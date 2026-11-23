/**
 * Access model for the channels Drawbridge provisions for a league.
 *
 * Access is expressed with four levels instead of Discord permission
 * integers: the transport layer maps a level to permission bits, this
 * package stays free of Discord constants and of any permission arithmetic.
 *
 * The levels are cumulative - `send` implies `read`, `manage` implies
 * `send` - so one level per target is enough to describe an overwrite.
 */

/** Access granted to a target on a channel. `none` means no access. */
export type AccessLevel = 'none' | 'read' | 'send' | 'manage';

/** Every access level, weakest first. */
export const ACCESS_LEVELS: readonly AccessLevel[] = ['none', 'read', 'send', 'manage'];

/** The channel kinds a league setup creates. */
export type ChannelKind = 'category' | 'team' | 'match';

/** A staff purpose and the access it grants on a channel kind. */
export interface AccessPurpose {
  readonly id: string;
  readonly name: string;
  readonly level: AccessLevel;
}

/**
 * Staff purposes on a division category channel.
 *
 * A purpose listed with level `none` is acknowledged on this channel kind
 * but grants nothing, which keeps every set complete over all four levels.
 */
export const CATEGORY_ACCESS: readonly AccessPurpose[] = [
  { id: 'league-admin', name: 'League Admin', level: 'manage' },
  { id: 'moderator', name: 'Moderator', level: 'send' },
  { id: 'spectator', name: 'Spectator', level: 'read' },
  { id: 'match-announcer', name: 'Match Announcer', level: 'none' },
];

/** Staff purposes on a team channel. */
export const TEAM_ACCESS: readonly AccessPurpose[] = [
  { id: 'league-admin', name: 'League Admin', level: 'manage' },
  { id: 'captain', name: 'Captain', level: 'send' },
  { id: 'spectator', name: 'Spectator', level: 'read' },
  { id: 'match-announcer', name: 'Match Announcer', level: 'none' },
];

/** Staff purposes on a match channel. */
export const MATCH_ACCESS: readonly AccessPurpose[] = [
  { id: 'league-admin', name: 'League Admin', level: 'manage' },
  { id: 'referee', name: 'Referee', level: 'send' },
  { id: 'spectator', name: 'Spectator', level: 'read' },
  { id: 'captain', name: 'Captain', level: 'none' },
];

/** The purpose set that applies to a channel kind. */
export function accessSetFor(kind: ChannelKind): readonly AccessPurpose[] {
  if (kind === 'category') return CATEGORY_ACCESS;
  if (kind === 'team') return TEAM_ACCESS;
  return MATCH_ACCESS;
}

const LEVEL_RANK: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  send: 2,
  manage: 3,
};

/** True when `granted` covers `required` (levels are cumulative). */
export function levelAtLeast(granted: AccessLevel, required: AccessLevel): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

/** A role that may enter a league channel on behalf of a team. */
export interface TeamRole {
  readonly id: string;
  readonly name: string;
}

/** A staff role and the purposes it holds. */
export interface StaffRole {
  readonly id: string;
  readonly name: string;
  readonly purposes: readonly string[];
}

/** A single permission overwrite in a plan. */
export interface AccessOverwrite {
  readonly targetId: string;
  readonly targetName: string;
  readonly targetKind: 'everyone' | 'role';
  readonly level: AccessLevel;
  readonly purposeIds: readonly string[];
}

/** The overwrite plan for one channel. */
export interface AccessPlan {
  readonly kind: ChannelKind;
  readonly purposes: readonly AccessPurpose[];
  readonly overwrites: readonly AccessOverwrite[];
}

/** The input of the access planner. */
export interface AccessPlanInput {
  readonly kind: ChannelKind;
  readonly teamRoles?: readonly TeamRole[];
  readonly staffRoles?: readonly StaffRole[];
}

interface OverwriteDraft {
  readonly targetId: string;
  targetName: string;
  readonly targetKind: 'everyone' | 'role';
  level: AccessLevel;
  purposeIds: string[];
}

/**
 * Produces the overwrite plan for a category, team or match channel.
 *
 * The rules are the same for every channel kind:
 *
 * - `@everyone` is denied - league channels are never public.
 * - Every team role that is passed in gets view and send (`send`).
 * - Every staff role gets the access of the purposes it holds, taken from
 *   the set that belongs to the channel kind. A staff role that holds no
 *   purpose of that set gets no overwrite at all and therefore no access.
 *
 * When one role appears twice (a staff role that is also a team role) the
 * stronger level wins and the purpose ids are merged, so the plan never
 * contains two overwrites for the same target.
 */
export function planAccess(input: AccessPlanInput): AccessPlan {
  const purposes = accessSetFor(input.kind);
  const levelByPurpose = new Map<string, AccessLevel>();
  for (const purpose of purposes) {
    levelByPurpose.set(purpose.id, purpose.level);
  }

  const drafts = new Map<string, OverwriteDraft>();

  const merge = (
    targetId: string,
    targetName: string,
    targetKind: 'everyone' | 'role',
    level: AccessLevel,
    purposeIds: readonly string[],
  ): void => {
    const existing = drafts.get(targetId);
    if (!existing) {
      drafts.set(targetId, {
        targetId,
        targetName,
        targetKind,
        level,
        purposeIds: [...purposeIds],
      });
      return;
    }
    if (levelAtLeast(level, existing.level)) {
      existing.level = level;
    }
    for (const purposeId of purposeIds) {
      if (!existing.purposeIds.includes(purposeId)) {
        existing.purposeIds.push(purposeId);
      }
    }
  };

  merge('everyone', '@everyone', 'everyone', 'none', []);

  for (const role of input.teamRoles ?? []) {
    merge(role.id, role.name, 'role', 'send', []);
  }

  for (const role of input.staffRoles ?? []) {
    const matched = role.purposes.filter((purposeId) => levelByPurpose.has(purposeId));
    if (matched.length === 0) continue;

    let granted: AccessLevel = 'none';
    for (const purposeId of matched) {
      const level = levelByPurpose.get(purposeId);
      if (level === undefined) continue;
      if (levelAtLeast(level, granted)) {
        granted = level;
      }
    }

    merge(role.id, role.name, 'role', granted, matched);
  }

  return {
    kind: input.kind,
    purposes,
    overwrites: [...drafts.values()].map((draft) => ({
      targetId: draft.targetId,
      targetName: draft.targetName,
      targetKind: draft.targetKind,
      level: draft.level,
      purposeIds: draft.purposeIds,
    })),
  };
}
