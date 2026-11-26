/**
 * Integration test for the worker role's real wiring (plan 02 §3.1): the
 * process entry starts the loop with the parsed config and a real database
 * connection, an operation the (not yet wired) step executor cannot run
 * parks through the taxonomy instead of being silently no-op'd, and a
 * SIGTERM-style stop() drains the loop after the current step.
 */
import { type Config, parseConfig } from '@drawbridge/config';
import { type Database, getJob } from '@drawbridge/db';
import { enqueueJob } from '@drawbridge/jobs';
import type { Logger } from '@drawbridge/logging';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../src/index.js';

const available = await testDatabaseAvailable();

const GUILD_ID = '999999999999999999';

/** The test database URL, mirroring the testkit's own resolution. */
function testUrl(): string {
  return (
    process.env['TEST_DATABASE_URL'] ??
    'postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_test'
  );
}

/** A logger whose children still report every warn message. */
function spyLogger(onWarn: (message: string) => void): Logger {
  const make = (): Logger => ({
    level: 'info',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message) => {
      onWarn(message);
    },
    error: () => {},
    fatal: () => {},
    child: () => make(),
  });
  return make();
}

describe.skipIf(!available)('worker role (integration)', () => {
  let database: Database;
  let stepFailed: Promise<void>;

  beforeAll(async () => {
    database = await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  it('runs the loop with real config and database, and stops gracefully', async () => {
    // A job nothing can execute yet: the placeholder executor must park it
    // for an operator with the cause in the journal, never fake success.
    const job = await enqueueJob(database.db, {
      type: 'manual.op',
      guildId: GUILD_ID,
      lane: 'setup',
      plan: {},
      planHash: 'worker-smoke-1',
      steps: [{ seq: 0, kind: 'manual.kind' }],
    });

    let signalFailure!: () => void;
    stepFailed = new Promise<void>((resolve) => {
      signalFailure = resolve;
    });
    const logger = spyLogger((message) => {
      if (message === 'step failed') signalFailure();
    });

    const config: Config = parseConfig({
      NODE_ENV: 'test',
      RUN_MODE: 'worker',
      DATABASE_URL: testUrl(),
    });
    const handle = await start(config, logger);

    await stepFailed; // the loop claimed the job and the executor refused
    await handle.stop(); // SIGTERM-shaped graceful shutdown

    const journal = await getJob(database.db, job.id);
    expect(journal?.job.state).toBe('awaiting_decision');
    expect(journal?.job.error?.['class']).toBe('invalid_input');
    expect(journal?.events.at(-1)?.message).toContain('no step executor is wired yet');
  });
});
