CREATE TABLE "player_daily_quests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_daily_quests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"quest_date" date NOT NULL,
	"quest_slug" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"description_snapshot" text NOT NULL,
	"type" text NOT NULL,
	"rarity_at_least" text,
	"target" integer NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"rewards_json" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_daily_quests_target_check" CHECK ("target" > 0),
	CONSTRAINT "player_daily_quests_progress_check" CHECK ("progress" >= 0)
);
--> statement-breakpoint
ALTER TABLE "player_daily_quests" ADD CONSTRAINT "player_daily_quests_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_daily_quests_player_date_slug_uq" ON "player_daily_quests" USING btree ("player_id","quest_date","quest_slug");--> statement-breakpoint
CREATE INDEX "player_daily_quests_player_date_idx" ON "player_daily_quests" USING btree ("player_id","quest_date");
