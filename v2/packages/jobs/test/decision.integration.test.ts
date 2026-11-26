/**
 * Integration tests for the five operator decisions (plan 02 §5.8) against
 * a real Postgres: capability gates, step guards, journal rows and the
 * hand-off of decided jobs back into the worker pool.
 */
import type { Capability } from '@drawbridge/authz';
import {
  type CreateJobInput,
  type CreateJobStepInput,
  type Database,
  getDiscordObject,
  getJob,
  type JobRow,
  jobSteps,
  updateJobState,
  upsertDiscordObject,
} from '@drawbridge/db';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDecision,
  claimNext,
  claimRevertNext,
  DECISION_CAPABILITY,
  DESTRUCTIVE_CAPABILITY,
  type DecisionActor,
  enqueueJob,
  InvalidDecision,
  InvalidTransition,
  type ReconcilePort,
  reclaimExpired,
  UnauthorizedDecision,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-00000000000d';
const CHANNEL_ID = '555555555555556002';
const ROLE_ID = '666666666666666667';
const WORKER_A = 'worker-a';

let hashCounter = 0;

/** A step set whose compensations delete, for the destructive gate. */
const deletingSteps: CreateJobStepInput[] = [
  {
    seq: 0,
    kind: 'create_category',
    reversible: true,
    compensation: { kind: 'delete_category', categoryId: '777777777777777701' },
  },
  {
    seq: 1,
    kind: 'create_channel',
    reversible: true,
    compensation: { kind: 'delete_channel', channelId: CHANNEL_ID },
  },
];

/** A step set whose compensations never delete. */
const gentleSteps: CreateJobStepInput[] = [
  {
    seq: 0,
    kind: 'set_overwrites',
    reversible: true,
    compensation: {
      kind: 'restore_overwrites',
      channelId: CHANNEL_ID,
      overwrites: [{ discordId: ROLE_ID, type: 'role', allow: '1024', deny: '0' }],
    },
  },
  { seq: 1, kind: 'create_role', skippable: true },
];

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

const actor = (userId: string, ...capabilities: Capability[]): DecisionActor => ({
  userId,
  capabilities: new Set<Capability>(capabilities),
});

/** The bare decider: jobs.decide but nothing destructive. */
const decider = actor('u-decider', DECISION_CAPABILITY);
/** A decider that may also destroy. */
const destroyer = actor('u-destroyer', DECISION_CAPABILITY, DESTRUCTIVE_CAPABILITY);
/** Someone with no capabilities at all. */
const nobody = actor('u-nobody');

const fakePort = (): ReconcilePort => ({
  async fetchObject() {
    return undefined;
  },
  async searchAuditByReason() {
    return [];
  },
});

describe.skipIf(!available)('decisions (02 §5.8)', () => {
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

  /** A job parked in awaiting_decision, the state the five decisions answer. */
  async function promptJob(steps: readonly CreateJobStepInput[] = gentleSteps): Promise<JobRow> {
    const job = await enqueueJob(db(), jobInput(steps));
    await claimNext(db(), ['setup'], WORKER_A);
    return updateJobState(db(), job.id, {
      state: 'awaiting_decision',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  async function journalCodes(jobId: string): Promise<string[]> {
    return (await getJob(db(), jobId))?.events.map((event) => event.code) ?? [];
  }

  /** Marks steps done, as the executor would have. */
  async function markDone(jobId: string, ...seqs: number[]): Promise<void> {
    for (const seq of seqs) {
      await db()
        .update(jobSteps)
        .set({ status: 'done' })
        .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.seq, seq)));
    }
  }

  it('refuses an unauthorized decision without any state change', async () => {
    const job = await promptJob();
    const eventsBefore = (await getJob(db(), job.id))?.events.length ?? 0;

    let caught: UnauthorizedDecision | undefined;
    try {
      await applyDecision(db(), job.id, { type: 'retry' }, nobody);
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedDecision);
      caught = err as UnauthorizedDecision;
    }
    expect(caught?.missing).toEqual([DECISION_CAPABILITY]);

    const after = await getJob(db(), job.id);
    expect(after?.job.state).toBe('awaiting_decision');
    expect(after?.events.length).toBe(eventsBefore);
    expect(after?.job.decision).toBeNull();
  });

  it('answers retry by handing the job back to the worker pool', async () => {
    const job = await promptJob();
    const decided = await applyDecision(db(), job.id, { type: 'retry' }, decider);

    expect(decided.state).toBe('running');
    expect(decided.leaseOwner).toBeNull();
    // The hand-off lease is already expired on the database clock.
    expect(decided.leaseExpiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect(decided.decision).toMatchObject({ type: 'retry', actorUserId: 'u-decider' });

    const journal = await getJob(db(), job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.decision.retry');
    expect(journal?.events.at(-1)?.message).toContain('u-decider');

    // The first reclaiming worker takes the decided job over.
    const reclaimed = await reclaimExpired(db(), 'worker-b', fakePort());
    expect(reclaimed?.job.id).toBe(job.id);
    expect(reclaimed?.applied).toBe('re_claimed');
    expect(reclaimed?.job.state).toBe('running');
    expect(reclaimed?.job.leaseOwner).toBe('worker-b');
  });

  it('refuses a skip of a step that is not skippable', async () => {
    const job = await promptJob();
    await expect(
      applyDecision(db(), job.id, { type: 'skip', stepSeq: 0 }, decider),
    ).rejects.toBeInstanceOf(InvalidDecision);
    expect((await getJob(db(), job.id))?.job.state).toBe('awaiting_decision');
    expect((await getJob(db(), job.id))?.steps[0]?.status).toBe('pending');
  });

  it('refuses a skip of a step that does not exist, or is already finished', async () => {
    const job = await promptJob();
    await expect(
      applyDecision(db(), job.id, { type: 'skip', stepSeq: 99 }, decider),
    ).rejects.toThrow(/step 99/);

    await markDone(job.id, 1);
    await expect(
      applyDecision(db(), job.id, { type: 'skip', stepSeq: 1 }, decider),
    ).rejects.toThrow(/already done/);
  });

  it('skips a skippable step, recording it in job_steps and job_events', async () => {
    const job = await promptJob();
    const decided = await applyDecision(db(), job.id, { type: 'skip', stepSeq: 1 }, decider);

    expect(decided.state).toBe('running');
    const step = (await getJob(db(), job.id))?.steps[1];
    expect(step?.status).toBe('skipped');
    expect(step?.finishedAt).not.toBeNull();

    const journal = await getJob(db(), job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.decision.skip');
    expect(journal?.events.at(-1)?.data).toEqual({
      from: 'awaiting_decision',
      to: 'running',
      stepSeq: 1,
    });
  });

  it('adopts an object onto the step and into the ledger, completing it', async () => {
    const job = await promptJob();
    const decided = await applyDecision(
      db(),
      job.id,
      {
        type: 'adopt',
        stepSeq: 0,
        object: { discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' },
      },
      decider,
    );

    expect(decided.state).toBe('running');
    const step = (await getJob(db(), job.id))?.steps[0];
    expect(step?.status).toBe('done');
    expect(step?.externalIds).toEqual([
      { discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' },
    ]);

    const ledger = await getDiscordObject(db(), GUILD_ID, CHANNEL_ID);
    expect(ledger?.state).toBe('live');
    expect(ledger?.ownerType).toBe('league');
    expect(ledger?.createdByJobId).toBe(job.id);

    expect(await journalCodes(job.id)).toContain('job.decision.adopt');
  });

  it('adopts without an object when reconciliation already recorded it', async () => {
    const job = await promptJob();
    await db()
      .update(jobSteps)
      .set({ externalIds: [{ discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' }] })
      .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.seq, 0)));

    const decided = await applyDecision(db(), job.id, { type: 'adopt', stepSeq: 0 }, decider);
    expect(decided.state).toBe('running');
    expect((await getJob(db(), job.id))?.steps[0]?.externalIds).toHaveLength(1);
  });

  it('aborts, cancelling the job and leaving every object as it is', async () => {
    const job = await promptJob();
    await upsertDiscordObject(db(), {
      guildId: GUILD_ID,
      discordId: CHANNEL_ID,
      kind: 'text_channel',
      ownerType: 'league',
      ownerId: LEAGUE_ID,
      createdByJobId: job.id,
    });

    const decided = await applyDecision(db(), job.id, { type: 'abort' }, decider);
    expect(decided.state).toBe('cancelled');
    expect(decided.finishedAt).not.toBeNull();
    expect(decided.leaseOwner).toBeNull();

    // Abort leaves objects as-is (02 §5.8).
    expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('live');
    const journal = await getJob(db(), job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.decision.abort');
    expect(journal?.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
  });

  it('refuses a revert that deletes without the destructive capability', async () => {
    const job = await promptJob(deletingSteps);
    await markDone(job.id, 0, 1);

    let caught: UnauthorizedDecision | undefined;
    try {
      await applyDecision(db(), job.id, { type: 'revert' }, decider);
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedDecision);
      caught = err as UnauthorizedDecision;
    }
    expect(caught?.missing).toEqual([DESTRUCTIVE_CAPABILITY]);
    expect((await getJob(db(), job.id))?.job.state).toBe('awaiting_decision');
    expect(await journalCodes(job.id)).not.toContain('job.decision.revert');
  });

  it('decides a destructive revert and hands the job to the revert loop', async () => {
    const job = await promptJob(deletingSteps);
    await markDone(job.id, 0, 1);

    const decided = await applyDecision(db(), job.id, { type: 'revert' }, destroyer);
    expect(decided.state).toBe('reverting');
    expect(decided.leaseOwner).toBeNull();
    expect(decided.decision).toMatchObject({ type: 'revert', actorUserId: 'u-destroyer' });
    expect((await getJob(db(), job.id))?.events.at(-1)?.code).toBe('job.decision.revert');

    // The revert loop claims it immediately.
    const claimed = await claimRevertNext(db(), 'reverter-a');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.leaseOwner).toBe('reverter-a');
  });

  it('allows a revert whose compensations never delete with jobs.decide alone', async () => {
    const job = await promptJob(gentleSteps);
    await markDone(job.id, 0);

    const decided = await applyDecision(db(), job.id, { type: 'revert' }, decider);
    expect(decided.state).toBe('reverting');
  });

  it('refuses a decision that does not fit the job state', async () => {
    const job = await enqueueJob(db(), jobInput(gentleSteps));
    await claimNext(db(), ['setup'], WORKER_A);
    // A running job is not a decision prompt: the machine rejects the move.
    await expect(applyDecision(db(), job.id, { type: 'retry' }, decider)).rejects.toBeInstanceOf(
      InvalidTransition,
    );
    expect((await getJob(db(), job.id))?.job.state).toBe('running');
  });

  it('aborts a running job through the machine cancel edge', async () => {
    const job = await enqueueJob(db(), jobInput(gentleSteps));
    await claimNext(db(), ['setup'], WORKER_A);

    const decided = await applyDecision(db(), job.id, { type: 'abort' }, decider);
    expect(decided.state).toBe('cancelled');
    expect(decided.finishedAt).not.toBeNull();
    expect((await getJob(db(), job.id))?.events.at(-1)?.code).toBe('job.cancelled');
  });

  it('reverts a running job through the machine revert edge', async () => {
    const job = await enqueueJob(db(), jobInput(gentleSteps));
    await claimNext(db(), ['setup'], WORKER_A);
    await markDone(job.id, 0);

    const decided = await applyDecision(db(), job.id, { type: 'revert' }, decider);
    expect(decided.state).toBe('reverting');
    expect((await getJob(db(), job.id))?.events.at(-1)?.code).toBe('job.reverting');

    const claimed = await claimRevertNext(db(), 'reverter-a');
    expect(claimed?.id).toBe(job.id);
  });

  it('serialises two racing decisions on the same job', async () => {
    const job = await promptJob();
    // Both decisions answer the same prompt; only one prompt exists.
    const [first, second] = await Promise.allSettled([
      applyDecision(db(), job.id, { type: 'retry' }, decider),
      applyDecision(db(), job.id, { type: 'skip', stepSeq: 1 }, decider),
    ]);
    // The row lock serialises them: the winner answers the prompt, and the
    // loser hits the machine's edge table for the state the winner left.
    const settled = [first, second];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = settled.find((r) => r.status === 'fulfilled');
    expect((winner?.value as JobRow | undefined)?.state).toBe('running');
    // And the journal shows exactly one decision row.
    const codes = await journalCodes(job.id);
    expect(codes.filter((code) => code.startsWith('job.decision'))).toHaveLength(1);
  });
});
