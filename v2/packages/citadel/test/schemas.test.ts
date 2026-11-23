import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type CitadelMap,
  CitadelParseError,
  type League,
  type Match,
  parseErrorResponse,
  parseLeagueResponse,
  parseMatchResponse,
  parseRosterResponse,
  parseTeamResponse,
  parseUserResponse,
  type User,
} from '../src/index.js';

// Raw JSON fixtures in the exact wire shapes Citadel produces (probe of the
// real serializers). Snowflake-sized ids stay bare JSON numbers: only the
// lossless parser can read them back exactly.

const user42 = `{"id":42,"name":"Captain","description":"","created_at":"2026-09-27T15:30:01.343Z","steam_32":"STEAM_0:1:16716622","steam_64":76561198012345678,"steam_id3":"U:1:33433245","discord_id":123456789012345678,"steam_64_str":"76561198012345678","profile_url":"/assets/fallback/thumb_user_avatar_default.png"}`;

const user43 = `{"id":43,"name":"Player","description":"","created_at":"2026-09-28T10:11:12.000Z","steam_32":"STEAM_0:0:12345678","steam_64":76561198000000001,"steam_id3":"U:1:24691356","discord_id":null,"steam_64_str":"76561198000000001","profile_url":"/assets/fallback/thumb_user_avatar_default.png"}`;

const team7 = `{"id":7,"name":"Test Team","description":"","avatar_url":"/assets/fallback/team_avatar_default.png","avatar_thumb_url":"/assets/fallback/thumb_team_avatar_default.png","avatar_icon_url":"/assets/fallback/icon_team_avatar_default.png"}`;

const roster10 = `{"id":10,"team_id":7,"name":"Home Roster","description":"","disbanded":false,"division":"Premier"}`;
const roster11 = `{"id":11,"team_id":8,"name":"Away Roster","description":"","disbanded":false,"division":"Premier"}`;

const match101 = `{"id":101,"forfeit_by":"no_forfeit","status":"submitted_by_home_team","round_name":"Week 1","round_number":1,"notice":"","created_at":"2026-11-20T10:00:00.000Z"}`;

// The league embedded under `match.league` carries only id/name/description;
// unknown extra keys (drift) are stripped instead of failing the parse.
const leagueDump = `{"id":1,"format_id":1,"name":"Probe League","description":"Probe description","signuppable":true,"roster_locked":false,"min_players":6,"max_players":0,"rosters_count":16,"schedule":"manual","points_per_round_win":"2.0","query_name_cache":"","description_render_cache":""}`;

const roundDump = `{"home_team_score":3,"away_team_score":2,"map":{"id":4,"game_id":1,"name":"Badlands","description":"","created_at":"2026-11-20T09:00:00.000Z","updated_at":"2026-11-20T09:00:00.000Z","description_render_cache":""}}`;

const withPlayers = (roster: string, user: string) => `${roster.slice(0, -1)},"players":[${user}]}`;
const withCaptain = (user: string, isCaptain: boolean) =>
  `${user.slice(0, -1)},"is_captain":${isCaptain}}`;
const withAssociations = (attributes: string, associations: string) =>
  `${attributes.slice(0, -1)},${associations}}`;
const withMatchGraph = (attributes: string, associations: string) =>
  `{"match":${withAssociations(attributes, associations)}}`;

const matchAssociations = `"league":${leagueDump},"home_team":${withPlayers(roster10, user43)},"away_team":${withPlayers(roster11, user42)},"rounds":[${roundDump}]`;
const byeAssociations = `"league":${leagueDump},"home_team":${withPlayers(roster10, user43)},"away_team":null,"rounds":[]`;

const userBody = `{"user":${withAssociations(user42, `"teams":[${team7}],"rosters":[${roster10}]`)}}`;
const steamBody = `{"user":${withAssociations(user43, `"teams":[],"rosters":[]`)}}`;
const teamBody = `{"team":${withAssociations(
  team7,
  `"players":[${withCaptain(user42, true)},${withCaptain(user43, false)}],"rosters":[${roster10}]`,
)}}`;
const rosterBody = `{"roster":${withAssociations(roster10, `"players":[${user42}],"matches":[${match101}]`)}}`;
const leagueBody = `{"league":{"id":1,"name":"Probe League","description":"Probe description","rosters":[${roster10},${roster11}],"matches":[${match101}]}}`;
const matchBody = withMatchGraph(match101, matchAssociations);
const byeMatchBody = withMatchGraph(
  `{"id":102,"forfeit_by":"no_forfeit","status":"confirmed","round_name":"","round_number":2,"notice":"","created_at":"2026-11-21T08:00:00.000Z"}`,
  byeAssociations,
);

const USER_KEYS = [
  'created_at',
  'description',
  'discord_id',
  'id',
  'name',
  'profile_url',
  'rosters',
  'steam_32',
  'steam_64',
  'steam_64_str',
  'steam_id3',
  'teams',
];

describe('citadel schemas', () => {
  it('parses a user fixture with exact snowflake round-trip', () => {
    const user = parseUserResponse(userBody);
    expect(user.id).toBe('42');
    expect(user.steam_64).toBe('76561198012345678');
    expect(user.discord_id).toBe('123456789012345678');
    expect(user.steam_64_str).toBe('76561198012345678');
    expect(Object.keys(user).sort()).toEqual(USER_KEYS);
    expect(user.teams[0]?.id).toBe('7');
    expect(user.rosters[0]?.team_id).toBe('7');
    expect(user.rosters[0]?.division).toBe('Premier');
  });

  it('parses the steam lookup shape, keeping null discord ids', () => {
    const user = parseUserResponse(steamBody);
    expect(user.steam_64).toBe('76561198000000001');
    expect(user.discord_id).toBeNull();
    expect(Object.keys(user).sort()).toEqual(USER_KEYS);
  });

  it('parses the discord lookup shape for an 18-digit snowflake', () => {
    const user = parseUserResponse(userBody);
    expect(user.discord_id).toBe('123456789012345678');
  });

  it('parses a team fixture with is_captain players', () => {
    const team = parseTeamResponse(teamBody);
    expect(Object.keys(team).sort()).toEqual([
      'avatar_icon_url',
      'avatar_thumb_url',
      'avatar_url',
      'description',
      'id',
      'name',
      'players',
      'rosters',
    ]);
    expect(team.players[0]?.is_captain).toBe(true);
    expect(team.players[1]?.is_captain).toBe(false);
    expect(team.players[0]?.discord_id).toBe('123456789012345678');
    expect(team.rosters[0]?.team_id).toBe('7');
  });

  it('parses a roster fixture whose players have no is_captain key', () => {
    const roster = parseRosterResponse(rosterBody);
    expect(Object.keys(roster).sort()).toEqual([
      'description',
      'disbanded',
      'division',
      'id',
      'matches',
      'name',
      'players',
      'team_id',
    ]);
    expect(roster.players[0]).not.toHaveProperty('is_captain');
    expect(roster.matches[0]?.status).toBe('submitted_by_home_team');
    expect(roster.matches[0]).not.toHaveProperty('rounds');
  });

  it('parses a league fixture with attribute-only rosters and matches', () => {
    const league = parseLeagueResponse(leagueBody);
    expect(Object.keys(league).sort()).toEqual(['description', 'id', 'matches', 'name', 'rosters']);
    expect(league.rosters).toHaveLength(2);
    expect(league.rosters[0]).not.toHaveProperty('players');
    expect(league.matches[0]?.round_number).toBe(1);
    expect(league.matches[0]).not.toHaveProperty('home_team');
    expect(league.matches[0]).not.toHaveProperty('league');
  });

  it('parses a match fixture, stripping the raw league and map dumps', () => {
    const match = parseMatchResponse(matchBody);
    expect(Object.keys(match).sort()).toEqual([
      'away_team',
      'created_at',
      'forfeit_by',
      'home_team',
      'id',
      'league',
      'notice',
      'round_name',
      'round_number',
      'rounds',
      'status',
    ]);
    expect(Object.keys(match.league).sort()).toEqual(['description', 'id', 'name']);
    expect(match.home_team.players[0]?.steam_64).toBe('76561198000000001');
    expect(match.home_team).not.toHaveProperty('matches');
    expect(match.away_team?.players[0]?.discord_id).toBe('123456789012345678');
    expect(match.rounds[0]?.home_team_score).toBe(3);
    expect(Object.keys(match.rounds[0]?.map ?? {}).sort()).toEqual(['description', 'id', 'name']);
  });

  it('parses a bye match with a null away team', () => {
    const match = parseMatchResponse(byeMatchBody);
    expect(match.away_team).toBeNull();
    expect(match.rounds).toEqual([]);
    expect(match.status).toBe('confirmed');
  });

  it('parses the error bodies the Citadel API renders', () => {
    expect(parseErrorResponse('{"message":"Unauthorized API key","status":401}')).toEqual({
      message: 'Unauthorized API key',
      status: 401,
    });
    expect(parseErrorResponse('{"message":"Record not found","status":404}')).toEqual({
      message: 'Record not found',
      status: 404,
    });
  });

  it('keeps an unknown match status as a string and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drifted = withMatchGraph(
      `{"id":103,"forfeit_by":"no_forfeit","status":"teleported","round_name":"","round_number":3,"notice":"","created_at":"2026-11-21T09:00:00.000Z"}`,
      matchAssociations,
    );

    const first = parseMatchResponse(drifted);
    parseMatchResponse(drifted);
    expect(first.status).toBe('teleported');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('teleported');

    parseMatchResponse(drifted.replace('"status":"teleported"', '"status":"time_travelled"'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once for an unknown forfeit state too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drifted = withMatchGraph(
      `{"id":104,"forfeit_by":"sudden_death","status":"pending","round_name":"","round_number":4,"notice":"","created_at":"2026-11-21T09:30:00.000Z"}`,
      matchAssociations,
    );
    parseMatchResponse(drifted);
    parseMatchResponse(drifted);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('sudden_death');
    expect(parseMatchResponse(drifted).forfeit_by).toBe('sudden_death');
  });

  it('raises a typed CitadelParseError on a malformed body', () => {
    expect(() => parseLeagueResponse('<html>502 Bad Gateway</html>')).toThrow(CitadelParseError);
    expect(() => parseUserResponse('{"user":')).toThrow(CitadelParseError);
  });

  it('fails loudly when a fixture is stale and lost a required key', () => {
    const stale = userBody.replace(',"discord_id":123456789012345678', '');
    try {
      parseUserResponse(stale);
      throw new Error('expected CitadelParseError');
    } catch (error) {
      expect(error).toBeInstanceOf(CitadelParseError);
      expect((error as Error).message).toContain('discord_id');
    }
  });

  it('fails loudly when a serializer key is renamed', () => {
    const renamed = rosterBody.replace('"team_id":7', '"teamId":7');
    expect(() => parseRosterResponse(renamed)).toThrow(CitadelParseError);
    try {
      parseRosterResponse(renamed);
      throw new Error('expected CitadelParseError');
    } catch (error) {
      expect((error as Error).message).toContain('team_id');
    }
  });

  it('does not let a successful-looking mismatched body through', () => {
    // A team body is valid JSON and valid Citadel data, but it is not a league
    // response; the parser must reject it instead of returning a half object.
    expect(() => parseLeagueResponse(teamBody)).toThrow(CitadelParseError);
    expect(() => parseMatchResponse(userBody)).toThrow(CitadelParseError);
  });

  it('normalises every id to a string at the type level', () => {
    expectTypeOf<League['rosters'][number]['id']>().toEqualTypeOf<string>();
    expectTypeOf<League['matches'][number]['round_number']>().toEqualTypeOf<number>();
    expectTypeOf<User['discord_id']>().toEqualTypeOf<string | null>();
    expectTypeOf<Match['away_team']>().toEqualTypeOf<Match['home_team'] | null>();
    expectTypeOf<Match['status']>().toEqualTypeOf<string>();
    expectTypeOf<Match['rounds'][number]['map']>().toEqualTypeOf<CitadelMap | null>();
  });
});
