/**
 * Read-only Citadel API client.
 *
 * Failures are mapped onto a small taxonomy so callers can decide between
 * retrying, asking an operator, or giving up. Time, retries, the circuit
 * breaker and the cache are driven by an injected clock, so the client is
 * fully testable without real waiting.
 */
import {
  type League,
  type Match,
  parseErrorResponse,
  parseLeagueResponse,
  parseMatchResponse,
  parseRosterResponse,
  parseTeamResponse,
  parseUserResponse,
  type Roster,
  type Team,
  type User,
} from './schemas.js';

/** How a Citadel failure should be treated by the caller. */
export type CitadelErrorCode =
  /** The API key was rejected; the configuration is wrong. */
  | 'fatal_config'
  /** The league exists but is not visible to this key. */
  | 'citadel_not_visible'
  /** The requested object does not exist. */
  | 'object_missing'
  /** The upstream failed in a way that may succeed later. */
  | 'transient'
  /** The upstream answered, but the body was not a valid Citadel body. */
  | 'invalid_response';

/** A Citadel failure carrying its taxonomy code. */
export class CitadelError extends Error {
  override readonly name = 'CitadelError';

  constructor(
    readonly code: CitadelErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Time source used by the client; inject a fake clock in tests. */
export interface CitadelClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Minimal response contract the client needs from `fetch`. */
export interface CitadelResponse {
  status: number;
  text(): Promise<string>;
}

/** The `fetch` shape the client uses; injectable for tests. */
export type CitadelFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<CitadelResponse>;

/** Options accepted by {@link createCitadelClient}. */
export interface CitadelClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: CitadelFetch;
  clock?: CitadelClock;
  random?: () => number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Retries after the first attempt; the default is 3 retries (4 attempts). */
  maxRetries?: number;
  concurrency?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  retryBaseDelayMs?: number;
}

/** The seven read endpoints the client exposes. */
export interface CitadelClient {
  getLeague(id: string): Promise<League>;
  getMatch(id: string): Promise<Match>;
  getRoster(id: string): Promise<Roster>;
  getTeam(id: string): Promise<Team>;
  getUser(id: string): Promise<User>;
  getUserBySteamId(id: string): Promise<User>;
  getUserByDiscordId(id: string): Promise<User>;
}

const TTL_MS = {
  league: 300_000,
  match: 60_000,
  roster: 600_000,
  team: 600_000,
  user: 600_000,
} as const;

const defaultClock: CitadelClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Creates a Citadel client whose failures reject with a {@link CitadelError}. */
export function createCitadelClient(options: CitadelClientOptions): CitadelClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const apiKey = options.apiKey;
  const fetchImpl: CitadelFetch =
    options.fetchImpl ??
    ((url, init) =>
      fetch(url, init).then((response) => ({
        status: response.status,
        text: () => response.text(),
      })));
  const clock = options.clock ?? defaultClock;
  const random = options.random ?? Math.random;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 3;
  const concurrencyLimit = options.concurrency ?? 4;
  const breakerThreshold = options.breakerThreshold ?? 5;
  const breakerCooldownMs = options.breakerCooldownMs ?? 60_000;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;

  const cache = new Map<string, { value: unknown; expiresAt: number }>();
  const waiters: (() => void)[] = [];
  let inFlight = 0;
  let fatal = false;
  let consecutiveFailures = 0;
  let breakerOpen = false;
  let openUntil = 0;
  let halfOpenProbe = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      clock.setTimeout(resolve, ms);
    });

  const backoffDelay = (attempt: number): number => {
    const base = retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = 0.8 + random() * 0.4;
    return Math.round(base * jitter);
  };

  async function acquire(): Promise<void> {
    if (inFlight < concurrencyLimit) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight += 1;
  }

  function release(): void {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  function readCache<T>(key: string): T | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= clock.now()) {
      cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  function assertNotFatal(): void {
    if (fatal) {
      throw new CitadelError(
        'fatal_config',
        'Citadel rejected the API key with 401; no further requests were sent',
      );
    }
  }

  /** Throws while the breaker is open; lets exactly one caller probe. */
  function checkBreaker(): void {
    if (!breakerOpen) return;
    const now = clock.now();
    if (now < openUntil) {
      throw new CitadelError(
        'transient',
        `Citadel circuit breaker is open for another ${openUntil - now}ms`,
      );
    }
    if (halfOpenProbe) {
      throw new CitadelError(
        'transient',
        'Citadel circuit breaker is half-open and a probe is already in flight',
      );
    }
    halfOpenProbe = true;
  }

  /** The upstream answered definitively (2xx or 4xx): it is healthy again. */
  function recordAnswered(): void {
    consecutiveFailures = 0;
    breakerOpen = false;
    openUntil = 0;
    halfOpenProbe = false;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    halfOpenProbe = false;
    if (consecutiveFailures >= breakerThreshold) {
      breakerOpen = true;
      openUntil = clock.now() + breakerCooldownMs;
    }
  }

  function mapStatus(status: number, path: string, body: string, isLeague: boolean): CitadelError {
    if (status === 401) {
      fatal = true;
      return new CitadelError('fatal_config', 'Citadel rejected the API key (401)');
    }
    if (status === 404) {
      if (isLeague) {
        return new CitadelError(
          'citadel_not_visible',
          `League ${path} is not visible to this API key`,
        );
      }
      return new CitadelError('object_missing', `Citadel ${path} was not found (404)`);
    }
    if (status >= 500) {
      return new CitadelError('transient', `Citadel returned ${status} for ${path}`);
    }
    if (status >= 400) {
      let detail = body.slice(0, 200);
      try {
        const parsed = parseErrorResponse(body);
        detail = parsed.message;
      } catch {
        detail = body.slice(0, 200);
      }
      return new CitadelError('invalid_response', `Citadel returned ${status}: ${detail}`);
    }
    return new CitadelError('invalid_response', `Citadel returned ${status} for ${path}`);
  }

  async function perform<T>(
    path: string,
    parse: (text: string) => T,
    isLeague: boolean,
  ): Promise<T> {
    const url = `${baseUrl}/${path}`;
    const controller = new AbortController();
    let connectTimer: unknown;
    let totalTimer: unknown;
    let timedOut: 'connect' | 'total' | null = null;

    const timeoutError = (): CitadelError =>
      timedOut === 'connect'
        ? new CitadelError('transient', `Citadel connect timed out after ${connectTimeoutMs}ms`)
        : new CitadelError('transient', `Citadel request timed out after ${totalTimeoutMs}ms`);

    const connectGuard = new Promise<never>((_resolve, reject) => {
      connectTimer = clock.setTimeout(() => {
        timedOut ??= 'connect';
        controller.abort();
        reject(timeoutError());
      }, connectTimeoutMs);
    });
    const totalGuard = new Promise<never>((_resolve, reject) => {
      totalTimer = clock.setTimeout(() => {
        timedOut ??= 'total';
        controller.abort();
        reject(timeoutError());
      }, totalTimeoutMs);
    });
    // The guards are only awaited while the request is in flight; the catch
    // keeps a late timeout from surfacing as an unhandled rejection.
    void connectGuard.catch(() => undefined);
    void totalGuard.catch(() => undefined);

    try {
      let response: CitadelResponse;
      try {
        response = await Promise.race([
          fetchImpl(url, {
            method: 'GET',
            signal: controller.signal,
            headers: { accept: 'application/json', 'x-api-key': apiKey },
          }),
          connectGuard,
          totalGuard,
        ]);
      } catch (cause) {
        if (cause instanceof CitadelError) throw cause;
        if (timedOut) throw timeoutError();
        throw new CitadelError(
          'transient',
          `Citadel request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      } finally {
        clock.clearTimeout(connectTimer);
      }

      let body: string;
      try {
        body = await Promise.race([response.text(), totalGuard]);
      } catch (cause) {
        if (cause instanceof CitadelError) throw cause;
        if (timedOut) throw timeoutError();
        throw new CitadelError('transient', `Citadel response body for ${path} failed`, { cause });
      }

      if (response.status < 200 || response.status >= 300) {
        throw mapStatus(response.status, path, body, isLeague);
      }

      try {
        return parse(body);
      } catch (cause) {
        throw new CitadelError('invalid_response', `Citadel ${path} did not return a valid body`, {
          cause,
        });
      }
    } finally {
      clock.clearTimeout(totalTimer);
    }
  }

  async function request<T>(
    path: string,
    cacheKey: string,
    ttlMs: number,
    parse: (text: string) => T,
    isLeague: boolean,
  ): Promise<T> {
    assertNotFatal();

    const hit = readCache<T>(cacheKey);
    if (hit !== undefined) return hit;

    checkBreaker();

    await acquire();
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const value = await perform(path, parse, isLeague);
          cache.set(cacheKey, { value, expiresAt: clock.now() + ttlMs });
          recordAnswered();
          return value;
        } catch (error) {
          const code = error instanceof CitadelError ? error.code : 'transient';
          if (code === 'transient') {
            if (attempt <= maxRetries) {
              await sleep(backoffDelay(attempt));
              continue;
            }
            recordFailure();
          } else {
            // A definitive answer (2xx/4xx/invalid body) proves the upstream
            // is responding; it must release a half-open probe or the breaker
            // would stay wedged until another transient failure.
            recordAnswered();
          }
          throw error;
        }
      }
    } finally {
      release();
    }
  }

  const encode = (id: string): string => encodeURIComponent(id);

  return {
    getLeague: (id) =>
      request(`leagues/${encode(id)}`, `league:${id}`, TTL_MS.league, parseLeagueResponse, true),
    getMatch: (id) =>
      request(`matches/${encode(id)}`, `match:${id}`, TTL_MS.match, parseMatchResponse, false),
    getRoster: (id) =>
      request(`rosters/${encode(id)}`, `roster:${id}`, TTL_MS.roster, parseRosterResponse, false),
    getTeam: (id) =>
      request(`teams/${encode(id)}`, `team:${id}`, TTL_MS.team, parseTeamResponse, false),
    getUser: (id) =>
      request(`users/${encode(id)}`, `user:${id}`, TTL_MS.user, parseUserResponse, false),
    getUserBySteamId: (id) =>
      request(
        `users/steam_id/${encode(id)}`,
        `user:steam:${id}`,
        TTL_MS.user,
        parseUserResponse,
        false,
      ),
    getUserByDiscordId: (id) =>
      request(
        `users/discord_id/${encode(id)}`,
        `user:discord:${id}`,
        TTL_MS.user,
        parseUserResponse,
        false,
      ),
  };
}
