import { describe, expect, it } from 'vitest';
import {
  type CapacityCategory,
  type CapacityRequest,
  type CapacityUsage,
  flagCapacityHeadroom,
  MAX_CATEGORIES,
  MAX_CHANNELS,
  MAX_CHANNELS_PER_CATEGORY,
  MAX_ROLES,
  planCapacity,
} from '../src/index.js';

const categories = (...counts: number[]): CapacityCategory[] =>
  counts.map((channelCount, index) => ({
    name: `Division ${String.fromCharCode(65 + index)}`,
    channelCount,
  }));

describe('capacity limits', () => {
  it('exposes the guild caps', () => {
    expect(MAX_ROLES).toBe(250);
    expect(MAX_CHANNELS).toBe(500);
    expect(MAX_CATEGORIES).toBe(50);
    expect(MAX_CHANNELS_PER_CATEGORY).toBe(50);
  });
});

describe('planCapacity', () => {
  it('fits two divisions of eight without a warning', () => {
    const plan = planCapacity({
      roleCount: 16,
      categories: [
        { name: 'Division A', channelCount: 8 },
        { name: 'Division B', channelCount: 8 },
      ],
    });

    expect(plan.status).toBe('fit');
    expect(plan.refusals).toEqual([]);
    expect(plan.splits).toEqual([]);
    expect(plan.channelCount).toBe(16);
    expect(plan.categoryCount).toBe(2);
    expect(plan.categories).toEqual([
      { name: 'Division A', channelCount: 8 },
      { name: 'Division B', channelCount: 8 },
    ]);
  });

  it('splits a division of 51 teams and refuses the unsplit arrangement', () => {
    const plan = planCapacity({
      roleCount: 51,
      categories: [{ name: 'Division X', channelCount: 51 }],
    });

    expect(plan.status).toBe('split');
    expect(plan.splits).toHaveLength(1);
    expect(plan.splits[0]?.name).toBe('Division X');
    expect(plan.splits[0]?.parts).toEqual([
      { name: 'Division X (1)', channelCount: 50 },
      { name: 'Division X (2)', channelCount: 1 },
    ]);

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.scope).toBe('category-channels');
    expect(plan.refusals[0]?.limit).toBe(50);
    expect(plan.refusals[0]?.actual).toBe(51);
    expect(plan.refusals[0]?.message).toContain('Division X');

    expect(plan.categories).toEqual([
      { name: 'Division X (1)', channelCount: 50 },
      { name: 'Division X (2)', channelCount: 1 },
    ]);
    expect(plan.categoryCount).toBe(2);
  });

  it('splits a division of 120 channels into three parts', () => {
    const plan = planCapacity({
      roleCount: 120,
      categories: [{ name: 'Division Y', channelCount: 120 }],
    });

    expect(plan.status).toBe('split');
    expect(plan.splits[0]?.parts.map((part) => part.name)).toEqual([
      'Division Y (1)',
      'Division Y (2)',
      'Division Y (3)',
    ]);
    expect(plan.splits[0]?.parts.map((part) => part.channelCount)).toEqual([50, 50, 20]);
  });

  it('allows the boundary values 250 roles, 500 channels and 50 categories', () => {
    const plan = planCapacity({
      roleCount: MAX_ROLES,
      categories: Array.from({ length: MAX_CATEGORIES }, (_, index) => ({
        name: `Division ${index}`,
        channelCount: 10,
      })),
    });

    expect(plan.roleCount).toBe(250);
    expect(plan.channelCount).toBe(500);
    expect(plan.categoryCount).toBe(50);
    expect(plan.status).toBe('fit');
    expect(plan.refusals).toEqual([]);
    expect(plan.splits).toEqual([]);
  });

  it('allows exactly 50 channels in one category', () => {
    const plan = planCapacity({
      roleCount: 50,
      categories: [{ name: 'Division X', channelCount: 50 }],
    });

    expect(plan.status).toBe('fit');
    expect(plan.splits).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses 251 roles', () => {
    const plan = planCapacity({
      roleCount: 251,
      categories: categories(1),
    });

    expect(plan.status).toBe('refused');
    expect(plan.refusals.map((refusal) => refusal.scope)).toContain('roles');
    const roles = plan.refusals.find((refusal) => refusal.scope === 'roles');
    expect(roles?.limit).toBe(250);
    expect(roles?.actual).toBe(251);
  });

  it('refuses 501 channels', () => {
    const plan = planCapacity({
      roleCount: 1,
      categories: [
        ...Array.from({ length: 10 }, (_, index) => ({
          name: `Division ${index}`,
          channelCount: 50,
        })),
        { name: 'Division K', channelCount: 1 },
      ],
    });

    expect(plan.status).toBe('refused');
    const channels = plan.refusals.find((refusal) => refusal.scope === 'channels');
    expect(channels?.limit).toBe(500);
    expect(channels?.actual).toBe(501);
  });

  it('refuses 51 categories', () => {
    const plan = planCapacity({
      roleCount: 1,
      categories: Array.from({ length: 51 }, (_, index) => ({
        name: `Division ${index}`,
        channelCount: 1,
      })),
    });

    expect(plan.status).toBe('refused');
    const tooMany = plan.refusals.find((refusal) => refusal.scope === 'categories');
    expect(tooMany?.limit).toBe(50);
    expect(tooMany?.actual).toBe(51);
  });

  it('refuses the guild caps even when a split would fix the division', () => {
    const plan = planCapacity({
      roleCount: 251,
      categories: [{ name: 'Division X', channelCount: 51 }],
    });

    expect(plan.status).toBe('refused');
    expect(plan.splits).toHaveLength(1);
    expect(plan.refusals.map((refusal) => refusal.scope)).toEqual(['roles', 'category-channels']);
  });

  it('refuses when the split pushes the category count over the cap', () => {
    const plan = planCapacity({
      roleCount: 1,
      categories: [
        ...Array.from({ length: 49 }, (_, index) => ({
          name: `Division ${index}`,
          channelCount: 1,
        })),
        { name: 'Division X', channelCount: 51 },
      ],
    });

    expect(plan.status).toBe('refused');
    const tooMany = plan.refusals.find((refusal) => refusal.scope === 'categories');
    expect(tooMany?.actual).toBe(51);
  });

  it('treats negative counts as empty', () => {
    const plan = planCapacity({
      roleCount: -5,
      categories: [{ name: 'Division A', channelCount: -3 }],
    });

    expect(plan.roleCount).toBe(0);
    expect(plan.channelCount).toBe(0);
    expect(plan.status).toBe('fit');
  });
});

describe('flagCapacityHeadroom', () => {
  const emptyUsage: CapacityUsage = { roles: 0, channels: 0, categories: 0 };
  const smallRequest: CapacityRequest = {
    roleCount: 6,
    categories: [
      { name: 'Division A', channelCount: 2 },
      { name: 'Division B', channelCount: 2 },
    ],
  };

  it('flags nothing when the guild has headroom for the plan', () => {
    expect(flagCapacityHeadroom(smallRequest, emptyUsage)).toEqual([]);
    // 6 planned channel objects (4 channels and 2 categories), exactly to the cap.
    expect(
      flagCapacityHeadroom(smallRequest, { roles: 244, channels: 494, categories: 48 }),
    ).toEqual([]);
  });

  it('flags a channel plan that no longer fits a near-full guild', () => {
    const flags = flagCapacityHeadroom(smallRequest, {
      roles: 10,
      channels: 496,
      categories: 30,
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]?.scope).toBe('channels');
    expect(flags[0]?.limit).toBe(MAX_CHANNELS);
    expect(flags[0]?.existing).toBe(496);
    // The plan adds 4 channels and 2 categories; Discord counts both.
    expect(flags[0]?.planned).toBe(6);
    expect(flags[0]?.message).toContain('496');
    expect(flags[0]?.message).toContain('500');
  });

  it('flags roles and categories against the guild caps', () => {
    const flags = flagCapacityHeadroom(smallRequest, {
      roles: 248,
      channels: 10,
      categories: 49,
    });

    expect(flags.map((flag) => flag.scope)).toEqual(['roles', 'categories']);
    expect(flags[0]?.limit).toBe(MAX_ROLES);
    expect(flags[0]?.existing).toBe(248);
    expect(flags[0]?.planned).toBe(6);
    expect(flags[1]?.limit).toBe(MAX_CATEGORIES);
    expect(flags[1]?.planned).toBe(2);
  });

  it('flags every scope at once for a full guild', () => {
    const flags = flagCapacityHeadroom(
      { roleCount: 1, categories: categories(1) },
      { roles: MAX_ROLES, channels: MAX_CHANNELS, categories: MAX_CATEGORIES },
    );

    expect(flags.map((flag) => flag.scope)).toEqual(['roles', 'channels', 'categories']);
  });

  it('treats negative planned counts as empty, but a category is still a channel', () => {
    const flags = flagCapacityHeadroom(
      { roleCount: -1, categories: [{ name: 'Division A', channelCount: -2 }] },
      { roles: MAX_ROLES, channels: MAX_CHANNELS, categories: MAX_CATEGORIES },
    );

    // The plan adds no channels and no roles, but its one category is a
    // channel object, so both channel-ish caps are still crossed.
    expect(flags.map((flag) => flag.scope)).toEqual(['channels', 'categories']);
  });
});
