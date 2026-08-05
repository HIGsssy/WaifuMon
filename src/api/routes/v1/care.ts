/**
 * Care Mode — read half only. Entering, leaving and retargeting are Phase 3.
 *
 * `careService.getState` is explicitly non-mutating: `pendingTicks` is a
 * forecast, and reading it never banks the ticks. That is what makes this
 * endpoint safe to poll.
 */
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { toSpeciesResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { careStateSchema } from '../../schemas/care';

export const careRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/care',
      {
        schema: {
          tags: ['Care Mode'],
          summary: 'Get Care Mode state',
          description:
            'Non-mutating snapshot: whether Care Mode is running, the target, the tick schedule ' +
            'and the tuning in force. `pendingTicks` forecasts what would be granted if ticks ' +
            'were applied now — reading does not apply them. `enabled: false` means Care Mode is ' +
            'switched off by server configuration.',
          params: playerIdParams,
          response: {
            200: dataSchema(careStateSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const state = await ctx.services.care.getState(requirePlayer(req).id);
        return ok(req, {
          ...state,
          target: state.target
            ? { waifu: state.target.waifu, species: toSpeciesResource(state.target.species) }
            : null,
        });
      },
    );
  };
