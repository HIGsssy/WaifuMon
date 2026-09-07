/**
 * A player's own achievements (Achievements & Leaderboards, Phase 1, §6).
 *
 * Self-scoped: the route carries `:playerId` but is **not** marked
 * `publicGuildProfile`, so the player-scope hook lets a Portal session point it
 * only at itself. The full, resolved list — including in-progress and hidden
 * badges — is a player's own view of their progress. Another player's
 * achievements are surfaced only as the showcase-safe summary embedded in the
 * public profile (see `playerDirectory.ts`), never as this list.
 *
 * The handler does no evaluation: the service returns resolved, hidden-safe
 * state and this maps it into the envelope (§6 — the Portal never computes
 * achievement rules).
 */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { achievementsResponseSchema } from '../../schemas/achievements';

export const achievementRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/achievements',
      {
        schema: {
          tags: ['Achievements'],
          summary: "Get a player's achievements",
          description:
            'The player\'s own achievement wall: every definition resolved to locked, ' +
            'in-progress, or unlocked, with progress and unlock time, plus a summary. ' +
            'Self-scoped — a Portal session may read only its own. Hidden achievements that ' +
            'are still locked arrive as a generic "???" card with no criteria or progress.',
          params: playerIdParams,
          response: {
            200: dataSchema(achievementsResponseSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const player = requirePlayer(req);
        const result = await ctx.services.achievements.getPlayerAchievements(player.id);
        return ok(req, result);
      },
    );
  };
