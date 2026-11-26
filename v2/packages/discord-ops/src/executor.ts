/**
 * The Discord write executor (plan 02 §4.3-4.5, §4.8, §4.13, §4.16).
 *
 * Every Discord write a job plans goes through here before it reaches the
 * port (02 §4.3: the worker's REST writes have one owner). The executor is
 * a queue, not a client: it takes one catalogue op plus the job/step it
 * belongs to, gates it behind three budgets, and hands back the op's
 * outcome or a taxonomy failure.
 *
 * Budgets (02 §4.4): at most `perGuildConcurrency` (start: 2) writes in
 * flight per guild; a global dispatch rate of `globalWritesPerSecond`
 * (start: 10) enforced twice over — no two dispatches closer together than
 * one rate interval, and never more than one rate's worth of dispatches in
 * any rolling second — which halves for `rateHalvingMs` (start: 60 s) after
 * any 429 and then restores. The starting values are provisional; they are
 * options, not constants, so the test guild can tune them without a code
 * change. Discord's own limits are never hardcoded here: the port surfaces
 * them reactively as 429 signals — `retry_after`, the bucket hash, the
 * scope — which the executor answers with the halving, the per-bucket
 * tally and the metrics hooks, while discord.js's REST queues do the
 * per-bucket pacing (02 §4.4's first rule).
 *
 * Lanes (02 §4.4) decide which queued write dispatches first, in the exact
 * order the job engine fixes: `interactive`, `matches`, `setup`, `repair`,
 * `maintenance`. The order comes from the engine's own `JOB_LANES`, so the
 * executor cannot drift from it.
 *
 * Failures (02 §4.13, §5.7) are reported, not retried: a 429 comes back as
 * a `rate_limited` failure carrying `retry_after` — the engine's
 * `paused(ratelimit)` path consumes no attempt — and everything else maps
 * through the taxonomy exactly as the engine's failure path does. A 401
 * stops the executor at once: one alert is raised, every queued write is
 * refused, and later writes fail fast without a port call (02 §4.5). The
 * invalid-request budget counts 401, 403 and 429 responses — except the
 * shared-scope 429, which is the per-IP bucket every bot on the host
 * shares — and alerts once at 1000 inside a rolling 10 minutes.
 *
 * Preflight (02 §4.5, §4.8, §4.11) runs before a write is queued: the §4.2
 * permission names the op needs, the role hierarchy for ops that touch a
 * role, and the guild capacity margins for creates. Permission names come
 * from an injected provider — the port has no way to express the bot's own
 * permission bits, a gap the adapter fills — while hierarchy and capacity
 * read the guild through the port itself. A refusal never reaches Discord:
 * it is reported as the taxonomy class it would have produced (50013 for
 * permissions and hierarchy, 30005/30013 for capacity), so the job parks
 * in `awaiting_decision` without spending an invalid request.
 *
 * Time is injected: the clock and the wait are options, so tests drive the
 * queues with a fake clock and never touch a timer. The only real timer
 * the executor ever uses is the default wait, a plain `setTimeout` the
 * worker can replace. Every create and delete carries the audit reason tag
 * `drb:{jobId}:{seq}` (02 §4.16); message sends and pins are not auditable
 * creates, so the port takes no reason for them.
 */
import {
  MAX_CATEGORIES,
  MAX_CHANNELS,
  MAX_CHANNELS_PER_CATEGORY,
  MAX_ROLES,
} from '@drawbridge/domain';
import {
  type ApiErrorSignal,
  type Clock,
  classifyError,
  DiscordOperationError,
  JOB_LANES,
  type JobErrorClass,
} from '@drawbridge/jobs';
import { type DiscordOp, type DiscordOpKind, type DiscordOpOutcome, opReason } from './ops.js';
import type { DiscordPort } from './port.js';

/**
 * The write lanes, in 02 §4.4's fixed priority order. The order is the job
 * engine's own, so the executor and the claim scan can never disagree about
 * which lane wins.
 */
export type DiscordLane = (typeof JOB_LANES)[number];

/** Per-guild writes in flight at once; provisional (02 §4.4 says start at 2). */
export const DEFAULT_PER_GUILD_CONCURRENCY = 2;

/** Global write dispatches per second; provisional (02 §4.4 says start at 10). */
export const DEFAULT_GLOBAL_WRITES_PER_SECOND = 10;

/** How long the halved rate holds after any 429 (02 §4.4: 60 seconds). */
export const DEFAULT_RATE_HALVING_MS = 60_000;

/** Alert at this many invalid requests inside the window (02 §4.5: 1000). */
export const DEFAULT_INVALID_ALERT_THRESHOLD = 1_000;

/** The invalid-request window Discord itself uses (02 §4.5: 10 minutes). */
export const DEFAULT_INVALID_WINDOW_MS = 10 * 60_000;

/** The executor's provisional budgets; every value can be tuned per deployment. */
export interface DiscordExecutorLimits {
  /** Writes in flight per guild at once (start: 2). */
  perGuildConcurrency: number;
  /** Global write dispatches per second (start: 10; halves after any 429). */
  globalWritesPerSecond: number;
  /** The halved rate holds this long after a 429, then restores (start: 60 s). */
  rateHalvingMs: number;
  /** Alert once when this many invalid requests land inside the window. */
  invalidRequestAlertThreshold: number;
  /** How far back the invalid-request window reaches. */
  invalidRequestWindowMs: number;
}

export const DEFAULT_EXECUTOR_LIMITS: DiscordExecutorLimits = {
  perGuildConcurrency: DEFAULT_PER_GUILD_CONCURRENCY,
  globalWritesPerSecond: DEFAULT_GLOBAL_WRITES_PER_SECOND,
  rateHalvingMs: DEFAULT_RATE_HALVING_MS,
  invalidRequestAlertThreshold: DEFAULT_INVALID_ALERT_THRESHOLD,
  invalidRequestWindowMs: DEFAULT_INVALID_WINDOW_MS,
};

/**
 * The §4.2 permission names, as granted to the bot. The adapter maps them to
 * bits with `discord-api-types` at build time; the executor only ever
 * compares names.
 */
export type BotPermissionName =
  | 'ViewChannel'
  | 'ManageChannels'
  | 'ManageRoles'
  | 'SendMessages'
  | 'EmbedLinks'
  | 'AttachFiles'
  | 'ReadMessageHistory'
  | 'ManageMessages'
  | 'ViewAuditLog'
  | 'UseApplicationCommands';

/**
 * What each op kind needs, by §4.2 name. Channel-scoped writes also need
 * ViewChannel (02 §4.11: the bot must view everything it manages); a send
 * with embeds additionally needs EmbedLinks.
 */
const OP_PERMISSIONS: Readonly<Record<DiscordOpKind, readonly BotPermissionName[]>> = {
  create_role: ['ManageRoles'],
  delete_role: ['ManageRoles'],
  create_category: ['ManageChannels'],
  create_text_channel: ['ManageChannels'],
  delete_channel: ['ManageChannels', 'ViewChannel'],
  delete_category: ['ManageChannels', 'ViewChannel'],
  edit_overwrites: ['ManageRoles', 'ViewChannel'],
  send_message: ['SendMessages', 'ViewChannel'],
  pin_message: ['ManageMessages', 'ViewChannel'],
  add_role_to_member: ['ManageRoles'],
  remove_role_from_member: ['ManageRoles'],
  move_channel: ['ManageChannels', 'ViewChannel'],
  rename_channel: ['ManageChannels', 'ViewChannel'],
};

/**
 * The §4.2 permissions one op needs, by name. Exported so the worker's
 * wiring (and the panel's diagnostics) can show what a refused step wanted.
 */
export function requiredWritePermissions(op: DiscordOp): readonly BotPermissionName[] {
  const base = OP_PERMISSIONS[op.kind];
  if (op.kind === 'send_message' && (op.embeds?.length ?? 0) > 0) {
    return [...base, 'EmbedLinks'];
  }
  return base;
}

/**
 * The preflight half the port cannot express: the bot's own member id (for
 * the role-hierarchy read) and its effective guild permissions by §4.2
 * name. Supplied by the worker's adapter; without it no preflight runs.
 */
export interface DiscordPreflight {
  /** The bot's own member snowflake in each guild it serves. */
  botMemberId: string;
  /** The bot's effective guild permissions, by §4.2 name. */
  permissions(guildId: string): Promise<readonly BotPermissionName[]>;
}

/** One 429 the executor reacted to, as the metrics hook receives it. */
export interface RateLimitHit {
  /** The `X-RateLimit-Bucket` hash, or `unknown` when the 429 carried none. */
  bucket: string;
  /** The `X-RateLimit-Scope`: `shared` is the per-IP bucket (02 §4.5). */
  scope: 'user' | 'shared' | 'global' | null;
  /** The seconds the bucket asked to wait (02 §5.7). */
  retryAfterSeconds: number;
  lane: DiscordLane;
  guildId: string;
}

/** One settled write, as the duration hook receives it. */
export interface StepDuration {
  lane: DiscordLane;
  kind: DiscordOpKind;
  guildId: string;
  /** Submit to settle, queue wait included. */
  durationMs: number;
  outcome: 'done' | 'failed' | 'refused';
}

/** Metrics hooks (02 §4.4): 429s by bucket and one duration per write. */
export interface DiscordExecutorMetrics {
  /** Fires once per 429 the executor reacted to (halving, tally, failure). */
  onRateLimit?(hit: RateLimitHit): void;
  /** Fires once per settled write, whatever settled it. */
  onStepDuration?(duration: StepDuration): void;
}

/** The two alerts the executor itself raises (02 §4.5). */
export type DiscordExecutorAlert =
  | {
      kind: 'discord.fatal_config';
      guildId: string;
      jobId: string;
      message: string;
    }
  | {
      kind: 'discord.invalid_request_budget';
      /** The invalid requests counted inside the 10-minute window. */
      count: number;
      message: string;
    };

/** The executor's logger, structural so `@drawbridge/logging` satisfies it. */
export interface DiscordExecutorLogger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** What one write's engine must do with the failure (02 §5.7). */
export type DiscordWriteAction = 'pause_ratelimit' | 'retry' | 'awaiting_decision';

/**
 * Why a write did not happen, in the taxonomy's own words: `class` is the
 * §4.13 classification, `action` the §5.7 consequence — a rate limit
 * pauses without consuming an attempt, a transient failure retries, every
 * permanent class parks the job for a decision.
 */
export type DiscordWriteFailure =
  | {
      class: 'rate_limited';
      action: 'pause_ratelimit';
      signal: ApiErrorSignal;
      /** The seconds to wait; Discord always sends one with a 429 (02 §5.7). */
      retryAfterSeconds: number;
    }
  | { class: 'transient'; action: 'retry'; signal: ApiErrorSignal }
  | {
      class: Exclude<JobErrorClass, 'rate_limited' | 'transient'>;
      action: 'awaiting_decision';
      signal: ApiErrorSignal;
    };

/**
 * One write the executor is asked to perform: the catalogue op itself,
 * plus the job identity that becomes the audit reason tag (02 §4.16).
 * Generic over the op so a concrete call narrows its own result.
 */
export interface DiscordWriteRequest<Op extends DiscordOp = DiscordOp> {
  /** The catalogue op to run (its guild decides the concurrency budget). */
  op: Op;
  /** The lane the op's job runs in (02 §4.4). */
  lane: DiscordLane;
  /** The owning job: half of the audit reason tag (02 §4.16). */
  jobId: string;
  /** The op's step sequence: the other half of the tag. */
  seq: number;
}

/** What a write produced: the op's outcome, or the taxonomy failure. */
export type DiscordWriteResult<Op extends DiscordOp = DiscordOp> =
  | { status: 'done'; outcome: Extract<DiscordOpOutcome, { kind: Op['kind'] }> }
  | { status: 'failed'; failure: DiscordWriteFailure };

/** Everything the executor needs; every dependency is injected. */
export interface DiscordExecutorOptions {
  /** The plain-data port every write and preflight read goes through. */
  port: DiscordPort;
  /** Epoch milliseconds; must be non-decreasing. */
  clock: Clock;
  /**
   * Waits `ms` on the injected clock. Production uses
   * {@link defaultExecutorSleep}; tests inject a fake so no timer runs.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Preflight data; without it no preflight runs. The worker always wires one. */
  preflight?: DiscordPreflight;
  /** Budget overrides; every value defaults to 02 §4.4-4.5's starting point. */
  limits?: Partial<DiscordExecutorLimits>;
  metrics?: DiscordExecutorMetrics;
  /**
   * Raised exactly once when a 401 stops all writes, and once per
   * invalid-budget breach (02 §4.5).
   */
  alert?: (alert: DiscordExecutorAlert) => void | Promise<void>;
  logger?: DiscordExecutorLogger;
}

/** The executor's surface: `createDiscordExecutor` builds one. */
export interface DiscordExecutor {
  /** Runs one op through preflight, the lanes and the budgets. */
  executeWrite<Op extends DiscordOp>(
    request: DiscordWriteRequest<Op>,
  ): Promise<DiscordWriteResult<Op>>;
  /** The 429s reacted to, counted per rate-limit bucket (02 §4.4). */
  rateLimitHits(): ReadonlyMap<string, number>;
  /** Invalid responses inside the rolling 10-minute window (02 §4.5). */
  invalidRequestCount(): number;
  /** Whether a 401 stopped all writes (they are refused until restart). */
  isStopped(): boolean;
}

/** The production wait: a plain unref'd timer the worker may replace. */
export function defaultExecutorSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The bucket key used when a 429 carried no bucket hash. */
const UNKNOWN_BUCKET = 'unknown';

/** The fallback wait when a 429 body could not be parsed; the engine's failure path uses the same default. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface QueueEntry {
  request: DiscordWriteRequest;
  deferred: Deferred<DiscordWriteResult>;
  submittedAt: number;
}

/** The failure the taxonomy prescribes for one signal (02 §4.13, §5.7). */
function failureFor(signal: ApiErrorSignal): DiscordWriteFailure {
  const cls = classifyError(signal);
  if (cls === 'rate_limited') {
    return {
      class: 'rate_limited',
      action: 'pause_ratelimit',
      signal,
      retryAfterSeconds: signal.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
    };
  }
  if (cls === 'transient') {
    return { class: 'transient', action: 'retry', signal };
  }
  return { class: cls, action: 'awaiting_decision', signal };
}

/**
 * A preflight refusal, shaped as the Discord code it is standing in for:
 * 50013 for permissions and hierarchy, 30005/30013 for capacity. The
 * taxonomy maps it exactly as it would map Discord's own answer.
 */
function refusedFailure(code: number, message: string): DiscordWriteFailure {
  return failureFor({ code, message });
}

/** Any error as a signal: port failures keep theirs, anything else maps through the taxonomy default (02 §4.13). */
function signalOf(err: unknown): ApiErrorSignal {
  if (err instanceof DiscordOperationError) return err.signal;
  return { message: err instanceof Error ? err.message : String(err) };
}

/**
 * Runs one op through the port method its catalogue entry names, carrying
 * the audit reason tag on every create and delete (02 §4.16). The port's
 * own signatures keep sends and pins reason-free.
 */
async function runOp(port: DiscordPort, op: DiscordOp, reason: string): Promise<DiscordOpOutcome> {
  switch (op.kind) {
    case 'create_role': {
      const created = await port.createRole(
        op.guildId,
        {
          name: op.name,
          ...(op.color !== undefined ? { color: op.color } : {}),
          ...(op.hoist !== undefined ? { hoist: op.hoist } : {}),
          ...(op.mentionable !== undefined ? { mentionable: op.mentionable } : {}),
        },
        reason,
      );
      return { ...op, result: { kind: 'create_role', roleId: created.roleId, name: created.name } };
    }
    case 'delete_role': {
      await port.deleteRole(op.guildId, op.roleId, reason);
      return { ...op, result: { kind: 'delete_role' } };
    }
    case 'create_category': {
      const created = await port.createCategory(
        op.guildId,
        {
          name: op.name,
          ...(op.overwrites !== undefined ? { overwrites: op.overwrites } : {}),
        },
        reason,
      );
      return {
        ...op,
        result: { kind: 'create_category', categoryId: created.categoryId, name: created.name },
      };
    }
    case 'delete_category': {
      await port.deleteCategory(op.guildId, op.categoryId, reason);
      return { ...op, result: { kind: 'delete_category' } };
    }
    case 'create_text_channel': {
      const created = await port.createTextChannel(
        op.guildId,
        {
          name: op.name,
          ...(op.categoryId !== undefined ? { categoryId: op.categoryId } : {}),
          ...(op.topic !== undefined ? { topic: op.topic } : {}),
          ...(op.overwrites !== undefined ? { overwrites: op.overwrites } : {}),
        },
        reason,
      );
      return {
        ...op,
        result: { kind: 'create_text_channel', channelId: created.channelId, name: created.name },
      };
    }
    case 'delete_channel': {
      await port.deleteChannel(op.guildId, op.channelId, reason);
      return { ...op, result: { kind: 'delete_channel' } };
    }
    case 'edit_overwrites': {
      await port.editOverwrites(op.guildId, op.channelId, op.overwrites, reason);
      return { ...op, result: { kind: 'edit_overwrites' } };
    }
    case 'send_message': {
      const sent = await port.sendMessage(op.guildId, op.channelId, {
        ...(op.content !== undefined ? { content: op.content } : {}),
        ...(op.embeds !== undefined ? { embeds: op.embeds } : {}),
        ...(op.allowedMentions !== undefined ? { allowedMentions: op.allowedMentions } : {}),
      });
      return { ...op, result: { kind: 'send_message', messageId: sent.messageId } };
    }
    case 'pin_message': {
      await port.pinMessage(op.guildId, op.channelId, op.messageId);
      return { ...op, result: { kind: 'pin_message' } };
    }
    case 'add_role_to_member': {
      await port.addRoleToMember(op.guildId, op.memberId, op.roleId, reason);
      return { ...op, result: { kind: 'add_role_to_member' } };
    }
    case 'remove_role_from_member': {
      await port.removeRoleFromMember(op.guildId, op.memberId, op.roleId, reason);
      return { ...op, result: { kind: 'remove_role_from_member' } };
    }
    case 'move_channel': {
      await port.moveChannel(
        op.guildId,
        op.channelId,
        {
          categoryId: op.categoryId,
          ...(op.position !== undefined ? { position: op.position } : {}),
        },
        reason,
      );
      return { ...op, result: { kind: 'move_channel' } };
    }
    case 'rename_channel': {
      await port.renameChannel(op.guildId, op.channelId, op.name, reason);
      return { ...op, result: { kind: 'rename_channel' } };
    }
  }
  return op satisfies never;
}

/**
 * Builds one executor. The instance holds the budgets' state (queues,
 * tallies, the fatal stop), so one worker shares one executor across all
 * its guilds; in `RUN_MODE=all` the whole process shares it (02 §4.3).
 */
export function createDiscordExecutor(options: DiscordExecutorOptions): DiscordExecutor {
  return new ExecutorCore(options);
}

class ExecutorCore implements DiscordExecutor {
  private readonly port: DiscordPort;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly preflight: DiscordPreflight | undefined;
  private readonly limits: DiscordExecutorLimits;
  private readonly metrics: DiscordExecutorMetrics | undefined;
  private readonly alertHook: ((alert: DiscordExecutorAlert) => void | Promise<void>) | undefined;
  private readonly logger: DiscordExecutorLogger | undefined;

  private readonly queue: QueueEntry[] = [];
  private readonly inFlight = new Map<string, number>();
  /** Dispatch times, ascending, capped at the base rate (the window probe). */
  private readonly recentDispatches: number[] = [];
  private lastDispatchAt: number | null = null;
  /** The moment the halved rate restores (02 §4.4). */
  private halvedUntil = 0;
  private readonly bucketHits = new Map<string, number>();
  /** Invalid-response times, ascending, pruned to the window (02 §4.5). */
  private readonly invalidAt: number[] = [];
  private invalidAlerted = false;
  /** Set by the first 401: every later write is refused until restart. */
  private fatalRefusal: DiscordWriteFailure | null = null;
  private pumping = false;

  constructor(options: DiscordExecutorOptions) {
    this.port = options.port;
    this.clock = options.clock;
    this.sleep = options.sleep ?? defaultExecutorSleep;
    this.preflight = options.preflight;
    this.metrics = options.metrics;
    this.alertHook = options.alert;
    this.logger = options.logger;
    const given = options.limits;
    this.limits = {
      perGuildConcurrency: given?.perGuildConcurrency ?? DEFAULT_PER_GUILD_CONCURRENCY,
      globalWritesPerSecond: given?.globalWritesPerSecond ?? DEFAULT_GLOBAL_WRITES_PER_SECOND,
      rateHalvingMs: given?.rateHalvingMs ?? DEFAULT_RATE_HALVING_MS,
      invalidRequestAlertThreshold:
        given?.invalidRequestAlertThreshold ?? DEFAULT_INVALID_ALERT_THRESHOLD,
      invalidRequestWindowMs: given?.invalidRequestWindowMs ?? DEFAULT_INVALID_WINDOW_MS,
    };
  }

  // The generic narrows the outcome per op; the queue below is
  // kind-agnostic over the same union, and a settle builds its outcome
  // from the very op it was given, so the refinement holds.
  executeWrite<Op extends DiscordOp>(
    request: DiscordWriteRequest<Op>,
  ): Promise<DiscordWriteResult<Op>> {
    const submittedAt = this.clock();
    const deferred = createDeferred<DiscordWriteResult>();
    void this.accept(request, submittedAt, deferred);
    return deferred.promise as Promise<DiscordWriteResult<Op>>;
  }

  rateLimitHits(): ReadonlyMap<string, number> {
    return this.bucketHits;
  }

  invalidRequestCount(): number {
    this.pruneInvalid(this.clock());
    return this.invalidAt.length;
  }

  isStopped(): boolean {
    return this.fatalRefusal !== null;
  }

  /** Accepts one write: fatal gate, preflight, then the lane queue. */
  private async accept(
    request: DiscordWriteRequest,
    submittedAt: number,
    deferred: Deferred<DiscordWriteResult>,
  ): Promise<void> {
    const entry: QueueEntry = { request, deferred, submittedAt };
    if (this.fatalRefusal !== null) {
      this.settle(entry, { status: 'failed', failure: this.fatalRefusal }, 'refused');
      return;
    }
    try {
      if (this.preflight !== undefined) {
        const refusal = await this.runPreflight(this.preflight, request.op);
        if (refusal !== undefined) {
          this.settle(entry, { status: 'failed', failure: refusal }, 'refused');
          return;
        }
      }
    } catch (err) {
      // A preflight read failed on its way to Discord: the taxonomy decides.
      this.settle(entry, { status: 'failed', failure: failureFor(signalOf(err)) }, 'failed');
      return;
    }
    if (this.fatalRefusal !== null) {
      // A 401 landed while this write's preflight reads were running.
      this.settle(entry, { status: 'failed', failure: this.fatalRefusal }, 'refused');
      return;
    }
    this.queue.push(entry);
    this.pump();
  }

  /** Resolves one write and reports its duration, whatever settled it. */
  private settle(
    entry: QueueEntry,
    result: DiscordWriteResult,
    outcome: StepDuration['outcome'],
  ): void {
    entry.deferred.resolve(result);
    try {
      this.metrics?.onStepDuration?.({
        lane: entry.request.lane,
        kind: entry.request.op.kind,
        guildId: entry.request.op.guildId,
        durationMs: this.clock() - entry.submittedAt,
        outcome,
      });
    } catch (err) {
      this.logger?.warn('step duration hook failed', { error: err });
    }
  }

  /** Starts the dispatch loop unless one is already running. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpLoop();
  }

  /**
   * Dispatches until nothing is eligible. One loop instance at a time: a
   * submit or a completion that arrives mid-loop is picked up by the loop's
   * next pass, and one that arrives after the loop's atomic exit starts a
   * fresh one. The only wait is the rate gate; guild slots free up through
   * completions, which re-arm the loop themselves.
   */
  private async pumpLoop(): Promise<void> {
    try {
      for (;;) {
        const entry = this.pickNext();
        if (entry === undefined) {
          this.pumping = false;
          return;
        }
        const delay = this.nextDispatchDelay(this.clock());
        if (delay > 0) {
          await this.sleep(delay);
          // Re-pick: a higher lane may have queued, or a completion may
          // have reordered eligibility while the gate was pending.
          continue;
        }
        this.dispatch(entry);
      }
    } catch (err) {
      // The injected wait failed: a wiring bug, never a Discord answer.
      // Refuse what is queued so no write hangs, and let the next submit
      // start a fresh loop.
      this.pumping = false;
      this.logger?.error('executor dispatch loop failed', { error: err });
      const failure = failureFor(signalOf(err));
      for (const queued of [...this.queue]) {
        this.settle(queued, { status: 'failed', failure }, 'failed');
      }
      this.queue.length = 0;
    }
  }

  /**
   * The next eligible write: lanes in 02 §4.4 order, then arrival order
   * within the lane, skipping guilds already at their concurrency budget.
   */
  private pickNext(): QueueEntry | undefined {
    for (const lane of JOB_LANES) {
      for (const entry of this.queue) {
        if (entry.request.lane !== lane) continue;
        const busy = this.inFlight.get(entry.request.op.guildId) ?? 0;
        if (busy >= this.limits.perGuildConcurrency) continue;
        return entry;
      }
    }
    return undefined;
  }

  /** The effective global rate: halved until the 429 window passes (02 §4.4). */
  private effectiveWritesPerSecond(now: number): number {
    if (now < this.halvedUntil) {
      return Math.max(1, Math.floor(this.limits.globalWritesPerSecond / 2));
    }
    return this.limits.globalWritesPerSecond;
  }

  /**
   * How long the next dispatch must wait. Two gates, both computed against
   * the effective rate, and the stricter wins: no two dispatches closer
   * than one rate interval (smooth pacing after idle), and never more than
   * one rate's worth of dispatches inside any rolling second (Discord's
   * own window rule).
   */
  private nextDispatchDelay(now: number): number {
    const perSecond = this.effectiveWritesPerSecond(now);
    const spacingGate = this.lastDispatchAt === null ? 0 : this.lastDispatchAt + 1_000 / perSecond;
    const oldestInWindow = this.recentDispatches.at(-perSecond);
    const windowGate = oldestInWindow === undefined ? 0 : oldestInWindow + 1_000;
    return Math.max(0, Math.max(spacingGate, windowGate) - now);
  }

  /** Sends one queued write on its way; its completion re-arms the loop. */
  private dispatch(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    const guildId = entry.request.op.guildId;
    this.inFlight.set(guildId, (this.inFlight.get(guildId) ?? 0) + 1);
    const now = this.clock();
    this.lastDispatchAt = now;
    this.recentDispatches.push(now);
    if (this.recentDispatches.length > this.limits.globalWritesPerSecond) {
      this.recentDispatches.shift();
    }
    void this.runDispatched(entry)
      .catch((err) => {
        // The boundary catch the loop's own step execution prescribes
        // (02 §3.2.2): a crash inside the write path still settles the
        // write through the taxonomy default and never hangs the slot.
        this.logger?.error('executor write path crashed', {
          jobId: entry.request.jobId,
          error: err,
        });
        this.settle(entry, { status: 'failed', failure: failureFor(signalOf(err)) }, 'failed');
      })
      .finally(() => {
        const remaining = (this.inFlight.get(guildId) ?? 1) - 1;
        if (remaining <= 0) this.inFlight.delete(guildId);
        else this.inFlight.set(guildId, remaining);
        this.pump();
      });
  }

  /** One dispatched write: port call, failure bookkeeping, the result. */
  private async runDispatched(entry: QueueEntry): Promise<void> {
    const { request } = entry;
    let result: DiscordWriteResult;
    let outcome: StepDuration['outcome'] = 'failed';
    try {
      const portOutcome = await runOp(this.port, request.op, opReason(request.jobId, request.seq));
      result = { status: 'done', outcome: portOutcome };
      outcome = 'done';
    } catch (err) {
      const signal = signalOf(err);
      await this.recordWriteFailure(request, signal);
      result = { status: 'failed', failure: failureFor(signal) };
    }
    this.settle(entry, result, outcome);
  }

  /**
   * Everything a Discord failure must move: the 429 reaction (halving,
   * per-bucket tally, metrics), the 401 stop with its single alert, and
   * the invalid-request budget with its own alert (02 §4.4-4.5).
   */
  private async recordWriteFailure(
    request: DiscordWriteRequest,
    signal: ApiErrorSignal,
  ): Promise<void> {
    const now = this.clock();
    if (signal.status === 429) {
      // Any 429 re-arms the halving window at half the base rate; it never
      // compounds below half (02 §4.4 says halve, then restore).
      this.halvedUntil = now + this.limits.rateHalvingMs;
      const bucket = signal.bucket ?? UNKNOWN_BUCKET;
      this.bucketHits.set(bucket, (this.bucketHits.get(bucket) ?? 0) + 1);
      try {
        this.metrics?.onRateLimit?.({
          bucket,
          scope: signal.rateLimitScope ?? null,
          retryAfterSeconds: signal.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
          lane: request.lane,
          guildId: request.op.guildId,
        });
      } catch (err) {
        this.logger?.warn('rate limit hook failed', { error: err });
      }
      this.logger?.warn('Discord write rate limited', {
        bucket,
        guildId: request.op.guildId,
        jobId: request.jobId,
        seq: request.seq,
      });
    }
    if (signal.status === 401 && this.fatalRefusal === null) {
      await this.stopAllWrites(request, signal);
    }
    if (isInvalidRequest(signal)) {
      await this.countInvalid(now);
    }
  }

  /**
   * The 401 stop (02 §4.5): one alert, then every queued write is refused
   * and later writes fail fast without a port call. In-flight writes
   * cannot be unsent; their results stand.
   */
  private async stopAllWrites(request: DiscordWriteRequest, signal: ApiErrorSignal): Promise<void> {
    this.fatalRefusal = failureFor({
      ...signal,
      message: `refused: Discord writes are stopped after a 401 (${signal.message ?? 'authentication failed'})`,
    });
    this.logger?.error('Discord rejected the token; stopping all writes', {
      guildId: request.op.guildId,
      jobId: request.jobId,
    });
    await this.raiseAlert({
      kind: 'discord.fatal_config',
      guildId: request.op.guildId,
      jobId: request.jobId,
      message: 'Discord rejected the bot token with 401; all writes stop until the token is fixed',
    });
    for (const queued of [...this.queue]) {
      this.settle(queued, { status: 'failed', failure: this.fatalRefusal }, 'refused');
    }
    this.queue.length = 0;
  }

  /**
   * Counts one invalid response and alerts once at the threshold (02
   * §4.5). The alert re-arms only after the window has drained below the
   * threshold, so a single sustained breach is one alert, and a fresh
   * breach after the window slides is a new one.
   */
  private async countInvalid(now: number): Promise<void> {
    this.pruneInvalid(now);
    this.invalidAt.push(now);
    if (this.invalidAt.length >= this.limits.invalidRequestAlertThreshold) {
      if (!this.invalidAlerted) {
        this.invalidAlerted = true;
        await this.raiseAlert({
          kind: 'discord.invalid_request_budget',
          count: this.invalidAt.length,
          message: `${this.invalidAt.length} invalid Discord requests inside ${Math.round(
            this.limits.invalidRequestWindowMs / 60_000,
          )} minutes; Discord bans at 10,000`,
        });
      }
    } else {
      this.invalidAlerted = false;
    }
  }

  /** Drops invalid-response times older than the window (02 §4.5). */
  private pruneInvalid(now: number): void {
    const cutoff = now - this.limits.invalidRequestWindowMs;
    while (this.invalidAt.length > 0 && (this.invalidAt[0] ?? 0) <= cutoff) {
      this.invalidAt.shift();
    }
  }

  /** Raises one alert through the hook; a failing hook is logged, never fatal. */
  private async raiseAlert(alert: DiscordExecutorAlert): Promise<void> {
    if (this.alertHook === undefined) return;
    try {
      await this.alertHook(alert);
    } catch (err) {
      this.logger?.warn('executor alert hook failed', { kind: alert.kind, error: err });
    }
  }

  /**
   * The preflight before a write is queued (02 §4.5): the §4.2 permission
   * names, then the op-specific checks — role hierarchy for ops that touch
   * a role, the capacity margins for creates. Anything refused never
   * reaches Discord, so it costs no invalid request.
   */
  private async runPreflight(
    pf: DiscordPreflight,
    op: DiscordOp,
  ): Promise<DiscordWriteFailure | undefined> {
    const required = requiredWritePermissions(op);
    const held = await pf.permissions(op.guildId);
    const missing = required.filter((name) => !held.includes(name));
    if (missing.length > 0) {
      return refusedFailure(
        50013,
        `the bot lacks the ${missing.join(', ')} permission in this guild`,
      );
    }
    switch (op.kind) {
      case 'delete_role':
      case 'add_role_to_member':
      case 'remove_role_from_member':
        return this.preflightRoleTarget(pf, op.guildId, op.roleId, op.kind);
      case 'create_role':
        return this.preflightRoleCapacity(op.guildId);
      case 'create_category':
        return this.preflightCategoryCapacity(op.guildId);
      case 'create_text_channel':
        return this.preflightChannelCapacity(op);
      default:
        return undefined;
    }
  }

  /**
   * The role-hierarchy rule: the bot's highest role must sit strictly above
   * any role it deletes or assigns, and integrations' managed roles are
   * untouchable either way (02 §4.13 names the role when it refuses). A
   * target the reads cannot find is not refused here — Discord's own 10011
   * answer maps to `object_missing` through the taxonomy.
   */
  private async preflightRoleTarget(
    pf: DiscordPreflight,
    guildId: string,
    roleId: string,
    kind: DiscordOpKind,
  ): Promise<DiscordWriteFailure | undefined> {
    const roles = await this.port.fetchGuildRoles(guildId);
    const target = roles.find((role) => role.roleId === roleId);
    if (target === undefined) return undefined;
    if (target.managed) {
      const verb = kind === 'delete_role' ? 'deleted' : 'assigned';
      return refusedFailure(
        50013,
        `role '${target.name}' is managed by an integration and cannot be ${verb}`,
      );
    }
    const me = await this.port.fetchMember(guildId, pf.botMemberId);
    if (me === undefined) return undefined;
    const positions = new Map(roles.map((role) => [role.roleId, role.position] as const));
    let myTop = 0;
    for (const held of me.roleIds) {
      myTop = Math.max(myTop, positions.get(held) ?? 0);
    }
    if (target.position >= myTop) {
      return refusedFailure(
        50013,
        `the bot's highest role (position ${myTop}) is not above role '${target.name}' (position ${target.position})`,
      );
    }
    return undefined;
  }

  /** The role capacity margin: one more role must fit under todo-8's limit. */
  private async preflightRoleCapacity(guildId: string): Promise<DiscordWriteFailure | undefined> {
    const roles = await this.port.fetchGuildRoles(guildId);
    if (roles.length + 1 > MAX_ROLES) {
      return refusedFailure(
        30005,
        `creating a role would exceed the guild limit of ${MAX_ROLES} roles (the guild holds ${roles.length})`,
      );
    }
    return undefined;
  }

  /** The channel capacity margins: the guild total, and the category cap. */
  private async preflightChannelCapacity(
    op: Extract<DiscordOp, { kind: 'create_text_channel' }>,
  ): Promise<DiscordWriteFailure | undefined> {
    const channels = await this.port.fetchGuildChannels(op.guildId);
    if (channels.length + 1 > MAX_CHANNELS) {
      return refusedFailure(
        30013,
        `creating a channel would exceed the guild limit of ${MAX_CHANNELS} channels (the guild holds ${channels.length})`,
      );
    }
    if (op.categoryId === undefined) return undefined;
    const inCategory = channels.filter((channel) => channel.categoryId === op.categoryId).length;
    if (inCategory + 1 > MAX_CHANNELS_PER_CATEGORY) {
      return refusedFailure(
        30013,
        `creating a channel would exceed the limit of ${MAX_CHANNELS_PER_CATEGORY} channels per category (the category holds ${inCategory})`,
      );
    }
    return undefined;
  }

  /** The category capacity margins: categories count as channels too (02 §4.8). */
  private async preflightCategoryCapacity(
    guildId: string,
  ): Promise<DiscordWriteFailure | undefined> {
    const channels = await this.port.fetchGuildChannels(guildId);
    if (channels.length + 1 > MAX_CHANNELS) {
      return refusedFailure(
        30013,
        `creating a category would exceed the guild limit of ${MAX_CHANNELS} channels (the guild holds ${channels.length})`,
      );
    }
    const categories = channels.filter((channel) => channel.kind === 'category').length;
    if (categories + 1 > MAX_CATEGORIES) {
      return refusedFailure(
        30013,
        `creating a category would exceed the guild limit of ${MAX_CATEGORIES} categories (the guild holds ${categories})`,
      );
    }
    return undefined;
  }
}

/**
 * Whether a response counts as invalid (02 §4.5): 401, 403 or a 429 —
 * except a shared-scope 429, which is the per-IP bucket every bot on the
 * host shares. A 429 without a scope counts: Discord always sends the
 * header, so an absent one is the adapter's conservatism, not Discord's.
 */
function isInvalidRequest(signal: ApiErrorSignal): boolean {
  if (signal.status === 401 || signal.status === 403) return true;
  return signal.status === 429 && signal.rateLimitScope !== 'shared';
}
