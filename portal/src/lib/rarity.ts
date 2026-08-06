/**
 * Rarity presentation vocabulary (plan §17).
 *
 * Rarity is the Portal's only accent language: glow rings on cards, border
 * accents on badges, small hues in text emphasis. Nothing else in the UI uses
 * these colours.
 *
 * The `rank` here is **presentation only** — it drives the client-side "rarest
 * first" sort on the Collection toolbar, which mirrors the order the API
 * already returns. It encodes no gameplay rule (drop weight, capture rate and
 * value all live in the game services).
 *
 * `EX` is in the game's rarity enum (`src/db/schema.ts`) but is absent from the
 * plan's colour list, so it is given its own hue rather than silently aliasing
 * another tier. Filed as a note in docs/portal.md.
 */
import type { Rarity } from '@/api/types';

export interface RarityStyle {
  /** Human label; always rendered so rarity is never colour-alone (§17). */
  readonly label: string;
  /** Sort weight, ascending — higher is rarer. Presentation only. */
  readonly rank: number;
  /** Tailwind token name, i.e. `rarity-sr` for `text-rarity-sr`. */
  readonly token: string;
  /** CSS custom property holding the colour, for inline ring/glow styles. */
  readonly cssVar: string;
  /** True for the one tier rendered as a gradient rather than a flat hue. */
  readonly iridescent: boolean;
}

export const RARITY_ORDER = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'] as const;

const STYLES: Record<Rarity, RarityStyle> = {
  N: { label: 'Common', rank: 0, token: 'rarity-n', cssVar: '--rarity-n', iridescent: false },
  R: { label: 'Rare', rank: 1, token: 'rarity-r', cssVar: '--rarity-r', iridescent: false },
  SR: {
    label: 'Super Rare',
    rank: 2,
    token: 'rarity-sr',
    cssVar: '--rarity-sr',
    iridescent: false,
  },
  SSR: {
    label: 'Super Special Rare',
    rank: 3,
    token: 'rarity-ssr',
    cssVar: '--rarity-ssr',
    iridescent: false,
  },
  UR: {
    label: 'Ultra Rare',
    rank: 4,
    token: 'rarity-ur',
    cssVar: '--rarity-ur',
    iridescent: false,
  },
  LR: {
    label: 'Legendary Rare',
    rank: 5,
    token: 'rarity-lr',
    cssVar: '--rarity-lr',
    iridescent: true,
  },
  EX: { label: 'Exotic', rank: 6, token: 'rarity-ex', cssVar: '--rarity-ex', iridescent: false },
};

const FALLBACK: RarityStyle = STYLES.N;

export function rarityStyle(rarity: string): RarityStyle {
  return STYLES[rarity as Rarity] ?? FALLBACK;
}

/** Descending rarity comparator — the Collection's default sort. */
export function byRarityDesc(a: string, b: string): number {
  return rarityStyle(b).rank - rarityStyle(a).rank;
}
