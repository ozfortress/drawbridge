CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"guild_id" numeric(20, 0),
	"league_id" uuid,
	"job_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_discord_id" numeric(20, 0),
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"guild_id" numeric(20, 0),
	"league_id" uuid,
	"request_id" text,
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE TABLE "guild_role_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" numeric(20, 0) NOT NULL,
	"league_id" uuid,
	"purpose" text NOT NULL,
	"discord_role_id" numeric(20, 0) NOT NULL,
	"league_role_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_roles" (
	"guild_id" numeric(20, 0) NOT NULL,
	"discord_role_id" numeric(20, 0) NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"color" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_roles_guild_id_discord_role_id_pk" PRIMARY KEY("guild_id","discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"discord_guild_id" numeric(20, 0) PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"icon_hash" text,
	"status" text DEFAULT 'pending_claim' NOT NULL,
	"claimed_by_user_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guilds_status_check" CHECK ("guilds"."status" in ('pending_claim','active','suspended','left'))
);
--> statement-breakpoint
CREATE TABLE "league_citadel_keys" (
	"league_id" uuid PRIMARY KEY NOT NULL,
	"key_envelope" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "league_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" uuid,
	"discord_id" numeric(20, 0) NOT NULL,
	"league_role_id" uuid NOT NULL,
	"source" text DEFAULT 'panel' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_memberships_source_check" CHECK ("league_memberships"."source" in ('panel','invite','discord_role'))
);
--> statement-breakpoint
CREATE TABLE "league_role_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"guild_id" numeric(20, 0),
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_role_templates_scope_check" CHECK ("league_role_templates"."scope" in ('global','guild'))
);
--> statement-breakpoint
CREATE TABLE "league_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"name" text NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"template_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_roles_rank_check" CHECK ("league_roles"."rank" >= 0)
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" numeric(20, 0) NOT NULL,
	"citadel_league_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"shortcode" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"timezone" text DEFAULT 'Australia/Sydney' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "leagues_status_check" CHECK ("leagues"."status" in ('draft','active','ended','archived'))
);
--> statement-breakpoint
CREATE TABLE "managed_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"discord_channel_id" numeric(20, 0) NOT NULL,
	"kind" text DEFAULT 'extra' NOT NULL,
	"capture" boolean DEFAULT true NOT NULL,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_channels_kind_check" CHECK ("managed_channels"."kind" in ('team','match','division','extra'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_id" numeric(20, 0) NOT NULL,
	"global_role" text DEFAULT 'guest' NOT NULL,
	"league_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "user_invites_global_role_check" CHECK ("user_invites"."global_role" in ('root','admin','helper','user','guest'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_id" numeric(20, 0) NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"avatar_hash" text,
	"global_role" text DEFAULT 'guest' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_global_role_check" CHECK ("users"."global_role" in ('root','admin','helper','user','guest')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active','invited','disabled'))
);
--> statement-breakpoint
ALTER TABLE "guild_role_mappings" ADD CONSTRAINT "guild_role_mappings_guild_id_guilds_discord_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("discord_guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_role_mappings" ADD CONSTRAINT "guild_role_mappings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_role_mappings" ADD CONSTRAINT "guild_role_mappings_league_role_id_league_roles_id_fk" FOREIGN KEY ("league_role_id") REFERENCES "public"."league_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_roles" ADD CONSTRAINT "guild_roles_guild_id_guilds_discord_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("discord_guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_citadel_keys" ADD CONSTRAINT "league_citadel_keys_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_role_id_league_roles_id_fk" FOREIGN KEY ("league_role_id") REFERENCES "public"."league_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_roles" ADD CONSTRAINT "league_roles_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_roles" ADD CONSTRAINT "league_roles_template_id_league_role_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."league_role_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_guild_id_guilds_discord_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("discord_guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_channels" ADD CONSTRAINT "managed_channels_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_channels" ADD CONSTRAINT "managed_channels_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "alerts" USING btree ("opened_at") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "audit_log_league_at_idx" ON "audit_log" USING btree ("league_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_action_at_idx" ON "audit_log" USING btree ("action","at");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_role_mappings_guild_key" ON "guild_role_mappings" USING btree ("guild_id","purpose","discord_role_id") WHERE "guild_role_mappings"."league_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_role_mappings_league_key" ON "guild_role_mappings" USING btree ("guild_id","league_id","purpose","discord_role_id") WHERE "guild_role_mappings"."league_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_league_discord_key" ON "league_memberships" USING btree ("league_id","discord_id");--> statement-breakpoint
CREATE INDEX "league_memberships_user_idx" ON "league_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "league_role_templates_scope_name_idx" ON "league_role_templates" USING btree ("scope","name");--> statement-breakpoint
CREATE UNIQUE INDEX "league_roles_league_rank_key" ON "league_roles" USING btree ("league_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "league_roles_league_name_key" ON "league_roles" USING btree ("league_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_guild_citadel_key" ON "leagues" USING btree ("guild_id","citadel_league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_channels_league_channel_key" ON "managed_channels" USING btree ("league_id","discord_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_invites_discord_id_idx" ON "user_invites" USING btree ("discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invites_pending_key" ON "user_invites" USING btree ("discord_id") WHERE "user_invites"."consumed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_discord_id_key" ON "users" USING btree ("discord_id");