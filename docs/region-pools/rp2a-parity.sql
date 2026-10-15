-- RP2A Region Pool parity check. Read-only; safe on any environment.
--
-- 1. BEFORE deploying RP2A, against the running pre-RP2A release, save the
--    output of query A:
--      psql "$DATABASE_URL" -X -A -F $'\t' -t -f docs/region-pools/rp2a-parity.sql > before.tsv
-- 2. Deploy. Startup migrates (0069), seeds species/items, bootstraps the six
--    Region Pools and projects them.
-- 3. Run the same command into after.tsv, then compare query A only:
--      diff <(grep '^A' before.tsv) <(grep '^A' after.tsv)
--    It must print nothing. Queries B–C read tables 0069 creates, so before
--    the deploy psql reports them as missing; that is expected.
--
-- The hunt reads region_encounter_pools without ORDER BY, so a seeded draw is
-- not reproducible across a rewrite. Parity is the canonical (region, slug,
-- weight) set below, explicitly sorted; with the hunt code unchanged, an
-- identical set means an identical distribution.

-- A. Canonical projection: what the hunt can draw, per region.
SELECT 'A' AS q, p.region_id, s.slug, p.weight, s.rarity, s.enabled
FROM region_encounter_pools p
JOIN species s ON s.id = p.species_id
ORDER BY p.region_id COLLATE "C", s.slug COLLATE "C";

-- B. Every projected region equals its published revision (expect no rows).
SELECT 'B' AS q, coalesce(proj.region_id, pub.region_id) AS region_id,
       coalesce(proj.species_id, pub.species_id) AS species_id,
       proj.weight AS projected_weight, pub.weight AS published_weight
FROM region_encounter_pools proj
FULL JOIN (
  SELECT rp.region_id, e.species_id, e.weight
  FROM region_pools rp
  JOIN region_pool_revision_entries e ON e.revision_id = rp.published_revision_id
  WHERE rp.region_id IN (SELECT DISTINCT region_id FROM region_encounter_pools)
) pub ON pub.region_id = proj.region_id AND pub.species_id = proj.species_id
WHERE proj.weight IS DISTINCT FROM pub.weight
ORDER BY coalesce(proj.region_id, pub.region_id) COLLATE "C", coalesce(proj.species_id, pub.species_id);

-- C. Bootstrap evidence: each region's first revision and whether the
--    projection the previous release left behind was identical (expect true
--    for all six when the RP2A release carries no region-file changes).
SELECT 'C' AS q, e.region_id,
       e.details->'previousProjection'->>'identical' AS previous_projection_identical,
       e.details->'previousProjection'->>'entries' AS previous_entries,
       jsonb_array_length(e.details->'shipped'->'entries') AS shipped_entries,
       e.details->'shipped'->'skipped' AS skipped
FROM region_pool_events e
WHERE e.action = 'bootstrapped'
ORDER BY e.region_id COLLATE "C";

-- D. Per-region, per-rarity totals of huntable rows (enabled, not dungeon-exclusive).
SELECT 'D' AS q, p.region_id, s.rarity, count(*) AS species, sum(p.weight) AS total_weight
FROM region_encounter_pools p
JOIN species s ON s.id = p.species_id
WHERE s.enabled AND NOT (s.tags @> '["dungeon_exclusive"]'::jsonb)
GROUP BY p.region_id, s.rarity
ORDER BY p.region_id COLLATE "C", s.rarity COLLATE "C";
