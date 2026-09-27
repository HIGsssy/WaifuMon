-- Load-test run log (Portal Admin → Load Testing).
--
-- Hand-written for the reason recorded in 0019-0021, 0035-0040: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0040's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- One row per finished run, written once. Additive only: no existing table is
-- touched. The table exists on every deployment and stays empty wherever
-- LOAD_TESTING_ENABLED is off — the flag gates behaviour, not schema.
CREATE TABLE IF NOT EXISTS "load_test_runs" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "run_key" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "profile" text NOT NULL,
  "card_mode" text,
  "concurrency" integer NOT NULL,
  "duration_seconds" integer NOT NULL,
  "elapsed_seconds" integer NOT NULL,
  "seed" integer NOT NULL,
  "label" text,
  "host_label" text,
  "operator_discord_id" text,
  "host_info" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metrics_start" jsonb,
  "metrics_end" jsonb,
  "error" text,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  CONSTRAINT "load_test_runs_status_check" CHECK ("status" in ('completed','stopped','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "load_test_runs_started_idx" ON "load_test_runs" ("started_at");
