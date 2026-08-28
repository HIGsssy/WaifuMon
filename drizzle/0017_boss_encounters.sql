-- Boss Encounters, Stage 1.
--
-- Hand-written, following this repository's convention since 0005: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline and re-emit tables that already exist. The journal
-- entry's `when` is likewise set *above* 0016's, because the node-postgres
-- migrator skips any entry whose folder timestamp is not greater than the last
-- applied one — a `Date.now()` stamp would be smaller than these far-future
-- values and the migration would silently never run.
--
-- Four additions, all purely additive:
--
--   1. `guilds.boss_channel_id` — the dedicated venue. Null (the value every
--      existing row takes) means bosses are off for that guild, which is the
--      correct state for every guild that has not opted in.
--   2. `guild_boss_state` — per-guild scheduler state: the persistent shuffle
--      bag, the next appearance, and the pause/suspend flags. Created lazily
--      per guild, so no backfill is needed or wanted.
--   3. `boss_encounters` — one row per appearance, with the boss's content
--      snapshotted onto it so a later content edit cannot rewrite history.
--   4. `boss_participations` — one row per committed buddy, carrying every
--      stat the damage formula reads, frozen at commitment.
--
-- Two indexes carry real invariants rather than just speed:
--
--   * `boss_encounters_active_guild_uq` is a *partial* unique index over the
--     three live statuses. It is what makes "one active encounter per guild"
--     true under two bot processes ticking simultaneously: both insert, one
--     gets a unique violation and reads it as "someone else already spawned".
--     Same technique as `encounters_active_player_uq` from 0000.
--   * `boss_participations_encounter_player_uq` is what makes a double-clicked
--     Commit button safe rather than merely unlikely.
--
-- `boss_participations.waifu_id` deliberately carries **no** foreign key,
-- matching `players.buddy_waifu_id` and the affection-gift rows: releasing an
-- owned copy must not take a historical battle result with it.
ALTER TABLE "guilds" ADD COLUMN "boss_channel_id" text;--> statement-breakpoint
CREATE TABLE "guild_boss_state" (
	"guild_id" bigint PRIMARY KEY NOT NULL,
	"region" text DEFAULT 'waifu-valley' NOT NULL,
	"bag_state" jsonb,
	"next_spawn_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"suspended_reason" text,
	"suspended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_boss_state_region_check" CHECK ("region" in ('waifu-valley'))
);
--> statement-breakpoint
CREATE TABLE "boss_encounters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "boss_encounters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" bigint NOT NULL,
	"region" text NOT NULL,
	"boss_id" text NOT NULL,
	"boss_name" text NOT NULL,
	"boss_affinity" text NOT NULL,
	"boss_artwork" text,
	"reward_table" text NOT NULL,
	"reward_table_version" text NOT NULL,
	"calc_version" integer NOT NULL,
	"affinity_version" integer NOT NULL,
	"channel_id" text,
	"message_id" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"scouting_started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"resolving_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"next_spawn_at" timestamp with time zone,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"total_damage" bigint DEFAULT 0 NOT NULL,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boss_encounters_status_check" CHECK ("status" in ('scheduled','scouting','resolving','resolved','cancelled')),
	CONSTRAINT "boss_encounters_reason_check" CHECK ("resolution_reason" is null or "resolution_reason" in ('repelled','unchallenged','cancelled_admin','channel_lost')),
	CONSTRAINT "boss_encounters_participants_check" CHECK ("participant_count" >= 0),
	CONSTRAINT "boss_encounters_damage_check" CHECK ("total_damage" >= 0)
);
--> statement-breakpoint
CREATE TABLE "boss_participations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "boss_participations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"encounter_id" bigint NOT NULL,
	"player_id" bigint NOT NULL,
	"discord_user_id" text NOT NULL,
	"trainer_name" text NOT NULL,
	"waifu_id" bigint NOT NULL,
	"species_id" bigint NOT NULL,
	"species_slug" text NOT NULL,
	"waifu_name" text NOT NULL,
	"level" integer NOT NULL,
	"base_sp" integer NOT NULL,
	"current_sp" integer NOT NULL,
	"rarity" text NOT NULL,
	"affinity" text NOT NULL,
	"race" text NOT NULL,
	"affection" integer NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_bonus" real DEFAULT 0 NOT NULL,
	"affinity_bonus" real DEFAULT 0 NOT NULL,
	"performance_percent" integer,
	"attack_count" integer,
	"total_damage" bigint,
	"xp_awarded" integer,
	"reward_items" jsonb,
	"reward_status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "boss_participations_level_check" CHECK ("level" >= 1),
	CONSTRAINT "boss_participations_sp_check" CHECK ("current_sp" >= 0 and "base_sp" >= 1),
	CONSTRAINT "boss_participations_damage_check" CHECK ("total_damage" is null or "total_damage" >= 0),
	CONSTRAINT "boss_participations_xp_check" CHECK ("xp_awarded" is null or "xp_awarded" >= 0),
	CONSTRAINT "boss_participations_reward_status_check" CHECK ("reward_status" in ('pending','applied'))
);
--> statement-breakpoint
ALTER TABLE "guild_boss_state" ADD CONSTRAINT "guild_boss_state_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boss_encounters" ADD CONSTRAINT "boss_encounters_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boss_participations" ADD CONSTRAINT "boss_participations_encounter_id_boss_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."boss_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boss_participations" ADD CONSTRAINT "boss_participations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boss_encounters_active_guild_uq" ON "boss_encounters" USING btree ("guild_id") WHERE status in ('scheduled','scouting','resolving');--> statement-breakpoint
CREATE INDEX "boss_encounters_guild_status_idx" ON "boss_encounters" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "boss_encounters_deadline_idx" ON "boss_encounters" USING btree ("deadline_at") WHERE status = 'scouting';--> statement-breakpoint
CREATE INDEX "boss_encounters_message_idx" ON "boss_encounters" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boss_participations_encounter_player_uq" ON "boss_participations" USING btree ("encounter_id","player_id");--> statement-breakpoint
CREATE INDEX "boss_participations_encounter_idx" ON "boss_participations" USING btree ("encounter_id","id");--> statement-breakpoint
CREATE INDEX "boss_participations_player_idx" ON "boss_participations" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "boss_participations_waifu_idx" ON "boss_participations" USING btree ("waifu_id");--> statement-breakpoint
CREATE INDEX "boss_participations_pending_idx" ON "boss_participations" USING btree ("encounter_id") WHERE reward_status = 'pending';
