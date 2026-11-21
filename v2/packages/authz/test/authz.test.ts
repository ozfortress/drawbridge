import { describe, expect, it } from 'vitest';
import {
  type Capability,
  canCreateLeague,
  canGrantLeagueRole,
  canManageLeagueRole,
  canManageTier,
  DEFAULT_LEAGUE_ROLES,
  GLOBAL_TIERS,
  type GlobalTier,
  mergeCapabilities,
  tierCapabilities,
} from '../src/index.js';

describe('global tiers', () => {
  it('orders root above admin above helper above user above guest', () => {
    expect(canManageTier('root', 'root')).toBe(true);
    expect(canManageTier('root', 'admin')).toBe(true);
    expect(canManageTier('admin', 'root')).toBe(false);
    expect(canManageTier('admin', 'admin')).toBe(false);
    expect(canManageTier('admin', 'helper')).toBe(true);
    expect(canManageTier('admin', 'user')).toBe(true);
    expect(canManageTier('admin', 'guest')).toBe(true);
    for (const tier of ['helper', 'user', 'guest'] as GlobalTier[]) {
      expect(canManageTier(tier, 'guest')).toBe(false);
    }
  });

  it('gives root and admin every capability', () => {
    for (const tier of ['root', 'admin'] as GlobalTier[]) {
      const access = mergeCapabilities(tier, []);
      expect(access.size).toBeGreaterThan(15);
      expect(access.has('tournament.destructive')).toBe(true);
      expect(access.has('citadel.keys.manage')).toBe(true);
    }
  });

  it('gives helpers league-wide capabilities except destructive ones', () => {
    const access = mergeCapabilities('helper', []);
    expect(access.has('match.manage')).toBe(true);
    expect(access.has('logs.read')).toBe(true);
    expect(access.has('tournament.destructive')).toBe(false);
    expect(access.has('logs.redact')).toBe(false);
  });

  it('gives users and guests only what their league role provides', () => {
    for (const tier of ['user', 'guest'] as GlobalTier[]) {
      expect(tierCapabilities(tier)).toEqual([]);
      const access = mergeCapabilities(tier, ['league.read']);
      expect(access.has('league.read')).toBe(true);
      expect(access.has('match.manage')).toBe(false);
    }
  });

  it('lets every tier above guest create leagues', () => {
    expect(canCreateLeague('root')).toBe(true);
    expect(canCreateLeague('admin')).toBe(true);
    expect(canCreateLeague('helper')).toBe(true);
    expect(canCreateLeague('user')).toBe(true);
    expect(canCreateLeague('guest')).toBe(false);
  });

  it('never lets a league role escalate beyond the catalogue', () => {
    const access = mergeCapabilities('guest', ['league.read', 'faq.edit']);
    expect([...access].sort()).toEqual(['faq.edit', 'league.read']);
  });
});

describe('league hierarchy', () => {
  const director = {
    rank: 10,
    name: 'Director',
    capabilities: ['league.read', 'logs.read'] as Capability[],
  };
  const admin = { rank: 20, name: 'Admin', capabilities: ['league.read'] as Capability[] };
  const trial = { rank: 30, name: 'Trial', capabilities: ['league.read'] as Capability[] };
  const directorCaps = new Set<Capability>(['league.read', 'logs.read']);

  it('allows editing strictly lower-ranked roles', () => {
    expect(canManageLeagueRole(director.rank, directorCaps, admin)).toBe(true);
    expect(canManageLeagueRole(director.rank, directorCaps, trial)).toBe(true);
  });

  it('forbids editing a role at or above your own rank', () => {
    expect(canManageLeagueRole(admin.rank, new Set(['league.read']), director)).toBe(false);
    expect(canManageLeagueRole(admin.rank, new Set(['league.read']), admin)).toBe(false);
  });

  it('forbids granting capabilities you do not hold', () => {
    const elevatedTrial = {
      rank: 30,
      name: 'Trial',
      capabilities: ['league.read', 'match.manage'] as Capability[],
    };
    expect(canManageLeagueRole(10, new Set(['league.read']), elevatedTrial)).toBe(false);
    expect(canManageLeagueRole(10, directorCaps, elevatedTrial)).toBe(false);
    expect(canManageLeagueRole(10, new Set(['league.read', 'match.manage']), elevatedTrial)).toBe(
      true,
    );
  });

  it('decides who may assign a league role', () => {
    expect(canGrantLeagueRole('root', null)).toBe(true);
    expect(canGrantLeagueRole('admin', null)).toBe(true);
    expect(canGrantLeagueRole('helper', 10)).toBe(true);
    expect(canGrantLeagueRole('user', 30)).toBe(true);
    expect(canGrantLeagueRole('guest', null)).toBe(false);
  });
});

describe('default league roles', () => {
  it('starts with a Director that holds every capability', () => {
    const director = DEFAULT_LEAGUE_ROLES[0]!;
    expect(director.name).toBe('Director');
    expect(director.capabilities.length).toBeGreaterThan(15);
    expect(director.capabilities).toContain('tournament.destructive');
  });

  it('keeps ranks unique and ascending', () => {
    const ranks = DEFAULT_LEAGUE_ROLES.map((role) => role.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('does not grant destructive operations or keys to the Admin role', () => {
    const admin = DEFAULT_LEAGUE_ROLES.find((role) => role.name === 'Admin')!;
    expect(admin.capabilities).not.toContain('tournament.destructive');
    expect(admin.capabilities).not.toContain('citadel.keys.manage');
    expect(admin.capabilities).not.toContain('logs.redact');
  });

  it('covers every tier in the matrix', () => {
    expect(GLOBAL_TIERS).toEqual(['root', 'admin', 'helper', 'user', 'guest']);
  });
});
