ALTER TABLE "players" ADD COLUMN "care_mode_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "care_mode_last_tick_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "care_mode_waifu_id" bigint;
