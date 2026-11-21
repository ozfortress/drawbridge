import { canCreateLeague } from '@drawbridge/authz';
import type { Config } from '@drawbridge/config';
import type { Db } from '@drawbridge/db';
import {
  createLeague,
  ensureGuild,
  type LeagueRoleRow,
  type LeagueRow,
  listLeagueRoles,
  listLeaguesForActor,
  updateLeague,
} from '@drawbridge/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, useSecureCookies } from '../auth/session.js';
import { HttpError } from '../http/errors.js';
import {
  audit,
  parseBody,
  requireLeagueCapability,
  requireTier,
  translateDbError,
} from '../http/helpers.js';

const snowflake = z.string().regex(/^\d{15,20}$/, 'must be a Discord snowflake');

const guildBody = z.object({
  discordGuildId: snowflake,
  name: z.string().max(100).optional(),
});

const createBody = z.object({
  guildId: snowflake,
  citadelLeagueId: z.number().int().positive(),
  name: z.string().min(1).max(100),
  shortcode: z.string().min(1).max(20),
  timezone: z.string().min(1).max(64).optional(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    shortcode: z.string().min(1).max(20).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'nothing to change',
  });

function serialiseLeague(league: LeagueRow): Record<string, unknown> {
  return {
    id: league.id,
    guildId: league.guildId,
    citadelLeagueId: league.citadelLeagueId,
    name: league.name,
    shortcode: league.shortcode,
    status: league.status,
    timezone: league.timezone,
    createdAt: league.createdAt.toISOString(),
    endedAt: league.endedAt?.toISOString() ?? null,
  };
}

function serialiseRole(role: LeagueRoleRow): Record<string, unknown> {
  return { id: role.id, rank: role.rank, name: role.name, capabilities: role.capabilities };
}

export interface LeagueRouteDeps {
  config: Config;
  db: Db;
}

export function registerLeagueRoutes(app: FastifyInstance, deps: LeagueRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);

  app.post('/api/v1/guilds', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const body = parseBody(guildBody, request);
    await ensureGuild(deps.db, body.discordGuildId, body.name ?? '');
    await audit(deps.db, request, auth, {
      action: 'guild.register',
      targetType: 'guild',
      targetId: body.discordGuildId,
      guildId: body.discordGuildId,
    });
    return reply.status(201).send({ ok: true });
  });

  app.get('/api/v1/leagues', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const leagues = await listLeaguesForActor(deps.db, {
      userId: auth.userId,
      discordId: auth.discordId,
      tier: auth.tier,
    });
    return reply.send({ leagues: leagues.map(serialiseLeague) });
  });

  app.post('/api/v1/leagues', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    if (!canCreateLeague(auth.tier)) throw new HttpError(403, 'Guests cannot create leagues');
    const body = parseBody(createBody, request);

    try {
      const league = await createLeague(deps.db, {
        guildId: body.guildId,
        citadelLeagueId: body.citadelLeagueId,
        name: body.name,
        shortcode: body.shortcode,
        ...(body.timezone ? { timezone: body.timezone } : {}),
        createdByUserId: auth.userId,
        createdByDiscordId: auth.discordId,
        requestId: String(request.id),
      });
      return reply.status(201).send({ league: serialiseLeague(league) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'That Citadel league is already imported into this server');
      }
      translateDbError(error);
    }
  });

  app.get('/api/v1/leagues/:leagueId', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    await requireLeagueCapability(deps.db, request, auth, 'league.read');
    const context = request.leagueContext!;
    const roles = await listLeagueRoles(deps.db, context.league.id);
    return reply.send({
      league: serialiseLeague(context.league),
      access: {
        tier: context.access.tier,
        leagueRank: context.access.leagueRank,
        capabilities: [...context.access.capabilities].sort(),
      },
      roles: roles.map(serialiseRole),
    });
  });

  app.get('/api/v1/leagues/:leagueId/roles', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    await requireLeagueCapability(deps.db, request, auth, 'league.read');
    const roles = await listLeagueRoles(deps.db, request.leagueContext!.league.id);
    return reply.send({ roles: roles.map(serialiseRole) });
  });

  app.patch('/api/v1/leagues/:leagueId', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(
      deps.db,
      request,
      auth,
      'league.settings.write',
    );
    const body = parseBody(patchBody, request);
    const updated = await updateLeague(
      deps.db,
      leagueId,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.shortcode !== undefined ? { shortcode: body.shortcode } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      },
      { userId: auth.userId, discordId: auth.discordId },
      String(request.id),
    );
    return reply.send({ league: serialiseLeague(updated) });
  });
}
