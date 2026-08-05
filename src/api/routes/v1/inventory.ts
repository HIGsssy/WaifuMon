/** Inventory contents. Using an item is a Phase 3 mutation. */
import { z } from 'zod';
import type { ApiContext } from '../../context';
import { requirePlayer } from '../../plugins/playerScope';
import { toItemResource } from '../../resources';
import { dataSchema, ok } from '../../plugins/responseEnvelope';
import type { FastifyPluginAsyncZod } from '../../plugins/typeProvider';
import { commonErrorResponses, notFoundResponse, playerIdParams } from '../../schemas/common';
import { inventoryEntrySchema } from '../../schemas/inventory';

export const inventoryRoutes =
  (ctx: ApiContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/players/:playerId/inventory',
      {
        schema: {
          tags: ['Inventory'],
          summary: 'List inventory',
          description:
            'Every item the player holds, ordered by category then price. Zero-quantity rows are ' +
            'omitted. Not paginated — an inventory is bounded by the item catalog.',
          params: playerIdParams,
          response: {
            200: dataSchema(z.array(inventoryEntrySchema)),
            ...notFoundResponse,
            ...commonErrorResponses,
          },
        },
      },
      async (req) => {
        const entries = await ctx.services.inventory.getInventory(requirePlayer(req).id);
        return ok(
          req,
          entries.map((e) => ({ item: toItemResource(e.item), quantity: e.quantity })),
        );
      },
    );
  };
