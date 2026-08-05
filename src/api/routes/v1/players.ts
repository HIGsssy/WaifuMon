/**
 * Players — identity and the composite profile.
 *
 * `/players/lookup` is the bridge from Discord identity to the internal id
 * every other player-scoped route takes. Fastify's router prefers the static
 * segment over `:playerId`, so the two coexist without ambiguity.
 */
import type { ApiContext } from '../../context';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import { requirePlayer } from '../../plugins/playerScope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { ApiPlayerNotFoundError } from '../../errors';
import { toPlayerResource } from '../../resources';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import {
  playerLookupQuery,
  playerLookupSchema,
  playerProfileSchema,
  playerSchema,
} from '../../schemas/players';

export const playerRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/lookup',
      {
        schema: {
          tags: ['Players'],
          summary: 'Resolve a Discord identity to an internal player id',
          description:
            'Read-only. Returns 404 when the pair has never played — this endpoint never provisions ' +
            'a player (provisioning is `POST /players/ensure`, which lands in Phase 3).',
          querystring: playerLookupQuery,
          response: {
            200: dataSchema(playerLookupSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { discordGuildId, discordUserId } = req.query;
        const playerId = await ctx.services.players.findPlayerId(discordGuildId, discordUserId);
        if (playerId === null) {
          throw new ApiPlayerNotFoundError(`${discordGuildId}/${discordUserId}`);
        }
        return ok(req, { playerId });
      },
    );

    app.get(
      '/players/:playerId',
      {
        schema: {
          tags: ['Players'],
          summary: 'Get a player',
          description: 'Identity, level/XP, buddy pointer and a Care Mode summary.',
          params: playerIdParams,
          response: {
            200: dataSchema(playerSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      // Served from the row the player-scope hook already resolved — no second query.
      async (req) => ok(req, toPlayerResource(requirePlayer(req))),
    );

    app.get(
      '/players/:playerId/profile',
      {
        schema: {
          tags: ['Players'],
          summary: 'Get a player with their balances',
          description:
            'Composite of the player resource and their currency balances, saving a round trip. ' +
            'Equivalent to calling GET /players/{playerId} and GET /players/{playerId}/currency.',
          params: playerIdParams,
          response: {
            200: dataSchema(playerProfileSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        // `playerService.getProfile` is the service-side composite, but it
        // re-reads the player row the scope hook already holds. Pairing that
        // row with one balance read is the same two queries, minus one.
        const player = requirePlayer(req);
        const currencies = await ctx.services.currency.getBalances(player.id);
        return ok(req, { player: toPlayerResource(player), currencies });
      },
    );
  };
