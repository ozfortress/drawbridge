/**
 * Task 24 manual-QA verification harness (independent re-run by omo-native-qa-executor).
 * Derived from task-24-jobs-ui-exec/qa24-server.mjs; the real buildApp and the
 * real built panel are used, only OAuth and Citadel are fakes. The scratch
 * database is on port 5433. `/__qa/*` routes are loopback-only harness
 * controls, not product routes.
 *
 * Extra controls versus the original harness:
 *  - /__qa/failed-job accepts ?message= (failure message payload, for the
 *    HTML-injection adversarial probe)
 *  - /__qa/empty-job creates a job with zero steps (detail empty state)
 *  - /__qa/slow?ms=N delays matching API GETs (loading state capture)
 *  - /__qa/api-fail?match=x / ?off=1 fails matching API GETs (error state)
 *
 * Usage from the worktree root after `pnpm build`:
 *   TEST_DATABASE_URL=postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_task24_mq \
 *     node .omo/evidence/drawbridge-v2-redesign-implementation/task-24-jobs-ui-manual-qa-exec/qa24-manual-server.mjs
 */
import { buildApp } from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/apps/web/dist/app.js';
import { createCitadelClient } from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/citadel/dist/index.js';
import { parseConfig } from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/config/dist/index.js';
import {
  appendJobEvent,
  createJob,
  ensureGuild,
  ensureRootAdmins,
  getJob,
} from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/db/dist/index.js';
import { applyStepFailure } from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/jobs/dist/index.js';
import { createLogger } from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/logging/dist/index.js';
import {
  closeTestDatabase,
  createFakeCitadel,
  prepareTestDatabase,
  resetTestDatabase,
  tournamentFixtures,
} from 'file:///E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20/v2/packages/testkit/dist/index.js';

const ROOT_ID = '136264506933248001';
const GUILD_ID = '1573554616371777546';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const APP_PORT = 8080;

process.env.TEST_DATABASE_URL ??=
  'postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_task24_mq';

const config = parseConfig({
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
  DISCORD_APPLICATION_ID: '1573555530901880855',
  DRAWBRIDGE_MASTER_KEY: MASTER_KEY,
  DRAWBRIDGE_MASTER_KEY_ID: 'k1',
});

const database = await prepareTestDatabase();
await resetTestDatabase(database.db);
await ensureRootAdmins(database.db, [ROOT_ID]);
await ensureGuild(database.db, GUILD_ID, 'QA Test Server');
const citadel = await createFakeCitadel({ fixtures: tournamentFixtures() });

const oauth = {
  authorizeUrl: (state) =>
    `/api/v1/auth/discord/callback?code=qa&state=${encodeURIComponent(state)}`,
  exchangeCode: async () => 'qa-access-token',
  fetchUser: async () => ({ id: ROOT_ID, username: 'Root', globalName: 'QA Root', avatar: null }),
};

const logger = createLogger({ level: 'debug' });
const ctx = await buildApp({
  config,
  logger,
  db: database.db,
  pool: database.pool,
  oauth,
  servePanel: false,
  citadel: (input) =>
    createCitadelClient({ baseUrl: citadel.baseUrl, apiKey: input.apiKey, maxRetries: 0 }),
});

// Loopback-only state controls for capturing loading/error states.
const qa = { slowMs: 0, failMatch: null };
ctx.app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/v1/') || request.url.startsWith('/api/v1/stream')) return;
  if (request.method !== 'GET') return;
  if (qa.failMatch && request.url.includes(qa.failMatch)) {
    return reply.status(500).send({ error: 'qa injected api failure' });
  }
  if (qa.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, qa.slowMs));
});

ctx.app.post('/__qa/job-state', async (request, reply) => {
  const body = request.body ?? {};
  const jobId = String(body.jobId ?? '');
  const state = String(body.state ?? '');
  if (!['running', 'completed'].includes(state)) {
    return reply.status(400).send({ error: 'state must be running or completed' });
  }
  const journal = await getJob(database.db, jobId);
  if (!journal) return reply.status(404).send({ error: 'job not found' });
  const from = journal.job.state;
  if (state === 'running') {
    await appendJobEvent(database.db, jobId, {
      level: 'info',
      code: 'job.started',
      message: 'Job started by the QA transition driver',
      data: { from, to: 'running' },
    });
    await database.pool.query(
      "update jobs set state = 'running', finished_at = null, updated_at = now() where id = $1",
      [jobId],
    );
  } else {
    await appendJobEvent(database.db, jobId, {
      level: 'info',
      code: 'job.completed',
      message: 'Job completed by the QA transition driver',
      data: { from, to: 'completed' },
    });
    await database.pool.query(
      "update job_steps set status = 'done', started_at = coalesce(started_at, now()), finished_at = coalesce(finished_at, now()) where job_id = $1 and status <> 'skipped'",
      [jobId],
    );
    await database.pool.query(
      "update jobs set state = 'completed', finished_at = now(), updated_at = now() where id = $1",
      [jobId],
    );
  }
  return reply.send({ jobId, from, state });
});

ctx.app.get('/__qa/failed-job', async (request, reply) => {
  const leagueId = String(request.query.leagueId ?? '');
  const message = String(request.query.message ?? 'QA bot token refused');
  const root = await database.pool.query('select id from users where discord_id = $1', [ROOT_ID]);
  const job = await createJob(database.db, {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId,
    lane: 'setup',
    plan: {},
    planHash: `qa-failure-${Date.now()}`,
    requestedByUserId: root.rows[0]?.id ?? null,
    requestedByDiscordId: ROOT_ID,
    steps: [
      {
        seq: 1,
        kind: 'create_role',
        reversible: true,
        skippable: true,
        compensation: { kind: 'delete_role', roleId: '9001' },
      },
    ],
  });
  await database.pool.query("update jobs set state = 'running' where id = $1", [job.id]);
  await database.pool.query("update job_steps set status = 'running' where job_id = $1", [job.id]);
  const result = await applyStepFailure(
    database.db,
    job.id,
    {
      stepSeq: 1,
      signal: { status: 401, message },
    },
    () => new Date(),
    () => 0.5,
  );
  return reply.send({ jobId: job.id, state: result.job.state, action: result.action });
});

ctx.app.get('/__qa/empty-job', async (request, reply) => {
  const leagueId = String(request.query.leagueId ?? '');
  const root = await database.pool.query('select id from users where discord_id = $1', [ROOT_ID]);
  const job = await createJob(database.db, {
    type: 'maintenance.probe',
    guildId: GUILD_ID,
    leagueId,
    lane: 'maintenance',
    plan: {},
    planHash: `qa-empty-${Date.now()}`,
    requestedByUserId: root.rows[0]?.id ?? null,
    requestedByDiscordId: ROOT_ID,
    steps: [],
  });
  return reply.send({ jobId: job.id, state: job.state });
});

ctx.app.post('/__qa/slow', async (request, reply) => {
  qa.slowMs = Number(request.body?.ms ?? 0);
  return reply.send({ slowMs: qa.slowMs });
});

ctx.app.post('/__qa/api-fail', async (request, reply) => {
  qa.failMatch = request.body?.off ? null : String(request.body?.match ?? 'jobs');
  return reply.send({ failMatch: qa.failMatch });
});

ctx.app.post('/__qa/revoke-root-sessions', async (_request, reply) => {
  const result = await database.pool.query(
    'delete from sessions where user_id = (select id from users where discord_id = $1)',
    [ROOT_ID],
  );
  return reply.send({ revoked: result.rowCount ?? 0 });
});

ctx.app.get('/__qa/listeners', async (_request, reply) => {
  const result = await database.pool.query(
    "select count(*) filter (where query ~ '^listen ')::int as listeners from pg_stat_activity where datname = current_database()",
  );
  return reply.send(result.rows[0] ?? { listeners: 0 });
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await ctx.app.close().catch(() => undefined);
  await citadel.close().catch(() => undefined);
  await closeTestDatabase(database).catch(() => undefined);
}
process.on('SIGTERM', () => void close().then(() => process.exit(0)));
process.on('SIGINT', () => void close().then(() => process.exit(0)));

await ctx.app.listen({ port: APP_PORT, host: '127.0.0.1' });
process.stdout.write(`QA_READY api=${APP_PORT} panel=5173 citadel=${citadel.baseUrl}\n`);
