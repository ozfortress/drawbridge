import type { Config } from '@drawbridge/config';
import {
  type Dependency,
  evaluateReadiness,
  httpStatusFor,
  notImplemented,
  type ReadinessReport,
} from '@drawbridge/health';
import type { Logger } from '@drawbridge/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { VERSION } from './version.js';

export interface BuildAppOptions {
  config: Config;
  logger: Logger;
  readinessDependencies?: readonly Dependency[];
}

export interface AppContext {
  app: FastifyInstance;
  config: Config;
  logger: Logger;
}

/** Errors may carry a message that is safe to show to the caller. */
type ErrorWithStatus = Error & { statusCode?: number; userMessage?: string };

function isProbe(url: string): boolean {
  return url.startsWith('/healthz') || url.startsWith('/readyz');
}

export function defaultReadinessDependencies(): Dependency[] {
  // Wired up incrementally: Postgres in P1, S3 in P6, Discord in P3. Until then
  // they are visible but not required, so readiness is `degraded`, not `down`.
  return [
    notImplemented('postgres', false),
    notImplemented('s3', false),
    notImplemented('discord', false),
  ];
}

export async function buildApp(options: BuildAppOptions): Promise<AppContext> {
  const { config, logger } = options;
  const readinessDependencies = options.readinessDependencies ?? defaultReadinessDependencies();

  const app = Fastify({
    // Every log line goes through the redacting logger; never Fastify's own.
    // With its own logger disabled, Fastify emits no request lines either.
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });

  const root = logger.child({ scope: 'web' });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', String(request.id));
    return payload;
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    if (!isProbe(request.url)) {
      root.info('request', {
        requestId: String(request.id),
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const typed = error as ErrorWithStatus;
    const statusCode = typed.statusCode && typed.statusCode >= 400 ? typed.statusCode : 500;
    const userMessage =
      typeof typed.userMessage === 'string'
        ? typed.userMessage
        : statusCode >= 500
          ? 'Internal server error'
          : typed.message;

    if (statusCode >= 500) {
      root.error('request failed', {
        requestId: String(request.id),
        method: request.method,
        path: request.url,
        statusCode,
        error,
      });
    }
    return reply.status(statusCode).send({ error: userMessage, requestId: String(request.id) });
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: 'Not found', requestId: String(request.id), path: request.url }),
  );

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'drawbridge',
    role: config.runMode,
    version: VERSION,
    time: new Date().toISOString(),
  }));

  app.get('/readyz', async (_request, reply) => {
    const report: ReadinessReport = await evaluateReadiness(readinessDependencies);
    if (report.status === 'degraded') {
      // debug, not warn: probes run every few seconds and would flood the log.
      root.debug('readiness degraded', { dependencies: report.dependencies });
    }
    return reply.status(httpStatusFor(report.status)).send({
      status: report.status,
      dependencies: report.dependencies,
    });
  });

  return { app, config, logger: root };
}

export async function listen(ctx: AppContext): Promise<void> {
  await ctx.app.listen({ host: ctx.config.webHost, port: ctx.config.webPort });
  ctx.logger.info('web listening', {
    host: ctx.config.webHost,
    port: ctx.config.webPort,
    publicBaseUrl: ctx.config.publicBaseUrl,
  });
}
