-- Expeditions Phase 2 — selling, recorded in the same ledger as buying.
--
-- Hand-written for the reason recorded in 0019-0021, 0035 and 0036: the
-- drizzle-kit snapshots stop at 0004. The journal `when` is above 0036's,
-- because the node-postgres migrator skips any entry not strictly newer than
-- the last applied one.
--
-- `shop_transactions` gains a `kind` discriminator rather than a new
-- `shop_sales` table. The alternative was rejected deliberately: every
-- consumer of this log — the admin player tools today, any economy dashboard
-- later — asks "what happened to this player's money", and a second table
-- would make that question a UNION forever, in every query, written correctly
-- by everyone who ever asks it. One table with a discriminator asks it once.
--
-- The DEFAULT is what makes this rewrite-free and backward compatible: every
-- existing row is a purchase, which is true, and every existing INSERT — none
-- of which names `kind` — keeps working and keeps meaning what it meant.
--
-- A sale's columns keep their signs and their meanings rather than going
-- negative: positive `quantity` (items left the inventory), `unit_price` =
-- the item's `sell_value`, `total_price` = what was paid out, `balance_after`
-- = the balance *after* crediting. Direction is read off `kind`, never off a
-- sign, so nothing has to remember which columns are signed.
--
-- The partial index serves the sell-history reads without touching the
-- existing `shop_transactions_player_created_idx`, which keeps serving the
-- purchase-shaped queries it was built for.

ALTER TABLE "shop_transactions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_transactions" DROP CONSTRAINT IF EXISTS "shop_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "shop_transactions" ADD CONSTRAINT "shop_transactions_kind_check" CHECK ("shop_transactions"."kind" in ('purchase','sale'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_transactions_player_kind_idx" ON "shop_transactions" ("player_id","kind","created_at");
