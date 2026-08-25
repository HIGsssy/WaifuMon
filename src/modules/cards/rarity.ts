/**
 * Rarity → the two raster assets that express it.
 *
 * A rarity owns **two** files: the ornate transparent frame the whole card is
 * built inside, and the roundel that sits in the bottom icon holder. There is
 * deliberately no aliasing — `EX` is not a recoloured `UR` — and a missing file
 * is a hard error at asset-validation time rather than a silent substitution,
 * because a card that shows the wrong rarity frame is worse than a card that
 * fails to render.
 *
 * `EX` is currently frameless: `frames/ex.png` has not been drawn yet. It stays
 * in the taxonomy and keeps its rarity icon; asking to render one raises
 * `CardAssetMissingError`. No content uses `EX` today.
 */
import { RARITIES, type Rarity } from '../../db/schema';

/** Frame filename per rarity, relative to `assets/cardart/frames/`. */
export const RARITY_FRAME_FILES: Readonly<Record<Rarity, string>> = {
  N: 'n.png',
  R: 'r.png',
  SR: 'sr.png',
  SSR: 'ssr.png',
  UR: 'ur.png',
  LR: 'lr.png',
  EX: 'ex.png',
};

/** Roundel filename per rarity, relative to `assets/cardart/icons/rarity/`. */
export const RARITY_ICON_FILES: Readonly<Record<Rarity, string>> = {
  N: 'n.png',
  R: 'r.png',
  SR: 'sr.png',
  SSR: 'ssr.png',
  UR: 'ur.png',
  LR: 'lr.png',
  EX: 'ex.png',
};

/**
 * Rarities whose frame artwork has not shipped yet. Rendering one raises
 * `CardAssetMissingError`; asset validation skips it rather than failing the
 * whole kit, so the other six rarities keep working.
 */
export const UNSUPPORTED_RARITIES: readonly Rarity[] = ['EX'];

/** Rarities the renderer can actually draw. */
export const RENDERABLE_RARITIES: readonly Rarity[] = RARITIES.filter(
  (rarity) => !UNSUPPORTED_RARITIES.includes(rarity),
);

export function isRenderableRarity(rarity: Rarity): boolean {
  return !UNSUPPORTED_RARITIES.includes(rarity);
}

/** Frame filename for a rarity, relative to `assets/cardart/frames/`. */
export function rarityFrameFile(rarity: Rarity): string {
  const file = RARITY_FRAME_FILES[rarity];
  if (!file) {
    // Unreachable for a well-typed caller; guards against a widened union or
    // an unvalidated string arriving from JSON content.
    throw new Error(`No card frame is mapped for rarity "${String(rarity)}"`);
  }
  return file;
}

/** Roundel filename for a rarity, relative to `assets/cardart/icons/rarity/`. */
export function rarityIconFile(rarity: Rarity): string {
  const file = RARITY_ICON_FILES[rarity];
  if (!file) {
    throw new Error(`No rarity icon is mapped for rarity "${String(rarity)}"`);
  }
  return file;
}

export { RARITIES, type Rarity };
