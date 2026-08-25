/**
 * Boot-time asset validation.
 *
 * The renderer refuses to start on an incomplete kit rather than degrading: a
 * missing frame must be a loud failure, not a silent substitution from another
 * rarity, because a card that advertises the wrong rarity is a worse outcome
 * than a card that fails to render.
 *
 * The one deliberate exception is a rarity with no frame artwork at all
 * (currently `EX`). That is a known gap, not a broken install, so it is
 * excluded from the required set and fails at render time instead — see
 * `rarity.ts`.
 */
import fs from 'node:fs/promises';
import { CardAssetMissingError } from '../errors';
import { RENDERABLE_RARITIES } from '../rarity';
import type { CardAssetLoader } from './loader';

/**
 * Checks every required file exists and is readable, then that the generated
 * geometry manifest actually covers the frames we ship. Throws on the first
 * problem — a broken install is fixed by looking at one path, not a list.
 */
export async function validateCardAssets(loader: CardAssetLoader): Promise<void> {
  for (const { relative, what } of loader.requiredFiles()) {
    const absolute = loader.resolve(relative);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size === 0) {
        throw new CardAssetMissingError(absolute, `${what} (empty or not a file)`);
      }
    } catch (err) {
      if (err instanceof CardAssetMissingError) throw err;
      throw new CardAssetMissingError(absolute, what);
    }
  }

  // Parses, checks the schema version, and checks the manifest was generated
  // for this renderer's canvas. A stale geometry.json places every element at
  // plausible-but-wrong coordinates, so it has to fail here.
  const geometry = await loader.geometry();

  for (const rarity of RENDERABLE_RARITIES) {
    if (!geometry.frames[rarity]) {
      throw new CardAssetMissingError(
        loader.framePath(rarity),
        `frame geometry for rarity ${rarity} (re-run "npm run cards:geometry")`,
      );
    }
  }
}
