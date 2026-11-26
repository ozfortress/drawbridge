import { auditReasonTag, type Compensation, type OverwriteSnapshot } from '@drawbridge/jobs';
import { describe, expect, it } from 'vitest';
import {
  compensationFor,
  DISCORD_OP_KINDS,
  DISCORD_OPS,
  type DiscordOpExecution,
  ENGINE_COMPENSATION_KINDS,
  externalIdsFor,
  nonReversibleOps,
  opReason,
} from '../src/index.js';

/** Snowflake-shaped test IDs, 18 digits — the precision 02 §6.6 guards. */
const GUILD = '111111111111111111';
const ROLE = '222222222222222222';
const CATEGORY = '333333333333333333';
const CHANNEL = '444444444444444444';
const MEMBER = '555555555555555555';
const MESSAGE = '666666666666666666';

const JOB_ID = '0192c0de-0000-7000-8000-000000000001';

/** Prior overwrites captured before a permission edit (02 §5.9). */
const priorOverwrites: readonly OverwriteSnapshot[] = [
  { discordId: ROLE, type: 'role', allow: '1024', deny: '0' },
  { discordId: MEMBER, type: 'member', allow: '0', deny: '2048' },
];

/** One sample execution per op kind: inputs, captured prior state, result. */
const executions: readonly DiscordOpExecution[] = [
  {
    kind: 'create_role',
    guildId: GUILD,
    name: 'Division X',
    prior: { kind: 'create_role' },
    result: { kind: 'create_role', roleId: ROLE, name: 'Division X' },
  },
  {
    kind: 'delete_role',
    guildId: GUILD,
    roleId: ROLE,
    prior: {
      kind: 'delete_role',
      name: 'Division X',
      color: 0x3498db,
      hoist: false,
      mentionable: true,
    },
    result: { kind: 'delete_role' },
  },
  {
    kind: 'create_category',
    guildId: GUILD,
    name: 'Division X',
    prior: { kind: 'create_category' },
    result: { kind: 'create_category', categoryId: CATEGORY, name: 'Division X' },
  },
  {
    kind: 'delete_category',
    guildId: GUILD,
    categoryId: CATEGORY,
    prior: { kind: 'delete_category', name: 'Division X' },
    result: { kind: 'delete_category' },
  },
  {
    kind: 'create_text_channel',
    guildId: GUILD,
    name: 'division-x',
    categoryId: CATEGORY,
    prior: { kind: 'create_text_channel' },
    result: { kind: 'create_text_channel', channelId: CHANNEL, name: 'division-x' },
  },
  {
    kind: 'delete_channel',
    guildId: GUILD,
    channelId: CHANNEL,
    prior: { kind: 'delete_channel', name: 'division-x', overwrites: priorOverwrites },
    result: { kind: 'delete_channel' },
  },
  {
    kind: 'edit_overwrites',
    guildId: GUILD,
    channelId: CHANNEL,
    overwrites: [{ discordId: ROLE, type: 'role', allow: '4', deny: '0' }],
    prior: { kind: 'edit_overwrites', overwrites: priorOverwrites },
    result: { kind: 'edit_overwrites' },
  },
  {
    kind: 'send_message',
    guildId: GUILD,
    channelId: CHANNEL,
    content: 'Welcome to the league!',
    prior: { kind: 'send_message' },
    result: { kind: 'send_message', messageId: MESSAGE },
  },
  {
    kind: 'pin_message',
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    prior: { kind: 'pin_message' },
    result: { kind: 'pin_message' },
  },
  {
    kind: 'add_role_to_member',
    guildId: GUILD,
    memberId: MEMBER,
    roleId: ROLE,
    prior: { kind: 'add_role_to_member' },
    result: { kind: 'add_role_to_member' },
  },
  {
    kind: 'remove_role_from_member',
    guildId: GUILD,
    memberId: MEMBER,
    roleId: ROLE,
    prior: { kind: 'remove_role_from_member' },
    result: { kind: 'remove_role_from_member' },
  },
  {
    kind: 'move_channel',
    guildId: GUILD,
    channelId: CHANNEL,
    categoryId: CATEGORY,
    prior: { kind: 'move_channel', categoryId: null, position: 3 },
    result: { kind: 'move_channel' },
  },
  {
    kind: 'rename_channel',
    guildId: GUILD,
    channelId: CHANNEL,
    name: 'division-x-round-2',
    prior: { kind: 'rename_channel', name: 'division-x' },
    result: { kind: 'rename_channel' },
  },
];

/** The sample execution for one op kind. */
function executionFor(kind: (typeof DISCORD_OP_KINDS)[number]): DiscordOpExecution {
  const found = executions.find((execution) => execution.kind === kind);
  if (found === undefined) throw new Error(`no sample execution for ${kind}`);
  return found;
}

describe('audit reason tags', () => {
  it('is exactly drb:{jobId}:{seq}', () => {
    expect(opReason(JOB_ID, 3)).toBe(`drb:${JOB_ID}:3`);
    expect(opReason('j', 0)).toBe('drb:j:0');
  });

  it('agrees with the engine tag reconciliation searches for', () => {
    for (const seq of [0, 1, 7, 41]) {
      expect(opReason(JOB_ID, seq)).toBe(auditReasonTag(JOB_ID, seq));
    }
  });

  it('stays inside Discord 512-character audit reason limit', () => {
    expect(opReason('j'.repeat(490), 999999).length).toBeLessThanOrEqual(512);
  });
});

describe('captured prior state', () => {
  it('compensates a permission edit with the exact overwrites captured before it', () => {
    expect(compensationFor(executionFor('edit_overwrites'))).toEqual({
      kind: 'restore_overwrites',
      channelId: CHANNEL,
      overwrites: priorOverwrites,
    });
  });

  it('keeps bitfields as strings through the capture', () => {
    const compensation = compensationFor(executionFor('edit_overwrites'));
    if (compensation === null || compensation.kind !== 'restore_overwrites') {
      throw new Error('expected restore_overwrites');
    }
    for (const overwrite of compensation.overwrites) {
      expect(typeof overwrite.allow).toBe('string');
      expect(typeof overwrite.deny).toBe('string');
    }
  });

  it('carries the captured overwrites through a channel recreation', () => {
    expect(compensationFor(executionFor('delete_channel'))).toEqual({
      kind: 'recreate_channel',
      name: 'division-x',
      overwrites: priorOverwrites,
    });
  });

  it('restores the placement and name captured before a move or rename', () => {
    expect(compensationFor(executionFor('move_channel'))).toEqual({
      kind: 'restore_placement',
      channelId: CHANNEL,
      categoryId: null,
      position: 3,
    });
    expect(compensationFor(executionFor('rename_channel'))).toEqual({
      kind: 'restore_name',
      channelId: CHANNEL,
      name: 'division-x',
    });
  });
});

describe('result ids', () => {
  it('records the created object of every create op', () => {
    expect(externalIdsFor(executionFor('create_role'))).toEqual([
      { discordId: ROLE, kind: 'role', name: 'Division X' },
    ]);
    expect(externalIdsFor(executionFor('create_category'))).toEqual([
      { discordId: CATEGORY, kind: 'category', name: 'Division X' },
    ]);
    expect(externalIdsFor(executionFor('create_text_channel'))).toEqual([
      { discordId: CHANNEL, kind: 'text_channel', name: 'division-x' },
    ]);
  });

  it('records a sent message with a deterministic ledger name', () => {
    expect(externalIdsFor(executionFor('send_message'))).toEqual([
      { discordId: MESSAGE, kind: 'message', name: 'Welcome to the league!' },
    ]);
  });

  it('records nothing for ops that create no ledger object', () => {
    for (const execution of executions) {
      if (DISCORD_OPS[execution.kind].creates === null) {
        expect(externalIdsFor(execution)).toEqual([]);
      }
    }
  });

  it('caps the ledger name of a long announcement at 80 characters', () => {
    const ids = externalIdsFor({
      kind: 'send_message',
      guildId: GUILD,
      channelId: CHANNEL,
      content: 'x'.repeat(200),
      result: { kind: 'send_message', messageId: MESSAGE },
    });
    expect(ids[0]?.name).toBe('x'.repeat(80));
  });
});

describe('the operation catalogue', () => {
  it('covers every step op kind exactly once', () => {
    expect([...DISCORD_OP_KINDS].sort()).toEqual([...Object.keys(DISCORD_OPS)].sort());
    expect(executions.map((execution) => execution.kind).sort()).toEqual(
      [...DISCORD_OP_KINDS].sort(),
    );
  });

  it('pairs every op with a compensation or an explicit non-reversible marker', () => {
    for (const kind of DISCORD_OP_KINDS) {
      const spec = DISCORD_OPS[kind];
      expect(spec.kind).toBe(kind);
      // Every op answers the compensation question: reversible ops name
      // their compensation kind, non-reversible ops are marked and warned.
      expect(spec.reversible).toBe(spec.compensationKind !== null);
      expect(spec.warning !== null).toBe(!spec.reversible);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.portMethod.length).toBeGreaterThan(0);
    }
  });

  it('builds the compensation its spec promises, except for announcements', () => {
    for (const execution of executions) {
      const spec = DISCORD_OPS[execution.kind];
      const compensation = compensationFor(execution);
      if (spec.reversible) {
        expect(compensation?.kind).toBe(spec.compensationKind);
      } else {
        expect(compensation).toBeNull();
      }
      // Pure and deterministic: the same execution builds the same descriptor.
      expect(compensationFor(execution)).toEqual(compensation);
    }
  });

  it('marks the four §5.9 compensations as the engine-executable set', () => {
    expect(ENGINE_COMPENSATION_KINDS).toEqual([
      'delete_role',
      'delete_channel',
      'delete_category',
      'restore_overwrites',
    ]);
  });
});

describe('preview warnings', () => {
  it('lists exactly the announcement ops as non-reversible', () => {
    const warnings = nonReversibleOps();
    expect(warnings.map((spec) => spec.kind)).toEqual(['send_message', 'pin_message']);
    for (const spec of warnings) {
      expect(spec.warning).toContain('revert');
    }
  });

  it('warns that a revert leaves posted and pinned messages in place', () => {
    const texts = nonReversibleOps()
      .map((spec) => spec.warning ?? '')
      .join(' ');
    expect(texts).toContain('announcement message');
    expect(texts).toContain('unpin');
  });
});

describe('engine compatibility', () => {
  // Each assignment only compiles while discord-ops' descriptors stay
  // structurally identical to the jobs revert engine's Compensation union.
  it('produces the §5.9 compensations in the jobs Compensation shape', () => {
    const roleComp = compensationFor(executionFor('create_role'));
    if (roleComp === null || roleComp.kind !== 'delete_role') {
      throw new Error('expected delete_role');
    }
    const engineRole: Compensation = roleComp;
    expect(engineRole).toEqual({ kind: 'delete_role', roleId: ROLE });

    const channelComp = compensationFor(executionFor('create_text_channel'));
    if (channelComp === null || channelComp.kind !== 'delete_channel') {
      throw new Error('expected delete_channel');
    }
    const engineChannel: Compensation = channelComp;
    expect(engineChannel).toEqual({ kind: 'delete_channel', channelId: CHANNEL });

    const categoryComp = compensationFor(executionFor('create_category'));
    if (categoryComp === null || categoryComp.kind !== 'delete_category') {
      throw new Error('expected delete_category');
    }
    const engineCategory: Compensation = categoryComp;
    expect(engineCategory).toEqual({ kind: 'delete_category', categoryId: CATEGORY });

    const overwritesComp = compensationFor(executionFor('edit_overwrites'));
    if (overwritesComp === null || overwritesComp.kind !== 'restore_overwrites') {
      throw new Error('expected restore_overwrites');
    }
    const engineOverwrites: Compensation = overwritesComp;
    expect(engineOverwrites).toEqual({
      kind: 'restore_overwrites',
      channelId: CHANNEL,
      overwrites: priorOverwrites,
    });
  });
});
