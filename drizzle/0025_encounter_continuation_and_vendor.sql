-- Phase 2: chained encounter continuation + world encounter vendor.
--
-- Hand-written, matching the repository convention since 0005. Adds one
-- nullable pointer to the existing active_world_encounters table so a chained
-- continuation is *another row* rather than a hidden field on the resolved
-- row: the partial unique index that pins one pending encounter per player
-- keeps working, and a Continue click races on that same insert exactly as a
-- fresh hunt would.
--
-- Two new tables model the encounter vendor. Deliberately kept minimal —
-- Phase 2 only ships the Wandering Merchant, and the abstraction has to hold
-- three shapes future vendors will grow into:
--
--   * fixed stock authored per definition (today)
--   * seed-based randomised stock generated at open (planned)
--   * region-scoped inventories (planned)
--
-- Rather than encode any of that in DDL up front, the definition carries a
-- `stock_template_json` payload and the instance carries a `stock_json`
-- snapshot of exactly what the player is shown. Purchases mutate that
-- snapshot atomically, which lets the vendor be transactional today and
-- lets a future randomiser drop in without a migration.
ALTER TABLE "active_world_encounters" ADD COLUMN "continuation_of_id" bigint;--> statement-breakpoint
ALTER TABLE "active_world_encounters" ADD CONSTRAINT "active_world_encounters_continuation_of_id_fk" FOREIGN KEY ("continuation_of_id") REFERENCES "public"."active_world_encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_world_encounters_continuation_of_idx" ON "active_world_encounters" USING btree ("continuation_of_id");--> statement-breakpoint
CREATE TABLE "world_encounter_vendors" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "world_encounter_vendors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vendor_key" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"stock_template_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_encounter_vendor_instances" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "world_encounter_vendor_instances_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"active_encounter_id" bigint NOT NULL,
	"vendor_key" text NOT NULL,
	"stock_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "world_encounter_vendor_instances_active_encounter_id_fk" FOREIGN KEY ("active_encounter_id") REFERENCES "public"."active_world_encounters"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "world_encounter_vendor_instances_active_encounter_uq" ON "world_encounter_vendor_instances" USING btree ("active_encounter_id");--> statement-breakpoint
CREATE INDEX "world_encounter_vendor_instances_vendor_key_idx" ON "world_encounter_vendor_instances" USING btree ("vendor_key");
