/**
 * Player Equipment management resources (Portal).
 *
 * What a player may see about their own gear and nothing more: display name,
 * slot, rarity, the copy's rolled multiplier and its definition's range as
 * plain multipliers (`0.8`, never `8000` basis points), roll quality, and the
 * three per-copy flags. Definition keys, affix keys, grant keys, source keys
 * and audit payloads never appear. The instance `id` is an opaque handle for
 * the action routes — clients do not render it.
 */
import { z } from 'zod';
import { EQUIPMENT_SLOTS } from '../../modules/equipment/vocabulary';
import { BROWSE_DEFAULT_PAGE_SIZE, BROWSE_MAX_PAGE_SIZE } from '../../modules/equipment/equipmentManagementService';
import { idParam, isoDateTime, raritySchema } from './common';

export const equipmentSlotSchema = z.enum(EQUIPMENT_SLOTS);

export const equipmentItemSchema = z.object({
  id: z.number().int().describe('Opaque handle for the action routes. Not for display.'),
  name: z.string().describe('Display name: base name plus affix suffix.'),
  baseName: z.string(),
  description: z.string(),
  slot: equipmentSlotSchema,
  rarity: raritySchema,
  multiplier: z.number().describe('This copy’s rolled multiplier, e.g. 0.8 for ×0.80.'),
  range: z
    .object({ min: z.number(), max: z.number() })
    .describe('The definition’s configured multiplier range, e.g. 0.65–0.85.'),
  rollQuality: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Display only: (rolled − min) / (max − min) as 0–100; 100 for a single-value range.'),
  equipped: z.boolean(),
  favorite: z.boolean(),
  locked: z.boolean(),
  acquiredAt: isoDateTime,
  source: z.string().describe('Human-friendly acquisition source, e.g. "Boss".'),
});

const statValue = z.number().int().nullable();

export const equipmentStatsSchema = z.object({
  attack: statValue,
  defense: statValue,
  maxHp: statValue,
});

export const equipmentOverviewSchema = z.discriminatedUnion('unlocked', [
  z.object({ unlocked: z.literal(false) }),
  z.object({
    unlocked: z.literal(true),
    buddy: z
      .object({
        waifuId: z.number().int(),
        name: z.string(),
        level: z.number().int(),
        currentSp: z.number().int(),
      })
      .nullable(),
    stats: equipmentStatsSchema.describe('Null per stat when its slot is empty or there is no Buddy.'),
    unavailableReason: z.enum(['no_buddy', 'incomplete_loadout']).nullable(),
    slots: z.object({
      attack: equipmentItemSchema.nullable(),
      defense: equipmentItemSchema.nullable(),
      health: equipmentItemSchema.nullable(),
    }),
  }),
]);

export const equipmentPageSchema = z.object({
  items: z.array(equipmentItemSchema),
  nextCursor: z.string().nullable(),
});

export const equipmentComparisonSchema = z.object({
  stat: z.enum(['attack', 'defense', 'maxHp']),
  /** The slot's stat now; null when empty or without a Buddy. */
  current: statValue,
  /** The slot's stat with this copy in it; null without a Buddy. */
  withItem: statValue,
  delta: statValue,
  /** What the slot holds now — this copy itself when it is the equipped one. */
  equippedItem: equipmentItemSchema.nullable(),
  /** False when there is no active Buddy, so no value could be calculated. */
  hasBuddy: z.boolean(),
});

export const equipmentDetailSchema = z.object({
  item: equipmentItemSchema,
  identicalCopies: z
    .number()
    .int()
    .describe('Copies the player holds with the same definition, roll and affix — this one included.'),
  comparison: equipmentComparisonSchema,
});

export const slotChangeSchema = z.object({
  slot: equipmentSlotSchema,
  changed: z.boolean(),
  item: equipmentItemSchema.nullable(),
  before: statValue,
  after: statValue,
});

// ── Requests ────────────────────────────────────────────────────────────────

/** The API's sort names; `newest` is the service's `acquired`. */
export const EQUIPMENT_BROWSE_SORTS = ['newest', 'oldest', 'slot', 'rarity', 'name', 'multiplier', 'quality'] as const;

const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const equipmentBrowseQuery = z.object({
  slot: equipmentSlotSchema.optional(),
  rarity: raritySchema.optional(),
  equipped: booleanQuery.optional(),
  favorite: booleanQuery.optional(),
  locked: booleanQuery.optional(),
  search: z.string().trim().max(100).optional().describe('Display-name substring: base name or affix suffix.'),
  sort: z.enum(EQUIPMENT_BROWSE_SORTS).default('newest'),
  cursor: z.string().min(1).max(512).optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce.number().int().min(1).max(BROWSE_MAX_PAGE_SIZE).default(BROWSE_DEFAULT_PAGE_SIZE),
});

export const equipmentItemParams = z.object({ playerId: idParam, equipmentId: idParam });
export const equipmentSlotParams = z.object({ playerId: idParam, slot: equipmentSlotSchema });
export const equipmentFlagParams = z.object({
  playerId: idParam,
  equipmentId: idParam,
  flag: z.enum(['favorite', 'locked']),
});

/**
 * What the client last saw in the slot — the stale-view guard. Required: a
 * change made from an outdated screen is refused with `409 LOADOUT_CONFLICT`
 * rather than silently overwriting a slot the player never saw.
 */
export const slotChangeBody = z.object({
  expectedCurrentId: z.number().int().positive().nullable(),
});

export const flagBody = z.object({ value: z.boolean() });
