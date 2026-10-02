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
import { EQUIPMENT_SLOTS, WORKSHOP_SLOT_CHOICES } from '../../modules/equipment/vocabulary';
import { WORKSHOP_REQUEST_KEY_PATTERN } from '../../modules/equipment/equipmentWorkshopService';
import { MAX_DISMANTLE_BATCH } from '../../modules/equipment/equipmentService';
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
  source: z.string().describe('Human-friendly acquisition source, e.g. "Boss" or "Fabricated by Patch".'),
  salvage: z
    .object({
      components: z
        .number()
        .int()
        .nullable()
        .describe('Salvaged Components Patch pays for this copy; null for a rarity Patch cannot salvage.'),
      blockedBy: z
        .enum(['equipped', 'favorite', 'locked', 'unsupported_rarity'])
        .nullable()
        .describe('Why this copy cannot be dismantled right now; null when it can.'),
    })
    .describe('Dismantle eligibility, decided by the server. The dismantle route re-checks it.'),
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

// ── Patch's Workshop ────────────────────────────────────────────────────────

export const workshopSlotChoiceSchema = z.enum(WORKSHOP_SLOT_CHOICES);

const balancesSchema = z.object({
  components: z.number().int().describe('Salvaged Components.'),
  waifubux: z.number().int(),
});

export const workshopOverviewSchema = z.object({
  balances: balancesSchema,
  artwork: z
    .object({
      source: z
        .enum(['workshop', 'patch'])
        .describe('`workshop` — the Workshop’s own artwork; `patch` — Patch’s portrait, its fallback.'),
    })
    .nullable()
    .describe(
      'The image to show, already resolved on the server, or null for text-only. Fetch the bytes ' +
        'from `GET …/equipment/workshop/artwork`; no path is ever exposed.',
    ),
  salvageYields: z
    .array(z.object({ rarity: raritySchema, components: z.number().int() }))
    .describe('Components per dismantled copy, by rarity. A rarity not listed cannot be dismantled.'),
  recipes: z.array(
    z.object({
      key: z.string().describe('Recipe handle for the fabricate route.'),
      name: z.string(),
      description: z.string().nullable(),
      rarity: raritySchema.describe('The rarity this recipe guarantees.'),
      componentCost: z.number().int(),
      waifubuxCost: z.number().int(),
      slots: z
        .array(
          z.object({
            choice: workshopSlotChoiceSchema,
            eligibleCount: z.number().int().describe('Base definitions this choice could produce.'),
            available: z.boolean(),
          }),
        )
        .describe('Attack, Defense, Health and Any, in that order — from live definitions.'),
      available: z.boolean().describe('At least one slot choice can be fabricated.'),
      affordable: z.boolean(),
      shortfall: balancesSchema.describe('How far short the player is; zeros when affordable.'),
    }),
  ),
});

const dismantleLineSchema = z.object({
  id: z.number().int().describe('Opaque instance handle.'),
  name: z.string(),
  rarity: raritySchema,
  slot: equipmentSlotSchema,
  multiplier: z.number(),
  components: z.number().int(),
});

const rarityLineSchema = z.object({ rarity: raritySchema, count: z.number().int(), components: z.number().int() });

export const dismantlePreviewSchema = z.object({
  count: z.number().int(),
  byRarity: z.array(rarityLineSchema),
  totalComponents: z.number().int(),
  items: z.array(dismantleLineSchema),
  balances: balancesSchema,
  componentsAfter: z.number().int(),
});

export const dismantleResultSchema = z.object({
  replayed: z.boolean().describe('True when this request key was already applied; nothing new happened.'),
  count: z.number().int(),
  byRarity: z.array(rarityLineSchema),
  totalComponents: z.number().int(),
  items: z.array(dismantleLineSchema),
  balances: balancesSchema,
});

export const fabricationResultSchema = z.object({
  replayed: z.boolean().describe('True when this request key was already applied: the same item, charged once.'),
  recipe: z.object({ key: z.string(), name: z.string(), rarity: raritySchema }),
  slotChoice: workshopSlotChoiceSchema,
  cost: balancesSchema,
  item: z.object({
    id: z.number().int().describe('Opaque instance handle — open it with the item route.'),
    name: z.string().describe('Display name: base name plus affix suffix.'),
    baseName: z.string(),
    slot: equipmentSlotSchema,
    rarity: raritySchema,
    multiplier: z.number(),
    affix: z.string().nullable().describe('The affix text, e.g. "of Poor Planning".'),
  }),
  balances: balancesSchema,
});

const requestKey = z
  .string()
  .regex(WORKSHOP_REQUEST_KEY_PATTERN, 'must be 8–100 letters, digits, "_", ":", "." or "-"')
  .describe('Idempotency key, one per confirmation. A retry with the same key returns the original result.');

const equipmentIdList = z
  .array(z.number().int().positive())
  .min(1)
  .max(MAX_DISMANTLE_BATCH)
  .describe(`Explicit instance ids, at most ${MAX_DISMANTLE_BATCH}. Duplicates are refused.`);

export const dismantlePreviewBody = z.object({ equipmentIds: equipmentIdList });

export const dismantleBody = z.object({
  equipmentIds: equipmentIdList,
  requestKey,
  expectedComponents: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('The total the player reviewed; refused with 409 WORKSHOP_PREVIEW_STALE if it changed.'),
});

export const fabricateBody = z.object({
  recipeKey: z.string().min(1).max(64),
  slot: workshopSlotChoiceSchema,
  requestKey,
});
