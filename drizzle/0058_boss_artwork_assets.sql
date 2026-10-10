-- ── boss artwork as managed assets ────────────────────────────────────────
-- Boss artwork was a shipped file only (`boss_definitions.artwork`, a path
-- under assets/). An admin can now upload it through Portal Admin → Boss
-- Management: the image is a managed artwork asset (`artwork_assets`,
-- migration 0054) in the new `boss_art` category, stored in the managed
-- artwork volume, and the boss names it by id.
--
-- CONVERGENCE WITH PRODUCTION. Assteroid ships this same schema as its own
-- `0046_boss_artwork_assets` (when 1819640000000): the artwork tables of 0054
-- plus the statements below. That file is NOT this branch's 0046 — equal
-- numbers do not mean equal migrations. When the branches merge, keep both
-- histories and every `when` as they are and order the journal by `when`;
-- every statement here is idempotent so that it is a no-op on a database
-- that already ran the Assteroid file. docs/boss-management.md, "Migration
-- history: two lines that must converge".
--
-- Nothing existing moves. `artwork` keeps working exactly as before and is
-- the fallback: the managed asset wins only while it is set and active.
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
