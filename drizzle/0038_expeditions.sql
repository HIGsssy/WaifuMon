-- Expeditions Phase 3 — the expedition state table.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0037: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0037's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- Purely additive: one new table, referenced by nothing that exists today.
--
-- ── Why the columns are shaped this way ────────────────────────────────────
--
-- `slot_index` — which of the player's expedition slots this mission occupies.
-- V1 offers exactly one because `tables.expeditions.maxConcurrent` is 1, but
-- the table is keyed by (player, slot) rather than by player alone, so
-- unlocking a second slot later is a content edit and a service-side cap
-- rather than a migration. The cap is deliberately NOT a CHECK here: a CHECK
-- would put the migration back.
--
-- `expedition_key` / `region` are *recorded*, not referenced. Content is not a
-- table, and a definition may be edited, disabled or deleted while a mission
-- is in flight.
--
-- `waifu_id` carries no foreign key, matching the documented precedent for
-- `players.buddy_waifu_id` and `players.care_mode_waifu_id`.
--
-- `resolution_plan` is the immutable contract: the reward tables and display
-- metadata copied out of content at deployment. Once it is written, resolution
-- reads nothing from the live content snapshot — which is what lets a content
-- deploy, a retune or a deletion affect future deployments only. It is cleared
-- at resolution in the same statement that writes `rewards`, because by then
-- it can never be needed again and keeping it would store every historical
-- mission's tables forever for no reader.
--
-- `rewards` is a resolved payload, not a table reference: what the player won
-- must survive an edit to the table they won it from, and claiming must never
-- roll anything.
--
-- ── Why the constraints are shaped this way ────────────────────────────────
--
-- The four shape CHECKs make the state machine's illegal states
-- unrepresentable rather than merely unreached:
--
--   active     → resolved_at NULL, cancelled_at NULL, outcome NULL
--   resolved   → resolved_at SET,  outcome SET
--   claimed    → resolved_at SET,  outcome SET, claimed_at SET
--   cancelled  → cancelled_at SET, outcome NULL   (never rolled, never paid)
--
-- The two partial unique indexes are the concurrency guarantee. One active
-- mission per (player, slot) means a double-clicked Deploy loses to a unique
-- violation rather than to a service-side count that read a stale value; one
-- active mission per waifu means a copy cannot be in two places at once, and
-- stays a separate rule from the first the moment a second slot exists.

CREATE TABLE IF NOT EXISTS "player_expeditions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_expeditions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"slot_index" integer DEFAULT 1 NOT NULL,
	"expedition_key" text NOT NULL,
	"region" text NOT NULL,
	"waifu_id" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completes_at" timestamp with time zone NOT NULL,
	"success_chance" real NOT NULL,
	"exceptional_chance" real NOT NULL,
	"suitability_band" text NOT NULL,
	"resolution_plan" jsonb,
	"resolution_roll" real,
	"outcome" text,
	"rewards" jsonb,
	"resolved_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"logic_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "player_expeditions_status_check" CHECK ("player_expeditions"."status" in ('active','resolved','claimed','cancelled')),
	CONSTRAINT "player_expeditions_outcome_check" CHECK ("player_expeditions"."outcome" is null or "player_expeditions"."outcome" in ('failure','success','exceptional')),
	CONSTRAINT "player_expeditions_slot_check" CHECK ("player_expeditions"."slot_index" >= 1),
	CONSTRAINT "player_expeditions_region_check" CHECK ("player_expeditions"."region" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085')),
	CONSTRAINT "player_expeditions_active_shape_check" CHECK (("player_expeditions"."status" = 'active') = ("player_expeditions"."resolved_at" is null and "player_expeditions"."cancelled_at" is null)),
	CONSTRAINT "player_expeditions_resolved_shape_check" CHECK (("player_expeditions"."resolved_at" is null) = ("player_expeditions"."outcome" is null)),
	CONSTRAINT "player_expeditions_claimed_shape_check" CHECK ("player_expeditions"."claimed_at" is null or "player_expeditions"."resolved_at" is not null),
	CONSTRAINT "player_expeditions_cancelled_shape_check" CHECK (("player_expeditions"."status" = 'cancelled') = ("player_expeditions"."cancelled_at" is not null))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_expeditions" ADD CONSTRAINT "player_expeditions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_expeditions_player_slot_active_uq" ON "player_expeditions" ("player_id","slot_index") WHERE "player_expeditions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_expeditions_waifu_active_uq" ON "player_expeditions" ("waifu_id") WHERE "player_expeditions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_expeditions_due_idx" ON "player_expeditions" ("completes_at") WHERE "player_expeditions"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_expeditions_player_history_idx" ON "player_expeditions" ("player_id","started_at");
