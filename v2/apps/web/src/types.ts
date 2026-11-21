import type { EffectiveAccess } from '@drawbridge/authz';
import type { LeagueRow } from '@drawbridge/db';
import type { AuthContext } from './auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    leagueContext?: {
      league: LeagueRow;
      access: EffectiveAccess;
    };
  }
}
