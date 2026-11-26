/**
 * Integration tests for the worker loop (plan 02 §3.1-3.2, §4.4, §5.5-5.7,
 * §5.11) against real Postgres: lane-ordered claims, one step per
 * iteration under a heartbeat, recovery of expired leases, external-pause
 * probes (the enumeration todo 17 left open), revert pickup, the
 * scheduled-operation driver, graceful shutdown and two-worker exclusivity.
 *
 * Time flows through an injected fake clock and the loop's idle wait is an
 * injected instant sleep, so iterations run at microtask speed and no test
 * touches a real timer except the faked heartbeat interval.
 */
import type { Capability } from '@drawbridge/authz';
import {
  type CreateJobInput,
  ensureGuild,
  getDiscordObject,
  getJob,
  type JobRow,
  jobSteps,
  jobs,
  leagues,
  updateJobState,
} from '@drawbridge/db';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  claimNext,
  DECISION_CAPABILITY,
  DESTRUCTIVE_CAPABILITY,
  DiscordOperationError,
  enqueueJob,
  HEARTBEAT_SECONDS,
  pauseExternal,
  type ReconcilePort,
  type RevertPort,
  runWorkerLoop,
  type ScheduledOperation,
  type StepExecution,
  type StepExecutor,
  type WorkerLoopLogger,
  type WorkerLoopOptions,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';
const LEAGUE_ID = '1e6b0f5e-0000-4000-8000-000000000001';
const ROLE_ID = '666666666666666666';

/** A manual gate: the holder decides when the promise resolves. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves after `total` ticks; a stand-in for "the expected work ran". */
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
 * The injected idle wait: advances the fake clock and resolves at once —
 * immediately when the signal is already aborted — counting sleeps so a
 * test can await "N idle iterations passed" without polling.
 */
function sleepHarness(
  time: ReturnType<typeof fakeTime>,
  signal: AbortSignal,
): {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  waits: (target: number) => Promise<void>;
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
    waits: async (target: number): Promise<void> => {
      if (count >= target) return;
      await new Promise<void>((resolve) => {
        waiters.push({ target, resolve });
      });
    },
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

/** A reconcile port that finds nothing — a reclaim re-runs the step. */
function calmReconcilePort(): ReconcilePort {
  return {
    async fetchObject() {
      return undefined;
    },
    async searchAuditByReason() {
      return [];
    },
  };
}

/** A revert port whose methods record and never fail. */
function recordingRevertPort(onDeleteRole?: () => void): RevertPort {
  return {
    async channelHasHumanMessages() {
      return true;
    },
    async categoryIsEmpty() {
      return true;
    },
    async deleteRole(_guildId, _roleId) {
      onDeleteRole?.();
    },
    async deleteChannel() {},
    async archiveChannel() {},
    async deleteCategory() {},
    async restoreOverwrites() {},
    async deleteDbRows() {},
  };
}

/** The external-pause probe as a recording fake. */
function probeHarness(result: () => boolean) {
  const calls: JobRow[] = [];
  const called = deferred();
  return {
    calls,
    called,
    probeExternal: async (job: JobRow): Promise<boolean> => {
      calls.push(job);
      called.resolve();
      return result();
    },
  };
}

const actor = (userId: string, ...capabilities: Capability[]) => ({
  userId,
  capabilities: new Set<Capability>(capabilities),
});

let hashCounter = 0;

function jobInput(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId: LEAGUE_ID,
    lane: 'setup',
    plan: { divisions: 1 },
    planHash: `hash-${++hashCounter}`,
    steps: [{ seq: 0, kind: 'noop', reversible: true }],
    ...overrides,
  };
}

describe.skipIf(!available)('worker loop (integration)', () => {
  let database: Awaited<ReturnType<typeof prepareTestDatabase>>;
  let db: Awaited<ReturnType<typeof prepareTestDatabase>>['db'];
  let time: ReturnType<typeof fakeTime>;

  const oneJob = async (jobId: string): Promise<JobRow | undefined> =>
    (await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1))[0];

  /** Starts a loop with the shared test defaults and the given overrides. */
  const startLoop = (
    controller: AbortController,
    harness: ReturnType<typeof sleepHarness>,
    overrides: Partial<WorkerLoopOptions> & { executeStep: StepExecutor },
    owner = 'w1',
  ): Promise<void> =>
    runWorkerLoop({
      db,
      owner,
      clock: time.clock,
      signal: controller.signal,
      intervalMs: 1_000,
      reconcilePort: calmReconcilePort(),
      revertPort: recordingRevertPort(),
      probeExternal: async () => false,
      sleep: harness.sleep,
      random: () => 0.5,
      ...overrides,
    });

  beforeAll(async () => {
    database = await prepareTestDatabase();
    db = database.db;
  });

  beforeEach(async () => {
    await resetTestDatabase(db);
    time = fakeTime();
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses an interval below the floor', async () => {
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);
    await expect(
      startLoop(controller, harness, { executeStep: async () => ({}), intervalMs: 999 }),
    ).rejects.toThrow(/below 1000/);
    controller.abort();
  });

  it('runs a due scheduled job once and sets the next next_run_at', async () => {
    await ensureGuild(db, GUILD_ID);
    await db.insert(leagues).values({
      guildId: GUILD_ID,
      citadelLeagueId: 1,
      name: 'League 1',
      shortcode: 'l1',
      status: 'active',
    });
    const operation: ScheduledOperation = {
      type: 'maintenance.op',
      intervalMs: 60_000,
      plan: { scope: 'test' },
      steps: [{ seq: 0, kind: 'op.noop' }],
    };
    const executed: StepExecution[] = [];
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      registry: [operation],
      executeStep: async (execution) => {
        executed.push(execution);
        done.tick();
        return {};
      },
    });

    await done.promise; // the first occurrence ran
    await harness.waits(31); // idle iterations carry the clock past the 30 s tick gate
    controller.abort();
    await loop;

    expect(executed).toHaveLength(1);
    const occurrences = await db
      .select()
      .from(jobs)
      .where(eq(jobs.type, 'maintenance.op'))
      .orderBy(jobs.createdAt);
    expect(occurrences).toHaveLength(2);
    const first = occurrences[0];
    const second = occurrences[1];
    if (!first || !second) throw new Error('missing occurrences');
    expect(first.state).toBe('completed');
    expect(second.state).toBe('queued');
    // One interval after the anchor — and not due again immediately.
    expect(second.nextRunAt.getTime()).toBe(first.nextRunAt.getTime() + 60_000);
  });

  it('completes a multi-step job through its own lease, one step per iteration', async () => {
    const job = await enqueueJob(
      db,
      jobInput({
        steps: [
          { seq: 0, kind: 'noop', reversible: true },
          { seq: 1, kind: 'noop', reversible: true },
        ],
      }),
    );
    const executed: number[] = [];
    const done = countdown(2);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ step }) => {
        executed.push(step.seq);
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect(executed).toEqual([0, 1]);
    expect((await oneJob(job.id))?.state).toBe('completed');
    const journal = await getJob(db, job.id);
    expect(journal?.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(journal?.events.at(-1)?.code).toBe('job.completed');
  });

  it('stops after the current step when signalled, claiming nothing further', async () => {
    const stopping = await enqueueJob(db, jobInput());
    const queued = await enqueueJob(db, jobInput());
    const executed: JobRow[] = [];
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ job }) => {
        executed.push(job);
        started.resolve();
        await release.promise;
        return {};
      },
    });

    await started.promise; // a step is executing
    controller.abort();
    release.resolve(); // the step may finish
    await loop;

    expect(executed.map((job) => job.id)).toEqual([stopping.id]);
    expect((await oneJob(stopping.id))?.state).toBe('completed');
    expect((await oneJob(queued.id))?.state).toBe('queued');
  });

  it('two workers never run the same job', async () => {
    const job = await enqueueJob(db, jobInput());
    const executed: JobRow[] = [];
    const done = countdown(1);
    const controllers = [new AbortController(), new AbortController()];
    const harnesses = controllers.map((controller) => sleepHarness(time, controller.signal));
    const executeStep: StepExecutor = async ({ job: claimed }) => {
      executed.push(claimed);
      done.tick();
      return {};
    };

    const loops = [
      startLoop(controllers[0]!, harnesses[0]!, { executeStep }, 'w1'),
      startLoop(controllers[1]!, harnesses[1]!, { executeStep }, 'w2'),
    ];

    await done.promise;
    for (const controller of controllers) controller.abort();
    await Promise.all(loops);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.id).toBe(job.id);
    const final = await oneJob(job.id);
    expect(final?.state).toBe('completed');
    expect(final?.attempt).toBe(1); // claimed once, never reclaimed
    expect(final?.leaseOwner).toBeNull();
  });

  it('claims in lane order, whatever the queues age', async () => {
    const maintenance = await enqueueJob(db, jobInput({ lane: 'maintenance' }));
    const setup = await enqueueJob(db, jobInput({ lane: 'setup' }));
    const interactive = await enqueueJob(db, jobInput({ lane: 'interactive' }));
    const executed: string[] = [];
    const done = countdown(3);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ job }) => {
        executed.push(job.lane);
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    // 02 §4.4 order, not enqueue order (maintenance was queued first).
    expect(executed).toEqual(['interactive', 'setup', 'maintenance']);
    for (const job of [interactive, setup, maintenance]) {
      expect((await oneJob(job.id))?.state).toBe('completed');
    }
  });

  it('reclaims an expired lease and executes the step under the new owner', async () => {
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await db
      .update(jobs)
      .set({ leaseExpiresAt: sql`now() - interval '5 seconds'` })
      .where(eq(jobs.id, job.id));

    const executed: string[] = [];
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ job: claimed, step }) => {
        executed.push(claimed.leaseOwner ?? '', step.kind);
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect(executed).toEqual(['w1', 'noop']);
    const final = await oneJob(job.id);
    expect(final?.state).toBe('completed');
    expect(final?.attempt).toBe(2); // the original claim plus the reclaim
    expect((await getJob(db, job.id))?.events.map((event) => event.code)).toContain(
      'job.lease.reclaimed',
    );
  });

  it('picks up a decided revert and runs its compensations', async () => {
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await db
      .update(jobSteps)
      .set({ status: 'done', compensation: { kind: 'delete_role', roleId: ROLE_ID } })
      .where(eq(jobSteps.jobId, job.id));
    await applyDecision(
      db,
      job.id,
      { type: 'revert' },
      actor('u-op', DECISION_CAPABILITY, DESTRUCTIVE_CAPABILITY),
    );

    const deleteRole = deferred();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async () => ({}),
      revertPort: recordingRevertPort(() => deleteRole.resolve()),
    });

    await deleteRole.promise;
    await harness.waits(1); // the revert finished and the loop idled on
    controller.abort();
    await loop;

    expect((await oneJob(job.id))?.state).toBe('reverted');
    const journal = await getJob(db, job.id);
    expect(journal?.steps[0]?.status).toBe('compensated');
    expect(journal?.events.map((event) => event.code)).toContain('job.reverted');
  });

  it('pauses a rate-limited step and keeps the loop working', async () => {
    const thrower = await enqueueJob(db, jobInput({ steps: [{ seq: 0, kind: 'boom' }] }));
    const healthy = await enqueueJob(db, jobInput());
    const executed: string[] = [];
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ step }) => {
        if (step.kind === 'boom') {
          throw new DiscordOperationError({
            status: 429,
            retryAfterSeconds: 3_600,
            message: 'rate limited',
          });
        }
        executed.push(step.kind);
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect(executed).toEqual(['noop']); // the loop kept going
    expect((await oneJob(healthy.id))?.state).toBe('completed');
    const paused = await oneJob(thrower.id);
    expect(paused?.state).toBe('paused');
    expect(paused?.pauseReason).toBe('ratelimit');
    expect(paused?.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    const journal = await getJob(db, thrower.id);
    expect(journal?.steps[0]?.status).toBe('failed');
    expect(journal?.steps[0]?.attempts).toBe(0); // 429 is not an attempt
    expect(journal?.events.map((event) => event.code)).toEqual([
      'job.queued',
      'job.started',
      'job.step.failure',
      'job.paused',
    ]);
  });

  it('parks an unexpectedly throwing step for an operator and keeps the loop working', async () => {
    const thrower = await enqueueJob(db, jobInput({ steps: [{ seq: 0, kind: 'boom' }] }));
    const healthy = await enqueueJob(db, jobInput());
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ step }) => {
        if (step.kind === 'boom') throw new Error('executor bug');
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    const parked = await oneJob(thrower.id);
    expect(parked?.state).toBe('awaiting_decision');
    expect(parked?.error?.['class']).toBe('invalid_input'); // the taxonomy default
    const journal = await getJob(db, thrower.id);
    expect(journal?.events.at(-1)?.code).toBe('job.awaiting_decision');
    expect(journal?.events.at(-1)?.message).toContain('executor bug');
    expect((await oneJob(healthy.id))?.state).toBe('completed');
  });

  it('schedules a transient retry and aligns the lease to the backoff', async () => {
    const startedAt = time.clock();
    const transient = await enqueueJob(db, jobInput({ steps: [{ seq: 0, kind: 'boom' }] }));
    const healthy = await enqueueJob(db, jobInput());
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async ({ step }) => {
        if (step.kind === 'boom') throw new DiscordOperationError({ status: 503 });
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect((await oneJob(healthy.id))?.state).toBe('completed'); // the loop kept going
    const scheduled = await oneJob(transient.id);
    expect(scheduled?.state).toBe('running');
    // Backoff 2 s with the injected mid jitter (random() = 0.5 → factor 1).
    expect(scheduled?.nextRunAt.getTime()).toBe(startedAt + 2_000);
    // The lease expires exactly at the backoff, so the reclaim scan
    // resumes the step on time instead of 60 s late.
    expect(scheduled?.leaseExpiresAt?.getTime()).toBe(scheduled?.nextRunAt.getTime());
    const journal = await getJob(db, transient.id);
    expect(journal?.steps[0]?.attempts).toBe(1);
    expect(journal?.events.map((event) => event.code)).toEqual([
      'job.queued',
      'job.started',
      'job.step.failure',
      'job.step.retry_scheduled',
    ]);
  });

  it('probes a due external pause and resumes the job through the machine', async () => {
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await pauseExternal(db, job.id, 'citadel unavailable', time.clock);
    // The pause schedule is data; make it due on the database clock.
    await updateJobState(db, job.id, { nextRunAt: new Date(Date.now() - 60_000) });

    const probe = probeHarness(() => true);
    const executed: JobRow[] = [];
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      probeExternal: probe.probeExternal,
      executeStep: async ({ job: claimed }) => {
        executed.push(claimed);
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.id).toBe(job.id);
    expect(executed[0]?.leaseOwner).toBe('w1'); // resumed under the prober
    expect((await oneJob(job.id))?.state).toBe('completed');
    const journal = await getJob(db, job.id);
    expect(journal?.events.map((event) => event.code)).toEqual([
      'job.queued',
      'job.started',
      'job.paused',
      'job.resumed',
      'job.step.done',
      'job.completed',
    ]);
  });

  it('postpones a failing external probe by 30 seconds, silently', async () => {
    const probedAt = time.clock();
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await pauseExternal(db, job.id, 'citadel unavailable', time.clock);
    await updateJobState(db, job.id, { nextRunAt: new Date(Date.now() - 60_000) });

    const probe = probeHarness(() => false);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);
    const eventsBefore = (await getJob(db, job.id))?.events.length ?? 0;

    const loop = startLoop(controller, harness, {
      probeExternal: probe.probeExternal,
      executeStep: async () => ({}),
    });

    await probe.called.promise;
    await harness.waits(1); // the probe transaction has committed
    controller.abort();
    await loop;

    const paused = await oneJob(job.id);
    expect(paused?.state).toBe('paused');
    expect(paused?.pauseReason).toBe('external');
    expect(paused?.nextRunAt.getTime()).toBe(probedAt + 30_000);
    // A probe every 30 seconds must not flood the journal (02 §5.7).
    expect((await getJob(db, job.id))?.events.length).toBe(eventsBefore);
  });

  it('escalates an external pause that has failed probes for over 24 hours', async () => {
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await pauseExternal(db, job.id, 'citadel unavailable', time.clock);
    await updateJobState(db, job.id, { nextRunAt: new Date(Date.now() - 60_000) });
    // The injected clock moves past the 24-hour escalation window while
    // the pause moment stays in the journal at real time.
    time.advance(24 * 60 * 60_000 + 2_000);

    const probe = probeHarness(() => false);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      probeExternal: probe.probeExternal,
      executeStep: async () => ({}),
    });

    await probe.called.promise;
    await harness.waits(1); // the escalation transaction has committed
    controller.abort();
    await loop;

    const escalated = await oneJob(job.id);
    expect(escalated?.state).toBe('awaiting_decision');
    expect(escalated?.leaseOwner).toBeNull();
    const journal = await getJob(db, job.id);
    expect(journal?.events.at(-1)?.code).toBe('job.awaiting_decision');
    expect(journal?.events.at(-1)?.message).toContain('24 hours');
  });

  it('keeps claiming when the scheduler tick itself fails', async () => {
    const healthy = await enqueueJob(db, jobInput());
    const done = countdown(1);
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);
    const logger = recordingLogger();

    const loop = startLoop(controller, harness, {
      registry: [{ type: 'maintenance.bad', intervalMs: 500, plan: {}, steps: [] }],
      logger,
      executeStep: async () => {
        done.tick();
        return {};
      },
    });

    await done.promise;
    controller.abort();
    await loop;

    expect(logger.errors).toContain('scheduler tick failed');
    expect((await oneJob(healthy.id))?.state).toBe('completed');
  });

  it('heartbeats the lease every 15 seconds while a step executes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const job = await enqueueJob(db, jobInput());
    const started = deferred();
    const release = deferred();
    // The heartbeat's database write is real I/O that the faked interval
    // does not await, so the test awaits the loop's own success log.
    const beat = deferred();
    const logger: WorkerLoopLogger = {
      debug: (message) => {
        if (message === 'lease heartbeat') beat.resolve();
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      logger,
      executeStep: async () => {
        started.resolve();
        await release.promise;
        return {};
      },
    });

    await started.promise;
    const leaseBefore = (await oneJob(job.id))?.leaseExpiresAt?.getTime() ?? 0;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_SECONDS * 1_000);
    await beat.promise; // the heartbeat's write has committed

    const leaseAfter = (await oneJob(job.id))?.leaseExpiresAt?.getTime() ?? 0;
    // The 60-second claim lease moved to a 15-second heartbeat re-arm.
    expect(leaseAfter).toBeGreaterThan(Date.now());
    expect(leaseAfter).toBeLessThan(leaseBefore);

    controller.abort();
    release.resolve();
    await loop;
    expect((await oneJob(job.id))?.state).toBe('completed');
  });

  it('completes a running job whose steps are all finished when it picks it up', async () => {
    // The crash window between the last step's commit and the completion
    // move: the job is running with every step done, and this worker owns
    // the lease.
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'w1');
    await db.update(jobSteps).set({ status: 'done' }).where(eq(jobSteps.jobId, job.id));

    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);
    const loop = startLoop(controller, harness, {
      executeStep: async () => {
        throw new Error('no step should execute');
      },
    });

    await harness.waits(1); // the completion move ran and the loop idled
    controller.abort();
    await loop;

    expect((await oneJob(job.id))?.state).toBe('completed');
    expect((await getJob(db, job.id))?.events.at(-1)?.code).toBe('job.completed');
  });

  it('survives a failure whose persistence the machine refuses', async () => {
    const job = await enqueueJob(db, jobInput({ steps: [{ seq: 0, kind: 'boom' }] }));
    const started = deferred();
    const release = deferred();
    const logger = recordingLogger();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      logger,
      executeStep: async () => {
        started.resolve();
        await release.promise;
        throw new Error('executor bug');
      },
    });

    await started.promise;
    // The operator cancels the job while the failing step is in flight;
    // applying the failure from 'cancelled' is an illegal move.
    await applyDecision(db, job.id, { type: 'abort' }, actor('u-op', DECISION_CAPABILITY));
    controller.abort();
    release.resolve();
    await loop;

    expect((await oneJob(job.id))?.state).toBe('cancelled'); // the operator's move stands
    expect(logger.errors).toContain('failed to persist a step failure');
  });

  it('leaves a revert to retry when a compensation fails without a signal', async () => {
    const job = await enqueueJob(db, jobInput());
    await claimNext(db, ['setup'], 'other-worker');
    await db
      .update(jobSteps)
      .set({ status: 'done', compensation: { kind: 'delete_role', roleId: ROLE_ID } })
      .where(eq(jobSteps.jobId, job.id));
    await applyDecision(
      db,
      job.id,
      { type: 'revert' },
      actor('u-op', DECISION_CAPABILITY, DESTRUCTIVE_CAPABILITY),
    );

    const logger = recordingLogger();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      logger,
      executeStep: async () => ({}),
      revertPort: {
        async channelHasHumanMessages() {
          return true;
        },
        async categoryIsEmpty() {
          return true;
        },
        async deleteRole() {
          throw new Error('database blip mid-compensation');
        },
        async deleteChannel() {},
        async archiveChannel() {},
        async deleteCategory() {},
        async restoreOverwrites() {},
        async deleteDbRows() {},
      },
    });

    await harness.waits(1); // the revert attempt failed and the loop idled
    controller.abort();
    await loop;

    expect(logger.errors).toContain('revert run failed');
    // The compensation rolled back; the expired claim lets another worker
    // retry it (02 §5.5), so the job stays mid-revert.
    expect((await oneJob(job.id))?.state).toBe('reverting');
    expect((await getJob(db, job.id))?.steps[0]?.status).toBe('done');
  });

  it('survives an iteration-level failure and keeps working', async () => {
    const first = await enqueueJob(db, jobInput());
    const firstDone = countdown(1);
    const logger = recordingLogger();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);
    // The idle wait itself fails once; the iteration boundary must catch
    // it and the next iteration must still claim new work (02 §3.2.2).
    const blipped = deferred();
    let thrown = false;
    let secondId = '';
    const secondDone = deferred();
    const blipSleep = async (_ms: number): Promise<void> => {
      if (!thrown) {
        thrown = true;
        blipped.resolve();
        throw new Error('idle wait blip');
      }
      time.advance(1_000);
      await Promise.resolve();
    };

    const loop = startLoop(controller, harness, {
      logger,
      sleep: blipSleep,
      executeStep: async ({ job }) => {
        if (job.id === first.id) firstDone.tick();
        if (secondId !== '' && job.id === secondId) secondDone.resolve();
        return {};
      },
    });

    await firstDone.promise; // the first job ran
    await blipped.promise; // the idle wait threw

    const second = await enqueueJob(db, jobInput());
    secondId = second.id;
    await secondDone.promise; // the loop kept working after the failure
    controller.abort();
    await loop;

    expect(logger.errors).toContain('worker loop iteration failed');
    expect((await oneJob(first.id))?.state).toBe('completed');
    expect((await oneJob(second.id))?.state).toBe('completed');
  });

  it('keeps a cancelled job cancelled while still recording the finished step', async () => {
    const job = await enqueueJob(db, jobInput());
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const harness = sleepHarness(time, controller.signal);

    const loop = startLoop(controller, harness, {
      executeStep: async () => {
        started.resolve();
        await release.promise;
        return { externalIds: [{ discordId: ROLE_ID, kind: 'role', name: 'Div 1' }] };
      },
    });

    await started.promise; // the step is executing
    // An operator aborts the job mid-step.
    await applyDecision(db, job.id, { type: 'abort' }, actor('u-op', DECISION_CAPABILITY));
    controller.abort();
    release.resolve();
    await loop;

    expect((await oneJob(job.id))?.state).toBe('cancelled'); // the operator's move stands
    const journal = await getJob(db, job.id);
    expect(journal?.steps[0]?.status).toBe('done'); // the step's writes survive
    expect(journal?.events.map((event) => event.code)).toContain('job.step.done');
    expect(journal?.events.map((event) => event.code)).not.toContain('job.completed');
    // The ledger row was written in the same transaction as the step (§5.4).
    const ledger = await getDiscordObject(db, GUILD_ID, ROLE_ID);
    expect(ledger?.state).toBe('live');
    expect(ledger?.createdByJobId).toBe(job.id);
  });
});
