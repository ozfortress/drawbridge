/**
 * Integration-test helpers.
 *
 * The database helpers use TEST_DATABASE_URL when set, otherwise the local dev
 * compose database on port 5433. The database is created on demand, migrations
 * are applied once, and `resetTestDatabase` truncates every table between
 * tests.
 *
 * `createFakeCitadel` serves recorded Citadel responses over real HTTP so
 * clients can be exercised without a live Citadel instance. `FakeDiscord` is
 * the in-memory `DiscordPort`: deterministic snowflakes, the audit log with
 * reason tags, capacity limits, fault injection and a gateway event emitter,
 * with no network I/O and no timers.
 */

import {
  closeDatabase,
  createDatabase,
  type Database,
  type Db,
  runMigrations,
} from '@drawbridge/db';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

export * from './fake-citadel.js';
export * from './fake-discord.js';

const DEFAULT_TEST_URL = 'postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_test';

const TABLES = [
  'users',
  'user_invites',
  'sessions',
  'audit_log',
  'alerts',
  'guilds',
  'league_role_templates',
  'leagues',
  'league_citadel_keys',
  'league_roles',
  'league_memberships',
  'managed_channels',
  'guild_roles',
  'guild_role_mappings',
  'settings_kv',
  'previews',
  'jobs',
  'job_steps',
  'job_events',
  'discord_objects',
];

function testUrl(): string {
  return process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_URL;
}

function adminUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

export async function testDatabaseAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: adminUrl(testUrl()), connectionTimeoutMillis: 2000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function prepareTestDatabase(): Promise<Database> {
  const url = testUrl();
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`unsafe test database name: ${name}`);

  const admin = new Pool({ connectionString: adminUrl(url), connectionTimeoutMillis: 5000 });
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await admin.query(`create database "${name}"`);
    }
  } finally {
    await admin.end();
  }

  const database = createDatabase(url, 4);
  await runMigrations(database.db);
  return database;
}

export async function resetTestDatabase(db: Db): Promise<void> {
  await db.execute(sql.raw(`truncate table ${TABLES.join(', ')} restart identity cascade`));
}

export async function closeTestDatabase(database: Database): Promise<void> {
  await closeDatabase(database);
}
