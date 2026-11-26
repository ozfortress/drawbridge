/**
 * The Discord error taxonomy (plan 02 §4.13).
 *
 * `classifyError` is pure: the Discord adapter (a later todo) maps every
 * REST failure to an {@link ApiErrorSignal}, and the engine asks this table
 * what to do with it. The code column is verified against the plan by a
 * unit test, so a wrong or missing code is a build failure rather than a
 * runtime surprise. Signals that match nothing in the table are permanent
 * by default — an unrecognised 4xx or an empty signal parks the job for an
 * operator (`invalid_input`), because silently retrying an unclassified
 * request is exactly the behaviour the taxonomy exists to prevent.
 */

/** How the engine must treat a Discord failure (plan 02 §4.13). */
export type JobErrorClass =
  | 'rate_limited'
  | 'transient'
  | 'fatal_config'
  | 'missing_permission'
  | 'object_missing'
  | 'capacity'
  | 'invalid_input';

export const JOB_ERROR_CLASSES: readonly JobErrorClass[] = [
  'rate_limited',
  'transient',
  'fatal_config',
  'missing_permission',
  'object_missing',
  'capacity',
  'invalid_input',
];

/**
 * The Discord json error codes the taxonomy names (02 §4.13), keyed by the
 * numeric `code` field of every Discord API error body. 429 is a status, so
 * it has no code row; 401 and 403 are classified by status (the codes they
 * carry, like 0 or 50001, are not in this table).
 */
export const ERROR_CODE_CLASSES: Readonly<Record<number, JobErrorClass>> = {
  50001: 'missing_permission',
  50013: 'missing_permission',
  10003: 'object_missing',
  10004: 'object_missing',
  10011: 'object_missing',
  30003: 'capacity',
  30005: 'capacity',
  30013: 'capacity',
  50035: 'invalid_input',
};

/**
 * What a Discord failure looks like to the engine. The adapter fills in
 * the fields it has: the HTTP `status`, the Discord `code` from the error
 * body, a `network` flag for transport-level failures (reset, timeout,
 * DNS) and the 429 body's `retry_after` seconds.
 */
export interface ApiErrorSignal {
  status?: number;
  code?: number;
  network?: boolean;
  retryAfterSeconds?: number;
  message?: string;
}

/** The error the Discord adapter throws for every REST failure. */
export class DiscordOperationError extends Error {
  override readonly name = 'DiscordOperationError';
  readonly signal: ApiErrorSignal;

  constructor(signal: ApiErrorSignal, message?: string) {
    super(message ?? signal.message ?? 'Discord operation failed');
    this.signal = signal;
  }
}

/**
 * Permanent classes park the job in `awaiting_decision` at once (02 §4.13);
 * `rate_limited` and `transient` are scheduled instead (02 §5.7).
 */
export function isPermanentErrorClass(cls: JobErrorClass): boolean {
  return cls !== 'rate_limited' && cls !== 'transient';
}

/**
 * Classifies one Discord failure signal. Discord's own error codes are
 * more specific than its statuses, so the code table wins over the status
 * line; 429 wins over everything because its handling (wait `retry_after`)
 * must never be misread. Unrecognised signals fall back to
 * `invalid_input`, the safe permanent class.
 */
export function classifyError(signal: ApiErrorSignal): JobErrorClass {
  if (signal.status === 429) return 'rate_limited';
  const byCode = signal.code === undefined ? undefined : ERROR_CODE_CLASSES[signal.code];
  if (byCode !== undefined) return byCode;
  if (signal.status === 403) return 'missing_permission';
  if (signal.status === 401) return 'fatal_config';
  if (signal.status === 400) return 'invalid_input';
  if (signal.status !== undefined && signal.status >= 500) return 'transient';
  if (signal.network === true) return 'transient';
  return 'invalid_input';
}

/**
 * The signal's fields as journal/`error`-column data, with undefined fields
 * omitted rather than stored as null.
 */
export function signalData(signal: ApiErrorSignal): Record<string, unknown> {
  return {
    ...(signal.status !== undefined ? { status: signal.status } : {}),
    ...(signal.code !== undefined ? { code: signal.code } : {}),
    ...(signal.network !== undefined ? { network: signal.network } : {}),
    ...(signal.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: signal.retryAfterSeconds }
      : {}),
    ...(signal.message !== undefined ? { message: signal.message } : {}),
  };
}
