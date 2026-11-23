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
