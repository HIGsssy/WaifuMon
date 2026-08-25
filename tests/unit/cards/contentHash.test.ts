/**
 * Artwork hashing. The whole cache rests on one property: identical bytes are
 * the same card, and nothing else about the file — where it lives, when it was
 * touched, how big the OS says it is — participates in that judgement.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CardArtworkMissingError, hashArtwork } from '../../../src/modules/cards';
import { ArtworkHashMemo } from '../../../src/modules/cards/cache/hashMemo';

let dir: string;

const BYTES_A = Buffer.from('the same artwork bytes, twice over');
const BYTES_B = Buffer.from('the same artwork bytes, twice ovef');

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-card-hash-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return p;
}

describe('hashArtwork', () => {
  it('is the SHA-256 of the file contents', async () => {
    const file = await write('plain.bin', BYTES_A);
    const expected = createHash('sha256').update(BYTES_A).digest('hex');
    await expect(hashArtwork(file)).resolves.toBe(expected);
    expect(expected).toHaveLength(64);
  });

  it('is independent of the absolute path', async () => {
    const nested = path.join(dir, 'nested', 'deeper');
    await fs.mkdir(nested, { recursive: true });
    const a = await write('here.bin', BYTES_A);
    const b = path.join(nested, 'there.bin');
    await fs.writeFile(b, BYTES_A);

    expect(a).not.toBe(b);
    await expect(hashArtwork(b)).resolves.toBe(await hashArtwork(a));
  });

  it('is independent of mtime — including through the memo', async () => {
    const file = await write('touched.bin', BYTES_A);
    const memo = new ArtworkHashMemo();
    const before = await hashArtwork(file, { memo });

    const future = new Date(Date.now() + 60_000);
    await fs.utimes(file, future, future);

    // Same memo instance: the stat changed, so it re-reads — and gets the same
    // answer, because the answer never depended on the stat.
    await expect(hashArtwork(file, { memo })).resolves.toBe(before);
    await expect(hashArtwork(file, { memo: new ArtworkHashMemo() })).resolves.toBe(before);
  });

  it('changes when the bytes change, even at identical size', async () => {
    const file = await write('mutating.bin', BYTES_A);
    const memo = new ArtworkHashMemo();
    const before = await hashArtwork(file, { memo });

    expect(BYTES_B).toHaveLength(BYTES_A.length);
    await fs.writeFile(file, BYTES_B);
    // Force the memo to notice a same-size rewrite that landed within mtime
    // resolution; the memo is an optimisation, never the identity.
    memo.clear();

    await expect(hashArtwork(file, { memo })).resolves.not.toBe(before);
  });

  it('memoizes repeat calls to the same unchanged file', async () => {
    const file = await write('stable.bin', BYTES_A);
    const memo = new ArtworkHashMemo();
    const [first, second] = await Promise.all([
      hashArtwork(file, { memo }),
      hashArtwork(file, { memo }),
    ]);
    expect(first).toBe(second);
    await expect(hashArtwork(file, { memo })).resolves.toBe(first);
  });

  it('raises a typed error for missing artwork rather than substituting any', async () => {
    const missing = path.join(dir, 'not-here.png');
    await expect(hashArtwork(missing, { speciesSlug: 'x', appearanceId: 'standard' })).rejects
      .toBeInstanceOf(CardArtworkMissingError);
    await expect(hashArtwork(missing)).rejects.toMatchObject({
      code: 'CARD_ARTWORK_MISSING',
      artworkPath: missing,
    });
  });
});
