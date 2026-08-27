/**
 * Shop catalog. The service filters out everything that is not buyable, so the
 * API does not re-derive purchasability — exactly the kind of rule that must
 * stay in one place. `available`/`availabilityNote` are retained for wire
 * compatibility and are now always `true`/`null`.
 */
import { z } from 'zod';
import { itemSchema } from './content';

export const shopCatalogEntrySchema = z.object({
  item: itemSchema,
  available: z.boolean().describe('Always true — the catalog lists buyable items only.'),
  availabilityNote: z
    .string()
    .nullable()
    .describe('Always null — retained for wire compatibility.'),
  currency: z.enum(['waifubux', 'essence']).describe('Currency buyPrice is denominated in.'),
});
