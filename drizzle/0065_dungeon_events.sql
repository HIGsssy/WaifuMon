-- Phase 3 Dungeon Events. An event's selection must survive a retreat, which
-- erases the action record it would otherwise live in, so it is kept beside
-- reward_claims. Existing and active runs read {}: they hold no events.
ALTER TABLE "dungeon_runs" ADD COLUMN "event_states" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Two new history types: which event an action presented, and what a choice spent.
ALTER TABLE "dungeon_run_events" DROP CONSTRAINT "dungeon_run_events_type_check";--> statement-breakpoint
ALTER TABLE "dungeon_run_events" ADD CONSTRAINT "dungeon_run_events_type_check" CHECK ("type" in ('run_started','room_entered','action_skipped','action_declined','combat_wave_resolved','action_completed','action_failed','room_completed','room_retreated','connection_taken','extraction','defeat','completion','abandon','currency_banked','rewards_granted','event_selected','items_consumed'));
