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
import { toOwnedWaifuResource, toSpeciesResource } from '../../resources';
import { dataSchema, ok, okPage, paginatedSchema } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import {
  collectionPageQuery,
  commonErrorResponses,
  notFoundResponse,
  playerIdParams,
  waifuIdParams,
} from '../../schemas/common';
import { appearanceGallerySchema, setAppearanceBody } from '../../schemas/appearance';
import { dexStatsSchema, ownedEntrySchema } from '../../schemas/collection';
import type { OwnedEntry } from '../../../modules/collection/collectionService';

export const collectionRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    const { appearance, collection } = ctx.services;

    /**
     * Progress is pure arithmetic over the row already in hand — no query.
     * Appearance resolution is likewise a pure content lookup, so embedding the
     * catalog and the selected appearance costs no round trip.
     */
    const toEntry = (entry: OwnedEntry) => ({
      waifu: toOwnedWaifuResource(entry.waifu, entry.species, appearance),
      species: toSpeciesResource(entry.species, appearance.catalogFor(entry.species)),
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

    // ── Appearances (cosmetic only) ───────────────────────────────────────
    //
    // Both routes return `assetId` and nothing resembling a location. See
    // `src/api/schemas/appearance.ts` for the contract and the CI guardrail
    // that keeps it honest.

    app.get(
      '/players/:playerId/collection/owned/:waifuId/appearances',
      {
        schema: {
          tags: ['Collection'],
          summary: 'List this copy’s appearances',
          description:
            'The full gallery, **locked entries included**, each carrying its `unlockLabel` — ' +
            'the gallery is a progression journal, not a lock indicator. Purely cosmetic: an ' +
            'appearance never affects stats, XP, affection, evolution, or capture odds.\n\n' +
            'Reading has one side effect by design: appearances this copy already qualifies for ' +
            'but has never been notified about are acknowledged now, and an `appearance_unlock` ' +
            'audit row is written with `source: "content_add"`. That is what makes retroactively ' +
            'added artwork unlock itself with no backfill job.',
          params: waifuIdParams,
          response: {
            200: dataSchema(appearanceGallerySchema),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const gallery = await appearance.listAppearances(
          requirePlayer(req).id,
          req.params.waifuId,
        );
        return ok(req, gallery);
      },
    );

    app.put(
      '/players/:playerId/collection/owned/:waifuId/appearance',
      {
        schema: {
          tags: ['Collection'],
          summary: 'Select this copy’s appearance',
          description:
            'Points the copy at a different unlocked appearance. Writes exactly one column ' +
            '(`variant`) — level, XP, affection, favourite state and everything else are ' +
            'untouched, and the integration suite diffs the row to prove it.\n\n' +
            '`400 APPEARANCE_NOT_FOUND` for an id the species does not have, ' +
            '`409 APPEARANCE_LOCKED` for one this copy has not earned, ' +
            '`404 WAIFU_NOT_OWNED` for a copy that is not the player’s.',
          params: waifuIdParams,
          body: setAppearanceBody,
          response: {
            200: dataSchema(ownedEntrySchema),
            409: commonErrorResponses[400].describe('The appearance is not unlocked yet.'),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const playerId = requirePlayer(req).id;
        await appearance.selectAppearance(
          playerId,
          req.params.waifuId,
          req.body.appearanceId,
        );
        // Re-read through the collection service so the response is the same
        // resource shape (and the same joins) every other collection route
        // returns — one embedded entry, not a bespoke selection payload.
        const entry = await collection.getOwned(playerId, req.params.waifuId);
        return ok(req, toEntry(entry));
      },
    );
  };
