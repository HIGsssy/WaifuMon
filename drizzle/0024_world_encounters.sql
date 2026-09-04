-- World Encounters — the interactive encounter foundation.
--
-- Hand-written, matching the repository convention since 0005: the drizzle
-- kit snapshots stop at 0004 and 0010, so a generated migration would diff
-- against a stale baseline and re-emit every existing table.
--
-- Seven purely-additive tables. All FKs to `world_encounters` cascade on
-- delete so an admin removing a draft encounter also removes its rows in the
-- child tables; deletion of an *active* encounter is guarded at the service
-- layer (a definition with any history row is disabled, never dropped).
--
-- Idempotency rails:
--
--   * `active_world_encounters_player_pending_uq` is the partial unique
--     index — one pending encounter per player, enforced by the database.
--     Same technique as `encounters_active_player_uq` and
--     `boss_encounters_active_guild_uq`: a double-clicked hunt or travel
--     races on the insert and exactly one process wins.
--
--   * `world_encounter_cooldowns` PK is composite `(player_id, encounter_id)`,
--     so re-writing a cooldown is an ON CONFLICT DO UPDATE rather than an
--     append-only ledger — a single row per pairing, updated in-place.
--
-- Region and route eligibility live in junction tables. An encounter with
-- **no** rows in either is treated as globally eligible for its enabled
-- sources; keeping the empty-set meaning out of the row shape is what makes
-- travel-only global encounters (Bandit Ambush) light on rows.
CREATE TABLE "world_encounters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "world_encounters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"rarity" text NOT NULL,
	"weight" integer DEFAULT 10 NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"hunt_eligible" boolean DEFAULT true NOT NULL,
	"travel_eligible" boolean DEFAULT false NOT NULL,
	"cooldown_seconds" integer DEFAULT 0 NOT NULL,
	"artwork_path" text,
	"chained_encounter_slug" text,
	"choices_required" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_encounters_type_check" CHECK ("type" in ('decision','skill_check','combat','vendor','deity','discovery')),
	CONSTRAINT "world_encounters_rarity_check" CHECK ("rarity" in ('common','uncommon','rare','mythic')),
	CONSTRAINT "world_encounters_lifecycle_check" CHECK ("lifecycle" in ('draft','active','disabled')),
	CONSTRAINT "world_encounters_weight_check" CHECK ("weight" > 0),
	CONSTRAINT "world_encounters_cooldown_check" CHECK ("cooldown_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "world_encounter_regions" (
	"encounter_id" bigint NOT NULL,
	"region_id" text NOT NULL,
	PRIMARY KEY ("encounter_id","region_id"),
	CONSTRAINT "world_encounter_regions_region_check" CHECK ("region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands'))
);
--> statement-breakpoint
CREATE TABLE "world_encounter_routes" (
	"encounter_id" bigint NOT NULL,
	"from_region" text NOT NULL,
	"to_region" text NOT NULL,
	PRIMARY KEY ("encounter_id","from_region","to_region"),
	CONSTRAINT "world_encounter_routes_from_check" CHECK ("from_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands')),
	CONSTRAINT "world_encounter_routes_to_check" CHECK ("to_region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands')),
	CONSTRAINT "world_encounter_routes_distinct" CHECK ("from_region" <> "to_region")
);
--> statement-breakpoint
CREATE TABLE "world_encounter_choices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "world_encounter_choices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"encounter_id" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"emoji" text,
	"requirements_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"check_json" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"success_effects_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_effects_json" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_encounter_cooldowns" (
	"player_id" bigint NOT NULL,
	"encounter_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	PRIMARY KEY ("player_id","encounter_id")
);
--> statement-breakpoint
CREATE TABLE "active_world_encounters" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "active_world_encounters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"encounter_id" bigint NOT NULL,
	"source" text NOT NULL,
	"region_id" text NOT NULL,
	"origin_region_id" text,
	"destination_region_id" text,
	"guild_id" bigint,
	"channel_id" text,
	"message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_choice_id" bigint,
	"resolution_json" jsonb,
	CONSTRAINT "active_world_encounters_source_check" CHECK ("source" in ('hunt','travel')),
	CONSTRAINT "active_world_encounters_status_check" CHECK ("status" in ('pending','resolved','expired','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "world_encounter_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "world_encounter_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"encounter_id" bigint NOT NULL,
	"choice_id" bigint,
	"source" text NOT NULL,
	"region_id" text NOT NULL,
	"success" boolean,
	"effects_applied_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_encounter_history_source_check" CHECK ("source" in ('hunt','travel'))
);
--> statement-breakpoint
ALTER TABLE "world_encounter_regions" ADD CONSTRAINT "world_encounter_regions_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_routes" ADD CONSTRAINT "world_encounter_routes_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_choices" ADD CONSTRAINT "world_encounter_choices_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_cooldowns" ADD CONSTRAINT "world_encounter_cooldowns_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_cooldowns" ADD CONSTRAINT "world_encounter_cooldowns_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_world_encounters" ADD CONSTRAINT "active_world_encounters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_world_encounters" ADD CONSTRAINT "active_world_encounters_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_history" ADD CONSTRAINT "world_encounter_history_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_encounter_history" ADD CONSTRAINT "world_encounter_history_encounter_id_world_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."world_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "world_encounters_lifecycle_idx" ON "world_encounters" USING btree ("lifecycle");--> statement-breakpoint
CREATE INDEX "world_encounter_regions_region_idx" ON "world_encounter_regions" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "world_encounter_routes_route_idx" ON "world_encounter_routes" USING btree ("from_region","to_region");--> statement-breakpoint
CREATE INDEX "world_encounter_choices_encounter_idx" ON "world_encounter_choices" USING btree ("encounter_id","sort_order");--> statement-breakpoint
CREATE INDEX "world_encounter_cooldowns_expires_idx" ON "world_encounter_cooldowns" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "active_world_encounters_player_pending_uq" ON "active_world_encounters" USING btree ("player_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "active_world_encounters_player_idx" ON "active_world_encounters" USING btree ("player_id","status");--> statement-breakpoint
CREATE INDEX "active_world_encounters_expires_idx" ON "active_world_encounters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "world_encounter_history_player_idx" ON "world_encounter_history" USING btree ("player_id","resolved_at");--> statement-breakpoint
CREATE INDEX "world_encounter_history_encounter_idx" ON "world_encounter_history" USING btree ("encounter_id","resolved_at");
