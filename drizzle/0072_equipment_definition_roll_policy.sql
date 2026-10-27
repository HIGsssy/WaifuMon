-- Equipment 3.0 (E3-C): per-definition roll policy for high-rarity gear.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0071: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0071's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
-- Two columns on `equipment_definitions`, read only by the SSR/UR/LR
-- distribution roll (`highRarityRoll.ts`):
--
--   primary_sp_eligible     whether this definition may roll primary flat SP
--                           (the published rarity rule decides chance/range)
--   max_additional_bonuses  0–3 additional bonuses at most, or null for the
--                           rarity's own ceiling
--
-- Every existing row reads `false` / `null`, which is exactly today's
-- behaviour. N/R/SR (and the unauthorable EX) are pinned to those defaults by
-- `equipment_definitions_roll_policy_rarity_check`, so the legacy roll can
-- never acquire a capability by a direct write.
--
-- Nothing is rewritten and no owned copy is touched.
--
-- ── Rollback ──────────────────────────────────────────────────────────────
--
-- Additive: dropping both constraints and both columns undoes it. Copies
-- already rolled keep their stored values either way.
--
-- Re-running this file is a no-op.
ALTER TABLE "equipment_definitions" ADD COLUMN IF NOT EXISTS "primary_sp_eligible" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_definitions" ADD COLUMN IF NOT EXISTS "max_additional_bonuses" smallint;
--> statement-breakpoint
ALTER TABLE "equipment_definitions" DROP CONSTRAINT IF EXISTS "equipment_definitions_max_additional_bonuses_check";
--> statement-breakpoint
ALTER TABLE "equipment_definitions"
  ADD CONSTRAINT "equipment_definitions_max_additional_bonuses_check"
  CHECK ("max_additional_bonuses" is null or ("max_additional_bonuses" >= 0 and "max_additional_bonuses" <= 3));
--> statement-breakpoint
ALTER TABLE "equipment_definitions" DROP CONSTRAINT IF EXISTS "equipment_definitions_roll_policy_rarity_check";
--> statement-breakpoint
ALTER TABLE "equipment_definitions"
  ADD CONSTRAINT "equipment_definitions_roll_policy_rarity_check"
  CHECK ("rarity" in ('SSR','UR','LR') or ("primary_sp_eligible" = false and "max_additional_bonuses" is null));
