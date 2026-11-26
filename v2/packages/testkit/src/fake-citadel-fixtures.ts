/**
 * Recorded-shaped Citadel bodies for the tournament integration tests.
 *
 * One small league (two divisions of two teams, three matches including a
 * bye) served by {@link createFakeCitadel}. The bodies are built as raw
 * JSON strings so the fake serves them byte for byte: Citadel sends
 * snowflakes as JSON numbers and re-serialising would round them.
 *
 * `rosterNames` renames one roster, which is how a plan drift is produced:
 * the live plan then hashes differently from a preview built before the
 * rename.
 */

/** The Citadel league the fixture bodies describe. */
export const CITADEL_LEAGUE_ID = 9100;

/** A player of a Citadel team. */
function player(
  id: number,
  name: string,
  discordId: string | null,
  isCaptain = false,
): Record<string, unknown> {
  return {
    id,
    name,
    description: '',
    created_at: '2026-11-21T21:00:47.379Z',
    steam_32: 'STEAM_0:1:19867136',
    steam_64: '76561198000000001',
    steam_id3: 'U:1:39734273',
    discord_id: discordId,
    steam_64_str: '76561198000000001',
    profile_url: '/assets/profile.png',
    is_captain: isCaptain,
  };
}

interface RosterSpec {
  id: number;
  team_id: number;
  name: string;
  division: string;
}

interface TeamSpec {
  id: number;
  name: string;
  captainDiscordId: string | null;
}

const ROSTERS: RosterSpec[] = [
  { id: 9400, team_id: 9300, name: 'Alpha One', division: 'Premier' },
  { id: 9401, team_id: 9301, name: 'Alpha Two', division: 'Premier' },
  { id: 9402, team_id: 9302, name: 'Bravo One', division: 'Open' },
  { id: 9403, team_id: 9303, name: 'Bravo Two', division: 'Open' },
];

const TEAMS: TeamSpec[] = [
  { id: 9300, name: 'Alpha One', captainDiscordId: '100000000000000001' },
  { id: 9301, name: 'Alpha Two', captainDiscordId: '100000000000000002' },
  { id: 9302, name: 'Bravo One', captainDiscordId: '100000000000000003' },
  { id: 9303, name: 'Bravo Two', captainDiscordId: null },
];

const MATCHES = [
  { id: 9500, home: 9400, away: 9401 },
  { id: 9501, home: 9402, away: 9403 },
  { id: 9502, home: 9402, away: null },
];

function rosterBody(roster: RosterSpec): Record<string, unknown> {
  return {
    id: roster.id,
    team_id: roster.team_id,
    name: roster.name,
    description: '',
    disbanded: false,
    division: roster.division,
  };
}

/** A roster as it is embedded in a match: the attributes plus its players. */
function matchRosterBody(roster: RosterSpec): Record<string, unknown> {
  return {
    ...rosterBody(roster),
    players: [
      player(9200 + roster.team_id - 9300, `Captain ${roster.name}`, '100000000000000001'),
      player(9600 + roster.team_id - 9300, `Player ${roster.name}`, null),
    ],
  };
}

function matchBody(
  id: number,
  home: RosterSpec | null,
  away: RosterSpec | null,
): Record<string, unknown> {
  return {
    id,
    forfeit_by: 'no_forfeit',
    status: 'confirmed',
    round_name: 'Round 1',
    round_number: 1,
    notice: '',
    created_at: '2026-11-21T21:00:53.489Z',
    league: { id: CITADEL_LEAGUE_ID, name: 'Drawbridge Test League', description: '' },
    home_team: home === null ? null : matchRosterBody(home),
    away_team: away === null ? null : matchRosterBody(away),
    rounds: [],
  };
}

/**
 * The Citadel bodies the fake serves. `rosterNames` overrides the name of
 * one roster, which is how the drift check is exercised.
 */
export function tournamentFixtures(
  rosterNames: Record<number, string> = {},
): Record<string, string> {
  const rosters = ROSTERS.map((roster) => ({
    ...rosterBody(roster),
    name: rosterNames[roster.id] ?? roster.name,
  }));

  const league = {
    league: {
      id: CITADEL_LEAGUE_ID,
      name: 'Drawbridge Test League',
      description: 'League used by the Drawbridge integration tests.',
      rosters,
      matches: MATCHES.map((match) => ({
        id: match.id,
        forfeit_by: 'no_forfeit',
        status: 'confirmed',
        round_name: 'Round 1',
        round_number: 1,
        notice: '',
        created_at: '2026-11-21T21:00:53.489Z',
      })),
    },
  };

  const bodies: Record<string, string> = {
    [`leagues/${CITADEL_LEAGUE_ID}`]: JSON.stringify(league),
  };

  for (const team of TEAMS) {
    bodies[`teams/${team.id}`] = JSON.stringify({
      team: {
        id: team.id,
        name: team.name,
        description: '',
        avatar_url: '/assets/team.png',
        avatar_thumb_url: '/assets/team-thumb.png',
        avatar_icon_url: '/assets/team-icon.png',
        players: [
          player(9200 + team.id - 9300, `Captain ${team.name}`, team.captainDiscordId, true),
          player(9600 + team.id - 9300, `Player ${team.name}`, null),
        ],
        rosters: ROSTERS.filter((roster) => roster.team_id === team.id).map(rosterBody),
      },
    });
  }

  for (const match of MATCHES) {
    const home = ROSTERS.find((roster) => roster.id === match.home) ?? null;
    const away =
      match.away === null ? null : (ROSTERS.find((roster) => roster.id === match.away) ?? null);
    bodies[`matches/${match.id}`] = JSON.stringify({ match: matchBody(match.id, home, away) });
  }

  return bodies;
}
