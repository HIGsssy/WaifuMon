-- Two more Result Presentation keys:
--
--   `world_encounter.back_to_hunting`  — the exit screen a resolved
--       hunt-origin World Encounter leaves the player on;
--   `collection.converted_to_essence`  — the result of converting an owned
--       copy to Essence.
--
-- 0033 is left exactly as it was: the key list and the encountered-artwork
-- rule are CHECK constraints, so extending them is a drop-and-recreate of
-- those two constraints, which is what this does. A database upgraded through
-- 0033 accepts both new keys afterwards, and every existing row still
-- satisfies the wider list.
--
-- `collection.converted_to_essence` also joins `encounter.released` as a key
-- that may use `encountered` artwork: the conversion result still carries the
-- species row, so her canonical artwork is available to the screen.
--
-- The lists mirror `RESULT_PRESENTATION_KEYS` and
-- `keysAllowingArtworkMode('encountered')` in
-- src/modules/resultPresentation/keys.ts; a unit test compares them.
ALTER TABLE "result_presentation_variants" DROP CONSTRAINT "result_presentation_variants_key_check";--> statement-breakpoint
ALTER TABLE "result_presentation_variants" ADD CONSTRAINT "result_presentation_variants_key_check" CHECK ("presentation_key" in ('hunt.waifubux_find','hunt.essence_find','hunt.item_find','hunt.rare_item_find','hunt.nothing_found','encounter.released','world_encounter.back_to_hunting','collection.converted_to_essence'));--> statement-breakpoint
ALTER TABLE "result_presentation_variants" DROP CONSTRAINT "result_presentation_variants_encountered_key_check";--> statement-breakpoint
ALTER TABLE "result_presentation_variants" ADD CONSTRAINT "result_presentation_variants_encountered_key_check" CHECK ("artwork_mode" <> 'encountered' or "presentation_key" in ('encounter.released','collection.converted_to_essence'));
