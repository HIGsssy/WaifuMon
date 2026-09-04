-- Global World Encounter runtime tuning, as a database row.
--
-- These four values were read from `content/tables.json`, so changing an
-- encounter rate meant editing content and reloading. They are the knobs an
-- operator turns while watching a live server, so they move to a table that
-- Portal Admin writes and the engine reads — no rebuild, no redeploy, no
-- content reload.
--
-- A singleton table, enforced by the CHECK on `id`: "the settings" is always
-- exactly one row, so nothing downstream has to decide which row wins.
--
-- The range CHECKs duplicate the API's validation on purpose. These values set
-- the game's pacing, and a bad one does not raise an error — it silently makes
-- encounters impossible, or expires them instantly. The API is the friendly
-- guard; this is the one that cannot be bypassed.
--
-- Defaults mirror the shipped content values exactly (0.35 / 0.2 / 600), so a
-- deployment that applies this migration and never opens the panel behaves
-- precisely as it did before the table existed. No seed edit, no data
-- backfill, and no existing encounter definition is touched.
CREATE TABLE "world_encounter_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"hunt_chance" real DEFAULT 0.35 NOT NULL,
	"travel_chance" real DEFAULT 0.2 NOT NULL,
	"default_expiry_seconds" integer DEFAULT 600 NOT NULL,
	"force_trigger" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "world_encounter_settings_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "world_encounter_settings_hunt_chance_check" CHECK ("hunt_chance" >= 0 and "hunt_chance" <= 1),
	CONSTRAINT "world_encounter_settings_travel_chance_check" CHECK ("travel_chance" >= 0 and "travel_chance" <= 1),
	CONSTRAINT "world_encounter_settings_expiry_check" CHECK ("default_expiry_seconds" >= 30 and "default_expiry_seconds" <= 86400)
);
