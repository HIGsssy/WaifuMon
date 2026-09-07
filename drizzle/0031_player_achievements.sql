-- Player achievement state (Achievements & Leaderboards, Phase 1).
--
-- The only durable achievement data. Definitions, criteria, categories and the
-- hidden flag live in content (`content/achievements.json`); this table holds
-- nothing an admin edits — just the one fact current state cannot reconstruct:
-- *when* a badge was first earned.
--
-- Achievements are otherwise derived: progress is computed on read from
-- canonical player state (level, collection, captures, buddy, bosses…). A row
-- appears here the first time an achievement is observed unlocked, stamping
-- `unlocked_at`. Once earned a badge must never revert even if the underlying
-- metric later dips (a released copy, a re-tuned threshold), so unlock is a
-- one-way write and this row is never deleted by gameplay.
--
-- `achievement_id` is the content slug, soft-typed on purpose: adding or
-- retiring an achievement is a content edit, never a migration. A row whose id
-- no longer matches any definition is simply not surfaced.
--
-- Additive in effect as well as form: applying it to an existing database
-- awards nobody anything. Every derived achievement a player already qualifies
-- for is materialised lazily on their next Achievements read, with an
-- `unlocked_at` of first-observation — deliberately *not* backdated, because
-- the true unlock time is not reconstructable from current state.
CREATE TABLE "player_achievements" (
	"player_id" bigint NOT NULL,
	"achievement_id" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_achievements_player_id_achievement_id_pk" PRIMARY KEY("player_id","achievement_id"),
	CONSTRAINT "player_achievements_progress_check" CHECK ("player_achievements"."progress" >= 0)
);
--> statement-breakpoint
ALTER TABLE "player_achievements" ADD CONSTRAINT "player_achievements_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_achievements_player_idx" ON "player_achievements" USING btree ("player_id");
