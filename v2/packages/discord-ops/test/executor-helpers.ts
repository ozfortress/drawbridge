/**
 * Deterministic test doubles for the executor (todo 20).
 *
 * `FakeScheduler` is the injected clock and wait: sleeps register
 * themselves on a fake timeline, and `advance` resolves them in due
 * order, flushing the microtask chains between so the executor's queue
 * runs to its next wait deterministically. No timer is ever created —
 * the tests never touch `setTimeout`.
 *
 * `FakeDiscord` implements the plain {@link DiscordPort}: every write is
 * recorded with its dispatch time and audit reason, can be held until the
 * test releases it (for concurrency observation), can be scripted to
 * throw a `DiscordOperationError`, and answers reads from fixtures.
 */

import { type ApiErrorSignal, DiscordOperationError } from '@drawbridge/jobs';
import type { DiscordPort, GuildChannel, GuildMember, GuildRole } from '../src/index.js';

/** Snowflake-shaped unique ids: 18 digits, like the plan's precision guard. */
export function snowflake(n: number): string {
  return `9${String(n).padStart(17, '0')}`;
}

/** The injected clock and wait, on a fake timeline the test drives. */
export class FakeScheduler {
  private nowMs = 0;
  private seq = 0;
  private readonly sleepers: Array<{ due: number; resolve: () => void; seq: number }> = [];

  /** The executor's clock: epoch milliseconds. */
  readonly clock = (): number => this.nowMs;

  /** The executor's wait: resolves when the timeline reaches it. */
  readonly sleep = (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      this.sleepers.push({ due: this.nowMs + ms, resolve, seq: this.seq++ });
    });
  };

  /** Lets microtask chains run without moving time. */
  async settle(): Promise<void> {
    await flushMicrotasks();
  }

  /**
   * Moves the timeline `ms` ahead, resolving every sleep that comes due —
   * earliest first, flushing between resolutions so continuations register
   * their own sleeps before the next is resolved.
   */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    let steps = 0;
    await flushMicrotasks();
    for (;;) {
      if (steps > 20_000) throw new Error('FakeScheduler.advance never settled');
      steps += 1;
      const due = this.sleepers.filter((sleeper) => sleeper.due <= target);
      if (due.length === 0) break;
      due.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const next = due[0];
      if (!next) break;
      const at = this.sleepers.indexOf(next);
      this.sleepers.splice(at, 1);
      this.nowMs = Math.max(this.nowMs, next.due);
      next.resolve();
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

/** Enough microtask rounds for a dispatch or completion chain to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 64; i += 1) {
    await Promise.resolve();
  }
}

/** The port method names that are writes, as the records name them. */
export type WriteMethod =
  | 'createRole'
  | 'deleteRole'
  | 'createCategory'
  | 'deleteCategory'
  | 'createTextChannel'
  | 'deleteChannel'
  | 'editOverwrites'
  | 'sendMessage'
  | 'pinMessage'
  | 'addRoleToMember'
  | 'removeRoleFromMember'
  | 'moveChannel'
  | 'renameChannel';

/** One write the fake saw: what, where, why, and when it was dispatched. */
export interface WriteRecord {
  index: number;
  method: WriteMethod;
  guildId: string;
  reason?: string;
  payload: unknown;
  at: number;
}

export interface FakeDiscordOptions {
  scheduler: FakeScheduler;
  /** How long every write stays in flight (fake time). Default: instant. */
  durationMs?: number;
  /** Hold every write until `release`d, for concurrency observation. */
  hold?: boolean;
  /** The failure the n-th write throws, by index. */
  script?: ReadonlyArray<ApiErrorSignal | undefined>;
  /** The failure every non-scripted write throws. */
  failAll?: ApiErrorSignal;
}

export class FakeDiscord implements DiscordPort {
  private readonly scheduler: FakeScheduler;
  private readonly durationMs: number;
  private readonly hold: boolean;
  private readonly script: ReadonlyArray<ApiErrorSignal | undefined>;
  private readonly failAll: ApiErrorSignal | undefined;
  private idCounter = 0;

  readonly records: WriteRecord[] = [];
  readonly readCounts = new Map<string, number>();
  readonly maxActive = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly gates = new Map<number, () => void>();
  private readonly rolesByGuild = new Map<string, GuildRole[]>();
  private readonly channelsByGuild = new Map<string, GuildChannel[]>();
  private readonly membersByGuild = new Map<string, GuildMember[]>();

  constructor(options: FakeDiscordOptions) {
    this.scheduler = options.scheduler;
    this.durationMs = options.durationMs ?? 0;
    this.hold = options.hold ?? false;
    this.script = options.script ?? [];
    this.failAll = options.failAll;
  }

  /** Guild fixtures for the preflight reads. */
  setRoles(guildId: string, roles: readonly GuildRole[]): void {
    this.rolesByGuild.set(guildId, [...roles]);
  }

  setChannels(guildId: string, channels: readonly GuildChannel[]): void {
    this.channelsByGuild.set(guildId, [...channels]);
  }

  setMembers(guildId: string, members: readonly GuildMember[]): void {
    this.membersByGuild.set(guildId, [...members]);
  }

  /** Lets one held write finish. */
  release(index: number): void {
    const gate = this.gates.get(index);
    if (gate !== undefined) {
      this.gates.delete(index);
      gate();
    }
  }

  /** How many writes were in flight in a guild when it was busiest. */
  peakInFlight(guildId: string): number {
    return this.maxActive.get(guildId) ?? 0;
  }

  private countRead(method: string): void {
    this.readCounts.set(method, (this.readCounts.get(method) ?? 0) + 1);
  }

  private nextId(): string {
    this.idCounter += 1;
    return snowflake(this.idCounter);
  }

  /** The one write path: record, maybe hold, maybe fail, maybe fabricate. */
  private async perform<T>(
    method: WriteMethod,
    guildId: string,
    payload: unknown,
    reason: string | undefined,
    fabricate: () => T,
  ): Promise<T> {
    const at = this.scheduler.clock();
    const index = this.records.length;
    this.records.push({
      index,
      method,
      guildId,
      ...(reason !== undefined ? { reason } : {}),
      payload,
      at,
    });
    const nowActive = (this.active.get(guildId) ?? 0) + 1;
    this.active.set(guildId, nowActive);
    this.maxActive.set(guildId, Math.max(this.maxActive.get(guildId) ?? 0, nowActive));
    try {
      if (this.hold) {
        await new Promise<void>((resolve) => {
          this.gates.set(index, resolve);
        });
      } else if (this.durationMs > 0) {
        await this.scheduler.sleep(this.durationMs);
      }
      const signal = this.script[index] ?? this.failAll;
      if (signal !== undefined) throw new DiscordOperationError(signal);
      return fabricate();
    } finally {
      this.active.set(guildId, (this.active.get(guildId) ?? 1) - 1);
    }
  }

  async createRole(
    guildId: string,
    role: { name: string; color?: number; hoist?: boolean; mentionable?: boolean },
    reason: string,
  ): Promise<{ roleId: string; name: string }> {
    const name = role.name;
    return this.perform('createRole', guildId, role, reason, () => ({
      roleId: this.nextId(),
      name,
    }));
  }

  async deleteRole(guildId: string, roleId: string, reason: string): Promise<void> {
    await this.perform('deleteRole', guildId, { roleId }, reason, () => undefined);
  }

  async createCategory(
    guildId: string,
    category: { name: string; overwrites?: readonly unknown[] },
    reason: string,
  ): Promise<{ categoryId: string; name: string }> {
    const name = category.name;
    return this.perform('createCategory', guildId, category, reason, () => ({
      categoryId: this.nextId(),
      name,
    }));
  }

  async deleteCategory(guildId: string, categoryId: string, reason: string): Promise<void> {
    await this.perform('deleteCategory', guildId, { categoryId }, reason, () => undefined);
  }

  async createTextChannel(
    guildId: string,
    channel: { name: string; categoryId?: string; topic?: string; overwrites?: readonly unknown[] },
    reason: string,
  ): Promise<{ channelId: string; name: string }> {
    const name = channel.name;
    return this.perform('createTextChannel', guildId, channel, reason, () => ({
      channelId: this.nextId(),
      name,
    }));
  }

  async deleteChannel(guildId: string, channelId: string, reason: string): Promise<void> {
    await this.perform('deleteChannel', guildId, { channelId }, reason, () => undefined);
  }

  async editOverwrites(
    guildId: string,
    channelId: string,
    overwrites: readonly unknown[],
    reason: string,
  ): Promise<void> {
    await this.perform(
      'editOverwrites',
      guildId,
      { channelId, overwrites },
      reason,
      () => undefined,
    );
  }

  async sendMessage(
    guildId: string,
    channelId: string,
    message: { content?: string; embeds?: readonly unknown[] },
  ): Promise<{ messageId: string }> {
    return this.perform('sendMessage', guildId, { channelId, message }, undefined, () => ({
      messageId: this.nextId(),
    }));
  }

  async pinMessage(guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.perform('pinMessage', guildId, { channelId, messageId }, undefined, () => undefined);
  }

  async addRoleToMember(
    guildId: string,
    memberId: string,
    roleId: string,
    reason: string,
  ): Promise<void> {
    await this.perform('addRoleToMember', guildId, { memberId, roleId }, reason, () => undefined);
  }

  async removeRoleFromMember(
    guildId: string,
    memberId: string,
    roleId: string,
    reason: string,
  ): Promise<void> {
    await this.perform(
      'removeRoleFromMember',
      guildId,
      { memberId, roleId },
      reason,
      () => undefined,
    );
  }

  async moveChannel(
    guildId: string,
    channelId: string,
    move: { categoryId: string | null; position?: number },
    reason: string,
  ): Promise<void> {
    await this.perform('moveChannel', guildId, { channelId, move }, reason, () => undefined);
  }

  async renameChannel(
    guildId: string,
    channelId: string,
    name: string,
    reason: string,
  ): Promise<void> {
    await this.perform('renameChannel', guildId, { channelId, name }, reason, () => undefined);
  }

  async fetchAuditEntries(): Promise<readonly []> {
    this.countRead('fetchAuditEntries');
    return [];
  }

  async fetchChannelMessages(): Promise<readonly []> {
    this.countRead('fetchChannelMessages');
    return [];
  }

  async fetchGuildRoles(guildId: string): Promise<readonly GuildRole[]> {
    this.countRead('fetchGuildRoles');
    return this.rolesByGuild.get(guildId) ?? [];
  }

  async fetchGuildChannels(guildId: string): Promise<readonly GuildChannel[]> {
    this.countRead('fetchGuildChannels');
    return this.channelsByGuild.get(guildId) ?? [];
  }

  async fetchMember(guildId: string, memberId: string): Promise<GuildMember | undefined> {
    this.countRead('fetchMember');
    return this.membersByGuild.get(guildId)?.find((member) => member.memberId === memberId);
  }
}
