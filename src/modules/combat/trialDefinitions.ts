/**
 * Combat Trial definitions — deployed content in `content/combat/trials.json`.
 *
 * A Trial is a named, ordered fight against **one** enemy from
 * `content/combat/enemies.json`, referenced by `enemyKey`. It never repeats
 * the enemy's stats: what the player fights is always the enemy definition.
 * What a Trial adds is presentation (name, description, art), ordering, the
 * authored stat **recommendation** shown to players, and the one-time
 * first-clear reward.
 *
 * Same envelope as the enemy file: `{ format, version, trials: [...] }`,
 * `.strict()` so a typo'd key is an error rather than silently ignored.
 * Cross-file checks (the enemy exists, reward items exist) run in the content
 * loader's `validateCombatTrialContent`.
 *
 * `recommended` is guidance only and authored by hand — nothing derives it
 * from the enemy and nothing gates entry on it.
 *
 * `artworkPath` / `backgroundArtworkPath` are relative to the assets root,
 * conventionally `combat/backgrounds/<key>.webp` (see `combatArtwork.ts`).
 * Both are optional: without them the enemy's own artwork is the picture.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import { relativeArtworkPath } from '../assets/artworkPath';
import {
  COMBAT_ENEMY_KEY_PATTERN,
  COMBAT_STAT_MAX,
  type CombatEnemyCatalogue,
  type CombatEnemyDefinition,
} from './enemyDefinitions';

/** Relative to the content directory. */
export const COMBAT_TRIAL_FILE = 'combat/trials.json';
export const COMBAT_TRIAL_FILE_FORMAT = 'waifumon-combat-trials' as const;
export const COMBAT_TRIAL_FILE_VERSION = 1 as const;

/**
 * Shorter than enemy keys: a Trial key travels inside a Discord custom id
 * (`wm|v1|ct|fight|<key>|<nonce>`), which Discord caps at 100 characters.
 */
export const COMBAT_TRIAL_KEY_MAX_LENGTH = 48;

const key = (max: number) => z.string().max(max).regex(COMBAT_ENEMY_KEY_PATTERN, 'must be lower_snake_case');
const recommendedStat = z.number().int().min(0).max(COMBAT_STAT_MAX);

export const CombatTrialRecommendedSchema = z
  .object({
    attack: recommendedStat.optional(),
    defense: recommendedStat.optional(),
    hp: recommendedStat.optional(),
  })
  .strict();

/**
 * Paid once, on a player's first `player_victory` in the Trial. Item slugs
 * must name items in `items.json` (checked at load). Repeat clears pay
 * nothing in V1.
 */
export const CombatTrialRewardSchema = z
  .object({
    waifubux: z.number().int().min(0).max(1_000_000).default(0),
    items: z
      .array(
        z
          .object({
            slug: z.string().min(1).max(64),
            quantity: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();

export type CombatTrialReward = z.infer<typeof CombatTrialRewardSchema>;

export const CombatTrialDefinitionSchema = z
  .object({
    key: key(COMBAT_TRIAL_KEY_MAX_LENGTH),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    enemyKey: key(64),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(1_000_000),
    recommended: CombatTrialRecommendedSchema.nullable().default(null),
    artworkPath: relativeArtworkPath.nullable().default(null),
    backgroundArtworkPath: relativeArtworkPath.nullable().default(null),
    firstClearRewards: CombatTrialRewardSchema.nullable().default(null),
    tags: z.array(key(64)).max(20).default([]),
  })
  .strict();

export type CombatTrialDefinition = z.infer<typeof CombatTrialDefinitionSchema>;
export type CombatTrialDefinitionInput = z.input<typeof CombatTrialDefinitionSchema>;

export const CombatTrialFileSchema = z
  .object({
    format: z.literal(COMBAT_TRIAL_FILE_FORMAT),
    version: z.literal(COMBAT_TRIAL_FILE_VERSION),
    trials: z.array(CombatTrialDefinitionSchema).max(1000),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();
    file.trials.forEach((trial, i) => {
      const first = seen.get(trial.key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trials', i, 'key'],
          message: `duplicate trial key "${trial.key}" (also trials[${first}])`,
        });
      } else seen.set(trial.key, i);
    });
  });

/** Why a Trial cannot be fought right now. */
export type CombatTrialUnavailableReason = 'missing' | 'disabled' | 'enemy_missing' | 'enemy_disabled';

/** A Trial resolved against the enemy catalogue. */
export type ResolvedCombatTrial =
  | { status: 'available'; trial: CombatTrialDefinition; enemy: CombatEnemyDefinition }
  | { status: 'unavailable'; reason: CombatTrialUnavailableReason; trial: CombatTrialDefinition | null };

/** Lookup over a validated Trial list, joined to the enemies it names. */
export interface CombatTrialCatalogue {
  /** Any defined Trial, enabled or not. */
  get(key: string): CombatTrialDefinition | undefined;
  /** The Trial and its enemy, or why it cannot be fought. */
  resolve(key: string): ResolvedCombatTrial;
  /**
   * Fightable Trials in `order` (file order breaks ties): the Trial is
   * enabled and its enemy exists and is enabled.
   */
  available(): Array<{ trial: CombatTrialDefinition; enemy: CombatEnemyDefinition }>;
}

export function createCombatTrialCatalogue(
  trials: readonly CombatTrialDefinition[],
  enemies: CombatEnemyCatalogue,
): CombatTrialCatalogue {
  const byKey = new Map(trials.map((t) => [t.key, t]));
  const sorted = trials
    .map((trial, index) => ({ trial, index }))
    .sort((a, b) => a.trial.order - b.trial.order || a.index - b.index)
    .map(({ trial }) => trial);

  function resolve(k: string): ResolvedCombatTrial {
    const trial = byKey.get(k);
    if (!trial) return { status: 'unavailable', reason: 'missing', trial: null };
    if (!trial.enabled) return { status: 'unavailable', reason: 'disabled', trial };
    const enemy = enemies.get(trial.enemyKey);
    if (!enemy) return { status: 'unavailable', reason: 'enemy_missing', trial };
    if (!enemy.enabled) return { status: 'unavailable', reason: 'enemy_disabled', trial };
    return { status: 'available', trial, enemy };
  }

  return {
    get: (k) => byKey.get(k),
    resolve,
    available: () =>
      sorted.flatMap((t) => {
        const r = resolve(t.key);
        return r.status === 'available' ? [{ trial: r.trial, enemy: r.enemy }] : [];
      }),
  };
}
