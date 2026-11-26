/**
 * FakeDiscord tests (plan 05 §3.2, P3): the in-memory `DiscordPort`.
 *
 * The sample sequence mirrors the todo-19 port contract's own executions
 * (one op of each catalogue kind), driven through the port handle so the
 * eighteen-method surface is what runs. The fake's ids, the ledger rows
 * `externalIdsFor` builds from the outcomes, and the audit reasons must
 * agree exactly — the reconciliation contract (02 §5.6) depends on it.
 * No test touches a timer, a socket or the database.
 */

import {
  type DiscordOpOutcome,
  type DiscordPort,
  externalIdsFor,
  opReason,
} from '@drawbridge/discord-ops';
import {
  type ApiErrorSignal,
  auditReasonTag,
  classifyError,
  DiscordOperationError,
  type JobErrorClass,
} from '@drawbridge/jobs';
import { FakeDiscord, type FakeDiscordOptions, type FakeGatewayEvent } from '@drawbridge/testkit';
import { describe, expect, expectTypeOf, it } from 'vitest';

/** The guild under test — 18 digits, the precision the plan guards. */
const GUILD = '111111111111111111';
/** A seeded captain. */
const MEMBER = '555555555555555555';
/** The bot's own role, at position 100. */
const BOT_ROLE = '777777777777777777';
/** A managed (integration-owned) role, untouchable either way. */
const MANAGED_ROLE = '888888888888888888';
/** A role above the bot's own, deletable by nobody the bot can act for. */
const HIGH_ROLE = '666666666666666666';
/** The job whose reason tags the audit log must carry. */
const JOB_ID = '0192c0de-0000-7000-8000-000000000021';

/** The standard fixture world: bot, captain, a booster role, a founder. */
function seededFake(options: FakeDiscordOptions = {}): FakeDiscord {
  const fake = new FakeDiscord(options);
  fake.seedGuild(GUILD, {
    botMember: { name: 'Drawbridge', roleIds: [BOT_ROLE] },
    roles: [
      { roleId: BOT_ROLE, name: 'Drawbridge Bot', position: 100 },
      { roleId: MANAGED_ROLE, name: 'Server Booster', position: 90, managed: true },
      { roleId: HIGH_ROLE, name: 'Founder', position: 150 },
    ],
    members: [{ memberId: MEMBER, name: 'Captain Ash' }],
  });
  return fake;
}

/** The rejection every port failure must be, with its taxonomy signal. */
async function failureOf(promise: Promise<unknown>): Promise<DiscordOperationError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (rejected: unknown) => rejected,
  );
  expect(err).toBeInstanceOf(DiscordOperationError);
  return err as DiscordOperationError;
}

/** One run of the todo-19 sample sequence: what it created and why. */
interface Sequence {
  roleId: string;
  categoryId: string;
  channelId: string;
  messageId: string;
  outcomes: readonly DiscordOpOutcome[];
  /** The reason tag each write carried; undefined for sends and pins. */
  reasons: readonly (string | undefined)[];
}

/**
 * The sample execution sequence of the port contract tests, one op of each
 * catalogue kind, threaded through the port with `drb:{jobId}:{seq}` tags.
 */
async function runSequence(port: DiscordPort): Promise<Sequence> {
  const outcomes: DiscordOpOutcome[] = [];
  const reasons: (string | undefined)[] = [];
  let seq = 0;
  const tag = (): string => {
    seq += 1;
    const reason = opReason(JOB_ID, seq);
    reasons.push(reason);
    return reason;
  };
  const noReason = (): void => {
    reasons.push(undefined);
  };

  // 1. create_role
  const role = await port.createRole(
    GUILD,
    { name: 'Division X', color: 0x3498db, hoist: false, mentionable: true },
    tag(),
  );
  outcomes.push({
    kind: 'create_role',
    guildId: GUILD,
    name: 'Division X',
    color: 0x3498db,
    hoist: false,
    mentionable: true,
    result: { kind: 'create_role', roleId: role.roleId, name: role.name },
  });

  // 2. create_category, overwriting the created role in
  const category = await port.createCategory(
    GUILD,
    {
      name: 'Division X',
      overwrites: [{ discordId: role.roleId, type: 'role', allow: '1024', deny: '0' }],
    },
    tag(),
  );
  outcomes.push({
    kind: 'create_category',
    guildId: GUILD,
    name: 'Division X',
    overwrites: [{ discordId: role.roleId, type: 'role', allow: '1024', deny: '0' }],
    result: { kind: 'create_category', categoryId: category.categoryId, name: category.name },
  });

  // 3. create_text_channel (stored slugified: 'Division X' -> 'division-x')
  const channel = await port.createTextChannel(
    GUILD,
    { name: 'Division X', categoryId: category.categoryId, topic: 'Division channels' },
    tag(),
  );
  outcomes.push({
    kind: 'create_text_channel',
    guildId: GUILD,
    name: 'Division X',
    categoryId: category.categoryId,
    topic: 'Division channels',
    result: { kind: 'create_text_channel', channelId: channel.channelId, name: channel.name },
  });

  // 4. edit_overwrites (wholesale replace, string bitfields)
  const overwrites = [
    { discordId: role.roleId, type: 'role' as const, allow: '1024', deny: '0' },
    { discordId: MEMBER, type: 'member' as const, allow: '0', deny: '2048' },
  ];
  await port.editOverwrites(GUILD, channel.channelId, overwrites, tag());
  outcomes.push({
    kind: 'edit_overwrites',
    guildId: GUILD,
    channelId: channel.channelId,
    overwrites,
    result: { kind: 'edit_overwrites' },
  });

  // 5. add_role_to_member
  await port.addRoleToMember(GUILD, MEMBER, role.roleId, tag());
  outcomes.push({
    kind: 'add_role_to_member',
    guildId: GUILD,
    memberId: MEMBER,
    roleId: role.roleId,
    result: { kind: 'add_role_to_member' },
  });

  // 6. remove_role_from_member
  await port.removeRoleFromMember(GUILD, MEMBER, role.roleId, tag());
  outcomes.push({
    kind: 'remove_role_from_member',
    guildId: GUILD,
    memberId: MEMBER,
    roleId: role.roleId,
    result: { kind: 'remove_role_from_member' },
  });

  // 7. send_message (not an auditable create: no reason)
  noReason();
  const message = await port.sendMessage(GUILD, channel.channelId, {
    content: 'Welcome to the league!',
  });
  outcomes.push({
    kind: 'send_message',
    guildId: GUILD,
    channelId: channel.channelId,
    content: 'Welcome to the league!',
    result: { kind: 'send_message', messageId: message.messageId },
  });

  // 8. pin_message (not an auditable create: no reason)
  noReason();
  await port.pinMessage(GUILD, channel.channelId, message.messageId);
  outcomes.push({
    kind: 'pin_message',
    guildId: GUILD,
    channelId: channel.channelId,
    messageId: message.messageId,
    result: { kind: 'pin_message' },
  });

  // 9. move_channel out of its category
  await port.moveChannel(GUILD, channel.channelId, { categoryId: null }, tag());
  outcomes.push({
    kind: 'move_channel',
    guildId: GUILD,
    channelId: channel.channelId,
    categoryId: null,
    result: { kind: 'move_channel' },
  });

  // 10. rename_channel (slugified again: 'Division X Round 2')
  await port.renameChannel(GUILD, channel.channelId, 'Division X Round 2', tag());
  outcomes.push({
    kind: 'rename_channel',
    guildId: GUILD,
    channelId: channel.channelId,
    name: 'Division X Round 2',
    result: { kind: 'rename_channel' },
  });

  // 11. delete_channel
  await port.deleteChannel(GUILD, channel.channelId, tag());
  outcomes.push({
    kind: 'delete_channel',
    guildId: GUILD,
    channelId: channel.channelId,
    result: { kind: 'delete_channel' },
  });

  // 12. delete_category
  await port.deleteCategory(GUILD, category.categoryId, tag());
  outcomes.push({
    kind: 'delete_category',
    guildId: GUILD,
    categoryId: category.categoryId,
    result: { kind: 'delete_category' },
  });

  // 13. delete_role
  await port.deleteRole(GUILD, role.roleId, tag());
  outcomes.push({
    kind: 'delete_role',
    guildId: GUILD,
    roleId: role.roleId,
    result: { kind: 'delete_role' },
  });

  return {
    roleId: role.roleId,
    categoryId: category.categoryId,
    channelId: channel.channelId,
    messageId: message.messageId,
    outcomes,
    reasons,
  };
}

/** A full determinism snapshot: ids, ledger outcomes, audit log, events. */
async function snapshotOf(fake: FakeDiscord): Promise<Record<string, unknown>> {
  const run = await runSequence(fake);
  const audit = await fake.fetchAuditEntries(GUILD, {});
  return {
    ids: {
      role: run.roleId,
      category: run.categoryId,
      channel: run.channelId,
      message: run.messageId,
    },
    reasons: run.reasons,
    outcomes: run.outcomes,
    audit,
    events: fake.emittedEvents().map((event) => ({ t: event.t, d: event.d })),
  };
}

describe('FakeDiscord (todo 21)', () => {
  it('typechecks exactly as DiscordPort and implements the eighteen methods', () => {
    expectTypeOf(new FakeDiscord()).toExtend<DiscordPort>();
    const port: DiscordPort = new FakeDiscord();
    const methods: readonly (keyof DiscordPort)[] = [
      'createRole',
      'deleteRole',
      'createCategory',
      'deleteCategory',
      'createTextChannel',
      'deleteChannel',
      'editOverwrites',
      'sendMessage',
      'pinMessage',
      'addRoleToMember',
      'removeRoleFromMember',
      'moveChannel',
      'renameChannel',
      'fetchAuditEntries',
      'fetchChannelMessages',
      'fetchGuildRoles',
      'fetchGuildChannels',
      'fetchMember',
    ];
    expect(methods).toHaveLength(18);
    for (const method of methods) {
      expect(typeof port[method]).toBe('function');
    }
  });

  it('runs the sample sequence with consistent ids, ledger rows and audit reasons', async () => {
    const fake = seededFake();
    const port: DiscordPort = fake;
    const run = await runSequence(port);

    // Snowflakes: 18 digits, strictly increasing in call order.
    const ids = [run.roleId, run.categoryId, run.channelId, run.messageId];
    for (const id of ids) {
      expect(id).toMatch(/^\d{18}$/);
    }
    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1];
      const current = ids[index];
      if (previous === undefined || current === undefined) throw new Error('unreachable');
      expect(BigInt(current) > BigInt(previous)).toBe(true);
    }

    // The port contract's own reason format, pinned to the engine's tag.
    expect(opReason(JOB_ID, 3)).toBe(auditReasonTag(JOB_ID, 3));
    expect(run.reasons.filter((reason) => reason !== undefined)).toEqual(
      Array.from({ length: 11 }, (_, index) => `drb:${JOB_ID}:${index + 1}`),
    );

    // Ledger rows: every create records the snowflake it was given, with the
    // name the fake stored (slugified for text channels).
    const rows = run.outcomes.flatMap((outcome) => [...externalIdsFor(outcome)]);
    expect(rows).toEqual([
      { discordId: run.roleId, kind: 'role', name: 'Division X' },
      { discordId: run.categoryId, kind: 'category', name: 'Division X' },
      { discordId: run.channelId, kind: 'text_channel', name: 'division-x' },
      { discordId: run.messageId, kind: 'message', name: 'Welcome to the league!' },
    ]);

    // The audit log carries one entry per auditable write, found by its tag.
    const auditable = run.outcomes
      .map((outcome, index) => ({ outcome, reason: run.reasons[index] }))
      .filter((entry) => entry.reason !== undefined);
    expect(auditable).toHaveLength(11);
    for (const { outcome, reason } of auditable) {
      if (reason === undefined) throw new Error('unreachable');
      const entries = await port.fetchAuditEntries(GUILD, { reason });
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined) throw new Error('unreachable');
      expect(entry.reason).toBe(reason);
      switch (outcome.kind) {
        case 'create_role':
          expect(entry.action).toBe('ROLE_CREATE');
          expect(entry.targetId).toBe(run.roleId);
          expect(entry.targetName).toBe('Division X');
          break;
        case 'delete_role':
          expect(entry.action).toBe('ROLE_DELETE');
          expect(entry.targetId).toBe(run.roleId);
          expect(entry.targetName).toBe('Division X');
          break;
        case 'create_category':
          expect(entry.action).toBe('CHANNEL_CREATE');
          expect(entry.targetId).toBe(run.categoryId);
          break;
        case 'delete_category':
          expect(entry.action).toBe('CHANNEL_DELETE');
          expect(entry.targetId).toBe(run.categoryId);
          expect(entry.targetName).toBe('Division X');
          break;
        case 'create_text_channel':
          expect(entry.action).toBe('CHANNEL_CREATE');
          expect(entry.targetId).toBe(run.channelId);
          expect(entry.targetName).toBe('division-x');
          break;
        case 'delete_channel':
          expect(entry.action).toBe('CHANNEL_DELETE');
          expect(entry.targetId).toBe(run.channelId);
          // The name at deletion time: renamed before the delete.
          expect(entry.targetName).toBe('division-x-round-2');
          break;
        case 'edit_overwrites':
        case 'move_channel':
        case 'rename_channel':
          expect(entry.action).toBe('CHANNEL_UPDATE');
          expect(entry.targetId).toBe(run.channelId);
          break;
        case 'add_role_to_member':
        case 'remove_role_from_member':
          expect(entry.action).toBe('MEMBER_ROLE_UPDATE');
          expect(entry.targetId).toBe(MEMBER);
          expect(entry.targetName).toBe('Captain Ash');
          break;
        default:
          throw new Error(`unexpected auditable kind: ${outcome.kind}`);
      }
    }

    // Eleven auditable writes, newest first, every entry ISO-stamped.
    const all = await port.fetchAuditEntries(GUILD, {});
    expect(all).toHaveLength(11);
    const entryIds = all.map((entry) => entry.entryId);
    expect([...entryIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))).toEqual(
      [...entryIds].reverse(),
    );
    for (const entry of all) {
      expect(entry.at).toBe(new Date(entry.at).toISOString());
    }

    // After the tail deletes, reads answer the deleted world.
    expect((await port.fetchGuildRoles(GUILD)).map((role) => role.name)).toEqual([
      '@everyone',
      'Server Booster',
      'Drawbridge Bot',
      'Founder',
    ]);
    expect(await port.fetchGuildChannels(GUILD)).toEqual([]);
  });

  it('reads answer the state the writes produced', async () => {
    const fake = seededFake();
    const port: DiscordPort = fake;

    const role = await port.createRole(
      GUILD,
      { name: 'Division X', color: 0x3498db },
      opReason(JOB_ID, 1),
    );
    const category = await port.createCategory(
      GUILD,
      {
        name: 'Division X',
        overwrites: [{ discordId: role.roleId, type: 'role', allow: '1024', deny: '0' }],
      },
      opReason(JOB_ID, 2),
    );
    const channel = await port.createTextChannel(
      GUILD,
      { name: 'Division X', categoryId: category.categoryId },
      opReason(JOB_ID, 3),
    );
    await port.editOverwrites(
      GUILD,
      channel.channelId,
      [
        { discordId: role.roleId, type: 'role', allow: '1024', deny: '0' },
        { discordId: MEMBER, type: 'member', allow: '0', deny: '2048' },
      ],
      opReason(JOB_ID, 4),
    );
    await port.addRoleToMember(GUILD, MEMBER, role.roleId, opReason(JOB_ID, 5));
    const message = await port.sendMessage(GUILD, channel.channelId, {
      content: 'Welcome to the league!',
    });

    // Roles: @everyone first, the created role inserted just above it, the
    // seeded roles shifted up one.
    const roles = await port.fetchGuildRoles(GUILD);
    expect(roles.map((found) => [found.name, found.position])).toEqual([
      ['@everyone', 0],
      ['Division X', 1],
      ['Server Booster', 91],
      ['Drawbridge Bot', 101],
      ['Founder', 151],
    ]);
    const createdRole = roles.find((found) => found.roleId === role.roleId);
    expect(createdRole).toMatchObject({ name: 'Division X', managed: false, color: 0x3498db });

    // Channels: the category and its child, overwrites as written.
    const channels = await port.fetchGuildChannels(GUILD);
    expect(channels.map((found) => [found.name, found.kind])).toEqual([
      ['Division X', 'category'],
      ['division-x', 'text'],
    ]);
    const readCategory = channels.find((found) => found.channelId === category.categoryId);
    const readChannel = channels.find((found) => found.channelId === channel.channelId);
    expect(readCategory?.overwrites).toEqual([
      { discordId: role.roleId, type: 'role', allow: '1024', deny: '0' },
    ]);
    expect(readChannel).toMatchObject({
      kind: 'text',
      categoryId: category.categoryId,
      name: 'division-x',
    });
    expect(readChannel?.overwrites).toEqual([
      { discordId: role.roleId, type: 'role', allow: '1024', deny: '0' },
      { discordId: MEMBER, type: 'member', allow: '0', deny: '2048' },
    ]);

    // The member holds the added role.
    const member = await port.fetchMember(GUILD, MEMBER);
    expect(member).toEqual({ memberId: MEMBER, name: 'Captain Ash', roleIds: [role.roleId] });
    expect(await port.fetchMember(GUILD, '999999999999999999')).toBeUndefined();

    // The message is in the channel's history, authored by the bot.
    const history = await port.fetchChannelMessages(GUILD, { channelId: channel.channelId });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      messageId: message.messageId,
      authorId: fake.botUserId,
      authorBot: true,
      webhookId: null,
    });
  });

  it('is deterministic: the same sequence yields the same ids, audit and events', async () => {
    const first = await snapshotOf(seededFake());
    const second = await snapshotOf(seededFake());
    expect(second).toEqual(first);

    // A different seed shifts the whole id space, still snowflake-shaped.
    const shiftedFake = seededFake({ seed: 1 });
    const shifted = await runSequence(shiftedFake);
    const baselineFake = seededFake();
    const baseline = await runSequence(baselineFake);
    expect(shifted.roleId).toMatch(/^\d{18}$/);
    expect(shifted.roleId).not.toBe(baseline.roleId);
    expect(shifted.roleId.length).toBe(baseline.roleId.length);
  });

  it('answers the capacity limits with the documented codes', async () => {
    const roleGuild = new FakeDiscord();
    roleGuild.seedGuild(GUILD, {
      // 247 seeded roles + 1 managed + @everyone = 249.
      roles: [
        ...Array.from({ length: 247 }, (_, index) => ({
          name: `Role ${index}`,
          position: index + 1,
        })),
        { name: 'Managed Thing', position: 248, managed: true },
      ],
    });
    await roleGuild.createRole(GUILD, { name: 'Two Fifty' }, 'drb:j:1');
    expect(await roleGuild.fetchGuildRoles(GUILD)).toHaveLength(250);
    const refused = await failureOf(roleGuild.createRole(GUILD, { name: 'Too Many' }, 'drb:j:2'));
    expect(refused.signal).toEqual({
      status: 400,
      code: 30005,
      message: expect.stringContaining('250'),
    });
    expect(classifyError(refused.signal)).toBe('capacity');
    expect(await roleGuild.fetchGuildRoles(GUILD)).toHaveLength(250);

    // 500 channels including categories: the 501st channel is refused, and a
    // category counts against the same budget.
    const channelGuild = new FakeDiscord();
    channelGuild.seedGuild(GUILD, {
      channels: Array.from({ length: 499 }, (_, index) => ({
        name: `Channel ${index}`,
        kind: 'text' as const,
      })),
    });
    await channelGuild.createTextChannel(GUILD, { name: 'Five Hundred' }, 'drb:j:1');
    expect(await channelGuild.fetchGuildChannels(GUILD)).toHaveLength(500);
    for (const create of [
      () => channelGuild.createTextChannel(GUILD, { name: 'Too Many' }, 'drb:j:2'),
      () => channelGuild.createCategory(GUILD, { name: 'Too Many' }, 'drb:j:3'),
    ]) {
      const answer = await failureOf(create());
      expect(answer.signal.code).toBe(30013);
      expect(classifyError(answer.signal)).toBe('capacity');
    }

    // 50 categories: the 51st is refused while the guild is under 500.
    const categoryGuild = new FakeDiscord();
    categoryGuild.seedGuild(GUILD, {
      channels: Array.from({ length: 50 }, (_, index) => ({
        name: `Division ${index}`,
        kind: 'category' as const,
      })),
    });
    const categoryAnswer = await failureOf(
      categoryGuild.createCategory(GUILD, { name: 'Division 50' }, 'drb:j:1'),
    );
    expect(categoryAnswer.signal).toEqual({
      status: 400,
      code: 30013,
      message: 'Maximum number of categories reached (50)',
    });

    // 50 channels per category: the 51st child is refused.
    const fullGuild = new FakeDiscord();
    fullGuild.seedGuild(GUILD, { channels: [{ name: 'Division', kind: 'category' }] });
    const parent = (await fullGuild.fetchGuildChannels(GUILD)).find(
      (found) => found.kind === 'category',
    );
    if (parent === undefined) throw new Error('parent missing');
    fullGuild.seedGuild(GUILD, {
      channels: Array.from({ length: 50 }, (_, index) => ({
        name: `Team ${index}`,
        kind: 'text' as const,
        categoryId: parent.channelId,
      })),
    });
    expect(
      (await fullGuild.fetchGuildChannels(GUILD)).filter(
        (found) => found.categoryId === parent.channelId,
      ),
    ).toHaveLength(50);
    const perCategoryAnswer = await failureOf(
      fullGuild.createTextChannel(
        GUILD,
        { name: 'team-50', categoryId: parent.channelId },
        'drb:j:1',
      ),
    );
    expect(perCategoryAnswer.signal).toEqual({
      status: 400,
      code: 30013,
      message: 'Maximum number of channels in a category reached (50)',
    });
  });

  it('allows a same-category move at the per-category cap, refuses entering a full one', async () => {
    const fake = new FakeDiscord();
    fake.seedGuild(GUILD, { channels: [{ name: 'Full Division', kind: 'category' }] });
    const parent = (await fake.fetchGuildChannels(GUILD)).find(
      (found) => found.kind === 'category',
    );
    if (parent === undefined) throw new Error('parent missing');
    fake.seedGuild(GUILD, {
      channels: Array.from({ length: 49 }, (_, index) => ({
        name: `Team ${index}`,
        kind: 'text' as const,
        categoryId: parent.channelId,
      })),
    });
    // The 50th child puts the category at its cap.
    const fiftieth = await fake.createTextChannel(
      GUILD,
      { name: 'Team 49', categoryId: parent.channelId },
      'drb:j:1',
    );
    expect(
      (await fake.fetchGuildChannels(GUILD)).filter(
        (found) => found.categoryId === parent.channelId,
      ),
    ).toHaveLength(50);

    // Repositioning inside the full category works (F2 regression): the
    // moving channel is already one of the fifty children.
    await fake.moveChannel(
      GUILD,
      fiftieth.channelId,
      { categoryId: parent.channelId, position: 1 },
      'drb:j:2',
    );
    const moved = (await fake.fetchGuildChannels(GUILD)).find(
      (found) => found.channelId === fiftieth.channelId,
    );
    expect(moved).toMatchObject({ categoryId: parent.channelId, position: 1 });

    // Entering the full category from outside is still refused with 30013,
    // and the refused move changes nothing.
    const outside = await fake.createTextChannel(GUILD, { name: 'Outside' }, 'drb:j:3');
    const entering = await failureOf(
      fake.moveChannel(GUILD, outside.channelId, { categoryId: parent.channelId }, 'drb:j:4'),
    );
    expect(entering.signal).toEqual({
      status: 400,
      code: 30013,
      message: 'Maximum number of channels in a category reached (50)',
    });
    expect(classifyError(entering.signal)).toBe('capacity');
    const stayed = (await fake.fetchGuildChannels(GUILD)).find(
      (found) => found.channelId === outside.channelId,
    );
    expect(stayed?.categoryId).toBeNull();
  });

  it('filters audit entries by exact reason, action and limit', async () => {
    const fake = seededFake();
    const one = await fake.createRole(GUILD, { name: 'One' }, 'drb:job-a:1');
    const two = await fake.createRole(GUILD, { name: 'Two' }, 'drb:job-b:1');
    await fake.createCategory(GUILD, { name: 'Cat' }, 'drb:job-a:2');
    await fake.deleteRole(GUILD, two.roleId, 'drb:job-b:2');

    // Reason: the reconciliation lookup (02 §5.6) — exact tag, one hit.
    const adopted = await fake.fetchAuditEntries(GUILD, { reason: 'drb:job-a:1' });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({
      action: 'ROLE_CREATE',
      targetId: one.roleId,
      targetName: 'One',
      reason: 'drb:job-a:1',
    });
    expect(await fake.fetchAuditEntries(GUILD, { reason: 'drb:missing:9' })).toEqual([]);

    // Action: two role creates, newest first.
    const creates = await fake.fetchAuditEntries(GUILD, { action: 'ROLE_CREATE' });
    expect(creates.map((entry) => entry.targetName)).toEqual(['Two', 'One']);

    // Limit: the two newest of four.
    const limited = await fake.fetchAuditEntries(GUILD, { limit: 2 });
    expect(limited.map((entry) => entry.action)).toEqual(['ROLE_DELETE', 'CHANNEL_CREATE']);
  });

  it('injects failures per method with the exact taxonomy signal', async () => {
    const fake = seededFake();

    // 429 with retry_after, bucket and scope rides the signal untouched.
    const rateLimit: ApiErrorSignal = {
      status: 429,
      retryAfterSeconds: 30,
      bucket: 'bkt:roles:write',
      rateLimitScope: 'user',
      message: 'You are being rate limited.',
    };
    fake.failOnce('createRole', rateLimit);
    const refused = await failureOf(fake.createRole(GUILD, { name: 'Division X' }, 'drb:j:1'));
    expect(refused.signal).toEqual(rateLimit);
    expect(classifyError(refused.signal)).toBe('rate_limited');

    // The fault mutated nothing and minted nothing: the retry observes the
    // id a never-faulted run would have produced.
    const retried = await fake.createRole(GUILD, { name: 'Division X' }, 'drb:j:1');
    const clean = seededFake();
    const cleanRole = await clean.createRole(GUILD, { name: 'Division X' }, 'drb:j:1');
    expect(retried.roleId).toBe(cleanRole.roleId);

    // Injected 30013 (the §3.4 scenario-6 tool): capacity, nothing created.
    fake.failOnce('createTextChannel', {
      status: 400,
      code: 30013,
      message: 'Maximum number of guild channels reached (500)',
    });
    const channelAnswer = await failureOf(
      fake.createTextChannel(GUILD, { name: 'team-1' }, 'drb:j:2'),
    );
    expect(classifyError(channelAnswer.signal)).toBe('capacity');
    expect(await fake.fetchGuildChannels(GUILD)).toEqual([]);

    // failWhile: every call fails until cleared.
    fake.failWhile('deleteRole', { status: 403, message: 'Missing Permissions' });
    await failureOf(fake.deleteRole(GUILD, retried.roleId, 'drb:j:3'));
    await failureOf(fake.deleteRole(GUILD, retried.roleId, 'drb:j:3'));
    fake.clearFaults();
    await fake.deleteRole(GUILD, retried.roleId, 'drb:j:3');
    expect((await fake.fetchGuildRoles(GUILD)).map((role) => role.name)).not.toContain(
      'Division X',
    );

    // Faults are per method: a read fault leaves the writes alone.
    fake.failOnce('fetchMember', { status: 404, message: 'Not Found' });
    await failureOf(fake.fetchMember(GUILD, MEMBER));
    const member = await fake.fetchMember(GUILD, MEMBER);
    expect(member?.memberId).toBe(MEMBER);
  });

  it('maps every injectable failure class through the taxonomy', async () => {
    const fake = seededFake();
    const cases: readonly [ApiErrorSignal, JobErrorClass][] = [
      [{ status: 429, retryAfterSeconds: 30 }, 'rate_limited'],
      [{ status: 403 }, 'missing_permission'],
      [{ status: 404, message: 'Not Found' }, 'invalid_input'],
      [{ status: 503, message: 'Service Unavailable' }, 'transient'],
      [{ network: true, message: 'socket timeout' }, 'transient'],
      [
        { status: 400, code: 30013, message: 'Maximum number of guild channels reached (500)' },
        'capacity',
      ],
      [{ status: 400, code: 50013, message: 'Missing Permissions' }, 'missing_permission'],
      [{ status: 400, code: 10003, message: 'Unknown Channel' }, 'object_missing'],
    ];
    for (const [signal, cls] of cases) {
      fake.failOnce('fetchGuildRoles', signal);
      const err = await failureOf(fake.fetchGuildRoles(GUILD));
      expect(err.signal).toEqual(signal);
      expect(classifyError(err.signal)).toBe(cls);
    }
    // No fault is left armed: the read works again.
    expect(await fake.fetchGuildRoles(GUILD)).toHaveLength(4);
  });

  it('enforces the role hierarchy, managed roles and unknown targets', async () => {
    const fake = seededFake();

    // @everyone is undeletable.
    const everyone = await failureOf(fake.deleteRole(GUILD, GUILD, 'drb:j:1'));
    expect(everyone.signal).toMatchObject({ status: 403, code: 50013 });
    expect(everyone.signal.message).toContain('@everyone');

    // Managed roles cannot be deleted or assigned.
    const managed = await failureOf(fake.deleteRole(GUILD, MANAGED_ROLE, 'drb:j:2'));
    expect(managed.signal).toMatchObject({ status: 403, code: 50013 });
    expect(managed.signal.message).toContain('managed by an integration');
    const assign = await failureOf(fake.addRoleToMember(GUILD, MEMBER, MANAGED_ROLE, 'drb:j:3'));
    expect(assign.signal.message).toContain('cannot be assigned');

    // The bot's highest role must sit strictly above the target.
    const above = await failureOf(fake.deleteRole(GUILD, HIGH_ROLE, 'drb:j:4'));
    expect(above.signal).toMatchObject({ status: 403, code: 50013 });
    expect(above.signal.message).toContain("the bot's highest role (position 100)");
    expect(classifyError(above.signal)).toBe('missing_permission');

    // Unknown targets answer Discord's own codes.
    const unknownRole = await failureOf(fake.deleteRole(GUILD, '999999999999999999', 'drb:j:5'));
    expect(unknownRole.signal).toEqual({ status: 404, code: 10011, message: 'Unknown Role' });
    expect(classifyError(unknownRole.signal)).toBe('object_missing');
    const unknownMember = await failureOf(
      fake.addRoleToMember(GUILD, '999999999999999999', BOT_ROLE, 'drb:j:6'),
    );
    expect(unknownMember.signal).toEqual({ status: 404, code: 10007, message: 'Unknown Member' });
    const unknownChannel = await failureOf(
      fake.editOverwrites(GUILD, '999999999999999999', [], 'drb:j:7'),
    );
    expect(unknownChannel.signal).toEqual({ status: 404, code: 10003, message: 'Unknown Channel' });
  });

  it('delivers gateway events for bot writes and member activity', async () => {
    const fake = seededFake();
    const seen: FakeGatewayEvent[] = [];
    fake.onEvent((event) => {
      seen.push(event);
    });

    const role = await fake.createRole(GUILD, { name: 'Division X', color: 0x3498db }, 'drb:j:1');
    const category = await fake.createCategory(GUILD, { name: 'Division X' }, 'drb:j:2');
    const channel = await fake.createTextChannel(
      GUILD,
      { name: 'Division X', categoryId: category.categoryId },
      'drb:j:3',
    );
    await fake.addRoleToMember(GUILD, MEMBER, role.roleId, 'drb:j:4');
    const message = await fake.sendMessage(GUILD, channel.channelId, {
      content: 'Welcome to the league!',
    });
    await fake.pinMessage(GUILD, channel.channelId, message.messageId);

    const events = fake.emittedEvents();
    expect(events.map((event) => event.t)).toEqual([
      'GUILD_ROLE_CREATE',
      'CHANNEL_CREATE',
      'CHANNEL_CREATE',
      'GUILD_MEMBER_UPDATE',
      'MESSAGE_CREATE',
      'MESSAGE_UPDATE',
    ]);

    // Sequence numbers are strictly monotonic.
    const seqs = events.map((event) => event.s);
    for (let index = 1; index < seqs.length; index += 1) {
      const previous = seqs[index - 1];
      const current = seqs[index];
      if (previous === undefined || current === undefined) throw new Error('unreachable');
      expect(current).toBeGreaterThan(previous);
    }

    const [roleEvent, categoryEvent, channelEvent, memberEvent, messageEvent, pinEvent] = events;
    if (
      roleEvent === undefined ||
      roleEvent.t !== 'GUILD_ROLE_CREATE' ||
      categoryEvent === undefined ||
      categoryEvent.t !== 'CHANNEL_CREATE' ||
      channelEvent === undefined ||
      channelEvent.t !== 'CHANNEL_CREATE' ||
      memberEvent === undefined ||
      memberEvent.t !== 'GUILD_MEMBER_UPDATE' ||
      messageEvent === undefined ||
      messageEvent.t !== 'MESSAGE_CREATE' ||
      pinEvent === undefined ||
      pinEvent.t !== 'MESSAGE_UPDATE'
    ) {
      throw new Error('unreachable');
    }
    expect(roleEvent.d.role).toEqual({
      id: role.roleId,
      name: 'Division X',
      position: 1,
      managed: false,
      color: 0x3498db,
    });
    expect(categoryEvent.d).toMatchObject({ type: 4, parent_id: null, name: 'Division X' });
    expect(channelEvent.d).toMatchObject({
      type: 0,
      parent_id: category.categoryId,
      name: 'division-x',
    });
    expect(memberEvent.d).toMatchObject({ user: { id: MEMBER }, guild_id: GUILD });
    expect(memberEvent.d.roles).toContain(role.roleId);
    expect(messageEvent.d).toMatchObject({
      id: message.messageId,
      author: { id: fake.botUserId, username: 'Drawbridge', bot: true },
      content: 'Welcome to the league!',
      pinned: false,
      webhook_id: null,
    });
    expect(messageEvent.d.timestamp).toBe(new Date(messageEvent.d.timestamp).toISOString());
    expect(pinEvent.d.pinned).toBe(true);

    // Member activity: messages, edits, deletes and reactions.
    const human = fake.humanMessage(GUILD, channel.channelId, { authorId: MEMBER, content: 'gg' });
    fake.editMessage(GUILD, channel.channelId, human, 'gg wp');
    fake.deleteMessage(GUILD, channel.channelId, human);
    fake.addReaction(GUILD, channel.channelId, message.messageId, MEMBER, {
      name: 'captain',
      id: '999999999999999999',
      animated: true,
    });
    fake.removeReaction(GUILD, channel.channelId, message.messageId, MEMBER, {
      name: 'captain',
      id: '999999999999999999',
    });
    fake.memberJoins(GUILD, { memberId: '123456789012345678', name: 'New Player' });
    fake.memberLeaves(GUILD, '123456789012345678');

    const activity = fake.emittedEvents().slice(6);
    expect(activity.map((event) => event.t)).toEqual([
      'MESSAGE_CREATE',
      'MESSAGE_UPDATE',
      'MESSAGE_DELETE',
      'MESSAGE_REACTION_ADD',
      'MESSAGE_REACTION_REMOVE',
      'GUILD_MEMBER_ADD',
      'GUILD_MEMBER_REMOVE',
    ]);
    const [humanCreate, humanEdit, humanDelete, reactionAdd, , joinEvent, leaveEvent] = activity;
    if (
      humanCreate === undefined ||
      humanCreate.t !== 'MESSAGE_CREATE' ||
      humanEdit === undefined ||
      humanEdit.t !== 'MESSAGE_UPDATE' ||
      humanDelete === undefined ||
      humanDelete.t !== 'MESSAGE_DELETE' ||
      reactionAdd === undefined ||
      reactionAdd.t !== 'MESSAGE_REACTION_ADD' ||
      joinEvent === undefined ||
      joinEvent.t !== 'GUILD_MEMBER_ADD' ||
      leaveEvent === undefined ||
      leaveEvent.t !== 'GUILD_MEMBER_REMOVE'
    ) {
      throw new Error('unreachable');
    }
    expect(humanCreate.d.author).toEqual({ id: MEMBER, username: 'Captain Ash', bot: false });
    expect(humanCreate.d.content).toBe('gg');
    expect(humanEdit.d.edited_timestamp).not.toBeNull();
    expect(humanDelete.d).toEqual({ id: human, channel_id: channel.channelId, guild_id: GUILD });
    expect(reactionAdd.d.emoji).toEqual({
      name: 'captain',
      id: '999999999999999999',
      animated: true,
    });
    expect(reactionAdd.d.user_id).toBe(MEMBER);
    expect(joinEvent.d).toMatchObject({
      user: { id: '123456789012345678', username: 'New Player', bot: false },
      roles: [],
    });
    expect(typeof joinEvent.d.joined_at).toBe('string');
    expect(leaveEvent.d.user.id).toBe('123456789012345678');

    // The live subscriber saw exactly the recorded stream.
    expect(seen).toEqual(fake.emittedEvents());

    // Duplicate delivery: any recorded event can be re-delivered verbatim.
    const before = fake.emittedEvents().length;
    fake.emit(leaveEvent);
    expect(fake.emittedEvents()).toHaveLength(before + 1);
    expect(fake.emittedEvents().at(-1)).toEqual(leaveEvent);
  });

  it('pages channel history newest first with after and before windows', async () => {
    const fake = seededFake();
    const category = await fake.createCategory(GUILD, { name: 'Division X' }, 'drb:j:1');
    const channel = await fake.createTextChannel(
      GUILD,
      { name: 'division-x', categoryId: category.categoryId },
      'drb:j:2',
    );
    const bot = await fake.sendMessage(GUILD, channel.channelId, { content: 'Welcome!' });
    const first = fake.humanMessage(GUILD, channel.channelId, { authorId: MEMBER, content: 'hi' });
    const second = fake.humanMessage(GUILD, channel.channelId, {
      authorId: MEMBER,
      content: 'hello',
    });
    const third = fake.humanMessage(GUILD, channel.channelId, { authorId: MEMBER, content: 'gm' });

    const all = await fake.fetchChannelMessages(GUILD, { channelId: channel.channelId });
    expect(all.map((found) => found.messageId)).toEqual([third, second, first, bot.messageId]);
    expect(all.map((found) => found.authorBot)).toEqual([false, false, false, true]);
    for (const found of all) {
      expect(found.at).toBe(new Date(found.at).toISOString());
    }

    const newer = await fake.fetchChannelMessages(GUILD, {
      channelId: channel.channelId,
      after: first,
      limit: 2,
    });
    expect(newer.map((found) => found.messageId)).toEqual([third, second]);

    const older = await fake.fetchChannelMessages(GUILD, {
      channelId: channel.channelId,
      before: second,
    });
    expect(older.map((found) => found.messageId)).toEqual([first, bot.messageId]);

    // A deleted channel answers Discord's code, not an empty page.
    await fake.deleteChannel(GUILD, channel.channelId, 'drb:j:3');
    const gone = await failureOf(
      fake.fetchChannelMessages(GUILD, { channelId: channel.channelId }),
    );
    expect(gone.signal).toEqual({ status: 404, code: 10003, message: 'Unknown Channel' });
    expect(classifyError(gone.signal)).toBe('object_missing');
  });
});
