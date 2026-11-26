/**
 * The required failure-injection suite (plan 05 §3.4, scenarios 1-10, level
 * L6) against real Postgres, the in-memory FakeDiscord and the HTTP
 * FakeCitadel.
 *
 * Every scenario runs the real product code: the worker loop, the claim and
 * reclaim scans, the failure path and its taxonomy, reconciliation by audit
 * reason, the revert engine, the preview/approval web API, and the
 * DiscordExecutor with its preflight — only the Discord port, the Citadel
 * wire and time are fake. Two database connections keep the test's view (the
 * "app") and the loop's own pool apart, the way a web process and a worker
 * process really sit. No test sleeps or waits on wall time: the loop's idle
 * wait is an instant harness that advances an injected clock, and every wait
 * is event-driven (a step tick, a probe tick, a child's READY line, an exit
 * event).
 *
 * Beyond the ten §3.4 scenarios, the suite carries the two chaos pieces the
 * delivery plan demands alongside them: a real SIGKILL of a child worker
 * process mid-step (scenario 2) and a `pg_terminate_backend` on the loop's
 * own connection, asserting the loop recovers and keeps working.
 *
 * Scenarios 8 and 9 approve through the real web API (`@drawbridge/web`
 * `buildApp`) with a fake OAuth and the FakeCitadel, because approval —
 * idempotency, the duplicate guard, the drift check — is web behaviour, and
 * faking it here would test nothing.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability } from '@drawbridge/authz';
import { type CitadelClient, createCitadelClient } from '@drawbridge/citadel';
import { parseConfig } from '@drawbridge/config';
import {
  type CreateJobInput,
  type CreateJobStepInput,
  createDatabase,
  type Database,
  discordObjects,
  ensureGuild,
  ensureRootAdmins,
  getDiscordObject,
  getJob,
  type JobRow,
  type JobStepRow,
  jobSteps,
  jobs,
  updateJobState,
} from '@drawbridge/db';
import {
  createDiscordExecutor,
  type DiscordExecutor,
  type DiscordLane,
  type DiscordOp,
  type DiscordPreflight,
  type OverwriteSet,
} from '@drawbridge/discord-ops';
import { createLogger } from '@drawbridge/logging';
import {
  CITADEL_LEAGUE_ID,
  closeTestDatabase,
  createFakeCitadel,
  type FakeCitadel,
  FakeDiscord,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
  tournamentFixtures,
} from '@drawbridge/testkit';
import { type AppContext, buildApp } from '@drawbridge/web';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDecision,
  claimNext,
  DECISION_CAPABILITY,
  DESTRUCTIVE_CAPABILITY,
  DiscordOperationError,
  type ExternalId,
  enqueueJob,
  pauseExternal,
  type ReconcilePort,
  type RevertPort,
  runWorkerLoop,
  type StepExecution,
  type StepExecutor,
  type WorkerLoopLogger,
  type WorkerLoopOptions,
} from '../src/index.js';

const available = await testDatabaseAvailable();

/** The test guild (plan 05 §1: the only guild live writes may touch). */
const GUILD_ID = '1573554616371777546';
/** A league id for engine-level jobs; jobs carry no FK to leagues by design. */
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-000000000022';
const ROOT_ID = '136264506933248001';
const BOT_ROLE_ID = '880000000000000001';
const STAFF_ROLE_ID = '880000000000000002';
const CAPTAIN_MEMBER_ID = '777000000000000001';
const HUMAN_MEMBER_ID = '888000000000000002';
const API_KEY = 'citadel-api-key-for-tests';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const TEST_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_test';
/** Tags the loop's own connections, so the terminated-connection case can aim. */
const LOOP_APP_NAME = 'failure-injection-loop';
/** The advisory-lock key of the terminated-connection scenario. */
const LOCK_KEY = 424_242;

/** The chaos child: a real process the suite SIGKILLs mid-step (scenario 2). */
const CHAOS_SCRIPT = fileURLToPath(
  new URL('../../testkit/chaos/crashed-worker.mjs', import.meta.url),
);

/** A manual gate: the holder decides when the promise resolves. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves after `total` ticks; the stand-in for "the expected work ran". */
function countdown(total: number): { promise: Promise<void>; tick: () => void } {
  let remaining = total;
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    tick: () => {
      remaining -= 1;
      if (remaining === 0) resolve();
    },
  };
}

/** An injectable clock the tests advance by hand. */
function fakeTime(): { clock: () => number; advance: (ms: number) => void } {
  let now = Date.now();
  return { clock: () => now, advance: (ms) => (now += ms) };
}

/**
 * The injected idle wait: advances the fake clock and resolves at once,
 * counting sleeps so a test can await "the loop idled again" without
 * polling. One idle sleep is also the deterministic "the loop's previous
 * transaction committed" barrier: the loop only idles when every scan and
 * persistence of an iteration has settled.
 */
function sleepHarness(
  time: ReturnType<typeof fakeTime>,
  signal: AbortSignal,
): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  waits: (more: number) => Promise<void>;
} {
  let count = 0;
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  const sleep = async (_ms: number): Promise<void> => {
    if (signal.aborted) return;
    time.advance(1_000);
    count += 1;
    for (const waiter of waiters) {
      if (count >= waiter.target) waiter.resolve();
    }
    await Promise.resolve();
  };
  return {
    sleep,
    /** Resolves after `more` further idle sleeps. */
    waits: (more: number): Promise<void> =>
      new Promise<void>((resolve) => {
        waiters.push({ target: count + more, resolve });
      }),
  };
}

/** Records loop log lines without a logger dependency. */
function recordingLogger(): WorkerLoopLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => {
      errors.push(message);
    },
  };
}

/** An operator holding every decision capability (02 §5.8). */
function operator(userId = 'u-operator-1'): {
  userId: string;
  capabilities: ReadonlySet<Capability>;
} {
  return {
    userId,
    capabilities: new Set<Capability>([DECISION_CAPABILITY, DESTRUCTIVE_CAPABILITY]),
  };
}

/** An operator who may decide but never destroy. */
function decideOnly(userId = 'u-operator-2'): {
  userId: string;
  capabilities: ReadonlySet<Capability>;
} {
  return { userId, capabilities: new Set<Capability>([DECISION_CAPABILITY]) };
}

let hashCounter = 0;

function jobInput(
  guildId: string,
  steps: readonly CreateJobStepInput[],
  overrides: Partial<CreateJobInput> = {},
): CreateJobInput {
  return {
    type: 'tournament.setup',
    guildId,
    leagueId: LEAGUE_ID,
    lane: 'setup',
    plan: {},
    planHash: `fi-${++hashCounter}`,
    steps,
    ...overrides,
  };
}

/** The guild seed every Discord-facing scenario starts from. */
function seedGuildFor(
  fake: FakeDiscord,
  options: { botPosition?: number; staff?: boolean; human?: boolean; channels?: number } = {},
): void {
  const botPosition = options.botPosition ?? 50;
  fake.seedGuild(GUILD_ID, {
    botMember: { name: 'drawbridge', roleIds: [BOT_ROLE_ID] },
    roles: [
      { roleId: BOT_ROLE_ID, name: 'Drawbridge Bot', position: botPosition },
      ...(options.staff ? [{ roleId: STAFF_ROLE_ID, name: 'Staff', position: 10 }] : []),
    ],
    members: [
      { memberId: CAPTAIN_MEMBER_ID, name: 'captain' },
      ...(options.human ? [{ memberId: HUMAN_MEMBER_ID, name: 'human' }] : []),
    ],
    channels: Array.from({ length: options.channels ?? 0 }, (_, index) => ({
      name: `season-channel-${index}`,
      kind: 'text' as const,
    })),
  });
}

/** The §4.2 permission names, granted whenever the bot outranks @everyone. */
const ALL_PERMISSION_NAMES = [
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
] as const;

/** The preflight the suite wires over the fake: permissions from hierarchy. */
function fakePreflight(fake: FakeDiscord): DiscordPreflight {
  return {
    botMemberId: fake.botUserId,
    async permissions(guildId) {
      // A bot removed from the guild learns it here first: the read itself
      // answers 404/10004 and the failure carries the signal onward.
      const roles = await fake.fetchGuildRoles(guildId);
      const me = await fake.fetchMember(guildId, fake.botUserId);
      if (!me) return [];
      const positions = new Map(roles.map((role) => [role.roleId, role.position] as const));
      let myTop = 0;
      for (const held of me.roleIds) {
        myTop = Math.max(myTop, positions.get(held) ?? 0);
      }
      return myTop > 0 ? [...ALL_PERMISSION_NAMES] : [];
    },
  };
}

/** Representative Discord bits per access level; the fake stores bitfields. */
const ALLOW_BITS: Record<string, string> = {
  none: '0',
  read: '1024', // VIEW_CHANNEL
  send: '3072', // VIEW_CHANNEL | SEND_MESSAGES
  manage: '16', // MANAGE_CHANNELS
};

/** Reconciliation over the fake: by ledger ids, or by the audit reason tag. */
function fakeReconcilePort(fake: FakeDiscord): ReconcilePort {
  return {
    async fetchObject(guildId, discordId) {
      try {
        const channels = await fake.fetchGuildChannels(guildId);
        const channel = channels.find((entry) => entry.channelId === discordId);
        if (channel) return { name: channel.name };
        const roles = await fake.fetchGuildRoles(guildId);
        const role = roles.find((entry) => entry.roleId === discordId);
        if (role) return { name: role.name };
        return undefined;
      } catch {
        // The guild itself is unreadable: nothing can be verified, which
        // reconciliation reports as "gone" for the operator to decide on.
        return undefined;
      }
    },
    async searchAuditByReason(guildId, reason) {
      const entries = await fake.fetchAuditEntries(guildId, { reason });
      const hits: Array<{
        discordId: string;
        name: string;
        kind: 'role' | 'category' | 'text_channel';
      }> = [];
      for (const entry of entries) {
        if (entry.action === 'ROLE_CREATE') {
          hits.push({ discordId: entry.targetId, name: entry.targetName ?? '', kind: 'role' });
          continue;
        }
        if (entry.action === 'CHANNEL_CREATE') {
          const channels = await fake.fetchGuildChannels(guildId);
          const channel = channels.find((candidate) => candidate.channelId === entry.targetId);
          hits.push({
            discordId: entry.targetId,
            name: channel?.name ?? entry.targetName ?? '',
            kind: channel?.kind === 'category' ? 'category' : 'text_channel',
          });
        }
      }
      return hits;
    },
  };
}

/** The revert port over the fake, recording every compensation call. */
function fakeRevertPort(fake: FakeDiscord, calls: string[], afterCall?: () => void): RevertPort {
  const archiveCategory = async (guildId: string): Promise<string> => {
    const channels = await fake.fetchGuildChannels(guildId);
    const existing = channels.find(
      (channel) => channel.kind === 'category' && channel.name === 'drawbridge-archive',
    );
    if (existing) return existing.channelId;
    const created = await fake.createCategory(
      guildId,
      { name: 'drawbridge-archive' },
      'drb:archive',
    );
    return created.categoryId;
  };
  return {
    async channelHasHumanMessages(guildId, channelId) {
      const messages = await fake.fetchChannelMessages(guildId, { channelId, limit: 100 });
      return messages.some((message) => !message.authorBot);
    },
    async categoryIsEmpty(guildId, categoryId) {
      const channels = await fake.fetchGuildChannels(guildId);
      return !channels.some((channel) => channel.categoryId === categoryId);
    },
    async deleteRole(guildId, roleId) {
      calls.push(`delete_role:${roleId}`);
      await fake.deleteRole(guildId, roleId, 'drb:revert');
      afterCall?.();
    },
    async deleteChannel(guildId, channelId) {
      calls.push(`delete_channel:${channelId}`);
      await fake.deleteChannel(guildId, channelId, 'drb:revert');
      afterCall?.();
    },
    async archiveChannel(guildId, channelId) {
      calls.push(`archive_channel:${channelId}`);
      const categoryId = await archiveCategory(guildId);
      await fake.moveChannel(guildId, channelId, { categoryId }, 'drb:revert');
      afterCall?.();
    },
    async deleteCategory(guildId, categoryId) {
      calls.push(`delete_category:${categoryId}`);
      await fake.deleteCategory(guildId, categoryId, 'drb:revert');
      afterCall?.();
    },
    async restoreOverwrites(guildId, channelId, overwrites) {
      calls.push(`restore_overwrites:${channelId}`);
      const restored: OverwriteSet[] = overwrites.map((overwrite) => ({
        discordId: overwrite.discordId,
        type: overwrite.type,
        allow: overwrite.allow,
        deny: overwrite.deny,
      }));
      await fake.editOverwrites(guildId, channelId, restored, 'drb:revert');
      afterCall?.();
    },
    async deleteDbRows() {
      // The suite's jobs create no domain rows; the compensation is reached
      // only by a step that recorded one.
      calls.push('delete_db_rows');
      afterCall?.();
    },
  };
}

/** What the suite's step executor needs beyond the step itself. */
interface SuiteExecutorSetup {
  /** The loop's own database: blocked reads and mid-step pauses go through it. */
  db: Database['db'];
  fake: FakeDiscord;
  discord: DiscordExecutor;
  time: ReturnType<typeof fakeTime>;
  /** The Citadel client of the mid-job Citadel read (scenario 3). */
  citadel?: CitadelClient;
  /** Resolved when the blocked step's query is in flight (terminate case). */
  inFlight?: { promise: Promise<void>; resolve: () => void };
  /** Runs before the step's kind switch: mid-job removals and hold gates. */
  beforeStep?: (execution: StepExecution) => Promise<void>;
}

/**
 * The suite's step executor: the todo-25 wiring shape over the real
 * DiscordExecutor. It interprets the plan's step kinds and the suite's
 * custom kinds, records `external_ids` and compensations exactly as the
 * engine contract requires, and rethrows the executor's taxonomy failures
 * as `DiscordOperationError` so the loop's failure path classifies them.
 *
 * A create step whose external ids are already recorded (reconciliation
 * adopted them after a crash) completes by record and never re-creates —
 * the division of labour 02 §5.6 prescribes: reconciliation adopts, the
 * re-run finishes by name.
 */
function createSuiteExecutor(setup: SuiteExecutorSetup): {
  executor: StepExecutor;
  executed: number[];
} {
  const executed: number[] = [];

  const stepsOf = (jobId: string) =>
    setup.db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId)).orderBy(jobSteps.seq);

  /** The Discord id a plan step key created, read from the journal itself. */
  const idOfKey = async (jobId: string, key: string): Promise<string | undefined> => {
    for (const step of await stepsOf(jobId)) {
      if ((step.args as Record<string, unknown>)['key'] !== key) continue;
      const ids = step.externalIds as Array<{ discordId?: unknown }>;
      const discordId = ids[0]?.discordId;
      if (typeof discordId === 'string') return discordId;
    }
    return undefined;
  };

  /** One write through the real executor; failures rethrow as signals. */
  const write = async (job: JobRow, seq: number, op: DiscordOp) => {
    const result = await setup.discord.executeWrite({
      op,
      lane: job.lane as DiscordLane,
      jobId: job.id,
      seq,
    });
    if (result.status === 'failed') {
      throw new DiscordOperationError(result.failure.signal);
    }
    return result.outcome;
  };

  const createRoleStep = async (job: JobRow, step: JobStepRow, name: string) => {
    const outcome = await write(job, step.seq, {
      kind: 'create_role',
      guildId: job.guildId,
      name,
    });
    if (outcome.result.kind !== 'create_role') throw new Error('executor returned a mismatched op');
    return {
      externalIds: [
        { discordId: outcome.result.roleId, kind: 'role', name: outcome.result.name },
      ] satisfies ExternalId[],
      compensation: { kind: 'delete_role', roleId: outcome.result.roleId },
    };
  };

  /** The category of a division, from the journal's recorded creates. */
  const categoryOf = async (jobId: string, division: unknown): Promise<string | undefined> => {
    for (const step of await stepsOf(jobId)) {
      const args = step.args as Record<string, unknown>;
      if (step.kind !== 'create-category' || args['division'] !== division) continue;
      const ids = step.externalIds as Array<{ discordId?: unknown }>;
      const discordId = ids[0]?.discordId;
      if (typeof discordId === 'string') return discordId;
    }
    return undefined;
  };

  /** Plan overwrites (access levels) as the port's overwrite sets. */
  const overwritesOf = async (
    jobId: string,
    args: Record<string, unknown>,
  ): Promise<OverwriteSet[]> => {
    const plan = args['overwrites'] as Array<Record<string, unknown>> | undefined;
    const sets: OverwriteSet[] = [];
    for (const entry of plan ?? []) {
      if (String(entry['targetKind']) === 'everyone') {
        sets.push({
          discordId: GUILD_ID,
          type: 'role',
          allow: ALLOW_BITS[String(entry['level'])] ?? '0',
          deny: '0',
        });
        continue;
      }
      const targetId = await idOfKey(jobId, String(entry['targetId']));
      if (targetId === undefined) {
        throw new Error(`overwrite target ${String(entry['targetId'])} was never created`);
      }
      sets.push({
        discordId: targetId,
        type: 'role',
        allow: ALLOW_BITS[String(entry['level'])] ?? '0',
        deny: '0',
      });
    }
    return sets;
  };

  const executor: StepExecutor = async ({ job, step }) => {
    executed.push(step.seq);
    await setup.beforeStep?.({ job, step });

    const args = step.args as Record<string, unknown>;
    const recorded = step.externalIds as unknown as ExternalId[];

    // Reconciled-onto-the-step objects complete by record: no second create.
    if (recorded.length > 0) {
      return { externalIds: recorded };
    }

    switch (step.kind) {
      case 'create-role': {
        return createRoleStep(job, step, String(args['name']));
      }
      case 'create-category': {
        const outcome = await write(job, step.seq, {
          kind: 'create_category',
          guildId: job.guildId,
          name: String(args['name']),
        });
        if (outcome.result.kind !== 'create_category') {
          throw new Error('executor returned a mismatched op');
        }
        return {
          externalIds: [
            { discordId: outcome.result.categoryId, kind: 'category', name: outcome.result.name },
          ] satisfies ExternalId[],
          compensation: { kind: 'delete_category', categoryId: outcome.result.categoryId },
        };
      }
      case 'create-channel': {
        const categoryId =
          typeof args['categoryId'] === 'string'
            ? args['categoryId']
            : await categoryOf(job.id, args['division']);
        const outcome = await write(job, step.seq, {
          kind: 'create_text_channel',
          guildId: job.guildId,
          name: String(args['name']),
          ...(categoryId === undefined ? {} : { categoryId }),
        });
        if (outcome.result.kind !== 'create_text_channel') {
          throw new Error('executor returned a mismatched op');
        }
        return {
          externalIds: [
            {
              discordId: outcome.result.channelId,
              kind: 'text_channel',
              name: outcome.result.name,
            },
          ] satisfies ExternalId[],
          compensation: { kind: 'delete_channel', channelId: outcome.result.channelId },
        };
      }
      case 'assign-role': {
        await write(job, step.seq, {
          kind: 'add_role_to_member',
          guildId: job.guildId,
          memberId: String(args['memberId']),
          roleId: String(args['roleId']),
        });
        return {};
      }
      case 'send-welcome-message': {
        const channelId = await idOfKey(job.id, String(args['channelKey']));
        if (channelId === undefined) {
          throw new Error(`no recorded channel for welcome step ${step.seq}`);
        }
        const outcome = await write(job, step.seq, {
          kind: 'send_message',
          guildId: job.guildId,
          channelId,
          content: String(args['content']),
          allowedMentions: { parse: [] },
        });
        if (outcome.result.kind !== 'send_message') {
          throw new Error('executor returned a mismatched op');
        }
        return {
          externalIds: [
            {
              discordId: outcome.result.messageId,
              kind: 'message',
              name: String(args['channelName'] ?? 'welcome'),
            },
          ] satisfies ExternalId[],
        };
      }
      case 'set-overwrites': {
        const channelId = await idOfKey(job.id, String(args['channelKey']));
        if (channelId === undefined) {
          throw new Error(`no recorded channel for overwrite step ${step.seq}`);
        }
        const channels = await setup.fake.fetchGuildChannels(job.guildId);
        const channel = channels.find((entry) => entry.channelId === channelId);
        const prior = (channel?.overwrites ?? []).map((overwrite) => ({
          discordId: overwrite.discordId,
          type: overwrite.type,
          allow: overwrite.allow,
          deny: overwrite.deny,
        }));
        const overwrites = await overwritesOf(job.id, args);
        await write(job, step.seq, {
          kind: 'edit_overwrites',
          guildId: job.guildId,
          channelId,
          overwrites,
        });
        return {
          compensation: { kind: 'restore_overwrites', channelId, overwrites: prior },
        };
      }
      case 'citadel-refresh': {
        // A mid-job Citadel read (02 §5.7): an unavailable Citadel pauses
        // the job through the engine; the loop's probe resumes it.
        const citadel = setup.citadel;
        if (!citadel) throw new Error('scenario 3 wires a Citadel client');
        try {
          await citadel.getLeague(String(CITADEL_LEAGUE_ID));
          return { result: { checkedAt: new Date(setup.time.clock()).toISOString() } };
        } catch (err) {
          if (
            err instanceof Error &&
            'code' in err &&
            (err as { code: unknown }).code === 'transient'
          ) {
            await pauseExternal(
              setup.db,
              job.id,
              'Citadel unavailable (transient)',
              setup.time.clock,
            );
            // The job has already moved to paused(external); the failure the
            // loop would apply is now an illegal move it logs and drops.
            throw new Error('paused(external): the step re-runs after the probe succeeds');
          }
          throw err;
        }
      }
      case 'db-blocked-create': {
        // The terminated-connection scenario: the step's first move is a
        // database read the test blocks on a session advisory lock, so the
        // kill lands on an in-flight query.
        // Drizzle wraps driver errors, so the server's own message rides on
        // `cause` — unwrap it so the journal records the termination itself.
        setup.inFlight?.resolve();
        try {
          await setup.db.execute(sql`select pg_advisory_lock(${LOCK_KEY}::bigint)`);
          await setup.db.execute(sql`select pg_advisory_unlock(${LOCK_KEY}::bigint)`);
        } catch (err) {
          const cause = (err as { cause?: unknown }).cause;
          throw cause instanceof Error ? cause : err;
        }
        return createRoleStep(job, step, String(args['name']));
      }
      case 'noop': {
        return {};
      }
      default: {
        // Plan kinds the suite never reaches (the job parks first), and
        // anything unknown: fail loudly instead of pretending to execute.
        throw new Error(
          `step kind '${step.kind}' is not executable in the failure-injection suite`,
        );
      }
    }
  };

  return { executor, executed };
}

/** Per-scenario wall time, for the evidence record. */
const scenarioMs = new Map<string, number>();

/** Times one scenario `it` so the suite can prove the 2 s budget. */
function scenario(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    const startedAt = Date.now();
    await fn();
    scenarioMs.set(name, Date.now() - startedAt);
  });
}

describe.skipIf(!available)('failure injection (plan 05 §3.4, scenarios 1-10)', () => {
  let database: Database;
  let dbA: Database['db'];
  let loopDatabase: Database;
  let dbB: Database['db'];
  let ctx: AppContext;
  let fake: FakeDiscord;
  let time: ReturnType<typeof fakeTime>;
  let citadel: FakeCitadel | undefined;
  let citadelBaseUrl = '';
  let citadelClient: CitadelClient | undefined;

  const config = parseConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:8080',
    DISCORD_APPLICATION_ID: '1573555530901880855',
    DRAWBRIDGE_MASTER_KEY: MASTER_KEY,
    DRAWBRIDGE_MASTER_KEY_ID: 'k1',
  });

  let currentUser = { id: ROOT_ID, username: 'Root', globalName: 'Root', avatar: null };
  /** Live loops and chaos children; a failed scenario must not leak either. */
  const loopControllers: AbortController[] = [];
  const chaosChildren: ChildProcess[] = [];

  beforeAll(async () => {
    database = await prepareTestDatabase();
    dbA = database.db;
    loopDatabase = createDatabase(
      `${TEST_URL}${TEST_URL.includes('?') ? '&' : '?'}application_name=${LOOP_APP_NAME}`,
      1,
    );
    dbB = loopDatabase.db;
    // An idle client the server kills would surface on the pool; the loop's
    // pool must never crash the worker over a connection it can replace.
    loopDatabase.pool.on('error', () => {});

    const logger = createLogger({ level: 'error', sink: () => {} });
    ctx = await buildApp({
      config,
      logger,
      db: dbA,
      pool: database.pool,
      oauth: {
        authorizeUrl: (state) =>
          `https://discord.invalid/oauth2/authorize?client_id=1&state=${encodeURIComponent(state)}`,
        exchangeCode: async () => 'access-token',
        fetchUser: async () => currentUser,
      },
      servePanel: false,
      citadel: (input) =>
        createCitadelClient({ baseUrl: citadelBaseUrl, apiKey: input.apiKey, maxRetries: 0 }),
    });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbA);
    await ensureRootAdmins(dbA, [ROOT_ID]);
    await ensureGuild(dbA, GUILD_ID, 'Failure Injection');
    fake = new FakeDiscord();
    time = fakeTime();
    citadelClient = undefined;
  });

  afterEach(async () => {
    // A failed scenario must not leak a spinning loop (the instant idle wait
    // makes an un-aborted loop a busy scan) or a parked chaos child.
    for (const controller of loopControllers.splice(0)) controller.abort();
    for (const child of chaosChildren.splice(0)) child.kill('SIGKILL');
    if (citadel) {
      await citadel.close();
      citadel = undefined;
    }
  });

  afterAll(async () => {
    if (scenarioMs.size > 0) {
      const lines = [...scenarioMs.entries()].map(([name, ms]) => `${name}: ${ms} ms`);
      console.log(`failure-injection scenario wall times\n${lines.join('\n')}`);
    }
    if (ctx) await ctx.app.close();
    if (loopDatabase) await closeTestDatabase(loopDatabase);
    if (database) await closeTestDatabase(database);
  });

  // ------------------------------------------------------------------
  // Shared harness
  // ------------------------------------------------------------------

  const oneJob = async (jobId: string): Promise<JobRow | undefined> =>
    (await dbA.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0];

  const journalCodes = async (jobId: string): Promise<string[]> =>
    (await getJob(dbA, jobId))?.events.map((event) => event.code) ?? [];

  /** Serves a fresh Citadel fixture set; the web app reads it per request. */
  const serveFixtures = async (
    bodies: Record<string, string> = tournamentFixtures(),
  ): Promise<void> => {
    if (citadel) await citadel.close();
    citadel = await createFakeCitadel({ fixtures: bodies });
    citadelBaseUrl = citadel.baseUrl;
    citadelClient = createCitadelClient({
      baseUrl: citadelBaseUrl,
      apiKey: API_KEY,
      maxRetries: 0,
      // The suite drives a straight outage-recovery arc: every probe reads
      // the real fake server, so the breaker stays out of the way (its
      // open/half-open flapping is Citadel-client behaviour, covered by the
      // client's own tests, not by these engine scenarios).
      breakerThreshold: 1_000,
      // The cache and any cooldown ride the injected clock, so nothing in
      // the client outlives a fake-clock scenario in wall time.
      clock: {
        now: () => time.clock(),
        setTimeout: (handler, ms) => setTimeout(handler, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
  };

  /** The real DiscordExecutor over the fake, clock-driven and untimed. */
  const discordExecutor = (): DiscordExecutor =>
    createDiscordExecutor({
      port: fake,
      clock: time.clock,
      // The rate gate advances the fake clock instead of waiting.
      sleep: async (ms) => {
        time.advance(Math.max(0, ms));
      },
      preflight: fakePreflight(fake),
    });

  /** Starts the worker loop over the suite's defaults. */
  const startLoop = (
    controller: AbortController,
    harness: ReturnType<typeof sleepHarness>,
    overrides: Partial<WorkerLoopOptions> & { executeStep: StepExecutor },
    owner = 'w-1',
  ): Promise<void> => {
    loopControllers.push(controller);
    return runWorkerLoop({
      db: dbB,
      owner,
      clock: time.clock,
      signal: controller.signal,
      intervalMs: 1_000,
      reconcilePort: fakeReconcilePort(fake),
      revertPort: fakeRevertPort(fake, []),
      probeExternal: async () => false,
      sleep: harness.sleep,
      random: () => 0.5,
      ...overrides,
    }).finally(() => {
      const at = loopControllers.indexOf(controller);
      if (at >= 0) loopControllers.splice(at, 1);
    });
  };

  /** Wraps a suite executor so each attempt — success or failure — ticks. */
  const ticking = (
    executor: StepExecutor,
    ticks: Array<{ promise: Promise<void>; resolve: () => void }>,
  ): StepExecutor => {
    let index = 0;
    return async (execution) => {
      try {
        return await executor(execution);
      } finally {
        ticks[index]?.resolve();
        index += 1;
      }
    };
  };

  /**
   * Holds one step's execution: `entered` resolves once the loop is inside
   * the step, and `release` lets it finish. Aborting between the two stops
   * the loop after exactly that step — the deterministic way to park a job
   * mid-run.
   */
  const holdStep = (seq: number) => {
    const entered = deferred();
    const release = deferred();
    return {
      beforeStep: async ({ step }: StepExecution): Promise<void> => {
        if (step.seq === seq) {
          entered.resolve();
          await release.promise;
        }
      },
      entered,
      release,
    };
  };

  const web = {
    async login(): Promise<{ cookie: string; csrf: string }> {
      currentUser = { id: ROOT_ID, username: 'Root', globalName: 'Root', avatar: null };
      const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/discord' });
      expect(start.statusCode).toBe(302);
      const state = start.cookies.find((cookie) => cookie.name === 'drawbridge_oauth_state');
      if (!state) throw new Error('oauth state cookie missing');

      const callback = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/auth/discord/callback?code=abc&state=${encodeURIComponent(state.value)}`,
        headers: { cookie: `drawbridge_oauth_state=${state.value}` },
      });
      expect(callback.statusCode).toBe(302);
      const session = callback.cookies.find((cookie) => cookie.name === 'drawbridge_session');
      const csrf = callback.cookies.find((cookie) => cookie.name === 'drawbridge_csrf');
      if (!session || !csrf) throw new Error('session cookies missing');
      return {
        cookie: `drawbridge_session=${session.value}; drawbridge_csrf=${csrf.value}`,
        csrf: csrf.value,
      };
    },

    headers(login: { cookie: string; csrf: string }): Record<string, string> {
      return { cookie: login.cookie, 'x-csrf-token': login.csrf };
    },

    /** A league with its Citadel key stored, created through the API. */
    async leagueWithKey(as: { cookie: string; csrf: string }): Promise<string> {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/leagues',
        headers: web.headers(as),
        payload: {
          guildId: GUILD_ID,
          citadelLeagueId: CITADEL_LEAGUE_ID,
          name: 'Failure Injection League',
          shortcode: 'FI',
        },
      });
      expect(created.statusCode).toBe(201);
      const leagueId = created.json().league.id as string;
      const key = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/leagues/${leagueId}/citadel-key`,
        headers: web.headers(as),
        payload: { key: API_KEY, label: 'primary' },
      });
      expect(key.statusCode).toBe(200);
      return leagueId;
    },

    async previewFor(
      as: { cookie: string; csrf: string },
      leagueId: string,
    ): Promise<{ previewId: string; body: Record<string, unknown> }> {
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/leagues/${leagueId}/preview`,
        headers: web.headers(as),
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as Record<string, unknown>;
      return { previewId: body['previewId'] as string, body };
    },

    async approve(as: { cookie: string; csrf: string }, previewId: string) {
      return ctx.app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: web.headers(as),
        payload: { previewId },
      });
    },
  };

  const countJobs = async (leagueId?: string): Promise<number> => {
    const result = await database.pool.query(
      leagueId === undefined
        ? 'select count(*)::int as count from jobs'
        : 'select count(*)::int as count from jobs where league_id = $1',
      leagueId === undefined ? [] : [leagueId],
    );
    return result.rows[0]?.count ?? 0;
  };

  /** Every ledger row of the guild, for the ledger-matches-Discord checks. */
  const ledgerRows = () =>
    dbA.select().from(discordObjects).where(eq(discordObjects.guildId, GUILD_ID));

  /** The first external id a step recorded, as a string when it is one. */
  const firstIdOf = (step: JobStepRow | undefined): string | undefined => {
    const ids = step?.externalIds as Array<{ discordId?: unknown }> | undefined;
    const id = ids?.[0]?.discordId;
    return typeof id === 'string' ? id : undefined;
  };

  // ------------------------------------------------------------------
  // Scenarios
  // ------------------------------------------------------------------

  scenario(
    '1. crash after the Discord create, before the ledger write: reconciliation adopts by audit reason, no duplicate',
    async () => {
      seedGuildFor(fake);
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          { seq: 0, kind: 'create-role', args: { name: 'Premier TL' } },
          { seq: 1, kind: 'create-role', args: { name: 'Open TL' } },
        ]),
      );

      // The crash window, exactly as a dying worker leaves it: the job is
      // claimed, the step marked running, the Discord write done — and the
      // ledger write never made.
      const claimed = await claimNext(dbB, ['setup'], 'w-crashed');
      expect(claimed?.id).toBe(job.id);
      if (!claimed) throw new Error('the crash-window claim was lost');
      await dbB
        .update(jobSteps)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(jobSteps.jobId, job.id));
      const runningStep = (
        await dbB
          .select()
          .from(jobSteps)
          .where(eq(jobSteps.jobId, job.id))
          .orderBy(jobSteps.seq)
          .limit(1)
      )[0];
      if (!runningStep) throw new Error('step row missing');

      const suite = createSuiteExecutor({ db: dbB, fake, discord: discordExecutor(), time });
      await suite.executor({ job: claimed, step: runningStep }); // the port write; the worker "dies" here

      const roles = await fake.fetchGuildRoles(GUILD_ID);
      const created = roles.find((role) => role.name === 'Premier TL');
      if (!created) throw new Error('the crashed create never reached Discord');
      expect(await getDiscordObject(dbA, GUILD_ID, created.roleId)).toBeUndefined(); // no ledger row
      await dbB
        .update(jobs)
        .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
        .where(eq(jobs.id, job.id));

      // Restart: a fresh worker reclaims, reconciliation finds the object by
      // its audit reason tag, adopts it, and the job finishes with one role.
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const done = countdown(2);
      const loop = startLoop(controller, harness, {
        executeStep: async (execution) => {
          const result = await suite.executor(execution);
          done.tick();
          return result;
        },
      });
      await done.promise;
      await harness.waits(1); // the completion move has committed
      controller.abort();
      await loop;

      expect((await oneJob(job.id))?.state).toBe('completed');
      const codes = await journalCodes(job.id);
      expect(codes).toContain('job.lease.reclaimed');
      expect(codes).toContain('job.reconcile.adopted');

      // No duplicate: Discord holds exactly one role of the name, and the
      // ledger matches Discord row for row.
      const finalRoles = (await fake.fetchGuildRoles(GUILD_ID)).filter(
        (role) => role.name === 'Premier TL',
      );
      expect(finalRoles).toHaveLength(1);
      const journal = await getJob(dbA, job.id);
      expect(firstIdOf(journal?.steps[0])).toBe(created.roleId);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(2); // the adopted role and the second create
      const port = fakeReconcilePort(fake);
      for (const row of rows) {
        expect(row.state).toBe('live');
        expect(row.createdByJobId).toBe(job.id);
        expect(await port.fetchObject(GUILD_ID, row.discordId)).toBeDefined();
      }
    },
  );

  scenario(
    '2. SIGKILL of a child worker mid-step: the lease expires and another worker resumes from the first unfinished step',
    async () => {
      seedGuildFor(fake);
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          { seq: 0, kind: 'create-role', args: { name: 'Alpha TL' } },
          { seq: 1, kind: 'create-role', args: { name: 'Bravo TL' } },
          { seq: 2, kind: 'create-role', args: { name: 'Charlie TL' } },
          { seq: 3, kind: 'create-role', args: { name: 'Delta TL' } },
        ]),
      );

      // A first worker runs steps 0 and 1, then stops mid-job (the hold makes
      // the stop deterministic: abort registers while step 1 executes).
      const gate = holdStep(1);
      const controllerA = new AbortController();
      const harnessA = sleepHarness(time, controllerA.signal);
      const suiteA = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        beforeStep: gate.beforeStep,
      });
      const loopA = startLoop(controllerA, harnessA, {
        executeStep: suiteA.executor,
      });
      await gate.entered.promise; // the loop is inside step 1
      controllerA.abort(); // stop after the current step
      gate.release.resolve(); // step 1 may finish
      await loopA;
      expect(suiteA.executed).toEqual([0, 1]);
      const stepsAfterFirst = (await getJob(dbA, job.id))?.steps ?? [];
      expect(stepsAfterFirst[0]?.status).toBe('done');
      expect(stepsAfterFirst[1]?.status).toBe('done');
      expect(stepsAfterFirst[2]?.status).toBe('pending');

      // Its lease lapses; a real child process takes the job over and parks
      // mid-step — then dies under SIGKILL, exactly as a killed worker does.
      await dbA
        .update(jobs)
        .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
        .where(eq(jobs.id, job.id));

      const chaosDir = mkdtempSync(join(tmpdir(), 'drb-chaos-'));
      try {
        const child = spawn(process.execPath, [CHAOS_SCRIPT], {
          env: {
            ...process.env,
            DRB_DB_URL: TEST_URL,
            DRB_JOB_ID: job.id,
            DRB_STEP_SEQ: '2',
            DRB_READY_FILE: join(chaosDir, 'ready'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        chaosChildren.push(child);
        const owner = await new Promise<string>((resolve, reject) => {
          let buffer = '';
          let stderr = '';
          child.stderr.on('data', (chunk: Uint8Array) => {
            stderr += Buffer.from(chunk).toString('utf8');
          });
          const onData = (chunk: Uint8Array): void => {
            buffer += Buffer.from(chunk).toString('utf8');
            const line = buffer.split('\n')[0] ?? '';
            if (line.startsWith('READY ')) {
              cleanup();
              resolve(line.slice('READY '.length));
            }
          };
          const onExit = (code: number | null): void => {
            cleanup();
            reject(
              new Error(
                `the chaos child exited (${code}) before it was mid-step: ${stderr.slice(0, 400)}`,
              ),
            );
          };
          const cleanup = (): void => {
            child.stdout.off('data', onData);
            child.off('exit', onExit);
          };
          child.stdout.on('data', onData);
          child.on('exit', onExit);
        });

        child.kill('SIGKILL');
        const end = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        expect(end.signal).toBe('SIGKILL');

        // The lease the dead child holds expires; another worker reclaims and
        // resumes from the first unfinished step.
        await dbA.execute(
          sql`update jobs set lease_expires_at = now() - interval '5 seconds' where id = ${job.id} and lease_owner = ${owner}`,
        );

        const suiteB = createSuiteExecutor({ db: dbB, fake, discord: discordExecutor(), time });
        const controllerB = new AbortController();
        const harnessB = sleepHarness(time, controllerB.signal);
        const done = countdown(2);
        const loopB = startLoop(controllerB, harnessB, {
          executeStep: async (execution) => {
            const result = await suiteB.executor(execution);
            done.tick();
            return result;
          },
        });
        await done.promise;
        await harnessB.waits(1);
        controllerB.abort();
        await loopB;

        // The recovery resumed from the first unfinished step (2), never
        // re-running the two steps the first worker had already finished.
        expect(suiteB.executed).toEqual([2, 3]);
        expect((await oneJob(job.id))?.state).toBe('completed');
        const final = await oneJob(job.id);
        expect(final?.attempt).toBe(3); // claim, child takeover, recovery reclaim
        const codes = await journalCodes(job.id);
        expect(codes.filter((code) => code === 'job.lease.reclaimed')).toHaveLength(2);
        expect(codes).toContain('job.reconcile.rerun'); // the killed step left no Discord trace

        // The ledger matches Discord: four live rows, one role each.
        const rows = await ledgerRows();
        expect(rows).toHaveLength(4);
        for (const name of ['Alpha TL', 'Bravo TL', 'Charlie TL', 'Delta TL']) {
          const matches = (await fake.fetchGuildRoles(GUILD_ID)).filter(
            (role) => role.name === name,
          );
          expect(matches).toHaveLength(1);
        }
      } finally {
        rmSync(chaosDir, { recursive: true, force: true });
      }
    },
  );

  scenario(
    '3. Citadel 503 for five simulated minutes: the job pauses external, probes, and completes after recovery',
    async () => {
      seedGuildFor(fake);
      await serveFixtures();
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          { seq: 0, kind: 'create-category', args: { name: 'Premier TL', division: 'Premier' } },
          { seq: 1, kind: 'citadel-refresh' },
          { seq: 2, kind: 'create-role', args: { name: 'Premier Role TL' } },
        ]),
      );

      const client = citadelClient;
      const server = citadel;
      if (!client || !server) throw new Error('scenario 3 needs its Citadel pair');
      await server.setMode('503');

      // The outage is data, not a wall clock: the probe reads real Citadel
      // answers, and the 30-second cadence lives in next_run_at.
      const probes = Array.from({ length: 11 }, () => deferred());
      let probeCount = 0;
      const probeExternal = async (): Promise<boolean> => {
        const index = probeCount;
        probeCount += 1;
        try {
          await client.getLeague(String(CITADEL_LEAGUE_ID));
          return true;
        } catch {
          return false;
        } finally {
          probes[index]?.resolve();
        }
      };

      const ticks = [deferred(), deferred(), deferred(), deferred()];
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const suite = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        citadel: client,
      });
      const loop = startLoop(controller, harness, {
        probeExternal,
        executeStep: ticking(suite.executor, ticks),
      });

      await ticks[0]?.promise;
      await ticks[1]?.promise;
      await harness.waits(1); // the pause has committed and the loop idled

      const paused = await oneJob(job.id);
      expect(paused?.state).toBe('paused');
      expect(paused?.pauseReason).toBe('external');

      // Five simulated minutes of failing probes, thirty fake seconds apart.
      const outageStart = time.clock();
      for (let cycle = 0; cycle < 10; cycle++) {
        time.advance(30_000);
        await updateJobState(dbA, job.id, { nextRunAt: new Date(Date.now() - 1_000) });
        await probes[cycle]?.promise; // the probe ran
        await harness.waits(1); // its postpone committed and the loop idled
      }
      expect(time.clock() - outageStart).toBeGreaterThanOrEqual(300_000); // five simulated minutes
      expect(probeCount).toBe(10);
      // Silent postpones: one pause row, nothing per probe (02 §5.7).
      const events = (await getJob(dbA, job.id))?.events ?? [];
      expect(events.filter((event) => event.code === 'job.paused')).toHaveLength(1);

      // Citadel recovers; the next probe resumes the job and it completes.
      await server.setMode('ok');
      time.advance(30_000);
      await updateJobState(dbA, job.id, { nextRunAt: new Date(Date.now() - 1_000) });
      await probes[10]?.promise; // the resuming probe
      await ticks[2]?.promise; // the Citadel read re-ran
      // The resume wrote next_run_at on the injected clock, which the outage
      // pushed ahead of the database clock; the loop's own-job scan compares
      // against the database clock, so the due time is aligned as data — the
      // same seam the existing loop tests bridge for pauses.
      await updateJobState(dbA, job.id, { nextRunAt: new Date(Date.now() - 1_000) });
      await ticks[3]?.promise; // the last step
      await harness.waits(1);
      controller.abort();
      await loop;

      expect((await oneJob(job.id))?.state).toBe('completed');
      const codes = await journalCodes(job.id);
      expect(codes).toContain('job.resumed');
      expect(codes.at(-1)).toBe('job.completed');
      const journal = await getJob(dbA, job.id);
      expect(journal?.steps[1]?.status).toBe('done'); // the paused step finished after recovery
      // The Discord half of the job is intact and recorded.
      const rows = await ledgerRows();
      expect(rows).toHaveLength(2); // the category and the role
    },
  );

  scenario(
    '4. Discord 429 with retry_after 30: the job pauses ratelimit and resumes without consuming the attempt',
    async () => {
      seedGuildFor(fake);
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          { seq: 0, kind: 'create-channel', args: { name: 'team-alpha', division: 'Premier' } },
          { seq: 1, kind: 'create-role', args: { name: 'Premier TL' } },
        ]),
      );
      fake.failOnce('createTextChannel', {
        status: 429,
        retryAfterSeconds: 30,
        bucket: 'channels:guild:main',
        rateLimitScope: 'user',
        message: 'You are being rate limited.',
      });

      const pausedAt = time.clock();
      const ticks = [deferred(), deferred(), deferred()];
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const suite = createSuiteExecutor({ db: dbB, fake, discord: discordExecutor(), time });
      const loop = startLoop(controller, harness, {
        executeStep: ticking(suite.executor, ticks),
      });

      await ticks[0]?.promise; // the 429 landed
      await harness.waits(1); // the pause has committed

      const paused = await oneJob(job.id);
      expect(paused?.state).toBe('paused');
      expect(paused?.pauseReason).toBe('ratelimit');
      expect(paused?.nextRunAt.getTime()).toBe(pausedAt + 30_000); // retry_after arithmetic
      const steps = (await getJob(dbA, job.id))?.steps ?? [];
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.attempts).toBe(0); // 429 consumes no attempt (02 §5.7)

      // The wait elapses on the fake clock; the claim scan resumes the job.
      time.advance(30_000);
      await updateJobState(dbA, job.id, { nextRunAt: new Date(Date.now() - 1_000) });
      await ticks[1]?.promise; // the step re-ran clean
      await ticks[2]?.promise; // the remaining step
      await harness.waits(1);
      controller.abort();
      await loop;

      expect((await oneJob(job.id))?.state).toBe('completed');
      const codes = await journalCodes(job.id);
      expect(codes).toContain('job.paused');
      expect(codes).toContain('job.resumed');
      const after = (await getJob(dbA, job.id))?.steps ?? [];
      expect(after[0]?.attempts).toBe(0); // still no attempt consumed
      // The ledger matches Discord: one channel, one role, each once.
      const channels = (await fake.fetchGuildChannels(GUILD_ID)).filter(
        (channel) => channel.name === 'team-alpha',
      );
      expect(channels).toHaveLength(1);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(2);
    },
  );

  scenario(
    '5. 403 on a role assignment: awaiting_decision, the skip is recorded, and the job completes with skips',
    async () => {
      // The bot sits below the Staff role, so assigning it is a hierarchy 403.
      seedGuildFor(fake, { botPosition: 5, staff: true, human: true });
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          {
            seq: 0,
            kind: 'assign-role',
            args: { memberId: CAPTAIN_MEMBER_ID, roleId: STAFF_ROLE_ID },
            skippable: true,
          },
          { seq: 1, kind: 'create-role', args: { name: 'Premier TL' } },
        ]),
      );

      const ticks = [deferred(), deferred()];
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const suite = createSuiteExecutor({ db: dbB, fake, discord: discordExecutor(), time });
      const loop = startLoop(controller, harness, {
        executeStep: ticking(suite.executor, ticks),
      });

      await ticks[0]?.promise; // the assignment was refused
      await harness.waits(1);

      const parked = await oneJob(job.id);
      expect(parked?.state).toBe('awaiting_decision');
      const journal = await getJob(dbA, job.id);
      const askRow = journal?.events.at(-1);
      expect(askRow?.code).toBe('job.awaiting_decision');
      expect(askRow?.message).toContain('missing_permission');
      expect(askRow?.message).toContain('Staff');
      expect(journal?.steps[0]?.status).toBe('failed');
      expect(journal?.steps[0]?.error).toMatchObject({ class: 'missing_permission', code: 50013 });

      // The operator decides to skip the step; the skip is recorded.
      const decided = await applyDecision(dbA, job.id, { type: 'skip', stepSeq: 0 }, operator());
      expect(decided.state).toBe('running');

      // The decision handed the job back with an expired lease; the loop
      // reclaims it and finishes the remaining step.
      await ticks[1]?.promise;
      await harness.waits(1);
      controller.abort();
      await loop;

      const final = await oneJob(job.id);
      expect(final?.state).toBe('completed_with_skips');
      const after = await getJob(dbA, job.id);
      expect(after?.steps[0]?.status).toBe('skipped'); // the recorded skip
      expect(after?.steps[1]?.status).toBe('done');
      const codes = await journalCodes(job.id);
      expect(codes).toContain('job.decision.skip');
      const doneRow = after?.events.at(-1);
      expect(doneRow?.code).toBe('job.completed_with_skips');
      expect(doneRow?.data).toMatchObject({ skippedCount: 1 });

      // The refusal was real: the member never got the role, and what did run
      // is in the ledger exactly once.
      const member = await fake.fetchMember(GUILD_ID, CAPTAIN_MEMBER_ID);
      expect(member?.roleIds).not.toContain(STAFF_ROLE_ID);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(1);
    },
  );

  scenario(
    '6. 30013 at the guild channel cap: awaiting_decision showing the limit, and the preview had flagged the headroom',
    async () => {
      await serveFixtures();
      // A guild one season deep: 496 of the 500 channel slots are used, and
      // the ledger says so because the bot provisioned them.
      seedGuildFor(fake, { channels: 496 });
      await dbA.insert(discordObjects).values(
        Array.from({ length: 496 }, (_, index) => ({
          guildId: GUILD_ID,
          discordId: (900_000_000_000_000_000n + BigInt(index)).toString(),
          kind: 'text_channel',
          ownerType: 'guild',
          ownerId: GUILD_ID,
          createdByJobId: null,
          state: 'live',
        })),
      );

      // The real preview API: the plan fits its own caps, but the headroom
      // flags the guild cap the plan is about to cross.
      const asRoot = await web.login();
      const leagueId = await web.leagueWithKey(asRoot);
      const preview = await web.previewFor(asRoot, leagueId);
      const headroom = preview.body['capacityHeadroom'] as Array<Record<string, unknown>>;
      expect(headroom).toHaveLength(1);
      expect(headroom[0]?.['scope']).toBe('channels');
      expect(headroom[0]?.['limit']).toBe(500);
      expect(Number(headroom[0]?.['existing']) + Number(headroom[0]?.['planned'])).toBeGreaterThan(
        500,
      );

      // The admin approves anyway; the job runs until Discord answers 30013.
      const approved = await web.approve(asRoot, preview.previewId);
      expect(approved.statusCode).toBe(201);
      const jobId = approved.json().job.id as string;

      const ticks = Array.from({ length: 11 }, () => deferred());
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const suite = createSuiteExecutor({ db: dbB, fake, discord: discordExecutor(), time });
      const loop = startLoop(controller, harness, {
        executeStep: ticking(suite.executor, ticks),
      });

      // 6 roles, 2 categories and 2 channels fit; the third channel create
      // crosses the cap and Discord answers 30013.
      await ticks[10]?.promise;
      await harness.waits(1);
      controller.abort();
      await loop;

      const parked = await oneJob(jobId);
      expect(parked?.state).toBe('awaiting_decision');
      const journal = await getJob(dbA, jobId);
      const askRow = journal?.events.at(-1);
      expect(askRow?.code).toBe('job.awaiting_decision');
      expect(askRow?.message).toContain('capacity');
      expect(askRow?.message).toContain('500'); // the limit is shown (02 §4.13)
      const failedStep = journal?.steps.find((step) => step.status === 'failed');
      expect(failedStep?.error).toMatchObject({ class: 'capacity', code: 30013 });
      expect(failedStep?.kind).toBe('create-channel');

      // The guild sits exactly at its cap, and the ledger matches Discord.
      const channels = await fake.fetchGuildChannels(GUILD_ID);
      expect(channels).toHaveLength(500);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(496 + 6 + 2 + 2); // seeded + roles + categories + channels
      expect(rows.every((row) => row.state === 'live')).toBe(true);
    },
  );

  scenario(
    '7. revert of a partial setup: reverse order, the ledger matches Discord, and a channel with human messages is archived, not deleted',
    async () => {
      seedGuildFor(fake, { human: true });
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          {
            seq: 0,
            kind: 'create-category',
            args: { name: 'Premier TL', division: 'Premier' },
            reversible: true,
          },
          { seq: 1, kind: 'create-role', args: { name: 'Div Premier TL' }, reversible: true },
          {
            seq: 2,
            kind: 'create-channel',
            args: { key: 'channel:alpha', name: 'team-alpha', division: 'Premier' },
            reversible: true,
          },
          {
            seq: 3,
            kind: 'create-channel',
            args: { key: 'channel:bravo', name: 'team-bravo', division: 'Premier' },
            reversible: true,
          },
          {
            seq: 4,
            kind: 'send-welcome-message',
            args: { channelKey: 'channel:alpha', channelName: 'team-alpha', content: 'Welcome!' },
            reversible: false,
          },
          {
            seq: 5,
            kind: 'create-channel',
            args: { key: 'channel:charlie', name: 'team-charlie', division: 'Premier' },
          },
        ]),
      );

      // A partial setup: the worker finishes five of six steps and stops —
      // the hold parks it inside step 4, the abort registers, the step
      // finishes, and the loop exits with step 5 pending.
      const gate = holdStep(4);
      const controllerA = new AbortController();
      const harnessA = sleepHarness(time, controllerA.signal);
      const suite = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        beforeStep: gate.beforeStep,
      });
      const loopA = startLoop(controllerA, harnessA, { executeStep: suite.executor });
      await gate.entered.promise; // the loop is inside step 4
      controllerA.abort(); // stop after the current step
      gate.release.resolve(); // step 4 may finish
      await loopA;
      expect(suite.executed).toEqual([0, 1, 2, 3, 4]);
      const stepsAfterPartial = (await getJob(dbA, job.id))?.steps ?? [];
      expect(stepsAfterPartial[4]?.status).toBe('done');
      expect(stepsAfterPartial[5]?.status).toBe('pending');

      // A human posted in team-alpha after the setup.
      const steps = (await getJob(dbA, job.id))?.steps ?? [];
      const alphaId = firstIdOf(steps[2]);
      const bravoId = firstIdOf(steps[3]);
      const roleId = firstIdOf(steps[1]);
      const categoryId = firstIdOf(steps[0]);
      if (!alphaId || !bravoId || !roleId || !categoryId) throw new Error('missing created ids');
      fake.humanMessage(GUILD_ID, alphaId, {
        authorId: HUMAN_MEMBER_ID,
        content: 'gl hf this season',
      });

      // The destructive gate first: a revert that deletes demands confirmation.
      await expect(applyDecision(dbA, job.id, { type: 'revert' }, decideOnly())).rejects.toThrow(
        /tournament.destructive/,
      );
      expect((await oneJob(job.id))?.state).toBe('running'); // nothing changed

      // The operator confirms the destructive revert.
      const decided = await applyDecision(dbA, job.id, { type: 'revert' }, operator());
      expect(decided.state).toBe('reverting');

      const calls: string[] = [];
      const revertDone = deferred();
      const revertPort = fakeRevertPort(fake, calls, () => {
        if (calls.length === 4) revertDone.resolve();
      });
      const controllerB = new AbortController();
      const harnessB = sleepHarness(time, controllerB.signal);
      const loopB = startLoop(controllerB, harnessB, {
        executeStep: async () => {
          throw new Error('no forward step may run during a revert');
        },
        revertPort,
      });
      await revertDone.promise;
      await harnessB.waits(1); // finish_revert has committed
      controllerB.abort();
      await loopB;

      expect((await oneJob(job.id))?.state).toBe('reverted');

      // Everything created was compensated in reverse order; the channel with
      // human messages was archived, never deleted (02 §5.9); the welcome
      // message is non-reversible and stayed.
      expect(calls).toEqual([
        `delete_channel:${bravoId}`,
        `archive_channel:${alphaId}`,
        `delete_role:${roleId}`,
        `delete_category:${categoryId}`,
      ]);
      const codes = await journalCodes(job.id);
      expect(codes).toContain('job.revert.not_reversible'); // the welcome step, listed and left
      expect(codes).toContain('job.reverted');

      // The ledger matches Discord exactly.
      const rows = await ledgerRows();
      const byState = new Map(rows.map((row) => [row.discordId, row.state]));
      expect(byState.get(categoryId)).toBe('deleted');
      expect(byState.get(roleId)).toBe('deleted');
      expect(byState.get(bravoId)).toBe('deleted');
      expect(byState.get(alphaId)).toBe('archived');
      const channels = await fake.fetchGuildChannels(GUILD_ID);
      const alpha = channels.find((channel) => channel.channelId === alphaId);
      expect(alpha).toBeDefined(); // archived, not deleted
      const archive = channels.find((channel) => channel.name === 'drawbridge-archive');
      expect(alpha?.categoryId).toBe(archive?.channelId);
      expect(channels.find((channel) => channel.channelId === bravoId)).toBeUndefined();
      expect(channels.find((channel) => channel.channelId === categoryId)).toBeUndefined();
      const roles = await fake.fetchGuildRoles(GUILD_ID);
      expect(roles.find((role) => role.roleId === roleId)).toBeUndefined();
      // The archived channel still holds its human history.
      const messages = await fake.fetchChannelMessages(GUILD_ID, {
        channelId: alphaId,
        limit: 100,
      });
      expect(messages.some((message) => !message.authorBot)).toBe(true);
    },
  );

  scenario('8. double approval of the same plan creates exactly one job', async () => {
    await serveFixtures();
    const asRoot = await web.login();
    const leagueId = await web.leagueWithKey(asRoot);
    const preview = await web.previewFor(asRoot, leagueId);

    const first = await web.approve(asRoot, preview.previewId);
    expect(first.statusCode).toBe(201);
    const jobId = first.json().job.id as string;

    // The same approval again is idempotent: the existing job comes back.
    const second = await web.approve(asRoot, preview.previewId);
    expect(second.statusCode).toBe(200);
    expect(second.json().job.id).toBe(jobId);

    // A second preview of the same league hashes identically; approving it
    // bounces off the duplicate guard (02 §5.10).
    const again = await web.previewFor(asRoot, leagueId);
    expect(again.body['planHash']).toBe(preview.body['planHash']);
    const refused = await web.approve(asRoot, again.previewId);
    expect(refused.statusCode).toBe(409);
    expect(String(refused.json().error)).toContain('active_duplicate');

    // One job, one job.create audit row, and no Discord write anywhere.
    expect(await countJobs(leagueId)).toBe(1);
    const audits = await database.pool.query(
      "select count(*)::int as count from audit_log where action = 'job.create'",
    );
    expect(audits.rows[0]?.count).toBe(1);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(0);
  });

  scenario(
    '9. Citadel drift between preview and approval: the approval is refused until the admin re-previews',
    async () => {
      const asRoot = await web.login();
      await serveFixtures();
      const leagueId = await web.leagueWithKey(asRoot);
      const preview = await web.previewFor(asRoot, leagueId);
      const planHash = preview.body['planHash'];

      // Citadel moves on: one roster is renamed, so the live plan re-hashes.
      await serveFixtures(tournamentFixtures({ 9402: 'Bravo Uno' }));

      const refused = await web.approve(asRoot, preview.previewId);
      expect(refused.statusCode).toBe(409);
      expect(String(refused.json().error)).toContain('plan_changed');
      expect(await countJobs()).toBe(0); // nothing was created

      // The refused approval left the preview open and untouched.
      const stillOpen = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/previews/${preview.previewId}`,
        headers: { cookie: asRoot.cookie },
      });
      expect(stillOpen.statusCode).toBe(200);

      // The admin re-previews; the new preview binds to the moved-on data.
      const rePreview = await web.previewFor(asRoot, leagueId);
      expect(rePreview.body['planHash']).not.toBe(planHash);
      const approved = await web.approve(asRoot, rePreview.previewId);
      expect(approved.statusCode).toBe(201);
      expect(approved.json().job.planHash).toBe(rePreview.body['planHash']);
      expect(await countJobs(leagueId)).toBe(1);

      // Audit invariant: the re-preview is recorded, and exactly one job was
      // ever created.
      const audits = await database.pool.query(
        "select count(*)::int as count from audit_log where action = 'preview.create'",
      );
      expect(audits.rows[0]?.count).toBe(2);
      const created = await database.pool.query(
        "select count(*)::int as count from audit_log where action = 'job.create'",
      );
      expect(created.rows[0]?.count).toBe(1);
      expect((await ledgerRows()).length).toBe(0); // an approval creates no Discord write
    },
  );

  scenario(
    '10. the bot removed mid-job: paused guild_unavailable, asking for a decision',
    async () => {
      seedGuildFor(fake);
      const stepsFor = (): readonly CreateJobStepInput[] => [
        { seq: 0, kind: 'create-role', args: { name: 'Premier TL' } },
        { seq: 1, kind: 'create-channel', args: { name: 'team-alpha', division: 'Premier' } },
      ];
      const job = await enqueueJob(dbA, jobInput(GUILD_ID, stepsFor()));

      // The bot is removed between the two steps.
      const pausedAt = time.clock();
      const ticks = [deferred(), deferred()];
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      let botRemoved = false;
      const removeOnce = async ({ step }: StepExecution): Promise<void> => {
        if (step.seq === 1 && !botRemoved) {
          botRemoved = true;
          fake.removeBot(GUILD_ID);
        }
      };
      const suite = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        beforeStep: removeOnce,
      });
      const loop = startLoop(controller, harness, {
        executeStep: ticking(suite.executor, ticks),
      });

      await ticks[0]?.promise;
      await ticks[1]?.promise;
      await harness.waits(1);

      const paused = await oneJob(job.id);
      expect(paused?.state).toBe('paused');
      expect(paused?.pauseReason).toBe('guild_unavailable');
      expect(paused?.nextRunAt.getTime()).toBe(pausedAt + 30_000); // the retry schedule
      const journal = await getJob(dbA, job.id);
      expect(journal?.steps[1]?.status).toBe('failed');
      expect(journal?.steps[1]?.error).toMatchObject({ guildUnavailable: true, code: 10004 });

      // The pause asks for a decision an operator can actually make.
      const codes = journal?.events.map((event) => event.code) ?? [];
      expect(codes).toContain('job.paused');
      expect(codes).toContain('job.guild_unavailable');
      const askRow = journal?.events.at(-1);
      expect(askRow?.message).toContain('re-invite');
      expect(askRow?.message).toContain('abort');

      // One answer is to abort; the decision path works from the pause.
      const aborted = await applyDecision(dbA, job.id, { type: 'abort' }, operator());
      expect(aborted.state).toBe('cancelled');
      controller.abort();
      await loop;

      // The other answer is to re-invite the bot: the retry schedule resumes
      // the job on its own, no operator required.
      fake.rejoinGuild(GUILD_ID);
      const job2 = await enqueueJob(dbA, jobInput(GUILD_ID, stepsFor()));
      const ticks2 = [deferred(), deferred(), deferred()];
      const controller2 = new AbortController();
      const harness2 = sleepHarness(time, controller2.signal);
      let botRemovedAgain = false;
      const suite2 = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        beforeStep: async ({ step }) => {
          if (step.seq === 1 && !botRemovedAgain) {
            botRemovedAgain = true;
            fake.removeBot(GUILD_ID);
          }
        },
      });
      const loop2 = startLoop(controller2, harness2, {
        executeStep: ticking(suite2.executor, ticks2),
      });
      await ticks2[0]?.promise;
      await ticks2[1]?.promise;
      await harness2.waits(1);
      expect((await oneJob(job2.id))?.pauseReason).toBe('guild_unavailable');

      fake.rejoinGuild(GUILD_ID);
      time.advance(30_000);
      await updateJobState(dbA, job2.id, { nextRunAt: new Date(Date.now() - 1_000) });
      await ticks2[2]?.promise; // the claim scan resumed and finished the step
      await harness2.waits(1);
      controller2.abort();
      await loop2;

      expect((await oneJob(job2.id))?.state).toBe('completed');
      const codes2 = await journalCodes(job2.id);
      expect(codes2).toContain('job.resumed');
      expect(codes2.at(-1)).toBe('job.completed');
      const channels = (await fake.fetchGuildChannels(GUILD_ID)).filter(
        (channel) => channel.name === 'team-alpha',
      );
      expect(channels).toHaveLength(1); // created exactly once
      const rows = await ledgerRows();
      expect(rows.filter((row) => row.createdByJobId === job2.id)).toHaveLength(2);
    },
  );

  scenario(
    'chaos: pg_terminate_backend on the worker connection mid-step; the loop recovers',
    async () => {
      seedGuildFor(fake);
      const job = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [
          { seq: 0, kind: 'db-blocked-create', args: { name: 'Blocked TL' } },
          { seq: 1, kind: 'create-role', args: { name: 'After TL' } },
        ]),
      );

      // Hold the advisory lock on a dedicated connection, so step 0's first
      // database call blocks with a query genuinely in flight.
      const lockClient = await database.pool.connect();
      await lockClient.query('select pg_advisory_lock($1::bigint)', [LOCK_KEY]);
      const inFlight = deferred();
      const ticks = [deferred(), deferred(), deferred(), deferred()];
      const controller = new AbortController();
      const harness = sleepHarness(time, controller.signal);
      const suite = createSuiteExecutor({
        db: dbB,
        fake,
        discord: discordExecutor(),
        time,
        inFlight,
      });
      const loop = startLoop(controller, harness, {
        executeStep: ticking(suite.executor, ticks),
      });

      await inFlight.promise; // the step's query is blocked on the lock
      const killed = await database.pool.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and datname = current_database()',
        [LOOP_APP_NAME],
      );
      expect(killed.rowCount ?? 0).toBeGreaterThanOrEqual(1);
      try {
        await lockClient.query('select pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
      } finally {
        lockClient.release();
      }

      await ticks[0]?.promise; // the blocked query died; the failure path ran
      await harness.waits(1);

      // The step's failure is the termination itself, parked for a decision.
      const parked = await oneJob(job.id);
      expect(parked?.state).toBe('awaiting_decision');
      const journal = await getJob(dbA, job.id);
      const failureRow = journal?.events.find((event) => event.code === 'job.step.failure');
      expect(failureRow?.message).toMatch(/administrator command|terminated/i);

      // The loop recovered: it kept working through its replacement connection.
      const healthy = await enqueueJob(
        dbA,
        jobInput(GUILD_ID, [{ seq: 0, kind: 'create-role', args: { name: 'Healthy TL' } }]),
      );
      await ticks[1]?.promise; // the healthy job's step ran
      await harness.waits(1);
      expect((await oneJob(healthy.id))?.state).toBe('completed');

      // The operator retries the parked job; the loop reclaims and finishes.
      await applyDecision(dbA, job.id, { type: 'retry' }, operator());
      await ticks[2]?.promise; // the step re-ran on a fresh connection
      await ticks[3]?.promise; // the last step
      await harness.waits(1);
      controller.abort();
      await loop;

      expect((await oneJob(job.id))?.state).toBe('completed');
      // The first attempt never reached Discord: each role exists exactly once.
      for (const name of ['Blocked TL', 'After TL', 'Healthy TL']) {
        const matches = (await fake.fetchGuildRoles(GUILD_ID)).filter((role) => role.name === name);
        expect(matches).toHaveLength(1);
      }
      const rows = await ledgerRows();
      expect(rows).toHaveLength(3);
    },
  );
});
