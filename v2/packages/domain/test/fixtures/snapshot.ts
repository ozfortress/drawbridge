import type { LeagueSnapshot } from '../../src/index.js';

/**
 * A small but complete league.
 *
 * The snapshot holds two divisions and six rosters. It carries every case the
 * plan builder has to survive: a captain without a Discord id, a team with two
 * captains, a team that is missing from the snapshot, a name that is longer
 * than the budget, two entries that trim to the same name, a match against a
 * team that has no roster and a match without an away team.
 */
export const FIXTURE_SNAPSHOT: LeagueSnapshot = {
  id: 'league-1',
  name: 'Ozfortress League',
  rosters: [
    { id: 'roster-a1', team_id: 'team-a1', name: 'Alpha One', division: 'Division A' },
    { id: 'roster-a2', team_id: 'team-a2', name: 'Alpha Two', division: 'Division A' },
    {
      id: 'roster-a3',
      team_id: 'team-a3',
      name: 'Alpha Three With A Very Long Name',
      division: 'Division A',
    },
    { id: 'roster-b1', team_id: 'team-b1', name: 'Bravo One', division: 'Division B' },
    { id: 'roster-b2', team_id: 'team-b2', name: 'Bravo Two', division: 'Division B' },
    { id: 'roster-b3', team_id: 'team-b3', name: 'Bravo Two', division: 'Division B' },
  ],
  teams: [
    {
      id: 'team-a1',
      name: 'Alpha One',
      players: [
        { id: 'user-a1', name: 'Ana', is_captain: true, discord_id: '100000000000000001' },
        { id: 'user-a9', name: 'Rin', is_captain: false, discord_id: '100000000000000009' },
      ],
    },
    {
      id: 'team-a2',
      name: 'Alpha Two',
      players: [{ id: 'user-a2', name: 'Ben', is_captain: true, discord_id: null }],
    },
    {
      id: 'team-a3',
      name: 'Alpha Three With A Very Long Name',
      players: [
        { id: 'user-a3', name: 'Cleo', is_captain: true, discord_id: '100000000000000003' },
      ],
    },
    {
      id: 'team-b1',
      name: 'Bravo One',
      players: [
        { id: 'user-b1', name: 'Dee', is_captain: true, discord_id: '100000000000000004' },
        { id: 'user-b2', name: 'Eve', is_captain: true, discord_id: '100000000000000005' },
      ],
    },
    {
      id: 'team-b3',
      name: 'Bravo Two',
      players: [{ id: 'user-b4', name: 'Gus', is_captain: true, discord_id: '100000000000000007' }],
    },
  ],
  matches: [
    { id: 'match-1', home: 'team-a1', away: 'team-a2' },
    { id: 'match-2', home: 'team-b1', away: 'team-b2' },
    { id: 'match-3', home: 'team-a3', away: 'team-ghost' },
    { id: 'match-4', home: 'team-b1', away: null },
  ],
};

/** A fresh copy of the fixture, safe to mutate inside a test. */
export function fixtureSnapshot(): LeagueSnapshot {
  return structuredClone(FIXTURE_SNAPSHOT);
}
