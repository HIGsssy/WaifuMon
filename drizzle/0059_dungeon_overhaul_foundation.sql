-- ── Dungeon overhaul, Phase 1A: revisioned content and cursor-driven runs ──
-- The Delve prototype stored a dungeon as one mutable `dungeon_zones` row and
-- a run as a copy of that zone plus one resolution per node. This migration
-- replaces both:
--
--   dungeon_definitions     one row per dungeon: its mutable draft, the
--                           editor layout, and the published-revision pointer
--   dungeon_revisions       immutable published revisions
--   dungeon_runs            rebuilt: a revision reference, a step counter and
--                           a cursor instead of a graph copy and node states
--   dungeon_run_events      rebuilt: keyed by step, room and action
--   dungeon_content_events  append-only authoring audit trail
--
-- and adds two nullable provenance columns to `player_waifus` for the later
-- phase that grants a Waifumon directly (nothing writes them yet).
--
-- JOURNAL ORDER. Drizzle's migrator applies a migration only when its journal
-- `when` is greater than the newest one already applied — the filename number
-- is not consulted. This entry's `when` (1820872800000) follows 0058's
-- (1820786400000), the newest on this branch, so it runs last everywhere.
-- This migration is NOT to be backported to another branch: it depends on
-- Delve's 0050–0058 and nothing outside Delve needs it.
--
-- PROTOTYPE DATA. No compatibility is kept, and the cleanup is limited to the
-- three prototype dungeon tables:
--
--   1. every prototype run still active is settled as an extraction — its
--      unbanked progression currency is banked in full, through the ledger,
--      under the request key the prototype itself would have used — and
--      closed as `extracted`. Nobody loses currency to the cutover;
--   2. `dungeon_zones`, `dungeon_runs` and `dungeon_run_events` are renamed
--      aside with a `_prototype` suffix. Nothing reads them again; they are
--      kept so the data can be inspected, and a later cleanup migration drops
--      them.
--
-- Untouched: `dungeon_settings`, `dungeon_daily_usage`, the progression
-- currency tables, every artwork table and every file under assets/.
--
-- Each step is guarded so the migration is a no-op on a database it has
-- already been applied to.

-- 1. Settle prototype runs that are still active.
DO $$
BEGIN
	IF to_regclass('public.dungeon_runs') IS NOT NULL
		AND EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'dungeon_runs' AND column_name = 'zone_snapshot') THEN

		INSERT INTO "player_progression_balances" ("player_id", "currency_key", "balance")
		SELECT r."player_id", c."currency_key", r."unbanked_currency"
		FROM "dungeon_runs" r
		JOIN "progression_currencies" c
			ON c."currency_key" = r."zone_snapshot" #>> '{zone,rewards,currencyKey}'
		WHERE r."status" = 'active' AND r."unbanked_currency" > 0
		ON CONFLICT ("player_id", "currency_key")
			DO UPDATE SET "balance" = "player_progression_balances"."balance" + EXCLUDED."balance", "updated_at" = now();

		INSERT INTO "progression_currency_ledger"
			("player_id", "currency_key", "delta", "balance_after", "reason", "source_ref", "request_key", "metadata")
		SELECT r."player_id", c."currency_key", r."unbanked_currency", b."balance",
			'dungeon_extraction', 'dungeon_run:' || r."id", 'dungeon_run:' || r."id" || ':settlement',
			jsonb_build_object('migration', '0059_dungeon_overhaul_foundation', 'zoneKey', r."zone_key")
		FROM "dungeon_runs" r
		JOIN "progression_currencies" c
			ON c."currency_key" = r."zone_snapshot" #>> '{zone,rewards,currencyKey}'
		JOIN "player_progression_balances" b
			ON b."player_id" = r."player_id" AND b."currency_key" = c."currency_key"
		WHERE r."status" = 'active' AND r."unbanked_currency" > 0
		ON CONFLICT DO NOTHING;

		UPDATE "dungeon_runs"
		SET "status" = 'extracted',
			"completed_at" = now(),
			"updated_at" = now(),
			"settlement" = jsonb_build_object(
				'outcome', 'extracted',
				'cause', 'prototype_retired',
				'earned', "unbanked_currency",
				'banked', "unbanked_currency",
				'lost', 0,
				'migration', '0059_dungeon_overhaul_foundation'),
			"unbanked_currency" = 0
		WHERE "status" = 'active';
	END IF;
END $$;--> statement-breakpoint

-- 2. Move the prototype tables aside. Index and sequence names are unique per
--    schema, so they move too or the new tables below could not reuse them.
DO $$
BEGIN
	IF to_regclass('public.dungeon_runs') IS NOT NULL
		AND EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'dungeon_runs' AND column_name = 'zone_snapshot') THEN
		ALTER TABLE "dungeon_run_events" RENAME TO "dungeon_run_events_prototype";
		ALTER INDEX IF EXISTS "dungeon_run_events_pkey" RENAME TO "dungeon_run_events_prototype_pkey";
		ALTER INDEX IF EXISTS "dungeon_run_events_run_idx" RENAME TO "dungeon_run_events_prototype_run_idx";
		ALTER SEQUENCE IF EXISTS "dungeon_run_events_id_seq" RENAME TO "dungeon_run_events_prototype_id_seq";
		ALTER TABLE "dungeon_runs" RENAME TO "dungeon_runs_prototype";
		ALTER INDEX IF EXISTS "dungeon_runs_pkey" RENAME TO "dungeon_runs_prototype_pkey";
		ALTER INDEX IF EXISTS "dungeon_runs_one_active_uq" RENAME TO "dungeon_runs_prototype_one_active_uq";
		ALTER INDEX IF EXISTS "dungeon_runs_player_idx" RENAME TO "dungeon_runs_prototype_player_idx";
		ALTER SEQUENCE IF EXISTS "dungeon_runs_id_seq" RENAME TO "dungeon_runs_prototype_id_seq";
	END IF;
	IF to_regclass('public.dungeon_zones') IS NOT NULL THEN
		ALTER TABLE "dungeon_zones" RENAME TO "dungeon_zones_prototype";
		ALTER INDEX IF EXISTS "dungeon_zones_pkey" RENAME TO "dungeon_zones_prototype_pkey";
	END IF;
END $$;--> statement-breakpoint

-- 3. Content: drafts, published revisions, audit.
CREATE TABLE IF NOT EXISTS "dungeon_definitions" (
	"dungeon_key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"draft" jsonb NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_hash" text NOT NULL,
	"published_revision_id" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "dungeon_definitions_key_check" CHECK ("dungeon_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "dungeon_definitions_draft_revision_check" CHECK ("draft_revision" >= 1)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dungeon_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"dungeon_key" text NOT NULL REFERENCES "dungeon_definitions"("dungeon_key"),
	"number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'editor' NOT NULL,
	"draft_revision" integer NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dungeon_revisions_number_check" CHECK ("number" >= 1),
	CONSTRAINT "dungeon_revisions_source_check" CHECK ("source" in ('editor','import'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dungeon_revisions_key_number_uq"
	ON "dungeon_revisions" USING btree ("dungeon_key", "number");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dungeon_definitions" ADD CONSTRAINT "dungeon_definitions_published_revision_fk"
		FOREIGN KEY ("published_revision_id") REFERENCES "dungeon_revisions"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- A published revision is immutable. The application never updates or deletes
-- one; this makes that a property of the database rather than of the code.
CREATE OR REPLACE FUNCTION "dungeon_revisions_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'dungeon_revisions rows are immutable (revision % of %)', OLD."number", OLD."dungeon_key"
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "dungeon_revisions_immutable_trg" ON "dungeon_revisions";--> statement-breakpoint
CREATE TRIGGER "dungeon_revisions_immutable_trg"
	BEFORE UPDATE OR DELETE ON "dungeon_revisions"
	FOR EACH ROW EXECUTE FUNCTION "dungeon_revisions_immutable"();--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "dungeon_content_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"dungeon_key" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dungeon_content_events_action_check"
		CHECK ("action" in ('created','draft_saved','published','rolled_back','enabled','disabled','exported','deleted'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_content_events_key_idx"
	ON "dungeon_content_events" USING btree ("dungeon_key", "id" DESC);--> statement-breakpoint

-- 4. Runs.
CREATE TABLE IF NOT EXISTS "dungeon_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"dungeon_key" text NOT NULL,
	"revision_id" bigint NOT NULL REFERENCES "dungeon_revisions"("id"),
	"seed" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"cursor" jsonb NOT NULL,
	"current_hp" integer NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"room_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unbanked_currency" integer DEFAULT 0 NOT NULL,
	"recent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secured_rewards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fighter" jsonb NOT NULL,
	"dependency_snapshot" jsonb NOT NULL,
	"settlement" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "dungeon_runs_status_check" CHECK ("status" in ('active','extracted','defeated','completed','abandoned')),
	CONSTRAINT "dungeon_runs_seed_check" CHECK ("seed" >= 0 and "seed" <= 4294967295),
	CONSTRAINT "dungeon_runs_step_check" CHECK ("step" >= 0),
	CONSTRAINT "dungeon_runs_unbanked_check" CHECK ("unbanked_currency" >= 0),
	CONSTRAINT "dungeon_runs_hp_check" CHECK ("current_hp" >= 0),
	CONSTRAINT "dungeon_runs_completed_check" CHECK (("status" = 'active') = ("completed_at" is null)),
	CONSTRAINT "dungeon_runs_settlement_check" CHECK ("status" <> 'active' or "settlement" is null)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dungeon_runs_one_active_uq"
	ON "dungeon_runs" USING btree ("player_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_runs_player_idx"
	ON "dungeon_runs" USING btree ("player_id", "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_runs_revision_idx"
	ON "dungeon_runs" USING btree ("revision_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dungeon_run_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"run_id" bigint NOT NULL REFERENCES "dungeon_runs"("id"),
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"step" integer NOT NULL,
	"type" text NOT NULL,
	"room_id" text,
	"action_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dungeon_run_events_type_check" CHECK ("type" in ('run_started','room_entered','action_skipped','action_declined','combat_wave_resolved','action_completed','action_failed','room_completed','room_retreated','connection_taken','extraction','defeat','completion','abandon','currency_banked','rewards_granted'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_run_events_run_idx"
	ON "dungeon_run_events" USING btree ("run_id", "id");--> statement-breakpoint

-- 5. Waifumon acquisition provenance (used from the phase that adds direct
--    recruitment; nullable and unwritten until then, so capture is unchanged).
ALTER TABLE "player_waifus" ADD COLUMN IF NOT EXISTS "acquired_via" text;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD COLUMN IF NOT EXISTS "grant_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_waifus_grant_key_uq"
	ON "player_waifus" USING btree ("grant_key") WHERE grant_key is not null;
