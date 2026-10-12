CREATE TABLE "dungeon_loot_tables" (
  "table_key" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "tier" text,
  "body" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "archived_at" timestamptz,
  "origin" text NOT NULL DEFAULT 'portal',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text,
  CONSTRAINT "dungeon_loot_tables_key_check" CHECK (char_length("table_key") <= 64 AND "table_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  CONSTRAINT "dungeon_loot_tables_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  CONSTRAINT "dungeon_loot_tables_description_check" CHECK (char_length("description") <= 600),
  CONSTRAINT "dungeon_loot_tables_tier_check" CHECK ("tier" IN ('common','rare','boss','legendary')),
  CONSTRAINT "dungeon_loot_tables_body_check" CHECK (jsonb_typeof("body") = 'object'),
  CONSTRAINT "dungeon_loot_tables_hash_check" CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "dungeon_loot_tables_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "dungeon_loot_tables_origin_check" CHECK ("origin" IN ('portal','import','converted','seed'))
);
--> statement-breakpoint
CREATE INDEX "dungeon_loot_tables_active_tier_name_idx" ON "dungeon_loot_tables" ("tier", "name", "table_key") WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION "dungeon_loot_tables_immutable_key"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.table_key IS DISTINCT FROM OLD.table_key THEN
    RAISE EXCEPTION 'Dungeon loot table keys are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dungeon_loot_tables_immutable_key" BEFORE UPDATE ON "dungeon_loot_tables"
  FOR EACH ROW EXECUTE FUNCTION "dungeon_loot_tables_immutable_key"();
--> statement-breakpoint
-- Deliberately no catalogue FK: events remain after deletion and key reuse.
CREATE TABLE "dungeon_loot_table_events" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "table_key" text NOT NULL,
  "action" text NOT NULL,
  "actor" text,
  "revision" integer NOT NULL,
  "origin" text NOT NULL,
  "previous_content_hash" text,
  "new_content_hash" text,
  "details" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dungeon_loot_table_events_key_check" CHECK (char_length("table_key") <= 64 AND "table_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  CONSTRAINT "dungeon_loot_table_events_action_check" CHECK ("action" IN ('created','updated','archived','restored','deleted','duplicated','imported','converted')),
  CONSTRAINT "dungeon_loot_table_events_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "dungeon_loot_table_events_origin_check" CHECK ("origin" IN ('portal','import','converted','seed')),
  CONSTRAINT "dungeon_loot_table_events_previous_hash_check" CHECK ("previous_content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "dungeon_loot_table_events_new_hash_check" CHECK ("new_content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "dungeon_loot_table_events_details_check" CHECK (jsonb_typeof("details") = 'object')
);
--> statement-breakpoint
CREATE INDEX "dungeon_loot_table_events_key_idx" ON "dungeon_loot_table_events" ("table_key", "id" DESC);
--> statement-breakpoint
CREATE FUNCTION "dungeon_loot_table_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dungeon loot table events are append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dungeon_loot_table_events_append_only" BEFORE UPDATE OR DELETE ON "dungeon_loot_table_events"
  FOR EACH ROW EXECUTE FUNCTION "dungeon_loot_table_events_append_only"();
--> statement-breakpoint
CREATE TRIGGER "dungeon_loot_table_events_no_truncate" BEFORE TRUNCATE ON "dungeon_loot_table_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "dungeon_loot_table_events_append_only"();
