/**
 * Feature-unlock vocabulary — the closed sets `player_feature_unlocks` is
 * CHECKed against.
 *
 * Import-free for the same reason as `equipment/vocabulary.ts`: `db/schema.ts`
 * builds its CHECK constraints from these lists. Both are mirrored as literals
 * in `drizzle/0045_equipment_foundation.sql`, and
 * `tests/unit/equipmentVocabulary.test.ts` keeps the two in step.
 */

/**
 * Account features a player unlocks once and keeps. Equipment is the first;
 * a future Dungeon or Raid unlock is a new entry here plus a CHECK-widening
 * migration.
 */
export const FEATURE_KEYS = ['equipment'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * How an unlock came about.
 *
 *   onboarding — the player completed the feature's introductory sequence.
 *   admin      — granted by an operator (audited).
 *   migration  — a backfill, should one ever be needed.
 */
export const FEATURE_UNLOCK_SOURCES = ['onboarding', 'admin', 'migration'] as const;
export type FeatureUnlockSource = (typeof FEATURE_UNLOCK_SOURCES)[number];

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}

export const FEATURE_KEY_SQL_LIST = sqlList(FEATURE_KEYS);
export const FEATURE_UNLOCK_SOURCE_SQL_LIST = sqlList(FEATURE_UNLOCK_SOURCES);

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}
