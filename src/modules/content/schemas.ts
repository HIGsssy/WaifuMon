import { z } from 'zod';
import { CONTENT_RATINGS, ITEM_CATEGORIES, RARITIES } from '../../db/schema';

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_]+$/, 'slug must be lowercase snake_case');

export const ItemContentSchema = z
  .object({
    slug,
    name: z.string().min(1),
    category: z.enum(ITEM_CATEGORIES),
    captureModifier: z.number().positive().nullable(),
    isGuaranteedCapture: z.boolean().default(false),
    purchasable: z.boolean().default(false),
    buyPrice: z.number().int().positive().nullable().default(null),
    dailyStockLimit: z.number().int().positive().nullable().default(null),
    description: z.string().default(''),
    emoji: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((item, ctx) => {
    // Schema-level invariants from the plan (§21).
    if (item.isGuaranteedCapture && item.purchasable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": is_guaranteed_capture=true requires purchasable=false`,
        path: ['purchasable'],
      });
    }
    if (item.purchasable && item.buyPrice == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": purchasable=true requires buy_price`,
        path: ['buyPrice'],
      });
    }
  });

export const ItemsFileSchema = z.object({ items: z.array(ItemContentSchema).min(1) });

export const SpeciesContentSchema = z.object({
  slug,
  name: z.string().min(1),
  rarity: z.enum(RARITIES),
  archetype: z.string().min(1),
  baseCaptureRate: z.number().gt(0).lte(1).nullable().default(null),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  contentRating: z.enum(CONTENT_RATINGS),
  imagePath: z.string().min(1),
  enabled: z.boolean().default(true),
  eventKey: z.string().nullable().default(null),
  perSpeciesWeight: z.number().int().positive().default(1),
});

export const SpeciesFileSchema = z.array(SpeciesContentSchema);

export const TablesFileSchema = z.object({
  energy: z.object({
    baseMax: z.number().int().positive(),
  }),
  inventory: z.object({
    /** Soft cap on total capture items; enforced at acquisition time. */
    captureCapacity: z.number().int().positive(),
  }),
  dailyPackage: z.object({
    waifubux: z.number().int().nonnegative(),
    /** item slug -> quantity granted per daily claim */
    items: z.record(slug, z.number().int().positive()),
  }),
});

export type ItemContent = z.infer<typeof ItemContentSchema>;
export type SpeciesContent = z.infer<typeof SpeciesContentSchema>;
export type TablesContent = z.infer<typeof TablesFileSchema>;

export interface LoadedContent {
  items: ItemContent[];
  species: SpeciesContent[];
  tables: TablesContent;
}
