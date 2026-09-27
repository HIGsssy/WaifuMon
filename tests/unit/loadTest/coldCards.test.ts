/**
 * Cold-card planning and eviction.
 *
 * Pinned:
 *   - the plan contains only keys whose master is absent, highest levels
 *     first, interleaved across species, capped at the requested count;
 *   - eviction removes exactly the planned keys' master and derivatives and
 *     leaves every other file in the cache — including other keys in the same
 *     species directory;
 *   - names that could escape the cache root are ignored, never deleted.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evictColdCards, planColdCards } from '../../../src/modules/loadTest/coldCards';
import type { CardRenderInput } from '../../../src/modules/cards';

/** A render input distinguishable by slug and level — all the planner reads. */
function input(slug: string, level: number): CardRenderInput {
  return { species: { slug }, progress: { level } } as unknown as CardRenderInput;
}

describe('planColdCards', () => {
  it('keeps only uncached masters, highest level first, interleaved, capped', async () => {
    const cached = new Set(['alpha:50', 'beta:49']);
    const renderer = {
      isCached: async (i: CardRenderInput) => cached.has(`${i.species.slug}:${i.progress?.level}`),
      computeMasterRenderKey: async (i: CardRenderInput) =>
        `${i.species.slug === 'alpha' ? 'aa' : 'bb'}${String(i.progress?.level).padStart(6, '0')}`,
    };
    const planned = await planColdCards(
      {
        renderer,
        maxLevel: 50,
        inputFor: (slug, level) => (slug === 'missing' ? null : input(slug, level)),
      },
      ['alpha', 'beta', 'missing', '../evil'],
      3,
    );
    expect(planned).toEqual([
      { slug: 'beta', level: 50, renderKey: 'bb000050' },
      { slug: 'alpha', level: 49, renderKey: 'aa000049' },
      { slug: 'alpha', level: 48, renderKey: 'aa000048' },
    ]);
  });

  it('returns nothing when asked for nothing, or when everything is cached', async () => {
    const renderer = { isCached: async () => true, computeMasterRenderKey: async () => 'x' };
    const deps = { renderer, maxLevel: 5, inputFor: input };
    expect(await planColdCards(deps, ['a'], 0)).toEqual([]);
    expect(await planColdCards(deps, ['a', 'b'], 10)).toEqual([]);
  });
});

describe('evictColdCards', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function touch(rel: string): Promise<void> {
    const file = path.join(root!, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'x');
  }

  async function listAll(): Promise<string[]> {
    const out: string[] = [];
    for (const dir of await fs.readdir(root!)) {
      const full = path.join(root!, dir);
      if ((await fs.stat(full)).isDirectory()) {
        for (const f of await fs.readdir(full)) out.push(`${dir}/${f}`);
      } else out.push(dir);
    }
    return out.sort();
  }

  it('removes exactly the planned keys and their derivatives', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-cold-'));
    await touch('alpha/aaaa0001.webp');
    await touch('alpha/aaaa0001@512.webp');
    await touch('alpha/aaaa0001@256.webp');
    await touch('alpha/bbbb0002.webp'); // a real player's card — must survive
    await touch('alpha/bbbb0002@512.webp');
    await touch('beta/cccc0003.webp');
    await touch('beta/notes.txt');

    const removed = await evictColdCards(root, [
      { slug: 'alpha', level: 50, renderKey: 'aaaa0001' },
      { slug: 'beta', level: 50, renderKey: 'dddd0004' }, // planned, never rendered
    ]);
    expect(removed).toBe(3);
    expect(await listAll()).toEqual([
      'alpha/bbbb0002.webp',
      'alpha/bbbb0002@512.webp',
      'beta/cccc0003.webp',
      'beta/notes.txt',
    ]);
  });

  it('ignores names that could escape the cache root', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-cold-'));
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.webp`);
    await fs.writeFile(outside, 'x');
    try {
      const removed = await evictColdCards(root, [
        { slug: '..', level: 1, renderKey: 'aaaa0001' },
        { slug: 'alpha', level: 1, renderKey: '../../etc' },
        { slug: `../${path.basename(root)}-outside`, level: 1, renderKey: 'aaaa0001' },
      ]);
      expect(removed).toBe(0);
      await expect(fs.stat(outside)).resolves.toBeTruthy();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
