-- Authored outcome flavor text for World Encounter choices.
--
-- Three nullable text columns on `world_encounter_choices` hold what an author
-- wrote: a generic `outcome_text` fallback and optional per-branch
-- `success_text` / `failure_text`. Presentation only — no check, effect,
-- cooldown or chain reads them.
--
-- `world_encounter_history.resolved_outcome_text` snapshots the one line the
-- player was actually shown, so later edits to the authored text never rewrite
-- history. Rows written before this migration read as null, which is exactly
-- "no flavor was shown".
--
-- Additive only: nullable columns with no default, so every existing row stays
-- valid and the migration cannot fail on data.
ALTER TABLE "world_encounter_choices" ADD COLUMN "outcome_text" text;--> statement-breakpoint
ALTER TABLE "world_encounter_choices" ADD COLUMN "success_text" text;--> statement-breakpoint
ALTER TABLE "world_encounter_choices" ADD COLUMN "failure_text" text;--> statement-breakpoint
ALTER TABLE "world_encounter_history" ADD COLUMN "resolved_outcome_text" text;
