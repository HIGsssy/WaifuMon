-- Item-driven shop regions — replace the region→item junction with an
-- item→regions array, and retire the `purchasable` flag.
--
-- Hand-written, for the reason recorded in 0019–0021: the drizzle-kit snapshots
-- stop at 0004/0010, so a generated migration would diff against a stale
-- baseline. The journal entry's `when` is set above 0021's, because the
-- node-postgres migrator skips any entry whose stamp is not greater than the
-- last applied one.
--
-- Shop availability used to be a global catalog (`items.purchasable` + price)
-- minus items "claimed" by a region via `region_shop_items`. It is now the
-- inverse: each item names the regions whose shops sell it in `shop_regions`,
-- and there is no global shop. `purchasable` no longer means anything — an item
-- is sellable exactly when it is enabled, priced, and lists at least one region.
--
-- Data is preserved: any existing `region_shop_items` membership is folded into
-- the new column before the table is dropped. Every DROP is `IF EXISTS` so the
-- file is safe to re-run.

ALTER TABLE "items" ADD COLUMN "shop_regions" text[] NOT NULL DEFAULT '{}'::text[];--> statement-breakpoint
UPDATE "items" AS i
SET "shop_regions" = sub.regions
FROM (
  SELECT "item_id", array_agg("region_id") AS regions
  FROM "region_shop_items"
  GROUP BY "item_id"
) AS sub
WHERE i."id" = sub."item_id";--> statement-breakpoint
DROP TABLE IF EXISTS "region_shop_items";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN IF EXISTS "purchasable";
