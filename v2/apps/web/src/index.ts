import type { Config } from '@drawbridge/config';
import type { Db, Pool } from '@drawbridge/db';
import type { Logger } from '@drawbridge/logging';
import { type AppContext, buildApp, listen } from './app.js';
import type { DiscordOAuth } from './auth/oauth.js';

export interface StartWebOptions {
  db?: Db;
  /** The Postgres pool. SSE stream listeners hold connections out of it. */
  pool?: Pool;
  oauth?: DiscordOAuth;
}

export async function start(
  config: Config,
  logger: Logger,
  options: StartWebOptions = {},
): Promise<AppContext> {
  const ctx = await buildApp({ config, logger, ...options });
  await listen(ctx);
  return ctx;
}

export type { AppContext } from './app.js';
export { buildApp, defaultReadinessDependencies } from './app.js';
export { createDiscordOAuth, type DiscordOAuth } from './auth/oauth.js';
