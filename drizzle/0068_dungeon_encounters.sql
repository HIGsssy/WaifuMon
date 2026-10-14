-- Phase 4 Dungeon Encounters. A selection must survive a retreat, which erases
-- the action record it would otherwise live in, so it is kept beside
-- event_states. Existing and active runs read {}: they hold no encounters.
ALTER TABLE "dungeon_runs" ADD COLUMN "encounter_states" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Three new history types: who an encounter presented, each capture attempt, and each copy granted.
ALTER TABLE "dungeon_run_events" DROP CONSTRAINT "dungeon_run_events_type_check";--> statement-breakpoint
ALTER TABLE "dungeon_run_events" ADD CONSTRAINT "dungeon_run_events_type_check" CHECK ("type" in ('run_started','room_entered','action_skipped','action_declined','combat_wave_resolved','action_completed','action_failed','room_completed','room_retreated','connection_taken','extraction','defeat','completion','abandon','currency_banked','rewards_granted','event_selected','items_consumed','encounter_selected','capture_attempted','waifu_acquired'));--> statement-breakpoint
-- One row per copy a dungeon granted. It answers "how many has this player
-- taken from this dungeon" for a species' per-player limit, and is the audit
-- trail for exclusives. The grant key is the one on player_waifus.
CREATE TABLE "dungeon_species_acquisitions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dungeon_species_acquisitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"species_id" bigint NOT NULL,
	"dungeon_key" text NOT NULL,
	"run_id" bigint NOT NULL,
	"room_id" text NOT NULL,
	"action_id" text NOT NULL,
	"mode" text NOT NULL,
	"waifu_id" bigint NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dungeon_species_acquisitions_mode_check" CHECK ("mode" in ('capture','rescue_capture','rescue_direct'))
);--> statement-breakpoint
ALTER TABLE "dungeon_species_acquisitions" ADD CONSTRAINT "dungeon_species_acquisitions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dungeon_species_acquisitions" ADD CONSTRAINT "dungeon_species_acquisitions_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dungeon_species_acquisitions" ADD CONSTRAINT "dungeon_species_acquisitions_run_id_dungeon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."dungeon_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dungeon_species_acquisitions" ADD CONSTRAINT "dungeon_species_acquisitions_waifu_id_player_waifus_id_fk" FOREIGN KEY ("waifu_id") REFERENCES "public"."player_waifus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dungeon_species_acquisitions_grant_key_uq" ON "dungeon_species_acquisitions" USING btree ("grant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dungeon_species_acquisitions_waifu_uq" ON "dungeon_species_acquisitions" USING btree ("waifu_id");--> statement-breakpoint
CREATE INDEX "dungeon_species_acquisitions_player_dungeon_species_idx" ON "dungeon_species_acquisitions" USING btree ("player_id","dungeon_key","species_id");
