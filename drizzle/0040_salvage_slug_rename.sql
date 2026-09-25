-- Salvage items — the 25 Expedition salvage slugs are renamed in place.
--
-- Hand-written for the reason recorded in 0019-0021, 0035-0039: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0039's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── Why this has to be a migration ────────────────────────────────────────
--
-- The seeder upserts `items` on slug conflict. Shipping the renamed slugs in
-- content alone would therefore mint 25 *new* rows and disable the 25 old
-- ones, while `player_inventory` and `shop_transactions` kept pointing at the
-- old `items.id` — every owned stack stranded on a disabled row. Slugs frozen
-- into JSON (an in-flight expedition's reward snapshot, an unclaimed payout)
-- would resolve to nothing at claim and be skipped.
--
-- So the rename happens here, on the existing row, *before* the seeder runs
-- (migrations run first at boot). The row keeps its `id`, which means:
--
--   * `player_inventory` — ownership and quantities — is not touched at all;
--   * `shop_transactions` history is not touched at all;
--   * the seeder then finds each new slug already present and simply updates
--     its name and description from content, exactly as for any other edit.
--
-- Nothing is inserted, deleted, merged or re-priced.
--
-- ── Refusal, not merge ────────────────────────────────────────────────────
--
-- If an old slug and its new slug *both* already exist — only possible if the
-- new content was somehow seeded before this ran — there are two rows with two
-- sets of inventory, and no correct automatic merge. The migration raises and
-- the whole transaction rolls back. A pair already fully renamed (old absent,
-- new present) is skipped, so the rename itself is safe to meet twice.
--
-- ── Frozen slugs in JSON and text columns ────────────────────────────────
--
-- Every persisted place that names an item by slug is rewritten, whatever the
-- row's status, so no reference is left pointing at a slug that no longer
-- exists:
--
--   * player_expeditions.resolution_plan / .rewards — in-flight reward
--     snapshots and resolved payouts. Reward draws are keyed on expedition id,
--     group id and roll index, never on the item slug, so rewriting a snapshot
--     cannot change an outcome;
--   * affection_gifts.item_slug, player_active_effects.source_item_slug —
--     defensive: salvage is neither giftable nor usable today;
--   * world-encounter choice, vendor, live-instance and history JSON — those
--     are authored through the admin import, not the repository, so they may
--     name salvage even though nothing in `content/` does.
--
-- JSON is rewritten by replacing the *quoted* slug (`"old"` → `"new"`) in the
-- column's text form. A slug inside prose is escaped (`\"old\"`) and never
-- matches, and none of the 25 old slugs is a quoted substring of another.
--
-- The mapping below is frozen with this migration. It must never be edited
-- after it has shipped; a further rename is a further migration.

DO $$
DECLARE
  m record;
  old_id bigint;
  new_id bigint;
  target record;
  n bigint;
BEGIN
  CREATE TEMP TABLE salvage_slug_rename (old_slug text PRIMARY KEY, new_slug text NOT NULL UNIQUE)
    ON COMMIT DROP;
  INSERT INTO salvage_slug_rename (old_slug, new_slug) VALUES
    ('bent_arcade_token', 'sticky_joystick'),
    ('cracked_shrine_charm', 'cracked_butt_plug'),
    ('dropped_setlist', 'cum_stained_evening_dress'),
    ('last_train_ticket', 'glory_hole_ticket'),
    ('moonlit_perfume_vial', 'chewed_gag_ball'),
    ('neon_sign_filament', 'still_buzzing_wand'),
    ('smudged_love_letter', 'crusted_magazine'),
    ('bathhouse_locker_token', 'stained_damp_towel'),
    ('chipped_enamel_pie_plate', 'licked_clean_pie_tin'),
    ('geothermal_core_sample', 'threadworn_love_glove'),
    ('ridge_road_postcard', 'frozen_cum_rag'),
    ('snapped_board_binding', 'ripped_leggings'),
    ('survey_flag_bundle', 'thawed_onahole'),
    ('leaning_cairn_stone', 'broken_penis_pump'),
    ('orchard_brandy_jar', 'sweat_stained_leather_harness'),
    ('quarry_grit_pouch', 'weighted_ball_stretcher'),
    ('skyfreight_ballast_weight', 'dropped_chastity_cage'),
    ('split_fence_rail', 'rusted_anal_beads'),
    ('undelivered_wax_seal', 'snapped_cock_ring'),
    ('canyon_cut_gemstone', 'sun_cracked_flogger'),
    ('dust_choked_rig_filter', 'dust_caked_blindfold'),
    ('sand_scoured_bearing', 'sand_scoured_nipple_clamps'),
    ('spent_blasting_cap', 'blown_out_fleshlight'),
    ('strongbox_hinge_plate', 'dried_up_lube_bottle'),
    ('surveyors_brass_dial', 'sun_bleached_strap_on');

  -- 1. Refuse before writing anything if any pair has both rows.
  FOR m IN SELECT * FROM salvage_slug_rename LOOP
    SELECT id INTO old_id FROM "items" WHERE "slug" = m.old_slug;
    SELECT id INTO new_id FROM "items" WHERE "slug" = m.new_slug;
    IF old_id IS NOT NULL AND new_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Salvage slug rename refused: both "%" (items.id %) and "%" (items.id %) exist. Two rows may carry separate inventory; resolve them by hand — this migration will not merge.',
        m.old_slug, old_id, m.new_slug, new_id;
    END IF;
  END LOOP;

  -- 2. Rename in place. The id — and everything keyed on it — is untouched.
  UPDATE "items" AS i
     SET "slug" = r.new_slug
    FROM salvage_slug_rename AS r
   WHERE i."slug" = r.old_slug;

  -- 3. Plain text slug columns.
  UPDATE "affection_gifts" AS g
     SET "item_slug" = r.new_slug
    FROM salvage_slug_rename AS r
   WHERE g."item_slug" = r.old_slug;
  UPDATE "player_active_effects" AS e
     SET "source_item_slug" = r.new_slug
    FROM salvage_slug_rename AS r
   WHERE e."source_item_slug" = r.old_slug;

  -- 4. Slugs frozen inside JSON.
  FOR target IN
    SELECT * FROM (VALUES
      ('player_expeditions', 'resolution_plan'),
      ('player_expeditions', 'rewards'),
      ('world_encounters', 'metadata'),
      ('world_encounter_choices', 'requirements_json'),
      ('world_encounter_choices', 'check_json'),
      ('world_encounter_choices', 'success_effects_json'),
      ('world_encounter_choices', 'failure_effects_json'),
      ('world_encounter_vendors', 'stock_template_json'),
      ('world_encounter_vendor_instances', 'stock_json'),
      ('active_world_encounters', 'context_json'),
      ('active_world_encounters', 'resolution_json'),
      ('world_encounter_history', 'effects_applied_json')
    ) AS t(tbl, col)
  LOOP
    FOR m IN SELECT * FROM salvage_slug_rename LOOP
      EXECUTE format(
        'UPDATE %I SET %I = replace(%I::text, $1, $2)::jsonb WHERE strpos(%I::text, $1) > 0',
        target.tbl, target.col, target.col, target.col
      ) USING '"' || m.old_slug || '"', '"' || m.new_slug || '"';
    END LOOP;
  END LOOP;

  -- 5. Post-conditions: no old slug left anywhere this migration owns.
  SELECT count(*) INTO n FROM "items" i JOIN salvage_slug_rename r ON i."slug" = r.old_slug;
  IF n > 0 THEN
    RAISE EXCEPTION 'Salvage slug rename left % items row(s) on an old slug', n;
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT i."slug" FROM "items" i JOIN salvage_slug_rename r ON i."slug" = r.new_slug
    GROUP BY i."slug" HAVING count(*) > 1
  ) AS dup;
  IF n > 0 THEN
    RAISE EXCEPTION 'Salvage slug rename produced % duplicated new slug(s)', n;
  END IF;
END $$;
