import { parseConfig } from '@drawbridge/config';
import { type Database, ensureGuild, ensureRootAdmins } from '@drawbridge/db';
import { createLogger } from '@drawbridge/logging';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, buildApp } from '../src/app.js';
import type { DiscordOAuth, DiscordUser } from '../src/auth/oauth.js';

const ROOT_ID = '136264506933248001';
const GUEST_ID = '136264506933248002';
const OTHER_ID = '136264506933248003';
const ADMIN_ID = '136264506933248004';
const GUILD_ID = '1573554616371777546';

const available = await testDatabaseAvailable();

const config = parseConfig({
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:8080',
  DISCORD_APPLICATION_ID: '1573555530901880855',
});

function user(id: string, name: string): DiscordUser {
  return { id, username: name, globalName: name, avatar: null };
}

describe.skipIf(!available)('web api (integration)', () => {
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
    ctx = await buildApp({ config, logger, db: database.db, oauth, servePanel: false });
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
    await ensureRootAdmins(database.db, [ROOT_ID]);
    await ensureGuild(database.db, GUILD_ID, 'Test Server');
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    if (database) await closeTestDatabase(database);
  });

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
    expect(callback.headers['location']).toBe('/');

    const session = cookieOf(callback.cookies, 'drawbridge_session');
    const csrf = cookieOf(callback.cookies, 'drawbridge_csrf');
    return { cookie: `drawbridge_session=${session}; drawbridge_csrf=${csrf}`, csrf };
  }

  function authHeaders(loginResult: Login): Record<string, string> {
    return { cookie: loginResult.cookie, 'x-csrf-token': loginResult.csrf };
  }

  async function me(loginResult: Login) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: loginResult.cookie },
    });
    return { response, body: response.json() as any };
  }

  it('rejects unauthenticated requests and sets security headers', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('signs in a root admin and returns global capabilities', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const { response, body } = await me(asRoot);
    expect(response.statusCode).toBe(200);
    expect(body.user.tier).toBe('root');
    expect(body.user.discordId).toBe(ROOT_ID);
    expect(body.globalCapabilities).toContain('tournament.destructive');
    expect(body.csrfToken).toBe(asRoot.csrf);

    const users = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: asRoot.cookie },
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().users).toHaveLength(1);
  });

  it('enforces CSRF on mutating requests', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: { cookie: asRoot.cookie },
      payload: { discordId: GUEST_ID, globalRole: 'user' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/CSRF/);
  });

  it('invites a user and applies the tier on first sign-in', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const invite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asRoot),
      payload: { discordId: GUEST_ID, globalRole: 'user' },
    });
    expect(invite.statusCode).toBe(201);

    const asGuest = await login(user(GUEST_ID, 'Guest'));
    const { body } = await me(asGuest);
    expect(body.user.tier).toBe('user');
  });

  it('lets a user create and read its own league, and blocks outsiders', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const invite = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asRoot),
      payload: { discordId: GUEST_ID, globalRole: 'user' },
    });
    expect(invite.statusCode).toBe(201);

    const asGuest = await login(user(GUEST_ID, 'Guest'));
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/leagues',
      headers: authHeaders(asGuest),
      payload: { guildId: GUILD_ID, citadelLeagueId: 7, name: 'HL', shortcode: 'HL7' },
    });
    expect(created.statusCode).toBe(201);
    const leagueId = created.json().league.id as string;

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueId}`,
      headers: { cookie: asGuest.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.access.tier).toBe('user');
    expect(body.access.leagueRank).toBe(10);
    expect(body.access.capabilities).toContain('tournament.destructive');
    expect(body.roles.map((role: { name: string }) => role.name)).toEqual([
      'Director',
      'Admin',
      'Trial',
      'Caster',
      'Player',
    ]);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/leagues/${leagueId}`,
      headers: authHeaders(asGuest),
      payload: { name: 'HL Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().league.name).toBe('HL Renamed');

    const asOther = await login(user(OTHER_ID, 'Other'));
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leagues/${leagueId}`,
      headers: { cookie: asOther.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('enforces tier management rules', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asRoot),
      payload: { discordId: ADMIN_ID, globalRole: 'admin' },
    });
    const asAdmin = await login(user(ADMIN_ID, 'Admin'));

    const users = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: asAdmin.cookie },
    });
    const rootUser = users
      .json()
      .users.find((entry: { discordId: string }) => entry.discordId === ROOT_ID);

    const demoteRoot = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${rootUser.id}`,
      headers: authHeaders(asAdmin),
      payload: { globalRole: 'guest' },
    });
    expect(demoteRoot.statusCode).toBe(403);

    const inviteAdmin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asAdmin),
      payload: { discordId: OTHER_ID, globalRole: 'admin' },
    });
    expect(inviteAdmin.statusCode).toBe(403);

    const inviteUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asAdmin),
      payload: { discordId: OTHER_ID, globalRole: 'user' },
    });
    expect(inviteUser.statusCode).toBe(201);

    const demoteAdmin = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${rootUser.id}`,
      headers: authHeaders(asRoot),
      payload: { globalRole: 'user' },
    });
    // Root may manage root.
    expect(demoteAdmin.statusCode).toBe(200);
  });

  it('blocks guests from user management', async () => {
    const asGuest = await login(user(GUEST_ID, 'Guest'));
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users/invites',
      headers: authHeaders(asGuest),
      payload: { discordId: OTHER_ID, globalRole: 'user' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('revokes the session on logout', async () => {
    const asRoot = await login(user(ROOT_ID, 'Root'));
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authHeaders(asRoot),
    });
    expect(logout.statusCode).toBe(204);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: asRoot.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
