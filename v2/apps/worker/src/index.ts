import type { Logger } from '@drawbridge/logging';

/**
 * Worker process: job runner (the only Discord REST writer), attachments,
 * retention and schedulers.
 *
 * Not implemented yet: the job engine arrives in P3. The process idles.
 */
export async function start(_logger: Logger): Promise<{ stop(): Promise<void> }> {
  const logger = _logger.child({ scope: 'worker' });
  logger.warn('worker role not implemented yet; idling', { phase: 'P0' });
  const timer = setInterval(() => {
    logger.debug('worker idle heartbeat');
  }, 30_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      logger.info('worker stopped');
    },
  };
}
