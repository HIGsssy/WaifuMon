/** Daily reward status. Claiming is a Phase 3 mutation. */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { dailyStatusSchema } from '../../schemas/daily';

export const dailyRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/daily',
      {
        schema: {
          tags: ['Daily'],
          summary: 'Get daily claim status',
          description:
            'Whether today\'s reward has been claimed, and when the next reset falls. "Today" is ' +
            'reckoned in the server\'s configured daily timezone, not the caller\'s.',
          params: playerIdParams,
          response: {
            200: dataSchema(dailyStatusSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await ctx.services.daily.status(requirePlayer(req).id)),
    );
  };
