-- Boss and expedition reward tables move into the database, and a boss
-- encounter snapshots the reward table it will pay at spawn.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0046: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0046's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── reward_tables ─────────────────────────────────────────────────────────
--
-- One row per table, one JSONB document per row: `definition` is the table
-- exactly as `content/bossRewards.json` / `content/expeditionRewards.json`
-- write it, validated by the per-kind Zod schema on every write and read.
-- One document rather than group/entry rows because entry order is part of
-- the deterministic weighted pick, saves and imports replace a whole table,
-- and nothing queries inside a table.
--
-- The shipped JSON stays the default. The startup seed inserts a missing
-- table, and updates an existing one from the shipped file **only** while the
-- row still holds what was last seeded into it (`content_hash = seed_hash`).
-- A row an admin has changed is never overwritten by a deploy; the seed logs
-- the divergence instead. `seed_hash` is NULL for a table that was never
-- shipped (created in the Portal or imported).
--
--   revision      optimistic concurrency: a save names the revision it
--                 edited, and loses with a 409 if someone saved first.
--   position      the order export writes tables back in (file order for
--                 shipped tables, appended after them for new ones).
--
-- Created empty: no rows are inserted here. The startup seed fills it from
-- the shipped files, so until that runs the tables are exactly the files.
--
-- ── boss_encounters.reward_snapshot ───────────────────────────────────────
--
-- The validated reward table and every Equipment entry's eligible base
-- definitions, frozen at spawn. Payout reads only the snapshot, so an edit
-- reaches future bosses and never an encounter already announced, its
-- participations, or a payout retried after a crash. NULL on encounters
-- spawned before this migration: those pay from the live table once, the
-- behaviour they were spawned under.
--
-- Purely additive. Every statement is IF NOT EXISTS, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "reward_tables" (
	"kind" text NOT NULL,
	"table_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"revision" integer NOT NULL DEFAULT 1,
	"content_hash" text NOT NULL,
	"seed_hash" text,
	"position" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_by" text,
	CONSTRAINT "reward_tables_pk" PRIMARY KEY ("kind", "table_id"),
	CONSTRAINT "reward_tables_kind_check" CHECK ("kind" in ('boss', 'expedition')),
	CONSTRAINT "reward_tables_revision_check" CHECK ("revision" >= 1)
);--> statement-breakpoint
ALTER TABLE "boss_encounters" ADD COLUMN IF NOT EXISTS "reward_snapshot" jsonb;
