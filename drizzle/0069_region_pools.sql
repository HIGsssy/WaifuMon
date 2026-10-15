-- Region Pools (RP2A): the database becomes authoritative for which species a
-- region's hunt can meet and at what region-local weight.
--
--   region_pools                  one row per canonical region: draft + published pointer
--   region_pool_revisions         immutable published revisions
--   region_pool_revision_entries  each revision's species, weights and authored order
--   region_pool_events            append-only audit trail
--
-- Schema only. No data is written here, and "region_encounter_pools" is not
-- touched: it stays the runtime projection the hunt reads. The application
-- bootstraps each region once from its shipped region file and projects the
-- published revision at startup (modules/regionPools/regionPoolStore.ts).
CREATE TABLE "region_pools" (
	"region_id" text PRIMARY KEY NOT NULL,
	"draft_entries" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"draft_hash" text NOT NULL,
	"published_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "region_pools_region_check" CHECK ("region_pools"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt')),
	CONSTRAINT "region_pools_draft_revision_check" CHECK ("region_pools"."draft_revision" >= 1),
	CONSTRAINT "region_pools_draft_hash_check" CHECK ("region_pools"."draft_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "region_pools_draft_entries_check" CHECK (jsonb_typeof("region_pools"."draft_entries") = 'array')
);--> statement-breakpoint
CREATE TABLE "region_pool_revisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "region_pool_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"region_id" text NOT NULL,
	"number" integer NOT NULL,
	"content_hash" text NOT NULL,
	"source" text NOT NULL,
	"rolled_back_from" bigint,
	"draft_revision" integer NOT NULL,
	"species_manifest" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_pool_revisions_number_check" CHECK ("region_pool_revisions"."number" >= 1),
	CONSTRAINT "region_pool_revisions_hash_check" CHECK ("region_pool_revisions"."content_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "region_pool_revisions_source_check" CHECK ("region_pool_revisions"."source" in ('bootstrap','editor','rollback','import')),
	CONSTRAINT "region_pool_revisions_manifest_check" CHECK (jsonb_typeof("region_pool_revisions"."species_manifest") = 'array')
);--> statement-breakpoint
CREATE TABLE "region_pool_revision_entries" (
	"revision_id" bigint NOT NULL,
	"species_id" bigint NOT NULL,
	"weight" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "region_pool_revision_entries_revision_id_species_id_pk" PRIMARY KEY("revision_id","species_id"),
	CONSTRAINT "region_pool_revision_entries_weight_check" CHECK ("region_pool_revision_entries"."weight" > 0 and "region_pool_revision_entries"."weight" <= 1000000),
	CONSTRAINT "region_pool_revision_entries_position_check" CHECK ("region_pool_revision_entries"."position" >= 0)
);--> statement-breakpoint
CREATE TABLE "region_pool_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "region_pool_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"region_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_pool_events_action_check" CHECK ("region_pool_events"."action" in ('bootstrapped','draft_saved','draft_discarded','draft_reset_to_shipped','published','rolled_back','projection_rebuilt','drift_detected'))
);--> statement-breakpoint
ALTER TABLE "region_pool_revisions" ADD CONSTRAINT "region_pool_revisions_region_id_region_pools_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region_pools"("region_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_pool_revisions" ADD CONSTRAINT "region_pool_revisions_rolled_back_from_fk" FOREIGN KEY ("rolled_back_from") REFERENCES "public"."region_pool_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_pool_revision_entries" ADD CONSTRAINT "region_pool_revision_entries_revision_id_region_pool_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."region_pool_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_pool_revision_entries" ADD CONSTRAINT "region_pool_revision_entries_species_id_species_id_fk" FOREIGN KEY ("species_id") REFERENCES "public"."species"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_pools" ADD CONSTRAINT "region_pools_published_revision_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."region_pool_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "region_pool_revisions_region_number_uq" ON "region_pool_revisions" USING btree ("region_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "region_pool_revision_entries_position_uq" ON "region_pool_revision_entries" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX "region_pool_events_region_idx" ON "region_pool_events" USING btree ("region_id","id" DESC);--> statement-breakpoint

-- A published revision is immutable, entries included. The application never
-- updates or deletes one; this makes that a property of the database.
CREATE OR REPLACE FUNCTION "region_pool_revisions_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "region_pool_revisions_immutable_trg"
	BEFORE UPDATE OR DELETE ON "region_pool_revisions"
	FOR EACH ROW EXECUTE FUNCTION "region_pool_revisions_immutable"();--> statement-breakpoint
CREATE TRIGGER "region_pool_revision_entries_immutable_trg"
	BEFORE UPDATE OR DELETE ON "region_pool_revision_entries"
	FOR EACH ROW EXECUTE FUNCTION "region_pool_revisions_immutable"();
