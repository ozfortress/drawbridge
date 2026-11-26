/**
 * Capacity planner for a league setup.
 *
 * Discord guilds cap the number of roles, channels and categories a bot may
 * create. The planner checks a requested setup against those caps and, when
 * only a division is too large, proposes how to split it instead of refusing
 * the whole setup.
 */

/** Maximum number of roles a guild may hold. */
export const MAX_ROLES = 250;

/** Maximum number of channels a guild may hold. */
export const MAX_CHANNELS = 500;

/** Maximum number of categories a guild may hold. */
export const MAX_CATEGORIES = 50;

/** Maximum number of channels a single category may hold. */
export const MAX_CHANNELS_PER_CATEGORY = 50;

/** A category of the requested setup and the number of channels it holds. */
export interface CapacityCategory {
  readonly name: string;
  readonly channelCount: number;
}

/** The setup the planner is asked about. */
export interface CapacityRequest {
  readonly roleCount: number;
  readonly categories: readonly CapacityCategory[];
}

/** Which cap was exceeded. */
export type CapacityScope = 'roles' | 'channels' | 'categories' | 'category-channels';

/** One explicit refusal: a cap that the requested setup does not fit under. */
export interface CapacityRefusal {
  readonly scope: CapacityScope;
  readonly limit: number;
  readonly actual: number;
  readonly message: string;
}

/** One part of a split division. */
export interface CapacitySplitPart {
  readonly name: string;
  readonly channelCount: number;
}

/** The split proposed for a division that exceeds the per-category cap. */
export interface CapacitySplit {
  readonly name: string;
  readonly parts: readonly CapacitySplitPart[];
}

/** The outcome of the capacity check. */
export type CapacityStatus = 'fit' | 'refused' | 'split';

/** The plan the executor can act on. */
export interface CapacityPlan {
  /** `refused` when a guild-wide cap is exceeded, `split` when only a
   * division had to be split, `fit` when everything fits as requested. */
  readonly status: CapacityStatus;
  readonly roleCount: number;
  readonly channelCount: number;
  readonly categoryCount: number;
  readonly refusals: readonly CapacityRefusal[];
  readonly splits: readonly CapacitySplit[];
  readonly categories: readonly CapacityCategory[];
}

/** What a guild already holds, as the bot's own ledger records it. */
export interface CapacityUsage {
  /** Live roles the bot created, @everyone and foreign roles excluded. */
  readonly roles: number;
  /** Live channels, categories included as Discord counts them. */
  readonly channels: number;
  readonly categories: number;
}

/** One headroom flag: the plan plus the guild's recorded usage crosses a cap. */
export interface CapacityHeadroomFlag {
  readonly scope: CapacityScope;
  readonly limit: number;
  /** What the guild already holds, per the ledger. */
  readonly existing: number;
  /** What the plan would add. */
  readonly planned: number;
  readonly message: string;
}

/**
 * Flags every guild-wide cap the planned setup plus the guild's recorded
 * usage would cross (02 §4.8).
 *
 * `planCapacity` says what the plan alone cannot fit; this says what no
 * longer fits because the guild is already close to a cap — a full season
 * of match channels can push a setup over the limit even when the setup
 * itself is small. The flags are warnings, not refusals: the ledger is the
 * bot's own record and cannot see foreign objects, so the executor's live
 * preflight stays the authority that refuses a create. Per-category
 * headroom is not derivable from the ledger (it does not record parents)
 * and stays the preflight's to check.
 */
export function flagCapacityHeadroom(
  request: CapacityRequest,
  usage: CapacityUsage,
): CapacityHeadroomFlag[] {
  const plannedChannels = request.categories.reduce(
    (sum, category) => sum + Math.max(0, category.channelCount),
    0,
  );
  const plannedCategories = request.categories.length;
  // Discord counts categories as channels, so the channel cap sees both.
  const plannedChannelObjects = plannedChannels + plannedCategories;
  const flags: CapacityHeadroomFlag[] = [];

  if (usage.roles + Math.max(0, request.roleCount) > MAX_ROLES) {
    flags.push({
      scope: 'roles',
      limit: MAX_ROLES,
      existing: usage.roles,
      planned: request.roleCount,
      message: `The guild already holds ${usage.roles} roles; this plan adds ${request.roleCount} and would cross the limit of ${MAX_ROLES}.`,
    });
  }
  if (usage.channels + plannedChannelObjects > MAX_CHANNELS) {
    flags.push({
      scope: 'channels',
      limit: MAX_CHANNELS,
      existing: usage.channels,
      planned: plannedChannelObjects,
      message: `The guild already holds ${usage.channels} channels; this plan adds ${plannedChannelObjects} and would cross the limit of ${MAX_CHANNELS}.`,
    });
  }
  if (usage.categories + plannedCategories > MAX_CATEGORIES) {
    flags.push({
      scope: 'categories',
      limit: MAX_CATEGORIES,
      existing: usage.categories,
      planned: plannedCategories,
      message: `The guild already holds ${usage.categories} categories; this plan adds ${plannedCategories} and would cross the limit of ${MAX_CATEGORIES}.`,
    });
  }
  return flags;
}

function splitCategory(category: CapacityCategory): CapacitySplitPart[] {
  const parts: CapacitySplitPart[] = [];
  const partCount = Math.ceil(category.channelCount / MAX_CHANNELS_PER_CATEGORY);
  for (let index = 1; index <= partCount; index += 1) {
    const remaining = category.channelCount - (index - 1) * MAX_CHANNELS_PER_CATEGORY;
    parts.push({
      name: `${category.name} (${index})`,
      channelCount: Math.min(MAX_CHANNELS_PER_CATEGORY, remaining),
    });
  }
  return parts;
}

/**
 * Checks a requested setup against the guild caps.
 *
 * The guild-wide caps (roles, channels, categories) are hard: exceeding one
 * is refused. A single division that holds more than
 * `MAX_CHANNELS_PER_CATEGORY` channels is not refused outright - it is split
 * into `Name (1)`, `Name (2)`, ... and the unsplit arrangement is refused
 * explicitly so the caller sees why the division was touched.
 */
export function planCapacity(request: CapacityRequest): CapacityPlan {
  const roleCount = Math.max(0, request.roleCount);
  const categories = request.categories.map((category) => ({
    name: category.name,
    channelCount: Math.max(0, category.channelCount),
  }));
  const channelCount = categories.reduce((sum, category) => sum + category.channelCount, 0);

  const refusals: CapacityRefusal[] = [];
  const splits: CapacitySplit[] = [];
  const finalCategories: CapacityCategory[] = [];

  if (roleCount > MAX_ROLES) {
    refusals.push({
      scope: 'roles',
      limit: MAX_ROLES,
      actual: roleCount,
      message: `${roleCount} roles exceeds the guild limit of ${MAX_ROLES}.`,
    });
  }

  if (channelCount > MAX_CHANNELS) {
    refusals.push({
      scope: 'channels',
      limit: MAX_CHANNELS,
      actual: channelCount,
      message: `${channelCount} channels exceeds the guild limit of ${MAX_CHANNELS}.`,
    });
  }

  for (const category of categories) {
    if (category.channelCount <= MAX_CHANNELS_PER_CATEGORY) {
      finalCategories.push(category);
      continue;
    }

    refusals.push({
      scope: 'category-channels',
      limit: MAX_CHANNELS_PER_CATEGORY,
      actual: category.channelCount,
      message: `Category "${category.name}" holds ${category.channelCount} channels, more than the ${MAX_CHANNELS_PER_CATEGORY} allowed per category.`,
    });

    const parts = splitCategory(category);
    splits.push({ name: category.name, parts });
    finalCategories.push(...parts);
  }

  if (finalCategories.length > MAX_CATEGORIES) {
    refusals.push({
      scope: 'categories',
      limit: MAX_CATEGORIES,
      actual: finalCategories.length,
      message: `${finalCategories.length} categories exceeds the guild limit of ${MAX_CATEGORIES}.`,
    });
  }

  const hardRefusal = refusals.some((refusal) => refusal.scope !== 'category-channels');
  const status: CapacityStatus = hardRefusal ? 'refused' : splits.length > 0 ? 'split' : 'fit';

  return {
    status,
    roleCount,
    channelCount,
    categoryCount: finalCategories.length,
    refusals,
    splits,
    categories: finalCategories,
  };
}
