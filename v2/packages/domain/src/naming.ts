/**
 * Naming rules for the Discord artefacts Drawbridge creates.
 *
 * Two rules drive everything in this module:
 *
 * 1. Names are cut on grapheme clusters, never on UTF-16 code units, so an
 *    emoji, a flag or a zero-width-joiner sequence is kept whole or dropped
 *    whole. A trimmed name never ends in a hyphen.
 * 2. Role and channel names stay inside Discord's 100 character limit, and
 *    channel names normalise to the `[a-z0-9-]` alphabet Discord accepts.
 *
 * The formats follow the legacy tournament plan: a division is
 * `{division} - {shortcode}`, a team role is `{name[:budget]} ({shortcode})`,
 * a team channel is `🛡️{name[:budget]} ({shortcode})` and a match channel is
 * `{home}-vs-{away}-{matchId}` normalised for Discord. Every function here is
 * pure; the package imports nothing.
 *
 * Two counters are at work and they are not the same:
 *
 * - The **budget** of a team name counts grapheme clusters, the characters a
 *   human reads: a budget of five keeps five emoji, never a broken pair.
 * - The **limit** of a Discord name counts UTF-16 code units, the strictest
 *   reading of Discord's 100 character cap. A name inside the limit is
 *   therefore inside 100 code points and 100 grapheme clusters as well.
 */

/** Discord's hard limit for role and channel names. */
export const DISCORD_NAME_LIMIT = 100;

/** Grapheme budget for the team name part of a role or channel name. */
export const DEFAULT_TEAM_NAME_BUDGET = 20;

/** Prefix Discord shows on a team channel. */
export const TEAM_CHANNEL_PREFIX = '\u{1F6E1}\u{FE0F}';

/** Word that separates the two sides of a match channel name. */
export const MATCH_CHANNEL_SEPARATOR = 'vs';

/** Options shared by the team role and team channel names. */
export interface TeamNamingOptions {
  /**
   * Budget for the team name, counted in grapheme clusters: a budget of five
   * keeps five emoji. Defaults to {@link DEFAULT_TEAM_NAME_BUDGET}.
   */
  readonly budget?: number;
  /**
   * Citadel roster id. It is appended to the team name when the trimmed name
   * is the same as a sibling team's trimmed name, so the two names differ.
   */
  readonly rosterId?: string;
  /**
   * Names of the other teams in the same league. The team being named is not
   * part of this list.
   */
  readonly siblingNames?: readonly string[];
}

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Splits a string into grapheme clusters. */
function clusters(value: string): string[] {
  return Array.from(SEGMENTER.segment(value), (part) => part.segment);
}

/** The length of `value` in UTF-16 code units. */
function units(value: string): number {
  return value.length;
}

/**
 * Cuts `value` to at most `maxClusters` grapheme clusters, never splitting
 * one.
 */
function cutClusters(value: string, maxClusters: number): string {
  if (maxClusters <= 0) return '';
  let out = '';
  let count = 0;
  for (const cluster of clusters(value)) {
    if (count >= maxClusters) break;
    out += cluster;
    count += 1;
  }
  return out;
}

/**
 * Cuts `value` to at most `maxUnits` UTF-16 code units without splitting a
 * grapheme cluster: a cluster that would straddle the limit is dropped whole.
 */
function cutUnits(value: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  let out = '';
  let length = 0;
  for (const cluster of clusters(value)) {
    if (length + cluster.length > maxUnits) break;
    out += cluster;
    length += cluster.length;
  }
  return out;
}

/** Drops trailing whitespace and hyphens so a name never ends in a hyphen. */
function stripTrailing(value: string): string {
  return value.replace(/[\s-]+$/u, '');
}

/** The team name as it appears inside a role or channel name. */
function trimName(name: string, budget: number): string {
  return stripTrailing(cutClusters(name, Math.max(0, budget)));
}

/** Cuts a name to the room left in a Discord name and drops a trailing hyphen. */
function trimToUnits(value: string, maxUnits: number): string {
  return stripTrailing(cutUnits(value, maxUnits));
}

/**
 * The last line of defence: cuts a finished name to Discord's limit and
 * drops a trailing hyphen, so no name is ever too long or ends in a hyphen.
 */
function clamp(value: string): string {
  return stripTrailing(cutUnits(value, DISCORD_NAME_LIMIT));
}

/** True when two names trim to the same text. */
function trimsAlike(left: string, right: string, budget: number): boolean {
  const first = trimName(left, budget).toLocaleLowerCase();
  const second = trimName(right, budget).toLocaleLowerCase();
  return first === second;
}

/**
 * Normalises a name to the alphabet Discord accepts in a channel name:
 * lowercase letters, digits and hyphens. Diacritics are folded away, every
 * other character becomes a hyphen, and the result never starts or ends with
 * a hyphen.
 */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * Assembles a Discord name from its parts so the result always fits inside
 * Discord's limit.
 *
 * The parts give way in a fixed order when the name is too long: the team
 * name first (legacy behaviour), then the roster id, then the shortcode. The
 * final clamp guarantees the limit even when a part is pathologically long.
 */
function assemble(
  prefix: string,
  name: string,
  suffix: string,
  code: string,
  open: string,
  close: string,
): string {
  const fixed = units(prefix) + units(open) + units(close);
  const wanted = stripTrailing(name);
  let finalSuffix = suffix;
  let finalCode = code;

  // The name absorbs the pressure of a tail that fits beside it.
  const nameRoom = DISCORD_NAME_LIMIT - fixed - units(finalSuffix) - units(finalCode);
  let finalName = units(wanted) > nameRoom ? trimToUnits(wanted, nameRoom) : wanted;

  // A tail that does not fit at all gives way: the roster id first, then the
  // shortcode, so the name keeps the room it asked for.
  if (fixed + units(finalName) + units(finalSuffix) + units(finalCode) > DISCORD_NAME_LIMIT) {
    const tailRoom = DISCORD_NAME_LIMIT - fixed - units(wanted);
    finalSuffix = cutUnits(finalSuffix, Math.max(0, tailRoom - units(finalCode)));
    finalCode = cutUnits(finalCode, Math.max(0, tailRoom - units(finalSuffix)));
    finalName = trimToUnits(
      wanted,
      DISCORD_NAME_LIMIT - fixed - units(finalSuffix) - units(finalCode),
    );
  }

  return clamp(`${prefix}${finalName}${finalSuffix}${open}${finalCode}${close}`);
}

/**
 * Composes a team role or channel name.
 *
 * The name is trimmed to the budget, a roster id is appended when a sibling
 * team trims to the same name, and the name part shrinks further if the whole
 * result would exceed Discord's limit.
 */
function composeTeamName(
  prefix: string,
  name: string,
  shortcode: string,
  options: TeamNamingOptions,
): string {
  const budget = Math.max(0, options.budget ?? DEFAULT_TEAM_NAME_BUDGET);
  const trimmed = trimName(name, budget);
  const siblings = options.siblingNames ?? [];
  const rosterId = options.rosterId ?? '';
  const collides =
    rosterId !== '' && siblings.some((sibling) => trimsAlike(sibling, trimmed, budget));
  const suffix = collides ? `-${rosterId}` : '';
  return assemble(prefix, trimmed, suffix, shortcode.trim(), ' (', ')');
}

/**
 * The Discord category name of a division: `{division} - {shortcode}`.
 *
 * The division is trimmed so the whole name fits Discord's limit.
 */
export function divisionCategoryName(division: string, shortcode: string): string {
  return divisionRoleName(division, shortcode);
}

/**
 * The Discord role name of a division: `{division} - {shortcode}`.
 *
 * Discord shows the same name for the division category and its role.
 */
export function divisionRoleName(division: string, shortcode: string): string {
  return assemble('', division.trim(), '', shortcode.trim(), ' - ', '');
}

/**
 * The Discord role name of a team: `{name[:budget]} ({shortcode})`.
 *
 * When another team trims to the same name, the Citadel roster id is
 * appended so the two roles differ: `{name}-{rosterId} ({shortcode})`.
 */
export function teamRoleName(
  name: string,
  shortcode: string,
  options: TeamNamingOptions = {},
): string {
  return composeTeamName('', name, shortcode, options);
}

/**
 * The Discord channel name of a team: `🛡️{name[:budget]} ({shortcode})`.
 *
 * The same roster id rule as {@link teamRoleName} applies, so the channels of
 * two teams that trim alike still differ.
 */
export function teamChannelName(
  name: string,
  shortcode: string,
  options: TeamNamingOptions = {},
): string {
  return composeTeamName(TEAM_CHANNEL_PREFIX, name, shortcode, options);
}

/**
 * The Discord channel name of a match: `{home}-vs-{away}-{matchId}`,
 * normalised to lowercase letters, digits and hyphens.
 *
 * The two team names are trimmed against each other until the whole name fits
 * Discord's limit.
 */
export function matchChannelName(home: string, away: string, matchId: string): string {
  const matchSlug = slugify(matchId);
  let homeSlug = slugify(home);
  let awaySlug = slugify(away);

  const compose = (homeName: string, awayName: string): string =>
    [homeName, MATCH_CHANNEL_SEPARATOR, awayName, matchSlug]
      .filter((part) => part.length > 0)
      .join('-');

  while (
    compose(homeSlug, awaySlug).length > DISCORD_NAME_LIMIT &&
    (homeSlug.length > 0 || awaySlug.length > 0)
  ) {
    if (homeSlug.length >= awaySlug.length) {
      homeSlug = stripTrailing(cutUnits(homeSlug, homeSlug.length - 1));
    } else {
      awaySlug = stripTrailing(cutUnits(awaySlug, awaySlug.length - 1));
    }
  }

  return clamp(compose(homeSlug, awaySlug));
}

/**
 * The readable line of a match used as a channel topic and in embeds:
 * `{Home} vs {Away} #{matchId} · {roundName}`.
 *
 * The team names keep their original spelling and accents; only surrounding
 * whitespace is removed.
 */
export function readableMatchLine(
  home: string,
  away: string,
  matchId: string,
  roundName: string,
): string {
  return `${home.trim()} vs ${away.trim()} #${matchId.trim()} · ${roundName.trim()}`;
}

/**
 * Normalises any name into the channel name Discord accepts:
 * lowercase letters, digits and hyphens only.
 */
export function normalizeChannelName(value: string): string {
  return slugify(value);
}

/**
 * The number of grapheme clusters in `value`: the characters a human reads.
 *
 * A flag or a zero-width-joiner sequence counts as one, never as the two or
 * more code units it is written with.
 */
export function graphemeLength(value: string): number {
  return clusters(value).length;
}

/**
 * True when `name` trims to the same text as one of the sibling names.
 *
 * Two teams that trim alike get the roster id appended to their role and
 * channel names so the two differ; this predicate is how a caller learns that
 * the suffix was needed.
 */
export function teamNameCollides(
  name: string,
  siblingNames: readonly string[],
  budget: number = DEFAULT_TEAM_NAME_BUDGET,
): boolean {
  return siblingNames.some((sibling) => trimsAlike(sibling, name, budget));
}
