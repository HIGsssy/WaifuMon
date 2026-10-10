-- ── managed boss artwork (Assteroid backport) ─────────────────────────────
-- Boss artwork was a shipped file only (`boss_definitions.artwork`, a path
-- under assets/). An admin can now upload it through Portal Admin → Boss
-- Management: the image is a managed artwork asset stored in the managed
-- artwork volume (MANAGED_ASSETS_DIR), and the boss names it by id. Nothing
-- existing moves: `artwork` keeps working and is the fallback.
--
-- This is the production (Assteroid) form of two migrations on the Delve
-- line: the `artwork_assets` / `artwork_asset_events` tables of Delve's
-- `0054_artwork_assets` (WITHOUT its `combat_enemy_artwork` table, which
-- belongs to the Enemy/Dungeon work this branch does not carry), followed by
-- Delve's `0058_boss_artwork_assets` statement for statement.
--
-- WHY IT IS NUMBERED 0046 AND TIMESTAMPED WHERE IT IS. drizzle's migrator
-- applies a migration only when its journal `when` is greater than the newest
-- applied one. This entry's `when` (1819640000000) sits after this branch's
-- 0045_boss_definitions (1819620000000) and BEFORE Delve's first own
-- migration, its 0045 (1819663200000). So:
--   * a database on this branch applies it now;
--   * when Delve later merges, every Delve migration (0045…0058) still has a
--     greater `when` and still runs here; Delve's 0054 and 0058 then find
--     these tables, columns, constraint and index already present and do
--     nothing to them (every statement below and there is idempotent), while
--     0054 still creates `combat_enemy_artwork`;
--   * a database already on the Delve line (staging) is past this `when` and
--     skips this file — it has the same objects from 0054 + 0058.
-- The category CHECK already lists `boss_art` and every Delve category, i.e.
-- the constraint exactly as Delve's 0058 leaves it. Do not renumber or
-- re-timestamp this file, and do not copy Delve's 0054/0058 in beside it.
--
-- Every statement is idempotent.

CREATE TABLE IF NOT EXISTS "artwork_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"has_alpha" boolean NOT NULL DEFAULT false,
	"file_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"status" text NOT NULL DEFAULT 'active',
	"uploaded_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"replaced_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artwork_assets_category_check" CHECK ("category" in ('dungeon_zone','dungeon_background','enemy_sprite','enemy_art','event_art','npc_portrait','equipment_art','boss_art')),
	CONSTRAINT "artwork_assets_mime_check" CHECK ("mime_type" in ('image/png','image/webp','image/jpeg')),
	CONSTRAINT "artwork_assets_status_check" CHECK ("status" in ('active','disabled','deleted')),
	CONSTRAINT "artwork_assets_dimensions_check" CHECK ("width" >= 1 and "height" >= 1 and "file_size" >= 1),
	CONSTRAINT "artwork_assets_version_check" CHECK ("version" >= 1),
	CONSTRAINT "artwork_assets_deleted_check" CHECK (("status" = 'deleted') = ("deleted_at" is not null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artwork_assets_category_idx"
	ON "artwork_assets" USING btree ("category", "status", "updated_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artwork_asset_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "artwork_assets"("id"),
	"action" text NOT NULL,
	"actor" text,
	"old_hash" text,
	"new_hash" text,
	"details" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "artwork_asset_events_action_check" CHECK ("action" in ('upload','replace','update','disable','enable','delete','reference_added','reference_removed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artwork_asset_events_asset_idx"
	ON "artwork_asset_events" USING btree ("asset_id", "id" DESC);--> statement-breakpoint
ALTER TABLE "artwork_assets" DROP CONSTRAINT IF EXISTS "artwork_assets_category_check";--> statement-breakpoint
ALTER TABLE "artwork_assets" ADD CONSTRAINT "artwork_assets_category_check"
	CHECK ("category" in ('dungeon_zone','dungeon_background','enemy_sprite','enemy_art','event_art','npc_portrait','equipment_art','boss_art'));--> statement-breakpoint
ALTER TABLE "boss_definitions" ADD COLUMN IF NOT EXISTS "artwork_asset_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "boss_definitions" ADD CONSTRAINT "boss_definitions_artwork_asset_id_artwork_assets_id_fk"
		FOREIGN KEY ("artwork_asset_id") REFERENCES "artwork_assets"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boss_definitions_artwork_asset_idx"
	ON "boss_definitions" USING btree ("artwork_asset_id");--> statement-breakpoint
-- ── boss_encounters.boss_artwork_asset_id ─────────────────────────────────
-- The managed artwork the boss named when the encounter was drawn, frozen
-- beside `boss_artwork`. A logical reference with no foreign key: the image
-- behind it is read live, and an asset disabled or deleted afterwards makes
-- the encounter fall back to `boss_artwork`, then to text.
ALTER TABLE "boss_encounters" ADD COLUMN IF NOT EXISTS "boss_artwork_asset_id" uuid;
