import { canManageTier, GLOBAL_TIERS, type GlobalTier } from '@drawbridge/authz';
import type { Config } from '@drawbridge/config';
import type { Db } from '@drawbridge/db';
import {
  createInvite,
  findUserById,
  listUsers,
  revokeAllSessions,
  setUserStatus,
  setUserTier,
  type UserRow,
} from '@drawbridge/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, useSecureCookies } from '../auth/session.js';
import { forbidden, notFound } from '../http/errors.js';
import { audit, parseBody, requireTier, translateDbError } from '../http/helpers.js';

const discordId = z.string().regex(/^\d{15,20}$/, 'must be a Discord snowflake');

const inviteBody = z.object({
  discordId,
  globalRole: z.enum(GLOBAL_TIERS),
  leagueGrants: z
    .array(z.object({ leagueId: z.uuid(), leagueRoleId: z.uuid() }))
    .max(20)
    .optional(),
});

const patchBody = z
  .object({
    globalRole: z.enum(GLOBAL_TIERS).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((value) => value.globalRole !== undefined || value.status !== undefined, {
    message: 'nothing to change',
  });

const revokeParams = z.object({ userId: z.uuid() });

function serialiseUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    discordId: user.discordId,
    displayName: user.displayName,
    globalRole: user.globalRole,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

export interface UserRouteDeps {
  config: Config;
  db: Db;
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);

  app.get('/api/v1/users', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const rows = await listUsers(deps.db);
    return reply.send({ users: rows.map(serialiseUser) });
  });

  app.post('/api/v1/users/invites', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const body = parseBody(inviteBody, request);

    // Only root may create root or admin invitations.
    if ((body.globalRole === 'root' || body.globalRole === 'admin') && auth.tier !== 'root') {
      throw forbidden('Only root may invite root or admin users');
    }

    try {
      await createInvite(deps.db, {
        discordId: body.discordId,
        globalRole: body.globalRole,
        invitedBy: auth.userId,
        leagueGrants: body.leagueGrants ?? [],
      });
    } catch (error) {
      translateDbError(error);
    }

    await audit(deps.db, request, auth, {
      action: 'user.invite',
      targetType: 'discord_user',
      targetId: body.discordId,
      after: { globalRole: body.globalRole, grants: body.leagueGrants?.length ?? 0 },
    });
    return reply.status(201).send({ ok: true });
  });

  app.patch('/api/v1/users/:userId', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const { userId } = revokeParams.parse(request.params);
    const body = parseBody(patchBody, request);

    const target = await findUserById(deps.db, userId);
    if (!target) throw notFound('User not found');
    const targetTier = target.globalRole as GlobalTier;

    // An admin never touches root or other admins.
    if (!canManageTier(auth.tier, targetTier)) {
      throw forbidden(`A ${auth.tier} may not manage a ${targetTier}`);
    }

    if (body.globalRole) {
      if (!canManageTier(auth.tier, body.globalRole)) {
        throw forbidden(`A ${auth.tier} may not promote anyone to ${body.globalRole}`);
      }
      await setUserTier(deps.db, userId, body.globalRole);
    }
    if (body.status) {
      await setUserStatus(deps.db, userId, body.status);
      if (body.status === 'disabled') await revokeAllSessions(deps.db, userId);
    }

    await audit(deps.db, request, auth, {
      action: 'user.update',
      targetType: 'user',
      targetId: userId,
      before: { globalRole: targetTier, status: target.status },
      after: {
        ...(body.globalRole ? { globalRole: body.globalRole } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });

    const updated = await findUserById(deps.db, userId);
    return reply.send({ user: updated ? serialiseUser(updated) : null });
  });

  app.post('/api/v1/users/:userId/revoke-sessions', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    requireTier(auth, 'admin');
    const { userId } = revokeParams.parse(request.params);
    const target = await findUserById(deps.db, userId);
    if (!target) throw notFound('User not found');
    if (!canManageTier(auth.tier, target.globalRole as GlobalTier)) {
      throw forbidden('You may not manage that user');
    }
    await revokeAllSessions(deps.db, userId);
    await audit(deps.db, request, auth, {
      action: 'user.sessions.revoke',
      targetType: 'user',
      targetId: userId,
    });
    return reply.status(204).send();
  });
}
