-- Trainer Profile (Gameplay UX Redesign, phase 3).
--
-- `waifumon_sessions.message_id` used to hold the public *session board* id.
-- Gameplay is ephemeral now (phase 2), so the column is repurposed to hold the
-- Care Mode Trainer Profile message id instead.
--
-- Data note: the rename preserves the column and every other field on the row
-- (the daily summary tally, splash tracking, timestamps). Only the message id
-- itself is discarded, because any surviving value points at an old session
-- board that nothing edits any more — keeping it would make the profile
-- edit/delete path target an unrelated message. Those old boards stay in
-- channel history harmlessly.
ALTER TABLE "waifumon_sessions" RENAME COLUMN "message_id" TO "profile_message_id";--> statement-breakpoint
-- The reverse message_id → session lookup existed only for the public-board
-- component-ownership check, which ephemeral views made unreachable.
DROP INDEX IF EXISTS "waifumon_sessions_message_id_uq";--> statement-breakpoint
UPDATE "waifumon_sessions" SET "profile_message_id" = NULL;
