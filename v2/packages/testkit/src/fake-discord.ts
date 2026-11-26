/**
 * An in-memory `DiscordPort` for tests (plan 05 §3.2, P3 FakeDiscord).
 *
 * The fake models the guild surfaces the worker writes through: roles with
 * the hierarchy and managed-role rules, channels and categories with
 * permission overwrites as string bitfields, members with their roles,
 * per-channel message history, the audit log with reason tags, and Discord's
 * capacity limits — 250 roles including @everyone and managed roles, 500
 * channels including categories, 50 categories, 50 channels per category —
 * answered with codes 30005/30013, the same codes the executor's preflight
 * stands in with. Reads answer the state writes produced, so reconciliation,
 * revert and capacity logic compose against one consistent world.
 *
 * Every failure surfaces as a `DiscordOperationError` carrying the same
 * `ApiErrorSignal` the real adapter would build, so taxonomy, executor and
 * engine tests run unchanged. Faults are injected per method — the next call
 * only, or every call until cleared — covering 429 with `retry_after`, 403,
 * 404, 5xx, timeouts (a `network` signal; no timer is ever created) and
 * 30013. An injected fault mutates nothing and mints nothing, so a retry
 * after a cleared fault observes the id sequence the clean run would have.
 *
 * Snowflakes are deterministic and realistic: a minted id is
 * `(base + n) << 22` with fixed worker and process bits and the mint counter
 * in the low twelve bits, strictly monotonic, always 18 digits. The same
 * call sequence yields byte-identical ids across runs; the `seed` option
 * shifts the whole id space. Timestamps decode from the id's own bits into
 * monotonic ISO strings, so `AuditEntry.at` and message times need no clock.
 *
 * The gateway emitter records and dispatches realistic `t`/`s`/`d`
 * payloads — message create/update/delete, reaction add/remove, member
 * add/update/remove, channel and role events — for the later capture tests:
 * every port write emits the event Discord's gateway would deliver for it,
 * and the `humanMessage`/`editMessage`/`deleteMessage`/`addReaction`/
 * `removeReaction`/`memberJoins`/`memberLeaves` helpers simulate member
 * activity the same way. `emit` re-delivers any recorded event so duplicate
 * delivery is testable.
 *
 * There is no REST client and no network I/O: the class is plain state plus
 * the port's eighteen methods, plus the seed, fault, event and audit
 * helpers tests need. `removeBot`/`rejoinGuild` model the bot being kicked
 * from a guild: while it is gone every port call for that guild answers
 * 404/10004 Unknown Guild and a `GUILD_DELETE` event is delivered.
 */

import type {
  AuditAction,
  AuditEntry,
  AuditQuery,
  CategoryCreate,
  CategoryCreated,
  ChannelMessage,
  ChannelMessagesQuery,
  ChannelMove,
  DiscordPort,
  GuildChannel,
  GuildMember,
  GuildRole,
  MessageSend,
  MessageSent,
  OverwriteSet,
  RoleCreate,
  RoleCreated,
  TextChannelCreate,
  TextChannelCreated,
} from '@drawbridge/discord-ops';
import {
  MAX_CATEGORIES,
  MAX_CHANNELS,
  MAX_CHANNELS_PER_CATEGORY,
  MAX_ROLES,
} from '@drawbridge/domain';
import { type ApiErrorSignal, DiscordOperationError, normalizeDiscordName } from '@drawbridge/jobs';

/** The bot's user id when the options do not name one. */
export const DEFAULT_FAKE_BOT_USER_ID = '100000000000000001';

/**
 * The epoch the snowflake timestamp bits count from — chosen so ids are
 * exactly 18 digits and the decoded timestamps sit in 2026, like the
 * precision guard 02 §6.6 describes.
 */
const FAKE_EPOCH_MS = 1_667_000_000_000;

/** Where the timestamp bits start; `1e11 << 22` is the smallest 18-digit id. */
const VIRTUAL_START_MS = 100_000_000_000;

/** Fixed worker and process bits, as a real snowflake carries. */
const WORKER_BITS = 1n;
const PROCESS_BITS = 2n;

/** The Discord audit-log page size; also the fake's read cap. */
const AUDIT_PAGE_LIMIT = 100;

/** The Discord channel-history page size; also the fake's read cap. */
const MESSAGES_PAGE_LIMIT = 100;

/** One user as the gateway payloads carry them. */
export interface FakeGatewayUser {
  id: string;
  username: string;
  bot: boolean;
}

/** One custom emoji as reaction payloads carry them. */
export interface FakeGatewayEmoji {
  name: string;
  id: string | null;
  animated: boolean;
}

/** A MESSAGE_CREATE / MESSAGE_UPDATE payload. */
export interface FakeGatewayMessage {
  id: string;
  channel_id: string;
  guild_id: string;
  author: FakeGatewayUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  pinned: boolean;
  mention_everyone: boolean;
  embeds: readonly unknown[];
  webhook_id: string | null;
}

/** A MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE payload. */
export interface FakeGatewayReaction {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id: string;
  emoji: FakeGatewayEmoji;
}

/** A CHANNEL_CREATE / CHANNEL_UPDATE / CHANNEL_DELETE payload. */
export interface FakeGatewayChannel {
  id: string;
  guild_id: string;
  name: string;
  /** Discord's wire types: 0 is text, 4 is a category. */
  type: 0 | 4;
  parent_id: string | null;
  position: number;
  permission_overwrites: readonly {
    id: string;
    /** Discord's wire overwrite types: 0 is role, 1 is member. */
    type: 0 | 1;
    allow: string;
    deny: string;
  }[];
}

/** A GUILD_ROLE_CREATE / GUILD_ROLE_UPDATE role object. */
export interface FakeGatewayRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  color: number;
}

/** A GUILD_MEMBER_ADD / GUILD_MEMBER_UPDATE payload. */
export interface FakeGatewayMember {
  user: FakeGatewayUser;
  guild_id: string;
  roles: readonly string[];
  joined_at: string | null;
}

/** A GUILD_DELETE payload: the guild is gone for this bot. */
export interface FakeGatewayGuildDelete {
  id: string;
}

/** The gateway events the fake delivers, discriminated on `t`. */
export type FakeGatewayEvent =
  | { t: 'MESSAGE_CREATE'; s: number; d: FakeGatewayMessage }
  | { t: 'MESSAGE_UPDATE'; s: number; d: FakeGatewayMessage }
  | { t: 'MESSAGE_DELETE'; s: number; d: { id: string; channel_id: string; guild_id: string } }
  | { t: 'MESSAGE_REACTION_ADD'; s: number; d: FakeGatewayReaction }
  | { t: 'MESSAGE_REACTION_REMOVE'; s: number; d: FakeGatewayReaction }
  | { t: 'GUILD_MEMBER_ADD'; s: number; d: FakeGatewayMember }
  | { t: 'GUILD_MEMBER_UPDATE'; s: number; d: FakeGatewayMember }
  | { t: 'GUILD_MEMBER_REMOVE'; s: number; d: { user: FakeGatewayUser; guild_id: string } }
  | { t: 'GUILD_DELETE'; s: number; d: FakeGatewayGuildDelete }
  | { t: 'CHANNEL_CREATE'; s: number; d: FakeGatewayChannel }
  | { t: 'CHANNEL_UPDATE'; s: number; d: FakeGatewayChannel }
  | { t: 'CHANNEL_DELETE'; s: number; d: FakeGatewayChannel }
  | { t: 'GUILD_ROLE_CREATE'; s: number; d: { guild_id: string; role: FakeGatewayRole } }
  | { t: 'GUILD_ROLE_UPDATE'; s: number; d: { guild_id: string; role: FakeGatewayRole } }
  | { t: 'GUILD_ROLE_DELETE'; s: number; d: { guild_id: string; role_id: string } };

/** Every port method, as the fault injector names them. */
export type FakeDiscordMethodName = keyof DiscordPort;

/** One seeded role fixture; ids are used as given or minted deterministically. */
export interface FakeRoleSeed {
  roleId?: string;
  name: string;
  position?: number;
  managed?: boolean;
  color?: number;
}

/** One seeded channel fixture; text names are stored slugified, like Discord. */
export interface FakeChannelSeed {
  channelId?: string;
  name: string;
  kind: 'text' | 'category';
  categoryId?: string;
  position?: number;
  overwrites?: readonly OverwriteSet[];
  topic?: string;
}

/** One seeded member fixture. */
export interface FakeMemberSeed {
  memberId?: string;
  name: string;
  roleIds?: readonly string[];
}

/** What `seedGuild` lays down: fixture state, never audited, never emitted. */
export interface FakeGuildSeed {
  /** The bot's member record; its highest role decides hierarchy refusals. */
  botMember?: FakeMemberSeed;
  roles?: readonly FakeRoleSeed[];
  channels?: readonly FakeChannelSeed[];
  members?: readonly FakeMemberSeed[];
}

/** Options accepted by `new FakeDiscord`. */
export interface FakeDiscordOptions {
  /** Shifts every minted snowflake's timestamp bits by this many ms. Default 0. */
  seed?: number;
  /** The bot's user id: message authorship and hierarchy checks. */
  botUserId?: string;
}

interface FakeRoleState {
  roleId: string;
  name: string;
  position: number;
  managed: boolean;
  color: number;
}

interface FakeChannelState {
  channelId: string;
  name: string;
  kind: 'text' | 'category';
  categoryId: string | null;
  position: number;
  overwrites: OverwriteSet[];
  topic: string | null;
}

interface FakeMemberState {
  memberId: string;
  name: string;
  roleIds: string[];
}

interface FakeMessageState {
  messageId: string;
  channelId: string;
  authorId: string;
  username: string;
  authorBot: boolean;
  content: string;
  embeds: readonly unknown[];
  at: string;
  editedAt: string | null;
  pinned: boolean;
  webhookId: string | null;
  /** Reaction users by emoji key (`name:id`). */
  reactions: Map<string, Set<string>>;
}

interface FakeGuildState {
  guildId: string;
  botMemberId: string;
  /** False once the bot was removed: every port call answers 10004. */
  botPresent: boolean;
  /** The bot member as it was seeded, restored by `rejoinGuild`. */
  removedBot: { name: string; roleIds: readonly string[] } | null;
  roles: Map<string, FakeRoleState>;
  channels: Map<string, FakeChannelState>;
  members: Map<string, FakeMemberState>;
  messages: FakeMessageState[];
  audit: AuditEntry[];
}

/** Decodes a minted snowflake's timestamp bits into an ISO string. */
function snowflakeAt(id: string): string {
  return new Date(FAKE_EPOCH_MS + Number(BigInt(id) >> 22n)).toISOString();
}

/** Snowflake order, numeric not lexicographic. */
function compareSnowflakes(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Copies overwrite entries so reads and writes never alias. */
function copyOverwrites(overwrites: readonly OverwriteSet[]): OverwriteSet[] {
  return overwrites.map((overwrite) => ({ ...overwrite }));
}

/** The stored form of a channel or role name (02 §4.10, reconciled names). */
function storedChannelName(kind: 'text' | 'category', name: string): string {
  return kind === 'text' ? normalizeDiscordName('text_channel', name) : name.trim();
}

/**
 * The in-memory Discord guild world, implementing the worker's
 * {@link DiscordPort} exactly. Deterministic: two instances seeded the same
 * and driven the same produce identical ids, audit entries and events.
 */
export class FakeDiscord implements DiscordPort {
  readonly botUserId: string;

  private readonly baseVirtualMs: number;
  private minted = 0;
  private eventSeq = 0;
  private readonly guilds = new Map<string, FakeGuildState>();
  private readonly onceFaults = new Map<FakeDiscordMethodName, ApiErrorSignal>();
  private readonly steadyFaults = new Map<FakeDiscordMethodName, ApiErrorSignal>();
  private readonly eventLog: FakeGatewayEvent[] = [];
  private readonly listeners = new Set<(event: FakeGatewayEvent) => void>();

  constructor(options: FakeDiscordOptions = {}) {
    this.baseVirtualMs = VIRTUAL_START_MS + (options.seed ?? 0);
    this.botUserId = options.botUserId ?? DEFAULT_FAKE_BOT_USER_ID;
  }

  // ---------------------------------------------------------------------
  // Seeding and inspection helpers
  // ---------------------------------------------------------------------

  /** Lays down fixture guild state. Fixture adds audit nothing, emit nothing. */
  seedGuild(guildId: string, seed: FakeGuildSeed = {}): void {
    const guild = this.guildState(guildId);
    const botMember = seed.botMember;
    if (botMember !== undefined) {
      const memberId = botMember.memberId ?? this.botUserId;
      guild.botMemberId = memberId;
      guild.members.set(memberId, {
        memberId,
        name: botMember.name,
        roleIds: [...(botMember.roleIds ?? [])],
      });
    }
    for (const role of seed.roles ?? []) {
      const roleId = role.roleId ?? this.mintId();
      guild.roles.set(roleId, {
        roleId,
        name: role.name.trim(),
        position: role.position ?? 1,
        managed: role.managed ?? false,
        color: role.color ?? 0,
      });
    }
    for (const member of seed.members ?? []) {
      const memberId = member.memberId ?? this.mintId();
      guild.members.set(memberId, {
        memberId,
        name: member.name,
        roleIds: [...(member.roleIds ?? [])],
      });
    }
    for (const channel of seed.channels ?? []) {
      const channelId = channel.channelId ?? this.mintId();
      guild.channels.set(channelId, {
        channelId,
        name: storedChannelName(channel.kind, channel.name),
        kind: channel.kind,
        categoryId: channel.categoryId ?? null,
        position: channel.position ?? this.appendPosition(guild, channel.categoryId ?? null),
        overwrites: copyOverwrites(channel.overwrites ?? []),
        topic: channel.topic ?? null,
      });
    }
  }

  /** Every event the fake has delivered, in delivery order. */
  emittedEvents(): readonly FakeGatewayEvent[] {
    return [...this.eventLog];
  }

  /** Subscribes to events as the gateway would deliver them. Returns the unsubscribe. */
  onEvent(listener: (event: FakeGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-delivers an event exactly as recorded — how duplicate delivery is tested. */
  emit(event: FakeGatewayEvent): void {
    this.deliver(event);
  }

  /**
   * The next call of `method` fails with the signal, then the injection clears.
   * The call mutates nothing and mints nothing, so a clean retry observes the
   * id sequence a never-faulted run would have.
   */
  failOnce(method: FakeDiscordMethodName, signal: ApiErrorSignal): void {
    this.onceFaults.set(method, signal);
  }

  /** Every call of `method` fails with the signal until `clearFaults`. */
  failWhile(method: FakeDiscordMethodName, signal: ApiErrorSignal): void {
    this.steadyFaults.set(method, signal);
  }

  /** Clears every injected fault. */
  clearFaults(): void {
    this.onceFaults.clear();
    this.steadyFaults.clear();
  }

  // ---------------------------------------------------------------------
  // Human-activity helpers (state plus gateway events, no audit entries)
  // ---------------------------------------------------------------------

  /** A member posts a message; returns its id. */
  humanMessage(
    guildId: string,
    channelId: string,
    message: { authorId: string; username?: string; content?: string },
  ): string {
    const guild = this.guildState(guildId);
    const channel = this.findChannel(guild, channelId);
    const member = guild.members.get(message.authorId);
    const messageId = this.mintId();
    const state: FakeMessageState = {
      messageId,
      channelId: channel.channelId,
      authorId: message.authorId,
      username: message.username ?? member?.name ?? message.authorId,
      authorBot: false,
      content: message.content ?? '',
      embeds: [],
      at: snowflakeAt(messageId),
      editedAt: null,
      pinned: false,
      webhookId: null,
      reactions: new Map(),
    };
    guild.messages.push(state);
    this.deliver({
      t: 'MESSAGE_CREATE',
      s: this.nextEventSeq(),
      d: this.messagePayload(guildId, state),
    });
    return messageId;
  }

  /** A member edits their message. */
  editMessage(guildId: string, channelId: string, messageId: string, content: string): void {
    const guild = this.guildState(guildId);
    this.findChannel(guild, channelId);
    const state = this.findMessage(guild, channelId, messageId);
    state.content = content;
    state.editedAt = this.tick();
    this.deliver({
      t: 'MESSAGE_UPDATE',
      s: this.nextEventSeq(),
      d: this.messagePayload(guildId, state),
    });
  }

  /** A message is deleted (a member or a moderator removing it). */
  deleteMessage(guildId: string, channelId: string, messageId: string): void {
    const guild = this.guildState(guildId);
    this.findChannel(guild, channelId);
    const state = this.findMessage(guild, channelId, messageId);
    guild.messages.splice(guild.messages.indexOf(state), 1);
    this.deliver({
      t: 'MESSAGE_DELETE',
      s: this.nextEventSeq(),
      d: { id: messageId, channel_id: channelId, guild_id: guildId },
    });
  }

  /** A member reacts to a message. */
  addReaction(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    emoji: { name: string; id?: string | null; animated?: boolean },
  ): void {
    this.react(guildId, channelId, messageId, userId, emoji, 'MESSAGE_REACTION_ADD');
  }

  /** A member removes their reaction. */
  removeReaction(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    emoji: { name: string; id?: string | null; animated?: boolean },
  ): void {
    this.react(guildId, channelId, messageId, userId, emoji, 'MESSAGE_REACTION_REMOVE');
  }

  /** A member joins the guild. */
  memberJoins(guildId: string, member: { memberId: string; name: string }): void {
    const guild = this.guildState(guildId);
    guild.members.set(member.memberId, {
      memberId: member.memberId,
      name: member.name,
      roleIds: [],
    });
    this.deliver({
      t: 'GUILD_MEMBER_ADD',
      s: this.nextEventSeq(),
      d: {
        user: { id: member.memberId, username: member.name, bot: false },
        guild_id: guildId,
        roles: [],
        joined_at: this.tick(),
      },
    });
  }

  /** A member leaves (or is removed from) the guild. */
  memberLeaves(guildId: string, memberId: string): void {
    const guild = this.guildState(guildId);
    const member = guild.members.get(memberId);
    if (member === undefined) return;
    guild.members.delete(memberId);
    this.deliver({
      t: 'GUILD_MEMBER_REMOVE',
      s: this.nextEventSeq(),
      d: { user: { id: memberId, username: member.name, bot: false }, guild_id: guildId },
    });
  }

  /**
   * Removes the bot from the guild: every later port call for the guild
   * answers 404/10004 Unknown Guild, exactly as Discord does for a bot that
   * is no longer a member. The guild's other state stays as it was, and a
   * `GUILD_DELETE` event is delivered as the gateway would. `rejoinGuild`
   * restores the member as it was seeded.
   */
  removeBot(guildId: string): void {
    const guild = this.guildStateUnchecked(guildId);
    const bot = guild.members.get(guild.botMemberId);
    guild.removedBot = bot === undefined ? null : { name: bot.name, roleIds: [...bot.roleIds] };
    guild.members.delete(guild.botMemberId);
    guild.botPresent = false;
    this.deliver({ t: 'GUILD_DELETE', s: this.nextEventSeq(), d: { id: guildId } });
  }

  /** Puts the bot back in the guild with the member record it had before. */
  rejoinGuild(guildId: string): void {
    const guild = this.guildStateUnchecked(guildId);
    const bot = guild.removedBot;
    guild.members.set(guild.botMemberId, {
      memberId: guild.botMemberId,
      name: bot?.name ?? 'drawbridge',
      roleIds: [...(bot?.roleIds ?? [])],
    });
    guild.removedBot = null;
    guild.botPresent = true;
  }

  // ---------------------------------------------------------------------
  // The DiscordPort: writes
  // ---------------------------------------------------------------------

  async createRole(guildId: string, role: RoleCreate, reason: string): Promise<RoleCreated> {
    await this.gate('createRole');
    const guild = this.guildState(guildId);
    if (guild.roles.size >= MAX_ROLES) {
      this.capacityRefused(30005, `Maximum number of guild roles reached (${MAX_ROLES})`);
    }
    // Discord inserts a created role just above @everyone and shifts the rest.
    for (const existing of guild.roles.values()) {
      if (existing.position >= 1) existing.position += 1;
    }
    const roleId = this.mintId();
    const name = role.name.trim();
    guild.roles.set(roleId, {
      roleId,
      name,
      position: 1,
      managed: false,
      color: role.color ?? 0,
    });
    this.recordAudit(guild, 'ROLE_CREATE', roleId, name, reason);
    this.deliver({
      t: 'GUILD_ROLE_CREATE',
      s: this.nextEventSeq(),
      d: { guild_id: guildId, role: this.rolePayload(guild, roleId) },
    });
    return { roleId, name };
  }

  async deleteRole(guildId: string, roleId: string, reason: string): Promise<void> {
    await this.gate('deleteRole');
    const guild = this.guildState(guildId);
    const role = this.findRole(guild, roleId);
    if (roleId === guildId) {
      this.permissionRefused('the @everyone role cannot be deleted');
    }
    if (role.managed) {
      this.permissionRefused(
        `role '${role.name}' is managed by an integration and cannot be deleted`,
      );
    }
    this.requireAboveBot(guild, role, 'deleted');
    guild.roles.delete(roleId);
    for (const member of guild.members.values()) {
      member.roleIds = member.roleIds.filter((held) => held !== roleId);
    }
    for (const existing of guild.roles.values()) {
      if (existing.position > role.position) existing.position -= 1;
    }
    this.recordAudit(guild, 'ROLE_DELETE', roleId, role.name, reason);
    this.deliver({
      t: 'GUILD_ROLE_DELETE',
      s: this.nextEventSeq(),
      d: { guild_id: guildId, role_id: roleId },
    });
  }

  async createCategory(
    guildId: string,
    category: CategoryCreate,
    reason: string,
  ): Promise<CategoryCreated> {
    await this.gate('createCategory');
    const guild = this.guildState(guildId);
    this.refuseOverChannelCapacity(guild);
    if (this.categoryCount(guild) >= MAX_CATEGORIES) {
      this.capacityRefused(30013, `Maximum number of categories reached (${MAX_CATEGORIES})`);
    }
    const categoryId = this.mintId();
    const name = category.name.trim();
    guild.channels.set(categoryId, {
      channelId: categoryId,
      name,
      kind: 'category',
      categoryId: null,
      position: this.appendPosition(guild, null),
      overwrites: copyOverwrites(category.overwrites ?? []),
      topic: null,
    });
    this.recordAudit(guild, 'CHANNEL_CREATE', categoryId, name, reason);
    this.deliver({
      t: 'CHANNEL_CREATE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, categoryId),
    });
    return { categoryId, name };
  }

  async deleteCategory(guildId: string, categoryId: string, reason: string): Promise<void> {
    await this.gate('deleteCategory');
    const guild = this.guildState(guildId);
    this.deleteChannelState(guildId, guild, categoryId, reason);
  }

  async createTextChannel(
    guildId: string,
    channel: TextChannelCreate,
    reason: string,
  ): Promise<TextChannelCreated> {
    await this.gate('createTextChannel');
    const guild = this.guildState(guildId);
    this.refuseOverChannelCapacity(guild);
    let categoryId: string | null = null;
    if (channel.categoryId !== undefined) {
      const parent = this.findChannel(guild, channel.categoryId);
      if (parent.kind !== 'category') {
        this.invalidRefused('the parent channel must be a category');
      }
      categoryId = parent.channelId;
      if (this.childrenOf(guild, categoryId).length >= MAX_CHANNELS_PER_CATEGORY) {
        this.capacityRefused(
          30013,
          `Maximum number of channels in a category reached (${MAX_CHANNELS_PER_CATEGORY})`,
        );
      }
    }
    const channelId = this.mintId();
    const name = storedChannelName('text', channel.name);
    guild.channels.set(channelId, {
      channelId,
      name,
      kind: 'text',
      categoryId,
      position: this.appendPosition(guild, categoryId),
      overwrites: copyOverwrites(channel.overwrites ?? []),
      topic: channel.topic ?? null,
    });
    this.recordAudit(guild, 'CHANNEL_CREATE', channelId, name, reason);
    this.deliver({
      t: 'CHANNEL_CREATE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, channelId),
    });
    return { channelId, name };
  }

  async deleteChannel(guildId: string, channelId: string, reason: string): Promise<void> {
    await this.gate('deleteChannel');
    const guild = this.guildState(guildId);
    this.deleteChannelState(guildId, guild, channelId, reason);
  }

  async editOverwrites(
    guildId: string,
    channelId: string,
    overwrites: readonly OverwriteSet[],
    reason: string,
  ): Promise<void> {
    await this.gate('editOverwrites');
    const guild = this.guildState(guildId);
    const channel = this.findChannel(guild, channelId);
    channel.overwrites = copyOverwrites(overwrites);
    this.recordAudit(guild, 'CHANNEL_UPDATE', channelId, channel.name, reason);
    this.deliver({
      t: 'CHANNEL_UPDATE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, channelId),
    });
  }

  async sendMessage(
    guildId: string,
    channelId: string,
    message: MessageSend,
  ): Promise<MessageSent> {
    await this.gate('sendMessage');
    const guild = this.guildState(guildId);
    const channel = this.findChannel(guild, channelId);
    if (channel.kind !== 'text') {
      this.invalidRefused('cannot send a message in a category channel');
    }
    const messageId = this.mintId();
    const state: FakeMessageState = {
      messageId,
      channelId,
      authorId: this.botUserId,
      username: guild.members.get(this.botUserId)?.name ?? 'drawbridge',
      authorBot: true,
      content: message.content ?? '',
      embeds: [...(message.embeds ?? [])],
      at: snowflakeAt(messageId),
      editedAt: null,
      pinned: false,
      webhookId: null,
      reactions: new Map(),
    };
    guild.messages.push(state);
    this.deliver({
      t: 'MESSAGE_CREATE',
      s: this.nextEventSeq(),
      d: this.messagePayload(guildId, state),
    });
    return { messageId };
  }

  async pinMessage(guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.gate('pinMessage');
    const guild = this.guildState(guildId);
    this.findChannel(guild, channelId);
    const state = this.findMessage(guild, channelId, messageId);
    state.pinned = true;
    this.deliver({
      t: 'MESSAGE_UPDATE',
      s: this.nextEventSeq(),
      d: this.messagePayload(guildId, state),
    });
  }

  async addRoleToMember(
    guildId: string,
    memberId: string,
    roleId: string,
    reason: string,
  ): Promise<void> {
    await this.gate('addRoleToMember');
    const guild = this.guildState(guildId);
    const member = this.findMember(guild, memberId);
    const role = this.findRole(guild, roleId);
    if (role.managed) {
      this.permissionRefused(
        `role '${role.name}' is managed by an integration and cannot be assigned`,
      );
    }
    this.requireAboveBot(guild, role, 'assigned');
    if (member.roleIds.includes(roleId)) return;
    member.roleIds.push(roleId);
    this.recordAudit(guild, 'MEMBER_ROLE_UPDATE', memberId, member.name, reason);
    this.deliver({
      t: 'GUILD_MEMBER_UPDATE',
      s: this.nextEventSeq(),
      d: this.memberPayload(guildId, member),
    });
  }

  async removeRoleFromMember(
    guildId: string,
    memberId: string,
    roleId: string,
    reason: string,
  ): Promise<void> {
    await this.gate('removeRoleFromMember');
    const guild = this.guildState(guildId);
    const member = this.findMember(guild, memberId);
    const role = this.findRole(guild, roleId);
    if (role.managed) {
      this.permissionRefused(
        `role '${role.name}' is managed by an integration and cannot be assigned`,
      );
    }
    this.requireAboveBot(guild, role, 'removed');
    if (!member.roleIds.includes(roleId)) return;
    member.roleIds = member.roleIds.filter((held) => held !== roleId);
    this.recordAudit(guild, 'MEMBER_ROLE_UPDATE', memberId, member.name, reason);
    this.deliver({
      t: 'GUILD_MEMBER_UPDATE',
      s: this.nextEventSeq(),
      d: this.memberPayload(guildId, member),
    });
  }

  async moveChannel(
    guildId: string,
    channelId: string,
    move: ChannelMove,
    reason: string,
  ): Promise<void> {
    await this.gate('moveChannel');
    const guild = this.guildState(guildId);
    const channel = this.findChannel(guild, channelId);
    if (move.categoryId !== null) {
      const parent = this.findChannel(guild, move.categoryId);
      if (parent.kind !== 'category') {
        this.invalidRefused('the parent channel must be a category');
      }
      // A move inside the channel's own category is a reposition: the moving
      // channel is already one of the parent's children, so the per-category
      // cap cannot bite. Only entering a different category can exceed it,
      // and that count excludes the moving channel.
      const entering = parent.channelId !== channel.categoryId;
      if (
        entering &&
        this.childrenOf(guild, parent.channelId).length >= MAX_CHANNELS_PER_CATEGORY
      ) {
        this.capacityRefused(
          30013,
          `Maximum number of channels in a category reached (${MAX_CHANNELS_PER_CATEGORY})`,
        );
      }
      channel.categoryId = parent.channelId;
    } else {
      channel.categoryId = null;
    }
    channel.position = move.position ?? this.appendPosition(guild, channel.categoryId);
    this.recordAudit(guild, 'CHANNEL_UPDATE', channelId, channel.name, reason);
    this.deliver({
      t: 'CHANNEL_UPDATE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, channelId),
    });
  }

  async renameChannel(
    guildId: string,
    channelId: string,
    name: string,
    reason: string,
  ): Promise<void> {
    await this.gate('renameChannel');
    const guild = this.guildState(guildId);
    const channel = this.findChannel(guild, channelId);
    channel.name = storedChannelName(channel.kind, name);
    this.recordAudit(guild, 'CHANNEL_UPDATE', channelId, channel.name, reason);
    this.deliver({
      t: 'CHANNEL_UPDATE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, channelId),
    });
  }

  // ---------------------------------------------------------------------
  // The DiscordPort: reads
  // ---------------------------------------------------------------------

  async fetchAuditEntries(guildId: string, query: AuditQuery): Promise<readonly AuditEntry[]> {
    await this.gate('fetchAuditEntries');
    const guild = this.guildState(guildId);
    const limit = this.pageLimit(query.limit, AUDIT_PAGE_LIMIT);
    const matches = guild.audit.filter((entry) => {
      if (query.action !== undefined && entry.action !== query.action) return false;
      // Discord cannot filter by reason server-side; the port reads and filters.
      if (query.reason !== undefined && entry.reason !== query.reason) return false;
      return true;
    });
    // Discord's audit log pages newest first; the fake keeps that order.
    return matches.slice(-limit).reverse();
  }

  async fetchChannelMessages(
    guildId: string,
    query: ChannelMessagesQuery,
  ): Promise<readonly ChannelMessage[]> {
    await this.gate('fetchChannelMessages');
    const guild = this.guildState(guildId);
    this.findChannel(guild, query.channelId);
    const limit = this.pageLimit(query.limit, MESSAGES_PAGE_LIMIT);
    const matches = guild.messages
      .filter((message) => message.channelId === query.channelId)
      .filter(
        (message) =>
          query.after === undefined || compareSnowflakes(message.messageId, query.after) > 0,
      )
      .filter(
        (message) =>
          query.before === undefined || compareSnowflakes(message.messageId, query.before) < 0,
      )
      .sort((a, b) => compareSnowflakes(b.messageId, a.messageId));
    return matches.slice(0, limit).map((message) => ({
      messageId: message.messageId,
      authorId: message.authorId,
      authorBot: message.authorBot,
      webhookId: message.webhookId,
      at: message.at,
    }));
  }

  async fetchGuildRoles(guildId: string): Promise<readonly GuildRole[]> {
    await this.gate('fetchGuildRoles');
    const guild = this.guildState(guildId);
    return [...guild.roles.values()]
      .sort((a, b) => a.position - b.position || compareSnowflakes(a.roleId, b.roleId))
      .map((role) => ({
        roleId: role.roleId,
        name: role.name,
        position: role.position,
        managed: role.managed,
        color: role.color,
      }));
  }

  async fetchGuildChannels(guildId: string): Promise<readonly GuildChannel[]> {
    await this.gate('fetchGuildChannels');
    const guild = this.guildState(guildId);
    return [...guild.channels.values()]
      .sort((a, b) => a.position - b.position || compareSnowflakes(a.channelId, b.channelId))
      .map((channel) => ({
        channelId: channel.channelId,
        name: channel.name,
        kind: channel.kind,
        categoryId: channel.categoryId,
        position: channel.position,
        overwrites: copyOverwrites(channel.overwrites),
      }));
  }

  async fetchMember(guildId: string, memberId: string): Promise<GuildMember | undefined> {
    await this.gate('fetchMember');
    const guild = this.guildState(guildId);
    const member = guild.members.get(memberId);
    if (member === undefined) return undefined;
    return { memberId: member.memberId, name: member.name, roleIds: [...member.roleIds] };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** The guild's state, created on first touch with @everyone in place. */
  private guildState(guildId: string): FakeGuildState {
    const guild = this.guildStateUnchecked(guildId);
    if (!guild.botPresent) {
      // A bot that was removed hears what Discord answers: 404/10004.
      throw new DiscordOperationError({ status: 404, code: 10004, message: 'Unknown Guild' });
    }
    return guild;
  }

  /** The guild's state without the bot-membership check. */
  private guildStateUnchecked(guildId: string): FakeGuildState {
    let guild = this.guilds.get(guildId);
    if (guild === undefined) {
      guild = {
        guildId,
        botMemberId: this.botUserId,
        botPresent: true,
        removedBot: null,
        roles: new Map(),
        channels: new Map(),
        members: new Map(),
        messages: [],
        audit: [],
      };
      // @everyone's id is the guild's own id, position 0, undeletable.
      guild.roles.set(guildId, {
        roleId: guildId,
        name: '@everyone',
        position: 0,
        managed: false,
        color: 0,
      });
      this.guilds.set(guildId, guild);
    }
    return guild;
  }

  /** The next minted snowflake: deterministic, monotonic, 18 digits. */
  private mintId(): string {
    this.minted += 1;
    const bits = BigInt(this.baseVirtualMs + this.minted) << 22n;
    return (
      bits |
      (WORKER_BITS << 17n) |
      (PROCESS_BITS << 12n) |
      BigInt(this.minted & 0xfff)
    ).toString();
  }

  /** Advances the virtual clock one mint; returns the new time as ISO. */
  private tick(): string {
    return snowflakeAt(this.mintId());
  }

  private nextEventSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  /** Throws the injected fault for `method`, when one is armed. */
  private async gate(method: FakeDiscordMethodName): Promise<void> {
    const once = this.onceFaults.get(method);
    if (once !== undefined) {
      this.onceFaults.delete(method);
      throw new DiscordOperationError(once);
    }
    const steady = this.steadyFaults.get(method);
    if (steady !== undefined) {
      throw new DiscordOperationError(steady);
    }
  }

  /** Records one audit entry with the write's reason tag; `at` decodes from the entry's own snowflake. */
  private recordAudit(
    guild: FakeGuildState,
    action: AuditAction,
    targetId: string,
    targetName: string | null,
    reason: string,
  ): void {
    const entryId = this.mintId();
    guild.audit.push({ entryId, action, targetId, targetName, reason, at: snowflakeAt(entryId) });
  }

  /** The stored channel state, or Discord's Unknown Channel answer. */
  private findChannel(guild: FakeGuildState, channelId: string): FakeChannelState {
    const channel = guild.channels.get(channelId);
    if (channel === undefined) {
      throw new DiscordOperationError({ status: 404, code: 10003, message: 'Unknown Channel' });
    }
    return channel;
  }

  /** The stored role state, or Discord's Unknown Role answer. */
  private findRole(guild: FakeGuildState, roleId: string): FakeRoleState {
    const role = guild.roles.get(roleId);
    if (role === undefined) {
      throw new DiscordOperationError({ status: 404, code: 10011, message: 'Unknown Role' });
    }
    return role;
  }

  /** The stored member state, or Discord's Unknown Member answer. */
  private findMember(guild: FakeGuildState, memberId: string): FakeMemberState {
    const member = guild.members.get(memberId);
    if (member === undefined) {
      throw new DiscordOperationError({ status: 404, code: 10007, message: 'Unknown Member' });
    }
    return member;
  }

  /** The stored message state, or Discord's Unknown Message answer. */
  private findMessage(
    guild: FakeGuildState,
    channelId: string,
    messageId: string,
  ): FakeMessageState {
    const message = guild.messages.find(
      (candidate) => candidate.messageId === messageId && candidate.channelId === channelId,
    );
    if (message === undefined) {
      throw new DiscordOperationError({ status: 404, code: 10008, message: 'Unknown Message' });
    }
    return message;
  }

  /** 403/50013: hierarchy and managed-role refusals, as the executor words them. */
  private permissionRefused(message: string): never {
    throw new DiscordOperationError({ status: 403, code: 50013, message });
  }

  /** 400/50035: structurally invalid requests. */
  private invalidRefused(message: string): never {
    throw new DiscordOperationError({ status: 400, code: 50035, message });
  }

  /** 400/30005 or 30013: the capacity answers, with the limits named. */
  private capacityRefused(code: 30005 | 30013, message: string): never {
    throw new DiscordOperationError({ status: 400, code, message });
  }

  /** The total-channel cap (categories count as channels) for any create. */
  private refuseOverChannelCapacity(guild: FakeGuildState): void {
    if (guild.channels.size >= MAX_CHANNELS) {
      this.capacityRefused(30013, `Maximum number of guild channels reached (${MAX_CHANNELS})`);
    }
  }

  /** Throws unless the bot's highest role sits strictly above the target. */
  private requireAboveBot(guild: FakeGuildState, role: FakeRoleState, verb: string): void {
    const bot = guild.members.get(guild.botMemberId);
    if (bot === undefined) return;
    let myTop = 0;
    for (const roleId of bot.roleIds) {
      myTop = Math.max(myTop, guild.roles.get(roleId)?.position ?? 0);
    }
    if (role.position >= myTop) {
      this.permissionRefused(
        `the bot's highest role (position ${myTop}) is not above role '${role.name}' (position ${role.position}) and cannot be ${verb}`,
      );
    }
  }

  /** One past the highest position among the siblings of a parent. */
  private appendPosition(guild: FakeGuildState, categoryId: string | null): number {
    let max = 0;
    for (const channel of guild.channels.values()) {
      if (channel.categoryId === categoryId) max = Math.max(max, channel.position);
    }
    return max + 1;
  }

  private childrenOf(guild: FakeGuildState, categoryId: string): readonly FakeChannelState[] {
    return [...guild.channels.values()].filter((channel) => channel.categoryId === categoryId);
  }

  private categoryCount(guild: FakeGuildState): number {
    let count = 0;
    for (const channel of guild.channels.values()) {
      if (channel.kind === 'category') count += 1;
    }
    return count;
  }

  /** Deletes any channel (deleteChannel and deleteCategory share the route). */
  private deleteChannelState(
    guildId: string,
    guild: FakeGuildState,
    channelId: string,
    reason: string,
  ): void {
    const channel = this.findChannel(guild, channelId);
    // A deleted category orphans its children; Discord re-parents them.
    if (channel.kind === 'category') {
      for (const child of this.childrenOf(guild, channelId)) {
        child.categoryId = null;
        this.deliver({
          t: 'CHANNEL_UPDATE',
          s: this.nextEventSeq(),
          d: this.channelPayload(guildId, guild, child.channelId),
        });
      }
    }
    guild.channels.delete(channelId);
    guild.messages = guild.messages.filter((message) => message.channelId !== channelId);
    this.recordAudit(guild, 'CHANNEL_DELETE', channelId, channel.name, reason);
    this.deliver({
      t: 'CHANNEL_DELETE',
      s: this.nextEventSeq(),
      d: this.channelPayload(guildId, guild, channelId, channel),
    });
  }

  /** One reaction, added or removed, with its payload event. */
  private react(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    emoji: { name: string; id?: string | null; animated?: boolean },
    type: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE',
  ): void {
    const guild = this.guildState(guildId);
    this.findChannel(guild, channelId);
    const state = this.findMessage(guild, channelId, messageId);
    const key = `${emoji.name}:${emoji.id ?? ''}`;
    let users = state.reactions.get(key);
    if (users === undefined) {
      users = new Set();
      state.reactions.set(key, users);
    }
    if (type === 'MESSAGE_REACTION_ADD') users.add(userId);
    else users.delete(userId);
    this.deliver({
      t: type,
      s: this.nextEventSeq(),
      d: {
        user_id: userId,
        channel_id: channelId,
        message_id: messageId,
        guild_id: guildId,
        emoji: { name: emoji.name, id: emoji.id ?? null, animated: emoji.animated ?? false },
      },
    });
  }

  private deliver(event: FakeGatewayEvent): void {
    this.eventLog.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private pageLimit(given: number | undefined, cap: number): number {
    return Math.max(1, Math.min(cap, given ?? cap));
  }

  private messagePayload(guildId: string, state: FakeMessageState): FakeGatewayMessage {
    return {
      id: state.messageId,
      channel_id: state.channelId,
      guild_id: guildId,
      author: { id: state.authorId, username: state.username, bot: state.authorBot },
      content: state.content,
      timestamp: state.at,
      edited_timestamp: state.editedAt,
      pinned: state.pinned,
      mention_everyone: false,
      embeds: state.embeds,
      webhook_id: state.webhookId,
    };
  }

  private channelPayload(
    guildId: string,
    guild: FakeGuildState,
    channelId: string,
    override?: FakeChannelState,
  ): FakeGatewayChannel {
    const channel = override ?? this.findChannel(guild, channelId);
    return {
      id: channel.channelId,
      guild_id: guildId,
      name: channel.name,
      type: channel.kind === 'category' ? 4 : 0,
      parent_id: channel.categoryId,
      position: channel.position,
      permission_overwrites: channel.overwrites.map((overwrite) => ({
        id: overwrite.discordId,
        type: overwrite.type === 'role' ? 0 : 1,
        allow: overwrite.allow,
        deny: overwrite.deny,
      })),
    };
  }

  private rolePayload(guild: FakeGuildState, roleId: string): FakeGatewayRole {
    const role = this.findRole(guild, roleId);
    return {
      id: role.roleId,
      name: role.name,
      position: role.position,
      managed: role.managed,
      color: role.color,
    };
  }

  private memberPayload(guildId: string, member: FakeMemberState): FakeGatewayMember {
    return {
      user: { id: member.memberId, username: member.name, bot: false },
      guild_id: guildId,
      roles: [...member.roleIds],
      joined_at: null,
    };
  }
}
