CREATE TABLE "dungeon_import_history" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "request_id" uuid NOT NULL UNIQUE,
  "request_hash" text NOT NULL,
  "package_id" uuid NOT NULL,
  "package_hash" text NOT NULL,
  "source_environment" text NOT NULL,
  "dungeon_key" text NOT NULL,
  "actor" text,
  "decisions" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "imported_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "dungeon_import_history_key_idx" ON "dungeon_import_history" ("dungeon_key", "id" DESC);
--> statement-breakpoint
ALTER TABLE "dungeon_content_events" DROP CONSTRAINT "dungeon_content_events_action_check";
--> statement-breakpoint
ALTER TABLE "dungeon_content_events" ADD CONSTRAINT "dungeon_content_events_action_check"
  CHECK ("action" IN ('created','draft_saved','published','rolled_back','enabled','disabled','exported','imported','deleted'));
