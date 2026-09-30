-- Equipment foundation — definitions, owned instances, loadouts, their slots,
-- the equipment event ledger, the equipment import log, and per-player
-- feature unlocks.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0044: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0044's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What this ships ───────────────────────────────────────────────────────
--
-- Tables only. No definitions are inserted here: equipment definitions are
-- database-authoritative content, seeded insert-missing at startup from
-- `content/equipment/equipment.seed.json` and moved between environments by
-- export/import package. No player is granted anything and no feature is
-- unlocked, so on a live server this migration changes no behaviour at all.
--
-- ── Where the invariants live ─────────────────────────────────────────────
--
--   * Ownership and slot compatibility: `player_loadout_slots` carries
--     `player_id` and `slot`, and is foreign-keyed on
--     `(equipment_id, player_id, slot)` to `player_equipment` and on
--     `(loadout_id, player_id)` to `player_loadouts`. Equipping another
--     player's instance, or an instance into the wrong slot, is refused by
--     Postgres even if the service has a bug. Both targets are UNIQUE
--     *constraints* (not merely indexes) so they can be referenced.
--   * One item per slot per loadout: the slot table's primary key.
--   * One active loadout per player: a partial unique index.
--   * Referenced definitions cannot be hard-deleted: ON DELETE RESTRICT.
--   * A grant lands once: a partial unique index on `grant_key`.
--   * One instance MAY appear in several loadouts (presets); there is
--     deliberately no uniqueness on `player_loadout_slots.equipment_id`.
--
-- The CHECK lists below mirror `src/modules/equipment/vocabulary.ts` and
-- `src/modules/features/vocabulary.ts`; `tests/unit/equipmentVocabulary.test.ts`
-- fails if they drift.
--
-- Purely additive. Every statement is IF NOT EXISTS, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "equipment_definitions" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "equipment_definitions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"slot" text NOT NULL,
	"rarity" text NOT NULL,
	"attack_bp" integer DEFAULT 0 NOT NULL,
	"defense_bp" integer DEFAULT 0 NOT NULL,
	"health_bp" integer DEFAULT 0 NOT NULL,
	"secondary_effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"region_id" text,
	"artwork_path" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"shop_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"buy_price" integer,
	"price_currency" text DEFAULT 'waifubux' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "equipment_definitions_pkey" PRIMARY KEY("id"),
	CONSTRAINT "equipment_definitions_key_unique" UNIQUE("key"),
	CONSTRAINT "equipment_definitions_slot_check" CHECK ("equipment_definitions"."slot" in ('attack','defense','health')),
	CONSTRAINT "equipment_definitions_rarity_check" CHECK ("equipment_definitions"."rarity" in ('N','R','SR','SSR','UR','LR','EX')),
	CONSTRAINT "equipment_definitions_multipliers_check" CHECK ("equipment_definitions"."attack_bp" >= 0 and "equipment_definitions"."defense_bp" >= 0 and "equipment_definitions"."health_bp" >= 0),
	CONSTRAINT "equipment_definitions_bounds_check" CHECK ("equipment_definitions"."attack_bp" <= 20000 and "equipment_definitions"."defense_bp" <= 20000 and "equipment_definitions"."health_bp" <= 80000),
	CONSTRAINT "equipment_definitions_own_stat_check" CHECK (("equipment_definitions"."slot" = 'attack' and "equipment_definitions"."attack_bp" > 0) or ("equipment_definitions"."slot" = 'defense' and "equipment_definitions"."defense_bp" > 0) or ("equipment_definitions"."slot" = 'health' and "equipment_definitions"."health_bp" > 0)),
	CONSTRAINT "equipment_definitions_region_check" CHECK ("equipment_definitions"."region_id" is null or "equipment_definitions"."region_id" in ('waifu-valley','twin-peeks','flaccid-foothills','thirstlands','base-80085','assteroid-belt')),
	CONSTRAINT "equipment_definitions_buy_price_check" CHECK ("equipment_definitions"."buy_price" is null or "equipment_definitions"."buy_price" > 0),
	CONSTRAINT "equipment_definitions_price_currency_check" CHECK ("equipment_definitions"."price_currency" in ('waifubux','essence'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_definitions_enabled_slot_idx" ON "equipment_definitions" USING btree ("enabled","slot");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_definitions_region_idx" ON "equipment_definitions" USING btree ("region_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_equipment" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "player_equipment_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"player_id" bigint NOT NULL,
	"definition_id" bigint NOT NULL,
	"slot" text NOT NULL,
	"rolled_properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"source_type" text NOT NULL,
	"source_key" text,
	"grant_key" text,
	"granted_by" text,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	CONSTRAINT "player_equipment_pkey" PRIMARY KEY("id"),
	CONSTRAINT "player_equipment_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "player_equipment_definition_id_equipment_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."equipment_definitions"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "player_equipment_id_player_slot_uq" UNIQUE("id","player_id","slot"),
	CONSTRAINT "player_equipment_slot_check" CHECK ("player_equipment"."slot" in ('attack','defense','health')),
	CONSTRAINT "player_equipment_source_type_check" CHECK ("player_equipment"."source_type" in ('onboarding','boss','encounter','expedition','shop','admin','event','dungeon','raid','quest')),
	CONSTRAINT "player_equipment_removed_shape_check" CHECK (("player_equipment"."removed_at" is null) = ("player_equipment"."removed_reason" is null))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_equipment_grant_key_uq" ON "player_equipment" USING btree ("grant_key") WHERE grant_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_equipment_player_active_idx" ON "player_equipment" USING btree ("player_id") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_equipment_player_definition_idx" ON "player_equipment" USING btree ("player_id","definition_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_equipment_definition_idx" ON "player_equipment" USING btree ("definition_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_loadouts" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "player_loadouts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"player_id" bigint NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_loadouts_pkey" PRIMARY KEY("id"),
	CONSTRAINT "player_loadouts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "player_loadouts_id_player_uq" UNIQUE("id","player_id"),
	CONSTRAINT "player_loadouts_name_check" CHECK (btrim("player_loadouts"."name") <> '' and char_length("player_loadouts"."name") <= 40)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_loadouts_player_active_uq" ON "player_loadouts" USING btree ("player_id") WHERE is_active;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_loadouts_player_name_uq" ON "player_loadouts" USING btree ("player_id",lower("name"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_loadout_slots" (
	"loadout_id" bigint NOT NULL,
	"player_id" bigint NOT NULL,
	"slot" text NOT NULL,
	"equipment_id" bigint NOT NULL,
	"equipped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_loadout_slots_loadout_id_slot_pk" PRIMARY KEY("loadout_id","slot"),
	CONSTRAINT "player_loadout_slots_loadout_fk" FOREIGN KEY ("loadout_id","player_id") REFERENCES "public"."player_loadouts"("id","player_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "player_loadout_slots_equipment_fk" FOREIGN KEY ("equipment_id","player_id","slot") REFERENCES "public"."player_equipment"("id","player_id","slot") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "player_loadout_slots_slot_check" CHECK ("player_loadout_slots"."slot" in ('attack','defense','health'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_loadout_slots_loadout_equipment_uq" ON "player_loadout_slots" USING btree ("loadout_id","equipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_loadout_slots_equipment_idx" ON "player_loadout_slots" USING btree ("equipment_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_events" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "equipment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
	"player_id" bigint NOT NULL,
	"equipment_id" bigint,
	"loadout_id" bigint,
	"kind" text NOT NULL,
	"slot" text,
	"previous_equipment_id" bigint,
	"actor_discord_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_events_pkey" PRIMARY KEY("id"),
	CONSTRAINT "equipment_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "equipment_events_equipment_id_player_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."player_equipment"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "equipment_events_loadout_id_player_loadouts_id_fk" FOREIGN KEY ("loadout_id") REFERENCES "public"."player_loadouts"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "equipment_events_previous_equipment_id_player_equipment_id_fk" FOREIGN KEY ("previous_equipment_id") REFERENCES "public"."player_equipment"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "equipment_events_kind_check" CHECK ("equipment_events"."kind" in ('granted','equipped','unequipped','removed','flag_changed')),
	CONSTRAINT "equipment_events_slot_check" CHECK ("equipment_events"."slot" is null or "equipment_events"."slot" in ('attack','defense','health'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_events_player_created_idx" ON "equipment_events" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_events_kind_created_idx" ON "equipment_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_events_equipment_idx" ON "equipment_events" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_events_loadout_idx" ON "equipment_events" USING btree ("loadout_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equipment_import_log" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "equipment_import_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1) NOT NULL,
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
	"definition_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "equipment_import_log_pkey" PRIMARY KEY("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_import_log_applied_idx" ON "equipment_import_log" USING btree ("applied_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_feature_unlocks" (
	"player_id" bigint NOT NULL,
	"feature_key" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"unlocked_by" text,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_feature_unlocks_player_id_feature_key_pk" PRIMARY KEY("player_id","feature_key"),
	CONSTRAINT "player_feature_unlocks_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "player_feature_unlocks_feature_check" CHECK ("player_feature_unlocks"."feature_key" in ('equipment')),
	CONSTRAINT "player_feature_unlocks_source_check" CHECK ("player_feature_unlocks"."source" in ('onboarding','admin','migration'))
);
