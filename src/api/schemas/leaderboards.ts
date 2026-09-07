/**
 * Leaderboards API contracts (Achievements & Leaderboards, Phase 1).
 *
 * ## The product rule this schema enforces: ranks, never scores (§10)
 *
 * There is deliberately no field for the ranked value. An entry is a rank, a
 * player id, and presentation identity — never `xp`, `captures`, `affection`,
 * or any derived "you are N behind". The value exists only inside the backend
 * to compute the rank. A client cannot render a raw metric because the wire
 * format has nowhere to put one.
 */
import { z } from 'zod';
import { snowflakeParam } from './common';
import { LEADERBOARD_METRICS } from '../../modules/leaderboards/leaderboardService';

export const leaderboardMetricSchema = z.enum(LEADERBOARD_METRICS);

export const leaderboardQuery = z.object({
  metric: leaderboardMetricSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  discordGuildId: snowflakeParam
    .optional()
    .describe('Bearer-token callers name their guild here; a Portal session may not widen scope.'),
});

export const leaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  playerId: z.number().int(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** True for the requesting player's own row, so the Portal can highlight it. */
  isMe: z.boolean(),
});

export const leaderboardMeSchema = z
  .object({
    rank: z.number().int().min(1),
  })
  .nullable()
  .describe("The requesting player's rank, even when outside the returned page. Null if ineligible.");

export const leaderboardResponseSchema = z.object({
  metric: leaderboardMetricSchema,
  entries: z.array(leaderboardEntrySchema),
  me: leaderboardMeSchema,
});
