-- Result Presentation variants: authored flavor text and artwork for
-- lightweight gameplay outcomes (hunt finds, "nothing found", a released
-- Waifumon).
--
-- Presentation only. Gameplay resolves the outcome — amounts, items, species,
-- encounter state — before this table is read, and nothing here is read back
-- by gameplay, so the table deliberately has no reward, rarity or chance
-- columns.
--
-- `presentation_key` is a closed list defined in code
-- (src/modules/resultPresentation/keys.ts). The CHECKs mirror that list and
-- its per-key artwork rule (`encountered` artwork is only meaningful for a
-- released Waifumon), so a row the runtime could not honour cannot be stored.
-- Adding a key means updating both the code list and these constraints.
--
-- Additive only: a new, empty table. With no rows every outcome renders its
-- built-in presentation, exactly as before this migration.
CREATE TABLE "result_presentation_variants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "result_presentation_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"presentation_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"flavor_text" text,
	"artwork_path" text,
	"artwork_mode" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_presentation_variants_key_check" CHECK ("presentation_key" in ('hunt.waifubux_find','hunt.essence_find','hunt.item_find','hunt.rare_item_find','hunt.nothing_found','encounter.released')),
	CONSTRAINT "result_presentation_variants_weight_check" CHECK ("weight" > 0),
	CONSTRAINT "result_presentation_variants_artwork_mode_check" CHECK ("artwork_mode" in ('custom','encountered','none')),
	CONSTRAINT "result_presentation_variants_encountered_key_check" CHECK ("artwork_mode" <> 'encountered' or "presentation_key" in ('encounter.released')),
	CONSTRAINT "result_presentation_variants_custom_artwork_check" CHECK ("artwork_mode" <> 'custom' or "artwork_path" is not null),
	CONSTRAINT "result_presentation_variants_flavor_text_check" CHECK ("flavor_text" is null or (btrim("flavor_text") <> '' and char_length("flavor_text") <= 500))
);
--> statement-breakpoint
CREATE INDEX "result_presentation_variants_key_idx" ON "result_presentation_variants" USING btree ("presentation_key","enabled");
