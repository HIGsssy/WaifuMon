CREATE TABLE "waifumon_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "waifumon_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" bigint NOT NULL,
	"player_id" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"current_screen" text DEFAULT 'menu' NOT NULL,
	"summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waifumon_sessions" ADD CONSTRAINT "waifumon_sessions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waifumon_sessions" ADD CONSTRAINT "waifumon_sessions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waifumon_sessions_player_channel_uq" ON "waifumon_sessions" USING btree ("player_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waifumon_sessions_message_id_uq" ON "waifumon_sessions" USING btree ("message_id") WHERE message_id is not null;
