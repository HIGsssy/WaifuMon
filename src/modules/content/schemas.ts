import { z } from 'zod';
import {
  AFFECTION_GIFT_TIERS,
  AFFINITIES,
  CONTENT_RATINGS,
  DEFAULT_AFFINITY,
  ITEM_CATEGORIES,
  ITEM_EFFECT_TYPES,
  PRICE_CURRENCIES,
  RARITIES,
} from '../../db/schema';
/**
 * `RACE_CODES` lives in the cards module because the race set is defined by the
 * icon files in `assets/cardart/icons/races/` — adding a race means shipping an
 * icon. Importing it here rather than re-declaring keeps one source of truth;
 * a second copy would drift the day someone adds a race. The import is a leaf
 * (`race.ts` pulls in nothing but a type), so nothing heavy comes with it, and
 * the dependency runs content → cards only.
 */
import { RACE_CODES } from '../cards/race';
/**
 * The Buddy Bonus effect registry. Same reasoning as `RACE_CODES` above: the
 * closed set of effects is owned by the module that *applies* them, and is
 * imported here rather than restated, so a new effect cannot exist in one
 * place and not the other. The import is a leaf (constants and pure
 * predicates only).
 */
import {
  BUDDY_BONUS_EFFECT_IDS,
  BUDDY_BONUS_EFFECTS,
  BUDDY_BONUS_TARGET_TYPES,
  BUDDY_BONUS_TARGET_VALUES,
  effectRequiresTarget,
} from '../buddyBonus/buddyBonusEffects';
/**
 * The boss affinity wheel's shipped contents double as this schema's default,
 * so `tables.json` omitting the block yields exactly the cycle the domain
 * module already uses. Same reasoning as `DEFAULT_SP_RANGES_BY_RARITY` below.
 */
import { DEFAULT_BOSS_AFFINITY_WHEEL } from '../bosses/bossAffinity';
/** The narrower set of regions a *boss* definition may name. */
import { REGIONS } from '../bosses/regions';
/**
 * Every region a player can stand in — the closed set region files, encounter
 * pools, travel routes and regional shops must name. Wider than the boss list
 * on purpose: a travel destination need not host a boss.
 */
import { REGIONS as ALL_REGIONS, DEFAULT_REGION } from '../locations/regions';
/**
 * The shipped SP ladder doubles as this schema's default, so content and code
 * cannot ship disagreeing tables — omitting the block yields exactly the
 * constant the domain module already uses.
 */
import { DEFAULT_SP_RANGES_BY_RARITY } from '../power/seductivePower';

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
 * Upper bound on a *direct* capture item's flat bonus (`captureBonus`).
 *
 * Deliberately looser than {@link MAX_ITEM_CAPTURE_BONUS}: that one bounds a
 * buff that rides along with *every* attempt for its charges, whereas this one
 * is spent on the single attempt that consumes the item, and is rarity-gated
 * in content on top. Fluffy Cuffs (+0.30 against N–SR) sits under it.
 */
export const MAX_CAPTURE_ITEM_BONUS = 0.5;

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
 * Quickie Coffee / Reach Around. Adds a fixed amount of Hunt Energy rather
 * than refilling — the amount-based sibling of `restore_energy_full`, sharing
 * its Care Mode interaction. The restore always clamps to the player's
 * *computed* max, so a small top-up at near-full energy is honoured (and
 * partly wasted) rather than refused: unlike the full refill, there is a
 * sensible thing to do with 5 energy when 3 fit.
 */
export const RestoreEnergyAmountEffectSchema = z
  .object({
    amount: z.number().int().positive(),
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
export type RestoreEnergyAmountEffect = z.infer<typeof RestoreEnergyAmountEffectSchema>;
export type CaptureBonusEffect = z.infer<typeof CaptureBonusEffectSchema>;
export type ItemEffectConfig =
  | RestoreEnergyEffect
  | RestoreEnergyAmountEffect
  | CaptureBonusEffect;

export type ItemEffectConfigSchema =
  | typeof RestoreEnergyEffectSchema
  | typeof RestoreEnergyAmountEffectSchema
  | typeof CaptureBonusEffectSchema;

/** The config schema that goes with an `effectType`. */
export function effectConfigSchemaFor(effectType: ItemEffectType): ItemEffectConfigSchema {
  if (effectType === 'restore_energy_full') return RestoreEnergyEffectSchema;
  if (effectType === 'restore_energy_amount') return RestoreEnergyAmountEffectSchema;
  return CaptureBonusEffectSchema;
}

const ItemBaseSchema = z.object({
  slug,
  name: z.string().min(1),
  category: z.enum(ITEM_CATEGORIES),
  captureModifier: z.number().positive().nullable(),
  /**
   * Flat additive capture bonus in probability points (0.30 = +30pp), applied
   * after the `captureModifier` multiply and before the clamp. Null = none.
   */
  captureBonus: z.number().gt(0).lte(MAX_CAPTURE_ITEM_BONUS).nullable().default(null),
  /**
   * Encounter rarities this capture item is eligible against. Null (or an
   * empty list, which the admin form produces when the field is cleared) means
   * "every rarity" — which is what the charms are.
   */
  captureRarities: z
    .array(z.enum(RARITIES))
    .nullable()
    .default(null)
    .transform((v) => (v == null || v.length === 0 ? null : v)),
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
  // The two capture-item fields only mean anything on a capture item, and a
  // guaranteed item bypasses the chance formula entirely — a flat bonus on one
  // would be silently inert, which is worse than a rejected edit.
  if (item.captureBonus != null) {
    if (item.category !== 'capture') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": captureBonus requires category "capture"`,
        path: ['captureBonus'],
      });
    }
    if (item.isGuaranteedCapture) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": captureBonus is meaningless on a guaranteed-capture item`,
        path: ['captureBonus'],
      });
    }
  }
  if (item.captureRarities != null && item.captureRarities.length > 0) {
    if (item.category !== 'capture') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${item.slug}": captureRarities requires category "capture"`,
        path: ['captureRarities'],
      });
    }
    const seen = new Set<string>();
    for (const rarity of item.captureRarities) {
      if (seen.has(rarity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${item.slug}": duplicate rarity "${rarity}" in captureRarities`,
          path: ['captureRarities'],
        });
      }
      seen.add(rarity);
    }
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

// ── Appearances (Appearance Progression System v1) ──────────────────────────

/**
 * Cosmetic rarity. **Deliberately separate from species rarity** (`N`/`R`/…):
 * a Rare species may carry a Seasonal appearance, and the two signals must
 * never be conflated. Presentation only — it drives no gameplay, no drops, and
 * no unlock. The enum is closed so a client never renders an unknown string;
 * new values are an additive schema change that older clients tolerate by
 * falling back to `common`.
 */
export const COSMETIC_RARITIES = [
  'standard',
  'common',
  'rare',
  'seasonal',
  'limited',
  'exclusive',
] as const;
export type CosmeticRarity = (typeof COSMETIC_RARITIES)[number];
export const CosmeticRaritySchema = z.enum(COSMETIC_RARITIES);

/**
 * Unlock sources V1 actually resolves. `owned` and `level` are both *derived*
 * from waifu state, which is why V1 persists no unlock rows at all — only
 * "was the player notified?" (`player_waifus.seen_appearances`).
 */
export const V1_APPEARANCE_UNLOCK_TYPES = ['owned', 'level'] as const;

/**
 * Reserved for later versions. Authoring one today is a validation error —
 * the literals exist so the discriminated union, the API wire format, and the
 * client renderers are already shaped for them, and shipping the first
 * grant-driven source is a new `isUnlocked` case plus a grants table, never a
 * schema migration. See `.ai/appearanceplan.md` § Future Appearance Sources.
 */
export const FUTURE_APPEARANCE_UNLOCK_TYPES = [
  'evolution',
  'affection',
  'event',
  'seasonal',
  'achievement',
  'promotion',
  'admin_grant',
  'special',
] as const;

export const APPEARANCE_UNLOCK_TYPES = [
  ...V1_APPEARANCE_UNLOCK_TYPES,
  ...FUTURE_APPEARANCE_UNLOCK_TYPES,
] as const;
export type AppearanceUnlockType = (typeof APPEARANCE_UNLOCK_TYPES)[number];
export type V1AppearanceUnlockType = (typeof V1_APPEARANCE_UNLOCK_TYPES)[number];
export type FutureAppearanceUnlockType = (typeof FUTURE_APPEARANCE_UNLOCK_TYPES)[number];

/**
 * The **only** asset reference the system stores, transmits, or serializes.
 *
 * It names *what* artwork to show, never where it lives: no path, URL, CDN
 * host, object-storage key, content hash, or file extension. Each consumer
 * (Portal, Discord, a future mobile client) owns its own `AssetId → physical
 * resource` resolver, so migrating storage backends is a per-consumer change
 * with zero API-contract impact.
 *
 * `kind` is a literal in V1 and a discriminator later (`card_print`, …).
 */
export const AssetIdSchema = z
  .object({
    kind: z.literal('waifumon'),
    slug,
    variant: slug,
  })
  .strict();

export type AssetId = z.infer<typeof AssetIdSchema>;

const OwnedUnlockSchema = z.object({ type: z.literal('owned') }).strict();

const LevelUnlockSchema = z
  .object({
    type: z.literal('level'),
    /** Waifu level (per-copy), not player level. Bounded in `validateContentSet`. */
    atLevel: z.number().int().positive(),
  })
  .strict();

/**
 * V1 accepts `owned` and `level`. A reserved future type parses far enough to
 * produce a *named* error rather than a confusing "invalid discriminator", so
 * an author who tries `{"type":"event"}` is told it is reserved, not that it
 * does not exist.
 */
export const AppearanceUnlockSchema = z.discriminatedUnion('type', [
  OwnedUnlockSchema,
  LevelUnlockSchema,
]);

export type AppearanceUnlock = z.infer<typeof AppearanceUnlockSchema>;

const appearanceUnlockField = z.unknown().superRefine((raw, ctx) => {
  const type = (raw as { type?: unknown } | null | undefined)?.type;
  if (typeof type === 'string' && (FUTURE_APPEARANCE_UNLOCK_TYPES as readonly string[]).includes(type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unlock.type "${type}" is reserved for a future version and is not implemented yet`,
      path: ['type'],
    });
    return;
  }
  const parsed = AppearanceUnlockSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: issue.path });
    }
  }
}).transform((raw) => AppearanceUnlockSchema.parse(raw));

/**
 * One appearance a species can wear.
 *
 * Every field except `id` and `unlock` is presentation: display name,
 * subtitle, in-world flavor line, cosmetic rarity badge, and the version the
 * art shipped in. None of them is readable by gameplay code — appearance is
 * cosmetic, full stop.
 *
 * `assetId` may be omitted; the content resolver defaults it to
 * `{ kind: 'waifumon', slug: <species slug>, variant: <appearance id> }`.
 * `unlockLabel` may be omitted; it is synthesized from `unlock`. Both are
 * always populated by the time anything above the loader sees them.
 */
export const AppearanceContentSchema = z
  .object({
    /** Unique within the species. Doubles as `player_waifus.variant`. */
    id: slug,
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    /** In-world caption, e.g. "Prepared for the annual shrine celebration." */
    flavorText: z.string().min(1).optional(),
    cosmeticRarity: CosmeticRaritySchema.default('standard'),
    /** Free-form, e.g. "v1.3". Displayed verbatim; never parsed. */
    introducedVersion: z.string().min(1).optional(),
    /** Defaults to the species' rating when omitted. */
    contentRating: z.enum(CONTENT_RATINGS).optional(),
    /** Gallery ordering; the implicit `standard` entry sits at 0. */
    sortOrder: z.number().int().default(100),
    tags: z.array(z.string()).default([]),
    assetId: AssetIdSchema.optional(),
    unlock: appearanceUnlockField,
    /** Author-supplied requirement text; synthesized when omitted. */
    unlockLabel: z.string().min(1).optional(),
  })
  .strict();

export type AppearanceContent = z.infer<typeof AppearanceContentSchema>;

/** The implicit entry every species has, authored or not. */
export const DEFAULT_APPEARANCE_ID = 'standard';

/**
 * A card-metadata string: trimmed, non-empty, capped.
 *
 * Trim-then-`min(1)` is deliberate — it turns `"   "` into a validation error
 * rather than a field that passes schema and then silently vanishes at render
 * time. Authors should omit a field they have nothing to say for, and the
 * schema says so out loud.
 */
const cardText = (max: number): z.ZodString => z.string().trim().min(1).max(max);

/**
 * Presentation-only species metadata for the card renderer.
 *
 * **Nothing here is gameplay.** No capture math, no progression, no affinity
 * matchup reads any of it; it is what gets printed on the card face. It is also
 * deliberately *not* in the database — like `appearances`, it lives in the JSON
 * content and travels in `LoadedContent`, so a card-copy edit is a content
 * change and never a migration.
 *
 * What is **not** here: the generic affinity blurbs. Those describe what an
 * affinity *category* means, identically on every card that shares it, so they
 * stay renderer-owned in `AFFINITY_DESCRIPTIONS`. Authoring them per species
 * would copy one global definition across every entry and let five species
 * disagree about what "primal" means.
 */
export const SpeciesCardMetaSchema = z
  .object({
    /** Epithet under the name, e.g. "Curious Companion". */
    subtitle: cardText(48).optional(),
    /**
     * Artwork credit. Supply only when a real attribution is known — an
     * invented credit is worse than a blank line, and the renderer simply
     * omits the element when this is absent.
     */
    artist: cardText(48).optional(),
    /**
     * All-or-nothing: a name with no text is an authoring mistake, not a
     * half-filled card, so the pair is required together or the block omitted.
     */
    ability: z
      .object({
        name: cardText(32),
        text: cardText(160),
      })
      .strict()
      .optional(),
    flavorQuote: cardText(120).optional(),
    /**
     * Free-form collector number. Presentation only — Phase 2 defines **no**
     * set-numbering system, so this is reserved rather than canonical. Do not
     * invent numbering to fill it in.
     */
    cardNumber: cardText(32).optional(),
  })
  .strict();

export type SpeciesCardMeta = z.infer<typeof SpeciesCardMetaSchema>;

/**
 * Buddy Bonus — the passive effect an owned copy grants while she is the
 * player's equipped Buddy.
 *
 * Wholly content-driven: the gameplay layer knows the closed set of
 * `effectId`s in {@link BUDDY_BONUS_EFFECTS} and nothing else. A new species
 * file naming an existing effect works with no code change, which is exactly
 * why the validation below is strict — a typo'd effect id or a target on an
 * effect that takes none is a content bug that must fail the load rather than
 * become a bonus that silently never fires.
 *
 * `name` and `flavorText` are display copy. Nothing branches on them.
 */
export const BuddyBonusSchema = z
  .object({
    name: cardText(48),
    flavorText: cardText(200),
    effectId: z.enum(BUDDY_BONUS_EFFECT_IDS),
    /** A percentage, read relative: `100` doubles, `5` adds a twentieth. */
    value: z.number().finite(),
    target: z
      .object({
        type: z.enum(BUDDY_BONUS_TARGET_TYPES),
        value: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((bonus, ctx) => {
    const rule = BUDDY_BONUS_EFFECTS[bonus.effectId];
    const target = bonus.target;

    if (!target) {
      if (effectRequiresTarget(bonus.effectId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `buddyBonus effect "${bonus.effectId}" requires a target`,
          path: ['target'],
        });
      }
      return;
    }

    if (rule.allowedTargetTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `buddyBonus effect "${bonus.effectId}" does not take a target`,
        path: ['target'],
      });
      return;
    }

    if (!rule.allowedTargetTypes.includes(target.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `buddyBonus effect "${bonus.effectId}" does not support target type ` +
          `"${target.type}" (allowed: ${rule.allowedTargetTypes.join(', ')})`,
        path: ['target', 'type'],
      });
      return;
    }

    // Values are closed sets, not free text: an unknown race or rarity would
    // match nothing at runtime, so it fails the load instead.
    const allowed = BUDDY_BONUS_TARGET_VALUES[target.type];
    if (!allowed.includes(target.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `buddyBonus target "${target.type}" value "${target.value}" is not one of: ` +
          allowed.join(', '),
        path: ['target', 'value'],
      });
    }
  });

export type BuddyBonusContent = z.infer<typeof BuddyBonusSchema>;

const SpeciesBaseSchema = z.object({
  slug,
  name: z.string().min(1),
  rarity: z.enum(RARITIES),
  /**
   * Narrative role — free-form and deliberately open: "paladin", "barista",
   * and "librarian" are all valid. Today's corpus happens to use values that
   * coincide with {@link RACE_CODES}, which is legacy overlap, not the model.
   * See `race` for the visual classification.
   */
  archetype: z.string().min(1),
  /**
   * Visual race classification — which frame iconography the card wears.
   *
   * Optional during migration: content that omits it falls back to a race
   * derived from `archetype` (see `resolveRace`), so no existing file needed
   * editing to ship this field. New content should set it explicitly, because
   * the fallback only works while archetypes happen to be race words — the
   * moment someone writes `"archetype": "paladin"`, only an explicit `race`
   * can say whether she is an angel or a valkyrie.
   */
  race: z.enum(RACE_CODES).optional(),
  /** Card-face presentation metadata. See {@link SpeciesCardMetaSchema}. */
  card: SpeciesCardMetaSchema.optional(),
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
  /**
   * The species' default artwork, relative to `ASSETS_DIR`.
   *
   * **Loader-private.** It is the pre-flight existence probe for the default
   * appearance and nothing else: it is not seeded into any appearance, is not
   * surfaced by the Platform API, and no consumer resolves art from it. Art is
   * addressed by `AssetId` everywhere above the loader boundary.
   */
  imagePath: z.string().min(1),
  enabled: z.boolean().default(true),
  eventKey: z.string().nullable().default(null),
  perSpeciesWeight: z.number().int().positive().default(1),
  /**
   * Optional appearance catalog. Omitted (the case for every species that
   * predates this system) means a single implicit `standard` / `owned` entry
   * is synthesized at read time — see `resolveAppearances`. Nothing is
   * rewritten on disk, so existing content files stay byte-identical.
   */
  appearances: z.array(AppearanceContentSchema).optional(),
  /**
   * Optional Buddy Bonus. Present → this species grants that effect whenever
   * one of the player's copies of her is the equipped Buddy. Absent → she
   * simply grants nothing, which is a perfectly ordinary species.
   */
  buddyBonus: BuddyBonusSchema.optional(),
});

export const SpeciesContentSchema = SpeciesBaseSchema.superRefine((s, ctx) => {
  const list = s.appearances;
  if (!list || list.length === 0) return;

  const seen = new Set<string>();
  for (const [i, appearance] of list.entries()) {
    if (seen.has(appearance.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${s.slug}": duplicate appearance id "${appearance.id}"`,
        path: ['appearances', i, 'id'],
      });
    }
    seen.add(appearance.id);
  }

  // Exactly one default: the entry the player wears the moment they own her.
  // Zero would leave a freshly-captured copy with nothing to render; two would
  // make "which one is default" a coin flip.
  const owned = list.filter((a) => a.unlock.type === 'owned');
  if (owned.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `"${s.slug}": exactly one appearance must have unlock.type "owned" ` +
        `(found ${owned.length})`,
      path: ['appearances'],
    });
  }

  for (const [i, appearance] of list.entries()) {
    const asset = appearance.assetId;
    if (asset && asset.slug !== s.slug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `"${s.slug}": appearance "${appearance.id}" has assetId.slug "${asset.slug}" — ` +
          'an appearance may only reference its own species',
        path: ['appearances', i, 'assetId', 'slug'],
      });
    }
  }
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

/** Venues the Activity Feed names when a hunt session opens and closes. */
const DEFAULT_LOCATION_FLAVORS = [
  'the Whispering Forest',
  'the Neon Boardwalk',
  'the Velvet Grove',
  'the Moonlit Docks',
] as const;

export const HuntTableSchema = z.object({
  cooldownSeconds: z.number().int().nonnegative(),
  encounterExpirySeconds: z.number().int().positive(),
  /**
   * Housekeeping window for hunt-session narration: a hunt after this much
   * silence closes the abandoned session and opens a new one. Not a gameplay
   * timer — nothing expires and no state is lost.
   */
  sessionIdleMinutes: z.number().int().positive().default(15),
  /**
   * Pool the Activity Feed picks a venue from, deterministically per session.
   * An empty pool falls back to plain "started/finished hunting" wording.
   */
  locationFlavors: z.array(z.string().min(1)).default([...DEFAULT_LOCATION_FLAVORS]),
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
 * Optional cosmetic flavor text pools that hydrate the menu UI.
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
 * Session tunables.
 *
 * ⚠️ `inactiveTimeoutMinutes` is currently **inert**. It governed the public
 * session board's staleness timeout, and that board was retired when gameplay
 * went ephemeral: ephemeral views expire on Discord's own schedule and there
 * is no shared message to go stale. The key is retained (and still editable in
 * the admin panel) rather than dropped, because removing it is a content
 * migration and the value is a plausible fit for a future "returned after
 * inactivity" Trainer Profile hook. Nothing reads it today.
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

/**
 * Affection Gift System.
 *
 * At the authoritative daily reset the player's *active buddy* — and only the
 * active buddy — takes at most one roll. Tiers are matched by the highest
 * `minAffection` the copy's current affection reaches; below the lowest tier
 * there is no roll at all, which is what "0% under 500" means.
 *
 * `guaranteeAfter` is a pity counter measured in **eligible rolls since her
 * last gift**: at `7`, the 7th such roll produces a gift even when the chance
 * roll misses. The counter lives on the owned copy, so changing buddies never
 * transfers, resets, or double-spends anyone's progress.
 *
 * `lootTable` is rolled *at generation time*, never at claim time, so what she
 * is holding cannot change while it waits. Weights are relative and are
 * deliberately **not** required to total any particular number — the shipped
 * table sums to 10,000 purely because that makes the percentages readable.
 */
export const AffectionGiftTierSchema = z
  .object({
    /** Inclusive affection floor for this tier. */
    minAffection: z.number().int().nonnegative(),
    /** Probability in [0, 1] that an eligible roll produces a gift. */
    dailyChance: z.number().gte(0).lte(1),
    /** Eligible rolls since the last gift after which one is guaranteed. */
    guaranteeAfter: z.number().int().positive(),
    /** Stored on the roll/gift rows so history survives a retune. */
    tier: z.enum(AFFECTION_GIFT_TIERS),
  })
  .strict();

export const AffectionGiftLootEntrySchema = z
  .object({
    slug,
    quantity: z.number().int().positive(),
    /** Relative weight. Positive integer — no fractional or zero weights. */
    weight: z.number().int().positive(),
  })
  .strict();

export const AffectionGiftsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    tiers: z.array(AffectionGiftTierSchema).default([]),
    lootTable: z.array(AffectionGiftLootEntrySchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.enabled) return;
    if (cfg.tiers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'affectionGifts.tiers must not be empty while enabled',
        path: ['tiers'],
      });
    }
    if (cfg.lootTable.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'affectionGifts.lootTable must not be empty while enabled',
        path: ['lootTable'],
      });
    }
    // Ascending, distinct floors: tier resolution takes the highest matching
    // entry, so an out-of-order or duplicated floor is an authoring mistake
    // that would silently change which chance a player gets.
    let previous = -1;
    for (const [index, tier] of cfg.tiers.entries()) {
      if (tier.minAffection <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `affectionGifts.tiers must be sorted by ascending, distinct minAffection ` +
            `(entry ${index} has ${tier.minAffection} after ${previous})`,
          path: ['tiers', index, 'minAffection'],
        });
      }
      previous = tier.minAffection;
    }
    const tierNames = cfg.tiers.map((t) => t.tier);
    const duplicateName = tierNames.find((t, i) => tierNames.indexOf(t) !== i);
    if (duplicateName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `affectionGifts.tiers has duplicate tier name: ${duplicateName}`,
        path: ['tiers'],
      });
    }
    const slugs = cfg.lootTable.map((e) => e.slug);
    const duplicateSlug = slugs.find((sl, i) => slugs.indexOf(sl) !== i);
    if (duplicateSlug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `affectionGifts.lootTable has duplicate item slug: ${duplicateSlug}`,
        path: ['lootTable'],
      });
    }
  });

/** Gifts switched off — the default when `tables.json` omits the block. */
const AFFECTION_GIFTS_DEFAULT: z.input<typeof AffectionGiftsConfigSchema> = {
  enabled: false,
  tiers: [],
  lootTable: [],
};

/**
 * Seductive Power — the Level 1 Base SP band each rarity rolls within.
 *
 * Tuning, so it lives in content rather than in code: an operator can widen a
 * band without a deploy. The *formula* that turns Base SP into Current SP is
 * not tunable and stays in `modules/power/seductivePower.ts` behind
 * `SP_FORMULA_VERSION`.
 *
 * Defaults to the shipped ladder, so a `tables.json` that omits the block
 * still rolls correctly instead of failing to find a range. Every rarity must
 * be present — including `EX`, which has no species in the current roster and
 * must still be rollable the day one ships.
 */
export const SeductivePowerRangeSchema = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict()
  .refine((r) => r.max >= r.min, {
    message: 'seductivePower range max must be >= min',
  });

export const SeductivePowerConfigSchema = z
  .object({
    rangesByRarity: z.object(
      Object.fromEntries(
        RARITIES.map((r) => [r, SeductivePowerRangeSchema] as const),
      ) as { [K in (typeof RARITIES)[number]]: typeof SeductivePowerRangeSchema },
    ),
  })
  .default({ rangesByRarity: DEFAULT_SP_RANGES_BY_RARITY });

/**
 * Boss Encounters — Stage 1.
 *
 * Two blocks live here: the shape of `content/bosses.json` (one entry per
 * boss), and the `bossEncounters` tuning block in `tables.json` (timings,
 * bonuses, and the named reward tables bosses point at). They are separate
 * files for the same reason species and tables are: a writer adds a boss
 * without touching numbers, and an operator retunes numbers without touching
 * prose.
 *
 * Cross-file checks — that a `rewardTable` names a table that exists, and that
 * every reward slug names an item that exists and is enabled — belong in
 * `loader.validateContentSet`, which is the only layer holding all three files
 * at once.
 */

/**
 * A relative artwork path under the assets root.
 *
 * Deliberately stricter than "a string": rejects absolute paths, drive
 * letters, backslashes and any `..` segment *before* the loader ever resolves
 * it. `resolveAssetPath` is the second line of defence and would catch an
 * escape anyway, but a content author deserves the error at the field rather
 * than as a startup crash, and a path that never reaches the filesystem cannot
 * be a traversal.
 */
const relativeAssetPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.startsWith('\\'), {
    message: 'artwork must be a relative path, not absolute',
  })
  .refine((p) => !/^[a-zA-Z]:/.test(p), {
    message: 'artwork must not start with a drive letter',
  })
  .refine((p) => !p.includes('\\'), {
    message: 'artwork must use forward slashes',
  })
  .refine((p) => !p.split('/').includes('..'), {
    message: 'artwork must not contain ".." path segments',
  })
  .refine((p) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p), {
    message: 'artwork must be a local asset path, not a URL',
  });

/** Player-facing prose. Required, because a boss with no copy has no encounter. */
const bossProse = z.string().trim().min(1);

/**
 * One boss definition.
 *
 * `.strict()` so a typo'd key is an error rather than a silently-ignored
 * field — boss entries are hand-authored and small, and a misspelled
 * `repelledText` would otherwise ship as a missing announcement.
 */
export const BossContentSchema = z
  .object({
    /** Stable identity. Snapshotted onto every encounter row, so never reused. */
    id: slug,
    name: z.string().min(1),
    /** Drives the advantage wheel; `switch` is a full participant here. */
    affinity: z.enum(AFFINITIES),
    region: z.enum(REGIONS),
    enabled: z.boolean().default(true),
    /**
     * Relative to the assets root. Optional — and when the file is missing the
     * encounter degrades to a text/embed announcement rather than failing to
     * resolve. Artwork is presentation; damage and rewards are not.
     */
    artwork: relativeAssetPath.nullable().default(null),
    /** Names an entry in `tables.json` → `bossEncounters.rewardTables`. */
    rewardTable: z.string().min(1),
    /** Shown while the scouting window is open. */
    scoutingText: bossProse,
    /** Shown when at least one trainer committed a buddy. */
    repelledText: bossProse,
    /** Shown when nobody did. */
    unchallengedText: bossProse,
    description: bossProse,
  })
  .strict();

export const BossesFileSchema = z.array(BossContentSchema);

export type BossContent = z.infer<typeof BossContentSchema>;
export type BossContentInput = z.input<typeof BossContentSchema>;

/**
 * Boss loot lives in its own file: `content/bossRewards.json`.
 *
 * **Why not in `tables.json` beside the rest of the boss tuning, and why not in
 * `items.json` beside the items themselves.** An item has one identity and
 * several independent *acquisition sources*, and the sources have nothing to
 * say to each other:
 *
 *   `items.json`        — what the item **is**: name, category, behaviour, and
 *                         `enabled`, which is retirement, not availability.
 *   shop fields on it   — whether it is **purchasable** and for how much
 *                         (`purchasable`, `buyPrice`, `priceCurrency`).
 *   `bossRewards.json`  — whether it **drops from a boss**, how many, and how
 *                         often. This file.
 *   (future) scavenge   — separate again, for the same reason.
 *
 * Consequences an operator can rely on, and which the tests pin: un-listing an
 * item from the Shop does not stop it dropping from a boss; disabling a boss
 * entry does not remove the item from the Shop; and nothing in the Shop's
 * availability or pricing is consulted when a boss pays out.
 *
 * The structure is groups-of-entries rather than one flat weighted list,
 * because the two things a boss table needs to express are different in kind:
 *
 *   - *Which* ordinary item, chosen among alternatives → **weights inside one
 *     group**. Weights are relative and normalized over whatever is enabled, so
 *     disabling an entry redistributes its share rather than leaving a hole.
 *   - *Whether* a rare extra fires at all → **a separate group** with its own
 *     `chanceBasisPoints`. Independent by construction: retuning the ordinary
 *     pool cannot move the rare group's odds, and the rare group never
 *     *displaces* an ordinary drop — a lucky participant receives both.
 */

/**
 * Identifier for a reward table's group.
 *
 * Kebab **or** snake, unlike the repository's `slug` (snake only). Item slugs
 * are snake_case because they name database rows; a reward group id names a
 * concept inside one JSON file and reads better hyphenated — `standard-item`,
 * `rare-bonus` — matching the table ids these groups live under
 * (`standard-scouting-v1`). Both are accepted so neither convention is a trap.
 */
const rewardId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'id must be lowercase kebab-case or snake_case');

/** One weighted drop inside a group. */
export const BossRewardEntrySchema = z
  .object({
    /**
     * An item slug from `items.json`. Named `itemId` rather than `slug` because
     * this file *references* an item rather than defining one, and the
     * asymmetry is worth seeing at the call site.
     */
    itemId: slug,
    /**
     * Per-entry switch. A disabled entry is excluded from future boss rolls and
     * from nothing else — it stays in the Shop, stays in the file, and stays
     * payable on any reward snapshot already taken.
     */
    enabled: z.boolean().default(true),
    /**
     * Relative weight within its group. Positive integer — no zero weights,
     * because a zero-weight entry is a disabled one written unclearly, and
     * `enabled: false` says it out loud.
     */
    weight: z.number().int().positive(),
    /** Stack size granted when this entry is picked. */
    quantity: z.number().int().positive(),
  })
  .strict();

/**
 * One independent draw against a pool.
 *
 * `rolls` and `chanceBasisPoints` compose: a group with `rolls: 2` and
 * `chanceBasisPoints: 5000` performs two *independent* 50% checks, each of
 * which — when it fires — picks one entry by weight.
 */
export const BossRewardGroupSchema = z
  .object({
    /**
     * Stable within its table. Part of the deterministic draw key, so renaming
     * a group re-rolls any encounter that has not yet resolved. Deliberate: a
     * renamed group is a different group.
     */
    id: rewardId,
    /** Group switch. A disabled group is skipped entirely, rolls and all. */
    enabled: z.boolean().default(true),
    /** Independent draws against this group per participation. */
    rolls: z.number().int().positive().default(1),
    /**
     * Probability this group produces anything on a given roll, in basis
     * points: 10000 = always, 25 = 0.25%.
     *
     * Basis points rather than a float so a rare chance is written exactly and
     * read at a glance — `0.0025` invites a misplaced zero in a way that `25`
     * out of `10000` does not.
     */
    chanceBasisPoints: z.number().int().gte(0).lte(10_000).default(10_000),
    entries: z.array(BossRewardEntrySchema).min(1),
  })
  .strict();

/**
 * A named boss reward table. Bosses reference it by `id` from `bosses.json`.
 *
 * Retuning payouts for every boss at once is one edit here; giving one boss its
 * own economy later is a new entry in this array rather than a schema change.
 */
export const BossRewardTableSchema = z
  .object({
    /** The id `bosses.json`'s `rewardTable` names. */
    id: z.string().min(1),
    /**
     * Table switch. Disabling it makes every boss pointing at it undrawable —
     * with a logged, actionable error — rather than making them pay out
     * nothing. A boss that appears and hands out an empty result is worse than
     * a boss that does not appear.
     */
    enabled: z.boolean().default(true),
    /**
     * Recorded on every encounter at spawn, so a historical result says which
     * payout rules produced it even after this file is edited underneath.
     * Defaults to the table's `id`; set it explicitly when you retune and want
     * old and new results to be distinguishable in an audit.
     */
    version: z.string().min(1).optional(),
    /** Guaranteed buddy XP. Zero is legal; a max-level buddy still gets items. */
    buddyXp: z.number().int().nonnegative(),
    groups: z.array(BossRewardGroupSchema).min(1),
  })
  .strict()
  .superRefine((table, ctx) => {
    const groupIds = table.groups.map((g) => g.id);
    const duplicateGroup = groupIds.find((id, i) => groupIds.indexOf(id) !== i);
    if (duplicateGroup) {
      // Group ids key the deterministic draw, so two groups sharing one id
      // would draw *identically* rather than independently.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bossRewards["${table.id}"] has two groups with id "${duplicateGroup}"`,
        path: ['groups'],
      });
    }
    for (const [index, group] of table.groups.entries()) {
      // Keyed on item *and* quantity: "2x Basic Charm" and "3x Basic Charm" are
      // two legitimate drops of different sizes, whereas the same item at the
      // same quantity listed twice is the authoring mistake worth catching — it
      // silently doubles that drop's weight.
      const drops = group.entries.map((e) => `${e.itemId}x${e.quantity}`);
      const duplicate = drops.find((d, i) => drops.indexOf(d) !== i);
      if (duplicate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bossRewards["${table.id}"].groups["${group.id}"] lists the same drop twice: ${duplicate}`,
          path: ['groups', index, 'entries'],
        });
      }
    }
  });

/** `content/bossRewards.json` — an array of tables. */
export const BossRewardsFileSchema = z
  .array(BossRewardTableSchema)
  .superRefine((tables, ctx) => {
    const ids = tables.map((t) => t.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
      // A duplicate id makes `bosses.json`'s `rewardTable` ambiguous, and an
      // encounter row records only the id — so the ambiguity would outlive the
      // file it came from.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bossRewards has two tables with id "${duplicate}"`,
      });
    }
  });

export type BossRewardTable = z.infer<typeof BossRewardTableSchema>;
export type BossRewardGroup = z.infer<typeof BossRewardGroupSchema>;
export type BossRewardEntry = z.infer<typeof BossRewardEntrySchema>;

/**
 * The version string stamped onto an encounter at spawn.
 *
 * `version` when the author set one, the table's `id` otherwise — so a table
 * that has never been retuned still records something meaningful rather than an
 * empty string.
 */
export function bossRewardTableVersion(table: BossRewardTable): string {
  return table.version ?? table.id;
}

/**
 * Boss encounter tuning.
 *
 * Everything a live operator might reasonably move — window length, downtime
 * band, attack count, bonus magnitudes, bracket boundaries, payouts — is here.
 * The two things that are *not* here are the damage formula and the affinity
 * wheel's shape, which live in code behind version constants because changing
 * them re-models the system rather than re-tuning it. The wheel's *contents*
 * are configurable so the cycle can be rotated without a deploy.
 */
export const BossEncountersConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Regions that may spawn bosses. Empty = every canonical region. */
    regions: z.array(z.enum(REGIONS)).default([...REGIONS]),
    /**
     * How long trainers have to commit, from the announcement.
     *
     * Thirty minutes: long enough that someone who checks Discord a couple of
     * times an hour still catches most encounters, short enough that the whole
     * cycle stays inside an hour. Every countdown, deadline and rapid-response
     * boundary derives from this one number.
     */
    scoutingMinutes: z.number().int().positive().default(30),
    /**
     * Inclusive quiet band after a resolution, before the next appearance.
     *
     * Randomised rather than fixed so bosses do not become a clock players can
     * set a timer against, and drawn **once** at resolution and persisted, so a
     * restart cannot reroll it into an earlier or later slot.
     *
     * With a 30-minute window this gives a 40–65 minute cycle: roughly 22–36
     * encounters a day. See `docs/boss-encounters.md` for what that implies for
     * the reward economy.
     */
    downtimeMinutesMin: z.number().int().positive().default(10),
    downtimeMinutesMax: z.number().int().positive().default(35),
    /** Attacks one committed buddy represents. Scaling, not simulation. */
    attacksPerParticipation: z.number().int().positive().default(10),
    /** Inclusive performance-modifier bounds, in hundredths. */
    performanceMinPercent: z.number().int().positive().default(85),
    performanceMaxPercent: z.number().int().positive().default(115),
    /**
     * Boss affinity → the buddy affinity that beats it. Defaults to the
     * shipped cycle in `modules/bosses/bossAffinity.ts`, so content that omits
     * the block cannot disagree with code.
     */
    affinityWheel: z
      .record(z.enum(AFFINITIES), z.enum(AFFINITIES))
      .default({ ...DEFAULT_BOSS_AFFINITY_WHEEL }),
    /** Additive damage bonus for the superior affinity. */
    affinityAdvantageBonus: z.number().gte(0).lte(1).default(0.1),
    /**
     * Rapid-response tiers, ascending by `withinMinutes`. The comparison is
     * strict, so a commitment at exactly the boundary falls into the next tier:
     * at 9:59 into a 30-minute window a player gets +5%, at exactly 10:00 they
     * get +2%, at exactly 20:00 they get nothing. Elapsed time is measured
     * from `scoutingStartedAt`, and anything past the last bracket — the final
     * ten minutes here — earns no bonus at all.
     */
    responseBrackets: z
      .array(
        z
          .object({
            withinMinutes: z.number().int().positive(),
            bonus: z.number().gte(0).lte(1),
          })
          .strict(),
      )
      .default([
        { withinMinutes: 10, bonus: 0.05 },
        { withinMinutes: 20, bonus: 0.02 },
      ]),
    /**
     * Payout tables are **not** here. They live in `content/bossRewards.json`
     * so that a writer retuning loot never has to open the file that also
     * carries window lengths and damage bounds, and so boss acquisition stays
     * independently editable from Shop availability. See
     * {@link BossRewardTableSchema}.
     */
    /** Participants shown on the first page of the public result. */
    resultsPageSize: z.number().int().positive().max(25).default(10),
    /**
     * How long a `resolving` claim may sit before another process may take it
     * over. The safety net for a worker that died mid-payout; every payout is
     * individually idempotent, so a takeover finishes rather than duplicates.
     */
    resolveClaimTimeoutMinutes: z.number().int().positive().default(10),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.downtimeMinutesMax < cfg.downtimeMinutesMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bossEncounters.downtimeMinutesMax must be >= downtimeMinutesMin',
        path: ['downtimeMinutesMax'],
      });
    }
    if (cfg.performanceMaxPercent < cfg.performanceMinPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bossEncounters.performanceMaxPercent must be >= performanceMinPercent',
        path: ['performanceMaxPercent'],
      });
    }
    // Ascending, distinct boundaries: brackets resolve first-match, so an
    // out-of-order entry would make a later tier unreachable.
    let previous = 0;
    for (const [index, bracket] of cfg.responseBrackets.entries()) {
      if (bracket.withinMinutes <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'bossEncounters.responseBrackets must be sorted by ascending, distinct ' +
            `withinMinutes (entry ${index} has ${bracket.withinMinutes} after ${previous})`,
          path: ['responseBrackets', index, 'withinMinutes'],
        });
      }
      previous = bracket.withinMinutes;
    }
    // A bracket that reaches past the window is dead configuration; a bracket
    // that exactly matches it is the legal "everyone gets something" case.
    const last = cfg.responseBrackets.at(-1);
    if (last && last.withinMinutes > cfg.scoutingMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `bossEncounters.responseBrackets extends to ${last.withinMinutes} minutes, ` +
          `past the ${cfg.scoutingMinutes}-minute scouting window`,
        path: ['responseBrackets'],
      });
    }
    // Reward-table invariants moved to `BossRewardsFileSchema` along with the
    // data. Cross-file checks — that a boss names a table that exists, that a
    // table names items that exist — stay in `loader.validateBossContent`,
    // which is the only layer holding every file at once.
  });

export type BossEncountersConfig = z.infer<typeof BossEncountersConfigSchema>;

/** Bosses switched off — the default when `tables.json` omits the block. */
const BOSS_ENCOUNTERS_DEFAULT: z.input<typeof BossEncountersConfigSchema> = {
  enabled: false,
};


/* ─────────────────────── Locations, Travel & Expansions ─────────────────── */

/**
 * One species' membership in one region's encounter pool.
 *
 * `weight` is region-local and is what the hunt actually rolls on — it fully
 * replaces `species.perSpeciesWeight` for the regional draw. Omitting it
 * inherits the species' own weight at seed time, so a region that just wants
 * "the usual rates" lists slugs and says nothing about numbers, while a region
 * that wants a species to be *its* speciality names a bigger number. That is
 * the whole reason pools are a table rather than a `species.region` column.
 *
 * Non-positive weights are rejected here rather than clamped: a zero weight
 * reads as "she is in this pool" while meaning "she can never be drawn", and
 * silently repairing it would hide the authoring mistake behind a species
 * nobody ever meets.
 */
export const RegionEncounterEntrySchema = z
  .object({
    species: slug,
    weight: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A region definition: what the place is called, whether it is open, and what
 * lives there.
 *
 * Core regions live in `content/regions/*.json`; an expansion pack ships its
 * own as `content/expansions/<pack>/region.json`. Same schema either way —
 * where the file sits decides which pack's enabled flag gates it, not what it
 * is allowed to say.
 *
 * `starting` marks the region every player begins in, and **exactly one**
 * region across the whole content set may set it (enforced in the loader,
 * which is the only layer holding every region file at once). It must also
 * agree with `DEFAULT_REGION`, because that constant is baked into the
 * `players.current_region` column default — content and schema disagreeing
 * there would mean new players spawn somewhere the game does not think they
 * are.
 */
export const RegionContentSchema = z
  .object({
    id: z.enum(ALL_REGIONS),
    name: z.string().min(1),
    description: z.string().default(''),
    emoji: z.string().nullable().default(null),
    /**
     * A disabled region is **hidden**, not merely locked: it does not appear
     * in the Locations list at all, cannot be travelled to, and its pool is
     * not seeded. This is the "unreleased content sitting on disk" switch.
     */
    enabled: z.boolean().default(true),
    /** Exactly one region in the content set is the starting region. */
    starting: z.boolean().default(false),
    /** Display order in the Locations list. Ties break on id. */
    order: z.number().int().nonnegative().default(0),
    /** Flavor shown on the destination detail screen. */
    flavor: z.array(z.string()).default([]),
    encounterPool: z.array(RegionEncounterEntrySchema).default([]),
    /**
     * Item slugs this region's shop stocks. Listing an item here makes it
     * *regionally scoped* — it leaves the global catalog and is sold only in
     * the regions that name it.
     */
    shopItems: z.array(slug).default([]),
    /**
     * Optional shallow/wide banner (recommended 1200×300, 4:1) shown on the
     * main menu and Locations screens. Missing file degrades to text-only at
     * render time; the schema only ensures the path is a safe local asset.
     */
    bannerImagePath: relativeAssetPath.nullable().default(null),
  })
  .strict();

export type RegionContent = z.infer<typeof RegionContentSchema>;
export type RegionEncounterEntry = z.infer<typeof RegionEncounterEntrySchema>;

/**
 * An expansion pack's manifest — `content/expansions/<pack>/expansion.json`.
 *
 * Its presence is what makes a directory under `content/expansions/` a pack.
 * A directory *without* one is not silently scanned for species: the loader
 * refuses to boot and names it. That rule exists because this repository
 * already had an orphaned pack sitting on disk that nothing loaded, and the
 * moment expansion discovery landed, "a folder full of species JSON" would
 * have quietly become live content. Requiring an explicit manifest makes
 * activation a decision somebody wrote down.
 *
 * `enabled: false` is a complete withdrawal: the pack's species are not merged
 * into the registry, not seeded, and may not be referenced by any enabled
 * region's pool. The files stay on disk and stay valid.
 */
export const ExpansionContentSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    description: z.string().default(''),
    enabled: z.boolean().default(false),
    order: z.number().int().nonnegative().default(0),
    /**
     * The region this pack introduces, if any. Metadata about *origin* — it
     * says which pack authored the place, and says nothing about where the
     * pack's species may be encountered. Availability is region-pool
     * membership and only region-pool membership.
     */
    regionId: z.enum(ALL_REGIONS).nullable().default(null),
  })
  .strict();

export type ExpansionContent = z.infer<typeof ExpansionContentSchema>;

/**
 * A travel pass — the container a player buys once.
 *
 * Deliberately not an inventory item: a pass is a permanent, non-stackable
 * entitlement with a level gate, and the shop's quantity/capacity machinery
 * models none of that. It lives in `player_travel_passes`, keyed so the
 * database refuses a second copy.
 */
export const TravelPassSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    description: z.string().default(''),
    emoji: z.string().nullable().default(null),
    price: z.number().int().nonnegative(),
    currency: z.enum(PRICE_CURRENCIES).default('waifubux'),
    /** Trainer level required to buy. */
    requiredLevel: z.number().int().positive().default(1),
    /**
     * Destinations stamped onto the pass by the initial purchase, granted in
     * the same transaction that grants the pass. Every later destination is a
     * separate route unlock against the same pass — which is why this is a
     * list rather than a single field, and why routes exist independently.
     */
    grantsRoutes: z.array(z.enum(ALL_REGIONS)).default([]),
  })
  .strict();

/** One purchasable destination, stamped onto a pass the player already owns. */
export const TravelRouteSchema = z
  .object({
    regionId: z.enum(ALL_REGIONS),
    passId: slug,
    /** Zero for a destination the pass itself already covers. */
    price: z.number().int().nonnegative().default(0),
    currency: z.enum(PRICE_CURRENCIES).default('waifubux'),
    requiredLevel: z.number().int().positive().default(1),
  })
  .strict();

/**
 * Travel tuning. Every number a live operator might move — the pass price, the
 * level gate, per-route fees — is content, never a constant in a service.
 */
export const TravelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    passes: z.array(TravelPassSchema).default([]),
    routes: z.array(TravelRouteSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const passIds = new Set(cfg.passes.map((p) => p.id));
    const dupPass = cfg.passes.map((p) => p.id).find((id, i, a) => a.indexOf(id) !== i);
    if (dupPass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `travel.passes contains duplicate pass id "${dupPass}"`,
        path: ['passes'],
      });
    }
    const routeRegions = new Set(cfg.routes.map((r) => r.regionId));
    const dupRoute = cfg.routes.map((r) => r.regionId).find((id, i, a) => a.indexOf(id) !== i);
    if (dupRoute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `travel.routes defines region "${dupRoute}" more than once`,
        path: ['routes'],
      });
    }
    for (const [i, route] of cfg.routes.entries()) {
      if (!passIds.has(route.passId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `travel.routes["${route.regionId}"] references unknown pass "${route.passId}" ` +
            `(known passes: ${[...passIds].join(', ') || 'none'})`,
          path: ['routes', i, 'passId'],
        });
      }
      // The starting region is reachable by rule, never by purchase. A route
      // to it would render a "buy" button for somewhere the player already is.
      if (route.regionId === DEFAULT_REGION) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `travel.routes must not define a route to the starting region ` +
            `"${DEFAULT_REGION}" — it is always reachable`,
          path: ['routes', i, 'regionId'],
        });
      }
    }
    // A pass that grants a destination nobody declared would unlock a region
    // the Locations screen has no price, gate or detail copy for.
    for (const [i, pass] of cfg.passes.entries()) {
      for (const [j, regionId] of pass.grantsRoutes.entries()) {
        if (!routeRegions.has(regionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `travel.passes["${pass.id}"].grantsRoutes names region "${regionId}", ` +
              'which has no entry in travel.routes',
            path: ['passes', i, 'grantsRoutes', j],
          });
        }
      }
    }
  });

export type TravelConfig = z.infer<typeof TravelConfigSchema>;
export type TravelPassConfig = z.infer<typeof TravelPassSchema>;
export type TravelRouteConfig = z.infer<typeof TravelRouteSchema>;

/** Travel switched off — the default when `tables.json` omits the block. */
const TRAVEL_DEFAULT: z.input<typeof TravelConfigSchema> = { enabled: false };

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
  affectionGifts: AffectionGiftsConfigSchema.optional().default(AFFECTION_GIFTS_DEFAULT),
  bossEncounters: BossEncountersConfigSchema.optional().default(BOSS_ENCOUNTERS_DEFAULT),
  seductivePower: SeductivePowerConfigSchema.optional().default({
    rangesByRarity: DEFAULT_SP_RANGES_BY_RARITY,
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
  travel: TravelConfigSchema.optional().default(TRAVEL_DEFAULT),
});

export type ItemContent = z.infer<typeof ItemContentSchema>;
export type SpeciesContent = z.infer<typeof SpeciesContentSchema>;
/** Input shape (pre-defaults) — what an author actually writes in JSON. */
export type SpeciesContentInput = z.input<typeof SpeciesContentSchema>;
export type TablesContent = z.infer<typeof TablesFileSchema>;
export type DuplicateConfig = z.infer<typeof DuplicateConfigSchema>;
export type BuddyAffinityConfig = z.infer<typeof BuddyAffinityConfigSchema>;
export type ProgressionConfig = z.infer<typeof ProgressionConfigSchema>;
export type WaifuProgressionConfig = z.infer<typeof WaifuProgressionConfigSchema>;
export type CareModeConfig = z.infer<typeof CareModeConfigSchema>;
export type DailyQuestsConfig = z.infer<typeof DailyQuestsConfigSchema>;
export type AffectionGiftsConfig = z.infer<typeof AffectionGiftsConfigSchema>;
export type SeductivePowerConfig = z.infer<typeof SeductivePowerConfigSchema>;
export type AffectionGiftTierConfig = z.infer<typeof AffectionGiftTierSchema>;
export type AffectionGiftLootEntry = z.infer<typeof AffectionGiftLootEntrySchema>;
export type QuestPoolEntry = z.infer<typeof QuestPoolEntrySchema>;
export type QuestRewards = z.infer<typeof QuestRewardsSchema>;
export type UiSplashConfig = z.infer<typeof UiSplashConfigSchema>;

export interface LoadedContent {
  items: ItemContent[];
  species: SpeciesContent[];
  tables: TablesContent;
  /**
   * Boss reward tables from `content/bossRewards.json`.
   *
   * Optional on disk and legitimately empty for the same reason as `bosses`:
   * a deployment without boss encounters has neither file. An enabled boss
   * whose table is missing is caught by `loader.validateBossContent`, so an
   * empty list here can only coexist with an empty `bosses` list.
   */
  bossRewards: BossRewardTable[];
  /**
   * Boss definitions from `content/bosses.json`.
   *
   * Non-optional so every consumer sees the same shape, but legitimately empty:
   * a deployment with no `bosses.json` loads with `[]` and the scheduler simply
   * finds nothing to draw. That is a supported configuration, not a broken one.
   */
  bosses: BossContent[];
  /**
   * Every region definition in the content set — core files from
   * `content/regions/` plus one per enabled expansion pack that ships a
   * region. Disabled packs contribute nothing here, so a region that only
   * exists inside a switched-off expansion is simply absent rather than
   * present-and-hidden.
   *
   * Legitimately empty: a deployment with no `content/regions/` directory
   * loads with `[]` and travel stays inert (`tables.travel.enabled` defaults
   * to false), which is exactly the pre-travel behavior.
   */
  regions: RegionContent[];
  /**
   * Expansion pack manifests, **including disabled ones**.
   *
   * Disabled packs are kept in the list on purpose: their species are excluded
   * from `species`, but validation still needs to know they exist so that a
   * region pool naming one can say "that species belongs to disabled expansion
   * X" instead of the much worse "unknown species".
   */
  expansions: ExpansionContent[];
  /**
   * Slug → the expansion that authored it, for species that came from a pack.
   * Core species are absent. Origin metadata only: it records where a species
   * was written, never where she may be encountered.
   */
  speciesOrigin: Record<string, string>;
}
