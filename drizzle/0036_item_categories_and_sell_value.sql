-- Expeditions Phase 1 — item foundation: three new categories and a sell value.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035: the drizzle-kit
-- snapshots stop at 0004, so a generated migration would diff against a stale
-- baseline. The journal entry's `when` is set above 0035's, because the
-- node-postgres migrator skips any entry whose stamp is not greater than the
-- last applied one.
--
-- Two additive changes, neither of which can alter how an existing row behaves:
--
--   1. `items_category_check` is **widened** to admit 'salvage', 'key' and
--      'equipment'. A wider IN list only admits more values, so every existing
--      row already satisfies the new predicate and no rewrite is needed. The
--      DROP is `IF EXISTS` so the file is safe to re-run.
--
--   2. `sell_value` arrives nullable with no default. Every existing row is
--      therefore NULL, which is the one spelling of "not sellable" — nothing
--      in the catalog becomes vendorable by accident on the day this runs.
--
-- The CHECK deliberately forbids storing `0`. The design treats 0, NULL and
-- absent as the same fact, and a column that can spell one fact three ways is
-- a bug generator: every consumer would have to remember to test all three.
-- One legal spelling means `sell_value IS NOT NULL` is the whole eligibility
-- rule, and the query in shopService can say exactly that.
--
-- `shop_regions` is untouched. Buying and selling are now different questions:
-- buying stays region-driven off `shop_regions` + `buy_price` and stays
-- restricted to SHOP_ITEM_CATEGORIES, so widening the category set here cannot
-- put salvage on a shelf.

ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_category_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_check" CHECK ("items"."category" in ('capture','material','cosmetic','consumable','salvage','key','equipment'));--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "sell_value" integer;--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_sell_value_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_sell_value_check" CHECK ("items"."sell_value" is null or "items"."sell_value" > 0);
