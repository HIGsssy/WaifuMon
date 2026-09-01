-- Flaccid Foothills — widen the region CHECK constraints for a released region.
--
-- Hand-written, for the reason recorded in 0019 and 0020: the drizzle-kit
-- snapshots stop at 0004, so a generated migration would diff against a stale
-- baseline. The journal entry's `when` is set above 0020's, because the
-- node-postgres migrator skips any entry whose stamp is not greater than the
-- last applied one.
--
-- Same shape as 0020, different intent. 0020 widened the columns for a region
-- that ships disabled; this one widens them for a region that ships **on** —
-- `content/expansions/flaccid_foothills/region.json` is `"enabled": true`, so
-- from the moment this migration runs, `players.current_region` and
-- `player_unlocked_routes.region_id` have real rows to store, and the seeder
-- writes a `region_encounter_pools` row per species in the pack.
--
-- Purely additive and rewrite-free: a wider `IN` list can only admit more
-- values, so every existing row already satisfies the widened predicate.
--
-- `guild_boss_state.region` is deliberately **not** widened, exactly as in
-- 0020: its CHECK comes from the narrower boss-region list, and the Foothills
-- host no boss roster. Travel destination and boss venue remain two different
-- questions.
--
-- Every DROP is `IF EXISTS` so the file is safe to re-run against a database
-- that already has the widened form.

ALTER TABLE "players" DROP CONSTRAINT IF EXISTS "players_current_region_check";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_check" CHECK ("players"."current_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands'));--> statement-breakpoint
ALTER TABLE "region_encounter_pools" DROP CONSTRAINT IF EXISTS "region_encounter_pools_region_check";--> statement-breakpoint
ALTER TABLE "region_encounter_pools" ADD CONSTRAINT "region_encounter_pools_region_check" CHECK ("region_encounter_pools"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands'));--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" DROP CONSTRAINT IF EXISTS "player_unlocked_routes_region_check";--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" ADD CONSTRAINT "player_unlocked_routes_region_check" CHECK ("player_unlocked_routes"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands'));--> statement-breakpoint
ALTER TABLE "region_shop_items" DROP CONSTRAINT IF EXISTS "region_shop_items_region_check";--> statement-breakpoint
ALTER TABLE "region_shop_items" ADD CONSTRAINT "region_shop_items_region_check" CHECK ("region_shop_items"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands'));
