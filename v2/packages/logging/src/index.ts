/**
 * Structured JSON logging.
 *
 * Three layers of protection keep secrets out of logs:
 *  1. Values wrapped in `Secret` (from @drawbridge/config) render as `[secret]`.
 *  2. Keys whose normalised name contains a sensitive word render `[redacted]`.
 *  3. Any value registered in the current secret scope is scrubbed from the
 *     finished line. This catches secrets that appear inside free text, such as
 *     an error message or a stack trace.
 *
 * Scopes keep layer 3 bounded: values registered while a line is prepared are
 * forgotten immediately after that line is written.
 */
import { currentSecretValues, isSecret, withSecretScope } from '@drawbridge/config';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

const REDACTED = '[redacted]';
const SECRET = '[secret]';
const MAX_DEPTH = 6;

const SENSITIVE_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'signature',
  'webhookurl',
  'dsn',
  'connectionstring',
] as const;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_WORDS.some((word) => normalised.includes(word));
}

function scrubRegisteredValues(text: string): string {
  let out = text;
  for (const value of currentSecretValues()) {
    if (value.length >= 4 && out.includes(value)) {
      out = out.split(value).join(REDACTED);
    }
  }
  return out;
}

function serialiseError(error: Error, depth: number, seen: Set<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) out['stack'] = error.stack;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) out['cause'] = redactValue(cause, depth + 1, seen);
  return out;
}

function redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (isSecret(value)) return SECRET;
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serialiseError(value, depth, seen);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

export type Bindings = Record<string, unknown>;
export type Sink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Bindings;
  sink?: Sink;
  /** Fixed clock, for tests. */
  now?: () => Date;
}

type LevelFn = (message: string, fields?: Bindings) => void;

export interface Logger {
  readonly level: LogLevel;
  trace: LevelFn;
  debug: LevelFn;
  info: LevelFn;
  warn: LevelFn;
  error: LevelFn;
  fatal: LevelFn;
  child(bindings: Bindings): Logger;
}

const stdoutSink: Sink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const threshold = LEVELS[level];

  const emit = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Bindings) => {
    if (LEVELS[entryLevel] < threshold) return;
    withSecretScope(() => {
      const entry: Record<string, unknown> = {
        time: now().toISOString(),
        level: entryLevel,
        message,
      };
      Object.assign(entry, redactValue(bindings, 0, new Set()) as Record<string, unknown>);
      if (fields) {
        Object.assign(entry, redactValue(fields, 0, new Set()) as Record<string, unknown>);
      }
      sink(scrubRegisteredValues(JSON.stringify(entry)));
    });
  };

  return {
    level,
    trace: (message, fields) => emit('trace', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    fatal: (message, fields) => emit('fatal', message, fields),
    // A fresh object per child, so a child can never mutate its parent.
    child: (extra) =>
      createLogger({
        level,
        bindings: { ...bindings, ...extra },
        sink,
        now,
      }),
  };
}

/** Exposed for tests and for redacting arbitrary payloads. */
export function redact(input: unknown): unknown {
  return redactValue(input, 0, new Set());
}
