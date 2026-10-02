/**
 * The Equipment affix catalogue — the master list of flavour suffixes an owned
 * instance may carry ("Rusty Pipe *of the Desperate Swings*").
 *
 * Deployed content, not database content: read from
 * `content/equipment/affixes.json` by the content loader with everything else
 * on disk, and followed live through `getContent()` so a reload is picked up.
 * Staging and production receive it with the deploy; it never travels in an
 * equipment package.
 *
 * ## Pools
 *
 * Every affix belongs to exactly one pool, `<slot>.<rarity>` — nine in all
 * (`attack.N` … `health.SR`). A definition's pool is **derived** from its slot
 * and rarity (`affixPoolOf`), never stored on the definition, so the two cannot
 * drift apart. A random roll draws only from its own pool: no fallback to
 * another rarity, slot or pool.
 *
 * Affixes are **flavour only**. An entry is a key, a suffix, a pool and an
 * enabled flag; the schema is `.strict()`, so an authored stat, effect or
 * weight is refused rather than stored inert.
 *
 * ## Keys are forever
 *
 * Owned instances store the affix **key** (`player_equipment.affix_key`) and
 * the display name is derived from it on every read. So an affix is retired by
 * setting `enabled: false` — it stops being rolled and keeps rendering on
 * every copy that already has it. Deleting an entry leaves owned copies naming
 * a key nothing resolves: they render with a visible `[Unknown Affix]` marker
 * and the miss is reported (`onUnknownKey`), so don't.
 *
 * Kept free of database imports so the content loader can validate the file.
 */
import { z } from 'zod';
import { EQUIPMENT_KEY_MAX_LENGTH, EQUIPMENT_KEY_PATTERN, EQUIPMENT_SLOTS } from './vocabulary';

/** Relative to the content directory. */
export const EQUIPMENT_AFFIX_FILE = 'equipment/affixes.json';

export const EQUIPMENT_AFFIX_FILE_FORMAT = 'waifumon-equipment-affixes' as const;
/** Version 2 added `pool`. */
export const EQUIPMENT_AFFIX_FILE_VERSION = 2 as const;

/** Rarities that have affix pools. SSR and above have none yet. */
export const EQUIPMENT_AFFIX_RARITIES = ['N', 'R', 'SR'] as const;

/** The nine pools, `<slot>.<rarity>`. */
export const EQUIPMENT_AFFIX_POOLS = EQUIPMENT_SLOTS.flatMap((slot) =>
  EQUIPMENT_AFFIX_RARITIES.map((rarity) => `${slot}.${rarity}` as const),
);
export type EquipmentAffixPool = (typeof EQUIPMENT_AFFIX_POOLS)[number];

export function isEquipmentAffixPool(value: unknown): value is EquipmentAffixPool {
  return typeof value === 'string' && (EQUIPMENT_AFFIX_POOLS as readonly string[]).includes(value);
}

/**
 * The pool a definition rolls from, derived from its slot and rarity. Returns
 * the derived id even when it is not a supported pool (an SSR definition), so
 * a caller can say exactly which pool is missing.
 */
export function affixPoolOf(definition: { slot: string; rarity: string }): string {
  return `${definition.slot}.${definition.rarity}`;
}

/** Longest suffix accepted — a Discord select label must fit name + suffix. */
const SUFFIX_MAX_LENGTH = 60;

export const EquipmentAffixSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(EQUIPMENT_KEY_MAX_LENGTH)
      .regex(EQUIPMENT_KEY_PATTERN, 'key must be lowercase snake_case'),
    /** Complete display text, `of …` included — code never prepends anything. */
    suffix: z
      .string()
      .min(1)
      .max(SUFFIX_MAX_LENGTH)
      .refine((s) => s === s.trim(), 'must not start or end with whitespace'),
    pool: z.enum(EQUIPMENT_AFFIX_POOLS as [EquipmentAffixPool, ...EquipmentAffixPool[]], {
      errorMap: () => ({ message: `must be one of ${EQUIPMENT_AFFIX_POOLS.join(', ')}` }),
    }),
    /** False retires the affix from new rolls; owned copies keep rendering it. */
    enabled: z.boolean(),
  })
  .strict();

export type EquipmentAffix = z.infer<typeof EquipmentAffixSchema>;

export const EquipmentAffixFileSchema = z
  .object({
    format: z.literal(EQUIPMENT_AFFIX_FILE_FORMAT),
    version: z.literal(EQUIPMENT_AFFIX_FILE_VERSION),
    affixes: z.array(EquipmentAffixSchema).max(5000),
  })
  .strict()
  .superRefine((file, ctx) => {
    const keys = new Map<string, number>();
    const suffixes = new Map<string, number>();
    file.affixes.forEach((affix, i) => {
      const k = keys.get(affix.key);
      if (k !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['affixes', i, 'key'],
          message: `duplicate affix key "${affix.key}" (also affixes[${k}])`,
        });
      } else keys.set(affix.key, i);
      // Two keys rendering the same name would make different copies look identical.
      const folded = affix.suffix.toLowerCase();
      const s = suffixes.get(folded);
      if (s !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['affixes', i, 'suffix'],
          message: `duplicate suffix "${affix.suffix}" (also affixes[${s}])`,
        });
      } else suffixes.set(folded, i);
    });
  });

/** Lookup over a validated affix list. */
export interface EquipmentAffixCatalogue {
  /** Any catalogued affix, enabled or retired. Silent on a miss. */
  get(key: string): EquipmentAffix | undefined;
  /**
   * The same lookup for a key **an owned instance carries**: a miss is a
   * content error (an affix was deleted rather than retired) and is reported
   * through `onUnknownKey` before returning undefined.
   */
  resolveOwned(key: string): EquipmentAffix | undefined;
  /** Enabled affixes of one pool, in catalogue order — what a random roll may pick. */
  rollable(pool: string): readonly EquipmentAffix[];
  /**
   * Every catalogued affix, retired ones included, in catalogue order — what a
   * display-name search must know to match a suffix an owned copy renders.
   */
  all(): readonly EquipmentAffix[];
}

export interface AffixCatalogueOptions {
  /** Called when an owned instance names a key the catalogue does not know. */
  onUnknownKey?: (key: string) => void;
}

export function buildAffixCatalogue(
  affixes: readonly EquipmentAffix[],
  opts: AffixCatalogueOptions = {},
): EquipmentAffixCatalogue {
  const byKey = new Map(affixes.map((a) => [a.key, a]));
  const byPool = new Map<string, EquipmentAffix[]>();
  for (const affix of affixes) {
    if (!affix.enabled) continue;
    const list = byPool.get(affix.pool) ?? [];
    list.push(affix);
    byPool.set(affix.pool, list);
  }
  return {
    get: (key) => byKey.get(key),
    resolveOwned(key) {
      const affix = byKey.get(key);
      if (!affix) opts.onUnknownKey?.(key);
      return affix;
    },
    rollable: (pool) => byPool.get(pool) ?? [],
    all: () => affixes,
  };
}

/** No affixes: every random roll fails for want of a pool entry. */
export const EMPTY_AFFIX_CATALOGUE: EquipmentAffixCatalogue = buildAffixCatalogue([]);
