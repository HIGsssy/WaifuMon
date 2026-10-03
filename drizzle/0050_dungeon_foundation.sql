-- Dungeon generation + Admin authoring foundation: dungeon zones, the
-- progression currency, and generated run snapshots.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0049: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0049's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── dungeon_zones ─────────────────────────────────────────────────────────
--
-- One row per zone, one JSONB document per row, exactly like `reward_tables`
-- (0047): `definition` is the zone as `content/dungeons/zones.json` writes it
-- — generation rules, pools, depth bands and reward settings — validated by
-- the zone schema on every write and read. One document rather than pool /
-- entry rows because entry order is part of every deterministic draw, a save
-- replaces the whole zone, and nothing queries inside one.
--
--   zone_key      the stable key. Never renamed: runs record it by value.
--   revision      optimistic concurrency: a save names the revision it
--                 edited, and loses with a 409 if someone saved first.
--   content_hash  semantic hash of `definition` as it stands.
--   seed_hash     hash of the shipped zone last seeded into the row; NULL for
--                 a zone created in the Portal. The startup seed updates a row
--                 from Git only while `content_hash = seed_hash`.
--   position      list / export order (`definition.order`, mirrored).
--
-- Created empty: the startup seed fills it from the shipped file.
--
-- ── progression_currencies ────────────────────────────────────────────────
--
-- Display metadata for a progression resource, keyed by a stable internal
-- key. The key is what reward configuration and balances reference; the names
-- are what an admin may rename at will. Seeded here with the one currency the
-- dungeon pays — `ascension_currency` — under working display names.
--
-- ── player_progression_balances / progression_currency_ledger ─────────────
--
-- The balance, and an append-only record of every change to it. Keyed rows
-- rather than another `player_currencies` column because the currency itself
-- is a row with editable metadata; and deliberately not an inventory item, so
-- no shop, sale, gift or consumable flow can reach it. A balance row is
-- created by the first grant — a player with none holds zero — so there is no
-- backfill. The `>= 0` CHECK backs up the conditional spend
-- (`WHERE balance >= n`) in `progressionCurrencyService`.
--
-- `request_key` makes a grant or spend idempotent when the caller has one
-- (unique per player and currency); NULL for a change that has none.
--
-- ── dungeon_runs ──────────────────────────────────────────────────────────
--
-- A generated run. `graph` is authoritative for the run from the moment it is
-- written; `seed` and `zone_snapshot` (the zone definition and every piece of
-- content the graph selected, as they stood) exist so the graph can be
-- reproduced and so an Admin edit never reaches a run already generated.
--
-- The partial unique index is the "one active run per player" rule, enforced
-- here rather than in a UI.
--
-- The four progress columns are where run state will live once runs are
-- playable; this migration only initialises them (start node, nothing banked).
--
-- No existing data changes. Every statement is idempotent, so a re-run is a
-- no-op.

CREATE TABLE IF NOT EXISTS "dungeon_zones" (
	"zone_key" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer NOT NULL DEFAULT 1,
	"content_hash" text NOT NULL,
	"seed_hash" text,
	"position" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "dungeon_zones_key_check" CHECK ("zone_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "dungeon_zones_revision_check" CHECK ("revision" >= 1)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "progression_currencies" (
	"currency_key" text PRIMARY KEY NOT NULL,
	"singular_name" text NOT NULL,
	"plural_name" text NOT NULL,
	"description" text NOT NULL DEFAULT '',
	"icon" text,
	"enabled" boolean NOT NULL DEFAULT true,
	"revision" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "progression_currencies_key_check" CHECK ("currency_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "progression_currencies_revision_check" CHECK ("revision" >= 1)
);--> statement-breakpoint
INSERT INTO "progression_currencies" ("currency_key", "singular_name", "plural_name", "description", "icon", "updated_by")
	VALUES (
		'ascension_currency',
		'Ascension Token',
		'Ascension Tokens',
		'Earned in dungeons. Working name — rename it in Portal Admin.',
		NULL,
		'seed'
	)
	ON CONFLICT ("currency_key") DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_progression_balances" (
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"currency_key" text NOT NULL REFERENCES "progression_currencies"("currency_key"),
	"balance" integer NOT NULL DEFAULT 0,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "player_progression_balances_pk" PRIMARY KEY ("player_id", "currency_key"),
	CONSTRAINT "player_progression_balances_balance_check" CHECK ("balance" >= 0)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "progression_currency_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"currency_key" text NOT NULL REFERENCES "progression_currencies"("currency_key"),
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"source_ref" text,
	"request_key" text,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "progression_currency_ledger_delta_check" CHECK ("delta" <> 0),
	CONSTRAINT "progression_currency_ledger_after_check" CHECK ("balance_after" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "progression_currency_ledger_request_uq"
	ON "progression_currency_ledger" USING btree ("player_id", "currency_key", "request_key")
	WHERE request_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "progression_currency_ledger_player_idx"
	ON "progression_currency_ledger" USING btree ("player_id", "currency_key", "id" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dungeon_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"zone_key" text NOT NULL,
	"zone_revision" integer NOT NULL,
	"seed" bigint NOT NULL,
	"generator_version" integer NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"graph" jsonb NOT NULL,
	"zone_snapshot" jsonb NOT NULL,
	"current_node_id" text,
	"current_hp" integer,
	"unbanked_currency" integer NOT NULL DEFAULT 0,
	"secured_rewards" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"completed_at" timestamp with time zone,
	CONSTRAINT "dungeon_runs_status_check" CHECK ("status" in ('active','extracted','defeated','completed','abandoned')),
	CONSTRAINT "dungeon_runs_seed_check" CHECK ("seed" >= 0 and "seed" <= 4294967295),
	CONSTRAINT "dungeon_runs_unbanked_check" CHECK ("unbanked_currency" >= 0),
	CONSTRAINT "dungeon_runs_hp_check" CHECK ("current_hp" is null or "current_hp" >= 0),
	CONSTRAINT "dungeon_runs_completed_check" CHECK (("status" = 'active') = ("completed_at" is null))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dungeon_runs_one_active_uq"
	ON "dungeon_runs" USING btree ("player_id")
	WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_runs_player_idx"
	ON "dungeon_runs" USING btree ("player_id", "id" DESC);
