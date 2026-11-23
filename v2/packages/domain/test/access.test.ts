import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS,
  type AccessLevel,
  type AccessPurpose,
  accessSetFor,
  CATEGORY_ACCESS,
  type ChannelKind,
  levelAtLeast,
  MATCH_ACCESS,
  planAccess,
  type StaffRole,
  TEAM_ACCESS,
  type TeamRole,
} from '../src/index.js';

const SETS: readonly { kind: ChannelKind; purposes: readonly AccessPurpose[] }[] = [
  { kind: 'category', purposes: CATEGORY_ACCESS },
  { kind: 'team', purposes: TEAM_ACCESS },
  { kind: 'match', purposes: MATCH_ACCESS },
];

const teamRole = (id: string, name = `Team ${id}`): TeamRole => ({ id, name });

const staffRole = (id: string, purposes: string[]): StaffRole => ({
  id,
  name: `Staff ${id}`,
  purposes,
});

const purposeWithLevel = (
  purposes: readonly AccessPurpose[],
  level: AccessLevel,
): AccessPurpose => {
  const found = purposes.find((purpose) => purpose.level === level);
  if (!found) throw new Error(`no purpose with level ${level}`);
  return found;
};

describe('access sets', () => {
  it('exposes one purpose per level in every set', () => {
    for (const { kind, purposes } of SETS) {
      const levels = purposes.map((purpose) => purpose.level);
      expect(new Set(levels)).toEqual(new Set(ACCESS_LEVELS));
      expect(accessSetFor(kind)).toBe(purposes);
    }
  });

  it('gives every purpose a unique id inside its set', () => {
    for (const { purposes } of SETS) {
      const ids = purposes.map((purpose) => purpose.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('orders levels cumulatively', () => {
    expect(levelAtLeast('manage', 'read')).toBe(true);
    expect(levelAtLeast('send', 'read')).toBe(true);
    expect(levelAtLeast('send', 'manage')).toBe(false);
    expect(levelAtLeast('none', 'none')).toBe(true);
    expect(levelAtLeast('none', 'read')).toBe(false);
    expect(levelAtLeast('read', 'none')).toBe(true);
  });
});

describe('planAccess', () => {
  it('denies @everyone on every channel kind', () => {
    for (const { kind } of SETS) {
      const plan = planAccess({ kind });
      const everyone = plan.overwrites.find((overwrite) => overwrite.targetKind === 'everyone');

      expect(everyone).toBeDefined();
      expect(everyone?.targetId).toBe('everyone');
      expect(everyone?.targetName).toBe('@everyone');
      expect(everyone?.level).toBe('none');
    }
  });

  it('grants the team role view and send on every channel kind', () => {
    for (const { kind } of SETS) {
      const plan = planAccess({ kind, teamRoles: [teamRole('role-1')] });
      const team = plan.overwrites.find((overwrite) => overwrite.targetId === 'role-1');

      expect(team).toBeDefined();
      expect(team?.targetKind).toBe('role');
      expect(team?.level).toBe('send');
      expect(levelAtLeast(team?.level ?? 'none', 'read')).toBe(true);
      expect(levelAtLeast(team?.level ?? 'none', 'send')).toBe(true);
    }
  });

  it('grants every level of every set to a staff role holding that purpose', () => {
    for (const { kind, purposes } of SETS) {
      for (const level of ACCESS_LEVELS) {
        const purpose = purposeWithLevel(purposes, level);
        const plan = planAccess({ kind, staffRoles: [staffRole('staff-1', [purpose.id])] });
        const staff = plan.overwrites.find((overwrite) => overwrite.targetId === 'staff-1');

        expect(staff).toBeDefined();
        expect(staff?.level).toBe(level);
        expect(staff?.purposeIds).toEqual([purpose.id]);
        expect(plan.purposes).toBe(purposes);
      }
    }
  });

  it('uses the set that belongs to the channel kind', () => {
    const category = planAccess({
      kind: 'category',
      staffRoles: [staffRole('staff-1', ['moderator'])],
    });
    const match = planAccess({
      kind: 'match',
      staffRoles: [staffRole('staff-1', ['moderator'])],
    });

    expect(category.overwrites.find((o) => o.targetId === 'staff-1')?.level).toBe('send');
    // "moderator" is not a match purpose, so the same role gets nothing there.
    expect(match.overwrites.find((o) => o.targetId === 'staff-1')).toBeUndefined();
  });

  it('gives a staff role no overwrite when it holds no purpose of the set', () => {
    const plan = planAccess({
      kind: 'team',
      staffRoles: [staffRole('staff-1', ['referee'])],
    });

    expect(plan.overwrites.map((overwrite) => overwrite.targetId)).toEqual(['everyone']);
  });

  it('keeps the strongest purpose when a staff role holds several', () => {
    const plan = planAccess({
      kind: 'match',
      staffRoles: [staffRole('staff-1', ['spectator', 'referee', 'league-admin'])],
    });
    const staff = plan.overwrites.find((overwrite) => overwrite.targetId === 'staff-1');

    expect(staff?.level).toBe('manage');
    expect(staff?.purposeIds).toEqual(['spectator', 'referee', 'league-admin']);
  });

  it('merges a role that is both a team role and a staff role into one overwrite', () => {
    const plan = planAccess({
      kind: 'match',
      teamRoles: [teamRole('role-1', 'Team One')],
      staffRoles: [staffRole('role-1', ['referee'])],
    });
    const merged = plan.overwrites.filter((overwrite) => overwrite.targetId === 'role-1');

    expect(merged).toHaveLength(1);
    expect(merged[0]?.level).toBe('send');
    expect(merged[0]?.targetName).toBe('Team One');
    expect(merged[0]?.purposeIds).toEqual(['referee']);
  });

  it('grants manage when a staff role also acts as a team role', () => {
    const plan = planAccess({
      kind: 'category',
      teamRoles: [teamRole('role-1', 'Team One')],
      staffRoles: [staffRole('role-1', ['league-admin'])],
    });
    const merged = plan.overwrites.find((overwrite) => overwrite.targetId === 'role-1');

    expect(merged?.level).toBe('manage');
  });

  it('grants both team roles of a match channel view and send', () => {
    const plan = planAccess({
      kind: 'match',
      teamRoles: [teamRole('role-home', 'Home'), teamRole('role-away', 'Away')],
    });

    expect(plan.overwrites.map((overwrite) => overwrite.targetId)).toEqual([
      'everyone',
      'role-home',
      'role-away',
    ]);
    expect(
      plan.overwrites
        .filter((overwrite) => overwrite.targetKind === 'role')
        .every((overwrite) => overwrite.level === 'send'),
    ).toBe(true);
  });

  it('keeps @everyone first and never emits two overwrites for one target', () => {
    const plan = planAccess({
      kind: 'team',
      teamRoles: [teamRole('role-1'), teamRole('role-2')],
      staffRoles: [staffRole('role-2', ['captain']), staffRole('staff-1', ['league-admin'])],
    });

    expect(plan.overwrites[0]?.targetId).toBe('everyone');
    expect(new Set(plan.overwrites.map((o) => o.targetId)).size).toBe(plan.overwrites.length);
  });

  it('denies a staff role whose only matching purpose grants nothing', () => {
    const plan = planAccess({
      kind: 'match',
      staffRoles: [staffRole('staff-1', ['captain'])],
    });
    const staff = plan.overwrites.find((overwrite) => overwrite.targetId === 'staff-1');

    expect(staff).toBeDefined();
    expect(staff?.level).toBe('none');
  });
});
