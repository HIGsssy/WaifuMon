/**
 * Combat enemy definitions — the shape of one enemy, and of the shipped file
 * `content/combat/enemies.json`.
 *
 * The file is the *shipped default*. At startup it is seeded into the
 * `combat_enemies` table (see `modules/enemies`), which is what every system
 * reads: the Enemy Catalogue. Same envelope as the affix catalogue:
 * `{ format, version, enemies: [...] }`, `.strict()` so a typo'd key is an
 * error rather than silently ignored. An export from Portal Admin is a file
 * of exactly this shape.
 *
 * Stats are the numbers the engine fights with, as non-negative integers:
 *
 *   - `attack` ≥ 1. Zero is refused in V1: the only action is a basic attack
 *     and the minimum-damage rule would make a 0-ATK enemy hit for 1 anyway.
 *     Revisit when utility enemies (abilities only) exist.
 *   - `defense` ≥ 0.
 *   - `hp` ≥ 1.
 *
 * {@link COMBAT_STAT_MAX} is a typo guard, not a balance rule: a strong boss
 * is fine, a stat with three extra zeroes is not.
 *
 * `artworkPath` is relative to the assets root, conventionally
 * `combat/enemies/<key>.webp` (see `combatArtwork.ts`); null means text-only.
 *
 * `spriteArtworkPath` is a separate, optional **transparent** cut-out of the
 * enemy (conventionally `combat/sprites/<key>.webp`), meant to be layered
 * over a dungeon background; `spritePlacement` is where it stands by default.
 * Managed artwork uploaded through Portal Admin lives on the catalogue row
 * and wins over both paths. An enemy needs neither.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import { SpritePlacementSchema } from '../artworkAssets/scenePlacement';
import type { CombatantInput } from './combatState';

/** Relative to the content directory. */
export const COMBAT_ENEMY_FILE = 'combat/enemies.json';
export const COMBAT_ENEMY_FILE_FORMAT = 'waifumon-combat-enemies' as const;
export const COMBAT_ENEMY_FILE_VERSION = 1 as const;

export const COMBAT_ENEMY_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const COMBAT_ENEMY_KEY_MAX_LENGTH = 64;
export const COMBAT_ENEMY_NAME_MAX_LENGTH = 100;
export const COMBAT_ENEMY_DESCRIPTION_MAX_LENGTH = 500;
export const COMBAT_ENEMY_MAX_TAGS = 20;
/** Sanity ceiling on any authored stat — far above anything a Buddy reaches. */
export const COMBAT_STAT_MAX = 1_000_000;

const stat = (min: number) => z.number().int().min(min).max(COMBAT_STAT_MAX);
const key = z
  .string()
  .max(COMBAT_ENEMY_KEY_MAX_LENGTH)
  .regex(COMBAT_ENEMY_KEY_PATTERN, 'must be lower_snake_case');

export const CombatEnemyDefinitionSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(COMBAT_ENEMY_NAME_MAX_LENGTH),
    /** Admin-facing notes and flavour. Optional in the file. */
    description: z.string().trim().max(COMBAT_ENEMY_DESCRIPTION_MAX_LENGTH).default(''),
    attack: stat(1),
    defense: stat(0),
    hp: stat(1),
    artworkPath: relativeArtworkPath.nullable().default(null),
    spriteArtworkPath: relativeArtworkPath.nullable().default(null),
    spritePlacement: SpritePlacementSchema.nullable().default(null),
    enabled: z.boolean(),
    tags: z.array(key).max(COMBAT_ENEMY_MAX_TAGS).default([]),
  })
  .strict();

export type CombatEnemyDefinition = z.infer<typeof CombatEnemyDefinitionSchema>;
export type CombatEnemyDefinitionInput = z.input<typeof CombatEnemyDefinitionSchema>;

export const CombatEnemyFileSchema = z
  .object({
    format: z.literal(COMBAT_ENEMY_FILE_FORMAT),
    version: z.literal(COMBAT_ENEMY_FILE_VERSION),
    enemies: z.array(CombatEnemyDefinitionSchema).max(5000),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    file.enemies.forEach((enemy, i) => {
      const first = seen.get(enemy.key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['enemies', i, 'key'],
          message: `duplicate enemy key "${enemy.key}" (also enemies[${first}])`,
        });
      } else seen.set(enemy.key, i);
    });
  });

/** Lookup over a validated enemy list. */
export interface CombatEnemyCatalogue {
  /** Any defined enemy, enabled or not. */
  get(key: string): CombatEnemyDefinition | undefined;
  /** Enabled enemies, in file order. */
  enabled(): CombatEnemyDefinition[];
}

export function createCombatEnemyCatalogue(
  enemies: readonly CombatEnemyDefinition[],
): CombatEnemyCatalogue {
  const byKey = new Map(enemies.map((e) => [e.key, e]));
  return {
    get: (k) => byKey.get(k),
    enabled: () => enemies.filter((e) => e.enabled),
  };
}

/** The engine input for an enemy at full HP. Id is `enemy:<key>`. */
export function enemyCombatantInput(enemy: CombatEnemyDefinition): CombatantInput {
  return {
    id: `enemy:${enemy.key}`,
    name: enemy.name,
    attack: enemy.attack,
    defense: enemy.defense,
    maxHp: enemy.hp,
  };
}
