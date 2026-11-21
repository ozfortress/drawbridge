/**
 * P1 schema: identity and access, guilds, leagues, league roles, managed
 * channels, audit and settings. Later phases add their own tables and
 * migrations (jobs in P3, tournament structure in P4, capture in P6, ...).
 *
 * Conventions (plan 03):
 *  - Internal ids are uuid; Discord and Citadel ids are numeric(20,0) exposed
 *    as strings, never JavaScript numbers.
 *  - Timestamps are timestamptz in UTC.
 *  - Enumerations are text with CHECK constraints.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const snowflake = (name: string) => numeric(name, { precision: 20, scale: 0 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discordId: snowflake('discord_id').notNull(),
    displayName: text('display_name').notNull().default(''),
    avatarHash: text('avatar_hash'),
    globalRole: text('global_role').notNull().default('guest'),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by'),
    createdAt: createdAt(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_discord_id_key').on(table.discordId),
    check(
      'users_global_role_check',
      sql`${table.globalRole} in ('root','admin','helper','user','guest')`,
    ),
    check('users_status_check', sql`${table.status} in ('active','invited','disabled')`),
  ],
);

export const userInvites = pgTable(
  'user_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discordId: snowflake('discord_id').notNull(),
    globalRole: text('global_role').notNull().default('guest'),
    leagueGrants: jsonb('league_grants')
      .$type<Array<{ leagueId: string; leagueRoleId: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    invitedBy: uuid('invited_by'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('user_invites_discord_id_idx').on(table.discordId),
    uniqueIndex('user_invites_pending_key')
      .on(table.discordId)
      .where(sql`${table.consumedAt} is null`),
    check(
      'user_invites_global_role_check',
      sql`${table.globalRole} in ('root','admin','helper','user','guest')`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorDiscordId: snowflake('actor_discord_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    guildId: snowflake('guild_id'),
    leagueId: uuid('league_id'),
    requestId: text('request_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index('audit_log_league_at_idx').on(table.leagueId, table.at),
    index('audit_log_action_at_idx').on(table.action, table.at),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull().default('warning'),
    guildId: snowflake('guild_id'),
    leagueId: uuid('league_id'),
    jobId: uuid('job_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('alerts_open_idx').on(table.openedAt).where(sql`${table.resolvedAt} is null`)],
);

export const guilds = pgTable(
  'guilds',
  {
    discordGuildId: snowflake('discord_guild_id').primaryKey(),
    name: text('name').notNull().default(''),
    iconHash: text('icon_hash'),
    status: text('status').notNull().default('pending_claim'),
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'guilds_status_check',
      sql`${table.status} in ('pending_claim','active','suspended','left')`,
    ),
  ],
);

export const leagueRoleTemplates = pgTable(
  'league_role_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull().default('global'),
    guildId: snowflake('guild_id'),
    name: text('name').notNull(),
    rank: integer('rank').notNull(),
    capabilities: text('capabilities')
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (table) => [
    index('league_role_templates_scope_name_idx').on(table.scope, table.name),
    check('league_role_templates_scope_check', sql`${table.scope} in ('global','guild')`),
  ],
);

export const leagues = pgTable(
  'leagues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: snowflake('guild_id')
      .notNull()
      .references(() => guilds.discordGuildId, { onDelete: 'cascade' }),
    citadelLeagueId: integer('citadel_league_id').notNull(),
    name: text('name').notNull().default(''),
    shortcode: text('shortcode').notNull().default(''),
    status: text('status').notNull().default('draft'),
    timezone: text('timezone').notNull().default('Australia/Sydney'),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('leagues_guild_citadel_key').on(table.guildId, table.citadelLeagueId),
    check('leagues_status_check', sql`${table.status} in ('draft','active','ended','archived')`),
  ],
);

export const leagueCitadelKeys = pgTable('league_citadel_keys', {
  leagueId: uuid('league_id')
    .primaryKey()
    .references(() => leagues.id, { onDelete: 'cascade' }),
  keyEnvelope: text('key_envelope').notNull(),
  label: text('label').notNull().default(''),
  createdAt: createdAt(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const leagueRoles = pgTable(
  'league_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    name: text('name').notNull(),
    capabilities: text('capabilities')
      .array()
      .$type<string[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    templateId: uuid('template_id').references(() => leagueRoleTemplates.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('league_roles_league_rank_key').on(table.leagueId, table.rank),
    uniqueIndex('league_roles_league_name_key').on(table.leagueId, table.name),
    check('league_roles_rank_check', sql`${table.rank} >= 0`),
  ],
);

export const leagueMemberships = pgTable(
  'league_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    discordId: snowflake('discord_id').notNull(),
    leagueRoleId: uuid('league_role_id')
      .notNull()
      .references(() => leagueRoles.id, { onDelete: 'restrict' }),
    source: text('source').notNull().default('panel'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('league_memberships_league_discord_key').on(table.leagueId, table.discordId),
    index('league_memberships_user_idx').on(table.userId),
    check(
      'league_memberships_source_check',
      sql`${table.source} in ('panel','invite','discord_role')`,
    ),
  ],
);

export const managedChannels = pgTable(
  'managed_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: uuid('league_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'cascade' }),
    discordChannelId: snowflake('discord_channel_id').notNull(),
    kind: text('kind').notNull().default('extra'),
    capture: boolean('capture').notNull().default(true),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('managed_channels_league_channel_key').on(table.leagueId, table.discordChannelId),
    check('managed_channels_kind_check', sql`${table.kind} in ('team','match','division','extra')`),
  ],
);

export const guildRoles = pgTable(
  'guild_roles',
  {
    guildId: snowflake('guild_id')
      .notNull()
      .references(() => guilds.discordGuildId, { onDelete: 'cascade' }),
    discordRoleId: snowflake('discord_role_id').notNull(),
    name: text('name').notNull().default(''),
    position: integer('position').notNull().default(0),
    managed: boolean('managed').notNull().default(false),
    color: integer('color').notNull().default(0),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.discordRoleId] })],
);

export const guildRoleMappings = pgTable(
  'guild_role_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: snowflake('guild_id')
      .notNull()
      .references(() => guilds.discordGuildId, { onDelete: 'cascade' }),
    leagueId: uuid('league_id').references(() => leagues.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    discordRoleId: snowflake('discord_role_id').notNull(),
    leagueRoleId: uuid('league_role_id').references(() => leagueRoles.id, {
      onDelete: 'cascade',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('guild_role_mappings_guild_key')
      .on(table.guildId, table.purpose, table.discordRoleId)
      .where(sql`${table.leagueId} is null`),
    uniqueIndex('guild_role_mappings_league_key')
      .on(table.guildId, table.leagueId, table.purpose, table.discordRoleId)
      .where(sql`${table.leagueId} is not null`),
  ],
);

export const settingsKv = pgTable('settings_kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInviteRow = typeof userInvites.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type LeagueRow = typeof leagues.$inferSelect;
export type LeagueRoleRow = typeof leagueRoles.$inferSelect;
export type LeagueMembershipRow = typeof leagueMemberships.$inferSelect;
export type GuildRow = typeof guilds.$inferSelect;
