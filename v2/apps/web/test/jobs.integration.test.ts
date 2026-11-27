/**
 * The job API against a real Postgres, a fake Citadel and the live SSE
 * stream: approval (idempotent, drift-checked, duplicate-guarded), the
 * league-scoped list and detail, operator decisions with their capability
 * gates, cancel, rate limits, and `job.state` delivery within a second of
 * a transition.
 */

import { randomUUID } from 'node:crypto';
import { createCitadelClient } from '@drawbridge/citadel';
import { parseConfig } from '@drawbridge/config';
import {
  alerts,
  consumePreview,
  createJob,
  type Database,
  ensureGuild,
  ensureRootAdmins,
} from '@drawbridge/db';
import { createLogger } from '@drawbridge/logging';
import {
  CITADEL_LEAGUE_ID,
  closeTestDatabase,
  createFakeCitadel,
  type FakeCitadel,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
  tournamentFixtures,
} from '@drawbridge/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, buildApp } from '../src/app.js';
import type { DiscordOAuth, DiscordUser } from '../src/auth/oauth.js';

const ROOT_ID = '136264506933248001';
const OUTSIDER_ID = '136264506933248003';
const HELPER_ID = '136264506933248004';
const MEMBER_ID = '136264506933248005';
const GUILD_ID = '1573554616371777546';
const API_KEY = 'citadel-api-key-for-tests';

/** A master key that is stable for the whole file: the key ring never changes. */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const available = await testDatabaseAvailable();

const config = parseConfig({
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:8080',
  DISCORD_APPLICATION_ID: '1573555530901880855',
  DRAWBRIDGE_MASTER_KEY: MASTER_KEY,
  DRAWBRIDGE_MASTER_KEY_ID: 'k1',
});

function user(id: string, name: string): DiscordUser {
  return { id, username: name, globalName: name, avatar: null };
}

/** One parsed SSE block. */
interface SseEvent {
  event: string;
  data: string;
}

/**
 * A reading handle on one open SSE response. `next` resolves with the next
 * event or rejects after the given deadline - no sleeps, no polling: the
 * pump fills a queue as chunks arrive and waiters take from it directly.
 */
interface SseStream {
  next(deadlineMs: number): Promise<SseEvent>;
  close(): Promise<void>;
}

async function openStream(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; stream?: SseStream }> {
  const response = await fetch(url, { headers });
  if (response.status !== 200 || response.body === null) {
    const body = await response.text().catch(() => '');
    return { status: response.status, body };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue: SseEvent[] = [];
  const pending: Array<(event: SseEvent) => void> = [];
  let buffer = '';
  let ended = false;

  const deliver = (event: SseEvent): void => {
    const waiter = pending.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };

  const parseBlock = (block: string): SseEvent | undefined => {
    let event: string | undefined;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
    }
    return event === undefined ? undefined : { event, data };
  };

  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index === -1) break;
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const parsed = parseBlock(block);
          if (parsed) deliver(parsed);
        }
      }
    } finally {
      ended = true;
      for (const waiter of pending.splice(0)) {
        waiter({ event: '__ended__', data: '' });
      }
    }
  })();
  // The pump must never surface as an unhandled rejection; a cancelled
  // reader rejects its own read and that is the expected end.
  pump.catch(() => undefined);

  return {
    status: 200,
    body: '',
    stream: {
      next: (deadlineMs: number): Promise<SseEvent> => {
        const queued = queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise<SseEvent>((resolve, reject) => {
          if (ended) {
            reject(new Error('the stream ended before the event arrived'));
            return;
          }
          const timer = setTimeout(() => {
            const index = pending.indexOf(waiter);
            if (index >= 0) pending.splice(index, 1);
            reject(new Error(`no event within ${deadlineMs}ms`));
          }, deadlineMs);
          const waiter = (event: SseEvent): void => {
            clearTimeout(timer);
            resolve(event);
          };
          pending.push(waiter);
        });
      },
      close: () => reader.cancel().then(() => undefined),
    },
  };
}

/** Creates a job row directly, outside the API, for state-specific tests. */
async function seededJob(
  database: Database,
  leagueId: string,
  options: {
    state?: string;
    step?: {
      kind: string;
      compensation: Record<string, unknown> | null;
      status?: string;
      skippable: boolean;
    };
  } = {},
): Promise<string> {
  const job = await createJob(database.db, {
    type: 'tournament.setup',
    guildId: GUILD_ID,
    leagueId,
    lane: 'setup',
    plan: {},
    planHash: `seed-${randomUUID()}`,
    steps: options.step
      ? [
          {
            seq: 1,
            kind: options.step.kind,
            reversible: true,
            skippable: options.step.skippable,
            compensation: options.step.compensation,
          },
        ]
      : [],
  });
  if (options.state !== undefined && options.state !== 'queued') {
    await database.pool.query('update jobs set state = $2 where id = $1', [job.id, options.state]);
  }
  if (options.step?.status !== undefined) {
    await database.pool.query('update job_steps set status = $2 where job_id = $1', [
      job.id,
      options.step.status,
    ]);
  }
  return job.id;
}

async function countJobs(database: Database, leagueId?: string): Promise<number> {
  const result = await database.pool.query(
    leagueId === undefined
      ? 'select count(*)::int as count from jobs'
      : 'select count(*)::int as count from jobs where league_id = $1',
    leagueId === undefined ? [] : [leagueId],
  );
  return result.rows[0]?.count ?? 0;
}

describe.skipIf(!available)('job api (integration)', () => {
  let database: Database;
  let ctx: AppContext;
  let citadel: FakeCitadel;
  let citadelBaseUrl = '';
  let port = 0;
  let currentUser: DiscordUser = user(ROOT_ID, 'Root');

  const oauth: DiscordOAuth = {
    authorizeUrl: (state) =>
      `https://discord.invalid/oauth2/authorize?client_id=1&state=${encodeURIComponent(state)}`,
    exchangeCode: async () => 'access-token',
    fetchUser: async () => currentUser,
  };

  beforeAll(async () => {
    database = await prepareTestDatabase();
    const lines: string[] = [];
    const logger = createLogger({ level: 'error', sink: (line) => lines.push(line) });
    ctx = await buildApp({
      config,
      logger,
      db: database.db,
      pool: database.pool,
      oauth,
      servePanel: false,
      // The fake Citadel answers every read; no retries, so a failing test
      // does not wait for a backoff.
      citadel: (input) =>
        createCitadelClient({
          baseUrl: citadelBaseUrl,
          apiKey: input.apiKey,
          maxRetries: 0,
        }),
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    if (citadel) await citadel.close();
    if (database) await closeTestDatabase(database);
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
    await ensureRootAdmins(database.db, [ROOT_ID]);
    await ensureGuild(database.db, GUILD_ID, 'Test Server');
    await serve(tournamentFixtures());
  });

  /** Serves a fresh set of bodies; the client is built per request, so the port may change. */
  async function serve(bodies: Record<string, string>): Promise<void> {
    if (citadel) await citadel.close();
    citadel = await createFakeCitadel({ fixtures: bodies });
    citadelBaseUrl = citadel.baseUrl;
  }

  interface Login {
    cookie: string;
    csrf: string;
  }

  function cookieOf(cookies: Array<{ name: string; value: string }>, name: string): string {
    const found = cookies.find((cookie) => cookie.name === name);
    if (!found) throw new Error(`cookie ${name} was not set`);
    return found.value;
  }

  async function login(as: DiscordUser): Promise<Login> {
    currentUser = as;
    const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/discord' });
    expect(start.statusCode).toBe(302);
    const state = cookieOf(start.cookies, 'drawbridge_oauth_state');

    const callback = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: `drawbridge_oauth_state=${state}` },
    });
    expect(callback.statusCode).toBe(302);

    const session = cookieOf(callback.cookies, 'drawbridge_session');
    const csrf = cookieOf(callback.cookies, 'drawbridge_csrf');
    return { cookie: `drawbridge_session=${session}; drawbridge_csrf=${csrf}`, csrf };
  }

  function authHeaders(loginResult: Login): Record<string, string> {
    return { cookie: loginResult.cookie, 'x-csrf-token': loginResult.csrf };
  }

  /** A league owned by the root admin, with its Citadel key stored. */
  async function leagueWithKey(as: Login, citadelLeagueId = CITADEL_LEAGUE_ID): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/leagues',
      headers: authHeaders(as),
      payload: {
        guildId: GUILD_ID,
        citadelLeagueId,
        name: 'Test League',
        shortcode: 'TL',
      },
    });
    expect(created.statusCode).toBe(201);
    const leagueId = created.json().league.id as string;

    if (citadelLeagueId === CITADEL_LEAGUE_ID) {
      const key = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/leagues/${leagueId}/citadel-key`,
        headers: authHeaders(as),
        payload: { key: API_KEY, label: 'primary' },
      });
      expect(key.statusCode).toBe(200);
    }
    return leagueId;
  }

  /** Builds a preview through the API and returns its id and plan shape. */
  async function previewFor(
    as: Login,
    leagueId: string,
  ): Promise<{ previewId: string; body: Record<string, unknown> }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(as),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as Record<string, unknown>;
    return { previewId: body['previewId'] as string, body };
  }

  async function approve(as: Login, previewId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: authHeaders(as),
      payload: { previewId },
    });
  }

  /** Invites a Discord id with a tier and optional league grants, then signs them in. */
  async function invited(
    discordId: string,
    globalRole: 'user' | 'helper',
    leagueGrants: Array<{ leagueId: string; leagueRoleId: string }> = [],
  ): Promise<Login> {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const invite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asRoot),
      payload: { discordId, globalRole, leagueGrants },
    });
    expect(invite.statusCode).toBe(201);
    return login(user(discordId, `User ${discordId}`));
  }

  /** The league-role id of a seeded default role. */
  async function roleId(leagueId: string, name: string): Promise<string> {
    const roles = await database.pool.query(
      'select id from league_roles where league_id = $1 and name = $2',
      [leagueId, name],
    );
    const id = roles.rows[0]?.id;
    if (typeof id !== 'string') throw new Error(`role ${name} not found`);
    return id;
  }

  async function auditActions(): Promise<string[]> {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=500',
      headers: { cookie: asRoot.cookie },
    });
    expect(response.statusCode).toBe(200);
    return (response.json().entries as Array<{ action: string }>).map((entry) => entry.action);
  }

  it('approves a preview into a queued league job with the plan as steps', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId, body } = await previewFor(asRoot, leagueId);

    const approved = await approve(asRoot, previewId);
    expect(approved.statusCode).toBe(201);
    const job = approved.json().job as Record<string, unknown>;
    expect(job['state']).toBe('queued');
    expect(job['type']).toBe('tournament.setup');
    expect(job['lane']).toBe('setup');
    expect(job['leagueId']).toBe(leagueId);
    expect(job['planHash']).toBe(body['planHash']);
    expect(job['requestedByDiscordId']).toBe(ROOT_ID);
    expect(job['requestedByUserId']).toBeTypeOf('string');
    expect(job['error']).toBeNull();
    expect(job['id']).toBeTruthy();

    // The preview is consumed by the approval.
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/previews/${previewId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(preview.statusCode).toBe(409);

    // The list shows it, newest first, league-scoped.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueId}/jobs`,
      headers: { cookie: asRoot.cookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().jobs as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.['id']).toBe(job['id']);

    // The detail carries the step journal and the human-readable event log.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job['id']}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const steps = detail.json().steps as Array<Record<string, unknown>>;
    const plan = body['plan'] as { counts: { steps: number } };
    expect(steps).toHaveLength(plan.counts.steps);
    expect(steps[0]?.['seq']).toBe(1);
    for (const step of steps) {
      expect(step['status']).toBe('pending');
      expect(typeof step['kind']).toBe('string');
    }
    const events = detail.json().events as Array<Record<string, unknown>>;
    expect(events.some((event) => event['code'] === 'job.queued')).toBe(true);
    expect(detail.json().access.capabilities).toContain('jobs.decide');
    // Queued jobs have only the machine's cancel edge, not revert.
    expect(detail.json().allowedDecisions).toEqual([{ type: 'abort' }]);

    expect(await auditActions()).toContain('job.create');
  });

  it('is idempotent: a second approval returns the existing job, never a duplicate', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId } = await previewFor(asRoot, leagueId);

    const first = await approve(asRoot, previewId);
    expect(first.statusCode).toBe(201);
    const jobId = first.json().job.id as string;

    const second = await approve(asRoot, previewId);
    expect(second.statusCode).toBe(200);
    expect(second.json().job.id).toBe(jobId);

    expect(await countJobs(database, leagueId)).toBe(1);
  });

  it('refuses drift with 409 plan_changed and creates nothing', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId } = await previewFor(asRoot, leagueId);

    // Citadel moves on: one roster is renamed, so the live plan re-hashes.
    await serve(tournamentFixtures({ 9402: 'Bravo Uno' }));

    const refused = await approve(asRoot, previewId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('plan_changed');
    expect(await countJobs(database)).toBe(0);

    // Nothing was consumed: the preview is still open, and approval works
    // again once Citadel matches the stored plan.
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/previews/${previewId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(preview.statusCode).toBe(200);

    await serve(tournamentFixtures());
    const approved = await approve(asRoot, previewId);
    expect(approved.statusCode).toBe(201);
  });

  it('refuses an expired preview and creates nothing', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId } = await previewFor(asRoot, leagueId);

    await database.pool.query(
      "update previews set expires_at = now() - interval '1 minute' where id = $1",
      [previewId],
    );

    const refused = await approve(asRoot, previewId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('preview_expired');
    expect(await countJobs(database)).toBe(0);
  });

  it('refuses a preview consumed without a job', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId } = await previewFor(asRoot, leagueId);

    const consumed = await consumePreview(database.db, previewId);
    expect(consumed).toBeTruthy();

    const refused = await approve(asRoot, previewId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('preview_consumed');
    expect(await countJobs(database)).toBe(0);
  });

  it('refuses a second active job with the same plan hash (duplicate guard)', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const first = await previewFor(asRoot, leagueId);
    const approved = await approve(asRoot, first.previewId);
    expect(approved.statusCode).toBe(201);

    // A second preview of the same league hashes identically.
    const second = await previewFor(asRoot, leagueId);
    expect(second.body['planHash']).toBe(first.body['planHash']);
    const refused = await approve(asRoot, second.previewId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('active_duplicate');
    expect(await countJobs(database, leagueId)).toBe(1);

    // The refused approval left the second preview open.
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/previews/${second.previewId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(preview.statusCode).toBe(200);
  });

  it('gates decisions on jobs.decide and audits every decision', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const casterRole = await roleId(leagueId, 'Caster');
    const asCaster = await invited(MEMBER_ID, 'user', [{ leagueId, leagueRoleId: casterRole }]);

    const jobId = await seededJob(database, leagueId, {
      state: 'awaiting_decision',
      step: { kind: 'create_channel', compensation: null, skippable: true },
    });

    const casterDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asCaster.cookie },
    });
    expect(casterDetail.statusCode).toBe(200);
    expect(casterDetail.json().allowedDecisions).toEqual([]);
    expect(casterDetail.json().access.capabilities).not.toContain('jobs.decide');

    const rootDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asRoot.cookie },
    });
    const allowed = rootDetail.json().allowedDecisions as Array<{
      type: string;
      stepSeq?: number;
    }>;
    expect(allowed.some((decision) => decision.type === 'retry')).toBe(true);
    expect(allowed.some((decision) => decision.type === 'skip' && decision.stepSeq === 1)).toBe(
      true,
    );
    expect(allowed.some((decision) => decision.type === 'adopt' && decision.stepSeq === 1)).toBe(
      true,
    );
    expect(allowed.some((decision) => decision.type === 'revert')).toBe(true);
    expect(allowed.some((decision) => decision.type === 'abort')).toBe(true);

    // A caster can read the league but cannot decide on its jobs.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/decision`,
      headers: authHeaders(asCaster),
      payload: { type: 'retry' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain('jobs.decide');

    // The refused decision changed nothing.
    const still = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(still.json().job.state).toBe('awaiting_decision');

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/decision`,
      headers: authHeaders(asRoot),
      payload: { type: 'retry' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().job.state).toBe('running');

    // The machine wrote its journal row and the decision was audited.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asRoot.cookie },
    });
    const codes = (detail.json().events as Array<{ code: string }>).map((event) => event.code);
    expect(codes).toContain('job.decision.retry');
    expect(await auditActions()).toContain('job.decision');

    // A guest without any access to the league learns nothing.
    const asGuest = await login(user(OUTSIDER_ID, 'Outsider'));
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/decision`,
      headers: authHeaders(asGuest),
      payload: { type: 'retry' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('requires tournament.destructive for a revert that deletes', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const asHelper = await invited(HELPER_ID, 'helper');

    // A job with a done step whose compensation deletes a role.
    const jobId = await seededJob(database, leagueId, {
      state: 'awaiting_decision',
      step: {
        kind: 'create_role',
        compensation: { kind: 'delete_role', roleId: '9001' },
        status: 'done',
        skippable: false,
      },
    });

    // A helper holds jobs.decide but never tournament.destructive.
    const helperDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asHelper.cookie },
    });
    expect(helperDetail.statusCode).toBe(200);
    const helperAllowed = helperDetail.json().allowedDecisions as Array<{ type: string }>;
    expect(helperAllowed.some((decision) => decision.type === 'retry')).toBe(true);
    expect(helperAllowed.some((decision) => decision.type === 'revert')).toBe(false);

    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/decision`,
      headers: authHeaders(asHelper),
      payload: { type: 'revert' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toContain('tournament.destructive');

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/decision`,
      headers: authHeaders(asRoot),
      payload: { type: 'revert' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().job.state).toBe('reverting');
  });

  it('cancels an active job, refuses a second cancel and audits both paths', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const jobId = await seededJob(database, leagueId);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: authHeaders(asRoot),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().job.state).toBe('cancelled');
    expect(cancelled.json().job.finishedAt).toBeTruthy();

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: asRoot.cookie },
    });
    const codes = (detail.json().events as Array<{ code: string }>).map((event) => event.code);
    expect(codes).toContain('job.cancelled');
    expect(detail.json().allowedDecisions).toEqual([]);
    expect(await auditActions()).toContain('job.cancel');

    // Terminal states accept nothing: a second cancel is a conflict.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/cancel`,
      headers: authHeaders(asRoot),
    });
    expect(again.statusCode).toBe(409);

    // A guest without league access cannot cancel either.
    const asGuest = await login(user(OUTSIDER_ID, 'Outsider'));
    const secondJob = await seededJob(database, leagueId);
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${secondJob}/cancel`,
      headers: authHeaders(asGuest),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("lists only unresolved alerts inside the caller's league access", async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueA = await leagueWithKey(asRoot);
    const leagueB = await leagueWithKey(asRoot, 9101);
    const casterRole = await roleId(leagueA, 'Caster');
    const asCaster = await invited(MEMBER_ID, 'user', [
      { leagueId: leagueA, leagueRoleId: casterRole },
    ]);
    const jobId = await seededJob(database, leagueA);
    await database.db.insert(alerts).values([
      {
        kind: 'job.fatal_config',
        severity: 'critical',
        guildId: GUILD_ID,
        leagueId: leagueA,
        jobId,
        details: { message: 'token refused' },
      },
      {
        kind: 'job.fatal_config',
        severity: 'critical',
        guildId: GUILD_ID,
        leagueId: leagueA,
        jobId,
        details: { message: 'already resolved' },
        resolvedAt: new Date(),
      },
      {
        kind: 'job.fatal_config',
        severity: 'critical',
        guildId: GUILD_ID,
        leagueId: leagueB,
        jobId: null,
        details: { message: 'another league' },
      },
    ]);

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueA}/alerts`,
      headers: { cookie: asCaster.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().alerts).toHaveLength(1);
    const alert = own.json().alerts[0] as Record<string, unknown>;
    expect(alert['kind']).toBe('job.fatal_config');
    expect(alert['severity']).toBe('critical');
    expect(alert['leagueId']).toBe(leagueA);
    expect(alert['jobId']).toBe(jobId);
    expect(alert['details']).toEqual({ message: 'token refused' });
    expect(alert['openedAt']).toBeTypeOf('string');

    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueB}/alerts`,
      headers: { cookie: asCaster.cookie },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('never shows another league: 403 for foreign jobs, 404 for unknown ones', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueA = await leagueWithKey(asRoot);
    const leagueB = await leagueWithKey(asRoot, 9101);

    const jobA = await seededJob(database, leagueA);
    const jobB = await seededJob(database, leagueB);

    const casterRole = await roleId(leagueA, 'Caster');
    const asCaster = await invited(MEMBER_ID, 'user', [
      { leagueId: leagueA, leagueRoleId: casterRole },
    ]);

    // The caster sees league A's jobs...
    const ownList = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueA}/jobs`,
      headers: { cookie: asCaster.cookie },
    });
    expect(ownList.statusCode).toBe(200);
    expect(ownList.json().jobs.map((job: { id: string }) => job.id)).toEqual([jobA]);

    // ...and is refused on league B, which exists and holds a job.
    const foreignList = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueB}/jobs`,
      headers: { cookie: asCaster.cookie },
    });
    expect(foreignList.statusCode).toBe(403);

    const foreignDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobB}`,
      headers: { cookie: asCaster.cookie },
    });
    expect(foreignDetail.statusCode).toBe(403);

    // Root sees league B, proving the 403 is access, not emptiness.
    const rootList = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueB}/jobs`,
      headers: { cookie: asRoot.cookie },
    });
    expect(rootList.statusCode).toBe(200);
    expect(rootList.json().jobs.map((job: { id: string }) => job.id)).toEqual([jobB]);

    // Unknown ids are a plain 404.
    const unknownJob = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${randomUUID()}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(unknownJob.statusCode).toBe(404);

    const unknownLeague = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${randomUUID()}/jobs`,
      headers: { cookie: asRoot.cookie },
    });
    expect(unknownLeague.statusCode).toBe(404);
  });

  it('streams job.state within a second of a transition', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);
    const { previewId } = await previewFor(asRoot, leagueId);

    const opened = await openStream(`http://127.0.0.1:${port}/api/v1/stream?leagueId=${leagueId}`, {
      cookie: asRoot.cookie,
    });
    expect(opened.status).toBe(200);
    const stream = opened.stream!;
    const openEvent = await stream.next(5000);
    expect(openEvent.event).toBe('open');

    const startedAt = Date.now();
    const approved = await approve(asRoot, previewId);
    expect(approved.statusCode).toBe(201);
    const jobId = approved.json().job.id as string;

    const event = await stream.next(2000);
    expect(event.event).toBe('job.state');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const payload = JSON.parse(event.data) as Record<string, unknown>;
    expect(payload['jobId']).toBe(jobId);
    expect(payload['leagueId']).toBe(leagueId);
    expect(payload['state']).toBe('queued');
    expect(payload['from']).toBeNull();
    await stream.close();
  });

  it('streams only its own league, never another', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueA = await leagueWithKey(asRoot);
    const leagueB = await leagueWithKey(asRoot, 9101);

    const opened = await openStream(`http://127.0.0.1:${port}/api/v1/stream?leagueId=${leagueA}`, {
      cookie: asRoot.cookie,
    });
    expect(opened.status).toBe(200);
    const stream = opened.stream!;
    expect((await stream.next(5000)).event).toBe('open');

    // A notification on league B's channel is not league A's business.
    await database.pool.query('select pg_notify($1, $2)', [
      `drawbridge_jobs_${leagueB}`,
      JSON.stringify({ jobId: randomUUID(), leagueId: leagueB, state: 'queued', from: null }),
    ]);
    // And one on league A's channel is.
    await database.pool.query('select pg_notify($1, $2)', [
      `drawbridge_jobs_${leagueA}`,
      JSON.stringify({ jobId: randomUUID(), leagueId: leagueA, state: 'running', from: 'queued' }),
    ]);

    // B was notified first; if the stream had heard it, B would arrive first.
    const event = await stream.next(2000);
    expect(event.event).toBe('job.state');
    expect((JSON.parse(event.data) as Record<string, unknown>)['leagueId']).toBe(leagueA);
    await stream.close();
  });

  it('refuses a stream for a league the caller cannot read', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueA = await leagueWithKey(asRoot);
    const leagueB = await leagueWithKey(asRoot, 9101);
    const casterRole = await roleId(leagueA, 'Caster');
    const asCaster = await invited(MEMBER_ID, 'user', [
      { leagueId: leagueA, leagueRoleId: casterRole },
    ]);

    const opened = await openStream(`http://127.0.0.1:${port}/api/v1/stream?leagueId=${leagueB}`, {
      cookie: asCaster.cookie,
    });
    expect(opened.status).toBe(403);
    expect(opened.body).toContain('league.read');
  });

  it('releases a listener acquired after the client disconnects', async () => {
    let acquisitionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    let completeAcquisition: ((listener: { close: () => Promise<void> }) => void) | undefined;
    const listenerReady = new Promise<{ close: () => Promise<void> }>((resolve) => {
      completeAcquisition = resolve;
    });
    let listenerClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      listenerClosed = resolve;
    });

    const disconnectApp = await buildApp({
      config,
      logger: createLogger({ level: 'error', sink: () => undefined }),
      db: database.db,
      pool: database.pool,
      oauth,
      servePanel: false,
      streamListen: () => {
        acquisitionStarted?.();
        return listenerReady;
      },
    });
    await disconnectApp.app.listen({ host: '127.0.0.1', port: 0 });
    const address = disconnectApp.app.server.address();
    const disconnectPort = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const asRoot = await login(user(ROOT_ID, 'Root'));
      const leagueId = await leagueWithKey(asRoot);
      const controller = new AbortController();
      const aborted = fetch(
        `http://127.0.0.1:${disconnectPort}/api/v1/stream?leagueId=${leagueId}`,
        { headers: { cookie: asRoot.cookie }, signal: controller.signal },
      ).then(
        () => {
          throw new Error('the stream answered after its client aborted');
        },
        (error: unknown) => error,
      );

      // Hold LISTEN acquisition until the request is definitely aborted.
      await started;
      controller.abort();
      completeAcquisition?.({
        close: async () => {
          listenerClosed?.();
        },
      });
      expect(await aborted).toBeInstanceOf(Error);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('late listener was not closed')), 2000);
      });
      try {
        await Promise.race([closed, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      await disconnectApp.app.close();
    }
  });

  it('heartbeats while the stream is open', async () => {
    const lines: string[] = [];
    const heartbeatApp = await buildApp({
      config,
      logger: createLogger({ level: 'error', sink: (line) => lines.push(line) }),
      db: database.db,
      pool: database.pool,
      oauth,
      servePanel: false,
      heartbeatMs: 50,
    });
    await heartbeatApp.app.listen({ host: '127.0.0.1', port: 0 });
    const address = heartbeatApp.app.server.address();
    const heartbeatPort = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const asRoot = await login(user(ROOT_ID, 'Root'));
      const leagueId = await leagueWithKey(asRoot);
      const opened = await openStream(
        `http://127.0.0.1:${heartbeatPort}/api/v1/stream?leagueId=${leagueId}`,
        { cookie: asRoot.cookie },
      );
      expect(opened.status).toBe(200);
      const stream = opened.stream!;
      expect((await stream.next(5000)).event).toBe('open');
      const beat = await stream.next(2000);
      expect(beat.event).toBe('heartbeat');
      await stream.close();
    } finally {
      await heartbeatApp.app.close();
    }
  });
});

describe.skipIf(!available)('rate limits (integration)', () => {
  let database: Database;
  let ctx: AppContext;
  let currentUser: DiscordUser = user(ROOT_ID, 'Root');

  const oauth: DiscordOAuth = {
    authorizeUrl: (state) =>
      `https://discord.invalid/oauth2/authorize?client_id=1&state=${encodeURIComponent(state)}`,
    exchangeCode: async () => 'access-token',
    fetchUser: async () => currentUser,
  };

  beforeAll(async () => {
    database = await prepareTestDatabase();
    const lines: string[] = [];
    const logger = createLogger({ level: 'error', sink: (line) => lines.push(line) });
    ctx = await buildApp({
      config,
      logger,
      db: database.db,
      oauth,
      servePanel: false,
      // A bucket small enough to exhaust deterministically within one test.
      rateLimit: { max: 6, timeWindow: 60_000 },
    });
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    if (database) await closeTestDatabase(database);
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
    await ensureRootAdmins(database.db, [ROOT_ID]);
    await ensureGuild(database.db, GUILD_ID, 'Test Server');
  });

  function cookieOf(cookies: Array<{ name: string; value: string }>, name: string): string {
    const found = cookies.find((cookie) => cookie.name === name);
    if (!found) throw new Error(`cookie ${name} was not set`);
    return found.value;
  }

  async function login(as: DiscordUser): Promise<string> {
    currentUser = as;
    const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/discord' });
    const state = cookieOf(start.cookies, 'drawbridge_oauth_state');
    const callback = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: `drawbridge_oauth_state=${state}` },
    });
    const session = cookieOf(callback.cookies, 'drawbridge_session');
    const csrf = cookieOf(callback.cookies, 'drawbridge_csrf');
    return `drawbridge_session=${session}; drawbridge_csrf=${csrf}`;
  }

  it('answers 429 after the configured bucket, per session and per IP, exempting probes', async () => {
    // Probes never trip, however often supervision hits them.
    for (let i = 0; i < 10; i += 1) {
      const probe = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(probe.statusCode).toBe(200);
    }

    // A signed-in session has its own bucket: six allowed, the seventh 429.
    const rootCookie = await login(user(ROOT_ID, 'Root'));
    for (let i = 0; i < 6; i += 1) {
      const ok = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/leagues',
        headers: { cookie: rootCookie },
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/leagues',
      headers: { cookie: rootCookie },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain('Rate limit exceeded');
    expect(limited.headers['x-ratelimit-limit']).toBe('6');
    expect(limited.json().requestId).toBeTruthy();

    // A different session is not affected by the first one's bucket.
    const otherCookie = await login(user(HELPER_ID, 'Helper'));
    const other = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/leagues',
      headers: { cookie: otherCookie },
    });
    expect(other.statusCode).toBe(200);

    // Anonymous requests share one bucket per IP.
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/leagues' });
    expect(anonymous.statusCode).toBe(401);
    await ctx.app.inject({ method: 'GET', url: '/api/v1/leagues' });
    const anonymousLimited = await ctx.app.inject({ method: 'GET', url: '/api/v1/leagues' });
    expect(anonymousLimited.statusCode).toBe(429);
  });
});
