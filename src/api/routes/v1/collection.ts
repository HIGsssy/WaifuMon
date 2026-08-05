/**
 * Collection — dex stats, the owned list, a single owned copy, and the buddy.
 *
 * Pagination note: `collectionService.listOwned` clamps `pageSize` to 25 (it
 * was written for Discord select menus). The API validates to that same
 * ceiling rather than the envelope's general 100, so asking for more is a
 * clear 400 instead of a silently-truncated page. Raising the service clamp
 * would mean changing a gameplay service purely for the API's convenience,
 * which plan §5 asks us to avoid — if a future client genuinely needs larger
 * pages, that is a deliberate, tested service change, not a quiet one.
 *
 * `GET /collection/buddy` is not in the plan's route tree (which only lists
 * the Phase 3 `DELETE`), but the buddy is a first-class read resource and a
 * client would otherwise have to fetch the player, read `buddyWaifuId`, then
 * fetch that copy. Purely additive, and it mirrors `collectionService.getBuddy`
 * one-for-one.
 */
import type { ApiContext } from '../../context';
import { ApiNoActiveResourceError } from '../../errors';
import { requirePlayer } from '../../plugins/playerScope';
import { toSpeciesResource } from '../../resources';
import { dataSchema, ok, okPage, paginatedSchema } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  collectionPageQuery,
  commonErrorResponses,
  notFoundResponse,
  playerIdParams,
  waifuIdParams,
} from '../../schemas/common';
import { dexStatsSchema, ownedEntrySchema } from '../../schemas/collection';
import type { OwnedEntry } from '../../../modules/collection/collectionService';

export const collectionRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const { collection } = ctx.services;

    /** Progress is pure arithmetic over the row already in hand — no query. */
    const toEntry = (entry: OwnedEntry) => ({
      waifu: entry.waifu,
      species: toSpeciesResource(entry.species),
      progress: collection.waifuProgress(entry.waifu),
    });

    app.get(
      '/players/:playerId/collection/stats',
      {
        schema: {
          tags: ['Collection'],
          summary: 'Dex progress',
          description: 'Active owned count, distinct species owned, and the enabled-species total.',
          params: playerIdParams,
          response: {
            200: dataSchema(dexStatsSchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => ok(req, await collection.getDexStats(requirePlayer(req).id)),
    );

    app.get(
      '/players/:playerId/collection/owned',
      {
        schema: {
          tags: ['Collection'],
          summary: 'List owned Waifumon',
          description:
            'Active (non-released) copies, rarest first. Paginated; `pageSize` is capped at 25 ' +
            'to match the service. Optionally filtered to a single rarity.',
          params: playerIdParams,
          querystring: collectionPageQuery,
          response: {
            200: paginatedSchema(ownedEntrySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const { page, pageSize, rarity } = req.query;
        const result = await collection.listOwned(requirePlayer(req).id, {
          page,
          pageSize,
          ...(rarity ? { rarity } : {}),
        });
        // Echo the service's own page/pageSize: it clamps an out-of-range page
        // to the last one, and the client should see where it actually landed.
        return okPage(
          req,
          result.entries.map(toEntry),
          result.page,
          result.pageSize,
          result.totalOwned,
        );
      },
    );

    app.get(
      '/players/:playerId/collection/owned/:waifuId',
      {
        schema: {
          tags: ['Collection'],
          summary: 'Get one owned Waifumon',
          description:
            'Returns 404 (`WAIFU_NOT_OWNED`) when the copy belongs to someone else, does not ' +
            'exist, or has been released.',
          params: waifuIdParams,
          response: {
            200: dataSchema(ownedEntrySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const entry = await collection.getOwned(requirePlayer(req).id, req.params.waifuId);
        return ok(req, toEntry(entry));
      },
    );

    app.get(
      '/players/:playerId/collection/buddy',
      {
        schema: {
          tags: ['Collection'],
          summary: 'Get the active buddy',
          description:
            'Returns 404 (`BUDDY_NOT_SET`) when no buddy is set. A buddy pointing at a released ' +
            'copy is self-healed by the service and reads as no buddy.',
          params: playerIdParams,
          response: {
            200: dataSchema(ownedEntrySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const buddy = await collection.getBuddy(requirePlayer(req).id);
        if (!buddy) {
          throw new ApiNoActiveResourceError(
            'BUDDY_NOT_SET',
            'Player has no active buddy',
            'No buddy is set.',
          );
        }
        return ok(req, toEntry(buddy));
      },
    );
  };
