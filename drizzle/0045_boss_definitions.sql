-- ── boss_definitions ──────────────────────────────────────────────────────
-- Boss definitions were file content only (content/bosses.json); they are
-- now rows, authored in Portal Admin → Boss Management. The scheduler draws
-- from this table and from nothing else.
--
-- This migration creates the table EMPTY on purpose: the shipped bosses live
-- in a JSON file a migration cannot read, so the first startup after it
-- inserts them (`bootstrapBossDefinitions`). That bootstrap only ever INSERTS
-- a boss whose key has no row — it never updates one. After the first start
-- the file is bootstrap data and this table is the authority.
--
-- `status` replaces the file's `enabled` flag: `enabled: true` arrives as
-- 'active', `enabled: false` as 'disabled'. 'draft' is for a boss still being
-- written; only 'active' bosses can spawn. `regions` replaces the file's
-- single `region` with a list (a one-element list for every shipped boss).
-- `schedule` is the availability schedule (`BossSchedule`): a timezone plus
-- optional weekly rules and an optional date range; the default is "always".
CREATE TABLE IF NOT EXISTS "boss_definitions" (
	"boss_key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"affinity" text NOT NULL,
	"regions" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"status" text NOT NULL DEFAULT 'draft',
	"artwork" text,
	"reward_table" text NOT NULL DEFAULT '',
	"scouting_text" text NOT NULL DEFAULT '',
	"repelled_text" text NOT NULL DEFAULT '',
	"unchallenged_text" text NOT NULL DEFAULT '',
	"description" text NOT NULL DEFAULT '',
	"schedule" jsonb NOT NULL DEFAULT '{"timezone":"America/Toronto","weekly":null,"dateRange":null}'::jsonb,
	"revision" integer NOT NULL DEFAULT 1,
	"source" text NOT NULL DEFAULT 'portal',
	"position" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "boss_definitions_key_check" CHECK ("boss_key" ~ '^[a-z0-9_]+$'),
	CONSTRAINT "boss_definitions_status_check" CHECK ("status" in ('draft','active','disabled')),
	CONSTRAINT "boss_definitions_affinity_check" CHECK ("affinity" in ('dominant','submissive','caregiver','primal','switch')),
	CONSTRAINT "boss_definitions_source_check" CHECK ("source" in ('bootstrap','portal','import')),
	CONSTRAINT "boss_definitions_revision_check" CHECK ("revision" >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boss_definitions_position_idx"
	ON "boss_definitions" USING btree ("position", "boss_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boss_definitions_status_idx"
	ON "boss_definitions" USING btree ("status");--> statement-breakpoint
-- ── boss_definition_events ────────────────────────────────────────────────
-- Append-only audit trail for Boss Management, in the shape of
-- `artwork_asset_events`: who did what to which boss, and when. Also carries
-- the operator actions on live encounters (manual spawn, schedule override,
-- manual end). `boss_key` has no foreign key so the trail outlives a deleted
-- definition.
CREATE TABLE IF NOT EXISTS "boss_definition_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"boss_key" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"details" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "boss_definition_events_action_check" CHECK ("action" in ('bootstrap','create','update','status','duplicate','delete','import','manual_spawn','schedule_override','manual_end'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boss_definition_events_boss_idx"
	ON "boss_definition_events" USING btree ("boss_key", "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boss_definition_events_recent_idx"
	ON "boss_definition_events" USING btree ("id" DESC);--> statement-breakpoint
-- ── boss_encounters.boss_snapshot ─────────────────────────────────────────
-- The boss's player-facing prose as it stood at spawn. The name, affinity,
-- artwork and reward table were already frozen onto the encounter row; the
-- four text fields were read live from content. Now that an admin can edit a
-- boss at any moment, they are frozen too, so an edit reaches the next
-- encounter and never one already announced. Null on encounters spawned
-- before this migration, which read the live definition as they always did.
ALTER TABLE "boss_encounters" ADD COLUMN IF NOT EXISTS "boss_snapshot" jsonb;
