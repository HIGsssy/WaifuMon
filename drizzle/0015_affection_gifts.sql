-- Affection Gift System + encounter-time capture-item selection.
--
-- Three independent additions, shipped together because the new gift-exclusive
-- items are what the gift table drops:
--
--   1. `affection_gift_rolls` / `affection_gifts` — the daily roll ledger and
--      the gifts it produces. The unique (player_id, roll_date) index is the
--      idempotency guard: a retried daily claim, or two workers racing, insert
--      here first and exactly one wins. The partial unique index on
--      `affection_gifts.waifu_id WHERE claimed_at IS NULL` enforces "one
--      unclaimed gift per owned copy" in the database rather than in code.
--   2. `player_waifus.gift_roll_counter` — per-copy progress toward the tier's
--      guaranteed gift. Per-copy so swapping buddies transfers nothing.
--   3. `encounters.selected_item_id` + `items.capture_bonus` /
--      `items.capture_rarities` — the chosen-but-not-yet-committed capture
--      item, its additive bonus, and the rarities it is eligible against.
--
-- Every column is additive with a safe default, so existing rows are correct
-- as they stand: no gift progress (0), no selection (null), no flat bonus
-- (null), and no rarity restriction (null = every rarity, i.e. the charms).
CREATE TABLE "affection_gift_rolls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affection_gift_rolls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"roll_date" date NOT NULL,
	"waifu_id" bigint NOT NULL,
	"affection" integer NOT NULL,
	"tier" text NOT NULL,
	"result" text NOT NULL,
	"guaranteed" boolean DEFAULT false NOT NULL,
	"counter_before" integer NOT NULL,
	"counter_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affection_gift_rolls_tier_check" CHECK ("tier" in ('low','mid','high')),
	CONSTRAINT "affection_gift_rolls_result_check" CHECK ("result" in ('gift','none'))
);
--> statement-breakpoint
CREATE TABLE "affection_gifts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "affection_gifts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"waifu_id" bigint NOT NULL,
	"item_slug" text NOT NULL,
	"quantity" integer NOT NULL,
	"affection_at_generation" integer NOT NULL,
	"tier_at_generation" text NOT NULL,
	"source" text NOT NULL,
	"reset_date" date NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "affection_gifts_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "affection_gifts_tier_check" CHECK ("tier_at_generation" in ('low','mid','high')),
	CONSTRAINT "affection_gifts_source_check" CHECK ("source" in ('random','guaranteed'))
);
--> statement-breakpoint
ALTER TABLE "affection_gift_rolls" ADD CONSTRAINT "affection_gift_rolls_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affection_gifts" ADD CONSTRAINT "affection_gifts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affection_gift_rolls_player_date_uq" ON "affection_gift_rolls" USING btree ("player_id","roll_date");--> statement-breakpoint
CREATE INDEX "affection_gift_rolls_waifu_idx" ON "affection_gift_rolls" USING btree ("waifu_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affection_gifts_waifu_unclaimed_uq" ON "affection_gifts" USING btree ("waifu_id") WHERE claimed_at is null;--> statement-breakpoint
CREATE INDEX "affection_gifts_player_idx" ON "affection_gifts" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "affection_gifts_player_unclaimed_idx" ON "affection_gifts" USING btree ("player_id") WHERE claimed_at is null;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD COLUMN "gift_roll_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD CONSTRAINT "player_waifus_gift_roll_counter_check" CHECK ("player_waifus"."gift_roll_counter" >= 0);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "capture_bonus" real;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "capture_rarities" jsonb;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "selected_item_id" bigint;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_selected_item_id_items_id_fk" FOREIGN KEY ("selected_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_effect_type_check";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_effect_type_check" CHECK ("items"."effect_type" is null or "items"."effect_type" in ('restore_energy_full','restore_energy_amount','capture_bonus_charges'));
