-- Base 80085 — widen the region CHECK constraints for a released region.
--
-- Hand-written, for the reason recorded in 0019, 0020 and 0021: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal entry's `when` is set above 0034's,
-- because the node-postgres migrator skips any entry whose stamp is not
-- greater than the last applied one.
--
-- Same shape and same intent as 0021: a region that ships **on**.
-- `content/expansions/base_80085/region.json` is `"enabled": true` and its
-- manifest declares `"regionId": "base-80085"`, so from the moment this
-- migration runs `players.current_region` and `player_unlocked_routes.region_id`
-- have real rows to store, and the seeder writes a `region_encounter_pools`
-- row per entry in the pack's encounter pool.
--
-- `region_shop_items` is **not** widened, unlike in 0020 and 0021: 0022 dropped
-- that table outright and moved regional stock onto `items.shop_regions`, which
-- is a text array with no region CHECK. Base 80085 ships no shop items of its
-- own, and adding some later is a content edit, not a migration.
--
-- Two constraints appear here that 0021 predates: `world_encounter_regions`
-- and `world_encounter_routes`, added by 0024 against the then-current
-- four-region list. Base 80085 ships no region-scoped world encounters of its
-- own, but the columns still have to admit the id — travel *into* and *out of*
-- the region writes `world_encounter_routes` rows for the unscoped encounters,
-- and a narrower CHECK would reject them at the first trip.
--
-- Purely additive and rewrite-free: a wider `IN` list can only admit more
-- values, so every existing row already satisfies the widened predicate.
--
-- `guild_boss_state.region` is deliberately **not** widened, exactly as in
-- 0020 and 0021: its CHECK comes from the narrower boss-region list, and Base
-- 80085 hosts no boss roster. Travel destination and boss venue remain two
-- different questions.
--
-- Every DROP is `IF EXISTS` so the file is safe to re-run against a database
-- that already has the widened form.

ALTER TABLE "players" DROP CONSTRAINT IF EXISTS "players_current_region_check";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_check" CHECK ("players"."current_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));--> statement-breakpoint
ALTER TABLE "region_encounter_pools" DROP CONSTRAINT IF EXISTS "region_encounter_pools_region_check";--> statement-breakpoint
ALTER TABLE "region_encounter_pools" ADD CONSTRAINT "region_encounter_pools_region_check" CHECK ("region_encounter_pools"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" DROP CONSTRAINT IF EXISTS "player_unlocked_routes_region_check";--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" ADD CONSTRAINT "player_unlocked_routes_region_check" CHECK ("player_unlocked_routes"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));--> statement-breakpoint
ALTER TABLE "world_encounter_regions" DROP CONSTRAINT IF EXISTS "world_encounter_regions_region_check";--> statement-breakpoint
ALTER TABLE "world_encounter_regions" ADD CONSTRAINT "world_encounter_regions_region_check" CHECK ("world_encounter_regions"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));--> statement-breakpoint
ALTER TABLE "world_encounter_routes" DROP CONSTRAINT IF EXISTS "world_encounter_routes_from_check";--> statement-breakpoint
ALTER TABLE "world_encounter_routes" ADD CONSTRAINT "world_encounter_routes_from_check" CHECK ("world_encounter_routes"."from_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));--> statement-breakpoint
ALTER TABLE "world_encounter_routes" DROP CONSTRAINT IF EXISTS "world_encounter_routes_to_check";--> statement-breakpoint
ALTER TABLE "world_encounter_routes" ADD CONSTRAINT "world_encounter_routes_to_check" CHECK ("world_encounter_routes"."to_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085'));
