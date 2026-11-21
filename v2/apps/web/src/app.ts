import './types.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from '@drawbridge/config';
import { checkPostgres, type Db } from '@drawbridge/db';
import {
  type Dependency,
  evaluateReadiness,
  httpStatusFor,
  notImplemented,
  type ReadinessReport,
} from '@drawbridge/health';
import type { Logger } from '@drawbridge/logging';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDiscordOAuth, type DiscordOAuth } from './auth/oauth.js';
import { requireCsrf } from './auth/session.js';
import { HttpError } from './http/errors.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLeagueRoutes } from './routes/leagues.js';
import { registerUserRoutes } from './routes/users.js';
import { VERSION } from './version.js';

export interface BuildAppOptions {
  config: Config;
  logger: Logger;
  db?: Db;
  oauth?: DiscordOAuth;
  readinessDependencies?: readonly Dependency[];
  /** Serve the built panel and SPA fallback. Off in API-only tests. */
  servePanel?: boolean;
}

export interface AppContext {
  app: FastifyInstance;
  config: Config;
  logger: Logger;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isProbe(url: string): boolean {
  return url.startsWith('/healthz') || url.startsWith('/readyz');
}

export function defaultReadinessDependencies(db?: Db): Dependency[] {
  // S3 is wired in P6, Discord in P3. Until then they are visible but optional.
  return [
    db
      ? { name: 'postgres', required: true, check: () => checkPostgres(db) }
      : notImplemented('postgres', false),
    notImplemented('s3', false),
    notImplemented('discord', false),
  ];
}

export async function buildApp(options: BuildAppOptions): Promise<AppContext> {
  const { config, logger, db } = options;
  const readinessDependencies = options.readinessDependencies ?? defaultReadinessDependencies(db);

  const app = Fastify({
    // Every log line goes through the redacting logger; never Fastify's own.
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });

  const root = logger.child({ scope: 'web' });
  await app.register(cookie);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', String(request.id));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  app.addHook('preHandler', async (request) => {
    if (
      MUTATING_METHODS.has(request.method) &&
      request.url.startsWith('/api/v1/') &&
      !request.url.startsWith('/api/v1/auth/discord')
    ) {
      requireCsrf(request);
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!isProbe(request.url)) {
      root.info('request', {
        requestId: String(request.id),
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.userMessage, requestId: String(request.id) });
    }
    const typed = error as { statusCode?: number; message: string };
    const statusCode = typed.statusCode && typed.statusCode >= 400 ? typed.statusCode : 500;
    const message = statusCode >= 500 ? 'Internal server error' : typed.message;
    if (statusCode >= 500) {
      root.error('request failed', {
        requestId: String(request.id),
        method: request.method,
        path: request.url,
        statusCode,
        error,
      });
    }
    return reply.status(statusCode).send({ error: message, requestId: String(request.id) });
  });

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

  if (db) {
    const oauth =
      options.oauth ??
      createDiscordOAuth({
        clientId: config.discordApplicationId,
        clientSecret: config.discordClientSecret.reveal(),
        redirectUri: config.discordRedirectUri,
      });
    const deps = { config, db, oauth, logger: root };
    registerAuthRoutes(app, deps);
    registerUserRoutes(app, { config, db });
    registerLeagueRoutes(app, { config, db });
    registerAuditRoutes(app, { config, db });
  } else {
    root.warn('no database configured; API routes are not registered');
  }

  // Panel: serve the built single-page app and fall back to index.html for  // client-side routes. API and health routes are matched before this.
  const panelDir = fileURLToPath(new URL('../../panel/dist', import.meta.url));
  const panelServed = options.servePanel !== false && existsSync(`${panelDir}/index.html`);
  if (panelServed) {
    await app.register(fastifyStatic, { root: panelDir, wildcard: false });
  } else {
    root.warn('panel build not found; run pnpm -F @drawbridge/panel build');
  }

  app.setNotFoundHandler((request, reply) => {
    if (panelServed && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply
      .status(404)
      .send({ error: 'Not found', requestId: String(request.id), path: request.url });
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
