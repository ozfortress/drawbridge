/**
 * Integration tests for the scheduled-operation driver (plan 02 §5.11)
 * against real Postgres: recurrence anchored on `next_run_at`, per-league
 * enqueue, the duplicate guard arbitrating concurrent ticks. Time flows
 * through an injected fake clock; no timers anywhere.
 */
import { ensureGuild, type JobRow, jobs, leagues, updateJobState } from '@drawbridge/db';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimNext,
  enqueueJob,
  runSchedulerTick,
  type ScheduledOperation,
  scheduledPlanHash,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const WORKER = 'worker-a';

let fakeNow = Date.now();
const clock = (): number => fakeNow;

const op = (overrides: Partial<ScheduledOperation> = {}): ScheduledOperation => ({
  type: 'maintenance.op',
  intervalMs: 60_000,
  plan: { scope: 'test' },
  steps: [{ seq: 0, kind: 'op.noop' }],
  ...overrides,
});

describe.skipIf(!available)('scheduled operations (integration)', () => {
  let db: Awaited<ReturnType<typeof prepareTestDatabase>>['db'];
  let database: Awaited<ReturnType<typeof prepareTestDatabase>>;

  /** The op's jobs for one league, oldest first. */
  const occurrences = async (leagueId: string): Promise<JobRow[]> =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'maintenance.op'), eq(jobs.leagueId, leagueId)))
      .orderBy(jobs.createdAt);

  beforeAll(async () => {
    database = await prepareTestDatabase();
    db = database.db;
  });

  beforeEach(async () => {
    await resetTestDatabase(db);
    fakeNow = Date.now();
    await ensureGuild(db, GUILD_ID);
    for (const [status, citadelId] of [
      ['active', 1],
      ['active', 2],
      ['draft', 3],
    ] as const) {
      await db.insert(leagues).values({
        guildId: GUILD_ID,
        citadelLeagueId: citadelId,
        name: `League ${citadelId}`,
        shortcode: `l${citadelId}`,
        status,
      });
    }
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  it('enqueues the first occurrence per active league, due immediately', async () => {
    const active = await db.select().from(leagues).where(eq(leagues.status, 'active'));
    const enqueued = await runSchedulerTick(db, [op()], clock);
    expect(enqueued).toHaveLength(2);

    for (const league of active) {
      const rows = await occurrences(league.id);
      expect(rows).toHaveLength(1);
      const job = rows[0];
      if (!job) throw new Error('missing occurrence');
      expect(job.lane).toBe('maintenance');
      expect(job.state).toBe('queued');
      expect(job.guildId).toBe(GUILD_ID);
      expect(job.planHash).toBe(scheduledPlanHash('maintenance.op', league.id));
      expect(job.nextRunAt.getTime()).toBe(fakeNow);
    }

    // A draft league is never scheduled.
    const draft = (await db.select().from(leagues).where(eq(leagues.status, 'draft')))[0];
    if (draft) expect(await occurrences(draft.id)).toHaveLength(0);

    // The first occurrence is claimable right away.
    expect((await claimNext(db, ['maintenance'], WORKER))?.type).toBe('maintenance.op');
  });

  it('enqueues nothing while an occurrence is in flight', async () => {
    await runSchedulerTick(db, [op()], clock);

    // queued: the standing occurrence is the schedule.
    expect(await runSchedulerTick(db, [op()], clock)).toHaveLength(0);

    // running: claimed by a worker.
    const claimed = await claimNext(db, ['maintenance'], WORKER);
    expect(claimed).toBeDefined();
    expect(await runSchedulerTick(db, [op()], clock)).toHaveLength(0);

    // paused and awaiting_decision keep holding the schedule.
    const leagueId = claimed?.leagueId;
    if (!leagueId) throw new Error('claim lost its league');
    await updateJobState(db, claimed?.id ?? '', { state: 'paused', pauseReason: 'ratelimit' });
    expect(await runSchedulerTick(db, [op()], clock)).toHaveLength(0);
    await updateJobState(db, claimed?.id ?? '', { state: 'awaiting_decision', pauseReason: null });
    expect(await runSchedulerTick(db, [op()], clock)).toHaveLength(0);

    // One occurrence per league, nothing more.
    expect(await db.select().from(jobs).where(eq(jobs.type, 'maintenance.op'))).toHaveLength(2);
  });

  it('schedules the next occurrence one interval after the anchor once the previous lands', async () => {
    const enqueued = await runSchedulerTick(db, [op()], clock);
    for (const job of enqueued) {
      await updateJobState(db, job.id, {
        state: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(fakeNow),
      });
    }

    fakeNow += 5_000; // inside the interval
    const next = await runSchedulerTick(db, [op()], clock);
    expect(next).toHaveLength(2);
    for (const job of next) {
      const anchor = enqueued.find((first) => first.leagueId === job.leagueId);
      if (!anchor) throw new Error('no anchor occurrence');
      expect(job.nextRunAt.getTime()).toBe(anchor.nextRunAt.getTime() + 60_000);
    }

    // The next occurrence is not due yet.
    expect(await claimNext(db, ['maintenance'], WORKER)).toBeUndefined();
  });

  it('catches up when the schedule lapsed: an overdue next occurrence is due at once', async () => {
    // A previous occurrence whose scheduled moment is two intervals old —
    // the real database clock, not the fake one, decides claimability.
    const leagueRows = await db.select().from(leagues).where(eq(leagues.status, 'active'));
    const leagueId = leagueRows[0]?.id;
    if (!leagueId) throw new Error('no active league');
    const anchor = await enqueueJob(db, {
      type: 'maintenance.op',
      guildId: GUILD_ID,
      leagueId,
      lane: 'maintenance',
      plan: {},
      planHash: 'manual-anchor',
      nextRunAt: new Date(Date.now() - 120_000),
      steps: [],
    });
    await updateJobState(db, anchor.id, { state: 'completed', finishedAt: new Date() });

    const next = await runSchedulerTick(db, [op()], clock);
    const caughtUp = next.find((job) => job.leagueId === leagueId);
    if (!caughtUp) throw new Error('no catch-up occurrence');
    expect(caughtUp.nextRunAt.getTime()).toBe(anchor.nextRunAt.getTime() + 60_000);
    // The overdue slot runs immediately instead of drifting forward, and it
    // claims before the other league's fresh first occurrence.
    expect((await claimNext(db, ['maintenance'], WORKER))?.id).toBe(caughtUp.id);
  });

  it('two concurrent ticks enqueue exactly one next occurrence', async () => {
    const [first] = await runSchedulerTick(db, [op()], clock);
    if (!first) throw new Error('no first occurrence');
    await updateJobState(db, first.id, { state: 'completed', finishedAt: new Date(fakeNow) });

    const ticks = await Promise.all([
      runSchedulerTick(db, [op()], clock),
      runSchedulerTick(db, [op()], clock),
    ]);
    const created = ticks.flat();
    // One tick's insert won the duplicate guard; the loser skipped.
    expect(created).toHaveLength(1);
    expect(await occurrences(first.leagueId ?? '')).toHaveLength(2);
  });

  it('reports a concurrent scheduler as a skip, never as a crash', async () => {
    const registry = [op({ type: 'maintenance.race' })];
    // Two ticks with no anchor at all race the very first inserts; the
    // duplicate guard keeps it to one occurrence per league, and the
    // loser's ConflictError is a skip inside the tick, not a rejection.
    const ticks = await Promise.all([
      runSchedulerTick(db, registry, clock),
      runSchedulerTick(db, registry, clock),
    ]);
    expect(ticks.flat().length).toBeLessThanOrEqual(2);
    const rows = await db.select().from(jobs).where(eq(jobs.type, 'maintenance.race'));
    expect(rows).toHaveLength(2); // one per active league, no more
  });

  it('refuses an operation whose interval is below the floor', async () => {
    await expect(runSchedulerTick(db, [op({ intervalMs: 999 })], clock)).rejects.toThrow(
      /below 1000/,
    );
  });
});
