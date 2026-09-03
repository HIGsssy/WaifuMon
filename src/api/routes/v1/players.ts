/**
 * Players — identity and the composite profile.
 *
 * `/players/lookup` is the bridge from Discord identity to the internal id
 * every other player-scoped route takes. Fastify's router prefers the static
 * segment over `:playerId`, so the two coexist without ambiguity.
 */
import type { PlayerRow } from '../../../db/schema';
import type { ApiContext } from '../../context';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import { requirePlayer } from '../../plugins/playerScope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { ApiPlayerNotFoundError } from '../../errors';
import { noIdentity } from '../../identity';
import { toCurrencyResource, toCurrentRegionResource, toPlayerResource } from '../../resources';
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
    // Presentation identity is optional infrastructure: a process wired without
    // a Discord client answers `identity: null` and every other field is
    // unaffected. The resolver already caches, times out and never rejects
    // (`src/api/identity.ts`), so calling it on a read path is bounded.
    const resolveIdentity = ctx.resolveIdentity ?? noIdentity;

    /**
     * The three non-column facts every player resource carries.
     *
     * Gathered once so `/players/{id}` and `/players/{id}/profile` cannot drift
     * apart, and so it is obvious that none of it costs a query: `progressFor`
     * is arithmetic over `player.xp`, and the region name is a lookup in the
     * in-memory content snapshot. The identity resolver is cached, capped and
     * never rejects, so awaiting it on a read path is bounded.
     */
    const playerContext = async (player: PlayerRow) => ({
      identity: await resolveIdentity(player.discordUserId),
      progress: ctx.services.progression.progressFor(player.xp),
      currentRegion: toCurrentRegionResource(player.currentRegion, ctx.getContent().regions),
    });

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
          description:
            'Identity, level/XP, buddy pointer and a Care Mode summary. `identity` carries the ' +
            'Discord display name and avatar for presentation and is null whenever they cannot ' +
            'be resolved — treat it as optional.',
          params: playerIdParams,
          response: {
            200: dataSchema(playerSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      // Served from the row the player-scope hook already resolved — no second
      // query. The identity lookup is cached and capped, not a database read.
      async (req) => {
        const player = requirePlayer(req);
        return ok(req, toPlayerResource(player, await playerContext(player)));
      },
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
        // Concurrent: the balance read hits Postgres, the identity lookup hits
        // an in-process cache (and at worst the gateway). Neither waits.
        const [balances, context] = await Promise.all([
          ctx.services.currency.getBalances(player.id),
          playerContext(player),
        ]);
        return ok(req, {
          player: toPlayerResource(player, context),
          // The Energy ceiling comes from the same function Care Mode reports
          // through, so the two surfaces cannot disagree about the cap.
          currencies: toCurrencyResource(
            balances,
            ctx.services.progression.computeMaxEnergy(player.level),
          ),
        });
      },
    );
  };
