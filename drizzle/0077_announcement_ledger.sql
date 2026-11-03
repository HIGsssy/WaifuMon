-- Peanut Gallery: which Discord message announced which WaifuMon event, so a
-- read-only integration can resolve a message it saw to authoritative records
-- without parsing display names. Additive; written best-effort after Discord
-- confirms a send, never inside a gameplay transaction. Boss messages are not
-- recorded here: boss_encounters.message_id / results_message_id already are.
CREATE TABLE IF NOT EXISTS announcement_ledger (
  message_id text PRIMARY KEY,
  guild_id bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  kind text NOT NULL,
  event_id uuid NOT NULL,
  player_id bigint REFERENCES players(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_ledger_kind_check
    CHECK (kind IN ('rare_capture','appearance_unlock','level_up','collection_completed'))
);
--> statement-breakpoint
-- Retention deletes by age in bounded batches.
CREATE INDEX IF NOT EXISTS announcement_ledger_created_idx ON announcement_ledger (created_at);
