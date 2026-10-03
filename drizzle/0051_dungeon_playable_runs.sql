-- Playable dungeon runs: the state a run carries while it is played, how it
-- ended, and an append-only history of what happened in it.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0050: the
-- drizzle-kit snapshots stop at 0004. The journal `when` is above 0050's.
--
-- ── dungeon_runs (three new columns) ──────────────────────────────────────
--
--   fighter      the Buddy and Equipment-derived ATK / DEF / max HP the run
--                fights with, snapshotted when it started. Never recalculated:
--                changing gear or the active Buddy afterwards does not reach
--                the run. NULL only for a run generated without a player
--                loadout (the 0050 foundation, admin tooling) — such a run
--                cannot be played.
--   node_states  per node id, where that node is in its lifecycle
--                (`entered` → `completed`) and, once completed, what resolving
--                it did. A node with no entry has not been entered. This is
--                what makes resolution idempotent: a completed node is read
--                back, never resolved again.
--   settlement   how the run ended and what was banked; NULL while active.
--
-- `current_node_id`, `current_hp`, `unbanked_currency` and `secured_rewards`
-- (0050) are now advanced by play. `dungeon_runs_settlement_check` ties the
-- settlement to the terminal states the same way `completed_at` already is.
--
-- ── dungeon_run_events ────────────────────────────────────────────────────
--
-- One row per thing that happened in a run, in order: `run_started`,
-- `node_entered`, `combat_resolved`, `rest_resolved`, `event_resolved`,
-- `reward_resolved`, `exit_resolved`, `extraction`, `defeat`, `completion`,
-- `abandon`, `currency_banked`. `payload` is structured (HP before and after,
-- the combat engine's events, what was paid) — never prose. Append-only:
-- nothing updates or deletes a row. Written in the same transaction as the
-- state change it records, so the history cannot disagree with the run.
--
-- No existing data changes. Every statement is idempotent.

ALTER TABLE "dungeon_runs" ADD COLUMN IF NOT EXISTS "fighter" jsonb;--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD COLUMN IF NOT EXISTS "node_states" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD COLUMN IF NOT EXISTS "settlement" jsonb;--> statement-breakpoint
ALTER TABLE "dungeon_runs" DROP CONSTRAINT IF EXISTS "dungeon_runs_settlement_check";--> statement-breakpoint
ALTER TABLE "dungeon_runs"
	ADD CONSTRAINT "dungeon_runs_settlement_check" CHECK ("status" <> 'active' or "settlement" is null);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dungeon_run_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"run_id" bigint NOT NULL REFERENCES "dungeon_runs"("id"),
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"type" text NOT NULL,
	"node_id" text,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "dungeon_run_events_type_check" CHECK ("type" in ('run_started','node_entered','combat_resolved','rest_resolved','event_resolved','reward_resolved','exit_resolved','extraction','defeat','completion','abandon','currency_banked'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dungeon_run_events_run_idx"
	ON "dungeon_run_events" USING btree ("run_id", "id");
