import type { Config } from '@drawbridge/config';
import type { Db } from '@drawbridge/db';
import { listAudit } from '@drawbridge/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, useSecureCookies } from '../auth/session.js';
import { parseQuery, requireTier } from '../http/helpers.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface AuditRouteDeps {
  config: Config;
  db: Db;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);

  app.get('/api/v1/audit', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const { limit } = parseQuery(query, request);
    const entries = await listAudit(deps.db, limit);
    return reply.send({ entries });
  });
}
