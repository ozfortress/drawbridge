/**
 * Pure authorization rules.
 *
 * Two independent layers:
 *  - Global bot-staff tiers (root > admin > helper > user > guest).
 *  - Per-league ranked roles, each carrying capabilities from the catalogue.
 *
 * Neither layer can change the other. Root and admin always pass league checks.
 * Helpers pass every league check except the destructive ones.
 */

export const GLOBAL_TIERS = ['root', 'admin', 'helper', 'user', 'guest'] as const;
export type GlobalTier = (typeof GLOBAL_TIERS)[number];

/** Lower number is more senior. */
const TIER_RANK: Record<GlobalTier, number> = {
  root: 0,
  admin: 1,
  helper: 2,
  user: 3,
  guest: 4,
};

export function tierRank(tier: GlobalTier): number {
  return TIER_RANK[tier];
}

export function isAtLeast(actor: GlobalTier, minimum: GlobalTier): boolean {
  return TIER_RANK[actor] <= TIER_RANK[minimum];
}

export const CAPABILITIES = [
  'league.read',
  'league.settings.write',
  'league.staff.manage',
  'league.roles.manage',
  'tournament.setup',
  'tournament.destructive',
  'match.manage',
  'schedule.manage',
  'awards.manage',
  'logs.read',
  'logs.redact',
  'logstf.manage',
  'faq.edit',
  'templates.edit',
  'citadel.keys.manage',
  'discord.settings.manage',
  'sync.manage',
  'jobs.decide',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES;

/** Operations that change or destroy data or remove access. */
export const DESTRUCTIVE_CAPABILITIES: readonly Capability[] = [
  'tournament.destructive',
  'logs.redact',
];

/** Helpers are league admins everywhere, minus destructive operations. */
const HELPER_CAPABILITIES: readonly Capability[] = ALL_CAPABILITIES.filter(
  (capability) => !DESTRUCTIVE_CAPABILITIES.includes(capability),
);

/** Capabilities granted by the global tier alone. League roles add to these. */
export function tierCapabilities(tier: GlobalTier): readonly Capability[] {
  switch (tier) {
    case 'root':
    case 'admin':
      return ALL_CAPABILITIES;
    case 'helper':
      return HELPER_CAPABILITIES;
    case 'user':
    case 'guest':
      return [];
  }
}

/**
 * Global tier rules for managing other users. Root manages everyone. Admin
 * manages every tier except root and other admins. Everyone else manages none.
 */
export function canManageTier(actor: GlobalTier, target: GlobalTier): boolean {
  if (actor === 'root') return true;
  if (actor === 'admin') return target !== 'root' && target !== 'admin';
  return false;
}

export interface LeagueRoleInput {
  rank: number;
  name: string;
  capabilities: readonly Capability[];
}

/**
 * League hierarchy rule: a member may edit or remove only roles ranked below
 * their own, and may only grant capabilities they themselves hold.
 */
export function canManageLeagueRole(
  actorRank: number,
  actorCapabilities: ReadonlySet<Capability>,
  target: LeagueRoleInput,
): boolean {
  return actorRank < target.rank && target.capabilities.every((cap) => actorCapabilities.has(cap));
}

export function canGrantLeagueRole(actor: GlobalTier, actorRank: number | null): boolean {
  if (actor === 'root' || actor === 'admin') return true;
  return actorRank !== null;
}

export interface EffectiveAccess {
  tier: GlobalTier;
  leagueRank: number | null;
  capabilities: ReadonlySet<Capability>;
}

export function mergeCapabilities(
  tier: GlobalTier,
  leagueCapabilities: readonly Capability[],
): ReadonlySet<Capability> {
  return new Set<Capability>([...tierCapabilities(tier), ...leagueCapabilities]);
}

export function can(access: EffectiveAccess, capability: Capability): boolean {
  return access.capabilities.has(capability);
}

/** Whether the tier may create leagues at all. */
export function canCreateLeague(tier: GlobalTier): boolean {
  return tier !== 'guest';
}

export interface DefaultLeagueRole {
  name: string;
  rank: number;
  capabilities: readonly Capability[];
}

/**
 * Starting hierarchy for a new league. Leagues may rename, reorder and edit
 * these. Admin deliberately lacks destructive operations and key management.
 */
export const DEFAULT_LEAGUE_ROLES: readonly DefaultLeagueRole[] = [
  { name: 'Director', rank: 10, capabilities: ALL_CAPABILITIES },
  {
    name: 'Admin',
    rank: 20,
    capabilities: ALL_CAPABILITIES.filter(
      (cap) =>
        ![
          'tournament.destructive',
          'logs.redact',
          'league.staff.manage',
          'league.roles.manage',
          'citadel.keys.manage',
        ].includes(cap),
    ),
  },
  {
    name: 'Trial',
    rank: 30,
    capabilities: ['league.read', 'match.manage', 'logs.read', 'sync.manage'],
  },
  { name: 'Caster', rank: 40, capabilities: ['league.read', 'logs.read'] },
  { name: 'Player', rank: 50, capabilities: [] },
];
