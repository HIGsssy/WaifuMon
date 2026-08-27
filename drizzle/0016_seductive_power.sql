-- Seductive Power v1 — permanent per-copy Base SP on every owned Waifumon.
--
-- Four steps, in this order for a reason:
--
--   1. Add the column nullable, so the table is never rewritten with a value
--      that would then have to be corrected.
--   2. Backfill deterministically from `(player_waifus.id, salt)` joined to the
--      copy's species rarity.
--   3. RAISE if anything is still null — that can only mean a copy whose
--      species carries a rarity this ladder does not define, and guessing a
--      value into a permanent column is worse than a failed deploy.
--   4. Only then SET NOT NULL and add the CHECK.
--
-- **Why derived rather than rolled.** A migration can re-run: a replay, a
-- restored snapshot, a re-applied deploy. Rolling would hand the same copy a
-- different permanent stat each time. The derivation below is a pure function
-- of the row's own id, so re-running is a no-op that writes the same integers.
--
--   md5('<id>:<salt>') -> first 8 hex digits -> a 32-bit integer -> min + (n % span)
--
-- `id` (not species) is the key, so two duplicate copies of one species land on
-- different values — Base SP belongs to the copy. `n` is uniform over 2^32 and
-- the spans are 11 wide, so every integer in each band is reachable and the
-- residual modulo bias is ~1 part in 390 million. Explicitly *not* a midpoint
-- default: the whole point is that historical copies get a real spread.
--
-- `src/modules/power/seductivePowerBackfill.ts` reproduces this exact
-- arithmetic in TypeScript, and a test sweeps a wide id range asserting the two
-- agree. The band table is snapshotted here because a historical backfill must
-- be frozen at the values that were current when it ran; `content/tables.json`
-- owns the live ladder for new rolls.
ALTER TABLE "player_waifus" ADD COLUMN "base_sp" integer;--> statement-breakpoint
UPDATE "player_waifus" AS w
SET "base_sp" = r.min + (
  ('x' || substr(md5(w."id"::text || ':' || 'waifumon.sp.backfill.v1'), 1, 8))::bit(32)::bigint
  % (r.max - r.min + 1)
)
FROM "species" AS s,
LATERAL (
  SELECT * FROM (VALUES
    ('N',   90, 100),
    ('R',  105, 115),
    ('SR', 120, 130),
    ('SSR',135, 145),
    ('UR', 150, 160),
    ('LR', 165, 175),
    ('EX', 180, 190)
  ) AS t(rarity, min, max)
  WHERE t.rarity = s."rarity"
) AS r
WHERE w."species_id" = s."id" AND w."base_sp" IS NULL;--> statement-breakpoint
DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned FROM "player_waifus" WHERE "base_sp" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Seductive Power backfill left % owned Waifumon without a base_sp — their species carry a rarity outside the configured ladder (N,R,SR,SSR,UR,LR,EX). Fix the species rows, then re-run.',
      orphaned;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "player_waifus" ALTER COLUMN "base_sp" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "player_waifus" ADD CONSTRAINT "player_waifus_base_sp_check" CHECK ("player_waifus"."base_sp" >= 1);
