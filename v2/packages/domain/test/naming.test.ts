import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEAM_NAME_BUDGET,
  DISCORD_NAME_LIMIT,
  divisionCategoryName,
  divisionRoleName,
  matchChannelName,
  normalizeChannelName,
  readableMatchLine,
  teamChannelName,
  teamRoleName,
} from '../src/index.js';

/** Discord only accepts these characters in a channel name. */
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;
/** A high surrogate that is not followed by a low surrogate. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;
/** A low surrogate that is not preceded by a high surrogate. */
const LONE_LOW_SURROGATE = /[\uDC00-\uDFFF](?![\uD800-\uDBFF])/u;

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

const clusterCount = (value: string): number => Array.from(SEGMENTER.segment(value)).length;

const expectNoSplit = (value: string): void => {
  expect(value).not.toMatch(LONE_HIGH_SURROGATE);
  expect(value).not.toMatch(LONE_LOW_SURROGATE);
};

describe('division names', () => {
  it('renders a division as "{division} - {shortcode}"', () => {
    expect(divisionCategoryName('Division 1', 'OZL')).toBe('Division 1 - OZL');
    expect(divisionRoleName('Division 1', 'OZL')).toBe('Division 1 - OZL');
    expect(divisionCategoryName('Division 1', 'OZL')).toBe(divisionRoleName('Division 1', 'OZL'));
  });

  it('keeps a long division inside the Discord limit', () => {
    const name = divisionCategoryName('D'.repeat(200), 'OZL');

    expect(name).toBe(`${'D'.repeat(94)} - OZL`);
    expect(name.length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
  });

  it('never ends a division name in a hyphen', () => {
    expect(divisionRoleName('Division -', 'OZL')).toBe('Division - OZL');
    expect(divisionRoleName('Division --', 'OZL')).toBe('Division - OZL');
  });

  it('keeps accented division names intact', () => {
    expect(divisionCategoryName('Ångström Division', 'OZL')).toBe('Ångström Division - OZL');
  });
});

describe('team names', () => {
  it('renders a team role as "{name[:budget]} ({shortcode})"', () => {
    expect(teamRoleName('Sydney Azzurri', 'OZL')).toBe('Sydney Azzurri (OZL)');
    expect(teamRoleName('Sydney Azzurri', 'OZL').length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
  });

  it('renders a team channel with the shield prefix', () => {
    expect(teamChannelName('Sydney Azzurri', 'OZL')).toBe('\u{1F6E1}\u{FE0F}Sydney Azzurri (OZL)');
    expect(teamChannelName('Sydney Azzurri', 'OZL').length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
  });

  it('trims the name to the budget', () => {
    const name = 'Team Name That Runs Past The Budget';

    expect(teamRoleName(name, 'OZL')).toBe('Team Name That Runs (OZL)');
    expect(teamRoleName(name, 'OZL').startsWith(name.slice(0, DEFAULT_TEAM_NAME_BUDGET))).toBe(
      true,
    );
  });

  it('keeps a 100 character name inside the Discord limit', () => {
    const name = 'X'.repeat(100);

    expect(teamRoleName(name, 'OZL')).toBe(`${'X'.repeat(DEFAULT_TEAM_NAME_BUDGET)} (OZL)`);
    expect(teamRoleName(name, 'OZL').length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
  });

  it('keeps an emoji name whole', () => {
    expect(teamRoleName('🔥 Sydney Azzurri', 'OZL')).toBe('🔥 Sydney Azzurri (OZL)');
    expect(teamChannelName('🔥 Bolts', 'OZL')).toBe('\u{1F6E1}\u{FE0F}🔥 Bolts (OZL)');
  });

  it('never splits a zero-width-joiner sequence', () => {
    expect(teamRoleName('👨‍👩‍👧‍👦 Family Esports', 'OZL')).toBe('👨‍👩‍👧‍👦 Family E (OZL)');
    expect(teamRoleName('👨‍👩‍👧‍👦 Family', 'OZL', { budget: 12 })).toBe('👨‍👩‍👧‍👦 (OZL)');
  });

  it('never splits a surrogate pair of a long emoji name', () => {
    const role = teamRoleName('🔥'.repeat(200), 'OZL');
    const namePart = role.slice(0, role.length - ' (OZL)'.length);

    expectNoSplit(role);
    expect(clusterCount(namePart)).toBe(DEFAULT_TEAM_NAME_BUDGET / 2);
    expect(role.length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
  });

  it('never ends a team name in a hyphen', () => {
    expect(teamRoleName('Sydney-', 'OZL')).toBe('Sydney (OZL)');
    expect(teamRoleName('Sydney--', 'OZL')).toBe('Sydney (OZL)');
  });

  it('keeps accented names intact in roles', () => {
    expect(teamRoleName('Équipe Bleue', 'OZL')).toBe('Équipe Bleue (OZL)');
  });

  it('handles a shortcode of more than twenty characters', () => {
    const shortcode = 'ABCDEFGHIJKLMNOPQRSTU';

    expect(teamRoleName('Sydney Azzurri', shortcode)).toBe(`Sydney Azzurri (${shortcode})`);
    expect(teamRoleName('Sydney Azzurri', shortcode).length).toBeLessThanOrEqual(
      DISCORD_NAME_LIMIT,
    );
  });

  it('shrinks the name when a long shortcode would break the limit', () => {
    const shortcode = 'ABCDEFGHIJKLMNOPQRSTU';
    const role = teamRoleName('X'.repeat(90), shortcode, { budget: 90 });

    expect(role).toBe(`${'X'.repeat(76)} (${shortcode})`);
    expect(role.length).toBe(DISCORD_NAME_LIMIT);

    const channel = teamChannelName('X'.repeat(90), shortcode, { budget: 90 });

    expect(channel.length).toBe(DISCORD_NAME_LIMIT);
    expect(channel).toBe(`\u{1F6E1}\u{FE0F}${'X'.repeat(73)} (${shortcode})`);
  });
});

describe('duplicate team names', () => {
  const first = 'Duplicated Team Name A';
  const second = 'Duplicated Team Name B';

  it('appends the roster id when two names trim alike', () => {
    const firstRole = teamRoleName(first, 'OZL', {
      rosterId: '101',
      siblingNames: [second],
    });
    const secondRole = teamRoleName(second, 'OZL', {
      rosterId: '102',
      siblingNames: [first],
    });

    expect(firstRole).toBe('Duplicated Team Name-101 (OZL)');
    expect(secondRole).toBe('Duplicated Team Name-102 (OZL)');
    expect(firstRole).not.toBe(secondRole);
  });

  it('appends the roster id to the channel name too', () => {
    const channel = teamChannelName(first, 'OZL', {
      rosterId: '101',
      siblingNames: [second],
    });

    expect(channel).toBe('\u{1F6E1}\u{FE0F}Duplicated Team Name-101 (OZL)');
    expect(channel).not.toBe(
      teamChannelName(second, 'OZL', { rosterId: '102', siblingNames: [first] }),
    );
  });

  it('leaves a unique name alone', () => {
    expect(teamRoleName(first, 'OZL', { rosterId: '101', siblingNames: ['Other Team'] })).toBe(
      'Duplicated Team Name (OZL)',
    );
    expect(teamRoleName(first, 'OZL')).toBe('Duplicated Team Name (OZL)');
  });

  it('ignores a roster id when there is no sibling', () => {
    expect(teamRoleName(first, 'OZL', { rosterId: '101' })).toBe('Duplicated Team Name (OZL)');
  });
});

describe('match channel names', () => {
  it('renders a match as "{home}-vs-{away}-{matchId}"', () => {
    expect(matchChannelName('Sydney Azzurri', 'Melbourne Tigers', '42')).toBe(
      'sydney-azzurri-vs-melbourne-tigers-42',
    );
  });

  it('normalises accents, emoji and punctuation away', () => {
    expect(matchChannelName('Équipe Bleue', 'Ångström', '7')).toBe('equipe-bleue-vs-angstrom-7');
    expect(matchChannelName('🔥 Bolts!', '🐯 Tigers (II)', '42')).toBe('bolts-vs-tigers-ii-42');
  });

  it('produces a name Discord accepts', () => {
    const channel = matchChannelName('Sydney Azzurri', 'Melbourne Tigers', '42');

    expect(channel).toMatch(CHANNEL_PATTERN);
    expect(channel).not.toMatch(/-$/u);
  });

  it('keeps a long match name inside the Discord limit', () => {
    const channel = matchChannelName('H'.repeat(90), 'A'.repeat(90), '42');

    expect(channel.length).toBeLessThanOrEqual(DISCORD_NAME_LIMIT);
    expect(channel).toMatch(CHANNEL_PATTERN);
    expect(channel.endsWith('-42')).toBe(true);
  });

  it('normalises a team channel into a name Discord accepts', () => {
    const channel = normalizeChannelName(teamChannelName('Sydney Azzurri', 'OZL'));

    expect(channel).toBe('sydney-azzurri-ozl');
    expect(channel).toMatch(CHANNEL_PATTERN);
  });
});

describe('readable match lines', () => {
  it('renders "{Home} vs {Away} #{matchId} · {roundName}"', () => {
    expect(readableMatchLine('Sydney Azzurri', 'Melbourne Tigers', '42', 'Round 3')).toBe(
      'Sydney Azzurri vs Melbourne Tigers #42 · Round 3',
    );
  });

  it('keeps accents and emoji intact', () => {
    expect(readableMatchLine('Équipe Bleue', '🔥 Bolts', '42', 'Round 3')).toBe(
      'Équipe Bleue vs 🔥 Bolts #42 · Round 3',
    );
    expectNoSplit(readableMatchLine('🔥'.repeat(200), 'Bolts', '42', 'Round 3'));
  });
});
