/** Active consumable buffs. */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { nullableCaptureBonusSchema } from '../../schemas/effects';

export const effectsRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/effects/capture-bonus',
      {
        schema: {
          tags: ['Effects'],
          summary: 'Get the active capture-bonus buff',
          description:
            'Returns `data: null` when no buff is active or the current one has expired — "no ' +
            'buff" is a normal state, not a missing resource, so this is 200 rather than 404.',
          params: playerIdParams,
          response: {
            200: dataSchema(nullableCaptureBonusSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await ctx.services.effects.getCaptureBonus(requirePlayer(req).id)),
    );
  };
