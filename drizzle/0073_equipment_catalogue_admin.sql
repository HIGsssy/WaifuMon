-- Equipment 3.0 (E3-D): the Admin Equipment Catalogue.
--
-- Hand-written for the reason recorded in 0019-0021 and 0035-0072: the
-- drizzle-kit snapshots stop at 0004, so a generated migration would diff
-- against a stale baseline. The journal `when` is above 0072's, because the
-- node-postgres migrator skips any entry not strictly newer than the last
-- applied one.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
-- 1. `equipment_definitions.revision` — the integer optimistic-concurrency
--    token the Portal editor names on every save (`expectedRevision`). Every
--    definition write increments it. Existing rows start at 1. An integer,
--    never `updated_at`: `now()` is the transaction start, and a JS `Date`
--    round-trip drops Postgres's microseconds.
--
-- 2. `equipment_admin_events` (0071) also records definition authoring:
--    subject kind `definition`, and the actions `enabled`, `disabled`,
--    `duplicated` and `imported` beside the existing `created` / `updated`.
--    Widening only: every existing row still satisfies both checks.
--
-- Nothing is rewritten beyond the default, and no owned copy is touched.
--
-- ── Rollback ──────────────────────────────────────────────────────────────
--
-- Drop the revision column and its check, and restore the 0071 forms of the
-- two event checks after deleting any `definition` rows (audit history only).
--
-- Re-running this file is a no-op.
ALTER TABLE "equipment_definitions" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "equipment_definitions" DROP CONSTRAINT IF EXISTS "equipment_definitions_revision_check";
--> statement-breakpoint
ALTER TABLE "equipment_definitions" ADD CONSTRAINT "equipment_definitions_revision_check" CHECK ("revision" >= 1);
--> statement-breakpoint
ALTER TABLE "equipment_admin_events" DROP CONSTRAINT IF EXISTS "equipment_admin_events_subject_kind_check";
--> statement-breakpoint
ALTER TABLE "equipment_admin_events"
  ADD CONSTRAINT "equipment_admin_events_subject_kind_check"
  CHECK ("subject_kind" in ('roll_rules','affix_library','definition'));
--> statement-breakpoint
ALTER TABLE "equipment_admin_events" DROP CONSTRAINT IF EXISTS "equipment_admin_events_action_check";
--> statement-breakpoint
ALTER TABLE "equipment_admin_events"
  ADD CONSTRAINT "equipment_admin_events_action_check"
  CHECK ("action" in ('bootstrapped','drift_detected','created','updated','draft_saved','draft_imported','published','rolled_back','enabled','disabled','duplicated','imported'));
