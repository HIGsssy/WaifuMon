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
] as const;
export type EquipmentSourceType = (typeof EQUIPMENT_SOURCE_TYPES)[number];

/** Rows in the append-only `equipment_events` ledger. */
export const EQUIPMENT_EVENT_KINDS = [
  'granted',
  'equipped',
  'unequipped',
  'removed',
  'flag_changed',
] as const;
export type EquipmentEventKind = (typeof EQUIPMENT_EVENT_KINDS)[number];

/**
 * Rarities an equipment definition may be *authored* with in V1.
 *
 * The database CHECK admits the full Waifumon ladder (`RARITIES`, N…EX) so
 * releasing LR/EX gear later is a validation change rather than a migration;
 * the design deliberately withholds those two tiers until the system matures,
 * and this list is where that decision lives.
 */
export const EQUIPMENT_AUTHORING_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'] as const;
export type EquipmentRarity = (typeof EQUIPMENT_AUTHORING_RARITIES)[number];

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
 * The per-slot ceiling as a SQL expression over the row's own `slot` column —
 * shared by the definition range CHECK and the instance roll CHECK, and
 * mirrored literally in `drizzle/0046_equipment_rolled_instances.sql`.
 */
export const EQUIPMENT_MULTIPLIER_CAP_SQL =
  `(case "slot" when 'attack' then ${EQUIPMENT_MULTIPLIER_BP_MAX.attack} ` +
  `when 'defense' then ${EQUIPMENT_MULTIPLIER_BP_MAX.defense} ` +
  `when 'health' then ${EQUIPMENT_MULTIPLIER_BP_MAX.health} else 0 end)`;

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}

export const EQUIPMENT_SLOT_SQL_LIST = sqlList(EQUIPMENT_SLOTS);
export const EQUIPMENT_SOURCE_TYPE_SQL_LIST = sqlList(EQUIPMENT_SOURCE_TYPES);
export const EQUIPMENT_EVENT_KIND_SQL_LIST = sqlList(EQUIPMENT_EVENT_KINDS);

export function isEquipmentSlot(value: unknown): value is EquipmentSlot {
  return typeof value === 'string' && (EQUIPMENT_SLOTS as readonly string[]).includes(value);
}
