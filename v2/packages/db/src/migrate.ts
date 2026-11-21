import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

/**
 * Applies every pending migration from packages/db/drizzle.
 *
 * Safe to run concurrently: the migrator takes an advisory lock.
 */
export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
}
