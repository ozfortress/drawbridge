ALTER TABLE "previews" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_league_created_idx" ON "jobs" USING btree ("league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION "drawbridge_notify_job_state"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- One channel per league (02 §11); guild-scoped jobs are never streamed.
  IF NEW."league_id" IS NULL THEN
    RETURN NULL;
  END IF;
  -- Only state transitions notify (02 §5.3): an update that does not move
  -- the state (a lease re-arm, an attempt bump) stays silent.
  IF TG_OP = 'UPDATE' AND OLD."state" = NEW."state" THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'drawbridge_jobs_' || NEW."league_id"::text,
    json_build_object(
      'jobId', NEW."id",
      'leagueId', NEW."league_id",
      'state', NEW."state",
      'from', CASE WHEN TG_OP = 'UPDATE' THEN OLD."state" ELSE NULL END
    )::text
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "jobs_state_notify"
AFTER INSERT OR UPDATE OF "state" ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "drawbridge_notify_job_state"();
