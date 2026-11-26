/**
 * Retry, backoff and pause-probe policy (plan 02 §5.7), as pure functions.
 *
 * Time flows through an injected clock (epoch milliseconds) and jitter
 * through an injected random source, so tests — and the worker loop, later
 * — never sleep or wait on wall time. `nextRetryAt` produces the transient
 * backoff schedule, `rateLimitRetryAt` converts a 429 `retry_after` into
 * the pause's wake-up time and `evaluateExternalPause` is the probe
 * evaluator for `paused(external)`. The engine applies these to Postgres;
 * this module never touches a database.
 */

/** Transient backoff starts at 2 seconds (02 §5.7). */
export const TRANSIENT_BASE_MS = 2_000;
/** Backoff doubles per attempt (02 §5.7). */
export const TRANSIENT_FACTOR = 2;
/** Backoff jitters ±20 % of the computed delay (02 §5.7). */
export const TRANSIENT_JITTER_FRACTION = 0.2;
/** No single backoff exceeds 5 minutes (02 §5.7). */
export const TRANSIENT_CAP_MS = 5 * 60_000;
/** A step gets at most 6 transient attempts (02 §5.7). */
export const TRANSIENT_MAX_ATTEMPTS = 6;
/** `paused(external)` probes every 30 seconds (02 §5.7). */
export const EXTERNAL_PROBE_INTERVAL_MS = 30_000;
/** A failing external pause escalates to awaiting_decision after 24 hours (02 §5.7). */
export const EXTERNAL_PAUSE_ESCALATION_MS = 24 * 60 * 60_000;
/**
 * A `paused(guild_unavailable)` job retries on this cadence (02 §5.3): the
 * claim scan re-runs the failed step once the bot is back in the guild, so
 * the pause is a retry schedule with an operator escape hatch, not a probe.
 */
export const GUILD_UNAVAILABLE_RETRY_MS = 30_000;

/** Injected clock: epoch milliseconds. */
export type Clock = () => number;

/** Injected uniform random source on [0, 1). */
export type Random01 = () => number;

/**
 * The delay before transient attempt `attemptsMade + 1`: base times
 * factor^attemptsMade, jitters ±20 % and caps at 5 minutes. `attemptsMade`
 * counts the transient attempts already made, so the first failure backs
 * off 2 seconds.
 */
export function transientBackoffMs(attemptsMade: number, random: Random01): number {
  const raw = TRANSIENT_BASE_MS * TRANSIENT_FACTOR ** (attemptsMade - 1);
  const jitter = 1 - TRANSIENT_JITTER_FRACTION + 2 * TRANSIENT_JITTER_FRACTION * random();
  return Math.min(raw * jitter, TRANSIENT_CAP_MS);
}

/** The next transient retry time for a step that already failed `attemptsMade` times. */
export function nextRetryAt(attemptsMade: number, clock: Clock, random: Random01): Date {
  return new Date(clock() + transientBackoffMs(attemptsMade, random));
}

/** Whether the transient attempt budget is spent and the job must fail (02 §5.7). */
export function isTransientExhausted(attemptsMade: number): boolean {
  return attemptsMade >= TRANSIENT_MAX_ATTEMPTS;
}

/** The wake-up time of a rate-limited pause; attempts are not consumed (02 §5.7). */
export function rateLimitRetryAt(retryAfterSeconds: number, clock: Clock): Date {
  return new Date(clock() + retryAfterSeconds * 1_000);
}

/** When the next `paused(external)` probe is due (02 §5.7). */
export function nextProbeAt(clock: Clock): Date {
  return new Date(clock() + EXTERNAL_PROBE_INTERVAL_MS);
}

/** When a `paused(guild_unavailable)` job next retries (02 §5.3). */
export function guildUnavailableRetryAt(clock: Clock): Date {
  return new Date(clock() + GUILD_UNAVAILABLE_RETRY_MS);
}

/** The state a `paused(external)` probe decision is made over. */
export interface ExternalPauseSnapshot {
  /** Probe time, epoch milliseconds. */
  now: number;
  /** When the job paused, epoch milliseconds. */
  pausedSince: number;
  /** Whether the cheap read succeeded. */
  probeSucceeded: boolean;
}

/**
 * What a `paused(external)` probe concludes (02 §5.7): a successful cheap
 * read resumes the job — even past the 24-hour mark, because the dependency
 * is back; a failing one postpones the next probe 30 seconds, until the
 * pause is 24 hours old and the job escalates to `awaiting_decision`.
 */
export type ExternalPauseAction =
  | { action: 'resume' }
  | { action: 'postpone' }
  | { action: 'escalate' };

export function evaluateExternalPause(snapshot: ExternalPauseSnapshot): ExternalPauseAction {
  if (snapshot.probeSucceeded) return { action: 'resume' };
  if (snapshot.now - snapshot.pausedSince >= EXTERNAL_PAUSE_ESCALATION_MS) {
    return { action: 'escalate' };
  }
  return { action: 'postpone' };
}
