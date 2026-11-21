import type { Logger } from '@drawbridge/logging';

/**
 * Bot process: Discord gateway, interactions and capture.
 *
 * Not implemented yet: the gateway adapter arrives with the Discord executor
 * work (P3). The process stays alive so a supervisor does not restart-loop it.
 */
export async function start(_logger: Logger): Promise<{ stop(): Promise<void> }> {
  const logger = _logger.child({ scope: 'bot' });
  logger.warn('bot role not implemented yet; idling', { phase: 'P0' });
  const timer = setInterval(() => {
    logger.debug('bot idle heartbeat');
  }, 30_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      logger.info('bot stopped');
    },
  };
}
