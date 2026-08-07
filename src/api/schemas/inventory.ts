/** Inventory: quantities of seeded items. Zero-quantity rows are filtered out by the service. */
import { z } from 'zod';
import { itemSchema } from './content';

export const inventoryEntrySchema = z.object({
  item: itemSchema,
  quantity: z.number().int().positive(),
});
