-- Boss Encounters — permanent Discord history.
--
-- Hand-written, following the convention established in 0005 and restated in
-- 0017: the drizzle-kit snapshots stop at 0004, so a generated migration would
-- diff against a stale baseline. The journal entry's `when` is set above
-- 0017's for the same reason as before — the node-postgres migrator skips any
-- entry whose folder timestamp is not greater than the last applied one.
--
-- Until now one `message_id` carried an encounter's entire lifecycle, because
-- results were published by *editing* the announcement into its results form.
-- That made retries trivially idempotent and made history impossible: the
-- channel could only ever show the latest state of each encounter, never the
-- announcement/result pair.
--
-- Four purely additive columns split the two messages and give each delivery
-- step its own state, so recovery can tell "not done yet" from "already done":
--
--   1. `results_message_id`     — the second, separate public message. Null
--      until results are published. Independent of `message_id` so a repair of
--      one cannot clobber the other.
--   2. `results_published_at`   — the results-publication flag. Non-null means
--      a results message exists; this is what stops a retry from posting a
--      second one.
--   3. `completion_edited_at`   — the encounter-message completion edit. The
--      announcement is edited in place into its terminal form (outcome prose,
--      no participation components) and this stamps when that landed, so a
--      restart can repair an edit that never made it out.
--   4. `results_page_size`      — the page size the results message was built
--      with, so pagination after a restart pages the same way it did on the
--      day even if the tuning value moved underneath.
--
-- Both delivery flags are timestamps rather than booleans: the same
-- "null means pending" shape `resolved_at` and `resolving_at` already use on
-- this table, and an operator debugging a stuck encounter gets a *when* rather
-- than only a *whether*.
ALTER TABLE "boss_encounters" ADD COLUMN "results_message_id" text;--> statement-breakpoint
ALTER TABLE "boss_encounters" ADD COLUMN "results_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boss_encounters" ADD COLUMN "completion_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boss_encounters" ADD COLUMN "results_page_size" integer;--> statement-breakpoint
-- Recovery reads this: "resolved encounters that still owe Discord something".
-- Partial, because the answer is almost always the empty set and the index
-- should cost nothing to keep.
CREATE INDEX "boss_encounters_delivery_idx" ON "boss_encounters" USING btree ("guild_id") WHERE status = 'resolved' and (results_published_at is null or completion_edited_at is null);--> statement-breakpoint
-- The results message is looked up by id during a repair, the same way the
-- announcement already is.
CREATE INDEX "boss_encounters_results_message_idx" ON "boss_encounters" USING btree ("results_message_id");--> statement-breakpoint
-- Encounters resolved before this migration published their results by editing
-- the announcement, so their completion edit is already on Discord and their
-- "results message" is that same message. Backfilling both stamps stops the
-- new recovery path from treating every historical encounter as unfinished
-- work and re-posting a results message under an announcement that was already
-- overwritten months ago. `results_message_id` stays null on purpose: there is
-- no separate message to point at, and null reads correctly as "this encounter
-- predates the split".
UPDATE "boss_encounters"
   SET "completion_edited_at" = coalesce("resolved_at", "created_at"),
       "results_published_at" = coalesce("resolved_at", "created_at")
 WHERE "status" in ('resolved','cancelled');
