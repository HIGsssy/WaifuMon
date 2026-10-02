/**
 * Combat artwork conventions.
 *
 * Paths are authored **relative to the assets root** (`ASSETS_DIR`), exactly
 * like boss and encounter artwork — never `/assets/...` and never a URL:
 *
 *   assets/combat/enemies/<enemy_key>.webp       → "combat/enemies/<enemy_key>.webp"
 *   assets/combat/backgrounds/<scene_key>.webp   → "combat/backgrounds/<scene_key>.webp"   (reserved)
 *   assets/combat/abilities/<ability_key>.webp   → "combat/abilities/<ability_key>.webp"   (reserved)
 *
 * The player side reuses the Buddy's existing owned artwork; nothing about a
 * Buddy is ever copied under `assets/combat/`.
 *
 * Shape and containment are the shared artwork rules (`relativeArtworkPath`,
 * `locateArtworkFile`). Missing art is never an error for combat: a presenter
 * that gets `missing` or `none` renders text-only.
 */
import { locateArtworkFile, type LocatedArtwork } from '../assets/artworkFile';

export const COMBAT_ARTWORK_DIRS = {
  enemies: 'combat/enemies',
  backgrounds: 'combat/backgrounds',
  abilities: 'combat/abilities',
} as const;
export type CombatArtworkKind = keyof typeof COMBAT_ARTWORK_DIRS;

/** The conventional content path for a key, e.g. `combat/enemies/scrapyard_drone.webp`. */
export function conventionalCombatArtworkPath(kind: CombatArtworkKind, key: string): string {
  return `${COMBAT_ARTWORK_DIRS[kind]}/${key}.webp`;
}

export type CombatArtwork = LocatedArtwork | { status: 'none' };

/**
 * Where an authored combat artwork path points, or `none` when nothing is
 * authored. Never throws; `unsafe` and `missing` mean "render without art".
 */
export function locateCombatArtwork(
  assetsDir: string,
  artworkPath: string | null | undefined,
): CombatArtwork {
  if (artworkPath == null) return { status: 'none' };
  return locateArtworkFile(assetsDir, artworkPath);
}
