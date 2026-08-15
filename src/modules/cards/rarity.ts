/**
 * Rarity → overlay file. Every one of the seven game rarities owns its own
 * overlay SVG; there is deliberately no aliasing (`EX` is not a recoloured
 * `UR`). A missing file is a hard error at asset-validation time rather than a
 * silent substitution, because a card that shows the wrong rarity frame is
 * worse than a card that fails to render.
 */
import { RARITIES, type Rarity } from '../../db/schema';

export const RARITY_OVERLAY_FILES: Readonly<Record<Rarity, string>> = {
  N: 'normal.svg',
  R: 'rare.svg',
  SR: 'sr.svg',
  SSR: 'ssr.svg',
  UR: 'ur.svg',
  LR: 'lr.svg',
  EX: 'ex.svg',
};

/** Overlay filename for a rarity, relative to `assets/cardart/rarities/`. */
export function rarityOverlayFile(rarity: Rarity): string {
  const file = RARITY_OVERLAY_FILES[rarity];
  if (!file) {
    // Unreachable for a well-typed caller; guards against a widened union or
    // an unvalidated string arriving from JSON content.
    throw new Error(`No card overlay is mapped for rarity "${String(rarity)}"`);
  }
  return file;
}

export { RARITIES, type Rarity };
