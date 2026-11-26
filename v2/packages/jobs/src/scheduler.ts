/**
 * The scheduled-operation registry and its driver (plan 02 §5.11).
 *
 * Deadline checks, retention, reconciliation, Citadel refresh and launchpad
 * refresh are recurring maintenance operations. They run through the same
 * job engine as everything else: each occurrence is an ordinary job row in
 * the `maintenance` lane whose `next_run_at` says when it is due, and the
 * existing claim scan executes it — the schedule lives in the database, not
 * in a timer.
 *
 * This module owns the recurrence. A tick of {@link runSchedulerTick} looks
 * at every registered operation and every active league, selects the
 * operation's latest job by `next_run_at` (the scheduled moment of its most
 * recent occurrence) and, when no occurrence is in flight, enqueues the
 * next one per league with `next_run_at` set one interval after that
 * anchor — a first occurrence for a league that never ran is due
 * immediately. The anchor is a job column, so a restart or a second worker
 * reconstructs the schedule from the database alone.
 *
 * The registry is deliberately empty at this commit. The operations the
 * plan names arrive with their step executors: `launchpad.refresh`
 * (todo 32), `channel.reconcile` (todo 33) and `retention.run` (todo 52).
 * To register one, add a {@link ScheduledOperation} entry to the worker's
 * `MAINTENANCE_OPERATIONS` array (`apps/worker/src/index.ts`) once the
 * op's step kinds are executable by the wired step executor (todo 25) —
 * the scheduler itself needs no changes.
 *
 * No clocks or timers live here: time flows through the injected clock,
 * and the worker loop (todo 18, `loop.ts`) drives ticks on its own
 * clock-gated cadence, so a tick is pure database work and never spins.
 */
import {
  ConflictError,
  type CreateJobInput,
  type CreateJobStepInput,
  type Db,
  type JobRow,
  jobs,
  leagues,
} from '@drawbridge/db';
import { and, desc, eq } from 'drizzle-orm';
import { enqueueJob } from './engine.js';
import type { Clock } from './retry.js';

/**
 * The states in which an occurrence is still in flight (02 §5.10's active
 * set). While the latest occurrence is in one of these, it *is* the
 * schedule: nothing new is enqueued, and the duplicate guard would refuse a
 * second occurrence anyway.
 */
const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'paused',
  'awaiting_decision',
]);

/** The smallest recurrence the scheduler accepts; smaller values would spin. */
export const MIN_OPERATION_INTERVAL_MS = 1_000;

/**
 * One recurring maintenance operation (02 §5.11). Immutable and
 * code-defined: the registry is composed by the worker, not stored in the
 * database, so an operation's cadence and plan change by deployment, not by
 * mutation.
 */
export interface ScheduledOperation {
  /** Job type of every occurrence, for example `retention.run`. */
  readonly type: string;
  /** Milliseconds between occurrences, at least {@link MIN_OPERATION_INTERVAL_MS}. */
  readonly intervalMs: number;
  /** Priority of every occurrence within the `maintenance` lane. */
  readonly priority?: number;
  /** Extra job params every occurrence carries. */
  readonly params?: Record<string, unknown>;
  /** The immutable plan every occurrence carries. */
  readonly plan: Record<string, unknown>;
  /** The step list every occurrence carries; kinds must be executable (todo 25). */
  readonly steps: readonly CreateJobStepInput[];
}

/** The composed set of maintenance operations a worker schedules. */
export type ScheduledOperationRegistry = readonly ScheduledOperation[];

/**
 * The plan hash of every occurrence of an operation in a league. One
 * deterministic hash per (operation, league) means the duplicate guard
 * (02 §5.10) arbitrates concurrent ticks for free: two workers that both
 * decide the schedule is due race on the insert, exactly one row appears,
 * and the loser's `ConflictError` is the skip signal.
 */
export function scheduledPlanHash(type: string, leagueId: string): string {
  return `sched:${type}:${leagueId}`;
}

/**
 * Selects the operations whose schedule is due and enqueues the next
 * occurrence per league (02 §5.11), returning the jobs it created.
 *
 * For each operation and each active league: the latest job of the
 * operation's type in that league — selected by `next_run_at`, the
 * scheduled moment of the most recent occurrence — is the schedule anchor.
 * An occurrence in an active state means the schedule is already held and
 * nothing is enqueued (an `awaiting_decision` occurrence therefore parks
 * the schedule until an operator resolves it, which is the point: a
 * broken operation must not be re-run behind an unresolved decision).
 * Otherwise the next occurrence is enqueued with
 * `next_run_at = anchor + intervalMs` — immediately due for a league that
 * never ran the operation, and catch-up due when the worker was down
 * across slots, one occurrence at a time. A `ConflictError` from a
 * concurrent tick is a skip, not a failure.
 */
export async function runSchedulerTick(
  db: Db,
  registry: ScheduledOperationRegistry,
  clock: Clock,
): Promise<readonly JobRow[]> {
  for (const operation of registry) {
    if (operation.intervalMs < MIN_OPERATION_INTERVAL_MS) {
      throw new Error(
        `scheduled operation '${operation.type}' has intervalMs ` +
          `${operation.intervalMs}, below ${MIN_OPERATION_INTERVAL_MS}`,
      );
    }
  }

  const enqueued: JobRow[] = [];
  for (const operation of registry) {
    const activeLeagues = await db
      .select({ id: leagues.id, guildId: leagues.guildId })
      .from(leagues)
      .where(eq(leagues.status, 'active'));

    for (const league of activeLeagues) {
      const latestRows = await db
        .select({ state: jobs.state, nextRunAt: jobs.nextRunAt })
        .from(jobs)
        .where(and(eq(jobs.type, operation.type), eq(jobs.leagueId, league.id)))
        .orderBy(desc(jobs.nextRunAt), desc(jobs.createdAt))
        .limit(1);
      const latest = latestRows[0];

      // In flight: the latest occurrence is the schedule (02 §5.10).
      if (latest !== undefined && ACTIVE_JOB_STATES.has(latest.state)) continue;

      // The anchor is the latest occurrence's scheduled moment; a league
      // that never ran the operation is due at once.
      const nextRunAt =
        latest === undefined
          ? new Date(clock())
          : new Date(latest.nextRunAt.getTime() + operation.intervalMs);

      const input: CreateJobInput = {
        type: operation.type,
        guildId: league.guildId,
        leagueId: league.id,
        lane: 'maintenance',
        ...(operation.priority !== undefined ? { priority: operation.priority } : {}),
        ...(operation.params !== undefined ? { params: operation.params } : {}),
        plan: operation.plan,
        planHash: scheduledPlanHash(operation.type, league.id),
        nextRunAt,
        steps: operation.steps,
      };
      try {
        enqueued.push(await enqueueJob(db, input));
      } catch (err) {
        // Two concurrent ticks agreed the schedule was due: the duplicate
        // guard kept it to one occurrence (02 §5.10).
        if (err instanceof ConflictError) continue;
        throw err;
      }
    }
  }
  return enqueued;
}
