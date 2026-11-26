CREATE TABLE "discord_objects" (
	"guild_id" numeric(20, 0) NOT NULL,
	"discord_id" numeric(20, 0) NOT NULL,
	"kind" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by_job_id" uuid,
	"state" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	CONSTRAINT "discord_objects_guild_id_discord_id_pk" PRIMARY KEY("guild_id","discord_id"),
	CONSTRAINT "discord_objects_kind_check" CHECK ("discord_objects"."kind" in ('role','category','text_channel','message','webhook','other')),
	CONSTRAINT "discord_objects_owner_type_check" CHECK ("discord_objects"."owner_type" in ('guild','league','division','entry','match','job')),
	CONSTRAINT "discord_objects_state_check" CHECK ("discord_objects"."state" in ('live','missing','deleted','archived'))
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "job_events_level_check" CHECK ("job_events"."level" in ('info','warn','error'))
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"skippable" boolean DEFAULT false NOT NULL,
	"reversible" boolean DEFAULT false NOT NULL,
	"compensation" jsonb,
	"external_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_steps_status_check" CHECK ("job_steps"."status" in ('pending','running','done','skipped','failed','compensated'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"guild_id" numeric(20, 0) NOT NULL,
	"league_id" uuid,
	"lane" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"pause_reason" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"requested_by_user_id" uuid,
	"requested_by_discord_id" numeric(20, 0),
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_lane_check" CHECK ("jobs"."lane" in ('interactive','matches','setup','repair','maintenance')),
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" in ('queued','running','paused','awaiting_decision','completed','completed_with_skips','failed','cancelled','reverting','reverted')),
	CONSTRAINT "jobs_pause_reason_check" CHECK ("jobs"."pause_reason" in ('external','ratelimit','guild_unavailable'))
);
--> statement-breakpoint
ALTER TABLE "discord_objects" ADD CONSTRAINT "discord_objects_created_by_job_id_jobs_id_fk" FOREIGN KEY ("created_by_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_events_job_at_idx" ON "job_events" USING btree ("job_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_steps_job_seq_key" ON "job_steps" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_runnable_idx" ON "jobs" USING btree ("state","next_run_at") WHERE "jobs"."state" in ('queued','paused','reverting');--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_plan_key" ON "jobs" USING btree ("league_id","plan_hash") WHERE "jobs"."state" in ('queued','running','paused','awaiting_decision');