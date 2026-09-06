-- Audit trail for World Encounter content promotion.
--
-- Encounter content lives in Postgres rather than in `content/*.json`, so
-- moving it between environments previously had no good answer: a database
-- dump carries surrogate keys, player rows and live encounter state, and
-- restoring one on production would overwrite the running game along with its
-- content. The promotion workflow replaces that with an explicit, reviewable
-- JSON package — and this table is the record of which packages were applied.
--
-- Written inside the import transaction, so a row exists if and only if the
-- content it describes actually landed. A refused preview or a failed apply
-- leaves nothing here, which is what makes the table trustworthy as an answer
-- to "what is on this server, and who promoted it?".
--
-- Deliberately does not store the package body. Packages are large, they
-- already live in source control or in the operator's hands, and a copy here
-- would be a second place for stale content to accumulate. The slug list is
-- enough to see what a given promotion touched.
--
-- Purely additive: nothing reads this table to make a decision, so applying
-- the migration changes no behaviour.
CREATE TABLE "world_encounter_import_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"actor_discord_user_id" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"package_format" text NOT NULL,
	"package_version" integer NOT NULL,
	"package_exported_at" text,
	"package_label" text,
	"source_filename" text,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"vendor_created_count" integer DEFAULT 0 NOT NULL,
	"vendor_updated_count" integer DEFAULT 0 NOT NULL,
	"encounter_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "world_encounter_import_log_applied_idx" ON "world_encounter_import_log" USING btree ("applied_at");
