/**
 * The worker loop (plan 02 §3.1-3.2, §4.4, §5.5-5.7, §5.11): the single
 * driver that turns the job engine's persisted state into executed work.
 *
 * One iteration, in priority order: continue the worker's own in-flight
 * job, reclaim a job whose running lease expired (reconciling the step
 * that was running first, 02 §5.5) or claim a stalled revert, probe the
 * oldest due `paused(external)` job — the enumeration todo 17 left open —
 * and only then claim new work, one lane at a time in the order 02 §4.4
 * fixes (`interactive, matches, setup, repair, maintenance`), so a lane
 * call never lets a low-priority lane beat a high one. Exactly one step is
 * executed per iteration through the injected {@link StepExecutor} port —
 * no Discord I/O lives here; the worker wires the real adapter (todo 25) —
 * under a lease heartbeat every 15 seconds, and the outcome is persisted
 * through the todo 17 failure path. Then the loop yields.
 *
 * Time is injected: the clock, the idle sleep (signal-aware, at least
 * `intervalMs`) and the jitter source all come from the caller, so tests
 * drive iterations with a fake clock and never touch timers — the only
 * real timer in a production loop is the idle wait and the heartbeat
 * interval. A signal stops the loop after the current step: an aborted
 * loop never claims new work, and a step already executing finishes and
 * is persisted before the loop exits. Every error is caught at the
 * iteration boundary (02 §3.2.2): a failed iteration is logged and the
 * loop keeps running.
 */
import {
  appendJobEvent,
  type Db,
  type JobRow,
  type JobStepRow,
  jobSteps,
  jobs,
  updateJobState,
  upsertDiscordObject,
} from '@drawbridge/db';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import {
  claimNext,
  HEARTBEAT_SECONDS,
  heartbeat,
  JOB_LANES,
  lockJobRow,
  reclaimExpired,
} from './engine.js';
import { type ApiErrorSignal, DiscordOperationError } from './errors.js';
import { applyStepFailure, probePausedExternal } from './failure.js';
import { type ExternalId, ledgerOwner, type ReconcilePort } from './reconcile.js';
import type { Clock, Random01 } from './retry.js';
import { claimRevertNext, type RevertPort, runRevert } from './revert.js';
import { runSchedulerTick, type ScheduledOperationRegistry } from './scheduler.js';
import {
  type JobEvent,
  type JobPauseReason,
  type JobSnapshot,
  type JobState,
  transition,
} from './state.js';

/** Step statuses that need no further execution (02 §5.4). */
const FINAL_STEP_STATUSES: ReadonlySet<string> = new Set(['done', 'skipped', 'compensated']);

/** The idle poll interval floor; smaller values would busy-spin the scans. */
export const MIN_LOOP_INTERVAL_MS = 1_000;

/** How often the loop lets the scheduler tick; the tick itself is cheap. */
export const DEFAULT_SCHEDULER_EVERY_MS = 30_000;

/**
 * One step execution, handed to the injected executor. The step row is the
 * engine's own record of the step about to run; a step whose status is
 * `running` (a lease expired mid-execution and reconciliation re-ran it)
 * or `failed` (an operator decided to retry it) is executable by contract:
 * create steps check by name first (02 §5.6), and the executor is
 * idempotent.
 */
export interface StepExecution {
  job: JobRow;
  step: JobStepRow;
}

/**
 * What the executor reports back: the plain result of the step, the
 * Discord objects it created (recorded before the step is marked done and
 * written to the ledger in the same transaction, 02 §5.4) and the
 * compensation a reversible step captured for the revert engine (02 §5.9).
 */
export interface StepExecutionResult {
  result?: Record<string, unknown>;
  externalIds?: readonly ExternalId[];
  compensation?: Record<string, unknown> | null;
}

/** The step executor port. The worker wires the real adapter (todo 25). */
export type StepExecutor = (execution: StepExecution) => Promise<StepExecutionResult>;

/**
 * The loop's logger, structural so the redacting `@drawbridge/logging`
 * logger satisfies it without a package dependency.
 */
export interface WorkerLoopLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Everything the loop needs; every dependency is injected. */
export interface WorkerLoopOptions {
  db: Db;
  /** Lease owner identity; claims, heartbeats and reverts run under it. */
  owner: string;
  clock: Clock;
  /** Abort to stop the loop after the current step. */
  signal: AbortSignal;
  /** Idle poll interval, at least {@link MIN_LOOP_INTERVAL_MS}. */
  intervalMs: number;
  executeStep: StepExecutor;
  reconcilePort: ReconcilePort;
  revertPort: RevertPort;
  /**
   * The cheap read that decides whether an externally paused dependency is
   * back (02 §5.7). Receives the job so a real probe can target its league.
   */
  probeExternal: (job: JobRow) => Promise<boolean>;
  /** Maintenance operations to schedule; empty until todos 32/33/52. */
  registry?: ScheduledOperationRegistry;
  /** Scheduler tick cadence; defaults to {@link DEFAULT_SCHEDULER_EVERY_MS}. */
  schedulerEveryMs?: number;
  /** Jitter source for transient backoff; defaults to Math.random. */
  random?: Random01;
  /** Idle wait; defaults to the signal-aware {@link signalAwareSleep}. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: WorkerLoopLogger;
}

/**
 * The production idle wait: sleeps `ms`, waking at once when the signal
 * aborts so shutdown never waits out an interval. The only real timer the
 * loop owns besides the execution heartbeat.
 */
export function signalAwareSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      signal.removeEventListener('abort', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** The worker's own in-flight job: running, leased to it, and due. */
async function findMyRunningJob(db: Db, owner: string): Promise<JobRow | undefined> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.state, 'running'), eq(jobs.leaseOwner, owner), lte(jobs.nextRunAt, sql`now()`)),
    )
    .orderBy(desc(jobs.priority), asc(jobs.nextRunAt))
    .limit(1);
  return rows[0];
}

/** The oldest due `paused(external)` job — the probe todo 17 left undriven. */
async function findDueExternalPause(db: Db): Promise<JobRow | undefined> {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.state, 'paused'),
        eq(jobs.pauseReason, 'external'),
        lte(jobs.nextRunAt, sql`now()`),
      ),
    )
    .orderBy(asc(jobs.nextRunAt))
    .limit(1);
  return rows[0];
}

/** Keeps the lease alive while a step (or a revert) executes (02 §5.5). */
async function withHeartbeat<T>(
  options: WorkerLoopOptions,
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tick = async (): Promise<void> => {
    try {
      await heartbeat(options.db, jobId, options.owner);
      options.logger?.debug?.('lease heartbeat', { jobId, owner: options.owner });
    } catch (err) {
      options.logger?.warn('lease heartbeat failed', { jobId, error: err });
    }
  };
  const timer = setInterval(tick, HEARTBEAT_SECONDS * 1_000);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The worker loop. Resolves when the signal aborts and the current step
 * has been executed and persisted; every other exit is a rejected promise.
 */
export async function runWorkerLoop(options: WorkerLoopOptions): Promise<void> {
  if (options.intervalMs < MIN_LOOP_INTERVAL_MS) {
    throw new Error(
      `worker loop intervalMs is ${options.intervalMs}, below ${MIN_LOOP_INTERVAL_MS}`,
    );
  }
  const registry = options.registry ?? [];
  const schedulerEveryMs = options.schedulerEveryMs ?? DEFAULT_SCHEDULER_EVERY_MS;
  const sleep = options.sleep ?? signalAwareSleep;
  const logger = options.logger;
  let nextSchedulerTickAt = options.clock();

  while (!options.signal.aborted) {
    try {
      // Scheduled operations (02 §5.11), on a clock-gated cadence. An empty
      // registry costs nothing. A failing tick is logged and backs off to
      // the same cadence — a misconfigured operation must not starve the
      // claims and probes below it.
      if (registry.length > 0 && options.clock() >= nextSchedulerTickAt) {
        try {
          const enqueued = await runSchedulerTick(options.db, registry, options.clock);
          for (const job of enqueued) {
            logger?.info('scheduled job enqueued', {
              jobId: job.id,
              type: job.type,
              nextRunAt: job.nextRunAt.toISOString(),
            });
          }
        } catch (err) {
          logger?.error('scheduler tick failed', { owner: options.owner, error: err });
        }
        nextSchedulerTickAt = options.clock() + schedulerEveryMs;
      }

      // Finish what this worker already holds before taking new work: a
      // multi-step job runs its remaining steps at iteration speed instead
      // of waiting for its own lease to expire.
      const mine = await findMyRunningJob(options.db, options.owner);
      if (mine !== undefined) {
        await executeOneStep(options, mine);
        continue;
      }

      // Recovery (02 §5.5): any worker may take an expired running lease —
      // reconciling the step that was running before anything else moves —
      // or pick up a revert whose lease is free or expired.
      const reclaimed = await reclaimExpired(options.db, options.owner, options.reconcilePort);
      if (reclaimed !== undefined) {
        logger?.debug?.('reclaimed an expired lease', {
          jobId: reclaimed.job.id,
          applied: reclaimed.applied,
        });
        await executeOneStep(options, reclaimed.job);
        continue;
      }
      const reverting = await claimRevertNext(options.db, options.owner);
      if (reverting !== undefined) {
        await runRevertingJob(options, reverting);
        continue;
      }

      // The external pause probe (02 §5.7): the schedule lives in the job's
      // `next_run_at`, so probing the oldest due job each iteration keeps
      // every paused job on its 30-second cadence without a timer.
      const paused = await findDueExternalPause(options.db);
      if (paused !== undefined) {
        const outcome = await probePausedExternal(
          options.db,
          paused.id,
          options.owner,
          () => options.probeExternal(paused),
          options.clock,
        );
        if (outcome.action === 'resume') {
          logger?.info('external pause resumed by probe', { jobId: paused.id });
          await executeOneStep(options, outcome.job);
          continue;
        }
        if (outcome.action === 'escalated') {
          logger?.warn('external pause escalated to a decision', { jobId: paused.id });
        }
        // A postponement is not a unit of work: fall through to claims.
      }

      // New work, one lane at a time in 02 §4.4 order. Iterating the lanes
      // keeps lane precedence: a single multi-lane scan would order by
      // priority and let a `maintenance` job outrank an `interactive` one.
      let claimed: JobRow | undefined;
      for (const lane of JOB_LANES) {
        claimed = await claimNext(options.db, [lane], options.owner);
        if (claimed !== undefined) break;
      }
      if (claimed !== undefined) {
        await executeOneStep(options, claimed);
        continue;
      }

      // Idle: no work anywhere. Sleep, and wake at once when signalled.
      await sleep(options.intervalMs, options.signal);
    } catch (err) {
      // The iteration boundary (02 §3.2.2): nothing here stops the loop.
      logger?.error('worker loop iteration failed', { owner: options.owner, error: err });
      await sleep(options.intervalMs, options.signal);
    }
  }
}

/** Runs the compensations of a claimed revert under a heartbeat. */
async function runRevertingJob(options: WorkerLoopOptions, job: JobRow): Promise<void> {
  try {
    const result = await withHeartbeat(options, job.id, () =>
      runRevert(options.db, job.id, options.revertPort, options.clock),
    );
    options.logger?.info('revert run finished', { jobId: job.id, action: result.action });
  } catch (err) {
    // runRevert parked any Discord failure itself; anything else leaves the
    // claim to expire, and the next worker resumes the compensations.
    options.logger?.error('revert run failed', { jobId: job.id, error: err });
  }
}

/**
 * Executes exactly one step of a job this worker holds and persists the
 * outcome. The first step not in a final status runs — `pending` in the
 * common case, `running` after a mid-execution reclaim, `failed` after a
 * retry decision — and when no step is left the job completes through the
 * state machine, with or without its recorded skips.
 */
async function executeOneStep(options: WorkerLoopOptions, job: JobRow): Promise<void> {
  const steps = await options.db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, job.id))
    .orderBy(asc(jobSteps.seq));
  const next = steps.find((step) => !FINAL_STEP_STATUSES.has(step.status));

  if (next === undefined) {
    // Every step already finished (a crash between the last step and the
    // completion move lands here on reclaim): just complete the job.
    await completeJob(options, job);
    return;
  }

  // The step is marked running before execution, so a crash mid-step
  // leaves the state reconciliation expects (02 §5.6).
  const runningRows = await options.db
    .update(jobSteps)
    .set({ status: 'running', startedAt: new Date(options.clock()) })
    .where(eq(jobSteps.id, next.id))
    .returning();
  const running = runningRows[0];
  if (!running) throw new Error(`step ${next.seq} of job ${job.id} vanished mid-loop`);

  let outcome: StepExecutionResult;
  try {
    outcome = await withHeartbeat(options, job.id, () =>
      options.executeStep({ job, step: running }),
    );
  } catch (err) {
    await handleStepError(options, job, running, err);
    return;
  }
  await persistStepSuccess(options, job, running, outcome);
}

/**
 * Persists a step failure through the todo 17 path (02 §4.13, §5.7). A
 * `DiscordOperationError` carries its own classified signal; anything else
 * maps through the taxonomy's default — an unrecognised failure parks the
 * job for an operator rather than being retried blind. A transient
 * outcome keeps the job running, and its lease is aligned to the backoff
 * so the reclaim scan resumes the step exactly on time.
 */
async function handleStepError(
  options: WorkerLoopOptions,
  job: JobRow,
  step: JobStepRow,
  err: unknown,
): Promise<void> {
  const signal: ApiErrorSignal =
    err instanceof DiscordOperationError
      ? err.signal
      : { message: err instanceof Error ? err.message : String(err) };
  options.logger?.warn('step failed', {
    jobId: job.id,
    stepSeq: step.seq,
    kind: step.kind,
    error: err,
  });

  try {
    const result = await applyStepFailure(
      options.db,
      job.id,
      { stepSeq: step.seq, signal },
      options.clock,
      options.random ?? Math.random,
    );
    if (result.action === 'retry_scheduled') {
      // The lease becomes the retry timer: it expires at the backoff
      // moment, and any worker's reclaim scan picks the step up there.
      await updateJobState(options.db, job.id, { leaseExpiresAt: result.job.nextRunAt });
      options.logger?.info('step retry scheduled', {
        jobId: job.id,
        stepSeq: step.seq,
        nextRunAt: result.job.nextRunAt.toISOString(),
      });
      return;
    }
    options.logger?.info('step failure persisted', {
      jobId: job.id,
      stepSeq: step.seq,
      action: result.action,
    });
  } catch (failureErr) {
    // The job moved underneath the failure (an operator cancelled it
    // mid-step): the machine's refusal stands, the loop keeps running.
    options.logger?.error('failed to persist a step failure', {
      jobId: job.id,
      stepSeq: step.seq,
      error: failureErr,
    });
  }
}

/**
 * Records a successful step: the step's `done` status, its result, the
 * external ids it created and their ledger rows all commit in one
 * transaction (02 §5.4), and when no step is left the job completes
 * through the machine. The completion is its own transaction: the step's
 * writes must survive an operator cancelling the job mid-step.
 */
async function persistStepSuccess(
  options: WorkerLoopOptions,
  job: JobRow,
  step: JobStepRow,
  execution: StepExecutionResult,
): Promise<void> {
  const statuses = await options.db.transaction(async (tx) => {
    await tx
      .update(jobSteps)
      .set({
        status: 'done',
        ...(execution.result !== undefined ? { result: execution.result } : {}),
        ...(execution.externalIds !== undefined
          ? { externalIds: execution.externalIds as unknown as JobStepRow['externalIds'] }
          : {}),
        ...(execution.compensation !== undefined ? { compensation: execution.compensation } : {}),
        finishedAt: new Date(options.clock()),
      })
      .where(eq(jobSteps.id, step.id));

    const owner = ledgerOwner(job);
    for (const entry of execution.externalIds ?? []) {
      await upsertDiscordObject(tx, {
        guildId: job.guildId,
        discordId: entry.discordId,
        kind: entry.kind,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        createdByJobId: job.id,
      });
    }

    await appendJobEvent(tx, job.id, {
      code: 'job.step.done',
      message: `Step ${step.seq} (${step.kind}) done`,
      data: { stepSeq: step.seq, kind: step.kind },
    });

    const rows = await tx
      .select({ status: jobSteps.status })
      .from(jobSteps)
      .where(eq(jobSteps.jobId, job.id))
      .orderBy(asc(jobSteps.seq));
    return rows.map((row) => row.status);
  });

  if (statuses.some((status) => !FINAL_STEP_STATUSES.has(status))) return;
  await completeJob(options, job);
}

/**
 * Moves a running job with every step finished to its terminal state
 * (`completed`, or `completed_with_skips` when steps were skipped, with the
 * skip count in the journal row). Refuses cleanly if the job moved
 * underneath the worker: an operator's cancel or decision stands, and the
 * loop logs it instead of failing the iteration.
 */
async function completeJob(options: WorkerLoopOptions, job: JobRow): Promise<void> {
  await options.db.transaction(async (tx) => {
    const current = await lockJobRow(tx, job.id);
    if ((current.state as JobState) !== 'running') {
      options.logger?.warn('job moved while its steps finished', {
        jobId: job.id,
        state: current.state,
      });
      return;
    }
    const rows = await tx
      .select({ status: jobSteps.status })
      .from(jobSteps)
      .where(eq(jobSteps.jobId, job.id));
    const skippedCount = rows.filter((row) => row.status === 'skipped').length;
    const event: JobEvent =
      skippedCount > 0 ? { type: 'complete_with_skips', skippedCount } : { type: 'complete' };

    const snapshot: JobSnapshot = {
      state: current.state as JobState,
      pauseReason: current.pauseReason as JobPauseReason | null,
    };
    const result = transition(snapshot, event, { detail: `${rows.length} steps` });
    const draft = result.events[0];
    if (!draft) throw new Error('state machine produced no event row');
    await appendJobEvent(tx, job.id, draft);
    await updateJobState(tx, job.id, {
      state: result.state,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: new Date(options.clock()),
    });
  });
  options.logger?.info('job completed', { jobId: job.id });
}
