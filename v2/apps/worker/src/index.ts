import type { Config } from '@drawbridge/config';
import { checkPostgres, closeDatabase, createDatabase, type Database } from '@drawbridge/db';
import {
  type ReconcilePort,
  type RevertPort,
  runWorkerLoop,
  type ScheduledOperationRegistry,
  type StepExecutor,
} from '@drawbridge/jobs';
import type { Logger } from '@drawbridge/logging';

/**
 * Worker process (plan 02 §3.1): the job runner — the only role that
 * writes to Discord over REST — plus the attachment pipeline, retention and
 * the schedulers. This todo starts the worker loop itself with the real
 * database and configuration; the step executor and the Discord adapter
 * arrive with the executor wiring (todo 25), and the maintenance operations
 * register here as they become executable.
 */

/**
 * The maintenance operation registry (02 §5.11), driven by the scheduler
 * inside the worker loop.
 *
 * EMPTY by design at this commit: an operation is only schedulable once its
 * step kinds can actually execute, and the real step executor lands with
 * todo 25. Registering a later operation (todos 32/33/52) means adding one
 * entry to this array:
 *
 *   export const MAINTENANCE_OPERATIONS: ScheduledOperationRegistry = [
 *     {
 *       type: 'retention.run',
 *       intervalMs: 24 * 60 * 60_000,       // daily (§9.8)
 *       plan: { scope: 'retention' },
 *       steps: [{ seq: 0, kind: 'retention.purge' }],
 *     },
 *   ];
 *
 * No other wiring changes: the loop ticks the scheduler on its own cadence,
 * enqueues one occurrence per active league with the deterministic
 * `sched:{type}:{leagueId}` plan hash, and the claim scan runs each
 * occurrence when its `next_run_at` arrives. The op's step kinds must be
 * implemented by the step executor wired in todo 25.
 */
export const MAINTENANCE_OPERATIONS: ScheduledOperationRegistry = [];

/** The idle poll cadence; the loop floor is one second (02 §5.5 scans). */
const LOOP_INTERVAL_MS = 1_000;

/**
 * The step executor placeholder until the Discord adapter lands (todo 25).
 * A claimed step fails into the taxonomy's default permanent class with a
 * clear cause in the journal, so a job that somehow reaches this worker
 * parks for an operator instead of being silently no-op'd as done.
 */
const notImplementedExecutor: StepExecutor = async ({ step }) => {
  throw new Error(
    `no step executor is wired yet: step kind '${step.kind}' needs the Discord ` +
      'adapter (todo 25)',
  );
};

/** Reconciliation reads Discord; the adapter arrives with todo 25. */
const notImplementedReconcile: ReconcilePort = {
  async fetchObject() {
    throw new Error('reconciliation is not wired until the Discord adapter (todo 25)');
  },
  async searchAuditByReason() {
    throw new Error('reconciliation is not wired until the Discord adapter (todo 25)');
  },
};

/** Revert compensations write Discord; the adapter arrives with todo 25. */
const notImplementedRevert: RevertPort = {
  async channelHasHumanMessages() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async categoryIsEmpty() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async deleteRole() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async deleteChannel() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async archiveChannel() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async deleteCategory() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async restoreOverwrites() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
  async deleteDbRows() {
    throw new Error('reverts are not wired until the Discord adapter (todo 25)');
  },
};

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Starts the worker loop with the real database and configuration. The
 * loop runs until the returned handle's `stop()` aborts it — the process
 * entry's SIGTERM/SIGINT handlers call `stop()`, and the loop finishes the
 * step it is executing, persists it, and only then exits.
 */
export async function start(config: Config, logger: Logger): Promise<WorkerHandle> {
  const log = logger.child({ scope: 'worker' });
  const database: Database = createDatabase(config.databaseUrl.reveal());
  const controller = new AbortController();

  const loop = runWorkerLoop({
    db: database.db,
    owner: `worker-${process.pid}`,
    clock: () => Date.now(),
    signal: controller.signal,
    intervalMs: LOOP_INTERVAL_MS,
    executeStep: notImplementedExecutor,
    reconcilePort: notImplementedReconcile,
    revertPort: notImplementedRevert,
    // The cheap external-pause read (02 §5.7): the database is one of the
    // two external dependencies, and its probe is real today. The Citadel
    // half of the probe wires up with the Citadel adapter (todo 25).
    probeExternal: () => checkPostgres(database.db),
    registry: MAINTENANCE_OPERATIONS,
    logger: log,
  }).catch((err: unknown) => {
    log.fatal('worker loop crashed', { error: err });
  });

  log.info('worker loop started', { intervalMs: LOOP_INTERVAL_MS });

  return {
    async stop() {
      controller.abort();
      await loop;
      await closeDatabase(database);
      log.info('worker stopped');
    },
  };
}
