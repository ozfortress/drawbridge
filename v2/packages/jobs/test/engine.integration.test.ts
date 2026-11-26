/**
 * Integration tests for the job engine's persistence moves (plan 02
 * §5.5-5.6, §5.10): claims, leases, reclaim and reconciliation against a
 * real Postgres. Time is controlled through `next_run_at` and
 * `lease_expires_at` on the database clock — no timers anywhere.
 */
import {
  ConflictError,
  type CreateJobInput,
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
  type AuditEntry,
  auditReasonTag,
  claimNext,
  enqueueJob,
  HEARTBEAT_SECONDS,
  heartbeat,
  LEASE_SECONDS,
  type ReconcilePort,
  reclaimExpired,
  withLeagueLock,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-000000000001';
const OTHER_LEAGUE_ID = '1e6b0f5e-0000-4000-8000-000000000002';
const CHANNEL_ID = '555555555555555555';
const ROLE_ID = '666666666666666666';
const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';

const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 3_600_000);

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

/** A port whose Discord and audit views are plain maps, with a call hook. */
function fakePort(overrides: {
  objects?: Record<string, { name: string } | undefined>;
  audit?: Record<string, readonly AuditEntry[]>;
  onCall?: () => Promise<void> | void;
}): ReconcilePort {
  return {
    async fetchObject(_guildId, discordId) {
      await overrides.onCall?.();
      return overrides.objects?.[discordId];
    },
    async searchAuditByReason(_guildId, reason) {
      await overrides.onCall?.();
      return overrides.audit?.[reason] ?? [];
    },
  };
}

describe.skipIf(!available)('job engine (integration)', () => {
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

  /**
   * The database clock in epoch milliseconds. Raw `execute` bypasses the
   * table decoders (drizzle returns timestamps as strings there), so the
   * probe asks for a bigint, which pg delivers as a numeric string.
   */
  async function dbNowMs(): Promise<number> {
    const result = await db().execute<{ ms: string }>(
      sql`select (extract(epoch from now()) * 1000)::bigint as ms`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('clock probe returned no row');
    return Number(row.ms);
  }

  /** A job worker A claimed, whose lease has lapsed; step 0 left running. */
  async function expiredRunningJob(
    stepPatch: { externalIds?: Array<Record<string, unknown>> } = {},
  ): Promise<JobRow> {
    const job = await enqueueJob(db(), jobInput());
    await claimNext(db(), ['setup'], WORKER_A);
    await db()
      .update(jobSteps)
      .set({ status: 'running', ...stepPatch })
      .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.seq, 0)));
    await db()
      .update(jobs)
      .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
      .where(eq(jobs.id, job.id));
    return job;
  }

  describe('claims', () => {
    it('claims a due job under a fresh lease, writing exactly the start row', async () => {
      const job = await enqueueJob(db(), jobInput());
      const before = await dbNowMs();
      const claimed = await claimNext(db(), ['setup'], WORKER_A);
      const after = await dbNowMs();

      expect(claimed?.id).toBe(job.id);
      expect(claimed?.state).toBe('running');
      expect(claimed?.leaseOwner).toBe(WORKER_A);
      expect(claimed?.attempt).toBe(1);
      expect(claimed?.pauseReason).toBeNull();
      const lease = claimed?.leaseExpiresAt;
      expect(lease?.getTime()).toBeGreaterThan(before + (LEASE_SECONDS - 1) * 1000);
      expect(lease?.getTime()).toBeLessThan(after + (LEASE_SECONDS + 1) * 1000);

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual(['job.queued', 'job.started']);
      expect(journal?.events[1]?.data).toEqual({ from: 'queued', to: 'running' });
    });

    it('claims nothing outside the requested lanes or before the due time', async () => {
      const matches = await enqueueJob(db(), jobInput({ lane: 'matches' }));
      const future = await enqueueJob(db(), jobInput({ lane: 'setup', nextRunAt: FUTURE() }));

      expect(await claimNext(db(), [], WORKER_A)).toBeUndefined();
      expect(await claimNext(db(), ['maintenance'], WORKER_A)).toBeUndefined();
      expect(await claimNext(db(), ['setup'], WORKER_A)).toBeUndefined();

      const claimed = await claimNext(db(), ['matches'], WORKER_A);
      expect(claimed?.id).toBe(matches.id);
      expect((await getJob(db(), future.id))?.job.state).toBe('queued');
    });

    it('claims in priority, then due-time, then age order', async () => {
      const low = await enqueueJob(db(), jobInput({ priority: 0 }));
      const high = await enqueueJob(db(), jobInput({ priority: 10 }));
      const early = await enqueueJob(db(), jobInput({ priority: 5, nextRunAt: PAST() }));
      const late = await enqueueJob(db(), jobInput({ priority: 5 }));

      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(high.id);
      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(early.id);
      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(late.id);
      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(low.id);

      // Same priority and same due time: oldest first.
      const tieDue = PAST();
      const tieA = await enqueueJob(db(), jobInput({ priority: 5, nextRunAt: tieDue }));
      const tieB = await enqueueJob(db(), jobInput({ priority: 5, nextRunAt: tieDue }));
      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(tieA.id);
      expect((await claimNext(db(), ['setup'], WORKER_A))?.id).toBe(tieB.id);
    });

    it('resumes a paused job through the machine and clears its pause reason', async () => {
      const job = await enqueueJob(db(), jobInput());
      await updateJobState(db(), job.id, {
        state: 'paused',
        pauseReason: 'ratelimit',
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: FUTURE(),
      });
      expect(await claimNext(db(), ['setup'], WORKER_A)).toBeUndefined();

      await updateJobState(db(), job.id, { nextRunAt: PAST() });
      const claimed = await claimNext(db(), ['setup'], WORKER_B);
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.state).toBe('running');
      expect(claimed?.pauseReason).toBeNull();
      expect(claimed?.attempt).toBe(1);

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual(['job.queued', 'job.resumed']);
      expect(journal?.events[1]?.data).toEqual({
        from: 'paused',
        to: 'running',
        pauseReason: 'ratelimit',
      });
    });

    it('two concurrent claimers never receive the same job', async () => {
      // One due job, two racing claimers: exactly one wins.
      const single = await enqueueJob(db(), jobInput());
      const race = await Promise.all([
        claimNext(db(), ['setup'], WORKER_A),
        claimNext(db(), ['setup'], WORKER_B),
      ]);
      expect(race.filter((claimed) => claimed !== undefined)).toHaveLength(1);
      expect(race[0]?.id ?? race[1]?.id).toBe(single.id);
      expect(await claimNext(db(), ['setup'], WORKER_B)).toBeUndefined();

      // Many jobs, many workers: every claim is a different job.
      for (let i = 0; i < 5; i++) {
        await enqueueJob(db(), jobInput());
      }
      const batch = await Promise.all(
        ['w1', 'w2', 'w3', 'w4'].map((worker) => claimNext(db(), ['setup'], worker)),
      );
      const ids = batch.map((claimed) => claimed?.id);
      expect(new Set(ids).size).toBe(4);
      expect(batch.every((claimed) => claimed !== undefined)).toBe(true);
      expect(await claimNext(db(), ['setup'], 'w5')).toBeDefined();
    });

    it('does not claim jobs mid-revert', async () => {
      const job = await enqueueJob(db(), jobInput());
      await updateJobState(db(), job.id, { state: 'reverting' });
      expect(await claimNext(db(), ['setup'], WORKER_A)).toBeUndefined();
      expect((await getJob(db(), job.id))?.job.state).toBe('reverting');
    });
  });

  describe('heartbeat', () => {
    it('re-arms the lease for the owner only while it is valid', async () => {
      const job = await enqueueJob(db(), jobInput());
      await claimNext(db(), ['setup'], WORKER_A);

      expect(await heartbeat(db(), job.id, WORKER_B)).toBe(false);

      const before = await dbNowMs();
      expect(await heartbeat(db(), job.id, WORKER_A)).toBe(true);
      const after = await dbNowMs();
      const lease = (await getJob(db(), job.id))?.job.leaseExpiresAt;
      expect(lease?.getTime()).toBeGreaterThan(before + (HEARTBEAT_SECONDS - 1) * 1000);
      expect(lease?.getTime()).toBeLessThan(after + (HEARTBEAT_SECONDS + 1) * 1000);

      // A lapsed lease must not be resurrectable by its old owner.
      await db()
        .update(jobs)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(jobs.id, job.id));
      expect(await heartbeat(db(), job.id, WORKER_A)).toBe(false);

      // A job that is not running refuses heartbeats outright.
      await updateJobState(db(), job.id, {
        state: 'paused',
        pauseReason: 'external',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(await heartbeat(db(), job.id, WORKER_A)).toBe(false);
    });
  });

  describe('expired-lease reclaim', () => {
    it('leaves a freshly claimed job alone', async () => {
      const job = await enqueueJob(db(), jobInput());
      await claimNext(db(), ['setup'], WORKER_A);
      expect(await reclaimExpired(db(), WORKER_B, fakePort({}))).toBeUndefined();
      expect((await getJob(db(), job.id))?.job.leaseOwner).toBe(WORKER_A);
    });

    it('reclaims a job with no running step under a fresh lease', async () => {
      const job = await enqueueJob(db(), jobInput());
      await claimNext(db(), ['setup'], WORKER_A);
      await db()
        .update(jobs)
        .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
        .where(eq(jobs.id, job.id));

      const result = await reclaimExpired(db(), WORKER_B, fakePort({}));
      expect(result?.job.id).toBe(job.id);
      expect(result?.applied).toBe('re_claimed');
      expect(result?.stepSeq).toBeNull();
      expect(result?.job.state).toBe('running');
      expect(result?.job.leaseOwner).toBe(WORKER_B);
      expect(result?.job.attempt).toBe(2);
      expect(result?.job.leaseExpiresAt?.getTime()).toBeGreaterThan(await dbNowMs());

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual([
        'job.queued',
        'job.started',
        'job.lease.reclaimed',
      ]);
      expect(journal?.events[2]?.data).toEqual({ previousOwner: WORKER_A });

      expect(await reclaimExpired(db(), WORKER_B, fakePort({}))).toBeUndefined();
    });

    it('reconciles the running step before re-claiming it', async () => {
      const job = await expiredRunningJob();

      let observed: { owner: string | null; state: string } | undefined;
      const port = fakePort({
        onCall: async () => {
          const rows = await db()
            .select({ owner: jobs.leaseOwner, state: jobs.state })
            .from(jobs)
            .where(eq(jobs.id, job.id));
          observed = rows[0];
        },
      });

      const result = await reclaimExpired(db(), WORKER_B, port);
      // Reconciliation saw the pre-reclaim row: still worker A's claim.
      expect(observed?.owner).toBe(WORKER_A);
      expect(observed?.state).toBe('running');
      // Then the re-claim took over, with nothing found in the audit log.
      expect(result?.applied).toBe('re_run');
      expect(result?.stepSeq).toBe(0);
      expect(result?.job.state).toBe('running');
      expect(result?.job.leaseOwner).toBe(WORKER_B);

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual([
        'job.queued',
        'job.started',
        'job.reconcile.rerun',
        'job.lease.reclaimed',
      ]);
    });

    it('marks the ledger row missing and parks the job when an object is gone', async () => {
      const job = await expiredRunningJob({
        externalIds: [{ discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' }],
      });
      await upsertDiscordObject(db(), {
        guildId: GUILD_ID,
        discordId: CHANNEL_ID,
        kind: 'text_channel',
        ownerType: 'league',
        ownerId: LEAGUE_ID,
        createdByJobId: job.id,
      });

      const result = await reclaimExpired(db(), WORKER_B, fakePort({ objects: {} }));
      expect(result?.applied).toBe('awaiting_decision');
      expect(result?.stepSeq).toBe(0);
      expect(result?.job.state).toBe('awaiting_decision');
      expect(result?.job.leaseOwner).toBeNull();
      expect(result?.job.leaseExpiresAt).toBeNull();

      expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('missing');

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual([
        'job.queued',
        'job.started',
        'job.awaiting_decision',
      ]);
      expect(journal?.events[2]?.data).toEqual({ from: 'running', to: 'awaiting_decision' });
      expect(journal?.events[2]?.message).toContain('division-x');
    });

    it('parks the job without touching the ledger when an object was renamed', async () => {
      const job = await expiredRunningJob({
        externalIds: [{ discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' }],
      });
      await upsertDiscordObject(db(), {
        guildId: GUILD_ID,
        discordId: CHANNEL_ID,
        kind: 'text_channel',
        ownerType: 'league',
        ownerId: LEAGUE_ID,
        createdByJobId: job.id,
      });

      const result = await reclaimExpired(
        db(),
        WORKER_B,
        fakePort({ objects: { [CHANNEL_ID]: { name: 'division-why' } } }),
      );
      expect(result?.applied).toBe('awaiting_decision');
      expect(result?.job.state).toBe('awaiting_decision');
      expect((await getDiscordObject(db(), GUILD_ID, CHANNEL_ID))?.state).toBe('live');
      expect((await getJob(db(), job.id))?.events[2]?.message).toContain('division-why');
    });

    it('re-runs the step when every recorded object verifies by name', async () => {
      const job = await expiredRunningJob({
        externalIds: [
          // Discord slugifies the channel name it actually created.
          { discordId: CHANNEL_ID, kind: 'text_channel', name: 'Division X' },
          // Role names keep their case; trailing space must not fail the check.
          { discordId: ROLE_ID, kind: 'role', name: 'Div 1 Captain' },
        ],
      });

      const result = await reclaimExpired(
        db(),
        WORKER_B,
        fakePort({
          objects: {
            [CHANNEL_ID]: { name: 'division-x' },
            [ROLE_ID]: { name: 'Div 1 Captain ' },
          },
        }),
      );
      expect(result?.applied).toBe('re_run');
      expect(result?.job.state).toBe('running');
      expect(result?.job.leaseOwner).toBe(WORKER_B);
      expect((await getJob(db(), job.id))?.events[2]?.code).toBe('job.reconcile.rerun');
    });

    it('adopts an audit-log match into the step and the ledger', async () => {
      const job = await expiredRunningJob();
      const reason = auditReasonTag(job.id, 0);

      const result = await reclaimExpired(
        db(),
        WORKER_B,
        fakePort({
          audit: {
            [reason]: [{ discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' }],
          },
        }),
      );
      expect(result?.applied).toBe('adopted');
      expect(result?.stepSeq).toBe(0);
      expect(result?.job.state).toBe('running');
      expect(result?.job.leaseOwner).toBe(WORKER_B);

      const step = (await getJob(db(), job.id))?.steps[0];
      expect(step?.status).toBe('running');
      expect(step?.externalIds).toEqual([
        { discordId: CHANNEL_ID, kind: 'text_channel', name: 'division-x' },
      ]);

      const ledger = await getDiscordObject(db(), GUILD_ID, CHANNEL_ID);
      expect(ledger?.state).toBe('live');
      expect(ledger?.createdByJobId).toBe(job.id);
      expect(ledger?.ownerType).toBe('league');
      expect(ledger?.ownerId).toBe(LEAGUE_ID);

      const journal = await getJob(db(), job.id);
      expect(journal?.events.map((event) => event.code)).toEqual([
        'job.queued',
        'job.started',
        'job.reconcile.adopted',
        'job.lease.reclaimed',
      ]);
    });
  });

  describe('league advisory lock', () => {
    it('serializes two transactions on the same league', async () => {
      const order: string[] = [];
      let releaseA!: () => void;
      let aEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        aEntered = resolve;
      });

      const taskA = withLeagueLock(db(), LEAGUE_ID, async () => {
        order.push('a:enter');
        aEntered();
        await gate;
        order.push('a:exit');
      });
      await entered; // A holds the lock from here until it commits.

      const taskB = withLeagueLock(db(), LEAGUE_ID, async () => {
        order.push('b:enter');
      });
      releaseA();
      await Promise.all([taskA, taskB]);

      expect(order).toEqual(['a:enter', 'a:exit', 'b:enter']);
    });

    it('does not block transactions on a different league', async () => {
      const order: string[] = [];
      let releaseA!: () => void;
      let aEntered!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        aEntered = resolve;
      });

      const taskA = withLeagueLock(db(), LEAGUE_ID, async () => {
        order.push('a:enter');
        aEntered();
        await gate;
        order.push('a:exit');
      });
      await entered; // A holds league 1's lock from here.

      const taskB = withLeagueLock(db(), OTHER_LEAGUE_ID, async () => {
        order.push('b:enter');
      });
      await taskB; // league 2 never waits behind league 1's lock.
      expect(order).toEqual(['a:enter', 'b:enter']);

      releaseA();
      await taskA;
      expect(order).toEqual(['a:enter', 'b:enter', 'a:exit']);
    });
  });

  describe('duplicate guard', () => {
    it('maps a second active job with the same league and plan to ConflictError', async () => {
      await enqueueJob(db(), jobInput({ leagueId: LEAGUE_ID, planHash: 'same-plan' }));
      await expect(
        enqueueJob(db(), jobInput({ leagueId: LEAGUE_ID, planHash: 'same-plan' })),
      ).rejects.toBeInstanceOf(ConflictError);

      // A different plan hash, or a different league, is not a duplicate.
      await enqueueJob(db(), jobInput({ leagueId: LEAGUE_ID, planHash: 'other-plan' }));
      await enqueueJob(db(), jobInput({ leagueId: OTHER_LEAGUE_ID, planHash: 'same-plan' }));
    });
  });
});
