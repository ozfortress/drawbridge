/**
 * The Discord port: every Discord REST call the worker makes, as plain
 * data (plan 02 §4.3).
 *
 * The worker is the sole Discord REST writer, and this port is the only
 * surface it writes through, so no discord.js or app type may cross it:
 * every input and output is plain serializable data, snowflakes are
 * strings end to end, permission bitfields are strings and timestamps
 * are ISO strings. Implementations (a later todo) map discord.js calls
 * onto these shapes and surface every failure as a `DiscordOperationError`
 * from `@drawbridge/jobs` (02 §4.13). This file deliberately references
 * no other module, which is what keeps the contract library-free — a test
 * fails the build if a module reference sneaks in.
 *
 * Every method that creates, updates or deletes an auditable object
 * carries the job's audit reason tag (02 §4.16); message sends and pins
 * are not auditable creates, so they carry none.
 */

/** One permission overwrite entry. Bitfields are strings: snowflake-safe and stable. */
export interface OverwriteSet {
  /** The role or member the overwrite applies to. */
  discordId: string;
  type: 'role' | 'member';
  /** Allowed permissions, as a bitfield string. */
  allow: string;
  /** Denied permissions, as a bitfield string. */
  deny: string;
}

/** The fields of a role the bot creates (02 §4.8 limits). */
export interface RoleCreate {
  /** 100 characters at most. */
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
}

/** What `createRole` reports back: the new role's snowflake and stored name. */
export interface RoleCreated {
  roleId: string;
  name: string;
}

/** The fields of a category channel the bot creates. */
export interface CategoryCreate {
  /** 100 characters at most. */
  name: string;
  overwrites?: readonly OverwriteSet[];
}

/** What `createCategory` reports back. */
export interface CategoryCreated {
  categoryId: string;
  name: string;
}

/** The fields of a text channel the bot creates. */
export interface TextChannelCreate {
  /**
   * Discord normalises text-channel names (lowercase, hyphens, 02 §4.10);
   * the port reports the stored form back, and reconciliation compares
   * normalised names against it.
   */
  name: string;
  categoryId?: string;
  topic?: string;
  overwrites?: readonly OverwriteSet[];
}

/** What `createTextChannel` reports back, with the slugified stored name. */
export interface TextChannelCreated {
  channelId: string;
  name: string;
}

/**
 * Explicit mention policy for every bot message (02 §4.9): `parse` lists
 * the mention classes to allow and specific IDs are listed, so nothing is
 * mentionable by accident.
 */
export interface AllowedMentions {
  parse: readonly ('roles' | 'users' | 'everyone')[];
  users?: readonly string[];
  roles?: readonly string[];
}

/** One embed field. */
export interface MessageEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/**
 * One embed, as plain JSON data. Only the fields the seeded templates
 * use are modelled; anything else a template needs is a catalogue change,
 * not an adapter hack.
 */
export interface MessageEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  /** ISO 8601. */
  timestamp?: string;
  footer?: { text: string; iconUrl?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; iconUrl?: string };
  fields?: readonly MessageEmbedField[];
}

/** A message the bot posts: content, embeds and the mention policy. */
export interface MessageSend {
  content?: string;
  embeds?: readonly MessageEmbed[];
  allowedMentions?: AllowedMentions;
}

/** What `sendMessage` reports back: the posted message's snowflake. */
export interface MessageSent {
  messageId: string;
}

/** Where a channel is moved to. */
export interface ChannelMove {
  /** The destination category, or null to move the channel out of any category. */
  categoryId: string | null;
  position?: number;
}

/** The audit-log actions the engine searches (02 §5.6, §4.16). */
export type AuditAction =
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATE'
  | 'CHANNEL_DELETE'
  | 'ROLE_CREATE'
  | 'ROLE_UPDATE'
  | 'ROLE_DELETE'
  | 'MEMBER_ROLE_UPDATE';

/** Filters for an audit-log read. */
export interface AuditQuery {
  action?: AuditAction;
  /**
   * Only entries whose audit reason is exactly this tag — reconciliation
   * searches `drb:{jobId}:{seq}` (02 §5.6). Discord cannot filter by
   * reason server-side; implementations read and filter.
   */
  reason?: string;
  limit?: number;
}

/** One audit-log entry, as plain data. */
export interface AuditEntry {
  /** The entry's own snowflake. */
  entryId: string;
  action: AuditAction;
  /** The object or member the entry acted on. */
  targetId: string;
  /** The target's name at action time, when the audit log kept one. */
  targetName: string | null;
  /** The audit reason the entry was created with, when any. */
  reason: string | null;
  /** ISO 8601. */
  at: string;
}

/** Filters for a channel-history read. */
export interface ChannelMessagesQuery {
  channelId: string;
  limit?: number;
  /** Only messages after this snowflake, exclusive. */
  after?: string;
  /** Only messages before this snowflake, exclusive. */
  before?: string;
}

/** One message of a channel's history, as plain data. */
export interface ChannelMessage {
  messageId: string;
  authorId: string;
  /** Whether the author is a bot account. */
  authorBot: boolean;
  /** The webhook that posted the message, when it was one. */
  webhookId: string | null;
  /** ISO 8601. */
  at: string;
}

/** One guild role, as plain data (the `guild_roles` cache columns, 03 §2.2). */
export interface GuildRole {
  roleId: string;
  name: string;
  position: number;
  /** Integrations (bots, boosters) own managed roles; they cannot be assigned or deleted. */
  managed: boolean;
  color: number;
}

/** The channel kinds the ledger distinguishes (03 §2.3). */
export type GuildChannelKind = 'text' | 'category' | 'other';

/**
 * One guild channel, as plain data. Channels the bot cannot view do not
 * appear at all (02 §4.11: obfuscated channels are "no access", never
 * "deleted"), and `overwrites` is the prior state an overwrite edit
 * captures (02 §5.9).
 */
export interface GuildChannel {
  channelId: string;
  name: string;
  kind: GuildChannelKind;
  /** The channel's category, or null when it has none. */
  categoryId: string | null;
  position: number;
  overwrites: readonly OverwriteSet[];
}

/** One guild member, as plain data. */
export interface GuildMember {
  memberId: string;
  /** The member's display name. */
  name: string;
  roleIds: readonly string[];
}

/**
 * The Discord port. Implemented by the worker over discord.js (02 §4.3);
 * faked by FakeDiscord in tests. Every write carries the job's audit
 * reason tag; failures surface as `DiscordOperationError`.
 */
export interface DiscordPort {
  /** Creates a guild role and reports its snowflake and stored name. */
  createRole(guildId: string, role: RoleCreate, reason: string): Promise<RoleCreated>;
  /** Deletes a guild role. */
  deleteRole(guildId: string, roleId: string, reason: string): Promise<void>;
  /** Creates a category channel and reports its snowflake and stored name. */
  createCategory(
    guildId: string,
    category: CategoryCreate,
    reason: string,
  ): Promise<CategoryCreated>;
  /** Deletes a category channel. */
  deleteCategory(guildId: string, categoryId: string, reason: string): Promise<void>;
  /** Creates a text channel and reports its snowflake and slugified stored name. */
  createTextChannel(
    guildId: string,
    channel: TextChannelCreate,
    reason: string,
  ): Promise<TextChannelCreated>;
  /** Deletes a channel of any kind. */
  deleteChannel(guildId: string, channelId: string, reason: string): Promise<void>;
  /** Replaces a channel's permission overwrites wholesale. */
  editOverwrites(
    guildId: string,
    channelId: string,
    overwrites: readonly OverwriteSet[],
    reason: string,
  ): Promise<void>;
  /** Posts a message with the explicit mention policy of 02 §4.9. */
  sendMessage(guildId: string, channelId: string, message: MessageSend): Promise<MessageSent>;
  /** Pins a message in its channel. */
  pinMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
  /** Adds a role to a member. */
  addRoleToMember(guildId: string, memberId: string, roleId: string, reason: string): Promise<void>;
  /** Removes a role from a member. */
  removeRoleFromMember(
    guildId: string,
    memberId: string,
    roleId: string,
    reason: string,
  ): Promise<void>;
  /** Moves a channel between categories, or out of any category. */
  moveChannel(guildId: string, channelId: string, move: ChannelMove, reason: string): Promise<void>;
  /** Renames a channel; Discord stores the slugified form for text channels. */
  renameChannel(guildId: string, channelId: string, name: string, reason: string): Promise<void>;
  /** Reads audit-log entries matching the query (02 §5.6). */
  fetchAuditEntries(guildId: string, query: AuditQuery): Promise<readonly AuditEntry[]>;
  /** Reads a page of a channel's history. */
  fetchChannelMessages(
    guildId: string,
    query: ChannelMessagesQuery,
  ): Promise<readonly ChannelMessage[]>;
  /** Reads every role of the guild. */
  fetchGuildRoles(guildId: string): Promise<readonly GuildRole[]>;
  /** Reads every channel the bot can view, overwrites included. */
  fetchGuildChannels(guildId: string): Promise<readonly GuildChannel[]>;
  /** Reads one member, or undefined when they are not in the guild. */
  fetchMember(guildId: string, memberId: string): Promise<GuildMember | undefined>;
}
