-- Assteroid Belt — widen the region CHECK constraints for a released region.
--
-- Hand-written, for the reason recorded in 0019, 0020 and 0021: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal entry's `when` is set above 0041's,
-- because the node-postgres migrator skips any entry whose stamp is not
-- greater than the last applied one.
--
-- Same shape and same intent as 0035 (Base 80085): a region that ships **on**.
-- `content/expansions/assteroid_belt/region.json` is `"enabled": true` and its
-- manifest declares `"regionId": "assteroid-belt"`, so from the moment this
-- migration runs `players.current_region` and `player_unlocked_routes.region_id`
-- have real rows to store, and the seeder writes a `region_encounter_pools`
-- row per entry in the pack's encounter pool.
--
-- One constraint appears here that 0035 predates: `player_expeditions.region`,
-- added by 0038 against the then-current five-region list. The Belt ships no
-- Expedition missions of its own yet, but the column still has to admit the id
-- the day a mission targets it — a narrower CHECK would reject the deploy.
--
-- `region_shop_items` is **not** widened: 0022 dropped that table and moved
-- regional stock onto `items.shop_regions`, a text array with no region CHECK.
--
-- `guild_boss_state.region` is deliberately **not** widened, exactly as in
-- 0020, 0021 and 0035: its CHECK comes from the narrower boss-region list, and
-- the Belt hosts no boss roster. Travel destination and boss venue remain two
-- different questions.
--
-- Purely additive and rewrite-free: a wider `IN` list can only admit more
-- values, so every existing row already satisfies the widened predicate.
--
-- Every DROP is `IF EXISTS` so the file is safe to re-run against a database
-- that already has the widened form.

ALTER TABLE "players" DROP CONSTRAINT IF EXISTS "players_current_region_check";--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_check" CHECK ("players"."current_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "region_encounter_pools" DROP CONSTRAINT IF EXISTS "region_encounter_pools_region_check";--> statement-breakpoint
ALTER TABLE "region_encounter_pools" ADD CONSTRAINT "region_encounter_pools_region_check" CHECK ("region_encounter_pools"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" DROP CONSTRAINT IF EXISTS "player_unlocked_routes_region_check";--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" ADD CONSTRAINT "player_unlocked_routes_region_check" CHECK ("player_unlocked_routes"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "world_encounter_regions" DROP CONSTRAINT IF EXISTS "world_encounter_regions_region_check";--> statement-breakpoint
ALTER TABLE "world_encounter_regions" ADD CONSTRAINT "world_encounter_regions_region_check" CHECK ("world_encounter_regions"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "world_encounter_routes" DROP CONSTRAINT IF EXISTS "world_encounter_routes_from_check";--> statement-breakpoint
ALTER TABLE "world_encounter_routes" ADD CONSTRAINT "world_encounter_routes_from_check" CHECK ("world_encounter_routes"."from_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "world_encounter_routes" DROP CONSTRAINT IF EXISTS "world_encounter_routes_to_check";--> statement-breakpoint
ALTER TABLE "world_encounter_routes" ADD CONSTRAINT "world_encounter_routes_to_check" CHECK ("world_encounter_routes"."to_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));--> statement-breakpoint
ALTER TABLE "player_expeditions" DROP CONSTRAINT IF EXISTS "player_expeditions_region_check";--> statement-breakpoint
ALTER TABLE "player_expeditions" ADD CONSTRAINT "player_expeditions_region_check" CHECK ("player_expeditions"."region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt'));
