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

/**
 * Duplicate + release economy. `essenceByRarity` is the full-value grant paid
 * on "Convert to Essence" after a duplicate capture; releasing an owned copy
 * grants `floor(essenceByRarity[rarity] × releaseFraction)`.
 */
export const DuplicateConfigSchema = z.object({
  essenceByRarity: z.object(
    Object.fromEntries(
      RARITIES.map((r) => [r, z.number().int().nonnegative()] as const),
    ) as { [K in (typeof RARITIES)[number]]: z.ZodNumber },
  ),
  /** Fraction of the duplicate-essence value granted on a manual release. */
  releaseFraction: z.number().gt(0).lte(1),
  /** How long the ephemeral Keep/Convert prompt stays valid (defaults to Keep). */
  keepOnTimeoutSeconds: z.number().int().positive(),
});

const RarityXpMap = z.object(
  Object.fromEntries(
    RARITIES.map((r) => [r, z.number().int().nonnegative()] as const),
  ) as { [K in (typeof RARITIES)[number]]: z.ZodNumber },
);

/**
 * Player XP & level rewards. All data-driven so balancing is a JSON tweak.
 * Level curve is linear-ish: xp_to_next(level) = base + growth × (level − 1).
 */
export const ProgressionConfigSchema = z.object({
  levelCurve: z.object({
    base: z.number().int().positive(),
    growth: z.number().int().nonnegative(),
  }),
  maxLevel: z.number().int().positive(),
  maxEnergy: z.object({
    cap: z.number().int().positive(),
    /** Additive bonuses that apply when the player's level meets `atLevel`. */
    levelBonuses: z
      .array(
        z.object({
          atLevel: z.number().int().positive(),
          delta: z.number().int().nonnegative(),
        }),
      )
      .default([]),
  }),
  xp: z.object({
    hunt: z.number().int().nonnegative(),
    captureFailed: z.number().int().nonnegative(),
    captureSuccessByRarity: RarityXpMap,
    newDexEntry: z.number().int().nonnegative(),
    dailyClaim: z.number().int().nonnegative(),
  }),
  /**
   * Level-40 "shift" of the rarity table: move `weightUnits` from `fromRarity`
   * to `toRarity`. Kept additive so it can never turn negative.
   */
  rareEncounterShift: z.object({
    atLevel: z.number().int().positive(),
    fromRarity: z.enum(RARITIES),
    toRarity: z.enum(RARITIES),
    weightUnits: z.number().nonnegative(),
  }),
  dailyBonusItems: z
    .array(
      z.object({
        atLevel: z.number().int().positive(),
        slug: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .default([]),
  dailyRareItemChance: z.object({
    atLevel: z.number().int().positive(),
    chance: z.number().gte(0).lte(1),
    slug: z.string().min(1),
    quantity: z.number().int().positive(),
  }),
  prestigeTitles: z
    .array(
      z.object({
        atLevel: z.number().int().positive(),
        label: z.string().min(1),
      }),
    )
    .default([]),
});

/**
 * Waifumon-side progression: per-copy level curve, buddy hunt rewards, and
 * Essence investment yields. Separate from player XP so both can be tuned
 * without spillover.
 */
export const WaifuProgressionConfigSchema = z.object({
  levelCurve: z.object({
    base: z.number().int().positive(),
    growth: z.number().int().nonnegative(),
  }),
  maxLevel: z.number().int().positive(),
  buddy: z.object({
    xpPerHunt: z.number().int().nonnegative(),
    affectionPerHunt: z.number().int().nonnegative(),
  }),
  essenceInvestment: z.object({
    essenceCost: z.number().int().positive(),
    xpGranted: z.number().int().positive(),
  }),
  /** Minimum waifu level required before a nickname can be set. */
  nicknameMinLevel: z.number().int().positive(),
});

/**
 * Optional cosmetic flavor text pools that hydrate the session board UI.
 * Empty arrays and missing entries are safe — render helpers fall back to a
 * built-in default line.
 */
export const UiFlavorConfigSchema = z
  .object({
    mainMenu: z.array(z.string().min(1)).default([]),
  })
  .default({ mainMenu: [] });

/**
 * Public session-board tunables. `inactiveTimeoutMinutes` controls when a
 * stale board is retired: after that many minutes without owner activity,
 * `/waifumon` ends the old public message and starts a fresh board instead
 * of editing the stale one. Old buttons/selects from an expired session are
 * rejected ephemerally without mutating state.
 */
export const SessionConfigSchema = z
  .object({
    inactiveTimeoutMinutes: z.number().int().positive().default(45),
  })
  .default({ inactiveTimeoutMinutes: 45 });

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
  duplicate: DuplicateConfigSchema,
  progression: ProgressionConfigSchema,
  waifuProgression: WaifuProgressionConfigSchema,
  uiFlavor: UiFlavorConfigSchema.optional().default({ mainMenu: [] }),
  session: SessionConfigSchema.optional().default({ inactiveTimeoutMinutes: 45 }),
});

export type ItemContent = z.infer<typeof ItemContentSchema>;
export type SpeciesContent = z.infer<typeof SpeciesContentSchema>;
export type TablesContent = z.infer<typeof TablesFileSchema>;
export type DuplicateConfig = z.infer<typeof DuplicateConfigSchema>;
export type ProgressionConfig = z.infer<typeof ProgressionConfigSchema>;
export type WaifuProgressionConfig = z.infer<typeof WaifuProgressionConfigSchema>;

export interface LoadedContent {
  items: ItemContent[];
  species: SpeciesContent[];
  tables: TablesContent;
}
