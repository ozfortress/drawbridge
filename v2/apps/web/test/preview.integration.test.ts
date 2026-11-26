/**
 * The preview API against a real Postgres and a fake Citadel.
 *
 * The Citadel answers over real HTTP with recorded-shaped bodies, so the
 * production client, its error taxonomy and the plan builder all run for
 * real. Nothing here writes to Discord: a preview is only a plan.
 */

import { createCitadelClient } from '@drawbridge/citadel';
import { parseConfig } from '@drawbridge/config';
import {
  consumePreview,
  type Database,
  ensureGuild,
  ensureRootAdmins,
  getLeagueCitadelKey,
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

describe.skipIf(!available)('preview api (integration)', () => {
  let database: Database;
  let ctx: AppContext;
  let citadel: FakeCitadel;
  let citadelBaseUrl = '';
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
      // The fake Citadel answers every read; no retries, so a failing test
      // does not wait for a backoff.
      citadel: (input) =>
        createCitadelClient({
          baseUrl: citadelBaseUrl,
          apiKey: input.apiKey,
          maxRetries: 0,
        }),
    });
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
  async function leagueWithKey(as: Login): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/leagues',
      headers: authHeaders(as),
      payload: {
        guildId: GUILD_ID,
        citadelLeagueId: CITADEL_LEAGUE_ID,
        name: 'Test League',
        shortcode: 'TL',
      },
    });
    expect(created.statusCode).toBe(201);
    const leagueId = created.json().league.id as string;

    const key = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(as),
      payload: { key: API_KEY, label: 'primary' },
    });
    expect(key.statusCode).toBe(200);
    return leagueId;
  }

  async function auditRows(): Promise<Array<{ action: string; actorDiscordId: string }>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=500',
      headers: { cookie: (await login(user(ROOT_ID, 'Root'))).cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().entries as Array<{ action: string; actorDiscordId: string }>;
  }

  async function auditActions(): Promise<string[]> {
    return (await auditRows()).map((entry) => entry.action);
  }

  it('creates a preview, reads it back and verifies it as unchanged', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.previewId).toBeTruthy();
    expect(body.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.plan.divisions).toHaveLength(2);
    expect(body.plan.divisions[0].entries).toHaveLength(2);
    expect(body.warnings).toEqual([]);
    expect(body.capacity.status).toBe('fit');
    expect(body.captains).toHaveLength(4);

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/previews/${body.previewId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().planHash).toBe(body.planHash);
    expect(read.json().plan).toEqual(body.plan);

    const verified = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/previews/${body.previewId}/verify`,
      headers: authHeaders(asRoot),
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().changed).toBe(false);
    expect(verified.json().changedPaths).toEqual([]);

    const actions = await auditActions();
    expect(actions).toContain('preview.create');
    expect(actions).toContain('preview.verify');
  });

  it('reports the changed division and team when Citadel moves on', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(created.statusCode).toBe(201);
    const previewId = created.json().previewId as string;

    // The roster of one entry is renamed, so its role and channel names move too.
    await serve(tournamentFixtures({ 9402: 'Bravo Uno' }));

    const verified = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/previews/${previewId}/verify`,
      headers: authHeaders(asRoot),
    });
    expect(verified.statusCode).toBe(200);
    const body = verified.json();
    expect(body.changed).toBe(true);
    expect(body.changedPaths.length).toBeGreaterThan(0);
    expect(body.changedPaths.some((path: string) => path.includes('Open'))).toBe(true);
    expect(body.changedPaths.some((path: string) => path.includes('Bravo'))).toBe(true);
  });

  it('leaves no preview row behind when Citadel is down', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    citadel.setMode('503');
    const failed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toContain('citadel_unavailable');

    const rows = await database.db.execute<{ count: number }>(
      'select count(*)::int as count from previews',
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('answers 422 when the key cannot see the league', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    citadel.setMode('404');
    const hidden = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(hidden.statusCode).toBe(422);
    expect(hidden.json().error).toContain('citadel_not_visible');
  });

  it('sets, rotates and revokes the Citadel key and stores only the envelope', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/leagues',
      headers: authHeaders(asRoot),
      payload: {
        guildId: GUILD_ID,
        citadelLeagueId: CITADEL_LEAGUE_ID,
        name: 'Test League',
        shortcode: 'TL',
      },
    });
    const leagueId = created.json().league.id as string;

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: { cookie: asRoot.cookie },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().status).toBe('missing');

    const set = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asRoot),
      payload: { key: API_KEY, label: 'primary' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().status).toBe('active');
    expect(JSON.stringify(set.json())).not.toContain(API_KEY);

    const stored = await getLeagueCitadelKey(database.db, leagueId);
    expect(stored).toBeTruthy();
    expect(stored!.keyEnvelope).not.toContain(API_KEY);
    expect(stored!.label).toBe('primary');

    const rotated = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asRoot),
      payload: { key: 'citadel-api-key-rotated', label: 'rotated' },
    });
    expect(rotated.statusCode).toBe(200);
    const afterRotation = await getLeagueCitadelKey(database.db, leagueId);
    expect(afterRotation!.keyEnvelope).not.toBe(stored!.keyEnvelope);
    expect(afterRotation!.keyEnvelope).not.toContain('citadel-api-key-rotated');

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asRoot),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');

    const status = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: { cookie: asRoot.cookie },
    });
    expect(status.json().status).toBe('revoked');
    expect(JSON.stringify(status.json())).not.toContain(API_KEY);

    // A revoked key is no key: a preview refuses with 409.
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error).toContain('citadel_key_missing');
  });

  it('refuses an unauthorized tier and writes no success audit', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const invite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asRoot),
      payload: { discordId: OUTSIDER_ID, globalRole: 'user' },
    });
    expect(invite.statusCode).toBe(201);
    const asOutsider = await login(user(OUTSIDER_ID, 'Outsider'));

    const before = (await auditRows()).filter((entry) => entry.actorDiscordId === OUTSIDER_ID);
    expect(before).toHaveLength(0);

    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asOutsider),
    });
    expect(preview.statusCode).toBe(403);

    const key = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asOutsider),
      payload: { key: 'citadel-api-key-for-tests', label: 'primary' },
    });
    expect(key.statusCode).toBe(403);

    // A refused request leaves no audit row behind that claims a success.
    const after = (await auditRows()).filter((entry) => entry.actorDiscordId === OUTSIDER_ID);
    expect(after).toHaveLength(0);
    expect(after.map((entry) => entry.action)).not.toContain('preview.create');
    expect(after.map((entry) => entry.action)).not.toContain('citadel.key.set');
  });

  it('refuses to reuse a consumed preview', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    const previewId = created.json().previewId as string;

    const consumed = await consumePreview(database.db, previewId);
    expect(consumed).toBeTruthy();

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/previews/${previewId}`,
      headers: { cookie: asRoot.cookie },
    });
    expect(read.statusCode).toBe(409);
    expect(read.json().error).toContain('consumed');
  });

  it('refuses to verify a preview whose stored plan cannot be read', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(created.statusCode).toBe(201);
    const previewId = created.json().previewId as string;

    // A plan that was corrupted in the database must not crash the check.
    await database.pool.query(
      'update previews set plan = \'{"broken":true}\'::jsonb where id = $1',
      [previewId],
    );

    const verified = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/previews/${previewId}/verify`,
      headers: authHeaders(asRoot),
    });
    expect(verified.statusCode).toBe(409);
    expect(verified.json().error).toContain('preview_plan_corrupt');
  });

  it('keeps working after the key is rotated and refuses a rejected key', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const leagueId = await leagueWithKey(asRoot);

    const first = await getLeagueCitadelKey(database.db, leagueId);
    const rotated = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asRoot),
      payload: { key: 'citadel-api-key-rotated', label: 'rotated' },
    });
    expect(rotated.statusCode).toBe(200);
    const afterRotation = await getLeagueCitadelKey(database.db, leagueId);
    expect(afterRotation!.keyEnvelope).not.toBe(first!.keyEnvelope);

    // The stale key is gone; the new one is what the preview reads.
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/leagues/${leagueId}/preview`,
      headers: authHeaders(asRoot),
    });
    expect(preview.statusCode).toBe(201);

    // A key Citadel rejects never reaches the database.
    citadel.setMode('401');
    const rejected = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/leagues/${leagueId}/citadel-key`,
      headers: authHeaders(asRoot),
      payload: { key: 'citadel-api-key-rejected', label: 'rejected' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toContain('citadel_unauthorized');
    const stillStored = await getLeagueCitadelKey(database.db, leagueId);
    expect(stillStored!.keyEnvelope).toBe(afterRotation!.keyEnvelope);
  });
});
