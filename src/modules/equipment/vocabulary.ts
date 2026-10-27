/**
 * Equipment vocabulary — the closed sets the equipment tables are CHECKed
 * against.
 *
 * Kept free of imports on purpose: `db/schema.ts` imports this module to build
 * its CHECK constraints, exactly as it does `locations/regions.ts`, so anything
 * this file pulled in would be pulled into the schema too.
 *
 * Every list here is mirrored as a literal in `drizzle/0045_equipment_foundation
 * .sql` (migrations cannot import TypeScript). `tests/unit/equipmentVocabulary
 * .test.ts` fails if the two ever disagree, so widening one of these — adding a
 * `relic` slot, a `dungeon` source — is deliberately a code change *plus* a
 * CHECK-widening migration, never one without the other.
 */

/**
 * The V1 equipment slots. Each converts the Buddy's Current SP into one combat
 * stat (see `equipmentMath.ts`). A future Relic/Charm slot is a new entry here
 * and a migration widening every `*_slot_check`.
 */
export const EQUIPMENT_SLOTS = ['attack', 'defense', 'health'] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/**
 * Where an owned instance came from. Recorded on every instance for audit and
 * reward tuning; nothing reads it back to make a decision.
 *
 * Several are reserved for systems that do not exist yet (`dungeon`, `raid`,
 * `quest`) so that shipping them needs no migration of this column.
 * `fabrication` is a copy Patch built in the Workshop (`0049`).
 */
export const EQUIPMENT_SOURCE_TYPES = [
  'onboarding',
  'boss',
  'encounter',
  'expedition',
  'shop',
  'admin',
  'event',
  'dungeon',
  'raid',
  'quest',
  'fabrication',
] as const;
export type EquipmentSourceType = (typeof EQUIPMENT_SOURCE_TYPES)[number];

/**
 * How a source reads to a player ("Found: Boss"). The type alone — never the
 * source key, grant key or audit payload behind it.
 */
export const EQUIPMENT_SOURCE_LABELS: Readonly<Record<EquipmentSourceType, string>> = Object.freeze({
  onboarding: 'Equipment onboarding',
  boss: 'Boss',
  encounter: 'Encounter',
  expedition: 'Expedition',
  shop: 'Shop',
  admin: 'Granted',
  event: 'Event',
  dungeon: 'Dungeon',
  raid: 'Raid',
  quest: 'Quest',
  fabrication: 'Fabricated by Patch',
});

/**
 * Rows in the append-only `equipment_events` ledger. `dismantled` is a copy
 * the player broke down at Patch's Workshop (`0049`) — a player action,
 * distinct from an admin `removed`.
 */
export const EQUIPMENT_EVENT_KINDS = [
  'granted',
  'equipped',
  'unequipped',
  'removed',
  'flag_changed',
  'dismantled',
] as const;
export type EquipmentEventKind = (typeof EQUIPMENT_EVENT_KINDS)[number];

/**
 * Rarity capabilities (Equipment 3.0). Four separate questions, four separate
 * lists — none derived from another, so widening one can never widen the
 * rest by accident:
 *
 *  - {@link EQUIPMENT_AUTHORING_RARITIES} — what a definition may be authored as.
 *  - {@link EQUIPMENT_RANDOM_ROLL_RARITIES} — what `rollEquipmentInstance` can
 *    generate today (the rarities with affix pools and bonus rules).
 *  - `EQUIPMENT_REWARD_RARITIES` (`rewardSelector.ts`) — what a random reward
 *    selector may hand out, and what one without `rarity` defaults to.
 *  - `WORKSHOP_RECIPE_RARITIES` (`workshopConfig.ts`) — what Patch can salvage
 *    and fabricate.
 *
 * `tests/unit/equipmentRarityCapabilities.test.ts` pins all four.
 */

/**
 * Rarities an equipment definition may be *authored* with. The database CHECK
 * admits the full Waifumon ladder (`RARITIES`, N…EX); EX stays withheld.
 * Authoring an SSR/UR/LR definition does not make it obtainable: random rolls
 * and every reward selector still refuse it.
 */
export const EQUIPMENT_AUTHORING_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'] as const;
export type EquipmentRarity = (typeof EQUIPMENT_AUTHORING_RARITIES)[number];

/**
 * Rarities a random roll can generate. SSR and above fail closed (no affix
 * pool, no bonus rule) until the Equipment 3.0 high-rarity engine ships.
 */
export const EQUIPMENT_RANDOM_ROLL_RARITIES = ['N', 'R', 'SR'] as const;

/**
 * Stable definition keys: lowercase snake_case, the same shape as a world
 * encounter vendor key. A key is the only identity content, packages, reward
 * tables and logs ever use, and it never changes once created.
 */
export const EQUIPMENT_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const EQUIPMENT_KEY_MAX_LENGTH = 64;

/**
 * Hard ceilings on a definition's multipliers, in basis points (10000 = ×1.00).
 *
 * Safety rails, not tuning: the design's illustrative bands top out around
 * ×0.95 ATK/DEF and ×3.8 HP, and these sit well above that so balancing never
 * needs a migration. They are enforced twice — by definition validation, which
 * fails loudly with a path, and by a CHECK constraint as the backstop for
 * anything that reaches the table another way.
 */
export const EQUIPMENT_MULTIPLIER_BP_MAX: Readonly<Record<EquipmentSlot, number>> = Object.freeze({
  attack: 20_000,
  defense: 20_000,
  health: 80_000,
});

/**
 * Flat SP safety ceilings (Equipment 3.0), in whole SP. Integrity rails, not
 * balance targets — no shipped gear carries flat SP.
 *
 *  - Per copy: the copy's primary `rolled_properties.flatSp` plus its
 *    additional `flat_sp` bonus. Enforced before storage (fixed grants) and
 *    clamped on read for anything that reached the table another way.
 *  - Per loadout: the sum over the equipped slots. Every copy keeps its stored
 *    values; only the amount added to effective SP is clamped
 *    (`equipmentMath.flatSpOf`).
 */
export const EQUIPMENT_FLAT_SP_MAX_PER_ITEM = 200;
export const EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT = 400;

/**
 * The per-slot ceiling as a SQL expression over the row's own `slot` column —
 * shared by the definition range CHECK and the instance roll CHECK, and
 * mirrored literally in `drizzle/0046_equipment_rolled_instances.sql`.
 */
export const EQUIPMENT_MULTIPLIER_CAP_SQL =
  `(case "slot" when 'attack' then ${EQUIPMENT_MULTIPLIER_BP_MAX.attack} ` +
  `when 'defense' then ${EQUIPMENT_MULTIPLIER_BP_MAX.defense} ` +
  `when 'health' then ${EQUIPMENT_MULTIPLIER_BP_MAX.health} else 0 end)`;

/**
 * Patch's Workshop (`equipment_workshop_operations`, `0049`): what one
 * confirmed operation did, and the slot a fabrication asked for — a real slot,
 * or `any` ("Surprise Me").
 */
export const WORKSHOP_OPERATION_KINDS = ['dismantle', 'fabricate'] as const;
export type WorkshopOperationKind = (typeof WORKSHOP_OPERATION_KINDS)[number];
export const WORKSHOP_SLOT_CHOICES = [...EQUIPMENT_SLOTS, 'any'] as const;
export type WorkshopSlotChoice = (typeof WORKSHOP_SLOT_CHOICES)[number];

export function isWorkshopSlotChoice(value: unknown): value is WorkshopSlotChoice {
  return typeof value === 'string' && (WORKSHOP_SLOT_CHOICES as readonly string[]).includes(value);
}

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}

export const EQUIPMENT_SLOT_SQL_LIST = sqlList(EQUIPMENT_SLOTS);
export const EQUIPMENT_SOURCE_TYPE_SQL_LIST = sqlList(EQUIPMENT_SOURCE_TYPES);
export const EQUIPMENT_EVENT_KIND_SQL_LIST = sqlList(EQUIPMENT_EVENT_KINDS);
export const WORKSHOP_OPERATION_KIND_SQL_LIST = sqlList(WORKSHOP_OPERATION_KINDS);
export const WORKSHOP_SLOT_CHOICE_SQL_LIST = sqlList(WORKSHOP_SLOT_CHOICES);

export function isEquipmentSlot(value: unknown): value is EquipmentSlot {
  return typeof value === 'string' && (EQUIPMENT_SLOTS as readonly string[]).includes(value);
}
