-- Thirstlands — widen the region CHECK constraints for an unreleased region.
--
-- Hand-written, following this repository's convention since 0005: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline and re-emit tables that already exist. The journal
-- entry's `when` is set above 0019's, because the node-postgres migrator skips
-- any entry whose stamp is not greater than the last applied one.
--
-- This is the migration half of the trade 0019 wrote down: the region CHECKs
-- are generated from `src/modules/locations/regions.ts`, so adding a region
-- there is a code change *plus* a migration that widens them. The alternative
-- — an unconstrained text column — is what these constraints exist to refuse.
--
-- **Widening a column is not releasing a place.** `content/expansions/
-- thirstlands/region.json` ships `"enabled": false`, which is what actually
-- keeps Thirstlands out of the Locations list, out of the travel catalog and
-- out of the seeded encounter pools. All this file does is make the id
-- storable, so that the day the region is switched on there is no migration
-- standing between the content edit and the release.
--
-- Purely additive and rewrite-free: every existing row already satisfies the
-- widened predicate, because a wider `IN` list can only admit more values.
-- Postgres validates each new constraint against the table it lands on, which
-- is a scan of tables that are small by construction (one row per player, and
-- one row per region/species pool entry).
--
-- `guild_boss_state.region` is deliberately **not** widened. Its CHECK is
-- generated from the narrower boss-region list, which is still Waifu Valley
-- alone: Thirstlands hosts no boss roster, and admitting it there would let a
-- scheduler point at a region with nothing drawable in it.
--
-- Every DROP is `IF EXISTS` so the file is safe to re-run against a database
-- that already has the widened form.

ALTER TABLE "players" DROP CONSTRAINT IF EXISTS "players_current_region_check";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_check" CHECK ("players"."current_region" in ('waifu-valley','twin-peeks','thirstlands'));--> statement-breakpoint
ALTER TABLE "region_encounter_pools" DROP CONSTRAINT IF EXISTS "region_encounter_pools_region_check";--> statement-breakpoint
ALTER TABLE "region_encounter_pools" ADD CONSTRAINT "region_encounter_pools_region_check" CHECK ("region_encounter_pools"."region_id" in ('waifu-valley','twin-peeks','thirstlands'));--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" DROP CONSTRAINT IF EXISTS "player_unlocked_routes_region_check";--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" ADD CONSTRAINT "player_unlocked_routes_region_check" CHECK ("player_unlocked_routes"."region_id" in ('waifu-valley','twin-peeks','thirstlands'));--> statement-breakpoint
ALTER TABLE "region_shop_items" DROP CONSTRAINT IF EXISTS "region_shop_items_region_check";--> statement-breakpoint
ALTER TABLE "region_shop_items" ADD CONSTRAINT "region_shop_items_region_check" CHECK ("region_shop_items"."region_id" in ('waifu-valley','twin-peeks','thirstlands'));
