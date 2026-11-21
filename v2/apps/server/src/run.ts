import { start as startBot } from '@drawbridge/bot';
import type { Config } from '@drawbridge/config';
import type { Logger } from '@drawbridge/logging';
import { start as startWeb } from '@drawbridge/web';
import { start as startWorker } from '@drawbridge/worker';

export interface RunningRole {
  readonly name: string;
  stop(): Promise<void>;
}

export async function startRole(config: Config, logger: Logger): Promise<RunningRole[]> {
  switch (config.runMode) {
    case 'migrate':
      // Migrations are wired in P1; the one-shot migrate role exits after them.
      logger.info('migrate role has no migrations to run yet');
      return [];
    case 'web': {
      const ctx = await startWeb(config, logger);
      return [{ name: 'web', stop: () => ctx.app.close() }];
    }
    case 'bot': {
      const bot = await startBot(logger);
      return [{ name: 'bot', stop: () => bot.stop() }];
    }
    case 'worker': {
      const worker = await startWorker(logger);
      return [{ name: 'worker', stop: () => worker.stop() }];
    }
    case 'all': {
      const ctx = await startWeb(config, logger);
      const bot = await startBot(logger);
      const worker = await startWorker(logger);
      return [
        { name: 'web', stop: () => ctx.app.close() },
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
