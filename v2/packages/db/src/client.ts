import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** An open transaction on {@link Db}, for callers that compose repo writes. */
export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** A database handle, or an open transaction on one. */
export type DbOrTx = Db | DbTx;

export interface Database {
  db: Db;
  pool: Pool;
}

export function createDatabase(connectionString: string, maxConnections = 10): Database {
  const pool = new Pool({ connectionString, max: maxConnections });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** Readiness probe: a tiny round trip that fails fast. */
export async function checkPostgres(db: Db): Promise<boolean> {
  const result = await db.execute<{ ok: number }>('select 1 as ok');
  return result.rows[0]?.ok === 1;
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.pool.end();
}

export { schema };
