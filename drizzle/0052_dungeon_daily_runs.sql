-- Daily Delve runs: a shared, configurable cap on how many dungeon runs a
-- player may start per game day, and the per-day usage it is counted from.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0051: the
-- drizzle-kit snapshots stop at 0004. The journal `when` is above 0051's.
--
-- ── dungeon_settings ──────────────────────────────────────────────────────
--
-- One row (`id = 1`) of Delve-wide settings, edited in Portal Admin. The limit
-- is a property of Delve as a whole — never of a zone — so every zone draws on
-- the same allowance.
--
--   daily_run_limit  runs a player may START per game day. 0 closes Delve to
--                    new runs (an active run can still be played out).
--
-- ── dungeon_daily_usage ───────────────────────────────────────────────────
--
-- One row per player per game day they started a run on. `period_key` is the
-- calendar date in `DAILY_TIMEZONE` — the same day the daily claim keys on.
-- Usage is *stored*, never refilled: what a player has left is
--
--   daily_run_limit − runs_started (for today's period_key)
--
-- so a new day has no row and therefore a full allowance, with no scheduled
-- job. The row is written in the transaction that creates the run, so a start
-- that fails consumes nothing. Independent of Energy.
--
-- A later bonus-attempt system layers on without reshaping this: grants live
-- in their own table (or a `bonus_runs` column here) and add to the limit for
-- the period; `runs_started` keeps meaning exactly what it means now.
--
-- No existing data changes. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS "dungeon_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"daily_run_limit" integer NOT NULL DEFAULT 3,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "dungeon_settings_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "dungeon_settings_daily_run_limit_check" CHECK ("daily_run_limit" >= 0 and "daily_run_limit" <= 50)
);--> statement-breakpoint
INSERT INTO "dungeon_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dungeon_daily_usage" (
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"period_key" date NOT NULL,
	"runs_started" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "dungeon_daily_usage_pk" PRIMARY KEY ("player_id", "period_key"),
	CONSTRAINT "dungeon_daily_usage_runs_started_check" CHECK ("runs_started" >= 0)
);
