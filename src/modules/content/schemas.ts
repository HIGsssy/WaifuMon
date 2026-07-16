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

export const HUNT_RESULT_KINDS = [
  'encounter',
  'item_find',
  'waifubux_find',
  'essence_find',
  'rare_item_find',
  'flavor',
] as const;
export type HuntResultKind = (typeof HUNT_RESULT_KINDS)[number];

const WeightedResult = z.object({
  kind: z.enum(HUNT_RESULT_KINDS),
  weight: z.number().nonnegative(),
});

const WeightedRarity = z.object({
  rarity: z.enum(RARITIES),
  weight: z.number().nonnegative(),
});

const ItemSubEntry = z
  .object({
    slug,
    weight: z.number().nonnegative(),
    minQty: z.number().int().positive(),
    maxQty: z.number().int().positive(),
  })
  .refine((e) => e.maxQty >= e.minQty, {
    message: 'maxQty must be >= minQty',
    path: ['maxQty'],
  });

const IntRange = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .refine((v) => v.max >= v.min, { message: 'max must be >= min', path: ['max'] });

export const HuntTableSchema = z.object({
  cooldownSeconds: z.number().int().nonnegative(),
  encounterExpirySeconds: z.number().int().positive(),
  resultTable: z.array(WeightedResult).min(1),
  rarityTable: z.array(WeightedRarity).min(1),
  itemFind: z.object({ sub: z.array(ItemSubEntry).min(1) }),
  rareItemFind: z.object({ sub: z.array(ItemSubEntry).min(1) }),
  waifubuxFind: IntRange,
  essenceFind: IntRange,
  flavor: z.array(z.string().min(1)).min(1),
});

/**
 * Capture math config: default base-capture rates per rarity, clamp bounds,
 * and the rarity thresholds for public announcements and @here mentions.
 * Species-level `baseCaptureRate` overrides the rarity default when set.
 */
export const CaptureConfigSchema = z.object({
  baseRatesByRarity: z.object(
    Object.fromEntries(
      RARITIES.map((r) => [r, z.number().gt(0).lte(1)] as const),
    ) as { [K in (typeof RARITIES)[number]]: z.ZodNumber },
  ),
  minChance: z.number().gt(0).lt(1),
  maxChance: z.number().gt(0).lte(1),
  /** Rarity at or above which a capture posts a public announcement. */
  announceMinRarity: z.enum(RARITIES),
  /** Rarity at or above which the announcement includes an @here mention. */
  hereMentionMinRarity: z.enum(RARITIES),
});

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
  hunt: HuntTableSchema,
  capture: CaptureConfigSchema,
});

export type ItemContent = z.infer<typeof ItemContentSchema>;
export type SpeciesContent = z.infer<typeof SpeciesContentSchema>;
export type TablesContent = z.infer<typeof TablesFileSchema>;

export interface LoadedContent {
  items: ItemContent[];
  species: SpeciesContent[];
  tables: TablesContent;
}
