/** Currency balances. */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { toCurrencyResource } from '../../resources';
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
          description:
            'Hunt Energy and its level-derived ceiling, WaifuBux and Essence, plus when they ' +
            'last changed.',
          params: playerIdParams,
          response: {
            200: dataSchema(currencySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const player = requirePlayer(req);
        const balances = await ctx.services.currency.getBalances(player.id);
        return ok(
          req,
          toCurrencyResource(balances, ctx.services.progression.computeMaxEnergy(player.level)),
        );
      },
    );
  };
