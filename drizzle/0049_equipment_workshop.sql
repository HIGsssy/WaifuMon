-- Patch's Workshop: Salvaged Components, dismantling and fabrication.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0048: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0048's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── player_currencies.salvaged_components ─────────────────────────────────
--
-- The Equipment-only material. A balance column beside WaifuBux and Essence
-- rather than an inventory item: inventory rows can be sold, gifted and
-- consumed by unrelated flows, and this must only ever move through the
-- Workshop. Reuses the row's existing guarantees — a `>= 0` CHECK, and
-- conditional spends (`WHERE balance >= n`) in `currencyService`. Every
-- existing player starts at 0.
--
-- ── Widened vocabularies ──────────────────────────────────────────────────
--
--   player_equipment.source_type   + 'fabrication'  (a copy Patch built)
--   equipment_events.kind          + 'dismantled'   (a copy the player broke
--                                                    down — not an admin removal)
--
-- Both lists mirror `src/modules/equipment/vocabulary.ts`;
-- `tests/unit/equipmentVocabulary.test.ts` reads the newest definition of each
-- constraint across the migrations and fails if they drift.
--
-- ── equipment_workshop_operations ─────────────────────────────────────────
--
-- One row per confirmed dismantle or fabrication: the idempotency record (a
-- per-player unique `request_key`) and the audit ledger in one, like
-- `combat_trial_attempts`. The balance and the gear are authoritative; this
-- row only proves the request already happened and snapshots what it did.
--
-- No existing data changes. Every statement is idempotent, so a re-run is a
-- no-op.

ALTER TABLE "player_currencies"
	ADD COLUMN IF NOT EXISTS "salvaged_components" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_currencies" DROP CONSTRAINT IF EXISTS "player_currencies_salvaged_components_check";--> statement-breakpoint
ALTER TABLE "player_currencies"
	ADD CONSTRAINT "player_currencies_salvaged_components_check" CHECK ("player_currencies"."salvaged_components" >= 0);--> statement-breakpoint
ALTER TABLE "player_equipment" DROP CONSTRAINT IF EXISTS "player_equipment_source_type_check";--> statement-breakpoint
ALTER TABLE "player_equipment"
	ADD CONSTRAINT "player_equipment_source_type_check" CHECK ("player_equipment"."source_type" in ('onboarding','boss','encounter','expedition','shop','admin','event','dungeon','raid','quest','fabrication'));--> statement-breakpoint
ALTER TABLE "equipment_events" DROP CONSTRAINT IF EXISTS "equipment_events_kind_check";--> statement-breakpoint
ALTER TABLE "equipment_events"
	ADD CONSTRAINT "equipment_events_kind_check" CHECK ("equipment_events"."kind" in ('granted','equipped','unequipped','removed','flag_changed','dismantled'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_workshop_operations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"request_key" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"recipe_key" text,
	"rarity" text,
	"slot_choice" text,
	"components_delta" integer NOT NULL,
	"waifubux_delta" integer NOT NULL,
	"components_after" integer NOT NULL,
	"waifubux_after" integer NOT NULL,
	"equipment_ids" bigint[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_workshop_operations_kind_check" CHECK ("kind" in ('dismantle','fabricate')),
	CONSTRAINT "equipment_workshop_operations_slot_choice_check" CHECK ("slot_choice" is null or "slot_choice" in ('attack','defense','health','any')),
	CONSTRAINT "equipment_workshop_operations_shape_check" CHECK (
		("kind" = 'dismantle' and "recipe_key" is null and "slot_choice" is null and "components_delta" > 0 and "waifubux_delta" = 0 and cardinality("equipment_ids") >= 1)
		or ("kind" = 'fabricate' and "recipe_key" is not null and "slot_choice" is not null and "components_delta" < 0 and "waifubux_delta" <= 0 and cardinality("equipment_ids") = 1)
	),
	CONSTRAINT "equipment_workshop_operations_after_check" CHECK ("components_after" >= 0 and "waifubux_after" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_workshop_operations_request_uq"
	ON "equipment_workshop_operations" USING btree ("player_id", "request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_workshop_operations_player_created_idx"
	ON "equipment_workshop_operations" USING btree ("player_id", "created_at");
