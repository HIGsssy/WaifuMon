-- Combat Trials: one row per resolved Trial fight.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0047: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0047's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── combat_trial_attempts ─────────────────────────────────────────────────
--
-- V1 Trials resolve immediately (automatic combat), so an attempt is written
-- once, already finished. It is a **snapshot**: the stats both sides started
-- with, the names they were shown under, the result and the remaining HP are
-- copied in, so a later content edit (an enemy retuned, a Trial renamed)
-- never rewrites history. `initial_state` is the engine's serialisable
-- `CombatState` at the start of the fight and `events` the engine's
-- structured event log — data, never prose — kept for debugging and replay.
--
--   request_key   the idempotency key: one per rendered Fight button. A
--                 double-click or a Discord retry carries the same key and
--                 reads the existing attempt back instead of fighting again.
--                 Unique per player.
--   first_clear   true on exactly the attempt that first cleared the Trial
--                 for this player (a `player_victory`). The partial unique
--                 index makes that one row per (player, trial), so first-clear
--                 detection and the first-clear reward cannot happen twice.
--   rewards       what that attempt paid, as a JSON snapshot; null when it
--                 paid nothing (every non-first-clear attempt in V1).
--
-- No active-fight table: interactive combat is future work and will park a
-- `CombatState` in a table of its own (see docs/combat-trials.md).
--
-- Purely additive. Every statement is IF NOT EXISTS, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "combat_trial_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"player_id" bigint NOT NULL REFERENCES "players"("id"),
	"trial_key" text NOT NULL,
	"enemy_key" text NOT NULL,
	"request_key" text NOT NULL,
	"result" text NOT NULL,
	"end_reason" text NOT NULL,
	"rounds" integer NOT NULL,
	"actions" integer NOT NULL,
	"buddy_waifu_id" bigint NOT NULL,
	"player_name" text NOT NULL,
	"player_attack" integer NOT NULL,
	"player_defense" integer NOT NULL,
	"player_max_hp" integer NOT NULL,
	"player_remaining_hp" integer NOT NULL,
	"enemy_name" text NOT NULL,
	"enemy_attack" integer NOT NULL,
	"enemy_defense" integer NOT NULL,
	"enemy_max_hp" integer NOT NULL,
	"enemy_remaining_hp" integer NOT NULL,
	"initial_state" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"first_clear" boolean NOT NULL DEFAULT false,
	"rewards" jsonb,
	"started_at" timestamp with time zone NOT NULL DEFAULT now(),
	"completed_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "combat_trial_attempts_result_check" CHECK ("result" in ('player_victory','enemy_victory','draw')),
	CONSTRAINT "combat_trial_attempts_end_reason_check" CHECK ("end_reason" in ('defeat','round_limit')),
	CONSTRAINT "combat_trial_attempts_first_clear_check" CHECK (NOT "first_clear" OR "result" = 'player_victory'),
	CONSTRAINT "combat_trial_attempts_counts_check" CHECK ("rounds" >= 1 AND "actions" >= 0),
	CONSTRAINT "combat_trial_attempts_player_stats_check" CHECK (
		"player_attack" >= 0 AND "player_defense" >= 0 AND "player_max_hp" >= 1
		AND "player_remaining_hp" >= 0 AND "player_remaining_hp" <= "player_max_hp"
	),
	CONSTRAINT "combat_trial_attempts_enemy_stats_check" CHECK (
		"enemy_attack" >= 0 AND "enemy_defense" >= 0 AND "enemy_max_hp" >= 1
		AND "enemy_remaining_hp" >= 0 AND "enemy_remaining_hp" <= "enemy_max_hp"
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "combat_trial_attempts_request_uq"
	ON "combat_trial_attempts" ("player_id", "request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "combat_trial_attempts_first_clear_uq"
	ON "combat_trial_attempts" ("player_id", "trial_key") WHERE "first_clear";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_trial_attempts_player_trial_idx"
	ON "combat_trial_attempts" ("player_id", "trial_key", "id" DESC);
