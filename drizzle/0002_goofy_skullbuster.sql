CREATE TABLE "capture_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "capture_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"encounter_id" bigint NOT NULL,
	"player_id" bigint NOT NULL,
	"attempt_number" integer NOT NULL,
	"item_id" bigint NOT NULL,
	"computed_chance" real NOT NULL,
	"roll" real NOT NULL,
	"success" boolean NOT NULL,
	"guaranteed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_waifus" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_waifus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"species_id" bigint NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"affection" integer DEFAULT 0 NOT NULL,
	"nickname" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"variant" text DEFAULT 'standard' NOT NULL,
	"cosmetics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caught_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "player_waifus_level_check" CHECK ("player_waifus"."level" >= 1),
	CONSTRAINT "player_waifus_xp_check" CHECK ("player_waifus"."xp" >= 0),
	CONSTRAINT "player_waifus_affection_check" CHECK ("player_waifus"."affection" >= 0)
);
--> statement-breakpoint
ALTER TABLE "capture_attempts" ADD CONSTRAINT "capture_attempts_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_attempts" ADD CONSTRAINT "capture_attempts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_attempts" ADD CONSTRAINT "capture_attempts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD CONSTRAINT "player_waifus_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD CONSTRAINT "player_waifus_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capture_attempts_encounter_number_uq" ON "capture_attempts" USING btree ("encounter_id","attempt_number");--> statement-breakpoint
CREATE INDEX "capture_attempts_encounter_idx" ON "capture_attempts" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "player_waifus_player_idx" ON "player_waifus" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "player_waifus_player_species_idx" ON "player_waifus" USING btree ("player_id","species_id");