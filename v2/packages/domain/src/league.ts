/**
 * The league structure of a Citadel snapshot.
 *
 * The snapshot is the source of truth: every roster becomes one entry, even
 * when two rosters share an id, and every captain is a player flagged as such
 * on the team behind a roster. The derivation is pure - it tolerates unknown
 * divisions, teams without players and matches without an away team, and it
 * never throws.
 */

/** A player as listed on a Citadel team. */
export interface LeagueSnapshotPlayer {
  readonly id: string;
  readonly name: string;
  readonly is_captain: boolean;
  readonly discord_id: string | null;
}

/** A Citadel team together with the players on it. */
export interface LeagueSnapshotTeam {
  readonly id: string;
  readonly name: string;
  readonly players: readonly LeagueSnapshotPlayer[];
}

/** A Citadel roster: one team competing in one division. */
export interface LeagueSnapshotRoster {
  readonly id: string;
  readonly team_id: string;
  readonly name: string;
  readonly division: string;
}

/** A scheduled match. `home` and `away` are Citadel team ids; a bye has no `away`. */
export interface LeagueSnapshotMatch {
  readonly id: string;
  readonly home: string | null;
  readonly away: string | null;
}

/** Everything the derivation needs to know about one league. */
export interface LeagueSnapshot {
  readonly id: string;
  readonly name: string;
  readonly rosters: readonly LeagueSnapshotRoster[];
  readonly teams: readonly LeagueSnapshotTeam[];
  readonly matches: readonly LeagueSnapshotMatch[];
}

/** One competing roster inside a division. */
export interface Entry {
  readonly citadelRosterId: string;
  readonly citadelTeamId: string;
  readonly name: string;
  readonly division: string;
}

/** A division of the league with the rosters competing in it. */
export interface Division {
  readonly name: string;
  readonly entries: readonly Entry[];
}

/** A team captain, discovered from the players of that team. */
export interface Captain {
  readonly citadelTeamId: string;
  readonly citadelUserId: string;
  readonly name: string;
  readonly discordId: string | null;
}

/** A round in which one team has no opponent. */
export interface Bye {
  readonly matchId: string;
  readonly citadelTeamId: string;
  readonly division: string | null;
}

/** The derived league structure. */
export interface LeagueStructure {
  readonly divisions: readonly Division[];
  readonly captains: readonly Captain[];
  readonly byes: readonly Bye[];
}

/**
 * Derives the league structure from a snapshot.
 *
 * Divisions are grouped by the division each roster declares. Every roster
 * becomes one entry, duplicate roster ids included: the snapshot is the
 * source of truth and nothing is silently dropped. Captains come from the
 * players of the team behind each roster, and a match without an away team
 * is a bye. Unknown divisions and teams without players are tolerated and
 * never throw.
 */
export function deriveLeague(snapshot: LeagueSnapshot): LeagueStructure {
  const entries: Entry[] = [];
  const divisions = new Map<string, Entry[]>();
  const teamIds = new Set<string>();

  for (const roster of snapshot.rosters) {
    const entry: Entry = {
      citadelRosterId: roster.id,
      citadelTeamId: roster.team_id,
      name: roster.name,
      division: roster.division,
    };
    entries.push(entry);
    const bucket = divisions.get(roster.division);
    if (bucket) {
      bucket.push(entry);
    } else {
      divisions.set(roster.division, [entry]);
    }
    teamIds.add(roster.team_id);
  }

  const teamsById = new Map<string, LeagueSnapshotTeam>();
  for (const team of snapshot.teams) {
    teamsById.set(team.id, team);
  }

  const captains: Captain[] = [];
  for (const teamId of teamIds) {
    const team = teamsById.get(teamId);
    if (!team) continue;
    for (const player of team.players) {
      if (!player.is_captain) continue;
      captains.push({
        citadelTeamId: team.id,
        citadelUserId: player.id,
        name: player.name,
        discordId: player.discord_id ?? null,
      });
    }
  }

  const divisionByTeam = new Map<string, string>();
  for (const entry of entries) {
    if (!divisionByTeam.has(entry.citadelTeamId)) {
      divisionByTeam.set(entry.citadelTeamId, entry.division);
    }
  }

  const byes: Bye[] = [];
  for (const match of snapshot.matches) {
    if (match.away !== null && match.away !== undefined) continue;
    if (match.home === null || match.home === undefined) continue;
    byes.push({
      matchId: match.id,
      citadelTeamId: match.home,
      division: divisionByTeam.get(match.home) ?? null,
    });
  }

  return {
    divisions: [...divisions].map(([name, divisionEntries]) => ({
      name,
      entries: divisionEntries,
    })),
    captains,
    byes,
  };
}
