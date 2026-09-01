/** Shop catalog. Purchasing is a Phase 3 mutation. */
import { z } from 'zod';
import type { ApiContext } from '../../context';
import { toItemResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses } from '../../schemas/common';
import { shopCatalogEntrySchema } from '../../schemas/shop';

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
  };
