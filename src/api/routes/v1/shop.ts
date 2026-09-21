/**
 * Shop catalog and the player's sellable stacks. Both directions of the
 * counter are read-only here: purchasing and selling are Phase 3 mutations.
 */
import { z } from 'zod';
import type { ApiContext } from '../../context';
import { toItemResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { requirePlayer } from '../../plugins/playerScope';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { sellableEntrySchema, shopCatalogEntrySchema } from '../../schemas/shop';

export const shopRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/shop/catalog',
      {
        schema: {
          tags: ['Shop'],
          summary: 'List the shop catalog',
          description:
            'The union of every region shop: enabled, priced capture and consumable items ' +
            'that are sold in at least one region. Items that exist only as drops or rewards ' +
            '(affection gifts, the Mythic Contract) are never listed. The catalog is ' +
            'player- and region-independent; affordability is not evaluated here.',
          response: {
            200: dataSchema(z.array(shopCatalogEntrySchema)),
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const catalog = await ctx.services.shop.getCatalog();
        return ok(
          req,
          catalog.map((entry) => ({ ...entry, item: toItemResource(entry.item) })),
        );
      },
    );

    app.get(
      '/players/:playerId/shop/sellable',
      {
        schema: {
          tags: ['Shop'],
          summary: 'List the stacks this player could sell',
          description:
            'Every inventory stack the player holds that is enabled and carries a sell value, ' +
            'most valuable stack first. Selling is global rather than region-gated, so this ' +
            'takes no region and a stack listed here is sellable anywhere. Items with no sell ' +
            'value — which is most of the catalog — are never listed.',
          params: playerIdParams,
          response: {
            200: dataSchema(z.array(sellableEntrySchema)),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const entries = await ctx.services.shop.getSellableInventory(requirePlayer(req).id);
        return ok(
          req,
          entries.map((e) => ({ ...e, item: toItemResource(e.item) })),
        );
      },
    );
  };
