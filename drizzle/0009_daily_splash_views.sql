CREATE TABLE "player_daily_splash_views" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_daily_splash_views_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"splash_date" date NOT NULL,
	"shown_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_daily_splash_views" ADD CONSTRAINT "player_daily_splash_views_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_daily_splash_views_player_date_uq" ON "player_daily_splash_views" USING btree ("player_id","splash_date");
