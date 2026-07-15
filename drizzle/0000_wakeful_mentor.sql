CREATE TABLE "daily_claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "daily_claims_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"claim_date" date NOT NULL,
	"rewards" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "guilds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"discord_guild_id" text NOT NULL,
	"announce_channel_id" text,
	"here_threshold_rarity" text DEFAULT 'UR' NOT NULL,
	"allowed_channel_ids" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guilds_discord_guild_id_unique" UNIQUE("discord_guild_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"capture_modifier" real,
	"is_guaranteed_capture" boolean DEFAULT false NOT NULL,
	"purchasable" boolean DEFAULT false NOT NULL,
	"buy_price" integer,
	"daily_stock_limit" integer,
	"description" text DEFAULT '' NOT NULL,
	"emoji" text,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "items_slug_unique" UNIQUE("slug"),
	CONSTRAINT "items_category_check" CHECK ("items"."category" in ('capture','material','cosmetic','consumable'))
);
--> statement-breakpoint
CREATE TABLE "player_currencies" (
	"player_id" bigint PRIMARY KEY NOT NULL,
	"hunt_energy" integer DEFAULT 0 NOT NULL,
	"waifubux" integer DEFAULT 0 NOT NULL,
	"essence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_currencies_hunt_energy_check" CHECK ("player_currencies"."hunt_energy" >= 0),
	CONSTRAINT "player_currencies_waifubux_check" CHECK ("player_currencies"."waifubux" >= 0),
	CONSTRAINT "player_currencies_essence_check" CHECK ("player_currencies"."essence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_inventory" (
	"player_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_inventory_player_id_item_id_pk" PRIMARY KEY("player_id","item_id"),
	CONSTRAINT "player_inventory_quantity_check" CHECK ("player_inventory"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "players_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" bigint NOT NULL,
	"discord_user_id" text NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"showcase" jsonb,
	"last_hunt_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shop_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"total_price" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "species" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "species_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"rarity" text NOT NULL,
	"archetype" text NOT NULL,
	"base_capture_rate" real,
	"description" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_rating" text NOT NULL,
	"image_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"event_key" text,
	"per_species_weight" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "species_slug_unique" UNIQUE("slug"),
	CONSTRAINT "species_rarity_check" CHECK ("species"."rarity" in ('N','R','SR','SSR','UR','LR','EX')),
	CONSTRAINT "species_content_rating_check" CHECK ("species"."content_rating" in ('suggestive','mature','explicit'))
);
--> statement-breakpoint
ALTER TABLE "daily_claims" ADD CONSTRAINT "daily_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_currencies" ADD CONSTRAINT "player_currencies_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_inventory" ADD CONSTRAINT "player_inventory_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_inventory" ADD CONSTRAINT "player_inventory_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transactions" ADD CONSTRAINT "shop_transactions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_transactions" ADD CONSTRAINT "shop_transactions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_claims_player_date_uq" ON "daily_claims" USING btree ("player_id","claim_date");--> statement-breakpoint
CREATE UNIQUE INDEX "players_guild_user_uq" ON "players" USING btree ("guild_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "shop_transactions_player_created_idx" ON "shop_transactions" USING btree ("player_id","created_at");