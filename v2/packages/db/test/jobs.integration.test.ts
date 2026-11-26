import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJobEvent,
  appendJobStep,
  ConflictError,
  type CreateJobInput,
  createJob,
  type Database,
  getDiscordObject,
  getJob,
  jobEvents,
  jobSteps,
  jobs,
  NotFoundError,
  updateJobState,
  upsertDiscordObject,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const REQUESTER_ID = '222222222222222222';
const LEDGER_ID = '555555555555555555';
const OTHER_LEDGER_ID = '666666666666666666';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-000000000001';
const MISSING_JOB_ID = '1e6b0f5e-0000-4000-8000-0000000000ff';

function baseJob(overrides: { leagueId?: string | null; planHash?: string } = {}): CreateJobInput {
  return {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId: LEAGUE_ID,
    lane: 'setup',
    plan: { divisions: 1 },
    planHash: 'hash-a',
    requestedByDiscordId: REQUESTER_ID,
    steps: [
      { seq: 0, kind: 'create_category', reversible: true },
      {
        seq: 1,
        kind: 'create_role',
        compensation: { action: 'delete_role' },
        skippable: true,
      },
    ],
    ...overrides,
  };
}

describe.skipIf(!available)('job repositories (integration)', () => {
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

  describe('duplicate guard', () => {
    it('rejects a second active job with the same league and plan hash', async () => {
      const first = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      expect(first.state).toBe('queued');
      await expect(
        createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('allows a new job once the previous one is completed', async () => {
      const first = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      const done = await updateJobState(db(), first.id, {
        state: 'completed',
        finishedAt: new Date(),
      });
      expect(done.state).toBe('completed');

      const second = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      expect(second.state).toBe('queued');
      expect(second.id).not.toBe(first.id);
    });

    it('keeps guild-scoped duplicates possible when the league is null', async () => {
      // The guard is keyed by league_id and Postgres treats nulls as
      // distinct, so jobs without a league are never deduplicated.
      await createJob(db(), baseJob({ leagueId: null, planHash: 'hash-a' }));
      const second = await createJob(db(), baseJob({ leagueId: null, planHash: 'hash-a' }));
      expect(second.state).toBe('queued');
    });
  });

  describe('journal', () => {
    it('creates a job with its steps and reads the full journal back', async () => {
      const job = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));

      const appended = await appendJobStep(db(), job.id, { seq: 2, kind: 'post_message' });
      expect(appended.status).toBe('pending');
      expect(appended.reversible).toBe(false);

      await appendJobEvent(db(), job.id, {
        level: 'warn',
        code: 'step.started',
        message: 'Step 0 started',
      });
      await appendJobEvent(db(), job.id, {
        code: 'step.done',
        message: 'Step 0 done',
        data: { externalIdCount: 1 },
      });

      const loaded = await getJob(db(), job.id);
      expect(loaded?.job.planHash).toBe('hash-a');
      expect(loaded?.job.lane).toBe('setup');
      expect(loaded?.steps.map((step) => step.seq)).toEqual([0, 1, 2]);
      expect(loaded?.steps[1]?.compensation).toEqual({ action: 'delete_role' });
      expect(loaded?.events.map((event) => event.code)).toEqual([
        'job.queued',
        'step.started',
        'step.done',
      ]);
      expect(loaded?.events[1]?.level).toBe('warn');
      expect(loaded?.events[0]?.data).toEqual({ type: 'tournament.setup', lane: 'setup' });
    });

    it('updates job state fields and bumps updated_at', async () => {
      const job = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      const lease = new Date(Date.now() + 60_000);
      const running = await updateJobState(db(), job.id, {
        state: 'running',
        leaseOwner: 'worker-1',
        leaseExpiresAt: lease,
        attempt: 1,
      });
      expect(running.state).toBe('running');
      expect(running.leaseOwner).toBe('worker-1');
      expect(running.leaseExpiresAt).toEqual(lease);
      expect(running.attempt).toBe(1);
      expect(running.updatedAt.getTime()).toBeGreaterThanOrEqual(job.updatedAt.getTime());

      const paused = await updateJobState(db(), job.id, {
        state: 'paused',
        pauseReason: 'ratelimit',
        nextRunAt: new Date(Date.now() + 5_000),
        leaseOwner: null,
        leaseExpiresAt: null,
        error: { retryAfterMs: 5_000 },
      });
      expect(paused.pauseReason).toBe('ratelimit');
      expect(paused.leaseOwner).toBeNull();
      expect(paused.error).toEqual({ retryAfterMs: 5_000 });
    });

    it('rejects journal writes and updates for unknown jobs', async () => {
      await expect(
        updateJobState(db(), MISSING_JOB_ID, { state: 'running' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        appendJobStep(db(), MISSING_JOB_ID, { seq: 0, kind: 'create_category' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        appendJobEvent(db(), MISSING_JOB_ID, { code: 'step.started', message: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('ledger', () => {
    it('upserts and reads a discord object, keeping the original creator', async () => {
      const job = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      const first = await upsertDiscordObject(db(), {
        guildId: GUILD_ID,
        discordId: LEDGER_ID,
        kind: 'text_channel',
        ownerType: 'league',
        ownerId: LEAGUE_ID,
        createdByJobId: job.id,
      });
      expect(first.state).toBe('live');
      expect(first.createdByJobId).toBe(job.id);

      const second = await upsertDiscordObject(db(), {
        guildId: GUILD_ID,
        discordId: LEDGER_ID,
        kind: 'text_channel',
        ownerType: 'league',
        ownerId: LEAGUE_ID,
        state: 'missing',
        lastVerifiedAt: new Date(),
      });
      expect(second.state).toBe('missing');
      expect(second.createdByJobId).toBe(job.id);
      expect(second.lastVerifiedAt).toBeDefined();

      const read = await getDiscordObject(db(), GUILD_ID, LEDGER_ID);
      expect(read?.ownerType).toBe('league');
      expect(read?.state).toBe('missing');
      expect(await getDiscordObject(db(), GUILD_ID, OTHER_LEDGER_ID)).toBeUndefined();
    });

    it('keeps ledger rows when their job is deleted', async () => {
      const job = await createJob(db(), baseJob({ leagueId: LEAGUE_ID, planHash: 'hash-a' }));
      await upsertDiscordObject(db(), {
        guildId: GUILD_ID,
        discordId: LEDGER_ID,
        kind: 'role',
        ownerType: 'league',
        ownerId: LEAGUE_ID,
        createdByJobId: job.id,
      });

      await db().delete(jobs).where(eq(jobs.id, job.id));

      expect(await getJob(db(), job.id)).toBeUndefined();
      const steps = await db().select().from(jobSteps).where(eq(jobSteps.jobId, job.id));
      expect(steps).toHaveLength(0);
      const events = await db().select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
      expect(events).toHaveLength(0);

      const ledger = await getDiscordObject(db(), GUILD_ID, LEDGER_ID);
      expect(ledger?.state).toBe('live');
      expect(ledger?.createdByJobId).toBeNull();
    });
  });
});
