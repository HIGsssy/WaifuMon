/**
 * Shop catalog. `available` and `availabilityNote` come straight from the
 * service — the API does not re-derive purchasability, which is exactly the
 * kind of rule that must stay in one place.
 */
import { z } from 'zod';
import { itemSchema } from './content';

export const shopCatalogEntrySchema = z.object({
  item: itemSchema,
  available: z.boolean().describe('True when the item can actually be bought right now.'),
  availabilityNote: z
    .string()
    .nullable()
    .describe('Display label for unavailable rows, e.g. "Not for sale".'),
  currency: z.enum(['waifubux', 'essence']).describe('Currency buyPrice is denominated in.'),
});
