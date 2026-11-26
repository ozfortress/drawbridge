/**
 * The realtime stream (plan 02 §11, §14): `GET /api/v1/stream?leagueId=...`
 * answers `text/event-stream` fed by Postgres LISTEN/NOTIFY.
 *
 * One channel per league: the `jobs_state_notify` trigger (migration 0004)
 * notifies `drawbridge_jobs_{leagueId}` at the commit of every job state
 * transition, and this route listens on exactly that channel for a caller
 * who holds `league.read` on the league. Each connection holds one
 * dedicated pool connection, so a stream hears its own league and nothing
 * else, and every notification is written to the socket the moment it
 * arrives - nothing is buffered in application memory between Postgres and
 * the wire. A heartbeat every 15 seconds keeps proxies from idling the
 * connection out; the reverse proxy contract (§14) additionally demands
 * response buffering off and a read timeout above the heartbeat interval.
 */
import { can } from '@drawbridge/authz';
import type { Config } from '@drawbridge/config';
import {
  type Db,
  type JobStateListener,
  listenJobState,
  type Pool,
  resolveLeagueAccess,
} from '@drawbridge/db';
import type { Logger } from '@drawbridge/logging';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, useSecureCookies } from '../auth/session.js';
import { forbidden, HttpError, notFound } from '../http/errors.js';
import { parseQuery } from '../http/helpers.js';

/** The heartbeat interval (02 §14: every 15 seconds). */
export const STREAM_HEARTBEAT_MS = 15_000;

const streamQuery = z.object({
  leagueId: z.string().min(1),
});

/** The trigger's notification payload, as the stream emits it. */
const notificationSchema = z.object({
  jobId: z.string().min(1),
  leagueId: z.string().min(1),
  state: z.string().min(1),
  from: z.string().min(1).nullable(),
});

export interface StreamRouteDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** SSE listeners hold a connection out of this pool; without it the route answers 503. */
  pool?: Pool | undefined;
  /** Overrides the 15-second heartbeat for tests. */
  heartbeatMs?: number | undefined;
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;

  app.get('/api/v1/stream', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = parseQuery(streamQuery, request);

    // A caller without league.read gets the same answer as for a league
    // that does not exist: the stream never names another league's
    // business, not even by existing.
    const actor = { userId: auth.userId, discordId: auth.discordId, tier: auth.tier };
    const resolved = await resolveLeagueAccess(deps.db, actor, leagueId);
    if (!resolved) throw notFound('League not found');
    if (!resolved.access || !can(resolved.access, 'league.read')) {
      throw forbidden('You need the league.read capability on this league');
    }

    if (!deps.pool) {
      throw new HttpError(503, 'streaming is unavailable: no database pool is configured');
    }

    let closed = false;
    let listener: JobStateListener | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const raw = reply.raw;
    const send = (event: string, data: string): void => {
      if (closed) return;
      raw.write(`event: ${event}\ndata: ${data}\n\n`);
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (listener !== undefined) void listener.close();
      try {
        raw.end();
      } catch {
        // The socket is already gone; the listener release is the cleanup.
      }
    };

    // The listener is acquired before the reply is hijacked, so a failure to
    // listen still answers as an ordinary HTTP error. Notifications are
    // delivered on I/O events, never inside the synchronous block below, so
    // `send` cannot run before the headers are on the wire.
    try {
      listener = await listenJobState(deps.pool, leagueId, {
        onPayload: (payload) => {
          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            return;
          }
          const parsed = notificationSchema.safeParse(json);
          if (!parsed.success) return;
          // The channel is per-league; a payload naming another league is
          // not this stream's business (defence in depth: the trigger
          // cannot produce one).
          if (parsed.data.leagueId !== leagueId) return;
          send('job.state', JSON.stringify(parsed.data));
        },
        onError: (error) => {
          deps.logger.warn('stream listener connection lost', { leagueId, error });
          close();
        },
      });
    } catch (error) {
      deps.logger.warn('stream listener failed', { leagueId, error });
      throw new HttpError(503, 'streaming is unavailable: the listener connection failed');
    }

    // The reply is ours from here: the socket stays open until the client
    // disconnects or the listener dies, and every event is written straight
    // to it as it happens.
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // §14: a buffering proxy defeats the stream; ask it not to.
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');

    heartbeat = setInterval(() => {
      send('heartbeat', JSON.stringify({ at: new Date().toISOString() }));
    }, heartbeatMs);
    // The server outlives any one stream; the timer must not hold it open.
    heartbeat.unref();

    // A write to a socket that died between events must not crash the
    // process: the error only ends this stream.
    raw.on('error', close);
    request.raw.on('close', close);

    send('open', JSON.stringify({ leagueId, at: new Date().toISOString() }));
  });
}
