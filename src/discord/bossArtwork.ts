/**
 * Boss artwork resolution — the one place a boss's relative content path
 * becomes an absolute path on disk, and the only place that decides an
 * encounter is text-only.
 *
 * Two layers of defence, both required:
 *
 *   1. `resolveAssetPath` confines the result to `ASSETS_DIR`, so a
 *      hand-edited `artwork` cannot read outside the assets root. The content
 *      schema already rejects `..` and absolute paths; this is the check that
 *      still holds if content is edited past the schema.
 *   2. An existence probe, because the loader's own probe ran at startup and
 *      a file can disappear afterwards. Artwork that vanishes mid-window must
 *      degrade the announcement, never fail the resolution.
 *
 * Returns a spreadable object rather than a bare value so call sites read as
 * `...resolveBossArtwork(ctx, encounter)` and the "no artwork" case is simply
 * an absent key.
 */
import fs from 'node:fs';
import type { BossEncounterRow } from '../db/schema';
import { resolveAssetPath } from '../modules/content/loader';
import type { AppContext } from './types';

export interface BossArtwork {
  artworkPath?: string;
}

export function resolveBossArtwork(
  ctx: AppContext,
  encounter: BossEncounterRow,
): BossArtwork {
  // The encounter's own snapshot, not live content: an encounter announced
  // with artwork keeps rendering with it even if the boss is retired midway.
  const relative = encounter.bossArtwork;
  if (!relative) return {};
  try {
    const absolute = resolveAssetPath(ctx.config.assetsDir, relative);
    if (!fs.existsSync(absolute)) {
      ctx.logger.warn(
        { tag: 'boss/artwork-missing', encounterId: encounter.id, artwork: relative },
        'boss artwork missing at post time — rendering text-only',
      );
      return {};
    }
    return { artworkPath: absolute };
  } catch (err) {
    ctx.logger.error(
      { tag: 'boss/artwork-unsafe', encounterId: encounter.id, artwork: relative, err },
      'boss artwork path rejected — rendering text-only',
    );
    return {};
  }
}
