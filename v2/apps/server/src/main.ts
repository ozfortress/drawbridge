import { type Config, ConfigError, loadConfig } from '@drawbridge/config';
import { createLogger, type Logger } from '@drawbridge/logging';
import { type RunningRole, startRole } from './run.js';

function loadConfigOrExit(): Config | undefined {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  if (!config) return;

  const logger: Logger = createLogger({
    level: config.logLevel,
    bindings: { service: 'drawbridge', role: config.runMode },
  });

  let roles: RunningRole[] = [];
  let stopping = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    await Promise.allSettled(roles.map(async (role) => role.stop()));
    logger.info('stopped');
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').finally(() => process.exit(0));
  });

  try {
    logger.info('starting', { runMode: config.runMode });
    roles = await startRole(config, logger);
    logger.info('started', { roles: roles.map((role) => role.name) });
  } catch (error) {
    logger.fatal('startup failed', { error });
    process.exitCode = 1;
    await shutdown('startup-failure');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `drawbridge failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
