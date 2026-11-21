import type { Config } from '@drawbridge/config';
import type { Logger } from '@drawbridge/logging';
import { type AppContext, buildApp, listen } from './app.js';

export async function start(config: Config, logger: Logger): Promise<AppContext> {
  const ctx = await buildApp({ config, logger });
  await listen(ctx);
  return ctx;
}

export type { AppContext } from './app.js';
export { buildApp, defaultReadinessDependencies } from './app.js';
