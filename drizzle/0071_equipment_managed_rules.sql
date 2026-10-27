-- Equipment 3.0 (E3-B): database-authoritative equipment roll rules and
-- managed affix libraries, with drafts, immutable published revisions,
-- rollback and an audit trail.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0070: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0070's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What this ships ───────────────────────────────────────────────────────
--
--   equipment_roll_config            one row (id = 1): the working draft and
--                                    the published pointer
--   equipment_roll_config_revisions  immutable published rule revisions
--   equipment_affix_libraries        one row per managed library: its draft
--                                    entries and published pointer
--   equipment_affix_library_revisions immutable published library revisions
--   equipment_admin_events           append-only audit trail for both
--
-- Schema only — no row is written here. The application bootstraps the rule
-- configuration once, at startup, from the shipped
-- `content/equipment/combatBonuses.json` (`equipmentRollRulesStore.ts`), and
-- never overwrites it afterwards. Managed affix libraries start empty; the
-- shipped `content/equipment/affixes.json` stays the N/R/SR source and is not
-- copied into these tables.
--
-- Nothing existing changes: `player_equipment`, `equipment_definitions` and
-- every owned roll are untouched, and no drop probability moves.
--
-- ── Rollback ──────────────────────────────────────────────────────────────
--
-- Purely additive. Dropping the five tables (and the trigger function) undoes
-- it, at the cost of every published revision and audit row; the shipped
-- JSON would then be the only rule source again, which is what pre-E3-B code
-- reads. Once E3-C grants copies from managed libraries, those copies keep
-- their rendered suffix in `player_equipment.rolled_properties`, so their
-- names survive even that.
--
-- Every statement is IF NOT EXISTS / OR REPLACE, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "equipment_roll_config_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equipment_roll_config_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" integer NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source" text NOT NULL,
	"rolled_back_from" bigint,
	"draft_revision" integer NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_roll_config_revisions_number_check" CHECK ("number" >= 1),
	CONSTRAINT "equipment_roll_config_revisions_hash_check" CHECK ("content_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "equipment_roll_config_revisions_source_check" CHECK ("source" in ('bootstrap','editor','import','rollback')),
	CONSTRAINT "equipment_roll_config_revisions_body_check" CHECK (jsonb_typeof("body") = 'object'),
	CONSTRAINT "equipment_roll_config_revisions_rolled_back_from_fk" FOREIGN KEY ("rolled_back_from") REFERENCES "public"."equipment_roll_config_revisions"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_roll_config_revisions_number_uq" ON "equipment_roll_config_revisions" USING btree ("number");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "equipment_roll_config" (
	"id" smallint PRIMARY KEY NOT NULL,
	"draft_body" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_hash" text NOT NULL,
	"published_revision_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "equipment_roll_config_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "equipment_roll_config_draft_revision_check" CHECK ("draft_revision" >= 1),
	CONSTRAINT "equipment_roll_config_draft_hash_check" CHECK ("draft_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "equipment_roll_config_draft_body_check" CHECK (jsonb_typeof("draft_body") = 'object'),
	CONSTRAINT "equipment_roll_config_published_revision_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."equipment_roll_config_revisions"("id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "equipment_affix_libraries" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"draft_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_hash" text NOT NULL,
	"published_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "equipment_affix_libraries_key_check" CHECK ("key" ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$' and char_length("key") <= 64 and "key" !~ '^legacy(_|$)'),
	CONSTRAINT "equipment_affix_libraries_name_check" CHECK (btrim("name") <> '' and char_length("name") <= 80),
	CONSTRAINT "equipment_affix_libraries_draft_revision_check" CHECK ("draft_revision" >= 1),
	CONSTRAINT "equipment_affix_libraries_draft_hash_check" CHECK ("draft_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "equipment_affix_libraries_draft_entries_check" CHECK (jsonb_typeof("draft_entries") = 'array')
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "equipment_affix_library_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equipment_affix_library_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"library_key" text NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"entries" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source" text NOT NULL,
	"rolled_back_from" bigint,
	"draft_revision" integer NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_affix_library_revisions_number_check" CHECK ("number" >= 1),
	CONSTRAINT "equipment_affix_library_revisions_hash_check" CHECK ("content_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "equipment_affix_library_revisions_source_check" CHECK ("source" in ('editor','import','rollback')),
	CONSTRAINT "equipment_affix_library_revisions_entries_check" CHECK (jsonb_typeof("entries") = 'array'),
	CONSTRAINT "equipment_affix_library_revisions_library_fk" FOREIGN KEY ("library_key") REFERENCES "public"."equipment_affix_libraries"("key"),
	CONSTRAINT "equipment_affix_library_revisions_rolled_back_from_fk" FOREIGN KEY ("rolled_back_from") REFERENCES "public"."equipment_affix_library_revisions"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_affix_library_revisions_number_uq" ON "equipment_affix_library_revisions" USING btree ("library_key","number");--> statement-breakpoint
ALTER TABLE "equipment_affix_libraries" DROP CONSTRAINT IF EXISTS "equipment_affix_libraries_published_revision_fk";--> statement-breakpoint
ALTER TABLE "equipment_affix_libraries" ADD CONSTRAINT "equipment_affix_libraries_published_revision_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."equipment_affix_library_revisions"("id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "equipment_admin_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equipment_admin_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_admin_events_subject_kind_check" CHECK ("subject_kind" in ('roll_rules','affix_library')),
	CONSTRAINT "equipment_admin_events_action_check" CHECK ("action" in ('bootstrapped','drift_detected','created','updated','draft_saved','draft_imported','published','rolled_back')),
	CONSTRAINT "equipment_admin_events_details_check" CHECK (jsonb_typeof("details") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_admin_events_subject_idx" ON "equipment_admin_events" USING btree ("subject_kind","subject_key","id" DESC);--> statement-breakpoint

-- A published revision is immutable. The application never updates or
-- deletes one; this makes that a property of the database.
CREATE OR REPLACE FUNCTION "equipment_revisions_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "equipment_roll_config_revisions_immutable_trg" ON "equipment_roll_config_revisions";--> statement-breakpoint
CREATE TRIGGER "equipment_roll_config_revisions_immutable_trg"
	BEFORE UPDATE OR DELETE ON "equipment_roll_config_revisions"
	FOR EACH ROW EXECUTE FUNCTION "equipment_revisions_immutable"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "equipment_affix_library_revisions_immutable_trg" ON "equipment_affix_library_revisions";--> statement-breakpoint
CREATE TRIGGER "equipment_affix_library_revisions_immutable_trg"
	BEFORE UPDATE OR DELETE ON "equipment_affix_library_revisions"
	FOR EACH ROW EXECUTE FUNCTION "equipment_revisions_immutable"();
