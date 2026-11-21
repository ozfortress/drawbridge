import type { Capability, EffectiveAccess, GlobalTier } from '@drawbridge/authz';
import {
  canManageTier,
  DEFAULT_LEAGUE_ROLES,
  mergeCapabilities,
  tierRank,
} from '@drawbridge/authz';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  auditLog,
  guilds,
  type LeagueMembershipRow,
  type LeagueRoleRow,
  type LeagueRow,
  leagueMemberships,
  leagueRoles,
  leagues,
  sessions,
  settingsKv,
  type UserRow,
  userInvites,
  users,
} from './schema.js';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export class ConflictError extends Error {
  override readonly name = 'ConflictError';
}

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

// ── Guilds and users ─────────────────────────────────────────

export async function ensureGuild(db: Db, discordGuildId: string, name = ''): Promise<void> {
  await db
    .insert(guilds)
    .values({ discordGuildId, name, status: 'pending_claim' })
    .onConflictDoNothing();
}

export async function ensureRootAdmins(db: Db, discordIds: readonly string[]): Promise<number> {
  let changed = 0;
  for (const discordId of discordIds) {
    const result = await db
      .insert(users)
      .values({
        discordId,
        globalRole: 'root',
        status: 'active',
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.discordId,
        set: { globalRole: 'root', status: 'active' },
      })
      .returning({ id: users.id });
    changed += result.length;
  }
  return changed;
}

export async function findUserByDiscordId(db: Db, discordId: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
  return rows[0];
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0];
}

/**
 * Records a Discord sign-in. Never changes the tier or reactivates a disabled
 * account; callers check `status` after this.
 */
export async function upsertDiscordUser(
  db: Db,
  input: { discordId: string; displayName: string; avatarHash: string | null },
): Promise<UserRow> {
  const now = new Date();
  const rows = await db
    .insert(users)
    .values({
      discordId: input.discordId,
      displayName: input.displayName,
      avatarHash: input.avatarHash,
      globalRole: 'guest',
      status: 'active',
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        displayName: input.displayName,
        avatarHash: input.avatarHash,
        lastLoginAt: now,
      },
    })
    .returning();
  return rows[0]!;
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  return db.select().from(users);
}

/** Applies tier changes with the root/admin rule. Throws ConflictError on a violation. */
export async function setUserTier(db: Db, userId: string, tier: GlobalTier): Promise<UserRow> {
  const target = await findUserById(db, userId);
  if (!target) throw new NotFoundError('user not found');
  const rows = await db
    .update(users)
    .set({ globalRole: tier })
    .where(eq(users.id, userId))
    .returning();
  return rows[0]!;
}

export async function setUserStatus(
  db: Db,
  userId: string,
  status: 'active' | 'invited' | 'disabled',
): Promise<UserRow> {
  const rows = await db.update(users).set({ status }).where(eq(users.id, userId)).returning();
  if (!rows[0]) throw new NotFoundError('user not found');
  return rows[0];
}

export function assertTierManagement(actorTier: GlobalTier, targetTier: GlobalTier): void {
  if (!canManageTier(actorTier, targetTier)) {
    throw new ConflictError(`a ${actorTier} may not manage a ${targetTier}`);
  }
}

// ── Invites ──────────────────────────────────────────────────

export async function createInvite(
  db: Db,
  input: {
    discordId: string;
    globalRole: GlobalTier;
    invitedBy: string;
    leagueGrants?: Array<{ leagueId: string; leagueRoleId: string }>;
  },
): Promise<void> {
  const existing = await db
    .select({ id: userInvites.id })
    .from(userInvites)
    .where(and(eq(userInvites.discordId, input.discordId), isNull(userInvites.consumedAt)))
    .limit(1);
  if (existing[0]) throw new ConflictError('an invite for that Discord user is already pending');

  await db.insert(userInvites).values({
    discordId: input.discordId,
    globalRole: input.globalRole,
    invitedBy: input.invitedBy,
    leagueGrants: input.leagueGrants ?? [],
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
}

/**
 * Consumes the newest live invite for a Discord user, applying its tier and
 * league grants. Returns the consumed invite, or null when there is none.
 */
export async function consumeInvite(db: Db, user: UserRow): Promise<void> {
  await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(userInvites)
      .where(
        and(
          eq(userInvites.discordId, user.discordId),
          isNull(userInvites.consumedAt),
          gt(userInvites.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(userInvites.createdAt))
      .limit(1);

    const invite = pending[0];
    if (!invite) return;

    await tx
      .update(userInvites)
      .set({ consumedAt: new Date() })
      .where(eq(userInvites.id, invite.id));

    // Only promote: an invite never demotes an existing tier.
    if (tierRank(invite.globalRole as GlobalTier) < tierRank(user.globalRole as GlobalTier)) {
      await tx.update(users).set({ globalRole: invite.globalRole }).where(eq(users.id, user.id));
    }

    for (const grant of invite.leagueGrants) {
      await tx
        .insert(leagueMemberships)
        .values({
          leagueId: grant.leagueId,
          userId: user.id,
          discordId: user.discordId,
          leagueRoleId: grant.leagueRoleId,
          source: 'invite',
          createdByUserId: invite.invitedBy,
        })
        .onConflictDoNothing();
    }

    await tx.insert(auditLog).values({
      actorUserId: invite.invitedBy,
      action: 'user.invite.consume',
      targetType: 'user',
      targetId: user.id,
      after: { globalRole: invite.globalRole, grants: invite.leagueGrants.length },
    });
  });
}

// ── Sessions ─────────────────────────────────────────────────

export async function createSession(
  db: Db,
  userId: string,
  tokenHash: string,
): Promise<{ expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MS);
  await db.insert(sessions).values({ userId, tokenHash, expiresAt });
  return { expiresAt };
}

export interface ValidSession {
  id: string;
  userId: string;
}

export async function findValidSession(
  db: Db,
  tokenHash: string,
): Promise<ValidSession | undefined> {
  const now = new Date();
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_IDLE_MS)),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (!session) return undefined;

  if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
  }
  return { id: session.id, userId: session.userId };
}

export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash));
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

// ── Audit ────────────────────────────────────────────────────

export interface AuditEntry {
  actorUserId?: string | null;
  actorDiscordId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  guildId?: string | null;
  leagueId?: string | null;
  requestId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export async function appendAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorDiscordId: entry.actorDiscordId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    guildId: entry.guildId ?? null,
    leagueId: entry.leagueId ?? null,
    requestId: entry.requestId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export async function listAudit(db: Db, limit = 100): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorDiscordId: auditLog.actorDiscordId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      leagueId: auditLog.leagueId,
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.at))
    .limit(Math.min(limit, 500));
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

// ── Leagues ──────────────────────────────────────────────────

export interface CreateLeagueInput {
  guildId: string;
  citadelLeagueId: number;
  name: string;
  shortcode: string;
  timezone?: string;
  createdByUserId: string;
  createdByDiscordId: string;
  requestId?: string;
}

export async function createLeague(db: Db, input: CreateLeagueInput): Promise<LeagueRow> {
  const guild = await db
    .select({ id: guilds.discordGuildId })
    .from(guilds)
    .where(eq(guilds.discordGuildId, input.guildId))
    .limit(1);
  if (!guild[0]) throw new NotFoundError(`guild ${input.guildId} is not registered`);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(leagues)
      .values({
        guildId: input.guildId,
        citadelLeagueId: input.citadelLeagueId,
        name: input.name,
        shortcode: input.shortcode,
        status: 'draft',
        ...(input.timezone ? { timezone: input.timezone } : {}),
        createdByUserId: input.createdByUserId,
      })
      .returning();
    const league = inserted[0];
    if (!league) throw new Error('league insert returned no row');

    const roles = await tx
      .insert(leagueRoles)
      .values(
        DEFAULT_LEAGUE_ROLES.map((role) => ({
          leagueId: league.id,
          rank: role.rank,
          name: role.name,
          capabilities: [...role.capabilities],
        })),
      )
      .returning();

    const topRole = roles.reduce((best, role) => (role.rank < best.rank ? role : best), roles[0]!);

    await tx.insert(leagueMemberships).values({
      leagueId: league.id,
      userId: input.createdByUserId,
      discordId: input.createdByDiscordId,
      leagueRoleId: topRole.id,
      source: 'panel',
      createdByUserId: input.createdByUserId,
    });

    await tx.insert(auditLog).values({
      actorUserId: input.createdByUserId,
      actorDiscordId: input.createdByDiscordId,
      action: 'league.create',
      targetType: 'league',
      targetId: league.id,
      guildId: input.guildId,
      leagueId: league.id,
      requestId: input.requestId ?? null,
      after: {
        citadelLeagueId: input.citadelLeagueId,
        name: input.name,
        shortcode: input.shortcode,
      },
    });

    return league;
  });
}

export async function getLeague(db: Db, leagueId: string): Promise<LeagueRow | undefined> {
  const rows = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  return rows[0];
}

export async function listLeagueRoles(db: Db, leagueId: string): Promise<LeagueRoleRow[]> {
  return db
    .select()
    .from(leagueRoles)
    .where(eq(leagueRoles.leagueId, leagueId))
    .orderBy(leagueRoles.rank);
}

export async function updateLeague(
  db: Db,
  leagueId: string,
  patch: { name?: string; shortcode?: string; timezone?: string },
  actor: { userId: string; discordId: string },
  requestId?: string,
): Promise<LeagueRow> {
  const before = await getLeague(db, leagueId);
  if (!before) throw new NotFoundError('league not found');
  const rows = await db.update(leagues).set(patch).where(eq(leagues.id, leagueId)).returning();
  await appendAudit(db, {
    actorUserId: actor.userId,
    actorDiscordId: actor.discordId,
    action: 'league.update',
    targetType: 'league',
    targetId: leagueId,
    guildId: before.guildId,
    leagueId,
    requestId: requestId ?? null,
    before: { name: before.name, shortcode: before.shortcode, timezone: before.timezone },
    after: patch as Record<string, unknown>,
  });
  return rows[0]!;
}

export interface Actor {
  userId: string;
  discordId: string;
  tier: GlobalTier;
}

export async function getMembership(
  db: Db,
  leagueId: string,
  discordId: string,
): Promise<LeagueMembershipRow | undefined> {
  const rows = await db
    .select()
    .from(leagueMemberships)
    .where(
      and(eq(leagueMemberships.leagueId, leagueId), eq(leagueMemberships.discordId, discordId)),
    )
    .limit(1);
  return rows[0];
}

export async function listLeaguesForActor(db: Db, actor: Actor): Promise<LeagueRow[]> {
  if (actor.tier === 'root' || actor.tier === 'admin' || actor.tier === 'helper') {
    return db.select().from(leagues).orderBy(desc(leagues.createdAt));
  }
  const created = await db.select().from(leagues).where(eq(leagues.createdByUserId, actor.userId));
  const member = await db
    .select({ league: leagues })
    .from(leagues)
    .innerJoin(leagueMemberships, eq(leagueMemberships.leagueId, leagues.id))
    .where(eq(leagueMemberships.discordId, actor.discordId));
  const byId = new Map<string, LeagueRow>();
  for (const league of created) byId.set(league.id, league);
  for (const row of member) byId.set(row.league.id, row.league);
  return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Effective access to one league: the union of the global tier's capabilities
 * and the member's league role. Root and admin bypass membership; helpers get
 * their league-wide set; everyone else needs a membership.
 */
export async function resolveLeagueAccess(
  db: Db,
  actor: Actor,
  leagueId: string,
): Promise<{ league: LeagueRow; access: EffectiveAccess | null } | null> {
  const league = await getLeague(db, leagueId);
  if (!league) return null;

  if (actor.tier === 'root' || actor.tier === 'admin') {
    return {
      league,
      access: { tier: actor.tier, leagueRank: 0, capabilities: mergeCapabilities(actor.tier, []) },
    };
  }
  if (actor.tier === 'helper') {
    return {
      league,
      access: {
        tier: actor.tier,
        leagueRank: null,
        capabilities: mergeCapabilities(actor.tier, []),
      },
    };
  }

  const membership = await getMembership(db, leagueId, actor.discordId);
  if (!membership) return { league, access: null };

  const roleRows = await db
    .select()
    .from(leagueRoles)
    .where(eq(leagueRoles.id, membership.leagueRoleId))
    .limit(1);
  const role = roleRows[0];
  if (!role) return { league, access: null };

  return {
    league,
    access: {
      tier: actor.tier,
      leagueRank: role.rank,
      capabilities: mergeCapabilities(actor.tier, role.capabilities as Capability[]),
    },
  };
}

// ── Settings ─────────────────────────────────────────────────

export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const rows = await db.select().from(settingsKv).where(eq(settingsKv.key, key)).limit(1);
  return rows[0]?.value as T | undefined;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(settingsKv)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsKv.key, set: { value, updatedAt: new Date() } });
}
