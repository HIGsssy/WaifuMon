/** Currency balances. */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { currencySchema } from '../../schemas/currency';

export const currencyRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/currency',
      {
        schema: {
          tags: ['Currency'],
          summary: 'Get balances',
          description: 'Hunt Energy, WaifuBux and Essence, plus when they last changed.',
          params: playerIdParams,
          response: {
            200: dataSchema(currencySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await ctx.services.currency.getBalances(requirePlayer(req).id)),
    );
  };
