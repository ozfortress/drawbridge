import { auditReasonTag } from '@drawbridge/jobs';
import { describe, expect, it } from 'vitest';
import type { DiscordOp, GuildChannel, GuildRole } from '../src/index.js';
import {
  type BotPermissionName,
  createDiscordExecutor,
  type DiscordPreflight,
  type DiscordWriteRequest,
  type DiscordWriteResult,
  requiredWritePermissions,
} from '../src/index.js';
import { FakeDiscord, FakeScheduler, snowflake } from './executor-helpers.js';

const GUILD = '111111111111111111';
const BOT_MEMBER = '555555555555555555';
const ROLE = '222222222222222222';
const MANAGED_ROLE = '777777777777777777';
const ABOVE_ROLE = '888888888888888888';
const BOT_ROLE = '999999999999999999';
const CATEGORY = '333333333333333333';
const CHANNEL = '444444444444444444';
const MEMBER = '666666666666666666';

const ALL_PERMISSIONS: readonly BotPermissionName[] = [
  'ViewChannel',
  'ManageChannels',
  'ManageRoles',
  'SendMessages',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'ManageMessages',
  'ViewAuditLog',
  'UseApplicationCommands',
];

/** A guild where the bot sits at position 5, below one role above it. */
function fixtureGuild(): {
  roles: GuildRole[];
  channels: GuildChannel[];
  members: readonly { memberId: string; name: string; roleIds: readonly string[] }[];
} {
  return {
    roles: [
      { roleId: '1', name: '@everyone', position: 0, managed: false, color: 0 },
      { roleId: BOT_ROLE, name: 'Drawbridge', position: 5, managed: false, color: 0x3498db },
      { roleId: ROLE, name: 'Division X', position: 3, managed: false, color: 0 },
      { roleId: MANAGED_ROLE, name: 'Server Booster', position: 1, managed: true, color: 0 },
      { roleId: ABOVE_ROLE, name: 'Admins', position: 7, managed: false, color: 0 },
    ],
    channels: [
      {
        channelId: CATEGORY,
        name: 'Division X',
        kind: 'category',
        categoryId: null,
        position: 0,
        overwrites: [],
      },
      {
        channelId: CHANNEL,
        name: 'general',
        kind: 'text',
        categoryId: CATEGORY,
        position: 0,
        overwrites: [],
      },
      {
        channelId: '2',
        name: 'voice',
        kind: 'other',
        categoryId: null,
        position: 1,
        overwrites: [],
      },
    ],
    members: [{ memberId: BOT_MEMBER, name: 'Drawbridge', roleIds: [BOT_ROLE, '1'] }],
  };
}

/** Wires an executor over the fixture guild, with a tunable permission set. */
function makeExecutor(
  port: FakeDiscord,
  scheduler: FakeScheduler,
  held: readonly BotPermissionName[],
): ReturnType<typeof createDiscordExecutor> {
  const fixture = fixtureGuild();
  port.setRoles(GUILD, fixture.roles);
  port.setChannels(GUILD, fixture.channels);
  port.setMembers(GUILD, fixture.members);
  const preflight: DiscordPreflight = {
    botMemberId: BOT_MEMBER,
    permissions: () => Promise.resolve(held),
  };
  return createDiscordExecutor({ port, clock: scheduler.clock, sleep: scheduler.sleep, preflight });
}

function request(op: DiscordOp, seq: number): DiscordWriteRequest {
  return { op, lane: 'setup', jobId: '0192c0de-0000-7000-8000-000000000030', seq };
}

describe('the executor preflight (todo 20; 02 §4.5, §4.8)', () => {
  it('requires exactly the §4.2 names per op kind, EmbedLinks with embeds', () => {
    expect(
      requiredWritePermissions({ kind: 'create_role', guildId: GUILD, name: 'Division X' }),
    ).toEqual(['ManageRoles']);
    expect(
      requiredWritePermissions({
        kind: 'send_message',
        guildId: GUILD,
        channelId: CHANNEL,
        content: 'hello',
      }),
    ).toEqual(['SendMessages', 'ViewChannel']);
    expect(
      requiredWritePermissions({
        kind: 'send_message',
        guildId: GUILD,
        channelId: CHANNEL,
        embeds: [{ title: 'Welcome' }],
      }),
    ).toEqual(['SendMessages', 'ViewChannel', 'EmbedLinks']);
  });

  it('refuses a write whose permission the bot lacks, without a port call', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ['ManageRoles']);

    const result = await executor.executeWrite(
      request({ kind: 'create_text_channel', guildId: GUILD, name: 'division-x' }, 1),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        class: 'missing_permission',
        action: 'awaiting_decision',
        signal: { code: 50013 },
      },
    });
    expect(result).toHaveProperty(
      'failure.signal.message',
      'the bot lacks the ManageChannels permission in this guild',
    );
    // The refusal never reached Discord: no write, no capacity read.
    expect(port.records).toHaveLength(0);
    expect(port.readCounts.get('fetchGuildChannels') ?? 0).toBe(0);
  });

  it('runs the write when preflight passes, with the audit reason tag', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const result = await executor.executeWrite(
      request(
        { kind: 'create_text_channel', guildId: GUILD, name: 'Division X', categoryId: CATEGORY },
        7,
      ),
    );

    expect(result.status).toBe('done');
    expect(port.records).toHaveLength(1);
    expect(port.records[0]?.reason).toBe('drb:0192c0de-0000-7000-8000-000000000030:7');
    expect(port.records[0]?.reason).toBe(auditReasonTag('0192c0de-0000-7000-8000-000000000030', 7));
  });

  it('refuses ops on roles above the bot, naming the role (02 §4.13)', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const result = await executor.executeWrite(
      request({ kind: 'delete_role', guildId: GUILD, roleId: ABOVE_ROLE }, 2),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        class: 'missing_permission',
        action: 'awaiting_decision',
        signal: { code: 50013 },
      },
    });
    expect(result).toHaveProperty(
      'failure.signal.message',
      "the bot's highest role (position 5) is not above role 'Admins' (position 7)",
    );
    expect(port.records).toHaveLength(0);
    expect(port.readCounts.get('fetchGuildRoles')).toBe(1);
    expect(port.readCounts.get('fetchMember')).toBe(1);
  });

  it('refuses managed roles and lets a role below the bot through', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const managed = await executor.executeWrite(
      request({ kind: 'delete_role', guildId: GUILD, roleId: MANAGED_ROLE }, 3),
    );
    expect(managed).toHaveProperty(
      'failure.signal.message',
      "role 'Server Booster' is managed by an integration and cannot be deleted",
    );
    expect(port.records).toHaveLength(0);

    const below = await executor.executeWrite(
      request({ kind: 'delete_role', guildId: GUILD, roleId: ROLE }, 4),
    );
    expect(below.status).toBe('done');
    expect(port.records).toHaveLength(1);
    expect(port.records[0]?.reason).toBe('drb:0192c0de-0000-7000-8000-000000000030:4');
  });

  it("refuses a role create over todo-8's 250-role cap with the 30005 code", async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);
    const roles: GuildRole[] = Array.from({ length: 250 }, (_, index) => ({
      roleId: snowflake(index + 1),
      name: `Role ${index}`,
      position: 0,
      managed: false,
      color: 0,
    }));
    port.setRoles(GUILD, roles);

    const result = await executor.executeWrite(
      request({ kind: 'create_role', guildId: GUILD, name: 'Division X' }, 5),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        class: 'capacity',
        action: 'awaiting_decision',
        signal: { code: 30005 },
      },
    });
    expect(port.records).toHaveLength(0);
  });

  it('maps a guild at the 500-channel cap to capacity and awaiting_decision (30013)', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);
    const channels: GuildChannel[] = Array.from({ length: 500 }, (_, index) => ({
      channelId: snowflake(index + 1),
      name: `channel-${index}`,
      kind: 'text',
      categoryId: null,
      position: index,
      overwrites: [],
    }));
    port.setChannels(GUILD, channels);

    const result = await executor.executeWrite(
      request({ kind: 'create_text_channel', guildId: GUILD, name: 'division-x' }, 6),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        class: 'capacity',
        action: 'awaiting_decision',
        signal: { code: 30013 },
      },
    });
    expect(result).toHaveProperty(
      'failure.signal.message',
      'creating a channel would exceed the guild limit of 500 channels (the guild holds 500)',
    );
    expect(port.records).toHaveLength(0);
  });

  it('refuses a category create over the 50-category cap and a channel over the 50-per-category cap', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const categories: GuildChannel[] = Array.from({ length: 50 }, (_, index) => ({
      channelId: snowflake(index + 1),
      name: `Category ${index}`,
      kind: 'category',
      categoryId: null,
      position: index,
      overwrites: [],
    }));
    port.setChannels(GUILD, categories);
    const categoryRefusal = await executor.executeWrite(
      request({ kind: 'create_category', guildId: GUILD, name: 'Division Y' }, 7),
    );
    expect(categoryRefusal).toMatchObject({
      status: 'failed',
      failure: { class: 'capacity', signal: { code: 30013 } },
    });
    expect(categoryRefusal).toHaveProperty(
      'failure.signal.message',
      'creating a category would exceed the guild limit of 50 categories (the guild holds 50)',
    );

    // 50 channels inside one category, far below the guild total.
    const full: GuildChannel[] = [
      ...Array.from({ length: 50 }, (_, index) => ({
        channelId: snowflake(index + 1),
        name: `channel-${index}`,
        kind: 'text' as const,
        categoryId: CATEGORY,
        position: index,
        overwrites: [],
      })),
      {
        channelId: CATEGORY,
        name: 'Division X',
        kind: 'category' as const,
        categoryId: null,
        position: 0,
        overwrites: [],
      },
    ];
    port.setChannels(GUILD, full);
    const perCategory = await executor.executeWrite(
      request(
        { kind: 'create_text_channel', guildId: GUILD, name: 'division-x', categoryId: CATEGORY },
        8,
      ),
    );
    expect(perCategory).toMatchObject({
      status: 'failed',
      failure: { class: 'capacity', signal: { code: 30013 } },
    });
    expect(perCategory).toHaveProperty(
      'failure.signal.message',
      'creating a channel would exceed the limit of 50 channels per category (the category holds 50)',
    );
    expect(port.records).toHaveLength(0);
  });

  it('maps a Discord 30013 answer to capacity and awaiting_decision too', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      failAll: { code: 30013, message: 'Maximum number of channels reached' },
    });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const result = await executor.executeWrite(
      request({ kind: 'create_text_channel', guildId: GUILD, name: 'division-x' }, 9),
    );

    // A race beat the preflight; the taxonomy still parks the job.
    expect(result).toMatchObject({
      status: 'failed',
      failure: {
        class: 'capacity',
        action: 'awaiting_decision',
        signal: { code: 30013 },
      },
    });
    // A capacity answer is not an invalid request: Discord served it.
    expect(executor.invalidRequestCount()).toBe(0);
  });

  it('reports a failing preflight read through the taxonomy', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const fixture = fixtureGuild();
    port.setRoles(GUILD, fixture.roles);
    port.setChannels(GUILD, fixture.channels);
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      preflight: {
        botMemberId: BOT_MEMBER,
        permissions: () => Promise.reject(new Error('socket hang up')),
      },
    });

    const result = await executor.executeWrite(
      request({ kind: 'create_role', guildId: GUILD, name: 'Division X' }, 10),
    );

    // An unmapped failure is permanent by default (02 §4.13): it parks.
    expect(result).toMatchObject({
      status: 'failed',
      failure: { class: 'invalid_input', action: 'awaiting_decision' },
    });
    expect(port.records).toHaveLength(0);
  });

  it('tags every create and delete with drb:{jobId}:{seq} and never the sends', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const ops: DiscordOp[] = [
      {
        kind: 'create_role',
        guildId: GUILD,
        name: 'Division X',
        color: 0x3498db,
        hoist: false,
        mentionable: true,
      },
      { kind: 'delete_role', guildId: GUILD, roleId: ROLE },
      { kind: 'create_category', guildId: GUILD, name: 'Division X' },
      { kind: 'delete_category', guildId: GUILD, categoryId: CATEGORY },
      {
        kind: 'create_text_channel',
        guildId: GUILD,
        name: 'division-x',
        categoryId: CATEGORY,
        topic: 'Matches',
      },
      { kind: 'delete_channel', guildId: GUILD, channelId: CHANNEL },
      {
        kind: 'edit_overwrites',
        guildId: GUILD,
        channelId: CHANNEL,
        overwrites: [{ discordId: ROLE, type: 'role', allow: '1024', deny: '0' }],
      },
      { kind: 'send_message', guildId: GUILD, channelId: CHANNEL, content: 'Welcome!' },
      { kind: 'pin_message', guildId: GUILD, channelId: CHANNEL, messageId: '666666666666666666' },
      { kind: 'add_role_to_member', guildId: GUILD, memberId: MEMBER, roleId: ROLE },
      { kind: 'remove_role_from_member', guildId: GUILD, memberId: MEMBER, roleId: ROLE },
      { kind: 'move_channel', guildId: GUILD, channelId: CHANNEL, categoryId: null, position: 2 },
      { kind: 'rename_channel', guildId: GUILD, channelId: CHANNEL, name: 'division-x' },
    ];

    const settled: DiscordWriteResult[] = [];
    // Sequential: preflight reads differ per op kind, so concurrent submits
    // enqueue in read-completion order; the tag check wants one op at a time.
    for (const [index, op] of ops.entries()) {
      settled.push(await executor.executeWrite(request(op, index + 1)));
      await scheduler.advance(150);
    }

    expect(settled.every((result) => result.status === 'done')).toBe(true);
    expect(port.records).toHaveLength(ops.length);

    // Every auditable create, delete, overwrite edit, member-role change,
    // move and rename carries the reconciliation tag (02 §4.16) — the same
    // format the engine's auditReasonTag spells.
    for (const record of port.records) {
      if (record.method === 'sendMessage' || record.method === 'pinMessage') {
        expect(record.reason).toBeUndefined();
        continue;
      }
      const seq = Number(record.index) + 1;
      expect(record.reason).toBe(`drb:0192c0de-0000-7000-8000-000000000030:${seq}`);
      expect(record.reason).toBe(auditReasonTag('0192c0de-0000-7000-8000-000000000030', seq));
    }
  });

  it('lets a role the reads cannot find through: Discord answers 10011', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);

    const result = await executor.executeWrite(
      request({ kind: 'delete_role', guildId: GUILD, roleId: '123456789012345678' }, 11),
    );

    // Not the preflight's call to make: the taxonomy maps the real answer.
    expect(result.status).toBe('done');
    expect(port.records).toHaveLength(1);
  });

  it('lets a write through when the bot member cannot be read', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const fixture = fixtureGuild();
    port.setRoles(GUILD, fixture.roles);
    // No member fixture: the hierarchy read cannot run.
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      preflight: { botMemberId: BOT_MEMBER, permissions: () => Promise.resolve(ALL_PERMISSIONS) },
    });

    const result = await executor.executeWrite(
      request({ kind: 'delete_role', guildId: GUILD, roleId: ROLE }, 12),
    );

    expect(result.status).toBe('done');
    expect(port.records).toHaveLength(1);
  });

  it('refuses a category create when the guild channel total is spent', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = makeExecutor(port, scheduler, ALL_PERMISSIONS);
    const channels: GuildChannel[] = Array.from({ length: 500 }, (_, index) => ({
      channelId: snowflake(index + 1),
      name: `channel-${index}`,
      kind: 'text',
      categoryId: null,
      position: index,
      overwrites: [],
    }));
    port.setChannels(GUILD, channels);

    const result = await executor.executeWrite(
      request({ kind: 'create_category', guildId: GUILD, name: 'Division Z' }, 13),
    );

    expect(result).toMatchObject({
      status: 'failed',
      failure: { class: 'capacity', action: 'awaiting_decision', signal: { code: 30013 } },
    });
    expect(result).toHaveProperty(
      'failure.signal.message',
      'creating a category would exceed the guild limit of 500 channels (the guild holds 500)',
    );
    expect(port.records).toHaveLength(0);
  });

  it('refuses a write whose preflight was still running when a 401 stopped everything', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      script: [{ status: 401, message: '401: Unauthorized' }],
    });
    let permissionCalls = 0;
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      preflight: {
        botMemberId: BOT_MEMBER,
        permissions: () => {
          permissionCalls += 1;
          return permissionCalls === 1
            ? Promise.resolve(ALL_PERMISSIONS)
            : secondGate.then(() => ALL_PERMISSIONS);
        },
      },
    });

    const first = executor.executeWrite(
      request({ kind: 'send_message', guildId: GUILD, channelId: CHANNEL }, 14),
    );
    const second = executor.executeWrite(
      request({ kind: 'send_message', guildId: GUILD, channelId: CHANNEL }, 15),
    );
    // The first write's 401 lands while the second is mid-preflight.
    await scheduler.settle();
    expect(executor.isStopped()).toBe(true);
    releaseSecond();
    const settled = await Promise.all([first, second]);

    expect(settled[0]).toMatchObject({ failure: { class: 'fatal_config' } });
    expect(settled[1]).toMatchObject({ failure: { class: 'fatal_config' } });
    // Only the first write ever reached the port.
    expect(port.records).toHaveLength(1);
  });
});
