/**
 * Integration tests for the revert engine (plan 02 §5.9) and the
 * reverting-state claim path (02 §5.5, task-16 gate finding F3) against a
 * real Postgres. The Discord side is a recording fake port; time is the
 * injected clock. No timers anywhere.
 */
import {
  type CreateJobInput,
  type CreateJobStepInput,
  type Database,
  getDiscordObject,
  getJob,
  type JobRow,
  jobSteps,
  jobs,
  updateJobState,
  upsertDiscordObject,
} from '@drawbridge/db';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDecision,
  type Compensation,
  claimNext,
  claimRevertNext,
  compensationDeletes,
  DiscordOperationError,
  enqueueJob,
  LEASE_SECONDS,
  type OverwriteSnapshot,
  type RevertPort,
  revertRequiresDestructive,
  runRevert,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-00000000000e';
const CATEGORY_ID = '777777777777777702';
const CHANNEL_ID = '555555555555556003';
const ROLE_ID = '666666666666666668';
const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';

const clock = () => Date.now();

let hashCounter = 0;

function jobInput(
  steps: readonly CreateJobStepInput[],
  overrides: Partial<CreateJobInput> = {},
): CreateJobInput {
  return {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId: LEAGUE_ID,
    lane: 'setup',
    plan: { divisions: 1 },
    planHash: `hash-${++hashCounter}`,
    steps: [...steps],
    ...overrides,
  };
}

/**
 * A step plan whose compensations exercise every branch of the revert
 * engine: a category (empty check), a channel (human-message check), an
 * overwrite restore, a DB-row delete and a non-reversible announcement.
 */
const revertSteps: CreateJobStepInput[] = [
  {
    seq: 0,
    kind: 'create_category',
    reversible: true,
    compensation: { kind: 'delete_category', categoryId: CATEGORY_ID },
  },
  {
    seq: 1,
    kind: 'create_channel',
    reversible: true,
    compensation: { kind: 'delete_channel', channelId: CHANNEL_ID },
  },
  {
    seq: 2,
    kind: 'set_overwrites',
    reversible: true,
    compensation: {
      kind: 'restore_overwrites',
      channelId: CHANNEL_ID,
      overwrites: [
        { discordId: ROLE_ID, type: 'role', allow: '1024', deny: '0' },
      ] satisfies readonly OverwriteSnapshot[],
    },
  },
  {
    seq: 3,
    kind: 'write_db_rows',
    reversible: true,
    compensation: {
      kind: 'delete_db_rows',
      rows: [{ table: 'managed_channels', criteria: { leagueId: LEAGUE_ID } }],
    },
  },
  { seq: 4, kind: 'announce', reversible: false },
];

/** A port that records every call; each method can be made to fail. */
interface PortRecipe {
  humanMessages?: Record<string, boolean>;
  emptyCategories?: Record<string, boolean>;
  fail?: (op: string) => DiscordOperationError | undefined;
  dbRows?: unknown[];
}

function fakePort(recipe: PortRecipe = {}): RevertPort & { calls: string[]; dbRows: unknown[] } {
  const calls: string[] = [];
  const port: RevertPort & { calls: string[]; dbRows: unknown[] } = {
    calls,
    dbRows: recipe.dbRows ?? [],
    async channelHasHumanMessages(_guildId, channelId) {
      calls.push(`human:${channelId}`);
      return recipe.humanMessages?.[channelId] ?? false;
    },
    async categoryIsEmpty(_guildId, categoryId) {
      calls.push(`empty:${categoryId}`);
      return recipe.emptyCategories?.[categoryId] ?? true;
    },
    async deleteRole(_guildId, roleId) {
      calls.push(`delete_role:${roleId}`);
      throwMaybe('delete_role');
    },
    async deleteChannel(_guildId, channelId) {
      calls.push(`delete_channel:${channelId}`);
      throwMaybe('delete_channel');
    },
    async archiveChannel(_guildId, channelId) {
      calls.push(`archive_channel:${channelId}`);
      throwMaybe('archive_channel');
    },
    async deleteCategory(_guildId, categoryId) {
      calls.push(`delete_category:${categoryId}`);
      throwMaybe('delete_category');
    },
    async restoreOverwrites(_guildId, channelId, overwrites) {
      calls.push(`restore_overwrites:${channelId}:${overwrites.length}`);
      throwMaybe('restore_overwrites');
    },
    async deleteDbRows(_guildId, rows) {
      calls.push(`delete_db_rows:${rows.length}`);
      port.dbRows.push(rows);
      throwMaybe('delete_db_rows');
    },
  };
  function throwMaybe(op: string): void {
    const failure = recipe.fail?.(op);
    if (failure) throw failure;
  }
  return port;
}

const rateLimited = () =>
  new DiscordOperationError({ status: 429, retryAfterSeconds: 9 }, 'rate limited');

describe('compensation vocabulary (pure)', () => {
  it('marks exactly the deleting compensation kinds', () => {
    const cases: Array<[Compensation, boolean]> = [
      [{ kind: 'delete_role', roleId: ROLE_ID }, true],
      [{ kind: 'delete_channel', channelId: CHANNEL_ID }, true],
      [{ kind: 'delete_category', categoryId: CATEGORY_ID }, true],
      [
        {
          kind: 'delete_db_rows',
          rows: [{ table: 'managed_channels', criteria: { leagueId: LEAGUE_ID } }],
        },
        true,
      ],
      [
        {
          kind: 'restore_overwrites',
          channelId: CHANNEL_ID,
          overwrites: [{ discordId: ROLE_ID, type: 'role', allow: '0', deny: '0' }],
        },
        false,
      ],
    ];
    for (const [compensation, deletes] of cases) {
      expect(compensationDeletes(compensation)).toBe(deletes);
    }
  });

  it('requires destructive only for done steps with deleting compensations', () => {
    const step = (
      status: string,
      reversible: boolean,
      compensation: Record<string, unknown> | null,
    ) =>
      ({
        id: 'x',
        jobId: 'x',
        seq: 0,
        kind: 'k',
        args: {},
        status,
        attempts: 0,
        skippable: false,
        reversible,
        compensation,
        externalIds: [],
        result: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }) as never;

    expect(revertRequiresDestructive([])).toBe(false);
    expect(
      revertRequiresDestructive([step('done', true, { kind: 'delete_role', roleId: '1' })]),
    ).toBe(true);
    // Pending, skipped or failed steps are never compensated.
    expect(
      revertRequiresDestructive([step('pending', true, { kind: 'delete_role', roleId: '1' })]),
    ).toBe(false);
    expect(
      revertRequiresDestructive([step('failed', true, { kind: 'delete_role', roleId: '1' })]),
    ).toBe(false);
    // Non-deleting compensations, non-reversible steps, no compensation.
    expect(
      revertRequiresDestructive([
        step('done', true, { kind: 'restore_overwrites', channelId: '1', overwrites: [] }),
      ]),
    ).toBe(false);
    expect(
      revertRequiresDestructive([step('done', false, { kind: 'delete_role', roleId: '1' })]),
    ).toBe(false);
    expect(revertRequiresDestructive([step('done', true, null)])).toBe(false);
    expect(
      revertRequiresDestructive([
        step('done', true, { kind: 'restore_overwrites', channelId: '1', overwrites: [] }),
        step('done', true, { kind: 'delete_channel', channelId: '2' }),
      ]),
    ).toBe(true);
  });
});

describe.skipIf(!available)('revert engine (02 §5.9)', () => {
  let database: Database;

  beforeAll(async () => {
    database = await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  const db = () => database.db;

  /** A reverting job whose steps ran, with ledger rows for its objects. */
  async function revertingJob(
    done: readonly number[],
    steps: readonly CreateJobStepInput[] = revertSteps,
  ): Promise<JobRow> {
    const job = await enqueueJob(db(), jobInput(steps));
    await claimNext(db(), ['setup'], WORKER_A);
    for (const seq of done) {
      await db()
        .update(jobSteps)
        .set({ status: 'done' })
        .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.seq, seq)));
    }
    await upsertDiscordObject(db(), {
      guildId: GUILD_ID,
      discordId: CATEGORY_ID,
      kind: 'category',
      ownerType: 'league',
      ownerId: LEAGUE_ID,
      createdByJobId: job.id,
    });
    await upsertDiscordObject(db(), {
      guildId: GUILD_ID,
      discordId: CHANNEL_ID,
      kind: 'text_channel',
      ownerType: 'league',
      ownerId: LEAGUE_ID,
      createdByJobId: job.id,
    });
    return updateJobState(db(), job.id, {
      state: 'reverting',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  it('compensates done steps in reverse order and finishes reverted', async () => {
    const job = await revertingJob([0, 1, 2, 3, 4]);
    const port = fakePort();

    const result = await runRevert(db(), job.id, port, clock);

    expect(result.action).toBe('reverted');
    expect(result.compensated).toEqual([3, 2, 1, 0]);
    // Reverse sequence order, with each policy check before its write.
    expect(port.calls).toEqual([
      'delete_db_rows:1',
      `restore_overwrites:${CHANNEL_ID}:1`,
      `human:${CHANNEL_ID}`,
      `delete_channel:${CHANNEL_ID}`,
      `empty:${CATEGORY_ID}`,
      `delete_category:${CATEGORY_ID}`,
    ]);
    expect(port.dbRows).toEqual([
      [{ table: 'managed_channels', criteria: { leagueId: LEAGUE_ID } }],
    ]);

    const journal = await getJob(db(), job.id);
    expect(journal?.job.state).toBe('reverted');
    expect(journal?.job.finishedAt).not.toBeNull();
    expect(journal?.job.leaseOwner).toBeNull();

    // The non-reversible announcement is listed, not compensated.
    expect(journal?.steps.map((step) => step.status)).toEqual([
      'compensated',
      'compensated',
      'compensated',
      'compensated',
      'done',
    ]);
    expect(journal?.events.map((row) => row.code)).toEqual([
      'job.queued',
      'job.started',
      'job.revert.not_reversible',
      'job.step.compensated',
      'job.step.compensated',
      'job.step.compensated',
      'job.step.compensated',
      'job.reverted',
    ]);
    const notReversible = journal?.events[2];
    expect(notReversible?.message).toContain('not reversible');
    expect(notReversible?.data).toEqual({ stepSeq: 4 });

    // The ledger records the deletions.
    expect((await getDiscordObject(db(), GUILD_ID, CATEGORY_ID))?.state).toBe('deleted');
    expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('deleted');
  });

  it('archives a channel with human messages instead of deleting, with a warning', async () => {
    const job = await revertingJob([0, 1]);
    const port = fakePort({ humanMessages: { [CHANNEL_ID]: true } });

    const result = await runRevert(db(), job.id, port, clock);

    expect(result.action).toBe('reverted');
    expect(result.compensated).toEqual([1, 0]);
    expect(port.calls).toContain(`archive_channel:${CHANNEL_ID}`);
    expect(port.calls).not.toContain(`delete_channel:${CHANNEL_ID}`);

    const channelStep = (await getJob(db(), job.id))?.steps[1];
    expect(channelStep?.status).toBe('compensated');
    expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('archived');

    const warnRow = (await getJob(db(), job.id))?.events.find(
      (row) => row.code === 'job.step.compensated' && row.data['stepSeq'] === 1,
    );
    expect(warnRow?.level).toBe('warn');
    expect(warnRow?.data).toEqual({
      stepSeq: 1,
      kind: 'delete_channel',
      outcome: 'archived',
    });
    expect(warnRow?.message).toContain('archived');
  });

  it('leaves a non-empty category in place with a warning, but still finishes', async () => {
    const job = await revertingJob([0, 1]);
    const port = fakePort({ emptyCategories: { [CATEGORY_ID]: false } });

    const result = await runRevert(db(), job.id, port, clock);

    expect(result.action).toBe('reverted');
    expect(result.compensated).toEqual([1]);
    expect(port.calls).not.toContain(`delete_category:${CATEGORY_ID}`);

    const categoryStep = (await getJob(db(), job.id))?.steps[0];
    expect(categoryStep?.status).toBe('done');
    expect((await getDiscordObject(db(), GUILD_ID, CATEGORY_ID))?.state).toBe('live');

    const warnRow = (await getJob(db(), job.id))?.events.find(
      (row) => row.code === 'job.step.compensated' && row.data['stepSeq'] === 0,
    );
    expect(warnRow?.level).toBe('warn');
    expect(warnRow?.data['outcome']).toBe('left_in_place');
  });

  it('claims a fresh revert under a 60s lease another worker cannot steal', async () => {
    const job = await revertingJob([0]);

    const before = await dbNowMs();
    const claimed = await claimRevertNext(db(), WORKER_B);
    const after = await dbNowMs();

    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe('reverting');
    expect(claimed?.leaseOwner).toBe(WORKER_B);
    expect(claimed?.attempt).toBe(2);
    expect(claimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(before + (LEASE_SECONDS - 1) * 1000);
    expect(claimed?.leaseExpiresAt?.getTime()).toBeLessThan(after + (LEASE_SECONDS + 1) * 1000);

    // A live lease is not claimable by anyone else.
    expect(await claimRevertNext(db(), 'worker-c')).toBeUndefined();
    expect((await getJob(db(), job.id))?.job.leaseOwner).toBe(WORKER_B);

    const claimedRow = (await getJob(db(), job.id))?.events.at(-1);
    expect(claimedRow?.code).toBe('job.revert.claimed');
    expect(claimedRow?.data).toEqual({ previousOwner: null });
  });

  it('reclaims an expired revert lease so a crashed worker never strands the job', async () => {
    const job = await revertingJob([0, 1, 2, 3, 4]);
    // Worker A claimed the revert, compensated step 3, then died: the lease
    // lapsed with step 3 already marked compensated.
    await claimRevertNext(db(), WORKER_A);
    await db()
      .update(jobSteps)
      .set({ status: 'compensated' })
      .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.seq, 3)));
    await db()
      .update(jobs)
      .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
      .where(eq(jobs.id, job.id));

    const reclaimed = await claimRevertNext(db(), WORKER_B);
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.leaseOwner).toBe(WORKER_B);

    const port = fakePort();
    const result = await runRevert(db(), job.id, port, clock);

    // Compensation resumes where the crash left off: step 3 (db rows) is
    // not redone; the rest run in reverse order.
    expect(result.action).toBe('reverted');
    expect(result.compensated).toEqual([2, 1, 0]);
    expect(port.calls).not.toContain('delete_db_rows:1');
    expect(port.calls).toEqual([
      `restore_overwrites:${CHANNEL_ID}:1`,
      `human:${CHANNEL_ID}`,
      `delete_channel:${CHANNEL_ID}`,
      `empty:${CATEGORY_ID}`,
      `delete_category:${CATEGORY_ID}`,
    ]);
    expect((await getJob(db(), job.id))?.job.state).toBe('reverted');
  });

  it('two racing revert claimers never take the same job', async () => {
    const single = await revertingJob([0]);
    const race = await Promise.all([
      claimRevertNext(db(), WORKER_A),
      claimRevertNext(db(), WORKER_B),
    ]);
    const winners = race.filter((claimed) => claimed !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(single.id);
    expect(await claimRevertNext(db(), 'worker-c')).toBeUndefined();
  });

  it('postpones the rest of the revert on a rate limit and auto-resumes', async () => {
    const job = await revertingJob([0, 1]);
    const before = clock();
    const failing = fakePort({
      fail: (op) => (op === 'delete_channel' ? rateLimited() : undefined),
    });

    const result = await runRevert(db(), job.id, failing, clock);
    const after = clock();

    // The pause is a schedule, not a state change: attempts are not
    // consumed and claimRevertNext resumes when the wait is over (02 §5.7).
    expect(result.action).toBe('ratelimit_postponed');
    expect(result.compensated).toEqual([]);
    const parked = (await getJob(db(), job.id))?.job;
    expect(parked?.state).toBe('reverting');
    expect(parked?.leaseOwner).toBeNull();
    expect(parked?.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 9_000);
    expect(parked?.nextRunAt.getTime()).toBeLessThanOrEqual(after + 9_000);

    const warnRow = (await getJob(db(), job.id))?.events.at(-1);
    expect(warnRow?.code).toBe('job.revert.ratelimited');
    expect(warnRow?.data).toMatchObject({ stepSeq: 1, retryAfterSeconds: 9 });

    // Not claimable until retry_after; claimable after.
    expect(await claimRevertNext(db(), WORKER_B)).toBeUndefined();
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });
    const reclaimed = await claimRevertNext(db(), WORKER_B);
    expect(reclaimed?.id).toBe(job.id);

    const done = await runRevert(db(), job.id, fakePort(), clock);
    expect(done.action).toBe('reverted');
    expect(done.compensated).toEqual([1, 0]);
  });

  it('parks the revert for a decision on a permanent compensation failure, and resumes by decide_revert', async () => {
    const job = await revertingJob([0, 1]);
    const failing = fakePort({
      fail: (op) =>
        op === 'delete_channel'
          ? new DiscordOperationError({ status: 403, code: 50013, message: 'Missing Permissions' })
          : undefined,
    });

    const result = await runRevert(db(), job.id, failing, clock);
    expect(result.action).toBe('awaiting_decision');

    const parked = await getJob(db(), job.id);
    expect(parked?.job.state).toBe('awaiting_decision');
    expect(parked?.job.error).toMatchObject({ class: 'missing_permission', stepSeq: 1 });
    // The failed compensation rolled back: the step is still done.
    expect(parked?.steps[1]?.status).toBe('done');
    expect(parked?.events.at(-1)?.code).toBe('job.awaiting_decision');
    expect(parked?.events.at(-1)?.message).toContain('missing_permission');

    // The operator answers decide_revert (the machine's way back into a
    // revert); the resume skips nothing and finishes the job.
    const destroyer = {
      userId: 'u-destroyer',
      capabilities: new Set(['jobs.decide', 'tournament.destructive'] as const),
    };
    const decided = await applyDecision(db(), job.id, { type: 'revert' }, destroyer);
    expect(decided.state).toBe('reverting');

    const done = await runRevert(db(), job.id, fakePort(), clock);
    expect(done.action).toBe('reverted');
    expect(done.compensated).toEqual([1, 0]);
  });

  it('fails loudly on a corrupt compensation kind, compensating nothing', async () => {
    const steps: CreateJobStepInput[] = [
      {
        seq: 0,
        kind: 'mystery',
        reversible: true,
        compensation: { kind: 'explode', someId: CHANNEL_ID },
      },
    ];
    const job = await revertingJob([0], steps);

    await expect(runRevert(db(), job.id, fakePort(), clock)).rejects.toThrow(
      /unknown compensation kind/,
    );
    const after = await getJob(db(), job.id);
    expect(after?.job.state).toBe('reverting');
    expect(after?.steps[0]?.status).toBe('done');
  });

  it('compensates a role deletion and marks its ledger row deleted', async () => {
    const steps: CreateJobStepInput[] = [
      {
        seq: 0,
        kind: 'create_role',
        reversible: true,
        compensation: { kind: 'delete_role', roleId: ROLE_ID },
      },
    ];
    const job = await revertingJob([0], steps);
    await upsertDiscordObject(db(), {
      guildId: GUILD_ID,
      discordId: ROLE_ID,
      kind: 'role',
      ownerType: 'league',
      ownerId: LEAGUE_ID,
      createdByJobId: job.id,
    });

    const port = fakePort();
    const result = await runRevert(db(), job.id, port, clock);

    expect(result.action).toBe('reverted');
    expect(port.calls).toEqual([`delete_role:${ROLE_ID}`]);
    expect((await getDiscordObject(db(), GUILD_ID, ROLE_ID))?.state).toBe('deleted');
    expect((await getDiscordObject(db(), GUILD_ID, ROLE_ID))?.deletedAt).not.toBeNull();
  });

  /** The db clock in epoch milliseconds. */
  async function dbNowMs(): Promise<number> {
    const result = await db().execute<{ ms: string }>(
      sql`select (extract(epoch from now()) * 1000)::bigint as ms`,
    );
    return Number(result.rows[0]?.ms);
  }
});
