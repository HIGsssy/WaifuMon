-- Equipment becomes instance-based loot: a definition describes a multiplier
-- *range*, and every owned instance stores the multiplier it rolled plus an
-- optional flavour affix.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0045: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0045's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
--   equipment_definitions: `attack_bp` / `defense_bp` / `health_bp` (one fixed
--     multiplier, two mandatory zeros) become `multiplier_min_bp`,
--     `multiplier_max_bp`, `multiplier_step_bp` — the discrete values a new
--     instance may roll, always for the definition's own slot. One set of
--     columns rather than three per-slot ranges: "a definition only provides
--     its own slot's multiplier" is then structural, not a CHECK.
--   player_equipment: gains `rolled_multiplier_bp` (NOT NULL — the one
--     authoritative combat value) and `affix_key` (nullable; flavour, keyed
--     into `content/equipment/affixes.json`).
--
-- ── Existing data ─────────────────────────────────────────────────────────
--
--   * Every existing instance keeps **exactly** its current effective
--     multiplier: `rolled_multiplier_bp` is copied from the old own-slot
--     column *before* anything about the definition changes. Nothing is
--     rerolled, and `affix_key` stays NULL — no surprise suffixes.
--   * Every existing definition becomes a single-value range at its old
--     multiplier (min = max = old value, step 100), so nothing an admin
--     authored changes behaviour.
--   * The three onboarding starters are widened to their starter ranges —
--     but only where the row still holds the value the seed shipped, so a
--     hand-tuned starter is left as a single-value range for an admin to
--     retune deliberately. Each range contains the fixed starter value the
--     onboarding grants (`STARTER_ROLLS`), so onboarding is unaffected:
--       rusty_pipe       ×0.45 → ×0.40–×0.60 step ×0.05
--       scrap_plate      ×0.35 → ×0.30–×0.50 step ×0.05
--       dented_lunchbox  ×2.00 → ×1.80–×2.60 step ×0.20
--
-- On a fresh database there are no rows and only the shape changes; the
-- startup seed then inserts the starters with their ranges.
--
-- The old columns are dropped at the end, so no reader can ever pick the
-- definition's value over the instance's. Re-running this file is a no-op:
-- the data copy runs only while the old columns still exist.

ALTER TABLE "equipment_definitions"
	ADD COLUMN IF NOT EXISTS "multiplier_min_bp" integer,
	ADD COLUMN IF NOT EXISTS "multiplier_max_bp" integer,
	ADD COLUMN IF NOT EXISTS "multiplier_step_bp" integer;--> statement-breakpoint
ALTER TABLE "player_equipment"
	ADD COLUMN IF NOT EXISTS "rolled_multiplier_bp" integer,
	ADD COLUMN IF NOT EXISTS "affix_key" text;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'equipment_definitions' AND column_name = 'attack_bp'
	) THEN
		-- 1. Instances first, from the old columns, by the instance's own slot
		--    (the same rule `toCombatSlotItem` applied).
		UPDATE "player_equipment" AS pe
		SET "rolled_multiplier_bp" = CASE pe."slot"
				WHEN 'attack' THEN d."attack_bp"
				WHEN 'defense' THEN d."defense_bp"
				ELSE d."health_bp"
			END
		FROM "equipment_definitions" AS d
		WHERE d."id" = pe."definition_id" AND pe."rolled_multiplier_bp" IS NULL;

		-- 2. Every definition: a single-value range at its old multiplier.
		UPDATE "equipment_definitions"
		SET "multiplier_min_bp" = CASE "slot" WHEN 'attack' THEN "attack_bp" WHEN 'defense' THEN "defense_bp" ELSE "health_bp" END,
			"multiplier_max_bp" = CASE "slot" WHEN 'attack' THEN "attack_bp" WHEN 'defense' THEN "defense_bp" ELSE "health_bp" END,
			"multiplier_step_bp" = 100
		WHERE "multiplier_min_bp" IS NULL;

		-- 3. The starters, where they still hold their seeded value.
		UPDATE "equipment_definitions"
		SET "multiplier_min_bp" = 4000, "multiplier_max_bp" = 6000, "multiplier_step_bp" = 500, "updated_at" = now()
		WHERE "key" = 'rusty_pipe' AND "slot" = 'attack' AND "attack_bp" = 4500;
		UPDATE "equipment_definitions"
		SET "multiplier_min_bp" = 3000, "multiplier_max_bp" = 5000, "multiplier_step_bp" = 500, "updated_at" = now()
		WHERE "key" = 'scrap_plate' AND "slot" = 'defense' AND "defense_bp" = 3500;
		UPDATE "equipment_definitions"
		SET "multiplier_min_bp" = 18000, "multiplier_max_bp" = 26000, "multiplier_step_bp" = 2000, "updated_at" = now()
		WHERE "key" = 'dented_lunchbox' AND "slot" = 'health' AND "health_bp" = 20000;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "equipment_definitions"
	ALTER COLUMN "multiplier_min_bp" SET NOT NULL,
	ALTER COLUMN "multiplier_max_bp" SET NOT NULL,
	ALTER COLUMN "multiplier_step_bp" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "player_equipment" ALTER COLUMN "rolled_multiplier_bp" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "equipment_definitions"
	DROP CONSTRAINT IF EXISTS "equipment_definitions_multipliers_check",
	DROP CONSTRAINT IF EXISTS "equipment_definitions_bounds_check",
	DROP CONSTRAINT IF EXISTS "equipment_definitions_own_stat_check";--> statement-breakpoint
ALTER TABLE "equipment_definitions"
	DROP COLUMN IF EXISTS "attack_bp",
	DROP COLUMN IF EXISTS "defense_bp",
	DROP COLUMN IF EXISTS "health_bp";--> statement-breakpoint
ALTER TABLE "equipment_definitions"
	DROP CONSTRAINT IF EXISTS "equipment_definitions_multiplier_range_check",
	DROP CONSTRAINT IF EXISTS "equipment_definitions_multiplier_bounds_check";--> statement-breakpoint
ALTER TABLE "equipment_definitions"
	ADD CONSTRAINT "equipment_definitions_multiplier_range_check" CHECK ("multiplier_min_bp" > 0 and "multiplier_max_bp" >= "multiplier_min_bp" and (case when "multiplier_step_bp" > 0 then ("multiplier_max_bp" - "multiplier_min_bp") % "multiplier_step_bp" = 0 else false end)),
	ADD CONSTRAINT "equipment_definitions_multiplier_bounds_check" CHECK ("multiplier_max_bp" <= (case "slot" when 'attack' then 20000 when 'defense' then 20000 when 'health' then 80000 else 0 end));--> statement-breakpoint
ALTER TABLE "player_equipment"
	DROP CONSTRAINT IF EXISTS "player_equipment_rolled_multiplier_check",
	DROP CONSTRAINT IF EXISTS "player_equipment_affix_key_check";--> statement-breakpoint
ALTER TABLE "player_equipment"
	ADD CONSTRAINT "player_equipment_rolled_multiplier_check" CHECK ("rolled_multiplier_bp" > 0 and "rolled_multiplier_bp" <= (case "slot" when 'attack' then 20000 when 'defense' then 20000 when 'health' then 80000 else 0 end)),
	ADD CONSTRAINT "player_equipment_affix_key_check" CHECK ("affix_key" is null or "affix_key" ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$');
