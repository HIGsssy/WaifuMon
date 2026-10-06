-- ── combat_enemies ────────────────────────────────────────────────────────
-- The central Enemy Catalogue. Enemies were file content only
-- (content/combat/enemies.json); they are now rows, authored in Portal Admin
-- and referenced by key from dungeon zones, Combat Trials and anything later.
--
-- The JSON file stays the shipped default and is seeded at startup exactly
-- like reward tables and dungeon zones: `content_hash` is the hash of the
-- row's portable definition, `seed_hash` the hash of the shipped enemy last
-- seeded into it (null for an enemy created in the Portal). Equal hashes
-- mean "untouched since shipped" and let a Git change through; different
-- hashes mean an admin edited the row, and the seed leaves it alone.
--
-- This migration creates the table EMPTY on purpose: the shipped enemies
-- live in a JSON file a migration cannot read, so the first startup after it
-- seeds them. Nothing reads enemies before that seed has run.
--
-- `artwork_path` / `sprite_artwork_path` are shipped files under assets/;
-- `artwork_asset_id` / `sprite_asset_id` are managed uploads and win over
-- them. Managed ids are local to one environment, so they are NOT part of
-- `content_hash`: attaching artwork does not turn a shipped enemy into an
-- edited one.
CREATE TABLE IF NOT EXISTS "combat_enemies" (
	"enemy_key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL DEFAULT '',
	"enabled" boolean NOT NULL,
	"attack" integer NOT NULL,
	"defense" integer NOT NULL,
	"hp" integer NOT NULL,
	"tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"artwork_path" text,
	"sprite_artwork_path" text,
	"artwork_asset_id" uuid REFERENCES "artwork_assets"("id"),
	"sprite_asset_id" uuid REFERENCES "artwork_assets"("id"),
	"sprite_placement" jsonb,
	"revision" integer NOT NULL DEFAULT 1,
	"content_hash" text NOT NULL,
	"seed_hash" text,
	"position" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "combat_enemies_key_check" CHECK ("enemy_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "combat_enemies_revision_check" CHECK ("revision" >= 1),
	CONSTRAINT "combat_enemies_attack_check" CHECK ("attack" >= 1),
	CONSTRAINT "combat_enemies_defense_check" CHECK ("defense" >= 0),
	CONSTRAINT "combat_enemies_hp_check" CHECK ("hp" >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_enemies_position_idx"
	ON "combat_enemies" USING btree ("position", "enemy_key");--> statement-breakpoint
-- ── combat_enemy_artwork (legacy overlay) ─────────────────────────────────
-- Managed enemy artwork used to live here, one row per enemy key, beside the
-- file-authored enemy. The enemy row now owns those references. Nothing is
-- deleted: the startup step that follows the first enemy seed copies each
-- row into `combat_enemies` and stamps `merged_at`, so the copy happens once
-- and the original stays readable. No code writes this table afterwards.
ALTER TABLE "combat_enemy_artwork" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;
