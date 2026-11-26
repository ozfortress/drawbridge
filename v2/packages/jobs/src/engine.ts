/**
 * The job engine's persistence moves: enqueue, claim, lease heartbeat and
 * expired-lease reclaim (plan 02 §5.5, §5.10-5.11).
 *
 * The pure state machine (`state.ts`) owns every legal move and the exact
 * `job_events` row it emits; this module is the I/O half that applies those
 * moves to Postgres under row locks. Leases are claimed with
 * `FOR UPDATE SKIP LOCKED` so concurrent workers never hand out the same
 * job, and every due/lease comparison uses the database clock (`now()`), so
 * tests control time through `next_run_at` and `lease_expires_at` instead
 * of timers. Retry policy (02 §5.7) is deliberately not here.
 */
import {
  appendJobEvent,
  type CreateJobInput,
  createJob,
  type Db,
  type DbOrTx,
  type DbTx,
  type JobLane,
  type JobRow,
  jobSteps,
  jobs,
  NotFoundError,
  updateJobState,
} from '@drawbridge/db';
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import { type ReconcileOutcome, type ReconcilePort, reconcileRunningStep } from './reconcile.js';
import {
  type JobEvent,
  type JobPauseReason,
  type JobSnapshot,
  type JobState,
  transition,
} from './state.js';

/** Claim leases run this many seconds ahead (02 §5.5). */
export const LEASE_SECONDS = 60;

/** Each heartbeat re-arms the lease this many seconds ahead (02 §5.5). */
export const HEARTBEAT_SECONDS = 15;

/**
 * How many due candidates one claim examines. The scan runs without a lock
 * and then locks candidates in priority order with SKIP LOCKED, so a worker
 * whose top candidate is taken by a concurrent claimer walks down the list
 * instead of going home empty-handed.
 */
const CLAIM_SCAN_LIMIT = 20;

/** Lanes in execution priority order (02 §4.4). */
export const JOB_LANES: readonly JobLane[] = [
  'interactive',
  'matches',
  'setup',
  'repair',
  'maintenance',
];

function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/**
 * Locks one job row for update and returns it. The single-job engine
 * moves (decisions, failure application, probes, revert finishing) all
 * serialise on this lock; the claim and reclaim scans use `SKIP LOCKED`
 * instead because they compete for many rows.
 */
export async function lockJobRow(tx: DbOrTx, jobId: string): Promise<JobRow> {
  const rows = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).for('update');
  const job = rows[0];
  if (!job) throw new NotFoundError('job not found');
  return job;
}

/**
 * Enqueues a job with its immutable plan and step list.
 *
 * The duplicate guard is the `jobs_active_plan_key` partial unique index on
 * `(league_id, plan_hash)` over the active states (02 §5.10): a second
 * active job with the same league and plan hash raises ConflictError from
 * the database layer, which keeps the guard and its mapping. Enqueueing
 * deliberately takes no advisory lock: it must never wait behind a running
 * job, and the unique index arbitrates duplicates on its own.
 */
export async function enqueueJob(db: Db, input: CreateJobInput): Promise<JobRow> {
  return createJob(db, input);
}

/**
 * Claims the next due job from the given lanes for a worker.
 *
 * Candidates are ordered by priority (highest value first), then due time,
 * then age, and locked with `FOR UPDATE SKIP LOCKED`, so two concurrent
 * claimers always receive different jobs. The claim applies the state
 * machine's `start` (from `queued`) or `resume` (from `paused`) move, sets
 * the lease 60 seconds ahead on the database clock and bumps the attempt
 * count. A `paused(external)` job is deliberately not claimable: it
 * resumes only through a successful probe (02 §5.7,
 * `probePausedExternal`), so the claim scan hands it back untouched even
 * when its probe time is due. Jobs in `reverting` are not claimed: the
 * machine has no edge out of `reverting` into `running`, so a crashed
 * revert is resumed by the revert loop under its own state
 * (`claimRevertNext`), not by this claim.
 *
 * Returns undefined when no due job is claimable from the given lanes.
 */
export async function claimNext(
  db: Db,
  lanes: readonly JobLane[],
  owner: string,
): Promise<JobRow | undefined> {
  if (lanes.length === 0) return undefined;
  // Paused jobs resume on a schedule, except external pauses, which need
  // a successful probe first (02 §5.7).
  const claimable = and(
    inArray(jobs.state, ['queued', 'paused']),
    lte(jobs.nextRunAt, sql`now()`),
    sql`(${jobs.state} <> 'paused' or ${jobs.pauseReason} is distinct from 'external')`,
  );
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(claimable, inArray(jobs.lane, [...lanes])))
      .orderBy(desc(jobs.priority), asc(jobs.nextRunAt), asc(jobs.createdAt))
      .limit(CLAIM_SCAN_LIMIT);

    for (const candidate of candidates) {
      // Re-check the mutable predicates on the locked row: the scan above
      // ran without a lock, so the job may have been claimed, paused or
      // postponed since it was read.
      const locked = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, candidate.id), claimable))
        .limit(1)
        .for('update', { skipLocked: true });
      const current = locked[0];
      if (!current) continue;

      // The jobs_state CHECK constrains the text column to JobState values.
      const snapshot: JobSnapshot = {
        state: current.state as JobState,
        pauseReason: current.pauseReason as JobPauseReason | null,
      };
      const event: JobEvent = snapshot.state === 'paused' ? { type: 'resume' } : { type: 'start' };
      const result = transition(snapshot, event, { detail: `claimed by ${owner}` });

      const updated = await tx
        .update(jobs)
        .set({
          state: result.state,
          pauseReason: result.pauseReason,
          leaseOwner: owner,
          leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
          attempt: current.attempt + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, current.id))
        .returning();

      const draft = result.events[0];
      if (!draft) throw new Error('state machine produced no event row');
      await appendJobEvent(tx, current.id, draft);

      return requireRow(updated, 'claim update');
    }
    return undefined;
  });
}

/**
 * Re-arms the lease while the caller still owns a running job: the lease
 * moves 15 seconds ahead on the database clock. Returns false when the job
 * is not running, the caller is not the lease owner, or the lease has
 * already lapsed (the job is then reclaimable by any worker, and a stale
 * owner must not resurrect its own expired claim).
 */
export async function heartbeat(db: Db, jobId: string, owner: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      leaseExpiresAt: sql`now() + ${HEARTBEAT_SECONDS} * interval '1 second'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.state, 'running'),
        eq(jobs.leaseOwner, owner),
        gt(jobs.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** What a reclaim did with the expired-lease job it picked up. */
export type ReclaimOutcomeApplied = 're_claimed' | 'adopted' | 're_run' | 'awaiting_decision';

export interface ReclaimResult {
  /** The job row after the reclaim (or the decision) was applied. */
  job: JobRow;
  /** The step that was running, or null when the job had none. */
  stepSeq: number | null;
  /** What reconciliation concluded and what was applied. */
  applied: ReclaimOutcomeApplied;
}

/**
 * Reclaims one job whose running lease has expired, for any worker
 * (02 §5.5): the oldest expired lease in priority order, locked with
 * SKIP LOCKED so two reclaimers never take the same job.
 *
 * Before continuing, the injected port reconciles the step that was
 * running (02 §5.6, `reconcileRunningStep`). A step that turns out missing
 * or renamed parks the job in `awaiting_decision` through the state
 * machine; anything else — adoption, re-run, or no running step at all —
 * re-claims the job under the new owner with a fresh 60-second lease and
 * the attempt count bumped, leaving the engine to resume from the first
 * unfinished step.
 */
export async function reclaimExpired(
  db: Db,
  owner: string,
  port: ReconcilePort,
): Promise<ReclaimResult | undefined> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.state, 'running'), lt(jobs.leaseExpiresAt, sql`now()`)))
      .orderBy(desc(jobs.priority), asc(jobs.leaseExpiresAt), asc(jobs.createdAt))
      .limit(CLAIM_SCAN_LIMIT);

    for (const candidate of candidates) {
      const locked = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, candidate.id),
            eq(jobs.state, 'running'),
            lt(jobs.leaseExpiresAt, sql`now()`),
          ),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      const job = locked[0];
      if (!job) continue;

      const stepRows = await tx
        .select()
        .from(jobSteps)
        .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.status, 'running')))
        .orderBy(asc(jobSteps.seq))
        .limit(1);
      const step = stepRows[0];

      // Reconcile before anything else moves (02 §5.5): only a step that
      // proves consistent may continue under a new owner.
      const outcome: ReconcileOutcome | undefined = step
        ? await reconcileRunningStep(tx, port, job, step)
        : undefined;

      if (outcome?.kind === 'awaiting_decision') {
        const result = transition(
          { state: 'running', pauseReason: null },
          { type: 'need_decision' },
          { detail: outcome.detail },
        );
        const draft = result.events[0];
        if (!draft) throw new Error('state machine produced no event row');
        await appendJobEvent(tx, job.id, draft);
        const parked = await updateJobState(tx, job.id, {
          state: result.state,
          pauseReason: result.pauseReason,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return { job: parked, stepSeq: step?.seq ?? null, applied: 'awaiting_decision' };
      }

      if (step && outcome) {
        const message =
          outcome.kind === 'adopted'
            ? `Reconciliation adopted ${outcome.entry.kind} '${outcome.entry.name}' ` +
              `(${outcome.entry.discordId}) for step ${step.seq}`
            : `Reconciliation for step ${step.seq}: ${outcome.detail}`;
        await appendJobEvent(tx, job.id, {
          code: outcome.kind === 'adopted' ? 'job.reconcile.adopted' : 'job.reconcile.rerun',
          message,
          data: { stepSeq: step.seq },
        });
      }

      const updated = await tx
        .update(jobs)
        .set({
          leaseOwner: owner,
          leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
          attempt: job.attempt + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, job.id))
        .returning();
      await appendJobEvent(tx, job.id, {
        code: 'job.lease.reclaimed',
        message: `Expired lease reclaimed by ${owner}`,
        data: { previousOwner: job.leaseOwner },
      });

      const applied: ReclaimOutcomeApplied =
        outcome?.kind === 'adopted' ? 'adopted' : outcome ? 're_run' : 're_claimed';
      return { job: requireRow(updated, 'reclaim update'), stepSeq: step?.seq ?? null, applied };
    }
    return undefined;
  });
}

/**
 * Runs `fn` inside a transaction holding the per-league advisory lock
 * (02 §5.10: one mutating job per league at a time). Transaction-scoped, so
 * the lock releases at commit or rollback; reads never take it. Keyed by
 * `hashtext(leagueId)` so any caller spells the league the same way.
 */
export async function withLeagueLock<T>(
  db: Db,
  leagueId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${leagueId}))`);
    return fn(tx);
  });
}
