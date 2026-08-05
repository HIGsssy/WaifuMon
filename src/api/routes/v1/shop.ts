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
            'Every enabled capture or consumable item, including rows that are listed but not ' +
            'currently buyable — `available` and `availabilityNote` say which is which. The ' +
            'catalog is player-independent; affordability is not evaluated here.',
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
