import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveLeague,
  type LeagueSnapshot,
  type LeagueSnapshotPlayer,
  type LeagueSnapshotRoster,
  type LeagueSnapshotTeam,
} from '../src/index.js';

const player = (
  id: string,
  name: string,
  isCaptain: boolean,
  discordId: string | null = null,
): LeagueSnapshotPlayer => ({
  id,
  name,
  is_captain: isCaptain,
  discord_id: discordId,
});

const team = (
  id: string,
  name: string,
  players: LeagueSnapshotPlayer[] = [],
): LeagueSnapshotTeam => ({
  id,
  name,
  players,
});

const roster = (
  id: string,
  teamId: string,
  name: string,
  division: string,
): LeagueSnapshotRoster => ({
  id,
  team_id: teamId,
  name,
  division,
});

const snapshot = (
  rosters: LeagueSnapshotRoster[],
  teams: LeagueSnapshotTeam[] = [],
  matches: LeagueSnapshot['matches'] = [],
): LeagueSnapshot => ({
  id: 'league-1',
  name: 'Ozfortress League',
  rosters,
  teams,
  matches,
});

describe('deriveLeague', () => {
  it('produces one entry per roster across two divisions', () => {
    const rosters: LeagueSnapshotRoster[] = [];
    for (let i = 0; i < 8; i += 1) {
      rosters.push(roster(`roster-a-${i}`, `team-a-${i}`, `Alpha ${i}`, 'Division A'));
      rosters.push(roster(`roster-b-${i}`, `team-b-${i}`, `Bravo ${i}`, 'Division B'));
    }

    const league = deriveLeague(snapshot(rosters));

    expect(league.divisions).toHaveLength(2);
    expect(league.divisions[0]?.name).toBe('Division A');
    expect(league.divisions[0]?.entries).toHaveLength(8);
    expect(league.divisions[1]?.name).toBe('Division B');
    expect(league.divisions[1]?.entries).toHaveLength(8);
    expect(league.divisions.flatMap((division) => division.entries)).toHaveLength(16);
    expect(league.divisions[0]?.entries[0]).toEqual({
      citadelRosterId: 'roster-a-0',
      citadelTeamId: 'team-a-0',
      name: 'Alpha 0',
      division: 'Division A',
    });
  });

  it('keeps only real captains and tolerates a missing discord id', () => {
    const league = deriveLeague(
      snapshot(
        [roster('roster-1', 'team-1', 'Team One', 'Division A')],
        [
          team('team-1', 'Team One', [
            player('user-1', 'Captain', true, '111'),
            player('user-2', 'Regular', false, '222'),
            player('user-3', 'Other Captain', true, null),
          ]),
        ],
      ),
    );

    expect(league.captains).toEqual([
      {
        citadelTeamId: 'team-1',
        citadelUserId: 'user-1',
        name: 'Captain',
        discordId: '111',
      },
      {
        citadelTeamId: 'team-1',
        citadelUserId: 'user-3',
        name: 'Other Captain',
        discordId: null,
      },
    ]);
  });

  it('does not throw for an unknown division or a team without players', () => {
    const league = deriveLeague(
      snapshot(
        [roster('roster-1', 'team-1', 'Team One', 'Division Unknown')],
        [team('team-1', 'Team One')],
      ),
    );

    expect(league.divisions).toHaveLength(1);
    expect(league.divisions[0]?.name).toBe('Division Unknown');
    expect(league.captains).toEqual([]);
  });

  it('preserves duplicate roster ids', () => {
    const league = deriveLeague(
      snapshot([
        roster('roster-dup', 'team-1', 'First', 'Division A'),
        roster('roster-dup', 'team-2', 'Second', 'Division A'),
      ]),
    );

    expect(league.divisions[0]?.entries).toHaveLength(2);
    expect(league.divisions[0]?.entries.map((entry) => entry.citadelRosterId)).toEqual([
      'roster-dup',
      'roster-dup',
    ]);
    expect(league.divisions[0]?.entries.map((entry) => entry.citadelTeamId)).toEqual([
      'team-1',
      'team-2',
    ]);
  });

  it('records byes for matches without an away team', () => {
    const league = deriveLeague(
      snapshot(
        [roster('roster-1', 'team-1', 'Team One', 'Division A')],
        [],
        [
          { id: 'match-1', home: 'team-1', away: null },
          { id: 'match-2', home: 'team-1', away: 'team-2' },
        ],
      ),
    );

    expect(league.byes).toEqual([
      { matchId: 'match-1', citadelTeamId: 'team-1', division: 'Division A' },
    ]);
  });

  it('ignores a match where both teams are missing', () => {
    const league = deriveLeague(snapshot([], [], [{ id: 'match-1', home: null, away: null }]));

    expect(league.byes).toEqual([]);
  });
});

describe('domain package boundary', () => {
  it('keeps src free of imports from outside the package', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(new URL(file, srcDir), 'utf8');

      // Every module specifier must point inside the package.
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        expect(match[1], file).toMatch(/^\.\//);
      }
      for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)) {
        expect(match[1], file).toMatch(/^\.\//);
      }
      // No side effect import of an external module.
      expect(source, file).not.toMatch(/^\s*import\s+['"]/m);
    }
  });

  it('keeps the hash implementation free of module specifiers', () => {
    const source = readFileSync(new URL('sha256.ts', new URL('../src/', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
  });
});
