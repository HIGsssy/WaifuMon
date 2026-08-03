CREATE TABLE "player_active_effects" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_active_effects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"effect_type" text NOT NULL,
	"source_item_slug" text NOT NULL,
	"modifier_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"charges_remaining" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_active_effects_charges_check" CHECK ("charges_remaining" >= 0)
);
--> statement-breakpoint
ALTER TABLE "player_active_effects" ADD CONSTRAINT "player_active_effects_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_active_effects_player_type_uq" ON "player_active_effects" USING btree ("player_id","effect_type");--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "price_currency" text DEFAULT 'waifubux' NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "effect_type" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "effect_config" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_price_currency_check" CHECK ("items"."price_currency" in ('waifubux','essence'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_effect_type_check" CHECK ("items"."effect_type" is null or "items"."effect_type" in ('restore_energy_full','capture_bonus_charges'));--> statement-breakpoint
ALTER TABLE "shop_transactions" ADD COLUMN "currency" text DEFAULT 'waifubux' NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_transactions" ADD CONSTRAINT "shop_transactions_currency_check" CHECK ("shop_transactions"."currency" in ('waifubux','essence'));
