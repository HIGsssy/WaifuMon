/**
 * Content-addressed disk cache for rendered cards.
 *
 * ```
 * assets/.card-cache/<slug>/<renderKey>.webp        master, always 1000×1400
 * assets/.card-cache/<slug>/<renderKey>@512.webp    derivative, resized from the master
 * ```
 *
 * Two deliberate behaviours:
 *
 * - **Writes are atomic.** A temp file in the *same* directory (so `rename` is
 *   a same-filesystem move) is renamed into place. A reader can therefore only
 *   ever see a complete file, never a half-written one.
 * - **A write failure is not a render failure.** If the cache directory is
 *   read-only or full, the caller still gets its bytes; only the next request
 *   pays to render again. Any temp file is cleaned up on the way out.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../../../shared/logger';

export class CardDiskCache {
  readonly root: string;
  private readonly logger: Logger | undefined;

  constructor(root: string, logger?: Logger) {
    this.root = root;
    this.logger = logger;
  }

  masterPath(slug: string, renderKey: string): string {
    return path.join(this.root, slug, `${renderKey}.webp`);
  }

  derivativePath(slug: string, renderKey: string, width: number): string {
    return path.join(this.root, slug, `${renderKey}@${width}.webp`);
  }

  /** Bytes if present, `null` on any miss. Never throws for a missing file. */
  async read(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Writes `bytes` to `filePath` atomically. Returns whether the file landed;
   * failures are logged, never thrown, and never leave a `.tmp` behind.
   */
  async write(filePath: string, bytes: Buffer): Promise<boolean> {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, bytes);
      await fs.rename(tmpPath, filePath);
      return true;
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      this.logger?.warn(
        { tag: 'card-renderer/cache-write-failed', filePath, err },
        'Card cache write failed; serving rendered bytes without caching',
      );
      return false;
    }
  }
}

/**
 * Collapses concurrent identical work onto one in-flight promise, so N
 * simultaneous requests for the same uncached card cause exactly one render.
 * Entries are dropped as soon as they settle — this is a de-duplicator, not a
 * memory cache; the bytes live on disk.
 */
export class InFlightMap<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /** Number of callers that joined an existing render instead of starting one. */
  joined = 0;

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.joined += 1;
      return existing;
    }
    const pending = work().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
