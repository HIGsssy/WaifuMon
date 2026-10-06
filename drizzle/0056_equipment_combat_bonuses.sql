-- Equipment combat bonuses, and seeded Combat Trials.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0055: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0055's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── player_equipment.combat_bonuses ───────────────────────────────────────
--
-- The mechanical secondary bonuses one owned instance rolled, beside its
-- primary multiplier and its flavour affix:
--
--   [{ "stat": "crit_chance_bp", "valueBp": 625 },
--    { "stat": "double_attack_chance_bp", "valueBp": 400 }]
--
-- Integer basis points (425 = 4.25%). At most two entries, distinct stat
-- families, stored in canonical family order. Authoritative and never
-- recomputed: retuning the ranges in content/equipment/combatBonuses.json
-- changes future drops only.
--
-- JSONB on the instance row rather than a child table: the bonuses are read
-- with the instance on every read and never queried on their own, the row
-- already carries its other rolled data this way (`rolled_properties`), and
-- identical copies group by plain equality on the column. A collection
-- rather than `affix_stat` / `affix_value_bp` columns because SR gear
-- carries two.
--
-- Every existing row takes the default `[]`: gear that predates the system
-- has no bonuses and is not given any. Nothing is rolled by this migration.
ALTER TABLE "player_equipment"
  ADD COLUMN IF NOT EXISTS "combat_bonuses" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "player_equipment" DROP CONSTRAINT IF EXISTS "player_equipment_combat_bonuses_check";
--> statement-breakpoint
ALTER TABLE "player_equipment"
  ADD CONSTRAINT "player_equipment_combat_bonuses_check"
  CHECK (jsonb_typeof("combat_bonuses") = 'array' and jsonb_array_length("combat_bonuses") <= 2);
--> statement-breakpoint
-- ── combat_trial_attempts.combat_seed ─────────────────────────────────────
--
-- Trials used to draw damage variance from unseeded randomness. Every draw
-- of a fight (variance, Crit, Double Attack) now comes from one seed derived
-- from the player, the Trial and the request key, stored here so the attempt
-- can be reproduced from `initial_state` + this seed. The player's combat
-- modifiers need no column: they are part of the `initial_state` snapshot.
--
-- Null for attempts fought before this migration — they stay replayable from
-- their stored `events`, and are not reproducible from a seed.
ALTER TABLE "combat_trial_attempts"
  ADD COLUMN IF NOT EXISTS "combat_seed" bigint;
