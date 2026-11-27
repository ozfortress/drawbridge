/**
 * Repositories for the job engine's bookkeeping: jobs, the step journal, the
 * event log and the Discord object ledger (plan 03 §2.3-2.4, engine states
 * 02 §5.3). The engine (P3) drives the state machine; this file is only its
 * persistence surface.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from './client.js';
import { ConflictError, NotFoundError } from './repos.js';
import {
  alerts,
  type DiscordObjectRow,
  discordObjects,
  type JobEventRow,
  type JobRow,
  type JobStepRow,
  jobEvents,
  jobSteps,
  jobs,
} from './schema.js';

export type JobLane = 'interactive' | 'matches' | 'setup' | 'repair' | 'maintenance';
export type JobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_decision'
  | 'completed'
  | 'completed_with_skips'
  | 'failed'
  | 'cancelled'
  | 'reverting'
  | 'reverted';
export type JobPauseReason = 'external' | 'ratelimit' | 'guild_unavailable';
export type JobStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'compensated';
export type JobEventLevel = 'info' | 'warn' | 'error';
export type DiscordObjectKind =
  | 'role'
  | 'category'
  | 'text_channel'
  | 'message'
  | 'webhook'
  | 'other';
export type DiscordObjectOwnerType = 'guild' | 'league' | 'division' | 'entry' | 'match' | 'job';
export type DiscordObjectState = 'live' | 'missing' | 'deleted' | 'archived';

interface PgError {
  code?: string;
  constraint?: string | null;
  cause?: unknown;
}

/** Finds a Postgres error in a drizzle/pg cause chain, if that is what it is. */
function findPgError(err: unknown, code: string, depth = 0): { constraint: string | null } | null {
  if (!err || typeof err !== 'object' || depth > 3) return null;
  const candidate = err as PgError;
  if (candidate.code === code) return { constraint: candidate.constraint ?? null };
  return findPgError(candidate.cause, code, depth + 1);
}

// ── Jobs and journal ─────────────────────────────────────────

export interface CreateJobStepInput {
  seq: number;
  kind: string;
  args?: Record<string, unknown>;
  skippable?: boolean;
  reversible?: boolean;
  compensation?: Record<string, unknown> | null;
}

export interface CreateJobInput {
  type: string;
  guildId: string;
  leagueId?: string | null;
  lane: JobLane;
  priority?: number;
  params?: Record<string, unknown>;
  plan: Record<string, unknown>;
  planHash: string;
  requestedByUserId?: string | null;
  requestedByDiscordId?: string | null;
  nextRunAt?: Date;
  steps: readonly CreateJobStepInput[];
}

/**
 * Enqueues a job with its immutable step plan and the first journal row.
 * A second active job with the same (league, plan_hash) raises ConflictError
 * (the duplicate guard, plan 02 §5.10). Accepts a transaction so an
 * approval can create the job and consume its preview atomically.
 */
export async function createJob(db: DbOrTx, input: CreateJobInput): Promise<JobRow> {
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(jobs)
        .values({
          type: input.type,
          guildId: input.guildId,
          leagueId: input.leagueId ?? null,
          lane: input.lane,
          priority: input.priority ?? 0,
          params: input.params ?? {},
          plan: input.plan,
          planHash: input.planHash,
          requestedByUserId: input.requestedByUserId ?? null,
          requestedByDiscordId: input.requestedByDiscordId ?? null,
          nextRunAt: input.nextRunAt ?? new Date(),
        })
        .returning();
      const job = inserted[0];
      if (!job) throw new Error('job insert returned no row');

      if (input.steps.length > 0) {
        await tx.insert(jobSteps).values(
          input.steps.map((step) => ({
            jobId: job.id,
            seq: step.seq,
            kind: step.kind,
            args: step.args ?? {},
            skippable: step.skippable ?? false,
            reversible: step.reversible ?? false,
            compensation: step.compensation ?? null,
          })),
        );
      }

      await tx.insert(jobEvents).values({
        jobId: job.id,
        level: 'info',
        code: 'job.queued',
        message: `Job queued (${input.steps.length} steps)`,
        data: { type: input.type, lane: input.lane },
      });

      return job;
    });
  } catch (err) {
    const violation = findPgError(err, '23505');
    if (violation) {
      throw new ConflictError(
        violation.constraint === 'jobs_active_plan_key'
          ? 'an active job with the same plan hash already exists'
          : 'a job step with this sequence number already exists',
      );
    }
    throw err;
  }
}

export interface JobWithJournal {
  job: JobRow;
  steps: JobStepRow[];
  events: JobEventRow[];
}

export interface ListJobsOptions {
  state?: JobState;
  limit?: number;
}

/**
 * One league's jobs, newest first, league-scoped only (02 §11). Guild-scoped
 * jobs (no league) are never listed here. The limit is clamped to at most
 * 200 so a caller cannot ask for the whole journal.
 */
export async function listJobsByLeague(
  db: Db,
  leagueId: string,
  options: ListJobsOptions = {},
): Promise<JobRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const where =
    options.state === undefined
      ? eq(jobs.leagueId, leagueId)
      : and(eq(jobs.leagueId, leagueId), eq(jobs.state, options.state));
  return db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(limit);
}

export type AlertRow = typeof alerts.$inferSelect;

/** Unresolved operational alerts visible within one league's access boundary. */
export async function listOpenAlertsByLeague(
  db: Db,
  leagueId: string,
  limit = 50,
): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.leagueId, leagueId), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.openedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** One job with its step journal (by seq) and event log (by time). */
export async function getJob(db: Db, id: string): Promise<JobWithJournal | undefined> {
  const jobRows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  const job = jobRows[0];
  if (!job) return undefined;

  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, id))
    .orderBy(jobSteps.seq);
  const events = await db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, id))
    .orderBy(jobEvents.at, jobEvents.id);
  return { job, steps, events };
}

export interface UpdateJobStatePatch {
  state?: JobState;
  pauseReason?: JobPauseReason | null;
  priority?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  attempt?: number;
  nextRunAt?: Date;
  decision?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  finishedAt?: Date | null;
}

/** Updates a job's scheduling and lifecycle fields, bumping updated_at. */
export async function updateJobState(
  db: DbOrTx,
  jobId: string,
  patch: UpdateJobStatePatch,
): Promise<JobRow> {
  const rows = await db
    .update(jobs)
    .set({
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.pauseReason !== undefined ? { pauseReason: patch.pauseReason } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.leaseOwner !== undefined ? { leaseOwner: patch.leaseOwner } : {}),
      ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
      ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId))
    .returning();
  if (!rows[0]) throw new NotFoundError('job not found');
  return rows[0];
}

// ── Journal writes ────────────────────────────────────────────

export interface AppendJobStepInput {
  seq: number;
  kind: string;
  args?: Record<string, unknown>;
  status?: JobStepStatus;
  skippable?: boolean;
  reversible?: boolean;
  compensation?: Record<string, unknown> | null;
}

/** Appends one step to a job's plan. */
export async function appendJobStep(
  db: Db,
  jobId: string,
  input: AppendJobStepInput,
): Promise<JobStepRow> {
  try {
    const rows = await db
      .insert(jobSteps)
      .values({
        jobId,
        seq: input.seq,
        kind: input.kind,
        args: input.args ?? {},
        ...(input.status !== undefined ? { status: input.status } : {}),
        skippable: input.skippable ?? false,
        reversible: input.reversible ?? false,
        compensation: input.compensation ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('job step insert returned no row');
    return row;
  } catch (err) {
    if (findPgError(err, '23503')) throw new NotFoundError('job not found');
    if (findPgError(err, '23505')) {
      throw new ConflictError('a job step with this sequence number already exists');
    }
    throw err;
  }
}

export interface AppendJobEventInput {
  level?: JobEventLevel;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

/** Appends one human-readable journal line (plan 02 §5.13). */
export async function appendJobEvent(
  db: DbOrTx,
  jobId: string,
  input: AppendJobEventInput,
): Promise<JobEventRow> {
  try {
    const rows = await db
      .insert(jobEvents)
      .values({
        jobId,
        level: input.level ?? 'info',
        code: input.code,
        message: input.message,
        data: input.data ?? {},
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('job event insert returned no row');
    return row;
  } catch (err) {
    if (findPgError(err, '23503')) throw new NotFoundError('job not found');
    throw err;
  }
}

// ── Discord object ledger ────────────────────────────────────

export interface UpsertDiscordObjectInput {
  guildId: string;
  discordId: string;
  kind: DiscordObjectKind;
  ownerType: DiscordObjectOwnerType;
  ownerId: string;
  createdByJobId?: string | null;
  state?: DiscordObjectState;
  lastVerifiedAt?: Date | null;
}

/**
 * Inserts a ledger row, or updates the mutable fields of an existing one.
 * The creating job is recorded on first insert and never overwritten, so
 * the original provenance survives re-creation by a later job.
 */
export async function upsertDiscordObject(
  db: DbOrTx,
  input: UpsertDiscordObjectInput,
): Promise<DiscordObjectRow> {
  try {
    const rows = await db
      .insert(discordObjects)
      .values({
        guildId: input.guildId,
        discordId: input.discordId,
        kind: input.kind,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        createdByJobId: input.createdByJobId ?? null,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.lastVerifiedAt !== undefined ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
      })
      .onConflictDoUpdate({
        target: [discordObjects.guildId, discordObjects.discordId],
        set: {
          kind: input.kind,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          ...(input.state !== undefined ? { state: input.state } : {}),
          ...(input.lastVerifiedAt !== undefined ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('discord object upsert returned no row');
    return row;
  } catch (err) {
    if (findPgError(err, '23503')) throw new NotFoundError('job not found');
    throw err;
  }
}

/** Reads one ledger row by its key. */
export async function getDiscordObject(
  db: DbOrTx,
  guildId: string,
  discordId: string,
): Promise<DiscordObjectRow | undefined> {
  const rows = await db
    .select()
    .from(discordObjects)
    .where(and(eq(discordObjects.guildId, guildId), eq(discordObjects.discordId, discordId)))
    .limit(1);
  return rows[0];
}

/** Live ledger objects by kind, the guild-usage half of a capacity check. */
export interface GuildDiscordObjectUsage {
  readonly roles: number;
  readonly channels: number;
  readonly categories: number;
}

/**
 * Counts the guild's live ledger objects by kind (02 §4.8): the usage a
 * preview weighs its plan against. Only `live` rows count — archived and
 * deleted objects freed their headroom.
 */
export async function guildDiscordObjectUsage(
  db: DbOrTx,
  guildId: string,
): Promise<GuildDiscordObjectUsage> {
  const rows = await db
    .select({ kind: discordObjects.kind, count: sql<number>`count(*)::int` })
    .from(discordObjects)
    .where(and(eq(discordObjects.guildId, guildId), eq(discordObjects.state, 'live')))
    .groupBy(discordObjects.kind);
  const byKind = new Map(rows.map((row) => [row.kind, row.count]));
  return {
    roles: byKind.get('role') ?? 0,
    channels: byKind.get('text_channel') ?? 0,
    categories: byKind.get('category') ?? 0,
  };
}
