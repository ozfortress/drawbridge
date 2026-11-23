import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTournamentPlan,
  canonicalJson,
  type LeagueSnapshot,
  type SetOverwritesStep,
  type TournamentPlan,
  type WelcomeMessageStep,
} from '../src/index.js';
import { fixtureSnapshot } from './fixtures/snapshot.js';

const OPTIONS = { leagueShortcode: 'OZL' } as const;

function build(snapshot: LeagueSnapshot = fixtureSnapshot()): TournamentPlan {
  return buildTournamentPlan(snapshot, OPTIONS);
}

/** Rebuilds the value with the keys of every object in reverse order. */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      shuffled[key] = shuffleKeys(source[key]);
    }
    return shuffled;
  }
  return value;
}

/** A league with one division that holds more channels than a category may. */
function oversizedDivision(): LeagueSnapshot {
  const rosters = [];
  const teams = [];
  for (let index = 0; index < 51; index += 1) {
    rosters.push({
      id: `roster-${index}`,
      team_id: `team-${index}`,
      name: `Team ${index}`,
      division: 'Division Big',
    });
    teams.push({ id: `team-${index}`, name: `Team ${index}`, players: [] });
  }
  return { id: 'league-big', name: 'Big League', rosters, teams, matches: [] };
}

describe('buildTournamentPlan', () => {
  it('produces the same plan and the same hash on two runs', () => {
    const first = build();
    const second = build();

    expect(first).toEqual(second);
    expect(first.planHash).toBe(second.planHash);
    expect(first.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash when the snapshot keys are shuffled', () => {
    const snapshot = fixtureSnapshot();
    const shuffled = shuffleKeys(snapshot) as LeagueSnapshot;

    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(snapshot));
    expect(build(shuffled).planHash).toBe(build(snapshot).planHash);
  });

  it('matches the committed golden file exactly', () => {
    const golden = readFileSync(new URL('./golden/tournament-plan.json', import.meta.url), 'utf8');
    const plan = build();
    const recorded = JSON.parse(golden) as TournamentPlan;

    // The file is compared in canonical form: the repository formatter decides
    // its whitespace, the builder decides its content.
    expect(canonicalJson(recorded)).toBe(canonicalJson(plan));
    expect(recorded).toEqual(plan);
    expect(recorded.planHash).toBe(plan.planHash);
  });

  it('changes the hash when one Citadel field changes', () => {
    const snapshot = fixtureSnapshot();
    const mutated: LeagueSnapshot = {
      ...snapshot,
      rosters: snapshot.rosters.map((roster) =>
        roster.id === 'roster-a1' ? { ...roster, name: 'Alpha One Prime' } : roster,
      ),
    };

    expect(build(mutated).planHash).not.toBe(build(snapshot).planHash);
  });

  it('adds a warning and changes the hash when a roster is deleted', () => {
    const snapshot = fixtureSnapshot();
    const mutated: LeagueSnapshot = {
      ...snapshot,
      rosters: snapshot.rosters.filter((roster) => roster.id !== 'roster-b2'),
    };

    const plan = build(mutated);

    expect(plan.planHash).not.toBe(build(snapshot).planHash);
    expect(plan.warnings.some((warning) => warning.code === 'missing-roster')).toBe(true);
    expect(
      plan.divisions
        .flatMap((division) => division.entries)
        .some((entry) => entry.citadelRosterId === 'roster-b2'),
    ).toBe(false);
  });

  it('keeps every roster of the snapshot as an entry', () => {
    const snapshot = fixtureSnapshot();
    const plan = build(snapshot);

    expect(
      plan.divisions
        .flatMap((division) => division.entries)
        .map((entry) => entry.citadelRosterId)
        .sort(),
    ).toEqual(snapshot.rosters.map((roster) => roster.id).sort());
  });

  it('sorts divisions, entries and steps canonically', () => {
    const plan = build();

    expect(plan.divisions.map((division) => division.name)).toEqual(['Division A', 'Division B']);
    expect(plan.divisions[1]?.entries.map((entry) => entry.citadelRosterId)).toEqual([
      'roster-b1',
      'roster-b2',
      'roster-b3',
    ]);
    expect(plan.steps.map((step) => step.order)).toEqual(
      plan.steps.map((_step, index) => index + 1),
    );
  });

  it('creates the category, the roles, the channels, the overwrites, the welcome messages and the database rows', () => {
    const plan = build();
    const kinds = new Set(plan.steps.map((step) => step.kind));

    expect(kinds).toEqual(
      new Set([
        'create-category',
        'create-role',
        'create-channel',
        'set-overwrites',
        'send-welcome-message',
        'insert-db-row',
      ]),
    );
    expect(plan.counts).toEqual({
      divisions: 2,
      entries: 6,
      categories: 2,
      roles: 8,
      channels: 6,
      steps: plan.steps.length,
    });
    expect(
      plan.steps.filter((step) => step.kind === 'insert-db-row').map((step) => step.table),
    ).toEqual([
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'guild_roles',
      'managed_channels',
      'managed_channels',
      'managed_channels',
      'managed_channels',
      'managed_channels',
      'managed_channels',
      'managed_channels',
      'managed_channels',
    ]);
  });

  it('gives the team role access to the team channel and the staff roles their purposes', () => {
    const plan = buildTournamentPlan(fixtureSnapshot(), {
      leagueShortcode: 'OZL',
      staffRoles: [
        { id: 'role-admin', name: 'League Admin', purposes: ['league-admin'] },
        { id: 'role-spectator', name: 'Spectator', purposes: ['spectator'] },
      ],
    });

    const teamOverwrites = plan.steps.find(
      (step): step is SetOverwritesStep =>
        step.kind === 'set-overwrites' && step.channelKind === 'team',
    );
    expect(teamOverwrites?.overwrites.map((overwrite) => overwrite.targetId)).toEqual([
      'everyone',
      'role:entry:roster-a1',
      'role-admin',
      'role-spectator',
    ]);
    expect(
      teamOverwrites?.overwrites.find((overwrite) => overwrite.targetId === 'role-admin')?.level,
    ).toBe('manage');
    expect(
      teamOverwrites?.overwrites.find((overwrite) => overwrite.targetId === 'role-spectator')
        ?.level,
    ).toBe('read');
  });

  it('reports the captains of the league', () => {
    const plan = build();

    expect(plan.captainReport.total).toBe(6);
    expect(plan.captainReport.willAssign).toBe(5);
    expect(plan.captainReport.notLinked).toBe(1);
    expect(
      plan.captainReport.captains.find((captain) => captain.status === 'not-linked'),
    ).toMatchObject({ citadelUserId: 'user-a2', discordId: null });
  });

  it('warns about the snapshot it was built from', () => {
    const plan = build();
    const codes = plan.warnings.map((warning) => warning.code);

    expect(codes).toContain('missing-roster');
    expect(codes).toContain('missing-team');
    expect(codes).toContain('name-truncated');
    expect(codes).toContain('duplicate-name');
    expect(plan.warnings.some((warning) => warning.subject === 'team-ghost')).toBe(true);
  });

  it('splits a division that does not fit into one category', () => {
    const plan = build(oversizedDivision());

    expect(plan.capacity.status).toBe('split');
    expect(plan.warnings.map((warning) => warning.code)).toContain('capacity-split');
    expect(plan.warnings.map((warning) => warning.code)).toContain('capacity-refusal');
  });

  it('uses the welcome template and the name budget of the caller', () => {
    const plan = buildTournamentPlan(fixtureSnapshot(), {
      leagueShortcode: 'OZL',
      teamNameBudget: 6,
      welcomeTemplate: 'Hi {division}!',
    });

    const welcome = plan.steps.find(
      (step): step is WelcomeMessageStep => step.kind === 'send-welcome-message',
    );
    expect(welcome?.content).toBe('Hi Division A!');

    const entry = plan.divisions[0]?.entries.find((one) => one.citadelRosterId === 'roster-a1');
    expect(entry?.roleName).toBe('Alpha-roster-a1 (OZL)');
  });

  it('is frozen', () => {
    const plan = build();

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.divisions)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
  });
});
