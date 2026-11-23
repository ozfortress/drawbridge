/**
 * Zod schemas for the Citadel v1 API wire format.
 *
 * Shapes follow the Citadel serializers under
 * `app/serializers/api/v1/**` (ActiveModelSerializers with the `:json`
 * adapter, so every body is root-wrapped: `{ "league": ... }`), verified
 * against real captures from the running dev instance. Two quirks of the
 * real wire format are encoded here:
 *
 * - `Match.away_team` is `null` for byes.
 * - Associations embedded inside another resource (a match's `league` and
 *   `home_team`, a round's `map`, a roster's `players`) are the
 *   corresponding serializer's attribute set with no further nesting: the
 *   include tree in each controller cuts them off after one level. Note
 *   that `belongs_to :league` / `belongs_to :map` resolve to the
 *   `API::V1` serializers through ActiveModelSerializers' namespace
 *   lookup; a bare `SerializableResource.new` outside the controller falls
 *   back to a raw column dump instead, so these shapes follow the real
 *   endpoint captures, not that fallback.
 *
 * Forward compatibility: Citadel may add enum values this package does not
 * know yet. Unknown enum strings are kept as strings and warn once per
 * process instead of failing the parse. Schemas strip unknown keys, so new
 * columns do not break parsing, but a renamed or missing key does.
 *
 * All IDs are normalised to strings: Citadel sends small ids as JSON numbers
 * and snowflake-sized ids as numbers too large for `number`, so every id
 * field accepts both forms.
 */
import { z } from 'zod';
import { CitadelParseError, parseCitadelJson } from './json.js';

/** Match statuses defined by the Citadel `League::Match` enum today. */
export const MATCH_STATUSES = [
  'pending',
  'submitted_by_home_team',
  'submitted_by_away_team',
  'confirmed',
] as const;

/** Forfeit states defined by the Citadel `League::Match` enum today. */
export const FORFEIT_BYS = [
  'no_forfeit',
  'home_team_forfeit',
  'away_team_forfeit',
  'mutual_forfeit',
  'technical_forfeit',
] as const;

const warned = new Set<string>();

function warnOnce(label: string, value: string): void {
  const key = `${label}:${value}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`citadel: unknown ${label} "${value}"; keeping it as-is`);
}

/**
 * An enum Citadel may extend after this package ships: accepts any string,
 * keeps it as-is, and warns once per process for values not in `known`.
 */
const driftingEnum = (known: readonly string[], label: string) =>
  z.string().superRefine((value) => {
    if (!known.includes(value)) warnOnce(label, value);
  });

/** A Citadel ID: a JSON number when small, an exact string when huge. */
const citadelId = () => z.union([z.number().int(), z.string()]).transform((value) => String(value));

/** A Citadel ID column that is absent for some rows (e.g. `discord_id`). */
const nullableCitadelId = () =>
  z
    .union([z.number().int(), z.string(), z.null()])
    .transform((value) => (value === null ? null : String(value)));

/** The error body `API::V1::APIController#render_error` produces. */
export const ErrorBodySchema = z.object({
  message: z.string(),
  status: z.number().int().min(400).max(599),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** `API::V1::MapSerializer` / raw `Map` column dump inside a round. */
export const MapSchema = z.object({
  id: citadelId(),
  name: z.string(),
  description: z.string(),
});
/** Named `CitadelMap` because a bare `Map` would shadow the global. */
export type CitadelMap = z.infer<typeof MapSchema>;

/** User attributes shared by every context a user is serialised in. */
const userAttributesSchema = z.object({
  id: citadelId(),
  name: z.string(),
  description: z.string(),
  created_at: z.string(),
  steam_32: z.string(),
  steam_64: citadelId(),
  steam_id3: z.string(),
  discord_id: nullableCitadelId(),
  steam_64_str: z.string(),
  profile_url: z.string(),
});

/** Team attributes as embedded under `User.teams` (no associations inside). */
const teamAttributesSchema = z.object({
  id: citadelId(),
  name: z.string(),
  description: z.string(),
  avatar_url: z.string(),
  avatar_thumb_url: z.string(),
  avatar_icon_url: z.string(),
});

/** Roster attributes as embedded under leagues, teams and users. */
const rosterAttributesSchema = z.object({
  id: citadelId(),
  team_id: citadelId(),
  name: z.string(),
  description: z.string(),
  disbanded: z.boolean(),
  division: z.string(),
});

/** Match attributes as embedded under leagues and rosters (no associations). */
const matchAttributesSchema = z.object({
  id: citadelId(),
  forfeit_by: driftingEnum(FORFEIT_BYS, 'match.forfeit_by'),
  status: driftingEnum(MATCH_STATUSES, 'match.status'),
  round_name: z.string(),
  round_number: z.number().int().min(0),
  notice: z.string(),
  created_at: z.string(),
});

/** A user as embedded in a roster: attributes only, no `is_captain`. */
const rosterPlayerSchema = userAttributesSchema;

/** A roster with its players, as embedded under `Match.home_team`. */
const rosterWithPlayersSchema = rosterAttributesSchema.extend({
  players: z.array(rosterPlayerSchema),
});

/** `API::V1::Leagues::Matches::RoundSerializer`. */
export const RoundSchema = z.object({
  home_team_score: z.number().int().min(0),
  away_team_score: z.number().int().min(0),
  map: MapSchema.nullable(),
});
export type Round = z.infer<typeof RoundSchema>;

/** League attributes as embedded under `Match.league` (no associations). */
const leagueAttributesSchema = z.object({
  id: citadelId(),
  name: z.string(),
  description: z.string(),
});
const LeagueRefSchema = leagueAttributesSchema;

/** `API::V1::Leagues::MatchSerializer` (GET `/matches/{id}`). */
export const MatchSchema = matchAttributesSchema.extend({
  league: LeagueRefSchema,
  home_team: rosterWithPlayersSchema,
  away_team: rosterWithPlayersSchema.nullable(),
  rounds: z.array(RoundSchema),
});
export type Match = z.infer<typeof MatchSchema>;

/** `API::V1::UserSerializer` (GET `/users/{id}` and its lookups). */
export const UserSchema = userAttributesSchema.extend({
  teams: z.array(teamAttributesSchema),
  rosters: z.array(rosterAttributesSchema),
});
export type User = z.infer<typeof UserSchema>;

/** A user inside `Team.players`, which adds `is_captain` (scope is a team). */
const teamPlayerSchema = userAttributesSchema.extend({
  is_captain: z.boolean(),
});

/** `API::V1::TeamSerializer` (GET `/teams/{id}`). */
export const TeamSchema = teamAttributesSchema.extend({
  players: z.array(teamPlayerSchema),
  rosters: z.array(rosterAttributesSchema),
});
export type Team = z.infer<typeof TeamSchema>;

/** `API::V1::Leagues::RosterSerializer` (GET `/rosters/{id}`). */
export const RosterSchema = rosterAttributesSchema.extend({
  players: z.array(rosterPlayerSchema),
  matches: z.array(matchAttributesSchema),
});
export type Roster = z.infer<typeof RosterSchema>;

/** `API::V1::LeagueSerializer` (GET `/leagues/{id}`). */
export const LeagueSchema = leagueAttributesSchema.extend({
  rosters: z.array(rosterAttributesSchema),
  matches: z.array(matchAttributesSchema),
});
export type League = z.infer<typeof LeagueSchema>;

/** Root-wrapped response bodies for each endpoint. */
export const LeagueResponseSchema = z.object({ league: LeagueSchema });
export const RosterResponseSchema = z.object({ roster: RosterSchema });
export const TeamResponseSchema = z.object({ team: TeamSchema });
export const UserResponseSchema = z.object({ user: UserSchema });
export const MatchResponseSchema = z.object({ match: MatchSchema });

function parseBody<S extends z.ZodType>(schema: S, text: string, label: string): z.output<S> {
  const value = parseCitadelJson(text);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  throw new CitadelParseError(`${label} violates the Citadel contract:\n${lines.join('\n')}`);
}

/** Parses and validates a GET `/leagues/{id}` body. */
export function parseLeagueResponse(text: string): League {
  return parseBody(LeagueResponseSchema, text, 'league response').league;
}

/** Parses and validates a GET `/rosters/{id}` body. */
export function parseRosterResponse(text: string): Roster {
  return parseBody(RosterResponseSchema, text, 'roster response').roster;
}

/** Parses and validates a GET `/teams/{id}` body. */
export function parseTeamResponse(text: string): Team {
  return parseBody(TeamResponseSchema, text, 'team response').team;
}

/** Parses and validates a GET `/users/{id}` body and its lookup variants. */
export function parseUserResponse(text: string): User {
  return parseBody(UserResponseSchema, text, 'user response').user;
}

/** Parses and validates a GET `/matches/{id}` body. */
export function parseMatchResponse(text: string): Match {
  return parseBody(MatchResponseSchema, text, 'match response').match;
}

/** Parses and validates an error body rendered by the Citadel API. */
export function parseErrorResponse(text: string): ErrorBody {
  return parseBody(ErrorBodySchema, text, 'error response');
}
