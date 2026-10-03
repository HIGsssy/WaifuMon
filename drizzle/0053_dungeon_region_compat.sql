-- Region availability compatibility for dungeon zones stored before
-- `availableRegions` existed.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0052.
--
-- A zone's `definition` is stored *parsed*, every default spelled out, so a
-- row written by any build that knows the field carries the key — even as an
-- empty list. A row with no `availableRegions` key at all was therefore last
-- written before the field existed, when a zone was effectively available
-- everywhere. Read by the current schema it would default to `[]`, which now
-- means "nowhere", and divergence protection (correctly) refuses to overwrite
-- an edited row from Git: the zone would silently disappear.
--
-- This migration only *marks* those rows. It cannot fill the field itself:
-- the compatibility value is the shipped zone's regions, or every enabled
-- region, and both live in content files the database cannot see. The startup
-- step `backfillDungeonZoneRegions` (dungeonZoneStore.ts) resolves each
-- `pending` row once and records what it did:
--
--   region_compat   NULL                  nothing to do / authored normally
--                   'pending'             predates the field; not yet resolved
--                   'shipped'             given the shipped zone's regions
--                   'all_enabled_regions' given every enabled region — an
--                                         admin should review it; cleared by
--                                         the next Portal save of the zone
--
-- One-time by construction: only rows that exist now and lack the key are
-- marked, a new row defaults to NULL, and nothing ever sets 'pending' again.
-- An empty list saved later is an explicit "nowhere" and is never refilled.
--
-- Ordering: this is before 0054 (managed artwork) on purpose — the two do not
-- depend on each other, and neither rewrites `definition`.

ALTER TABLE "dungeon_zones" ADD COLUMN IF NOT EXISTS "region_compat" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dungeon_zones" ADD CONSTRAINT "dungeon_zones_region_compat_check"
		CHECK ("region_compat" IS NULL OR "region_compat" IN ('pending','shipped','all_enabled_regions'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
UPDATE "dungeon_zones"
	SET "region_compat" = 'pending'
	WHERE "region_compat" IS NULL AND NOT ("definition" ? 'availableRegions');
