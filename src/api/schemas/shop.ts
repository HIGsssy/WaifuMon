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

/**
 * One inventory stack the player could sell. The service filters eligibility
 * in its query, so the API does not re-derive sellability here — the same
 * one-place rule that keeps `available` out of the catalog route.
 *
 * `unitValue` is always WaifuBux. `priceCurrency` on the nested item describes
 * what the item costs to *buy* and has no bearing on what selling pays.
 */
export const sellableEntrySchema = z.object({
  item: itemSchema,
  quantity: z.number().int().positive(),
  unitValue: z.number().int().positive().describe('WaifuBux paid per unit.'),
  stackValue: z.number().int().positive().describe('unitValue x quantity.'),
});
