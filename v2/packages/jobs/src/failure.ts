/**
 * Failure application and the external pause/probe loop (plan 02 §4.13,
 * §5.7): what the engine does when a step fails, when an external
 * dependency (Citadel or the database) goes away, and when a
 * `paused(external)` probe comes due.
 *
 * Every move the job itself makes goes through the pure state machine,
 * which owns legality and the journal row; this module decides which move a
 * classified failure prescribes and persists the schedule the caller (the
 * worker loop, a later todo) follows. Time comes from the injected clock;
 * there is not a single sleep or timer in this file. A transient failure
 * keeps the job `running` under its lease with `next_run_at` pushed out as
 * the earliest re-execution time — the paused states are reserved for the
 * three reasons the plan names, and `transient` is not one of them.
 */
import {
  alerts,
  appendJobEvent,
  type Db,
  type DbTx,
  discordObjects,
  type JobRow,
  type JobStepRow,
  jobEvents,
  jobSteps,
  jobs,
  NotFoundError,
  updateJobState,
} from '@drawbridge/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { LEASE_SECONDS, lockJobRow } from './engine.js';
import {
  type ApiErrorSignal,
  classifyError,
  isPermanentErrorClass,
  type JobErrorClass,
  signalData,
} from './errors.js';
import {
  type Clock,
  type ExternalPauseAction,
  evaluateExternalPause,
  guildUnavailableRetryAt,
  isTransientExhausted,
  nextProbeAt,
  nextRetryAt,
  type Random01,
  rateLimitRetryAt,
  TRANSIENT_MAX_ATTEMPTS,
} from './retry.js';
import {
  InvalidTransition,
  type JobEvent,
  type JobPauseReason,
  type JobSnapshot,
  type TransitionContext,
  type TransitionResult,
  transition,
} from './state.js';

/**
 * The §4.13 handling note each permanent class names in its journal row,
 * so an operator reads why the job parked, not just that it did.
 */
const PERMANENT_CAUSES: Record<Exclude<JobErrorClass, 'rate_limited' | 'transient'>, string> = {
  fatal_config: 'authentication failed; all Discord writes must stop until the token is fixed',
  missing_permission: 'the bot is missing the role or channel access this step needs',
  object_missing: 'a Discord object this step depends on no longer exists',
  capacity: 'a Discord capacity limit was reached',
  invalid_input: 'the request was invalid; the plan must be fixed before the step can run',
};

/** The 429 wake-up used when a body could not be parsed; Discord always sends one. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** How a step failure was applied. */
export type StepFailureAction =
  | 'retry_scheduled'
  | 'ratelimit_paused'
  | 'guild_unavailable_paused'
  | 'failed'
  | 'awaiting_decision';

export interface StepFailureResult {
  job: JobRow;
  action: StepFailureAction;
}

/** The failure the step executor reports: which step, with what signal. */
export interface StepFailureInput {
  stepSeq: number;
  signal: ApiErrorSignal;
  /**
   * The Discord object the failure is about, when the executor knows it.
   * An `object_missing` failure marks this object's ledger row `missing`
   * (02 §4.13).
   */
  objectId?: string;
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

/** The step of a job, by sequence number. */
async function findStep(tx: DbTx, jobId: string, stepSeq: number): Promise<JobStepRow> {
  const rows = await tx
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.seq, stepSeq)))
    .limit(1);
  const step = rows[0];
  if (!step) throw new NotFoundError(`step ${stepSeq} of job ${jobId} not found`);
  return step;
}

/**
 * Applies a step failure to the journal and the job (plan 02 §4.13, §5.7).
 *
 * The classified signal decides the move: a 10004 Unknown Guild pauses the
 * job with reason `guild_unavailable` on a 30-second retry schedule and
 * asks for a decision; `rate_limited` pauses the job until `retry_after`
 * without consuming a step attempt; `transient` keeps the job `running`
 * under its lease with `next_run_at` pushed to the next backoff slot, and
 * fails the job once 6 attempts are spent; every permanent class parks the
 * job in `awaiting_decision` at once, naming its cause — and
 * `fatal_config` additionally opens an alert. One `job.step.failure` row
 * records the signal; the state machine emits its own row whenever the
 * job's state actually moves. The job must be `running`; anything else is
 * an illegal move the machine rejects.
 */
export async function applyStepFailure(
  db: Db,
  jobId: string,
  failure: StepFailureInput,
  clock: Clock,
  random: Random01,
): Promise<StepFailureResult> {
  return db.transaction(async (tx) => {
    const job = await lockJobRow(tx, jobId);
    // Only a running job reports step failures: the machine's pause, fail
    // and need_decision edges all leave `running`, and a transient retry
    // schedule is meaningless on a job nobody is executing.
    if (job.state !== 'running') {
      throw new InvalidTransition(
        job.state as JobSnapshot['state'],
        'fail',
        `cannot apply a step failure from state '${job.state}'`,
      );
    }
    const step = await findStep(tx, jobId, failure.stepSeq);
    const signal = signalData(failure.signal);

    // The guild itself is unavailable (02 §5.3's third pause reason): a
    // 10004 Unknown Guild on a guild-scoped write means the bot was removed
    // mid-job. That is neither a taxonomy class to park on nor an object
    // that went missing — it is `paused(guild_unavailable)`, with a
    // 30-second claim-retry schedule that resumes the job on its own once
    // the bot is back, and an explicit ask for a decision because an
    // operator may prefer to abort or revert instead of waiting.
    if (failure.signal.code === 10004) {
      await tx
        .update(jobSteps)
        .set({ status: 'failed', error: { guildUnavailable: true, ...signal } })
        .where(eq(jobSteps.id, step.id));
      await appendJobEvent(tx, jobId, {
        level: 'warn',
        code: 'job.step.failure',
        message: `Step ${failure.stepSeq} failed: the guild is unavailable${
          failure.signal.message === undefined ? '' : ` (${failure.signal.message})`
        }`,
        data: { stepSeq: failure.stepSeq, guildUnavailable: true, ...signal },
      });
      const paused = await applyMove(
        tx,
        job,
        { type: 'pause', reason: 'guild_unavailable' },
        { detail: `the bot is no longer in guild ${job.guildId}` },
      );
      const updated = await updateJobState(tx, jobId, {
        state: paused.state,
        pauseReason: paused.pauseReason,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: guildUnavailableRetryAt(clock),
      });
      await appendJobEvent(tx, jobId, {
        level: 'warn',
        code: 'job.guild_unavailable',
        message:
          'Decision needed: re-invite the bot to resume this job on its own, or abort/revert it',
        data: { guildId: job.guildId, stepSeq: failure.stepSeq },
      });
      return { job: updated, action: 'guild_unavailable_paused' };
    }

    const cls = classifyError(failure.signal);

    // The step records the classified signal whatever the engine does next.
    await tx
      .update(jobSteps)
      .set({ status: 'failed', error: { class: cls, ...signal } })
      .where(eq(jobSteps.id, step.id));
    await appendJobEvent(tx, jobId, {
      level: isPermanentErrorClass(cls) ? 'error' : 'warn',
      code: 'job.step.failure',
      message: `Step ${failure.stepSeq} failed: ${cls}${
        failure.signal.message === undefined ? '' : ` (${failure.signal.message})`
      }`,
      data: { stepSeq: failure.stepSeq, class: cls, ...signal },
    });

    if (cls === 'rate_limited') {
      // 02 §5.7: wait retry_after; the attempt is not consumed.
      const retryAfter = failure.signal.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      const result = await applyMove(
        tx,
        job,
        { type: 'pause', reason: 'ratelimit' },
        {
          detail: `rate limited on step ${failure.stepSeq}; retry after ${retryAfter}s`,
        },
      );
      const updated = await updateJobState(tx, jobId, {
        state: result.state,
        pauseReason: result.pauseReason,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: rateLimitRetryAt(retryAfter, clock),
      });
      return { job: updated, action: 'ratelimit_paused' };
    }

    if (cls === 'transient') {
      const attempts = step.attempts + 1;
      await tx.update(jobSteps).set({ attempts }).where(eq(jobSteps.id, step.id));
      if (isTransientExhausted(attempts)) {
        const result = await applyMove(
          tx,
          job,
          { type: 'fail' },
          {
            detail: `transient retries exhausted for step ${failure.stepSeq}`,
          },
        );
        const updated = await updateJobState(tx, jobId, {
          state: result.state,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: new Date(clock()),
          error: { class: cls, stepSeq: failure.stepSeq, ...signal },
        });
        return { job: updated, action: 'failed' };
      }
      const nextRunAt = nextRetryAt(attempts, clock, random);
      const updated = await updateJobState(tx, jobId, { nextRunAt });
      await appendJobEvent(tx, jobId, {
        level: 'warn',
        code: 'job.step.retry_scheduled',
        message: `Step ${failure.stepSeq} transient failure; retry ${attempts}/${TRANSIENT_MAX_ATTEMPTS} at the backoff time`,
        data: { stepSeq: failure.stepSeq, attempt: attempts, nextRunAt: nextRunAt.toISOString() },
      });
      return { job: updated, action: 'retry_scheduled' };
    }

    // Permanent (02 §4.13): park at once with the named cause.
    const permanent = cls as Exclude<JobErrorClass, 'rate_limited' | 'transient'>;
    const cause =
      failure.signal.message === undefined
        ? `${permanent}: ${PERMANENT_CAUSES[permanent]}`
        : `${permanent}: ${PERMANENT_CAUSES[permanent]}: ${failure.signal.message}`;
    const result = await applyMove(tx, job, { type: 'need_decision' }, { detail: cause });
    if (permanent === 'object_missing' && failure.objectId !== undefined) {
      await tx
        .update(discordObjects)
        .set({ state: 'missing' })
        .where(
          and(
            eq(discordObjects.guildId, job.guildId),
            eq(discordObjects.discordId, failure.objectId),
          ),
        );
    }
    if (permanent === 'fatal_config') {
      await tx.insert(alerts).values({
        kind: 'job.fatal_config',
        severity: 'critical',
        guildId: job.guildId,
        leagueId: job.leagueId,
        jobId,
        details: { stepSeq: failure.stepSeq, ...signal },
      });
    }
    const updated = await updateJobState(tx, jobId, {
      state: result.state,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: { class: cls, stepSeq: failure.stepSeq, ...signal },
    });
    return { job: updated, action: 'awaiting_decision' };
  });
}

/**
 * Parks a running job because an external dependency (Citadel or the
 * database) is unavailable (02 §5.7). The pause schedules the first probe
 * 30 seconds out; the job resumes only through a successful
 * `probePausedExternal`, never through the claim scan.
 */
export async function pauseExternal(
  db: Db,
  jobId: string,
  detail: string,
  clock: Clock,
): Promise<JobRow> {
  return db.transaction(async (tx) => {
    const job = await lockJobRow(tx, jobId);
    const result = await applyMove(tx, job, { type: 'pause', reason: 'external' }, { detail });
    return updateJobState(tx, jobId, {
      state: result.state,
      pauseReason: result.pauseReason,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextRunAt: nextProbeAt(clock),
    });
  });
}

/** What a `paused(external)` probe concluded. */
export type ExternalProbeOutcome =
  | { action: 'resume'; job: JobRow }
  | { action: 'postponed'; job: JobRow }
  | { action: 'escalated'; job: JobRow }
  | { action: 'not_due'; nextRunAt: Date }
  | { action: 'not_paused_external' };

/**
 * Runs one `paused(external)` probe on a due job (02 §5.7) and applies the
 * evaluator's verdict. The probe runs inside the job's row-lock
 * transaction (the same pattern as reconciliation: one cheap read), so two
 * probers can never race a resume. A successful probe resumes the job
 * through the state machine and hands the caller a fresh lease; a failing
 * one postpones the next probe 30 seconds without a journal row (a probe
 * every 30 seconds would flood the log); after 24 hours of failing probes
 * the job escalates to `awaiting_decision`.
 */
export async function probePausedExternal(
  db: Db,
  jobId: string,
  owner: string,
  probe: () => Promise<boolean>,
  clock: Clock,
): Promise<ExternalProbeOutcome> {
  return db.transaction(async (tx) => {
    const job = await lockJobRow(tx, jobId);
    if (job.state !== 'paused' || job.pauseReason !== 'external') {
      return { action: 'not_paused_external' };
    }
    const now = clock();
    if (job.nextRunAt.getTime() > now) {
      return { action: 'not_due', nextRunAt: job.nextRunAt };
    }

    // The pause moment is the journal's `job.paused` row, not a column, so
    // the 24-hour escalation window needed no schema change.
    const pausedSince = (await findPauseStartedAt(tx, jobId)) ?? now;
    const verdict: ExternalPauseAction = evaluateExternalPause({
      now,
      pausedSince,
      probeSucceeded: await probe(),
    });

    if (verdict.action === 'resume') {
      const result = await applyMove(
        tx,
        job,
        { type: 'resume' },
        {
          detail: `external probe succeeded; resumed by ${owner}`,
        },
      );
      // Lease arithmetic stays in SQL on the database clock (the repo
      // patch is Date-typed and cannot express it), as in claimNext.
      const rows = await tx
        .update(jobs)
        .set({
          state: result.state,
          pauseReason: result.pauseReason,
          leaseOwner: owner,
          leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
          nextRunAt: new Date(now),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId))
        .returning();
      const resumed = rows[0];
      if (!resumed) throw new NotFoundError('job not found');
      return { action: 'resume', job: resumed };
    }

    if (verdict.action === 'escalate') {
      const result = await applyMove(
        tx,
        job,
        { type: 'need_decision' },
        {
          detail: 'external dependency unavailable for over 24 hours',
        },
      );
      const escalated = await updateJobState(tx, jobId, {
        state: result.state,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return { action: 'escalated', job: escalated };
    }

    const postponed = await updateJobState(tx, jobId, { nextRunAt: nextProbeAt(clock) });
    return { action: 'postponed', job: postponed };
  });
}

/** When the job's current pause began, from the journal; undefined when unrecorded. */
async function findPauseStartedAt(tx: DbTx, jobId: string): Promise<number | undefined> {
  const rows = await tx
    .select({ at: jobEvents.at, data: jobEvents.data })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.code, 'job.paused')))
    .orderBy(desc(jobEvents.at), desc(jobEvents.id))
    .limit(1);
  const row = rows[0];
  if (!row || (row.data as { reason?: unknown }).reason !== 'external') return undefined;
  return row.at.getTime();
}
