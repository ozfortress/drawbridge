/**
 * The Discord operation catalogue (plan 02 §5.4, §5.9; §4.16).
 *
 * Every Discord write a job's plan can contain is one catalogue op. The
 * catalogue is pure data and pure functions — no I/O, no executor — and
 * describes, for each op kind: its inputs (the same plain data the port
 * takes), the prior guild state captured before it runs, the result IDs
 * recorded in `job_steps.external_ids` before the step is marked done,
 * and the compensation descriptor the revert engine later reads from
 * `job_steps.compensation`. Every op carries the audit reason tag
 * `drb:{jobId}:{seq}` (02 §4.16).
 *
 * The four §5.9 compensations — delete role, delete channel, delete
 * category, restore overwrites — are the exact shapes the
 * `@drawbridge/jobs` revert engine executes today, imported here as types
 * so the two vocabularies cannot drift (a test proves it). The restore
 * and best-effort recreate descriptors for move, rename, member-role and
 * delete ops are the vocabulary the step executor adopts when it lands
 * (recorded in docs/decisions.md). Announcement messages are the one
 * non-reversible op pair: a revert neither deletes nor unpins them, and
 * `nonReversibleOps` lists them for preview warnings (02 §5.2).
 */
import type { Compensation, ExternalId, OverwriteSnapshot } from '@drawbridge/jobs';
import type { AllowedMentions, DiscordPort, MessageEmbed, OverwriteSet } from './port.js';

/** Every step operation kind the engine can plan (05, P3). */
export const DISCORD_OP_KINDS = [
  'create_role',
  'delete_role',
  'create_category',
  'delete_category',
  'create_text_channel',
  'delete_channel',
  'edit_overwrites',
  'send_message',
  'pin_message',
  'add_role_to_member',
  'remove_role_from_member',
  'move_channel',
  'rename_channel',
] as const;

export type DiscordOpKind = (typeof DISCORD_OP_KINDS)[number];

/** One op's inputs — the same plain data the port call takes. */
export type DiscordOp =
  | {
      kind: 'create_role';
      guildId: string;
      name: string;
      color?: number;
      hoist?: boolean;
      mentionable?: boolean;
    }
  | { kind: 'delete_role'; guildId: string; roleId: string }
  | { kind: 'create_category'; guildId: string; name: string; overwrites?: readonly OverwriteSet[] }
  | { kind: 'delete_category'; guildId: string; categoryId: string }
  | {
      kind: 'create_text_channel';
      guildId: string;
      name: string;
      categoryId?: string;
      topic?: string;
      overwrites?: readonly OverwriteSet[];
    }
  | { kind: 'delete_channel'; guildId: string; channelId: string }
  | {
      kind: 'edit_overwrites';
      guildId: string;
      channelId: string;
      overwrites: readonly OverwriteSet[];
    }
  | {
      kind: 'send_message';
      guildId: string;
      channelId: string;
      content?: string;
      embeds?: readonly MessageEmbed[];
      allowedMentions?: AllowedMentions;
    }
  | { kind: 'pin_message'; guildId: string; channelId: string; messageId: string }
  | { kind: 'add_role_to_member'; guildId: string; memberId: string; roleId: string }
  | {
      kind: 'remove_role_from_member';
      guildId: string;
      memberId: string;
      roleId: string;
    }
  | {
      kind: 'move_channel';
      guildId: string;
      channelId: string;
      categoryId: string | null;
      position?: number;
    }
  | { kind: 'rename_channel'; guildId: string; channelId: string; name: string };

/**
 * The guild state captured before an op runs, for its compensation
 * (02 §5.9). Ops that need no prior state carry the empty variant of
 * their kind, so one execution's op, prior state and result always share
 * a kind.
 */
export type DiscordOpPrior =
  | { kind: 'create_role' }
  | { kind: 'delete_role'; name: string; color: number; hoist: boolean; mentionable: boolean }
  | { kind: 'create_category' }
  | { kind: 'delete_category'; name: string }
  | { kind: 'create_text_channel' }
  | { kind: 'delete_channel'; name: string; overwrites: readonly OverwriteSnapshot[] }
  | { kind: 'edit_overwrites'; overwrites: readonly OverwriteSnapshot[] }
  | { kind: 'send_message' }
  | { kind: 'pin_message' }
  | { kind: 'add_role_to_member' }
  | { kind: 'remove_role_from_member' }
  | { kind: 'move_channel'; categoryId: string | null; position: number | null }
  | { kind: 'rename_channel'; name: string };

/** What one op returned: the snowflakes it created, when it created any. */
export type DiscordOpResult =
  | { kind: 'create_role'; roleId: string; name: string }
  | { kind: 'delete_role' }
  | { kind: 'create_category'; categoryId: string; name: string }
  | { kind: 'delete_category' }
  | { kind: 'create_text_channel'; channelId: string; name: string }
  | { kind: 'delete_channel' }
  | { kind: 'edit_overwrites' }
  | { kind: 'send_message'; messageId: string }
  | { kind: 'pin_message' }
  | { kind: 'add_role_to_member' }
  | { kind: 'remove_role_from_member' }
  | { kind: 'move_channel' }
  | { kind: 'rename_channel' };

type OpFor<K extends DiscordOpKind> = Extract<DiscordOp, { kind: K }>;
type PriorFor<K extends DiscordOpKind> = Extract<DiscordOpPrior, { kind: K }>;
type ResultFor<K extends DiscordOpKind> = Extract<DiscordOpResult, { kind: K }>;

/**
 * One executed op: its inputs at the top level — the kind discriminant
 * and the same plain-data fields the port call takes — plus the prior
 * state captured before it ran and its result, correlated by kind: a
 * mismatched pair cannot be built.
 */
export type DiscordOpExecution = {
  [K in DiscordOpKind]: OpFor<K> & { prior: PriorFor<K>; result: ResultFor<K> };
}[DiscordOpKind];

/** One op's inputs and result, correlated by kind. */
export type DiscordOpOutcome = {
  [K in DiscordOpKind]: OpFor<K> & { result: ResultFor<K> };
}[DiscordOpKind];

/**
 * The compensation descriptor written to `job_steps.compensation` when a
 * reversible op's step is marked done (02 §5.9). The first four kinds are
 * the §5.9 compensations the jobs revert engine executes today; the
 * restores and best-effort recreations are the vocabulary the step
 * executor adopts (ENGINE_COMPENSATION_KINDS marks the line).
 */
export type DiscordCompensation =
  | { kind: 'delete_role'; roleId: string }
  | { kind: 'delete_channel'; channelId: string }
  | { kind: 'delete_category'; categoryId: string }
  | { kind: 'restore_overwrites'; channelId: string; overwrites: readonly OverwriteSnapshot[] }
  | {
      kind: 'restore_placement';
      channelId: string;
      categoryId: string | null;
      position: number | null;
    }
  | { kind: 'restore_name'; channelId: string; name: string }
  | { kind: 'remove_member_role'; memberId: string; roleId: string }
  | { kind: 'restore_member_role'; memberId: string; roleId: string }
  | { kind: 'recreate_role'; name: string; color: number; hoist: boolean; mentionable: boolean }
  | { kind: 'recreate_channel'; name: string; overwrites: readonly OverwriteSnapshot[] }
  | { kind: 'recreate_category'; name: string };

/**
 * The compensation kinds the `@drawbridge/jobs` revert engine executes
 * today (02 §5.9): the engine's own Compensation union minus its DB-row
 * kind. Everything else in {@link DiscordCompensation} lands with the
 * step executor.
 */
export const ENGINE_COMPENSATION_KINDS: readonly Extract<
  DiscordCompensation,
  { kind: Compensation['kind'] }
>['kind'][] = ['delete_role', 'delete_channel', 'delete_category', 'restore_overwrites'];

/** Static metadata for one op kind: how a step of this kind runs and reverts. */
export interface DiscordOpSpec {
  readonly kind: DiscordOpKind;
  /** Human label for journal rows, previews and decision screens. */
  readonly label: string;
  /** The port method the step executor calls (02 §4.3). */
  readonly portMethod: keyof DiscordPort;
  /** The ledger kind this op creates and records in `external_ids`, or null (02 §5.4). */
  readonly creates: ExternalId['kind'] | null;
  /** Whether a done step carries a compensation descriptor (02 §5.9). */
  readonly reversible: boolean;
  /** The compensation kind written with the step, or null when non-reversible. */
  readonly compensationKind: DiscordCompensation['kind'] | null;
  /** Preview warning text for the non-reversible list (02 §5.2), or null. */
  readonly warning: string | null;
}

/** The catalogue: one entry per step op kind. */
export const DISCORD_OPS: Readonly<Record<DiscordOpKind, DiscordOpSpec>> = {
  create_role: {
    kind: 'create_role',
    label: 'Create role',
    portMethod: 'createRole',
    creates: 'role',
    reversible: true,
    compensationKind: 'delete_role',
    warning: null,
  },
  delete_role: {
    kind: 'delete_role',
    label: 'Delete role',
    portMethod: 'deleteRole',
    creates: null,
    reversible: true,
    compensationKind: 'recreate_role',
    warning: null,
  },
  create_category: {
    kind: 'create_category',
    label: 'Create category',
    portMethod: 'createCategory',
    creates: 'category',
    reversible: true,
    compensationKind: 'delete_category',
    warning: null,
  },
  delete_category: {
    kind: 'delete_category',
    label: 'Delete category',
    portMethod: 'deleteCategory',
    creates: null,
    reversible: true,
    compensationKind: 'recreate_category',
    warning: null,
  },
  create_text_channel: {
    kind: 'create_text_channel',
    label: 'Create text channel',
    portMethod: 'createTextChannel',
    creates: 'text_channel',
    reversible: true,
    compensationKind: 'delete_channel',
    warning: null,
  },
  delete_channel: {
    kind: 'delete_channel',
    label: 'Delete channel',
    portMethod: 'deleteChannel',
    creates: null,
    reversible: true,
    compensationKind: 'recreate_channel',
    warning: null,
  },
  edit_overwrites: {
    kind: 'edit_overwrites',
    label: 'Edit channel permissions',
    portMethod: 'editOverwrites',
    creates: null,
    reversible: true,
    compensationKind: 'restore_overwrites',
    warning: null,
  },
  send_message: {
    kind: 'send_message',
    label: 'Send announcement message',
    portMethod: 'sendMessage',
    creates: 'message',
    reversible: false,
    compensationKind: null,
    warning: 'Posts an announcement message that a revert will not delete.',
  },
  pin_message: {
    kind: 'pin_message',
    label: 'Pin announcement message',
    portMethod: 'pinMessage',
    creates: null,
    reversible: false,
    compensationKind: null,
    warning: 'Pins a message that a revert will not unpin.',
  },
  add_role_to_member: {
    kind: 'add_role_to_member',
    label: 'Add role to member',
    portMethod: 'addRoleToMember',
    creates: null,
    reversible: true,
    compensationKind: 'remove_member_role',
    warning: null,
  },
  remove_role_from_member: {
    kind: 'remove_role_from_member',
    label: 'Remove role from member',
    portMethod: 'removeRoleFromMember',
    creates: null,
    reversible: true,
    compensationKind: 'restore_member_role',
    warning: null,
  },
  move_channel: {
    kind: 'move_channel',
    label: 'Move channel',
    portMethod: 'moveChannel',
    creates: null,
    reversible: true,
    compensationKind: 'restore_placement',
    warning: null,
  },
  rename_channel: {
    kind: 'rename_channel',
    label: 'Rename channel',
    portMethod: 'renameChannel',
    creates: null,
    reversible: true,
    compensationKind: 'restore_name',
    warning: null,
  },
};

/**
 * The audit reason tag every Discord write carries (02 §4.16):
 * `drb:{jobId}:{seq}`, inside Discord's 512-character limit.
 * Reconciliation searches the audit log for this exact tag (02 §5.6);
 * `@drawbridge/jobs`' `auditReasonTag` spells the same format and a test
 * asserts the two agree.
 */
export function opReason(jobId: string, seq: number): string {
  return `drb:${jobId}:${seq}`;
}

/**
 * The compensation descriptor for one executed op (02 §5.9): reversible
 * ops undo what the step did, built from the op's inputs, the prior state
 * captured before it ran and the IDs it created. The announcements return
 * null — a revert neither deletes nor unpins them.
 */
export function compensationFor(execution: DiscordOpExecution): DiscordCompensation | null {
  switch (execution.kind) {
    case 'create_role':
      return { kind: 'delete_role', roleId: execution.result.roleId };
    case 'delete_role':
      return {
        kind: 'recreate_role',
        name: execution.prior.name,
        color: execution.prior.color,
        hoist: execution.prior.hoist,
        mentionable: execution.prior.mentionable,
      };
    case 'create_category':
      return { kind: 'delete_category', categoryId: execution.result.categoryId };
    case 'delete_category':
      return { kind: 'recreate_category', name: execution.prior.name };
    case 'create_text_channel':
      return { kind: 'delete_channel', channelId: execution.result.channelId };
    case 'delete_channel':
      return {
        kind: 'recreate_channel',
        name: execution.prior.name,
        overwrites: execution.prior.overwrites,
      };
    case 'edit_overwrites':
      return {
        kind: 'restore_overwrites',
        channelId: execution.channelId,
        overwrites: execution.prior.overwrites,
      };
    case 'send_message':
    case 'pin_message':
      return null;
    case 'add_role_to_member':
      return {
        kind: 'remove_member_role',
        memberId: execution.memberId,
        roleId: execution.roleId,
      };
    case 'remove_role_from_member':
      return {
        kind: 'restore_member_role',
        memberId: execution.memberId,
        roleId: execution.roleId,
      };
    case 'move_channel':
      return {
        kind: 'restore_placement',
        channelId: execution.channelId,
        categoryId: execution.prior.categoryId,
        position: execution.prior.position,
      };
    case 'rename_channel':
      return {
        kind: 'restore_name',
        channelId: execution.channelId,
        name: execution.prior.name,
      };
  }
  return execution satisfies never;
}

/**
 * The external IDs one executed op created, recorded in
 * `job_steps.external_ids` before the step is marked done (02 §5.4).
 * Only creates record anything: the role, category, channel or message
 * snowflake with its ledger kind and the name reconciliation verifies.
 */
export function externalIdsFor(outcome: DiscordOpOutcome): readonly ExternalId[] {
  switch (outcome.kind) {
    case 'create_role':
      return [{ discordId: outcome.result.roleId, kind: 'role', name: outcome.result.name }];
    case 'create_category':
      return [
        {
          discordId: outcome.result.categoryId,
          kind: 'category',
          name: outcome.result.name,
        },
      ];
    case 'create_text_channel':
      return [
        {
          discordId: outcome.result.channelId,
          kind: 'text_channel',
          name: outcome.result.name,
        },
      ];
    case 'send_message':
      return [
        {
          discordId: outcome.result.messageId,
          kind: 'message',
          name: announcementName(outcome),
        },
      ];
    case 'delete_role':
    case 'delete_category':
    case 'delete_channel':
    case 'edit_overwrites':
    case 'pin_message':
    case 'add_role_to_member':
    case 'remove_role_from_member':
    case 'move_channel':
    case 'rename_channel':
      return [];
  }
  return outcome satisfies never;
}

/**
 * The ledger name for an announcement message: a short deterministic
 * label from its content, for journal displays. A message has no Discord
 * name of its own.
 */
function announcementName(op: OpFor<'send_message'>): string {
  const content = op.content?.trim();
  if (content === undefined || content === '') return '[announcement]';
  return content.length > 80 ? content.slice(0, 80) : content;
}

/**
 * The ops a revert cannot compensate (02 §5.9), for the preview's warning
 * list (02 §5.2): announcements post content a revert leaves in place.
 */
export function nonReversibleOps(): readonly DiscordOpSpec[] {
  return DISCORD_OP_KINDS.map((kind) => DISCORD_OPS[kind]).filter((spec) => !spec.reversible);
}
