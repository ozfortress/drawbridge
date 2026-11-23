import { describe, expect, it } from 'vitest';
import {
  type CitadelClock,
  type CitadelFetch,
  CitadelParseError,
  type CitadelResponse,
  createCitadelClient,
} from '../src/index.js';

class FakeClock implements CitadelClock {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  /** Every delay passed to setTimeout, for jitter assertions. */
  readonly scheduled: number[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, fn: handler });
    this.scheduled.push(ms);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  /** Timers the client has left armed; must be empty when no call is in flight. */
  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.current = timer?.at ?? this.current;
      timer?.fn();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

/** Drains every queued microtask without waiting on any real timer. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }) as Outcome,
    (error) => ({ ok: false, error }) as Outcome,
  );
}

const userAttributes = (id: string) => ({
  id,
  name: `User ${id}`,
  description: '',
  created_at: '2026-01-01T00:00:00Z',
  steam_32: 'STEAM_0:0:1',
  steam_64: '76561198012345678',
  steam_id3: '[U:1:1]',
  discord_id: '123456789012345678',
  steam_64_str: '76561198012345678',
  profile_url: '',
});

const teamAttributes = (id: string) => ({
  id,
  name: `Team ${id}`,
  description: '',
  avatar_url: '',
  avatar_thumb_url: '',
  avatar_icon_url: '',
});

const rosterAttributes = (id: string) => ({
  id,
  team_id: '10',
  name: `Roster ${id}`,
  description: '',
  disbanded: false,
  division: 'Division 1',
});

const matchAttributes = (id: string) => ({
  id,
  forfeit_by: 'no_forfeit',
  status: 'pending',
  round_name: 'Round 1',
  round_number: 1,
  notice: '',
  created_at: '2026-01-01T00:00:00Z',
});

const leagueAttributes = (id: string) => ({
  id,
  name: `League ${id}`,
  description: '',
});

const leagueBody = (id = '1') =>
  JSON.stringify({
    league: {
      ...leagueAttributes(id),
      rosters: [rosterAttributes('100')],
      matches: [matchAttributes('200')],
    },
  });

const userBody = (id = '5') =>
  JSON.stringify({
    user: {
      ...userAttributes(id),
      teams: [teamAttributes('10')],
      rosters: [rosterAttributes('100')],
    },
  });

const teamBody = (id = '10') =>
  JSON.stringify({
    team: {
      ...teamAttributes(id),
      players: [{ ...userAttributes('5'), is_captain: true }],
      rosters: [rosterAttributes('100')],
    },
  });

const rosterBody = (id = '100') =>
  JSON.stringify({
    roster: {
      ...rosterAttributes(id),
      players: [userAttributes('5')],
      matches: [matchAttributes('200')],
    },
  });

const matchBody = (id = '200') =>
  JSON.stringify({
    match: {
      ...matchAttributes(id),
      league: leagueAttributes('1'),
      home_team: { ...rosterAttributes('100'), players: [userAttributes('5')] },
      away_team: null,
      rounds: [],
    },
  });

type StubResponse = { status: number; body: string } | Error | string;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

function stubFetch(responses: StubResponse[]): {
  fetchImpl: CitadelFetch;
  calls: string[];
  recorded: RecordedCall[];
} {
  const calls: string[] = [];
  const recorded: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl: CitadelFetch = async (url, init) => {
    calls.push(url);
    recorded.push({ url, method: init.method, headers: init.headers, signal: init.signal });
    const next = queue.shift() ?? { status: 500, body: '{}' };
    if (next instanceof Error) throw next;
    // A raw string rejection exercises the non-Error cause path.
    if (typeof next === 'string') throw next;
    const response: CitadelResponse = { status: next.status, text: async () => next.body };
    return response;
  };
  return { fetchImpl, calls, recorded };
}

function clientWith(
  fetchImpl: CitadelFetch,
  clock: FakeClock,
  overrides: Partial<Parameters<typeof createCitadelClient>[0]> = {},
) {
  return createCitadelClient({
    baseUrl: 'http://citadel.test/api/v1',
    apiKey: 'test-key',
    fetchImpl,
    clock,
    random: () => 0.5,
    ...overrides,
  });
}

const serverError = () => ({ status: 500, body: '{}' }) as StubResponse;

describe('createCitadelClient', () => {
  it('reads a league through the root-wrapped body and sends a GET with the API key', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls, recorded } = stubFetch([{ status: 200, body: leagueBody() }]);
    const client = clientWith(fetchImpl, clock);

    const league = await client.getLeague('1');

    expect(league.name).toBe('League 1');
    expect(league.rosters[0]?.division).toBe('Division 1');
    expect(calls).toEqual(['http://citadel.test/api/v1/leagues/1']);
    expect(recorded[0]?.method).toBe('GET');
    expect(recorded[0]?.headers).toEqual({
      accept: 'application/json',
      'x-api-key': 'test-key',
    });
    // Both timeout guards are cleared once the call settles.
    expect(clock.pending).toBe(0);
  });

  it('uses the shallow lookup paths for steam and discord ids', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: userBody() },
      { status: 200, body: userBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    await client.getUserBySteamId('76561198012345678');
    await client.getUserByDiscordId('123456789012345678');

    expect(calls).toEqual([
      'http://citadel.test/api/v1/users/steam_id/76561198012345678',
      'http://citadel.test/api/v1/users/discord_id/123456789012345678',
    ]);
  });

  it('reads the other five resources', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: matchBody() },
      { status: 200, body: rosterBody() },
      { status: 200, body: teamBody() },
      { status: 200, body: userBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    expect((await client.getMatch('200')).id).toBe('200');
    expect((await client.getRoster('100')).id).toBe('100');
    expect((await client.getTeam('10')).players[0]?.is_captain).toBe(true);
    expect((await client.getUser('5')).teams[0]?.id).toBe('10');
    expect(calls).toHaveLength(4);
  });

  it('normalises the base URL and encodes ids into the path', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: teamBody() }]);
    const client = clientWith(fetchImpl, clock, {
      baseUrl: 'http://citadel.test/api/v1///',
    });

    await client.getTeam('a/b c');

    expect(calls).toEqual(['http://citadel.test/api/v1/teams/a%2Fb%20c']);
  });

  it('serves every method twice from the cache and fetches each id once', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: leagueBody() },
      { status: 200, body: matchBody() },
      { status: 200, body: rosterBody() },
      { status: 200, body: teamBody() },
      { status: 200, body: userBody() },
      { status: 200, body: userBody() },
      { status: 200, body: userBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    for (let round = 0; round < 2; round += 1) {
      await client.getLeague('1');
      await client.getMatch('200');
      await client.getRoster('100');
      await client.getTeam('10');
      await client.getUser('5');
      await client.getUserBySteamId('76561198012345678');
      await client.getUserByDiscordId('123456789012345678');
    }

    expect(calls).toHaveLength(7);
  });

  it('serves a cached league until its TTL expires', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: leagueBody() },
      { status: 200, body: leagueBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    await client.getLeague('1');
    await client.getLeague('1');
    expect(calls).toHaveLength(1);

    await clock.advance(299_999);
    await client.getLeague('1');
    expect(calls).toHaveLength(1);

    await clock.advance(1);
    await client.getLeague('1');
    expect(calls).toHaveLength(2);
  });

  it('uses the shorter match TTL', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: matchBody() },
      { status: 200, body: matchBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    await client.getMatch('200');
    await clock.advance(60_000);
    await client.getMatch('200');

    expect(calls).toHaveLength(2);
  });

  it('keeps roster, team and user entries for 600s', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: rosterBody() },
      { status: 200, body: teamBody() },
      { status: 200, body: userBody() },
      { status: 200, body: rosterBody() },
      { status: 200, body: teamBody() },
      { status: 200, body: userBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    await client.getRoster('100');
    await client.getTeam('10');
    await client.getUser('5');
    expect(calls).toHaveLength(3);

    await clock.advance(599_999);
    await client.getRoster('100');
    await client.getTeam('10');
    await client.getUser('5');
    expect(calls).toHaveLength(3);

    await clock.advance(1);
    await client.getRoster('100');
    await client.getTeam('10');
    await client.getUser('5');
    expect(calls).toHaveLength(6);
  });

  it('never caches a failure', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 404, body: '{"message":"Record not found","status":404}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getTeam('404')).rejects.toMatchObject({ code: 'object_missing' });
    await expect(client.getTeam('404')).rejects.toMatchObject({ code: 'object_missing' });
    expect(calls).toHaveLength(2);
  });

  it('maps 401 to fatal_config and stops sending requests', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: '{"message":"nope","status":401}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getLeague('1')).rejects.toMatchObject({ code: 'fatal_config' });
    await expect(client.getLeague('2')).rejects.toMatchObject({ code: 'fatal_config' });
    expect(calls).toHaveLength(1);
  });

  it('maps a hidden league to citadel_not_visible and other 404s to object_missing', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 404, body: '{"message":"Record not found","status":404}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getLeague('1')).rejects.toMatchObject({
      code: 'citadel_not_visible',
      message: expect.stringContaining('not visible'),
    });
    await expect(client.getTeam('10')).rejects.toMatchObject({
      code: 'object_missing',
      message: expect.stringContaining('was not found'),
    });
    expect(calls).toHaveLength(2);
  });

  it('maps an unlisted 4xx to invalid_response and keeps the error body detail', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 422, body: '{"message":"Unprocessable","status":422}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getTeam('10')).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('Unprocessable'),
    });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the raw body when a 4xx error body is not JSON', async () => {
    const clock = new FakeClock();
    const { fetchImpl } = stubFetch([{ status: 422, body: '<html>nope</html>' }]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getTeam('10')).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('<html>nope</html>'),
    });
  });

  it('maps a redirect to invalid_response because the contract has none', async () => {
    const clock = new FakeClock();
    const { fetchImpl } = stubFetch([{ status: 302, body: '' }]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getTeam('10')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps 5xx and network failures to transient', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(10_000);

    expect(await outcome).toMatchObject({ ok: false, error: { code: 'transient' } });
    expect(calls).toHaveLength(4);
    expect(clock.pending).toBe(0);
  });

  it('retries up to three times and then reports transient', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
      { status: 503, body: '{}' },
    ]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(10_000);

    expect(await outcome).toMatchObject({ ok: false, error: { code: 'transient' } });
    expect(calls).toHaveLength(4);
  });

  it('recovers when a later attempt succeeds', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 500, body: '{}' },
      { status: 500, body: '{}' },
      { status: 200, body: leagueBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(10_000);

    expect(await outcome).toMatchObject({ ok: true, value: { name: 'League 1' } });
    expect(calls).toHaveLength(3);
  });

  it('maps a network failure to transient and keeps a non-Error cause readable', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      'socket hang up',
      'socket hang up',
      'socket hang up',
      'socket hang up',
    ]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(10_000);

    expect(await outcome).toMatchObject({
      ok: false,
      error: { code: 'transient', message: expect.stringContaining('socket hang up') },
    });
    expect(calls).toHaveLength(4);
  });

  it('spaces retries with exponential jitter', async () => {
    const low = new FakeClock();
    const lowStub = stubFetch(Array.from({ length: 4 }, serverError));
    const lowOutcome = settle(
      clientWith(lowStub.fetchImpl, low, { random: () => 0 }).getLeague('1'),
    );
    await flush();
    await low.advance(10_000);
    await lowOutcome;

    const high = new FakeClock();
    const highStub = stubFetch(Array.from({ length: 4 }, serverError));
    const highOutcome = settle(
      clientWith(highStub.fetchImpl, high, { random: () => 1 }).getLeague('1'),
    );
    await flush();
    await high.advance(10_000);
    await highOutcome;

    // 250ms base doubling per retry, jitter factor 0.8..1.2.
    expect(low.scheduled.filter((ms) => ms < 5_000)).toEqual([200, 400, 800]);
    expect(high.scheduled.filter((ms) => ms < 5_000)).toEqual([300, 600, 1200]);
  });

  it('does not retry a body that is not valid Citadel JSON', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: 'not json at all' }]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));

    expect(await outcome).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    const error = (await outcome) as { ok: false; error: Error };
    expect(error.error.cause).toBeInstanceOf(CitadelParseError);
    expect(calls).toHaveLength(1);
  });

  it('rejects a misleading success body instead of returning a half object', async () => {
    const clock = new FakeClock();
    // A perfectly valid team body on the league endpoint: 200, valid JSON,
    // valid Citadel data - but the wrong shape.
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: teamBody() },
      { status: 200, body: teamBody() },
    ]);
    const client = clientWith(fetchImpl, clock);

    await expect(client.getLeague('1')).rejects.toMatchObject({ code: 'invalid_response' });
    // The rejected response was not cached either.
    await expect(client.getLeague('1')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls).toHaveLength(2);
  });

  it('rejects a stale schema that lost a renamed key', async () => {
    const clock = new FakeClock();
    const stale = leagueBody().replace('"name":"League 1"', '"title":"League 1"');
    const { fetchImpl } = stubFetch([{ status: 200, body: stale }]);
    const client = clientWith(fetchImpl, clock);

    const outcome = settle(client.getLeague('1'));
    expect(await outcome).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    const error = (await outcome) as { ok: false; error: Error };
    expect((error.error.cause as Error).message).toContain('name');
  });

  it('opens the circuit after five failures and fails fast afterwards', async () => {
    const clock = new FakeClock();
    const failing = Array.from({ length: 5 }, serverError);
    const { fetchImpl, calls } = stubFetch(failing);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getLeague(`league-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }
    expect(calls).toHaveLength(5);

    await expect(client.getLeague('after')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(5);
  });

  it('lets a single probe through after the cooldown and closes the circuit on success', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      ...Array.from({ length: 5 }, serverError),
      { status: 200, body: leagueBody() },
    ]);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getLeague(`league-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }

    await clock.advance(60_000);
    await expect(client.getLeague('probe')).resolves.toMatchObject({ name: 'League 1' });
    expect(calls).toHaveLength(6);

    await expect(client.getTeam('10')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(7);
  });

  it('reopens the circuit when the probe fails and allows another probe after the cooldown', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      ...Array.from({ length: 5 }, serverError),
      serverError(),
      { status: 200, body: leagueBody() },
      { status: 200, body: teamBody() },
    ]);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getLeague(`league-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }

    await clock.advance(60_000);
    await expect(client.getLeague('probe-1')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(6);

    // Open again: fails fast without touching the network.
    await expect(client.getLeague('fast')).rejects.toMatchObject({ code: 'transient' });
    expect(calls).toHaveLength(6);

    await clock.advance(60_000);
    await expect(client.getLeague('probe-2')).resolves.toMatchObject({ name: 'League 1' });
    await expect(client.getTeam('10')).resolves.toMatchObject({ name: 'Team 10' });
    expect(calls).toHaveLength(8);
  });

  it('closes the circuit when the probe gets a definitive answer like 404', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      ...Array.from({ length: 5 }, serverError),
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 200, body: leagueBody() },
    ]);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getLeague(`league-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }

    await clock.advance(60_000);
    // The probe gets a definitive answer (league 404 = citadel_not_visible):
    // it must not wedge the breaker.
    await expect(client.getLeague('probe')).rejects.toMatchObject({ code: 'citadel_not_visible' });
    await expect(client.getLeague('after')).resolves.toMatchObject({ name: 'League 1' });
    expect(calls).toHaveLength(7);
  });

  it('does not count definitive answers toward the breaker', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 200, body: 'not json at all' },
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 404, body: '{"message":"Record not found","status":404}' },
      { status: 200, body: leagueBody() },
    ]);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getTeam(`team-${attempt}`)).rejects.toMatchObject({
        code: expect.stringMatching(/object_missing|invalid_response/),
      });
    }
    // Five definitive answers did not open the breaker: this call still fetches.
    await expect(client.getLeague('1')).resolves.toMatchObject({ name: 'League 1' });
    expect(calls).toHaveLength(6);
  });

  it('serves fresh cache entries even while the breaker is open', async () => {
    const clock = new FakeClock();
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: leagueBody() },
      ...Array.from({ length: 5 }, serverError),
    ]);
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    await client.getLeague('1');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getTeam(`team-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }
    expect(calls).toHaveLength(6);

    await expect(client.getLeague('1')).resolves.toMatchObject({ name: 'League 1' });
    expect(calls).toHaveLength(6);
  });

  it('fails fast for other callers while the probe is in flight', async () => {
    const clock = new FakeClock();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = stubFetch(Array.from({ length: 5 }, serverError));
    const gated: CitadelFetch = async (url, init) => {
      if (calls.length >= 5) {
        calls.push(url);
        await gate;
        return { status: 200, text: async () => leagueBody() };
      }
      return fetchImpl(url, init);
    };
    const client = clientWith(gated, clock, { maxRetries: 0 });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.getLeague(`league-${attempt}`)).rejects.toMatchObject({
        code: 'transient',
      });
    }

    await clock.advance(60_000);
    const probe = settle(client.getLeague('probe'));
    await flush();
    expect(calls).toHaveLength(6);

    await expect(client.getLeague('other')).rejects.toMatchObject({
      code: 'transient',
      message: expect.stringContaining('probe'),
    });
    expect(calls).toHaveLength(6);

    release?.();
    expect(await probe).toMatchObject({ ok: true, value: { name: 'League 1' } });
  });

  it('keeps at most four requests in flight for one client', async () => {
    const clock = new FakeClock();
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: CitadelFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return { status: 200, text: async () => leagueBody() };
    };
    const client = clientWith(fetchImpl, clock);

    const pending = [1, 2, 3, 4, 5].map((id) => client.getLeague(`league-${id}`));
    await flush();
    await flush();

    expect(peak).toBe(4);
    release?.();
    await Promise.all(pending);
    expect(inFlight).toBe(0);
  });

  it('times out a request that never answers and aborts it', async () => {
    const clock = new FakeClock();
    let signal: AbortSignal | undefined;
    const fetchImpl: CitadelFetch = (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(5_000);

    expect(await outcome).toMatchObject({
      ok: false,
      error: {
        code: 'transient',
        message: expect.stringContaining('connect timed out after 5000ms'),
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('times out a request whose body never finishes', async () => {
    const clock = new FakeClock();
    const fetchImpl: CitadelFetch = () =>
      Promise.resolve({ status: 200, text: () => new Promise<string>(() => undefined) });
    const client = clientWith(fetchImpl, clock, { maxRetries: 0 });

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(15_000);

    expect(await outcome).toMatchObject({
      ok: false,
      error: {
        code: 'transient',
        message: expect.stringContaining('request timed out after 15000ms'),
      },
    });
    expect(clock.pending).toBe(0);
  });

  it('retries after a timeout and succeeds on a later attempt', async () => {
    const clock = new FakeClock();
    let firstSignal: AbortSignal | undefined;
    let calls = 0;
    const fetchImpl: CitadelFetch = (_url, init) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = init.signal;
        // Hangs until the connect timeout aborts it.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve({ status: 200, text: async () => leagueBody() });
    };
    const client = clientWith(fetchImpl, clock, { maxRetries: 1 });

    const outcome = settle(client.getLeague('1'));
    await flush();
    await clock.advance(5_000);
    await clock.advance(1_000);

    expect(await outcome).toMatchObject({ ok: true, value: { name: 'League 1' } });
    expect(calls).toBe(2);
    expect(firstSignal?.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });
});
