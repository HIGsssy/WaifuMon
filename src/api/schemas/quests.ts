/**
 * Assigned daily quests.
 *
 * Title, description and rewards are *snapshots* frozen at assignment time, so
 * editing the quest pool never rewrites a quest already in progress. That is
 * why these fields live on the row rather than being resolved from the catalog
 * at read time — `GET /content/quests` returns the live pool for comparison.
 */
import { z } from 'zod';
import { calendarDay, nullableIsoDateTime, raritySchema } from './common';
import { questRewardsSchema } from './content';

export const dailyQuestSchema = z.object({
  id: z.number().int(),
  playerId: z.number().int(),
  questDate: calendarDay,
  questSlug: z.string(),
  title: z.string().describe('Frozen at assignment time.'),
  description: z.string().describe('Frozen at assignment time.'),
  type: z.string(),
  rarityAtLeast: raritySchema.nullable(),
  target: z.number().int(),
  progress: z.number().int(),
  rewards: questRewardsSchema.describe('Frozen at assignment time.'),
  completedAt: nullableIsoDateTime,
  claimedAt: nullableIsoDateTime,
});

export const dailyQuestsSchema = z.object({
  questDate: calendarDay
    .nullable()
    .describe('The day these quests belong to; null when none have been assigned yet.'),
  quests: z.array(dailyQuestSchema),
  allCompleteBonusClaimed: z.boolean(),
});
