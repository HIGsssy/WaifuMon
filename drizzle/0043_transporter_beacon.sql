-- Transporter Beacon — the Assteroid Belt moves from a paid Caravan Pass route
-- to a permanent key item, and every player who already holds the route is
-- given the beacon so nobody loses access they paid for.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0042: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0042's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What changes ───────────────────────────────────────────────────────────
--
--   1. `items.max_owned` — an optional per-player ownership cap, enforced by
--      `inventoryService.addItem`'s conditional upsert. Null (every existing
--      row) means unlimited, so this is purely additive.
--   2. `key_item_constructions` — the audit trail for key-item recipes, the
--      same role `travel_transactions` plays for pass and route purchases.
--   3. The `transporter_beacon` item row, inserted here rather than left to
--      the seeder, because migrations run *before* the seeder at boot and the
--      backfill below needs an `items.id` to point inventory at. The seeder
--      then finds the slug present and upserts the rest of its fields from
--      `content/items.json`, exactly as for any other item. `ON CONFLICT DO
--      NOTHING` makes a re-run (or a database the seeder somehow reached
--      first) a no-op.
--   4. The backfill.
--
-- ── Who gets a beacon ─────────────────────────────────────────────────────
--
-- Before this release, Assteroid Belt access was *exactly* one fact: a
-- `player_unlocked_routes` row with `region_id = 'assteroid-belt'`. That row
-- is written by a route purchase (`source = 'purchase'`, 3,000 WaifuBux, with
-- a matching `travel_transactions` row) or by the admin `grantRoute` helper
-- (`source = 'admin'`). `travelService.travel()` checked that row and nothing
-- else. So every player with that row — either source — held legitimate
-- access, and every such player receives exactly one beacon here.
--
-- Deliberately *not* used as evidence of access:
--
--   * `players.current_region = 'assteroid-belt'` without a route row. Only an
--     admin edit can produce that; the player can still leave (travel checks
--     the destination, never the origin), and granting on it would reward the
--     inconsistency rather than repair it.
--   * `travel_transactions` alone. A purchase always wrote a route row in the
--     same transaction, so a transaction without one means an admin revoked
--     the route afterwards — a decision this migration should not reverse.
--
-- The route rows themselves are left in place. After this release the Belt's
-- gate reads the beacon, never the route row, so the row is inert history —
-- and deleting it would needlessly change the achievements "regions visited"
-- count for exactly the players this migration is protecting.
--
-- Idempotent: a player who already holds a beacon is untouched (the upsert
-- only lifts a zero quantity to one), and the audit row is written only for
-- rows the upsert actually changed.

ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "max_owned" integer;--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_max_owned_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_max_owned_check" CHECK ("items"."max_owned" is null or "items"."max_owned" > 0);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "key_item_constructions" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "key_item_constructions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"player_id" bigint NOT NULL,
	"recipe_id" text NOT NULL,
	"output_item_id" bigint NOT NULL,
	"source" text DEFAULT 'construct' NOT NULL,
	"waifubux_spent" integer DEFAULT 0 NOT NULL,
	"inputs" jsonb NOT NULL,
	"balance_after" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_item_constructions_pkey" PRIMARY KEY("id"),
	CONSTRAINT "key_item_constructions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "key_item_constructions_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "key_item_constructions_source_check" CHECK ("key_item_constructions"."source" in ('construct','migration')),
	CONSTRAINT "key_item_constructions_spent_check" CHECK ("key_item_constructions"."waifubux_spent" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "key_item_constructions_player_idx" ON "key_item_constructions" USING btree ("player_id","created_at");--> statement-breakpoint
INSERT INTO "items" ("slug", "name", "category", "description", "emoji", "enabled", "max_owned")
VALUES (
	'transporter_beacon',
	'Transporter Beacon',
	'key',
	'A hand-built beacon keyed to the transporter pad on Station 8008135. Permanent — it unlocks travel to the Assteroid Belt and is never used up.',
	'📡',
	true,
	1
)
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
WITH "granted" AS (
	INSERT INTO "player_inventory" ("player_id", "item_id", "quantity")
	SELECT r."player_id", i."id", 1
	FROM "player_unlocked_routes" r
	JOIN "items" i ON i."slug" = 'transporter_beacon'
	WHERE r."region_id" = 'assteroid-belt'
	ON CONFLICT ("player_id", "item_id") DO UPDATE
		SET "quantity" = 1
		WHERE "player_inventory"."quantity" < 1
	RETURNING "player_id", "item_id"
)
INSERT INTO "key_item_constructions" ("player_id", "recipe_id", "output_item_id", "source", "waifubux_spent", "inputs", "balance_after")
SELECT g."player_id", 'transporter_beacon', g."item_id", 'migration', 0, '[]'::jsonb, NULL
FROM "granted" g;
