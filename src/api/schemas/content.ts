/**
 * Content resources — species, items, tuning tables, quest pool.
 *
 * Two shapes exist for species and items, and the difference is load-bearing:
 *
 *   `speciesSchema` / `itemSchema`      the seeded **database** rows, which
 *                                       carry an internal `id`. These are what
 *                                       gameplay resources reference (an owned
 *                                       waifu has a `speciesId`, an inventory
 *                                       entry an `itemId`), so they are what
 *                                       gameplay endpoints embed.
 *
 *   `contentSpeciesSchema` / `contentItemSchema`
 *                                       the in-memory **content snapshot**,
 *                                       keyed by slug with no id, served by
 *                                       `/content/*`. This is the authored
 *                                       source that the admin panel edits.
 *
 * The two are kept in sync by the seeder. Content endpoints read the snapshot
 * (no query at all — see §Performance in the Phase 2 notes); gameplay
 * endpoints embed the DB row they already joined.
 */
import { z } from 'zod';
import { appearanceCatalogSchema } from './appearance';
import {
  affinitySchema,
  contentRatingSchema,
  raritySchema,
} from './common';

// ── Species ─────────────────────────────────────────────────────────────────

const speciesFields = {
  slug: z.string(),
  name: z.string(),
  rarity: raritySchema,
  archetype: z.string(),
  affinity: affinitySchema.describe('Buddy capture-matchup style.'),
  contentRating: contentRatingSchema,
  description: z.string(),
  tags: z.array(z.string()),
  baseCaptureRate: z.number().nullable(),
  enabled: z.boolean(),
  eventKey: z.string().nullable(),
  perSpeciesWeight: z.number().int(),
  /**
   * The species' appearance catalog — the authoritative source for the
   * encyclopedia and for previewing artwork a player has not earned yet.
   * Catalog metadata only: `isUnlocked` / `isSelected` are per-copy and come
   * from the collection's appearance endpoint instead.
   *
   * Never empty: a species with no authored catalog resolves to its single
   * implicit `standard` / `owned` entry.
   */
  appearances: z.array(appearanceCatalogSchema),
};

/** Seeded species row — carries the internal id gameplay resources point at. */
export const speciesSchema = z.object({
  id: z.number().int(),
  ...speciesFields,
});

/** Authored species from the content snapshot; addressed by slug. */
export const contentSpeciesSchema = z.object(speciesFields);

export const speciesQuery = z.object({
  rarity: raritySchema.optional(),
  archetype: z.string().min(1).max(60).optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .describe('Omit to return both enabled and disabled species.'),
});

// ── Items ───────────────────────────────────────────────────────────────────

export const ITEM_CATEGORIES = ['capture', 'material', 'cosmetic', 'consumable'] as const;

const itemFields = {
  slug: z.string(),
  name: z.string(),
  category: z.enum(ITEM_CATEGORIES),
  description: z.string(),
  emoji: z.string().nullable(),
  enabled: z.boolean(),
  purchasable: z.boolean(),
  buyPrice: z.number().int().nullable(),
  priceCurrency: z.enum(['waifubux', 'essence']),
  captureModifier: z.number().nullable(),
  isGuaranteedCapture: z.boolean(),
  effectType: z.string().nullable().describe('Non-null makes the item usable from the inventory.'),
  effectConfig: z.record(z.string(), z.unknown()).nullable(),
  dailyStockLimit: z.number().int().nullable(),
};

/** Seeded item row — carries the internal id inventory entries point at. */
export const itemSchema = z.object({
  id: z.number().int(),
  ...itemFields,
});

/** Authored item from the content snapshot; addressed by slug. */
export const contentItemSchema = z.object(itemFields);

export const itemsQuery = z.object({
  category: z.enum(ITEM_CATEGORIES).optional(),
  enabled: z
    .enum(['true', 'false'])
    .optional()
    .describe('Omit to return both enabled and disabled items.'),
});

// ── Tuning tables ───────────────────────────────────────────────────────────

/**
 * Intentionally opaque. `tables.json` is balance tuning — hunt weights, XP
 * curves, care-mode rates — and it is re-tuned routinely. Freezing its nested
 * shape into the v1 contract would make every balance patch a breaking API
 * change and would churn the OpenAPI snapshot for no client benefit. Clients
 * that read tuning data are expected to be operator tools that follow the
 * content schema, not third parties coding against a frozen shape.
 */
export const tablesSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Balance tuning blob, mirroring content/tables.json. Its nested shape is owned by the ' +
      'content loader and is explicitly NOT part of the frozen v1 contract — treat it as opaque.',
  );

export const tableKeyParams = z.object({
  key: z.string().min(1).max(60).regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
});

// ── Quest catalog ───────────────────────────────────────────────────────────

export const questRewardsSchema = z.object({
  waifubux: z.number().int(),
  essence: z.number().int(),
  items: z.array(z.object({ slug: z.string(), quantity: z.number().int() })),
});

export const questPoolEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.string().describe('Quest event type the pool entry tracks.'),
  target: z.number().int(),
  weight: z.number(),
  difficulty: z.string(),
  rarityAtLeast: raritySchema.nullable(),
  rewards: questRewardsSchema,
});

export const questCatalogSchema = z.object({
  enabled: z.boolean(),
  questsPerDay: z.number().int(),
  allCompleteBonus: questRewardsSchema.nullable(),
  pool: z.array(questPoolEntrySchema),
});
