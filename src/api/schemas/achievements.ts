/**
 * Achievements API contracts (Achievements & Leaderboards, Phase 1).
 *
 * The Portal never evaluates achievement rules — the backend returns resolved,
 * hidden-safe state and the client renders it (§6). A hidden, still-locked
 * achievement arrives with placeholder name/description and `progress: null`,
 * so there is no criteria for a client to leak even by accident.
 */
import { z } from 'zod';
import {
  ACHIEVEMENT_CATEGORIES,
} from '../../modules/achievements/achievementRules';

export const achievementCategorySchema = z.enum(ACHIEVEMENT_CATEGORIES);

/** Already an ISO-8601 string when it leaves the service (never a Date). */
const unlockedAtString = z.string().describe('ISO 8601 timestamp in UTC.');

export const achievementProgressSchema = z.object({
  current: z.number().int().min(0),
  target: z.number().int().min(1),
});

export const achievementSchema = z.object({
  id: z.string(),
  category: achievementCategorySchema,
  hidden: z.boolean(),
  status: z.enum(['locked', 'in_progress', 'unlocked']),
  unlocked: z.boolean(),
  unlockedAt: unlockedAtString.nullable(),
  name: z.string().describe('"???" for a hidden achievement that is still locked.'),
  description: z.string().describe('"Hidden Achievement" for a hidden, locked achievement.'),
  icon: z.string().nullable(),
  series: z.string().nullable().describe('Null for hidden, locked achievements.'),
  tier: z.number().int().nullable(),
  progress: achievementProgressSchema
    .nullable()
    .describe('Null for hidden, locked achievements — no criteria are exposed.'),
});

export const achievementSummarySchema = z.object({
  total: z.number().int().min(0),
  unlocked: z.number().int().min(0),
  completionPercent: z.number().int().min(0).max(100),
});

export const achievementsResponseSchema = z.object({
  summary: achievementSummarySchema,
  achievements: z.array(achievementSchema),
});

/** The public, showcase-safe summary embedded in a player's public profile. */
export const publicAchievementSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: achievementCategorySchema,
  icon: z.string().nullable(),
  unlockedAt: unlockedAtString,
});

export const publicAchievementSummarySchema = z.object({
  total: z.number().int().min(0),
  unlocked: z.number().int().min(0),
  completionPercent: z.number().int().min(0).max(100),
  recent: z.array(publicAchievementSchema),
});
