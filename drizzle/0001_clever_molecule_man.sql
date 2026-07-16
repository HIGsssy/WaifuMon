CREATE TABLE "encounters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "encounters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"species_id" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"public_message_id" text,
	"state" text DEFAULT 'active' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "encounters_state_check" CHECK ("encounters"."state" in ('active','captured','escaped','released','expired')),
	CONSTRAINT "encounters_attempts_check" CHECK ("encounters"."attempt_count" >= 0 and "encounters"."attempt_count" <= "encounters"."max_attempts")
);
--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounters_active_player_uq" ON "encounters" USING btree ("player_id") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "encounters_player_state_idx" ON "encounters" USING btree ("player_id","state");