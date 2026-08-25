/**
 * In-process memo for artwork content hashes.
 *
 * The memo *key* uses `mtime` and `size` — cheap stat data that tells us
 * whether a re-read is worth doing. The memo *value* is always the real
 * SHA-256 of the bytes. That distinction matters: identity is never derived
 * from filesystem metadata, so two copies of the same artwork under different
 * paths, or the same file touched by a sync tool, resolve to the same hash.
 * The worst a stale stat can do is cause an unnecessary re-hash.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

interface MemoEntry {
  mtimeMs: number;
  size: number;
  hash: Promise<string>;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ArtworkHashMemo {
  private readonly entries = new Map<string, MemoEntry>();

  /**
   * SHA-256 (hex) of the file's bytes. `stat` is consulted only to decide
   * whether the memoized value can be reused.
   */
  async hashFile(absolutePath: string): Promise<string> {
    const stat = await fs.stat(absolutePath);
    const cached = this.entries.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.hash;
    }

    const hash = fs.readFile(absolutePath).then((bytes) => sha256Hex(bytes));
    hash.catch(() => this.entries.delete(absolutePath));
    this.entries.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    return hash;
  }

  /** Test/ops seam: drop everything and re-hash on next request. */
  clear(): void {
    this.entries.clear();
  }
}
