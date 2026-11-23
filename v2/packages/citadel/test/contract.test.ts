/**
 * Contract tests for the Citadel client against the recorded fixtures.
 *
 * The fixtures under `tools/citadel-dev/fixtures` are verbatim responses
 * captured from a Citadel dev instance, so they are the wire contract: the
 * bodies carry JSON integers above `Number.MAX_SAFE_INTEGER` (Discord
 * snowflakes, Steam 64 ids) that only survive if the client parses them
 * losslessly. The fake Citadel serves those exact bytes over real HTTP, so
 * these tests exercise the production fetch path, the real status codes and
 * the real error taxonomy.
 *
 * No timers are involved: every failing call uses `maxRetries: 0`, so the
 * client never waits between attempts. The one exception is the `slow`
 * suite, where the client itself carries the timeout that ends the call.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeCitadel, type FakeCitadel } from '@drawbridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CitadelClient,
  CitadelError,
  CitadelParseError,
  createCitadelClient,
} from '../src/index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../../tools/citadel-dev/fixtures/', import.meta.url));

/** The Discord snowflake the dev instance assigns to the seeded player. */
const DISCORD_ID = '200000000000000001';
/** The Steam 64 id the dev instance assigns to the seeded player. */
const STEAM_ID = '76561198000000001';

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** Route path to the recorded body of that route. */
const FIXTURES: Record<string, string> = {
  'leagues/9100': fixture('league.json'),
  'matches/9500': fixture('match-pending.json'),
  'matches/9503': fixture('match-confirmed.json'),
  'matches/9511': fixture('match-bye.json'),
  'rosters/9400': fixture('roster.json'),
  'teams/9300': fixture('team.json'),
  'users/9200': fixture('user.json'),
  [`users/steam_id/${STEAM_ID}`]: fixture('user-by-steam-id.json'),
  [`users/discord_id/${DISCORD_ID}`]: fixture('user-by-discord-id.json'),
};

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Resolves with the outcome instead of throwing, so "no object" is assertable. */
async function settle<T>(promise: Promise<T>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }) as Outcome,
    (error: unknown) => ({ ok: false, error }) as Outcome,
  );
}

/**
 * Fails loudly instead of hanging when the promise never settles. The timer
 * is always cleared, so it never keeps the process alive.
 */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the call did not settle within ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

describe('Citadel client against the recorded fixtures', () => {
  let citadel: FakeCitadel;
  let client: CitadelClient;

  beforeAll(async () => {
    citadel = await createFakeCitadel({ fixtures: FIXTURES });
    client = createCitadelClient({
      baseUrl: citadel.baseUrl,
      apiKey: 'test-key',
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await citadel.close();
  });

  it('reads the league with its rosters and matches', async () => {
    const league = await client.getLeague('9100');

    expect(league.id).toBe('9100');
    expect(league.name).toBe('ozfortress Dev Sixes');
    expect(league.rosters).toHaveLength(16);
    expect(league.matches).toHaveLength(16);
    expect(league.rosters[0]?.id).toBe('9406');
    expect(league.rosters[0]?.team_id).toBe('9306');
    expect(league.rosters[0]?.division).toBe('Premier');
    expect(league.matches[0]?.id).toBe('9503');
    expect(league.matches[0]?.status).toBe('confirmed');
    expect(league.matches[0]?.forfeit_by).toBe('no_forfeit');
  });

  it('reads a confirmed match with both teams and its rounds', async () => {
    const match = await client.getMatch('9503');

    expect(match.id).toBe('9503');
    expect(match.status).toBe('confirmed');
    expect(match.forfeit_by).toBe('no_forfeit');
    expect(match.round_name).toBe('Round 1');
    expect(match.round_number).toBe(1);
    expect(match.league.id).toBe('9100');
    expect(match.league.name).toBe('ozfortress Dev Sixes');
    expect(match.home_team.id).toBe('9406');
    expect(match.home_team.players).toHaveLength(6);
    expect(match.away_team?.id).toBe('9407');
    expect(match.away_team?.players).toHaveLength(6);
    expect(match.rounds).toHaveLength(3);
    expect(match.rounds[0]?.home_team_score).toBe(3);
    expect(match.rounds[0]?.away_team_score).toBe(1);
    expect(match.rounds[0]?.map?.id).toBe('9010');
    expect(match.rounds[0]?.map?.name).toBe('cp_badlands');
  });

  it('reads a pending match without rounds', async () => {
    const match = await client.getMatch('9500');

    expect(match.id).toBe('9500');
    expect(match.status).toBe('pending');
    expect(match.rounds).toHaveLength(0);
    expect(match.home_team.id).toBe('9400');
    expect(match.away_team?.id).toBe('9401');
  });

  it('reads a bye with a null away team', async () => {
    const match = await client.getMatch('9511');

    expect(match.id).toBe('9511');
    expect(match.status).toBe('confirmed');
    expect(match.away_team).toBeNull();
    expect(match.home_team.id).toBe('9406');
  });

  it('reads the roster with its players and matches', async () => {
    const roster = await client.getRoster('9400');

    expect(roster.id).toBe('9400');
    expect(roster.team_id).toBe('9300');
    expect(roster.name).toBe('Dev Team 01');
    expect(roster.division).toBe('Premier');
    expect(roster.disbanded).toBe(false);
    expect(roster.players).toHaveLength(6);
    expect(roster.players[0]?.id).toBe('9200');
    expect(roster.players[0]?.steam_64).toBe(STEAM_ID);
    expect(roster.players[0]?.discord_id).toBe(DISCORD_ID);
    // The seeded player without a Discord account keeps a null id.
    expect(roster.players[2]?.id).toBe('9202');
    expect(roster.players[2]?.discord_id).toBeNull();
    expect(roster.matches).toHaveLength(3);
  });

  it('reads the team with exactly one captain', async () => {
    const team = await client.getTeam('9300');

    expect(team.id).toBe('9300');
    expect(team.name).toBe('Dev Team 01');
    expect(team.players).toHaveLength(6);
    expect(team.players[0]?.id).toBe('9200');
    expect(team.players[0]?.is_captain).toBe(true);
    expect(team.players.filter((player) => player.is_captain)).toHaveLength(1);
    expect(team.rosters[0]?.id).toBe('9400');
  });

  it('reads the user with the exact snowflake and steam id', async () => {
    const user = await client.getUser('9200');

    expect(user.id).toBe('9200');
    expect(user.name).toBe('Dev Player 01');
    // The raw body carries these as JSON integers; only a lossless parse
    // keeps them exact.
    expect(user.steam_64).toBe(STEAM_ID);
    expect(user.steam_64_str).toBe(STEAM_ID);
    expect(user.discord_id).toBe(DISCORD_ID);
    expect(user.teams[0]?.id).toBe('9300');
    expect(user.rosters[0]?.id).toBe('9400');
  });

  it('looks the user up by steam id', async () => {
    const user = await client.getUserBySteamId(STEAM_ID);

    expect(user.id).toBe('9200');
    expect(user.steam_64).toBe(STEAM_ID);
    expect(user.steam_64_str).toBe(STEAM_ID);
    expect(user.discord_id).toBe(DISCORD_ID);
  });

  it('looks the user up by discord id', async () => {
    const user = await client.getUserByDiscordId(DISCORD_ID);

    expect(user.id).toBe('9200');
    expect(user.discord_id).toBe(DISCORD_ID);
    expect(user.steam_64).toBe(STEAM_ID);
  });
});

describe('Citadel client against a failing Citadel', () => {
  let citadel: FakeCitadel;

  beforeAll(async () => {
    citadel = await createFakeCitadel({ fixtures: FIXTURES, mode: '503' });
  });

  afterAll(async () => {
    await citadel.close();
  });

  it('reports a 503 as transient and returns no object', async () => {
    const client = createCitadelClient({
      baseUrl: citadel.baseUrl,
      apiKey: 'test-key',
      maxRetries: 0,
    });

    const outcome = await settle(client.getLeague('9100'));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected the league read to fail');
    expect((outcome.error as CitadelError).code).toBe('transient');
    // A failure is never cached, so the next read fails the same way.
    await expect(client.getLeague('9100')).rejects.toMatchObject({ code: 'transient' });
  });
});

describe('Citadel client against a slow Citadel', () => {
  let citadel: FakeCitadel;

  beforeAll(async () => {
    citadel = await createFakeCitadel({ fixtures: FIXTURES, mode: 'slow' });
  });

  afterAll(async () => {
    await citadel.close();
  });

  it('reports a hung response as transient and returns no object', async () => {
    const client = createCitadelClient({
      baseUrl: citadel.baseUrl,
      apiKey: 'test-key',
      // The fake sends the header but never the body, so the client's own
      // timeout is the only thing that can end the call.
      connectTimeoutMs: 50,
      totalTimeoutMs: 50,
      maxRetries: 0,
    });

    const outcome = await settle(within(client.getLeague('9100'), 5_000));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected the league read to fail');
    expect(outcome.error).toBeInstanceOf(CitadelError);
    expect((outcome.error as CitadelError).code).toBe('transient');
  });
});

describe('Citadel client against a malformed Citadel body', () => {
  let citadel: FakeCitadel;

  beforeAll(async () => {
    citadel = await createFakeCitadel({ fixtures: FIXTURES, mode: 'malformed' });
  });

  afterAll(async () => {
    await citadel.close();
  });

  it('reports a non-JSON body as invalid_response and returns no object', async () => {
    const client = createCitadelClient({
      baseUrl: citadel.baseUrl,
      apiKey: 'test-key',
      maxRetries: 0,
    });

    const outcome = await settle(client.getLeague('9100'));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected the league read to fail');
    const error = outcome.error as CitadelError;
    expect(error.code).toBe('invalid_response');
    expect(error.cause).toBeInstanceOf(CitadelParseError);
  });
});
