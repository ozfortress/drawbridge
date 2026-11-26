/**
 * Pure job state machine (plan 02 §5.3-5.4).
 *
 * This module is the job engine's rulebook, not the engine. It owns the job
 * states, the legal moves between them and the journal row each move emits.
 * It holds no clock, performs no I/O and touches no database: `transition`
 * returns the `job_events` row to write plus the job fields to persist, and
 * the caller does the writing. Leases, claims, retries, probes and
 * reconciliation (02 §5.5-5.7) are engine concerns that stay outside this
 * pure core, which is what makes the table exhaustively testable.
 *
 * Journal rows carry only level, code, message and data: id, job_id and at
 * come from the database (packages/db job_events). Level policy: progress
 * is `info`, deviations an operator should see are `warn`, failures are
 * `error`.
 */

/** Job states (plan 02 §5.3). */
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

/** Why a running job paused (plan 02 §5.3). */
export type JobPauseReason = 'external' | 'ratelimit' | 'guild_unavailable';

/** Step statuses (plan 02 §5.4). */
export type JobStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'compensated';

/** Journal row levels, matching the job_events CHECK. */
export type JobEventLevel = 'info' | 'warn' | 'error';

export const JOB_STATES: readonly JobState[] = [
  'queued',
  'running',
  'paused',
  'awaiting_decision',
  'completed',
  'completed_with_skips',
  'failed',
  'cancelled',
  'reverting',
  'reverted',
];

/** States with no outgoing transitions; a finished job is never re-opened. */
export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'completed',
  'completed_with_skips',
  'failed',
  'cancelled',
  'reverted',
];

export const JOB_PAUSE_REASONS: readonly JobPauseReason[] = [
  'external',
  'ratelimit',
  'guild_unavailable',
];

export const JOB_STEP_STATUSES: readonly JobStepStatus[] = [
  'pending',
  'running',
  'done',
  'skipped',
  'failed',
  'compensated',
];

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(TERMINAL_JOB_STATES);

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Engine-driven events move a job on their own; decision events (02 §5.8)
 * answer an `awaiting_decision` prompt; `cancel` and `revert` are operator
 * actions on an active job. Terminal states accept nothing.
 */
export type JobEventType =
  | 'start'
  | 'pause'
  | 'resume'
  | 'need_decision'
  | 'decide_retry'
  | 'decide_skip'
  | 'decide_adopt'
  | 'decide_revert'
  | 'decide_abort'
  | 'revert'
  | 'finish_revert'
  | 'complete'
  | 'complete_with_skips'
  | 'fail'
  | 'cancel';

export type JobEvent =
  | { type: 'start' }
  | { type: 'pause'; reason: JobPauseReason }
  | { type: 'resume' }
  | { type: 'need_decision' }
  | { type: 'decide_retry' }
  | { type: 'decide_skip'; stepSeq?: number }
  | { type: 'decide_adopt' }
  | { type: 'decide_revert' }
  | { type: 'decide_abort' }
  | { type: 'revert' }
  | { type: 'finish_revert' }
  | { type: 'complete' }
  | { type: 'complete_with_skips'; skippedCount?: number }
  | { type: 'fail' }
  | { type: 'cancel' };

export const JOB_EVENT_TYPES: readonly JobEventType[] = [
  'start',
  'pause',
  'resume',
  'need_decision',
  'decide_retry',
  'decide_skip',
  'decide_adopt',
  'decide_revert',
  'decide_abort',
  'revert',
  'finish_revert',
  'complete',
  'complete_with_skips',
  'fail',
  'cancel',
];

/** Free-text cause or note; appended to the journal message and row data. */
export interface TransitionContext {
  detail?: string;
}

/** The job fields the machine reasons over. */
export interface JobSnapshot {
  state: JobState;
  pauseReason: JobPauseReason | null;
}

/** One `job_events` row to append. id, job_id and at come from the database. */
export interface JobEventDraft {
  level: JobEventLevel;
  code: string;
  message: string;
  data: Record<string, unknown>;
}

/** What a transition prescribes for the job, plus its journal row. */
export interface TransitionResult {
  state: JobState;
  pauseReason: JobPauseReason | null;
  /** True when the target state is terminal: the engine sets finished_at. */
  finished: boolean;
  /** Rows to write; exactly one per transition (02 §5.3). */
  events: JobEventDraft[];
}

/** Thrown for every illegal move: no row is produced and nothing changes. */
export class InvalidTransition extends Error {
  readonly from: JobState;
  readonly event: JobEventType;

  constructor(from: JobState, event: JobEventType, message: string) {
    super(message);
    this.name = 'InvalidTransition';
    this.from = from;
    this.event = event;
  }
}

type EventTargets = Partial<Record<JobEventType, JobState>>;

/**
 * The transition table. `reverting` is reachable only from
 * `running|paused|awaiting_decision` (an operator decides to undo mid-run,
 * or answers a decision with revert, 02 §5.8) and `reverted` only from
 * `reverting` finishing its compensations (02 §5.9). Edges the plan does not
 * spell out follow from its rules: `cancel` stops an active job between
 * steps and leaves objects in place, like the §5.8 abort; `need_decision`
 * from `paused` is the external-probe escalation (§5.7) and from `reverting`
 * a compensation hitting a §4.13 error, with `decide_revert` as the way
 * back; `fail` is transient retries exhausted (§5.7). Terminal states have
 * no edges: undoing a finished job means enqueuing a new one (A13).
 */
const TRANSITIONS: Record<JobState, EventTargets> = {
  queued: { start: 'running', cancel: 'cancelled' },
  running: {
    pause: 'paused',
    need_decision: 'awaiting_decision',
    complete: 'completed',
    complete_with_skips: 'completed_with_skips',
    fail: 'failed',
    revert: 'reverting',
    cancel: 'cancelled',
  },
  paused: {
    resume: 'running',
    need_decision: 'awaiting_decision',
    revert: 'reverting',
    cancel: 'cancelled',
  },
  awaiting_decision: {
    decide_retry: 'running',
    decide_skip: 'running',
    decide_adopt: 'running',
    decide_revert: 'reverting',
    decide_abort: 'cancelled',
  },
  reverting: { finish_revert: 'reverted', need_decision: 'awaiting_decision' },
  completed: {},
  completed_with_skips: {},
  failed: {},
  cancelled: {},
  reverted: {},
};

/**
 * Whether an event is legal from a state. True is necessary, not always
 * sufficient: `pause` additionally requires a reason from 02 §5.3, which
 * `transition` enforces.
 */
export function canTransition(state: JobState, event: JobEventType): boolean {
  return TRANSITIONS[state]?.[event] !== undefined;
}

/**
 * Applies one move to a job. Returns the next job fields to persist and the
 * journal row to append, or throws `InvalidTransition` and changes nothing.
 */
export function transition(
  job: JobSnapshot,
  event: JobEvent,
  ctx: TransitionContext,
): TransitionResult {
  const to = TRANSITIONS[job.state]?.[event.type];
  if (to === undefined) {
    throw new InvalidTransition(
      job.state,
      event.type,
      `invalid transition: cannot ${event.type} from state '${job.state}'`,
    );
  }
  if (event.type === 'pause' && !JOB_PAUSE_REASONS.includes(event.reason)) {
    throw new InvalidTransition(job.state, 'pause', `invalid pause reason '${event.reason}'`);
  }

  const detail = ctx.detail === undefined ? '' : `: ${ctx.detail}`;

  return {
    state: to,
    pauseReason: event.type === 'pause' ? event.reason : null,
    finished: isTerminalJobState(to),
    events: [journalRow(job, event, to, detail)],
  };
}

/** Builds the single journal row a transition emits (codes are stable). */
function journalRow(
  job: JobSnapshot,
  event: JobEvent,
  to: JobState,
  detail: string,
): JobEventDraft {
  const row = (
    level: JobEventLevel,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): JobEventDraft => ({
    level,
    code,
    message,
    data: { from: job.state, to, ...(extra ?? {}) },
  });

  switch (event.type) {
    case 'start':
      return row('info', 'job.started', `Job started${detail}`);
    case 'pause':
      return row('warn', 'job.paused', `Job paused (${event.reason})${detail}`, {
        reason: event.reason,
      });
    case 'resume':
      return row('info', 'job.resumed', `Job resumed${detail}`, {
        pauseReason: job.pauseReason,
      });
    case 'need_decision':
      return row('warn', 'job.awaiting_decision', `Job awaiting decision${detail}`);
    case 'decide_retry':
      return row('info', 'job.decision.retry', `Decision: retry the step${detail}`);
    case 'decide_skip':
      return row('warn', 'job.decision.skip', `Decision: skip the step${detail}`, {
        ...(event.stepSeq === undefined ? {} : { stepSeq: event.stepSeq }),
      });
    case 'decide_adopt':
      return row(
        'info',
        'job.decision.adopt',
        `Decision: adopt the object found by reconciliation${detail}`,
      );
    case 'decide_revert':
      return row('warn', 'job.decision.revert', `Decision: revert the job${detail}`);
    case 'decide_abort':
      return row('warn', 'job.decision.abort', `Decision: abort the job${detail}`);
    case 'revert':
      return row('warn', 'job.reverting', `Job revert started${detail}`);
    case 'finish_revert':
      return row('info', 'job.reverted', `Job reverted${detail}`);
    case 'complete':
      return row('info', 'job.completed', `Job completed${detail}`);
    case 'complete_with_skips':
      return row(
        'warn',
        'job.completed_with_skips',
        event.skippedCount === undefined
          ? `Job completed with skips${detail}`
          : `Job completed with skips (${event.skippedCount})${detail}`,
        {
          ...(event.skippedCount === undefined ? {} : { skippedCount: event.skippedCount }),
        },
      );
    case 'fail':
      return row('error', 'job.failed', `Job failed${detail}`);
    case 'cancel':
      return row('info', 'job.cancelled', `Job cancelled${detail}`);
  }
  // Exhaustive: a new JobEventType without a journal row is a compile error.
  return event satisfies never;
}

/**
 * The journal row for the initial move into `queued`. Kept identical to the
 * row `packages/db` `createJob` writes (code `job.queued`, data
 * `{ type, lane }`), so the engine has one event vocabulary from enqueue to
 * completion and the db layer can adopt this helper without a format change.
 */
export function enqueueEvent(type: string, lane: string, stepCount: number): JobEventDraft {
  return {
    level: 'info',
    code: 'job.queued',
    message: `Job queued (${stepCount} steps)`,
    data: { type, lane },
  };
}
