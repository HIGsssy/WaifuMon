ALTER TABLE artwork_assets DROP CONSTRAINT artwork_assets_category_check;
--> statement-breakpoint
ALTER TABLE artwork_assets ADD CONSTRAINT artwork_assets_category_check CHECK (category IN ('dungeon_zone','dungeon_background','enemy_sprite','dungeon_scene_sprite','enemy_art','event_art','npc_portrait','equipment_art','boss_art'));
--> statement-breakpoint
CREATE TABLE dungeon_scene_sprites (
  sprite_key text PRIMARY KEY,
  definition jsonb NOT NULL,
  asset_id uuid NOT NULL REFERENCES artwork_assets(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
--> statement-breakpoint
CREATE TABLE dungeon_scene_sprite_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sprite_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','archived','restored','deleted')),
  actor text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX dungeon_scene_sprite_events_key_idx ON dungeon_scene_sprite_events (sprite_key, id DESC);
