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
            'Capture and consumable items that are enabled, purchasable and priced. Items that ' +
            'exist only as drops or rewards (affection gifts, the Mythic Contract) are never ' +
            'listed. The catalog is player-independent; affordability is not evaluated here.',
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
