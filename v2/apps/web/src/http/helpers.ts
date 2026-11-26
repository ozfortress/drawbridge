import {
  type Capability,
  can,
  type EffectiveAccess,
  type GlobalTier,
  isAtLeast,
} from '@drawbridge/authz';
import {
  type Actor,
  appendAudit,
  ConflictError,
  type Db,
  type LeagueRow,
  NotFoundError,
  resolveLeagueAccess,
} from '@drawbridge/db';
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { AuthContext } from '../auth/session.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';

export function translateDbError(error: unknown): never {
  if (error instanceof ConflictError) throw badRequest(error.message);
  if (error instanceof NotFoundError) throw notFound(error.message);
  throw error;
}

export function parseBody<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const result = schema.safeParse(request.body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? 'body';
    throw badRequest(`${path}: ${issue?.message ?? 'invalid body'}`);
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const result = schema.safeParse(request.query ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`${issue?.path.join('.') ?? 'query'}: ${issue?.message ?? 'invalid query'}`);
  }
  return result.data;
}

export function requireTier(auth: AuthContext, minimum: GlobalTier): void {
  if (!isAtLeast(auth.tier, minimum)) {
    throw forbidden(`Requires the ${minimum} tier or higher`);
  }
}

export async function requireLeagueCapability(
  db: Db,
  request: FastifyRequest,
  auth: AuthContext,
  capability: Capability,
): Promise<{ leagueId: string }> {
  const leagueId = (request.params as { leagueId?: string }).leagueId;
  if (!leagueId) throw badRequest('leagueId is required');

  const actor: Actor = { userId: auth.userId, discordId: auth.discordId, tier: auth.tier };
  const resolved = await resolveLeagueAccess(db, actor, leagueId);
  if (!resolved) throw notFound('League not found');
  if (!resolved.access || !can(resolved.access, capability)) {
    throw forbidden(`You need the ${capability} capability on this league`);
  }
  request.leagueContext = { league: resolved.league, access: resolved.access };
  return { leagueId };
}

/**
 * Resolves the actor's access to one league when the league is not in the
 * path (a job or preview id names it instead). 404 when the league does not
 * exist, 403 when the actor has no access to it at all - so a foreign id
 * never reveals more than that.
 */
export async function requireLeagueAccess(
  db: Db,
  auth: AuthContext,
  leagueId: string,
): Promise<{ league: LeagueRow; access: EffectiveAccess }> {
  const actor: Actor = { userId: auth.userId, discordId: auth.discordId, tier: auth.tier };
  const resolved = await resolveLeagueAccess(db, actor, leagueId);
  if (!resolved) throw notFound('League not found');
  if (!resolved.access) throw forbidden('You do not have access to that league');
  return { league: resolved.league, access: resolved.access };
}

/** {@link requireLeagueAccess} plus a capability check, naming the capability. */
export async function requireLeagueCapabilityOn(
  db: Db,
  auth: AuthContext,
  leagueId: string,
  capability: Capability,
): Promise<{ league: LeagueRow; access: EffectiveAccess }> {
  const { league, access } = await requireLeagueAccess(db, auth, leagueId);
  if (!can(access, capability)) {
    throw forbidden(`You need the ${capability} capability on this league`);
  }
  return { league, access };
}

export async function audit(
  db: Db,
  request: FastifyRequest,
  auth: AuthContext | undefined,
  entry: {
    action: string;
    targetType?: string;
    targetId?: string;
    guildId?: string | null;
    leagueId?: string | null;
    after?: Record<string, unknown> | null;
    before?: Record<string, unknown> | null;
  },
): Promise<void> {
  await appendAudit(db, {
    actorUserId: auth?.userId ?? null,
    actorDiscordId: auth?.discordId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    guildId: entry.guildId ?? null,
    leagueId: entry.leagueId ?? null,
    requestId: String(request.id),
    after: entry.after ?? null,
    before: entry.before ?? null,
  });
}
