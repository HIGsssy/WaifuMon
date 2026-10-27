-- Equipment 3.0 (E3-A): an owned copy may store up to three combat bonuses.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0069: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0069's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
-- `player_equipment_combat_bonuses_check` (0056) allowed at most two entries.
-- It now allows three, for future SSR/UR/LR gear. Widening only: every
-- existing row (zero, one or two bonuses) already satisfies it, nothing is
-- rewritten and nothing is rolled. N/R/SR rarity rules still grant at most two
-- (`MAX_LEGACY_RULE_BONUS_COUNT`); no shipped content can produce a third.
--
-- ── Rollback ──────────────────────────────────────────────────────────────
--
-- Forward-only once any copy holds three bonuses: restoring `<= 2` would then
-- fail (or, if forced, require deleting player data). Before any such copy
-- exists, re-adding the 0056 form of the constraint is safe.
--
-- Re-running this file is a no-op.
ALTER TABLE "player_equipment" DROP CONSTRAINT IF EXISTS "player_equipment_combat_bonuses_check";
--> statement-breakpoint
ALTER TABLE "player_equipment"
  ADD CONSTRAINT "player_equipment_combat_bonuses_check"
  CHECK (jsonb_typeof("combat_bonuses") = 'array' and jsonb_array_length("combat_bonuses") <= 3);
