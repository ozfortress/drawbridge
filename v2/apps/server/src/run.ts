import { start as startBot } from '@drawbridge/bot';
import type { Config } from '@drawbridge/config';
import {
  closeDatabase,
  createDatabase,
  type Database,
  ensureRootAdmins,
  runMigrations,
} from '@drawbridge/db';
import type { Logger } from '@drawbridge/logging';
import { createDiscordOAuth, start as startWeb } from '@drawbridge/web';
import { start as startWorker } from '@drawbridge/worker';

export interface RunningRole {
  readonly name: string;
  stop(): Promise<void>;
}

function openDatabase(config: Config): Database {
  return createDatabase(config.databaseUrl.reveal());
}

async function startWebWithDatabase(
  config: Config,
  logger: Logger,
  options: { migrate: boolean },
): Promise<RunningRole> {
  const database = openDatabase(config);
  try {
    if (options.migrate) {
      await runMigrations(database.db);
      logger.info('migrations applied');
    } else {
      logger.info('migrations skipped (run the migrate role)');
    }
    const roots = await ensureRootAdmins(database.db, config.rootAdminDiscordIds);
    if (roots > 0) logger.info('root admins ensured', { count: roots });

    if (!config.masterKey) {
      logger.warn('DRAWBRIDGE_MASTER_KEY is not set; secrets cannot be sealed yet');
    }

    const oauth = createDiscordOAuth({
      clientId: config.discordApplicationId,
      clientSecret: config.discordClientSecret.reveal(),
      redirectUri: config.discordRedirectUri,
    });

    const ctx = await startWeb(config, logger, { db: database.db, pool: database.pool, oauth });
    return {
      name: 'web',
      stop: async () => {
        await ctx.app.close();
        await closeDatabase(database);
      },
    };
  } catch (error) {
    await closeDatabase(database);
    throw error;
  }
}

export async function startRole(config: Config, logger: Logger): Promise<RunningRole[]> {
  switch (config.runMode) {
    case 'migrate': {
      const database = openDatabase(config);
      try {
        await runMigrations(database.db);
        logger.info('migrations applied');
      } finally {
        await closeDatabase(database);
      }
      return [];
    }
    case 'web':
      return [await startWebWithDatabase(config, logger, { migrate: false })];
    case 'bot': {
      const bot = await startBot(logger);
      return [{ name: 'bot', stop: () => bot.stop() }];
    }
    case 'worker': {
      const worker = await startWorker(config, logger);
      return [{ name: 'worker', stop: () => worker.stop() }];
    }
    case 'all': {
      const web = await startWebWithDatabase(config, logger, { migrate: true });
      const bot = await startBot(logger);
      const worker = await startWorker(config, logger);
      return [
        web,
        { name: 'bot', stop: () => bot.stop() },
        { name: 'worker', stop: () => worker.stop() },
      ];
    }
    default: {
      const never: never = config.runMode;
      throw new Error(`unhandled run mode: ${String(never)}`);
    }
  }
}
