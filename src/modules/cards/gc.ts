/**
 * Card cache garbage collection.
 *
 * ## Why this cannot be an exact sweep
 *
 * The obvious design — compute every currently-valid render key and delete
 * everything else — does not work here, because **level is part of the render
 * key**. A card for a level-37 copy is as legitimate as one for level 1, and
 * enumerating every species × appearance × level would be both enormous and
 * pointless. So an "exact" GC would delete real, correct cache entries the
 * moment a player levelled anything up.
 *
 * ## What this does instead
 *
 * Two rules, in order:
 *
 *   1. **Unknown slug directories are orphaned outright.** A directory for a
 *      species that no longer exists in content can never be requested again,
 *      whatever is in it and however new it is.
 *   2. **Everything else expires by age**, except keys the caller marks as
 *      currently valid (the warm set), which are kept regardless — deleting
 *      those would just force the next warm run to redo the work.
 *
 * Age is the honest signal: a cache entry nothing has requested in a month is
 * a stale render (old artwork, old kit VERSION, a level nobody is at any more),
 * and re-rendering it on the next request costs one card.
 *
 * The alternative — tracking every render in a database — is exactly the
 * "elaborate cache database" this is meant to avoid. The disk is the index.
 *
 * ## Safety
 *
 * Nothing outside the cache root is ever touched, only `.webp` files are
 * considered, and `dryRun` reports the identical decisions without unlinking.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CACHE_ROOT } from './paths';
import type { Logger } from '../../shared/logger';

/** Entries untouched for this long are collectable. Conservative on purpose. */
export const DEFAULT_MAX_AGE_DAYS = 30;

export interface CardCacheGcOptions {
  cacheRoot?: string | undefined;
  /**
   * Render keys to keep no matter how old — normally the warm set. Derivatives
   * (`<key>@512.webp`) are kept alongside their master.
   */
  keepRenderKeys?: Iterable<string> | undefined;
  /** Species slugs that still exist. Directories outside this set are orphaned. */
  knownSlugs?: Iterable<string> | undefined;
  maxAgeDays?: number | undefined;
  /** Report what would be removed, change nothing. */
  dryRun?: boolean | undefined;
  logger?: Logger | undefined;
  /** Injectable clock so age logic is testable without waiting a month. */
  now?: Date | undefined;
}

export type CardCacheGcReason = 'unknown-species' | 'expired';

export interface CardCacheGcRemoval {
  /** Path relative to the cache root — absolute paths never leave this module. */
  file: string;
  reason: CardCacheGcReason;
  bytes: number;
}

export interface CardCacheGcResult {
  scanned: number;
  kept: number;
  removed: CardCacheGcRemoval[];
  bytesReclaimed: number;
  dryRun: boolean;
}

/** `<key>.webp` and `<key>@512.webp` both belong to master `<key>`. */
export function renderKeyOfCacheFile(fileName: string): string | null {
  const match = /^([0-9a-f]+)(?:@\d+)?\.webp$/.exec(fileName);
  return match?.[1] ?? null;
}

export async function collectCardCacheGarbage(
  options: CardCacheGcOptions = {},
): Promise<CardCacheGcResult> {
  const root = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const keep = new Set(options.keepRenderKeys ?? []);
  const knownSlugs = options.knownSlugs ? new Set(options.knownSlugs) : null;
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const now = (options.now ?? new Date()).getTime();
  const dryRun = options.dryRun === true;

  const result: CardCacheGcResult = {
    scanned: 0,
    kept: 0,
    removed: [],
    bytesReclaimed: 0,
    dryRun,
  };

  const slugDirs = await readDirNames(root);
  for (const slug of slugDirs) {
    const slugDir = path.join(root, slug);
    const unknownSpecies = knownSlugs !== null && !knownSlugs.has(slug);

    for (const fileName of await readFileNames(slugDir)) {
      // Only our own artifacts. A stray `.tmp` from an interrupted write is
      // left alone rather than raced against a live render.
      if (!fileName.endsWith('.webp')) continue;
      result.scanned += 1;

      const relative = `${slug}/${fileName}`;
      const absolute = path.join(slugDir, fileName);
      const stat = await statOrNull(absolute);
      if (!stat) continue;

      const reason = collectableReason({
        unknownSpecies,
        renderKey: renderKeyOfCacheFile(fileName),
        keep,
        ageMs: now - stat.mtimeMs,
        maxAgeMs,
      });

      if (reason === null) {
        result.kept += 1;
        continue;
      }

      if (!dryRun) {
        try {
          await fs.rm(absolute, { force: true });
        } catch (err) {
          options.logger?.warn(
            { tag: 'card-renderer/gc-remove-failed', file: relative, err },
            'could not remove card cache file',
          );
          result.kept += 1;
          continue;
        }
      }

      result.removed.push({ file: relative, reason, bytes: stat.size });
      result.bytesReclaimed += stat.size;
    }

    if (!dryRun) await removeIfEmpty(slugDir);
  }

  options.logger?.info(
    {
      tag: 'card-renderer/gc',
      scanned: result.scanned,
      kept: result.kept,
      removed: result.removed.length,
      bytesReclaimed: result.bytesReclaimed,
      dryRun,
    },
    'card cache gc complete',
  );

  return result;
}

function collectableReason(args: {
  unknownSpecies: boolean;
  renderKey: string | null;
  keep: Set<string>;
  ageMs: number;
  maxAgeMs: number;
}): CardCacheGcReason | null {
  if (args.unknownSpecies) return 'unknown-species';
  // A key in the warm set is current by definition, whatever its mtime says.
  if (args.renderKey !== null && args.keep.has(args.renderKey)) return null;
  return args.ageMs > args.maxAgeMs ? 'expired' : null;
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readFileNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function statOrNull(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.stat(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** Tidies a slug directory the sweep emptied. Never removes the cache root. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) await fs.rmdir(dir);
  } catch {
    // Racing a concurrent render is fine — leaving the directory costs nothing.
  }
}
