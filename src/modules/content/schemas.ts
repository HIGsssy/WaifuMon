import { z } from 'zod';
import {
  AFFINITIES,
  CONTENT_RATINGS,
  DEFAULT_AFFINITY,
  ITEM_CATEGORIES,
  ITEM_EFFECT_TYPES,
  PRICE_CURRENCIES,
  RARITIES,
} from '../../db/schema';

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_]+$/, 'slug must be lowercase snake_case');

/**
 * Upper bound on a single capture-bonus item. Small and hard-capped on
 * purpose: the additive capture terms (buddy affinity + item buffs) must never
 * add up to something that trivializes rare captures. The admin panel surfaces
 * this same bound in its field hint.
 */
export const MAX_ITEM_CAPTURE_BONUS = 0.25;

/**
 * Energy Drink. `restoreToMax` is a literal `true` — a "restore energy but not
 * to max" variant would be a different effect type, not a config flag.
 * `exitCareMode` documents (and lets an admin flip) the Care Mode interaction:
 * shipped as `true`, i.e. drinking wakes you up.
 */
export const RestoreEnergyEffectSchema = z
  .object({
    restoreToMax: z.literal(true).default(true),
    exitCareMode: z.boolean().default(true),
  })
  .strict();

/**
 * Microdose. Flat capture bonus for a fixed number of *capture attempts*.
 * `refreshBehavior` decides what a second use does while one is already
 * active: `refresh` resets charges to the configured max (never above it),
 * `ignore` leaves the running buff untouched (and refunds nothing).
 */
export const CaptureBonusEffectSchema = z
  .object({
    captureBonus: z.number().gte(0).lte(MAX_ITEM_CAPTURE_BONUS),
    charges: z.number().int().positive(),
    refreshBehavior: z.enum(['refresh', 'ignore']).default('refresh'),
  })
  .strict();

export type ItemEffectType = (typeof ITEM_EFFECT_TYPES)[number];
export type RestoreEnergyEffect = z.infer<typeof RestoreEnergyEffectSchema>;
export type CaptureBonusEffect = z.infer<typeof CaptureBonusEffectSchema>;
export type ItemEffectConfig = RestoreEnergyEffect | CaptureBonusEffect;

/** The config schema that goes with an `effectType`. */
export function effectConfigSchemaFor(
  effectType: ItemEffectType,
): typeof RestoreEnergyEffectSchema | typeof CaptureBonusEffectSchema {
  return effectType === 'restore_energy_full'
    ? RestoreEnergyEffectSchema
    : CaptureBonusEffectSchema;
}

const ItemBaseSchema = z.object({
  slug,
  name: z.string().min(1),
  category: z.enum(ITEM_CATEGORIES),
  captureModifier: z.number().positive().nullable(),
  isGuaranteedCapture: z.boolean().default(false),
  purchasable: z.boolean().default(false),
  buyPrice: z.number().int().positive().nullable().default(null),
  /** Which currency `buyPrice` is denominated in; defaults to WaifuBux. */
  priceCurrency: z.enum(PRICE_CURRENCIES).default('waifubux'),
  dailyStockLimit: z.number().int().positive().nullable().default(null),
  /** Non-null makes the item usable from the inventory screen. */
  effectType: z.enum(ITEM_EFFECT_TYPES).nullable().default(null),
  /** Validated against `effectType` below, then normalized to the typed shape. */
  effectConfig: z.record(z.string(), z.unknown()).nullable().default(null),
  description: z.string().default(''),
  emoji: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});

export const ItemContentSchema = ItemBaseSchema.superRefine((item, ctx) => {
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
  if (item.effectType == null) {
    if (item.effectConfig != null && Object.keys(item.effectConfig).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": effectConfig requires an effectType`,
        path: ['effectConfig'],
      });
    }
    return;
  }
  // Per-type config validation. The sub-schemas are `.strict()`, so a
  // capture-only field on a restore_energy_full item is rejected by name.
  const parsed = effectConfigSchemaFor(item.effectType).safeParse(item.effectConfig ?? {});
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": effectConfig.${issue.path.join('.') || '(root)'} — ${issue.message}`,
        path: ['effectConfig', ...issue.path],
      });
    }
  }
}).transform((item) => ({
  ...item,
  // Safe: the superRefine above already rejected anything that fails here.
  effectConfig:
    item.effectType == null
      ? null
      : (effectConfigSchemaFor(item.effectType).parse(
          item.effectConfig ?? {},
        ) as ItemEffectConfig),
}));

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
  /**
   * Buddy capture-matchup style (Milestone 5D). Distinct from `archetype`
   * (what she is) and `variant` (which art renders). Omitted in older content
   * files → `switch`, which is always a neutral matchup.
   */
  affinity: z.enum(AFFINITIES).default(DEFAULT_AFFINITY),
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

const RarityNumberMap = (value: z.ZodNumber) =>
  z.object(
    Object.fromEntries(RARITIES.map((r) => [r, value] as const)) as {
      [K in (typeof RARITIES)[number]]: z.ZodNumber;
    },
  );

/**
 * Buddy Affinity (Milestone 5D). An active buddy whose affinity *beats* the
 * encounter's affinity adds a flat, rarity-scaled bonus to the capture chance
 * — applied after the charm multiplier and before the min/max clamp.
 *
 * `wheel` maps an affinity to the single affinity it beats. Styles listed in
 * `neutralStyles` (i.e. `switch`) short-circuit to neutral on either side of
 * the matchup, so they have no strengths and no weaknesses.
 *
 * `weakPenaltyByRarity` exists so unfavorable matchups are tunable later; all
 * shipped values are 0, i.e. a weak matchup costs nothing today.
 */
export const BuddyAffinityConfigSchema = z
  .object({
    styles: z.array(z.enum(AFFINITIES)).min(1).default([...AFFINITIES]),
    wheel: z.record(z.string(), z.enum(AFFINITIES)).default({}),
    neutralStyles: z.array(z.enum(AFFINITIES)).default([DEFAULT_AFFINITY]),
    strongBonusByRarity: RarityNumberMap(z.number().nonnegative()),
    /** Magnitude subtracted on a weak matchup. 0 = no penalty (current tuning). */
    weakPenaltyByRarity: RarityNumberMap(z.number().nonnegative()),
  })
  .superRefine((cfg, ctx) => {
    const allowed = new Set<string>(AFFINITIES);
    for (const [from, to] of Object.entries(cfg.wheel)) {
      if (!allowed.has(from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `buddyAffinity.wheel has unknown affinity key: ${from}`,
          path: ['wheel', from],
        });
        continue;
      }
      if (from === to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `buddyAffinity.wheel["${from}"] cannot beat itself`,
          path: ['wheel', from],
        });
      }
      // A neutral style must never appear on either side of a wheel edge —
      // that is what "no strengths, no weaknesses" means.
      if (cfg.neutralStyles.includes(from as (typeof AFFINITIES)[number])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `buddyAffinity.wheel lists neutral style "${from}" as a winner`,
          path: ['wheel', from],
        });
      }
      if (cfg.neutralStyles.includes(to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `buddyAffinity.wheel["${from}"] beats neutral style "${to}"`,
          path: ['wheel', from],
        });
      }
    }
  });

/** Neutral-everything fallback used when tables.json omits the block. */
const zeroByRarity = (): { [K in (typeof RARITIES)[number]]: number } =>
  Object.fromEntries(RARITIES.map((r) => [r, 0])) as {
    [K in (typeof RARITIES)[number]]: number;
  };

const BUDDY_AFFINITY_DEFAULT = {
  styles: [...AFFINITIES],
  wheel: {},
  neutralStyles: [DEFAULT_AFFINITY],
  strongBonusByRarity: zeroByRarity(),
  weakPenaltyByRarity: zeroByRarity(),
};

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
 * Daily launch splash screen shown once per (player, guild-day) on the first
 * `/waifumon` of the day. Body accepts either an array of lines (preferred —
 * easier to edit) or a single string; the loader normalizes both to lines.
 * `imagePath` is optional; when unset or unresolvable, the splash renders
 * text-only. `frequency` reserves the shape for future tuning but only
 * `daily` and `always` are honored today (`always` re-renders every launch).
 */
export const UiSplashConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    title: z.string().min(1).default('Welcome to Waifumon'),
    body: z
      .union([z.array(z.string().min(1)), z.string().min(1)])
      .default([])
      .transform((v) => (Array.isArray(v) ? v : [v])),
    imagePath: z.string().min(1).nullable().default(null),
    buttonLabel: z.string().min(1).default('Start Hunt'),
    frequency: z.enum(['daily', 'always']).default('daily'),
  })
  .default({
    enabled: false,
    title: 'Welcome to Waifumon',
    body: [],
    imagePath: null,
    buttonLabel: 'Start Hunt',
    frequency: 'daily',
  });

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

/**
 * Care Mode (Milestone 5B): idle state that recovers Hunt Energy and slowly
 * trains a chosen owned Waifumon. Ticks are computed lazily. Energy recovery
 * is capped both by `recoveryCap` and by the player's computed max energy;
 * Waifumon XP/affection continues even while energy is at the cap.
 */
export const CareModeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().positive(),
  energyPerTick: z.number().int().nonnegative(),
  recoveryCap: z.number().int().nonnegative(),
  waifuXpPerTick: z.number().int().nonnegative(),
  affectionPerTick: z.number().int().nonnegative(),
});

/**
 * Daily Quests (Milestone 5C): each player receives `questsPerDay` quests
 * per calendar day, drawn from `pool` using per-entry `weight`. Completing a
 * quest grants its `rewards`; completing all assigned quests grants the
 * shared `allCompleteBonus` once per day. All rewards are transactional.
 */
export const QUEST_EVENT_TYPES = [
  'hunt_energy_spent',
  'capture_attempts',
  'capture_success',
  'capture_success_rarity_at_least',
  'waifu_affection_gained',
  'care_mode_ticks',
  'duplicate_converted',
  'inspect_waifu',
] as const;
export type QuestEventType = (typeof QUEST_EVENT_TYPES)[number];

export const QUEST_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuestDifficulty = (typeof QUEST_DIFFICULTIES)[number];

const QuestRewardItemEntry = z.object({
  slug,
  quantity: z.number().int().positive(),
});

export const QuestRewardsSchema = z
  .object({
    waifubux: z.number().int().nonnegative().default(0),
    essence: z.number().int().nonnegative().default(0),
    items: z.array(QuestRewardItemEntry).default([]),
  })
  .refine((r) => r.waifubux > 0 || r.essence > 0 || r.items.length > 0, {
    message: 'quest reward must grant at least one of waifubux, essence, or items',
  });

export const QuestPoolEntrySchema = z
  .object({
    slug,
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(QUEST_EVENT_TYPES),
    target: z.number().int().positive(),
    weight: z.number().positive(),
    difficulty: z.enum(QUEST_DIFFICULTIES).default('easy'),
    /** For `capture_success_rarity_at_least`: required minimum rarity. */
    rarityAtLeast: z.enum(RARITIES).optional(),
    rewards: QuestRewardsSchema,
  })
  .superRefine((q, ctx) => {
    if (q.type === 'capture_success_rarity_at_least' && !q.rarityAtLeast) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${q.slug}": capture_success_rarity_at_least requires rarityAtLeast`,
        path: ['rarityAtLeast'],
      });
    }
    if (q.type !== 'capture_success_rarity_at_least' && q.rarityAtLeast) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${q.slug}": rarityAtLeast is only valid for capture_success_rarity_at_least`,
        path: ['rarityAtLeast'],
      });
    }
  });

export const DailyQuestsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    questsPerDay: z.number().int().positive().default(3),
    allCompleteBonus: QuestRewardsSchema.optional(),
    pool: z.array(QuestPoolEntrySchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const entry of cfg.pool) {
      if (seen.has(entry.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate quest slug in pool: ${entry.slug}`,
          path: ['pool'],
        });
      }
      seen.add(entry.slug);
    }
    if (cfg.enabled && cfg.pool.length > 0 && cfg.pool.length < cfg.questsPerDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dailyQuests.pool has ${cfg.pool.length} entries; fewer than questsPerDay=${cfg.questsPerDay}`,
        path: ['pool'],
      });
    }
  });

export const TablesFileSchema = z.object({
  energy: z.object({
    baseMax: z.number().int().positive(),
    careMode: CareModeConfigSchema,
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
  buddyAffinity: BuddyAffinityConfigSchema.optional().default(BUDDY_AFFINITY_DEFAULT),
  duplicate: DuplicateConfigSchema,
  progression: ProgressionConfigSchema,
  waifuProgression: WaifuProgressionConfigSchema,
  dailyQuests: DailyQuestsConfigSchema.optional().default({
    enabled: false,
    questsPerDay: 3,
    pool: [],
  }),
  uiFlavor: UiFlavorConfigSchema.optional().default({ mainMenu: [] }),
  uiSplash: UiSplashConfigSchema.optional().default({
    enabled: false,
    title: 'Welcome to Waifumon',
    body: [],
    imagePath: null,
    buttonLabel: 'Start Hunt',
    frequency: 'daily',
  }),
  session: SessionConfigSchema.optional().default({ inactiveTimeoutMinutes: 45 }),
});

export type ItemContent = z.infer<typeof ItemContentSchema>;
export type SpeciesContent = z.infer<typeof SpeciesContentSchema>;
export type TablesContent = z.infer<typeof TablesFileSchema>;
export type DuplicateConfig = z.infer<typeof DuplicateConfigSchema>;
export type BuddyAffinityConfig = z.infer<typeof BuddyAffinityConfigSchema>;
export type ProgressionConfig = z.infer<typeof ProgressionConfigSchema>;
export type WaifuProgressionConfig = z.infer<typeof WaifuProgressionConfigSchema>;
export type CareModeConfig = z.infer<typeof CareModeConfigSchema>;
export type DailyQuestsConfig = z.infer<typeof DailyQuestsConfigSchema>;
export type QuestPoolEntry = z.infer<typeof QuestPoolEntrySchema>;
export type QuestRewards = z.infer<typeof QuestRewardsSchema>;
export type UiSplashConfig = z.infer<typeof UiSplashConfigSchema>;

export interface LoadedContent {
  items: ItemContent[];
  species: SpeciesContent[];
  tables: TablesContent;
}
