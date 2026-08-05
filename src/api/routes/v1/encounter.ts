/**
 * The player's active encounter, if any. Hunting and capturing are Phase 3.
 *
 * An encounter that has passed `expiresAt` reads as absent (404) even before
 * the sweeper marks it `expired` — same rule the Discord path applies, so the
 * two surfaces agree on when she has slipped away.
 */
import type { ApiContext } from '../../context';
import { ApiNoActiveResourceError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import { toEncounterResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { encounterSchema } from '../../schemas/encounter';

export const encounterRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/encounter',
      {
        schema: {
          tags: ['Encounters'],
          summary: 'Get the active encounter',
          description:
            'Returns 404 (`ENCOUNTER_NOT_FOUND`) when the player is not currently facing anyone, ' +
            'including when the last encounter has passed its expiry. The species row is embedded ' +
            'because content endpoints are slug-addressed and carry no internal ids.',
          params: playerIdParams,
          response: {
            200: dataSchema(encounterSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const detail = await ctx.services.hunt.getActiveEncounterDetail(requirePlayer(req).id);
        if (!detail) {
          throw new ApiNoActiveResourceError(
            'ENCOUNTER_NOT_FOUND',
            'Player has no active encounter',
            "She's already gone~",
          );
        }
        return ok(req, toEncounterResource(detail.encounter, detail.species));
      },
    );
  };
