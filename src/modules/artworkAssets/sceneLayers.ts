/**
 * Turning an artwork reference into a {@link SceneLayer}, by the one
 * precedence every surface shares:
 *
 *     managed asset (active)  →  shipped artwork path  →  nothing
 *
 * A managed asset that is unset, disabled, deleted or whose file is gone
 * falls through to the shipped path; a shipped path that is unsafe or missing
 * falls through to nothing. Never throws.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { locateArtworkFile } from '../assets/artworkFile';
import type { ArtworkAssetService } from './artworkAssetService';
import type { SceneLayer } from './sceneComposition';

/** Either or both of a managed asset id and a shipped path. */
export interface ArtworkRef {
  assetId?: string | null | undefined;
  artworkPath?: string | null | undefined;
}

/**
 * A shipped file under `assets/` as a layer. Its hash is the path plus the
 * file's size and modification time — cheap, and it changes when a deploy
 * replaces the file.
 */
export function shippedArtworkLayer(assetsDir: string, relativePath: string | null | undefined): SceneLayer | null {
  if (!relativePath) return null;
  const located = locateArtworkFile(assetsDir, relativePath);
  if (located.status !== 'available') return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(located.absolutePath);
  } catch {
    return null;
  }
  const hash = createHash('sha256').update(`shipped:${relativePath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  return { hash, load: () => readFile(located.absolutePath).catch(() => null) };
}

export async function resolveArtworkLayer(
  deps: { assets?: Pick<ArtworkAssetService, 'layer'> | undefined; assetsDir: string },
  ref: ArtworkRef,
  options: { includeDisabled?: boolean } = {},
): Promise<SceneLayer | null> {
  const managed = await deps.assets?.layer(ref.assetId, options);
  return managed ?? shippedArtworkLayer(deps.assetsDir, ref.artworkPath);
}
