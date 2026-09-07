-- Widen `items.effect_type` to admit `buddy_affection_gain`.
--
-- Additive only: the constraint gains one permitted value and loses none, so
-- every existing row still satisfies it and the migration cannot fail on data.
-- Postgres has no "alter check", hence the drop-and-recreate.
ALTER TABLE "items" DROP CONSTRAINT "items_effect_type_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_effect_type_check" CHECK ("items"."effect_type" is null or "items"."effect_type" in ('restore_energy_full','restore_energy_amount','capture_bonus_charges','buddy_affection_gain'));
