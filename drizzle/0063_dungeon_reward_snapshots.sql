-- Phase 2B T6: a published dungeon revision pins the reward dependencies it
-- was validated against.
--
--   reward_snapshot  the loot-table bodies, eligible equipment and item
--                    metadata the revision's v2 rewards resolve from
--   gameplay_hash    sha256 over the definition's content hash and the
--                    snapshot's hash; what publication compares
--
-- Both are null for a revision with no v2 reward bundle, which is every
-- revision that exists before this migration: for those `content_hash` stays
-- the only hash and nothing about them changes.
--
-- Adding a nullable column is DDL: it does not fire the row-level
-- `dungeon_revisions_immutable_trg`, rewrites no row and leaves every stored
-- revision byte-identical.
--
-- JOURNAL ORDER. This entry's `when` (1821218400000) follows 0062's
-- (1821132000000), the newest on Delve.
ALTER TABLE "dungeon_revisions" ADD COLUMN "reward_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "dungeon_revisions" ADD COLUMN "gameplay_hash" text;
--> statement-breakpoint
ALTER TABLE "dungeon_revisions" ADD CONSTRAINT "dungeon_revisions_reward_snapshot_check"
  CHECK (("reward_snapshot" IS NULL) = ("gameplay_hash" IS NULL) AND jsonb_typeof("reward_snapshot") = 'object');
--> statement-breakpoint
ALTER TABLE "dungeon_revisions" ADD CONSTRAINT "dungeon_revisions_gameplay_hash_check"
  CHECK ("gameplay_hash" ~ '^sha256:[a-f0-9]{64}$');
