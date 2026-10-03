-- Managed artwork: images uploaded through Portal Admin, usable without a
-- Git commit.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0053. After
-- 0053 (region compatibility) and independent of it: no existing row or
-- stored dungeon document is rewritten here.
--
-- ── artwork_assets ────────────────────────────────────────────────────────
--
-- One row per logical asset. The image bytes are NOT here: they live in the
-- artwork storage (a persistent directory in V1, an object store later) under
-- `storage_key`, a name the server generates. Authored content references an
-- asset by `id` and never by path.
--
--   id            the stable logical id. Replacing the image keeps it, so
--                 every reference shows the replacement.
--   category      what the asset is for; drives pickers and nothing else.
--   name          display label, editable. Never a path.
--   original_filename  the uploader's file name, sanitised to a base name.
--                 Informational only — it never reaches the filesystem.
--   storage_key   `<category>/<id>/<content_hash>.<ext>`.
--   content_hash  sha256 of the stored bytes: the ETag, the cache-busting
--                 version, and the scene compositor's cache key input.
--   version       1 on upload, +1 per replacement.
--   status        'active' | 'disabled' (kept, not used — references fall
--                 back to shipped art) | 'deleted' (soft: bytes removed, row
--                 kept for the audit trail). A referenced asset cannot be
--                 deleted.
--
-- ── artwork_asset_events ──────────────────────────────────────────────────
--
-- Append-only audit: upload, replace, rename, disable, enable, delete, and
-- every change to what references an asset. Hashes and ids only — never
-- image bytes.
--
-- ── combat_enemy_artwork ──────────────────────────────────────────────────
--
-- Enemies are file content (`content/combat/enemies.json`), so their managed
-- artwork is an overlay keyed by enemy key rather than a field in the file:
-- an optional full-art asset, an optional transparent sprite asset, and the
-- sprite's default placement in a composed scene. No row means "shipped art
-- only". No FK on `enemy_key` (it names file content); the asset FKs are
-- RESTRICT so a referenced asset row can never vanish.
--
-- Every statement is idempotent.

CREATE TABLE IF NOT EXISTS "artwork_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"has_alpha" boolean NOT NULL DEFAULT false,
	"file_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"status" text NOT NULL DEFAULT 'active',
	"uploaded_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"replaced_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artwork_assets_category_check" CHECK ("category" in ('dungeon_zone','dungeon_background','enemy_sprite','enemy_art','event_art','npc_portrait','equipment_art')),
	CONSTRAINT "artwork_assets_mime_check" CHECK ("mime_type" in ('image/png','image/webp','image/jpeg')),
	CONSTRAINT "artwork_assets_status_check" CHECK ("status" in ('active','disabled','deleted')),
	CONSTRAINT "artwork_assets_dimensions_check" CHECK ("width" >= 1 and "height" >= 1 and "file_size" >= 1),
	CONSTRAINT "artwork_assets_version_check" CHECK ("version" >= 1),
	CONSTRAINT "artwork_assets_deleted_check" CHECK (("status" = 'deleted') = ("deleted_at" is not null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artwork_assets_category_idx"
	ON "artwork_assets" USING btree ("category", "status", "updated_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artwork_asset_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "artwork_assets"("id"),
	"action" text NOT NULL,
	"actor" text,
	"old_hash" text,
	"new_hash" text,
	"details" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "artwork_asset_events_action_check" CHECK ("action" in ('upload','replace','update','disable','enable','delete','reference_added','reference_removed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artwork_asset_events_asset_idx"
	ON "artwork_asset_events" USING btree ("asset_id", "id" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "combat_enemy_artwork" (
	"enemy_key" text PRIMARY KEY NOT NULL,
	"artwork_asset_id" uuid REFERENCES "artwork_assets"("id"),
	"sprite_asset_id" uuid REFERENCES "artwork_assets"("id"),
	"sprite_placement" jsonb,
	"revision" integer NOT NULL DEFAULT 1,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "combat_enemy_artwork_key_check" CHECK ("enemy_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "combat_enemy_artwork_revision_check" CHECK ("revision" >= 1)
);
