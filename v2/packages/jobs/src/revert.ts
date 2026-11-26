/**
 * The revert engine (plan 02 §5.9) and the revert claim path (02 §5.5).
 *
 * `claimRevertNext` is the reverting-state twin of `claimNext`: reverting
 * jobs are never routed through the `queued|paused` claim scan (the state
 * machine has no edge out of `reverting`), and before this existed nothing
 * recovered a crashed revert (task-16 gate finding F3). The scan is
 * `FOR UPDATE SKIP LOCKED` over `state = 'reverting'` jobs whose probe/due
 * time has arrived and whose lease is free or expired, so a revert worker
 * that dies mid-compensation is resumed by the next worker under a fresh
 * 60-second lease.
 *
 * `runRevert` walks the done, reversible steps in reverse sequence order
 * and executes each step's compensation through the injected
 * {@link RevertPort} — no Discord I/O lives here; the worker wires the real
 * adapter to the port later. A channel with human messages is archived,
 * never deleted (02 §5.9); a category is deleted only when empty; DB rows
 * the job created are deleted through the port as well, because the domain
 * tables they live in are not this engine's to touch. Every compensated
 * step is persisted in its own transaction, so a crash never re-executes a
 * compensation that already succeeded. Non-reversible steps are listed in
 * the journal and left alone.
 */
import {
  appendJobEvent,
  type Db,
  type DbOrTx,
  type DbTx,
  discordObjects,
  type JobRow,
  type JobStepRow,
  jobSteps,
  jobs,
  NotFoundError,
  updateJobState,
} from '@drawbridge/db';
import { and, asc, desc, eq, lt, lte, or, sql } from 'drizzle-orm';
import { LEASE_SECONDS, lockJobRow } from './engine.js';
import { classifyError, DiscordOperationError, signalData } from './errors.js';
import { type Clock, rateLimitRetryAt } from './retry.js';
import {
  type JobEvent,
  type JobPauseReason,
  type JobSnapshot,
  type TransitionContext,
  type TransitionResult,
  transition,
} from './state.js';

/** One permission-overwrite entry captured before the job edited it (02 §5.9). */
export interface OverwriteSnapshot {
  discordId: string;
  type: 'role' | 'member';
  /** Permission bitfields, as strings: snowflake-safe and stable. */
  allow: string;
  deny: string;
}

/** One domain-table row the job created, for the DB-row compensation (02 §5.9). */
export interface DbRowDeletion {
  table: string;
  criteria: Record<string, string | number>;
}

/**
 * What a step's `compensation` jsonb holds. Written by the step executor
 * in the same transaction that marks the step done; the revert engine
 * trusts the shape, exactly as reconciliation trusts `external_ids`.
 */
export type Compensation =
  | { kind: 'delete_role'; roleId: string }
  | { kind: 'delete_channel'; channelId: string }
  | { kind: 'delete_category'; categoryId: string }
  | { kind: 'restore_overwrites'; channelId: string; overwrites: readonly OverwriteSnapshot[] }
  | { kind: 'delete_db_rows'; rows: readonly DbRowDeletion[] };

/**
 * Whether executing this compensation destroys anything (02 §5.8: a revert
 * that deletes requires `tournament.destructive`). A channel compensation
 * counts as deleting even though it archives on human messages, because
 * the decision is made before the message check runs.
 */
export function compensationDeletes(compensation: Compensation): boolean {
  switch (compensation.kind) {
    case 'delete_role':
    case 'delete_channel':
    case 'delete_category':
    case 'delete_db_rows':
      return true;
    case 'restore_overwrites':
      return false;
  }
  return compensation satisfies never;
}

/**
 * Whether reverting these steps would delete anything: only steps that are
 * done, reversible and carrying a compensation can be compensated, so only
 * those count (02 §5.8-5.9).
 */
export function revertRequiresDestructive(steps: readonly JobStepRow[]): boolean {
  return steps.some(
    (step) =>
      step.status === 'done' &&
      step.reversible &&
      step.compensation !== null &&
      compensationDeletes(step.compensation as unknown as Compensation),
  );
}

/**
 * The Discord and DB access the revert engine needs. Implemented by the
 * worker over the real Discord REST client and the domain repositories;
 * faked in tests. Every method may throw {@link DiscordOperationError}
 * with the classified signal of the failure it hit.
 */
export interface RevertPort {
  /** Whether anyone but the bot ever posted in the channel (02 §5.9). */
  channelHasHumanMessages(guildId: string, channelId: string): Promise<boolean>;
  /** Whether the category holds any channel (02 §5.9). */
  categoryIsEmpty(guildId: string, categoryId: string): Promise<boolean>;
  deleteRole(guildId: string, roleId: string): Promise<void>;
  deleteChannel(guildId: string, channelId: string): Promise<void>;
  /** The 02 §5.9 fallback for a channel with human messages. */
  archiveChannel(guildId: string, channelId: string): Promise<void>;
  deleteCategory(guildId: string, categoryId: string): Promise<void>;
  restoreOverwrites(
    guildId: string,
    channelId: string,
    overwrites: readonly OverwriteSnapshot[],
  ): Promise<void>;
  /** Deletes DB rows the job created, in the domain tables this engine does not own. */
  deleteDbRows(guildId: string, rows: readonly DbRowDeletion[]): Promise<void>;
}

/** How many reverting candidates one claim examines, mirroring the claim scan. */
const REVERT_SCAN_LIMIT = 20;

/**
 * Claims the next due reverting job for a worker (02 §5.5, §5.9): the
 * oldest due revert in priority order, locked with `FOR UPDATE SKIP LOCKED`
 * so two workers never take the same revert. A revert is claimable when
 * its lease is free (freshly decided) or expired (a crashed worker), and
 * `next_run_at` has arrived — a rate-limited compensation postpones the
 * claim until its `retry_after`. The job stays in `reverting`; the machine
 * has no edge out of it until the compensations finish.
 */
export async function claimRevertNext(db: Db, owner: string): Promise<JobRow | undefined> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.state, 'reverting'),
          lte(jobs.nextRunAt, sql`now()`),
          or(sql`${jobs.leaseExpiresAt} is null`, lt(jobs.leaseExpiresAt, sql`now()`)),
        ),
      )
      .orderBy(desc(jobs.priority), asc(jobs.nextRunAt), asc(jobs.createdAt))
      .limit(REVERT_SCAN_LIMIT);

    for (const candidate of candidates) {
      // Re-check the mutable predicates on the locked row, as the claim
      // scan does: the revert may have been claimed or postponed since.
      const locked = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, candidate.id),
            eq(jobs.state, 'reverting'),
            lte(jobs.nextRunAt, sql`now()`),
            or(sql`${jobs.leaseExpiresAt} is null`, lt(jobs.leaseExpiresAt, sql`now()`)),
          ),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      const job = locked[0];
      if (!job) continue;

      const updated = await tx
        .update(jobs)
        .set({
          leaseOwner: owner,
          leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
          attempt: job.attempt + 1,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id))
        .returning();
      await appendJobEvent(tx, job.id, {
        code: 'job.revert.claimed',
        message: `Revert claimed by ${owner}`,
        data: { previousOwner: job.leaseOwner },
      });
      return requireRow(updated, 'revert claim update');
    }
    return undefined;
  });
}

function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/** What one compensation did, in the journal row and the result. */
export type CompensationOutcome =
  | 'deleted'
  | 'archived'
  | 'restored'
  | 'db_rows_deleted'
  | 'left_in_place';

/** What a revert run concluded. */
export interface RevertRunResult {
  action: 'reverted' | 'ratelimit_postponed' | 'awaiting_decision';
  /** Steps compensated in this run, in the order they ran (descending seq). */
  compensated: number[];
}

/**
 * Runs the compensations of a reverting job (02 §5.9), resuming where a
 * crashed worker left off: steps already `compensated` are skipped, steps
 * that are not done (or not reversible, or without a compensation) are
 * listed and left alone. Each compensation is one transaction — the port
 * call, the step status, the journal row and the ledger update all commit
 * together — so a crash between compensations loses nothing. A rate
 * limit postpones the rest of the revert until `retry_after` without
 * consuming anything; any other Discord failure parks the job in
 * `awaiting_decision`, from which an operator answers `decide_revert` to
 * resume (the machine's reverting escape hatch).
 */
export async function runRevert(
  db: Db,
  jobId: string,
  port: RevertPort,
  clock: Clock,
): Promise<RevertRunResult> {
  const job = await findJob(db, jobId);
  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId))
    .orderBy(desc(jobSteps.seq));
  const compensated: number[] = [];

  for (const step of steps) {
    if (step.status !== 'done') continue;
    const compensation = step.compensation as unknown as Compensation | null;
    if (!step.reversible || compensation === null) {
      await appendJobEvent(db, jobId, {
        code: 'job.revert.not_reversible',
        message: `Step ${step.seq} (${step.kind}) is not reversible; left in place`,
        data: { stepSeq: step.seq },
      });
      continue;
    }

    let outcome: CompensationOutcome;
    try {
      outcome = await db.transaction((tx) =>
        executeCompensation(tx, job, step, compensation, port),
      );
    } catch (err) {
      return await parkRevertFailure(db, jobId, step, err, clock, compensated);
    }
    if (outcome !== 'left_in_place') compensated.push(step.seq);
  }

  await db.transaction(async (tx) => {
    const current = await lockJobRow(tx, jobId);
    const move = await applyMove(
      tx,
      current,
      { type: 'finish_revert' },
      {
        detail: `${compensated.length} steps compensated`,
      },
    );
    return updateJobState(tx, jobId, {
      state: move.state,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: new Date(clock()),
    });
  });
  return { action: 'reverted', compensated };
}

/** One job row, unlocked (the revert runs under the claim's single lease). */
async function findJob(db: DbOrTx, jobId: string): Promise<JobRow> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) throw new NotFoundError('job not found');
  return job;
}

/** Applies one machine move inside the caller's transaction. */
async function applyMove(
  tx: DbTx,
  job: JobRow,
  event: JobEvent,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  const snapshot: JobSnapshot = {
    state: job.state as JobSnapshot['state'],
    pauseReason: job.pauseReason as JobPauseReason | null,
  };
  const result = transition(snapshot, event, ctx);
  const draft = result.events[0];
  if (!draft) throw new Error('state machine produced no event row');
  await appendJobEvent(tx, job.id, draft);
  return result;
}

/** Marks the ledger row of a compensated object deleted or archived. */
async function markLedger(
  tx: DbTx,
  guildId: string,
  discordId: string,
  state: 'deleted' | 'archived',
): Promise<void> {
  await tx
    .update(discordObjects)
    .set(
      state === 'deleted'
        ? { state: 'deleted', deletedAt: sql`now()` }
        : { state: 'archived', archivedAt: sql`now()` },
    )
    .where(and(eq(discordObjects.guildId, guildId), eq(discordObjects.discordId, discordId)));
}

/**
 * Executes one step's compensation and persists its result: the port call,
 * the step's `compensated` status, the journal row and the ledger update
 * commit in the caller's transaction, so a rolled-back compensation leaves
 * the step `done` and the revert resumable.
 */
async function executeCompensation(
  tx: DbTx,
  job: JobRow,
  step: JobStepRow,
  compensation: Compensation,
  port: RevertPort,
): Promise<CompensationOutcome> {
  const guildId = job.guildId;
  let outcome: CompensationOutcome;
  let deviated = false;

  switch (compensation.kind) {
    case 'delete_role': {
      await port.deleteRole(guildId, compensation.roleId);
      await markLedger(tx, guildId, compensation.roleId, 'deleted');
      outcome = 'deleted';
      break;
    }
    case 'delete_channel': {
      // 02 §5.9: delete only when no non-bot message was ever posted;
      // otherwise archive, and say so at warn level.
      if (await port.channelHasHumanMessages(guildId, compensation.channelId)) {
        await port.archiveChannel(guildId, compensation.channelId);
        await markLedger(tx, guildId, compensation.channelId, 'archived');
        outcome = 'archived';
        deviated = true;
      } else {
        await port.deleteChannel(guildId, compensation.channelId);
        await markLedger(tx, guildId, compensation.channelId, 'deleted');
        outcome = 'deleted';
      }
      break;
    }
    case 'delete_category': {
      // 02 §5.9: delete only if empty; foreign channels keep the category.
      if (await port.categoryIsEmpty(guildId, compensation.categoryId)) {
        await port.deleteCategory(guildId, compensation.categoryId);
        await markLedger(tx, guildId, compensation.categoryId, 'deleted');
        outcome = 'deleted';
      } else {
        outcome = 'left_in_place';
        deviated = true;
      }
      break;
    }
    case 'restore_overwrites': {
      await port.restoreOverwrites(guildId, compensation.channelId, compensation.overwrites);
      outcome = 'restored';
      break;
    }
    case 'delete_db_rows': {
      await port.deleteDbRows(guildId, compensation.rows);
      outcome = 'db_rows_deleted';
      break;
    }
    default: {
      // The jsonb column is trusted, but a corrupt kind fails loudly here
      // instead of being marked compensated in silence.
      const unknown: never = compensation;
      throw new Error(`unknown compensation kind: ${JSON.stringify(unknown)}`);
    }
  }

  if (outcome !== 'left_in_place') {
    await tx.update(jobSteps).set({ status: 'compensated' }).where(eq(jobSteps.id, step.id));
  }
  await appendJobEvent(tx, job.id, {
    level: deviated ? 'warn' : 'info',
    code: 'job.step.compensated',
    message: `Step ${step.seq} (${compensation.kind}): ${outcome.replace(/_/g, ' ')}`,
    data: { stepSeq: step.seq, kind: compensation.kind, outcome },
  });
  return outcome;
}

/**
 * Applies a compensation failure's verdict (02 §4.13, §5.7): a rate limit
 * postpones the rest of the revert until `retry_after` — attempts are not
 * consumed and the job stays `reverting`, so `claimRevertNext` resumes it
 * on time; every other class parks the job in `awaiting_decision` with the
 * named cause, from which `decide_revert` resumes the revert. A non-Discord
 * error is rethrown: the transaction already rolled back, the lease will
 * expire, and another worker retries the compensation (02 §5.5).
 */
async function parkRevertFailure(
  db: Db,
  jobId: string,
  step: JobStepRow,
  err: unknown,
  clock: Clock,
  compensated: number[],
): Promise<RevertRunResult> {
  if (!(err instanceof DiscordOperationError)) throw err;
  const cls = classifyError(err.signal);

  if (cls === 'rate_limited') {
    const retryAfter = err.signal.retryAfterSeconds ?? 1;
    await db.transaction(async (tx) => {
      await appendJobEvent(tx, jobId, {
        level: 'warn',
        code: 'job.revert.ratelimited',
        message: `Rate limited compensating step ${step.seq}; retry after ${retryAfter}s`,
        data: { stepSeq: step.seq, retryAfterSeconds: retryAfter },
      });
      await updateJobState(tx, jobId, {
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: rateLimitRetryAt(retryAfter, clock),
      });
    });
    return { action: 'ratelimit_postponed', compensated };
  }

  await db.transaction(async (tx) => {
    const job = await lockJobRow(tx, jobId);
    const move = await applyMove(
      tx,
      job,
      { type: 'need_decision' },
      {
        detail: `${cls} compensating step ${step.seq}: ${err.message}`,
      },
    );
    await updateJobState(tx, jobId, {
      state: move.state,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: { class: cls, stepSeq: step.seq, ...signalData(err.signal) },
    });
  });
  return { action: 'awaiting_decision', compensated };
}
