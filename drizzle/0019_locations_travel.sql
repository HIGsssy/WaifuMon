-- Locations, Travel, Regional Encounters & Expansion Content Packs — framework pass.
--
-- Hand-written, following this repository's convention since 0005: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline and re-emit tables that already exist. The journal
-- entry's `when` is set *above* 0018's for the same reason recorded there —
-- the node-postgres migrator skips any entry whose stamp is not greater than
-- the last applied one.
--
-- Everything here is purely additive. Nothing is backfilled and nothing is
-- rewritten, because the two columns that touch existing rows both carry a
-- default that is already the correct answer for every row that exists:
--
--   * `players.current_region` defaults to 'waifu-valley'. Every player who
--     predates travel has been standing in Waifu Valley the whole time, so the
--     default *is* the backfill and an UPDATE would be a no-op over the table.
--   * `encounters.region_id` is nullable and stays NULL on historical rows. It
--     is a snapshot of where a hunt happened; rows from before travel have no
--     honest answer and inventing 'waifu-valley' for them would fabricate data
--     that reads as recorded rather than assumed. Nothing branches on it.
--
-- The CHECK constraints on every region column are generated from
-- `src/modules/locations/regions.ts`. Adding a region is therefore a code
-- change plus a migration that widens these, which is the deliberate trade the
-- boss subsystem already made in 0017 — the database refusing to store a typo
-- is worth a migration per region.
--
-- Two uniqueness guarantees are the load-bearing part of this file, and both
-- are primary keys rather than application checks:
--
--   * `player_travel_passes (player_id, pass_id)` makes "you cannot buy the
--     Caravan Pass twice" a database fact. Two concurrent purchase clicks both
--     lock the currency row, both deduct, both insert — and exactly one commits.
--     The loser's whole transaction rolls back, so the second click cannot
--     charge a second 1,000 WaifuBux even if it wins every other race.
--   * `player_unlocked_routes (player_id, region_id)` does the same for each
--     destination, so a route stamped onto an existing pass is equally safe.
--
-- Waifu Valley gets no `player_unlocked_routes` row, on purpose: it is always
-- reachable by rule, and storing a row for it would invite code that checks the
-- row instead of the rule and then strands anyone whose row went missing.
ALTER TABLE "players" ADD COLUMN "current_region" text DEFAULT 'waifu-valley' NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_check" CHECK ("players"."current_region" in ('waifu-valley','twin-peeks'));--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "region_id" text;--> statement-breakpoint
CREATE TABLE "region_encounter_pools" (
	"region_id" text NOT NULL,
	"species_id" bigint NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "region_encounter_pools_region_id_species_id_pk" PRIMARY KEY("region_id","species_id"),
	CONSTRAINT "region_encounter_pools_weight_check" CHECK ("region_encounter_pools"."weight" > 0),
	CONSTRAINT "region_encounter_pools_region_check" CHECK ("region_encounter_pools"."region_id" in ('waifu-valley','twin-peeks'))
);--> statement-breakpoint
CREATE TABLE "player_travel_passes" (
	"player_id" bigint NOT NULL,
	"pass_id" text NOT NULL,
	"source" text DEFAULT 'purchase' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_travel_passes_player_id_pass_id_pk" PRIMARY KEY("player_id","pass_id"),
	CONSTRAINT "player_travel_passes_source_check" CHECK ("player_travel_passes"."source" in ('purchase','admin'))
);--> statement-breakpoint
CREATE TABLE "player_unlocked_routes" (
	"player_id" bigint NOT NULL,
	"region_id" text NOT NULL,
	"source" text DEFAULT 'purchase' NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_unlocked_routes_player_id_region_id_pk" PRIMARY KEY("player_id","region_id"),
	CONSTRAINT "player_unlocked_routes_region_check" CHECK ("player_unlocked_routes"."region_id" in ('waifu-valley','twin-peeks')),
	CONSTRAINT "player_unlocked_routes_source_check" CHECK ("player_unlocked_routes"."source" in ('purchase','admin'))
);--> statement-breakpoint
CREATE TABLE "travel_transactions" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "travel_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"player_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"pass_id" text,
	"region_id" text,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'waifubux' NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "travel_transactions_pkey" PRIMARY KEY("id"),
	CONSTRAINT "travel_transactions_kind_check" CHECK ("travel_transactions"."kind" in ('pass','route')),
	CONSTRAINT "travel_transactions_currency_check" CHECK ("travel_transactions"."currency" in ('waifubux','essence'))
);--> statement-breakpoint
CREATE TABLE "region_shop_items" (
	"region_id" text NOT NULL,
	"item_id" bigint NOT NULL,
	CONSTRAINT "region_shop_items_region_id_item_id_pk" PRIMARY KEY("region_id","item_id"),
	CONSTRAINT "region_shop_items_region_check" CHECK ("region_shop_items"."region_id" in ('waifu-valley','twin-peeks'))
);--> statement-breakpoint
ALTER TABLE "region_encounter_pools" ADD CONSTRAINT "region_encounter_pools_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_travel_passes" ADD CONSTRAINT "player_travel_passes_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_unlocked_routes" ADD CONSTRAINT "player_unlocked_routes_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_transactions" ADD CONSTRAINT "travel_transactions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_shop_items" ADD CONSTRAINT "region_shop_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "region_encounter_pools_region_idx" ON "region_encounter_pools" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "travel_transactions_player_created_idx" ON "travel_transactions" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE INDEX "region_shop_items_region_idx" ON "region_shop_items" USING btree ("region_id");
