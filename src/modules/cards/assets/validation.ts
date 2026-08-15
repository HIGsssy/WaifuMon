/**
 * Boot-time asset validation.
 *
 * The renderer refuses to start on an incomplete kit rather than degrading:
 * a missing `ex.svg` must be a loud failure, not a silent `ur.svg`
 * substitution, because a card that advertises the wrong rarity is a worse
 * outcome than a card that fails to render.
 */
import fs from 'node:fs/promises';
import { CardAssetMissingError } from '../errors';
import type { CardAssetLoader } from './loader';

/**
 * Checks every required file exists and is readable. Throws on the first
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
}
