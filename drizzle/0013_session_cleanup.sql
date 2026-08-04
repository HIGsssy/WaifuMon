-- Rev 4 session-board leftovers (Gameplay UX Redesign, phase 4).
--
-- These three columns existed only to serve the public session board and the
-- per-attempt public capture message, both of which were retired when
-- gameplay went ephemeral (phase 2):
--
--   waifumon_sessions.current_screen      — diagnostic breadcrumb for the board
--   waifumon_sessions.owner_display_name  — cached nickname for the "Hunter"
--                                           line and the foreign-click copy
--   encounters.public_message_id          — the edit-in-place capture message
--
-- Nothing has read or written any of them since phase 2. This is a
-- destructive, one-way drop: the values are not recoverable without a
-- restore, which is why it is deliberately a separate migration from 0012.
-- No gameplay data is affected — species, waifus, currencies, inventory,
-- progression, quests, the daily summary tally, and the Trainer Profile
-- pointer all live in other columns and are untouched.
ALTER TABLE "waifumon_sessions" DROP COLUMN IF EXISTS "current_screen";--> statement-breakpoint
ALTER TABLE "waifumon_sessions" DROP COLUMN IF EXISTS "owner_display_name";--> statement-breakpoint
ALTER TABLE "encounters" DROP COLUMN IF EXISTS "public_message_id";
