-- Claims are committed with effects under the run lock, independently of room
-- navigation. Recover claims from history, including rewards erased by retreat.
ALTER TABLE "dungeon_runs" ADD COLUMN "reward_claims" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "dungeon_runs" r
SET "reward_claims" = claims.plans
FROM (
  SELECT "run_id", jsonb_object_agg("payload"->>'claimKey', "payload"->'plan' ORDER BY "id") AS plans
  FROM "dungeon_run_events"
  WHERE "type" = 'action_completed'
    AND "payload"->>'actionType' = 'reward'
    AND "payload"->>'claimKey' IS NOT NULL
    AND jsonb_typeof("payload"->'plan') = 'object'
  GROUP BY "run_id"
) claims
WHERE r."id" = claims."run_id";
