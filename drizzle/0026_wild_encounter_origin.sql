-- Phase 2 closure: provenance + idempotency for *spawned* wild encounters.
--
-- Until now the only way a row landed in `encounters` was a hunt roll, so the
-- table had no need to say where an encounter came from. `trigger_waifumon_
-- encounter` (and, later, quests, items, events, exploration and deity
-- rewards) spawn one directly, and two of those callers can retry: a Discord
-- button can be double-clicked, and a job can be replayed.
--
-- `origin_kind` names the subsystem, `origin_ref` is that subsystem's own id
-- for the single cause of this spawn. The pair is the idempotency key. The
-- unique index is **partial** — hunted encounters leave both columns null and
-- never enter it — so the cost on the hot path is nothing, and a replayed
-- spawn loses the race on the index rather than creating a second encounter.
--
-- Both columns are nullable and unconstrained by a FK on purpose: the
-- referenced id lives in a different table per `origin_kind`, and an origin
-- row being cleaned up must never cascade away an encounter a player is in
-- the middle of.
ALTER TABLE "encounters" ADD COLUMN "origin_kind" text;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "origin_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "encounters_origin_uq" ON "encounters" USING btree ("origin_kind","origin_ref") WHERE origin_kind is not null and origin_ref is not null;
