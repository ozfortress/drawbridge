/**
 * Integration tests for failure application and the external pause/probe
 * loop (plan 02 §4.13, §5.7) against a real Postgres. Time is controlled
 * through the injected clock and `next_run_at`; no timers anywhere.
 */
import {
  type CreateJobInput,
  type Database,
  getDiscordObject,
  getJob,
  type JobRow,
  jobEvents,
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
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyStepFailure,
  claimNext,
  enqueueJob,
  InvalidTransition,
  LEASE_SECONDS,
  pauseExternal,
  probePausedExternal,
  type StepFailureInput,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-00000000000f';
const CHANNEL_ID = '555555555555556001';
const WORKER_A = 'worker-a';

/** App-clock stand-ins; the engine only ever sees these. */
const clock = () => Date.now();
const noJitter = () => 0.5;

let hashCounter = 0;

function jobInput(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId: LEAGUE_ID,
    lane: 'setup',
    plan: { divisions: 1 },
    planHash: `hash-${++hashCounter}`,
    steps: [
      { seq: 0, kind: 'create_category', reversible: true },
      { seq: 1, kind: 'create_role', skippable: true },
    ],
    ...overrides,
  };
}

/** The first transient failure a fresh step hits. */
const transientFailure: StepFailureInput = {
  stepSeq: 0,
  signal: { status: 503, message: 'gateway unavailable' },
};

describe.skipIf(!available)('step failure application (02 §4.13, §5.7)', () => {
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

  /** A running job claimed by worker A. */
  async function runningJob(): Promise<JobRow> {
    const job = await enqueueJob(db(), jobInput());
    const claimed = await claimNext(db(), ['setup'], WORKER_A);
    expect(claimed?.id).toBe(job.id);
    return job;
  }

  async function journalCodes(jobId: string): Promise<string[]> {
    return (await getJob(db(), jobId))?.events.map((event) => event.code) ?? [];
  }

  it('schedules a transient retry on the backoff without pausing the job', async () => {
    const job = await runningJob();
    const before = clock();
    const result = await applyStepFailure(db(), job.id, transientFailure, clock, noJitter);
    const after = clock();

    expect(result.action).toBe('retry_scheduled');
    expect(result.job.state).toBe('running');
    expect(result.job.pauseReason).toBeNull();
    // The lease stays with the worker that is waiting out the backoff.
    expect(result.job.leaseOwner).toBe(WORKER_A);
    // 2s base, no jitter at the mid draw.
    expect(result.job.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(result.job.nextRunAt.getTime()).toBeLessThanOrEqual(after + 2_000);
    expect(result.job.error).toBeNull();

    const step = (await getJob(db(), job.id))?.steps[0];
    expect(step?.status).toBe('failed');
    expect(step?.attempts).toBe(1);
    expect(step?.error).toMatchObject({ class: 'transient', status: 503 });

    expect(await journalCodes(job.id)).toEqual([
      'job.queued',
      'job.started',
      'job.step.failure',
      'job.step.retry_scheduled',
    ]);
    const retryRow = (await getJob(db(), job.id))?.events[3];
    expect(retryRow?.level).toBe('warn');
    expect(retryRow?.data).toMatchObject({ stepSeq: 0, attempt: 1 });
  });

  it('fails the job after the sixth transient attempt, with the backoff doubling throughout', async () => {
    const job = await runningJob();
    let result = { action: 'retry_scheduled' as string, job: {} as JobRow };
    for (let attempt = 1; attempt <= 6; attempt++) {
      const before = clock();
      result = await applyStepFailure(db(), job.id, transientFailure, clock, noJitter);
      const after = clock();
      if (attempt < 6) {
        expect(result.action).toBe('retry_scheduled');
        // The backoff doubles every attempt: 2s, 4s, ..., 32s for the fifth.
        const expected = 2_000 * 2 ** (attempt - 1);
        expect(result.job.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + expected);
        expect(result.job.nextRunAt.getTime()).toBeLessThanOrEqual(after + expected);
      }
    }
    expect(result.action).toBe('failed');
    expect(result.job.state).toBe('failed');
    expect(result.job.finishedAt).not.toBeNull();
    expect(result.job.leaseOwner).toBeNull();
    expect(result.job.error).toMatchObject({ class: 'transient', stepSeq: 0 });

    const step = (await getJob(db(), job.id))?.steps[0];
    expect(step?.attempts).toBe(6);
    expect(step?.status).toBe('failed');

    const expected = ['job.queued', 'job.started'];
    for (let i = 0; i < 5; i++) expected.push('job.step.failure', 'job.step.retry_scheduled');
    expected.push('job.step.failure', 'job.failed');
    expect(await journalCodes(job.id)).toEqual(expected);
    const failedRow = (await getJob(db(), job.id))?.events.at(-1);
    expect(failedRow?.level).toBe('error');
    expect(failedRow?.message).toContain('transient retries exhausted');
  });

  it('pauses on a 429 until retry_after, consuming no attempt, then resumes by claim', async () => {
    const job = await runningJob();
    const before = clock();
    const result = await applyStepFailure(
      db(),
      job.id,
      { stepSeq: 0, signal: { status: 429, retryAfterSeconds: 12.5 } },
      clock,
      noJitter,
    );
    const after = clock();

    expect(result.action).toBe('ratelimit_paused');
    expect(result.job.state).toBe('paused');
    expect(result.job.pauseReason).toBe('ratelimit');
    expect(result.job.leaseOwner).toBeNull();
    expect(result.job.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 12_500);
    expect(result.job.nextRunAt.getTime()).toBeLessThanOrEqual(after + 12_500);

    // The attempt is not consumed (02 §5.7).
    const step = (await getJob(db(), job.id))?.steps[0];
    expect(step?.attempts).toBe(0);
    expect(step?.status).toBe('failed');

    const pausedRow = (await getJob(db(), job.id))?.events.at(-1);
    expect(pausedRow?.code).toBe('job.paused');
    expect(pausedRow?.data).toMatchObject({ from: 'running', to: 'paused', reason: 'ratelimit' });
    expect(pausedRow?.message).toContain('retry after 12.5s');

    // Not claimable before retry_after; claimable (and resumed) after.
    expect(await claimNext(db(), ['setup'], 'worker-b')).toBeUndefined();
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });
    const resumed = await claimNext(db(), ['setup'], 'worker-b');
    expect(resumed?.state).toBe('running');
    expect(resumed?.pauseReason).toBeNull();
    expect(await journalCodes(job.id)).toContain('job.resumed');
  });

  it('parks a permanent failure at once with its named cause', async () => {
    const job = await runningJob();
    const result = await applyStepFailure(
      db(),
      job.id,
      { stepSeq: 0, signal: { status: 403, code: 50013, message: 'Missing Permissions' } },
      clock,
      noJitter,
    );

    expect(result.action).toBe('awaiting_decision');
    expect(result.job.state).toBe('awaiting_decision');
    expect(result.job.leaseOwner).toBeNull();
    expect(result.job.error).toMatchObject({ class: 'missing_permission', stepSeq: 0 });

    // Attempts were never in play for a permanent class.
    expect((await getJob(db(), job.id))?.steps[0]?.attempts).toBe(0);

    const journal = await getJob(db(), job.id);
    expect(journal?.events.map((row) => row.code)).toEqual([
      'job.queued',
      'job.started',
      'job.step.failure',
      'job.awaiting_decision',
    ]);
    expect(journal?.events[2]?.level).toBe('error');
    expect(journal?.events[2]?.data).toMatchObject({ class: 'missing_permission', code: 50013 });
    expect(journal?.events[3]?.message).toContain('missing_permission');
    expect(journal?.events[3]?.message).toContain('role or channel access');
  });

  it('marks the ledger row missing for an object_missing failure', async () => {
    const job = await runningJob();
    await upsertDiscordObject(db(), {
      guildId: GUILD_ID,
      discordId: CHANNEL_ID,
      kind: 'text_channel',
      ownerType: 'league',
      ownerId: LEAGUE_ID,
      createdByJobId: job.id,
    });

    const result = await applyStepFailure(
      db(),
      job.id,
      { stepSeq: 0, signal: { code: 10003, message: 'Unknown Channel' }, objectId: CHANNEL_ID },
      clock,
      noJitter,
    );
    expect(result.action).toBe('awaiting_decision');
    expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('missing');
  });

  it('parks a fatal_config failure and opens an alert', async () => {
    const job = await runningJob();
    const result = await applyStepFailure(
      db(),
      job.id,
      { stepSeq: 0, signal: { status: 401, message: 'Unauthorized' } },
      clock,
      noJitter,
    );

    expect(result.action).toBe('awaiting_decision');
    expect(result.job.error).toMatchObject({ class: 'fatal_config' });
    expect(result.job.state).toBe('awaiting_decision');

    const alertsResult = await db().execute<{ kind: string; severity: string }>(
      sql`select kind, severity from alerts where job_id = ${job.id}`,
    );
    expect(alertsResult.rows).toEqual([{ kind: 'job.fatal_config', severity: 'critical' }]);
  });

  it('parks capacity and invalid_input failures with the plan-named causes', async () => {
    const capacity = await runningJob();
    const capacityResult = await applyStepFailure(
      db(),
      capacity.id,
      {
        stepSeq: 0,
        signal: { code: 30005, message: 'Maximum number of guild channels reached' },
      },
      clock,
      noJitter,
    );
    expect(capacityResult.action).toBe('awaiting_decision');
    const capacityRow = (await getJob(db(), capacity.id))?.events.at(-1);
    expect(capacityRow?.message).toContain('capacity');
    expect(capacityRow?.message).toContain('Maximum number of guild channels reached');

    const invalid = await runningJob();
    const invalidResult = await applyStepFailure(
      db(),
      invalid.id,
      { stepSeq: 0, signal: { code: 50035, message: 'Invalid Form Body' } },
      clock,
      noJitter,
    );
    expect(invalidResult.action).toBe('awaiting_decision');
    const invalidRow = (await getJob(db(), invalid.id))?.events.at(-1);
    expect(invalidRow?.message).toContain('invalid_input');
    expect(invalidRow?.message).toContain('plan must be fixed');
  });

  it('refuses a failure on a job that is not running, without writing anything', async () => {
    const job = await enqueueJob(db(), jobInput());
    await expect(
      applyStepFailure(db(), job.id, transientFailure, clock, noJitter),
    ).rejects.toBeInstanceOf(InvalidTransition);
    expect((await getJob(db(), job.id))?.job.state).toBe('queued');
    expect(await journalCodes(job.id)).toEqual(['job.queued']);
  });

  it('refuses a failure for a step that does not exist', async () => {
    const job = await runningJob();
    await expect(
      applyStepFailure(db(), job.id, { ...transientFailure, stepSeq: 99 }, clock, noJitter),
    ).rejects.toThrow(/step 99/);
    expect((await getJob(db(), job.id))?.job.state).toBe('running');
  });
});

describe.skipIf(!available)('external pause and probe (02 §5.7)', () => {
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

  async function pausedExternalJob(): Promise<JobRow> {
    const job = await enqueueJob(db(), jobInput());
    const claimed = await claimNext(db(), ['setup'], WORKER_A);
    expect(claimed?.id).toBe(job.id);
    return pauseExternal(db(), job.id, 'Citadel unreachable', clock);
  }

  /** The db clock in epoch milliseconds, for lease assertions. */
  async function dbNowMs(): Promise<number> {
    const result = await db().execute<{ ms: string }>(
      sql`select (extract(epoch from now()) * 1000)::bigint as ms`,
    );
    return Number(result.rows[0]?.ms);
  }

  it('parks with a 30s probe schedule that the claim scan never claims', async () => {
    const job = await pausedExternalJob();
    expect(job.state).toBe('paused');
    expect(job.pauseReason).toBe('external');
    expect(job.leaseOwner).toBeNull();
    expect(job.nextRunAt.getTime()).toBeGreaterThan(clock() + 25_000);

    // Due for a probe, but the claim scan hands it back untouched (02
    // §5.7: resume needs a successful probe). A ratelimit pause in the
    // same position IS claimed, proving the filter is the pause reason.
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });
    const ratelimited = await enqueueJob(db(), jobInput());
    await updateJobState(db(), ratelimited.id, {
      state: 'paused',
      pauseReason: 'ratelimit',
      nextRunAt: new Date(clock() - 1_000),
    });
    const claimed = await claimNext(db(), ['setup'], 'worker-b');
    expect(claimed?.id).toBe(ratelimited.id);
    expect((await getJob(db(), job.id))?.job.state).toBe('paused');

    const journal = await getJob(db(), job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.paused');
    expect(journal?.events.at(-1)?.data).toMatchObject({ reason: 'external' });
    expect(journal?.events.at(-1)?.message).toContain('Citadel unreachable');
  });

  it('does not probe before the due time', async () => {
    const job = await pausedExternalJob();
    let probes = 0;
    const outcome = await probePausedExternal(
      db(),
      job.id,
      'prober',
      async () => {
        probes += 1;
        return true;
      },
      clock,
    );
    expect(outcome).toEqual({ action: 'not_due', nextRunAt: job.nextRunAt });
    expect(probes).toBe(0);
  });

  it('postpones a failing probe by 30s without a journal row', async () => {
    const job = await pausedExternalJob();
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });
    const eventsBefore = (await getJob(db(), job.id))?.events.length ?? 0;

    const before = clock();
    const outcome = await probePausedExternal(db(), job.id, 'prober', async () => false, clock);
    const after = clock();

    expect(outcome.action).toBe('postponed');
    const postponed = (await getJob(db(), job.id))?.job;
    expect(postponed?.state).toBe('paused');
    expect(postponed?.pauseReason).toBe('external');
    expect(postponed?.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(postponed?.nextRunAt.getTime()).toBeLessThanOrEqual(after + 30_000);
    // Silent: a probe every 30 seconds would flood the journal.
    expect((await getJob(db(), job.id))?.events.length).toBe(eventsBefore);
  });

  it('resumes on a successful probe under the prober lease, without a claim bump', async () => {
    const job = await pausedExternalJob();
    const attemptBefore = (await getJob(db(), job.id))?.job.attempt ?? 0;
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });

    const before = await dbNowMs();
    const outcome = await probePausedExternal(db(), job.id, 'prober', async () => true, clock);
    const after = await dbNowMs();

    expect(outcome.action).toBe('resume');
    if (outcome.action !== 'resume') throw new Error('probe did not resume');
    expect(outcome.job.state).toBe('running');
    expect(outcome.job.pauseReason).toBeNull();
    expect(outcome.job.leaseOwner).toBe('prober');
    expect(outcome.job.leaseExpiresAt?.getTime()).toBeGreaterThan(
      before + (LEASE_SECONDS - 1) * 1000,
    );
    expect(outcome.job.leaseExpiresAt?.getTime()).toBeLessThan(after + (LEASE_SECONDS + 1) * 1000);
    expect(outcome.job.attempt).toBe(attemptBefore);

    const journal = await getJob(db(), job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.resumed');
    expect(journal?.events.at(-1)?.message).toContain('external probe succeeded');
  });

  it('escalates to a decision after 24 hours of failing probes', async () => {
    const job = await pausedExternalJob();
    // Backdate the pause moment: the journal row is the clock of record.
    await db()
      .update(jobEvents)
      .set({ at: sql`now() - interval '25 hours'` })
      .where(and(eq(jobEvents.jobId, job.id), eq(jobEvents.code, 'job.paused')));
    await updateJobState(db(), job.id, { nextRunAt: new Date(clock() - 1_000) });

    const outcome = await probePausedExternal(db(), job.id, 'prober', async () => false, clock);
    expect(outcome.action).toBe('escalated');

    const parked = await getJob(db(), job.id);
    expect(parked?.job.state).toBe('awaiting_decision');
    expect(parked?.job.leaseOwner).toBeNull();
    expect(parked?.events.at(-1)?.code).toBe('job.awaiting_decision');
    expect(parked?.events.at(-1)?.message).toContain('24 hours');
    expect(parked?.events.at(-1)?.data).toEqual({ from: 'paused', to: 'awaiting_decision' });
  });

  it('a pause without its journal row postpones instead of escalating', async () => {
    // A paused(external) row can exist without its journal (a trimmed
    // log): the probe falls back to the probe time as the pause moment.
    const job = await enqueueJob(db(), jobInput());
    await updateJobState(db(), job.id, {
      state: 'paused',
      pauseReason: 'external',
      nextRunAt: new Date(clock() - 1_000),
    });
    const outcome = await probePausedExternal(db(), job.id, 'prober', async () => false, clock);
    expect(outcome.action).toBe('postponed');
  });

  it('refuses to probe anything but a paused(external) job', async () => {
    const running = await enqueueJob(db(), jobInput());
    await claimNext(db(), ['setup'], WORKER_A);
    expect(await probePausedExternal(db(), running.id, 'prober', async () => true, clock)).toEqual({
      action: 'not_paused_external',
    });

    const ratelimited = await enqueueJob(db(), jobInput());
    await updateJobState(db(), ratelimited.id, { state: 'paused', pauseReason: 'ratelimit' });
    expect(
      await probePausedExternal(db(), ratelimited.id, 'prober', async () => true, clock),
    ).toEqual({ action: 'not_paused_external' });
  });

  it('a step paused mid-run keeps its journal, steps and lease untouched by the pause itself', async () => {
    const job = await pausedExternalJob();
    const steps = await db().select().from(jobSteps).where(eq(jobSteps.jobId, job.id));
    expect(steps.map((step) => step.status)).toEqual(['pending', 'pending']);
    expect((await getJob(db(), job.id))?.events.map((row) => row.code)).toEqual([
      'job.queued',
      'job.started',
      'job.paused',
    ]);
  });
});
