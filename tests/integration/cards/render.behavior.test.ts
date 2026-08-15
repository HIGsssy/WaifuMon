/**
 * Rendering and caching behaviour — the properties the whole design exists to
 * provide: one canonical master per card, derivatives that never re-rasterize,
 * content-addressed invalidation, atomic writes, and de-duplicated concurrent
 * renders.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CardArtworkMissingError,
  CardOutputWidthError,
  createCardRenderer,
  MASTER_HEIGHT,
  MASTER_WIDTH,
  type CardRenderer,
} from '../../../src/modules/cards';
import {
  cardInput,
  copyAssetKit,
  dimensionsOf,
  isWebp,
  listFiles,
  makeTempDir,
  writeArtwork,
} from '../../helpers/cardFixtures';

let workdir: string;
let artwork: string;
let caseIndex = 0;

beforeAll(async () => {
  workdir = await makeTempDir('cards-behavior');
  artwork = await writeArtwork(path.join(workdir, 'art', 'standard.png'), { r: 200, g: 60, b: 60 });
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

/**
 * Bumps a kit copy's VERSION relative to whatever it currently holds. Derived
 * rather than hardcoded so these tests keep testing a real bump after the
 * shipped VERSION moves on.
 */
async function bumpKitVersion(kit: string): Promise<string> {
  const versionPath = path.join(kit, 'VERSION');
  const current = (await fs.readFile(versionPath, 'utf8')).trim();
  const next = String(Number.parseInt(current, 10) + 1);
  expect(next).not.toBe(current);
  await fs.writeFile(versionPath, `${next}\n`);
  return next;
}

/** A cache root of its own per test, so no test can be fooled by a neighbour. */
let cacheRoot: string;
let renderer: CardRenderer;

beforeEach(() => {
  caseIndex += 1;
  cacheRoot = path.join(workdir, `cache-${caseIndex}`);
  renderer = createCardRenderer({ cacheRoot });
});

describe('master rendering', () => {
  it('produces a valid 1000×1400 WebP and caches exactly one file', async () => {
    const result = await renderer.renderCard(cardInput(artwork));

    expect(isWebp(result.bytes)).toBe(true);
    expect(result.contentType).toBe('image/webp');
    expect(await dimensionsOf(result.bytes)).toEqual({
      width: MASTER_WIDTH,
      height: MASTER_HEIGHT,
    });
    expect(result.fromCache).toBe(false);
    expect(await listFiles(cacheRoot)).toEqual([`alley_catgirl/${result.renderKey}.webp`]);
  });

  it('is deterministic — an identical input renders identical bytes', async () => {
    const other = createCardRenderer({ cacheRoot: path.join(workdir, `cache-${caseIndex}-b`) });
    const [first, second] = await Promise.all([
      renderer.renderCard(cardInput(artwork)),
      other.renderCard(cardInput(artwork)),
    ]);
    expect(first!.renderKey).toBe(second!.renderKey);
    expect(first!.bytes.equals(second!.bytes)).toBe(true);
  });

  it('serves the second identical request from disk without re-rendering', async () => {
    const first = await renderer.renderCard(cardInput(artwork));
    const second = await renderer.renderCard(cardInput(artwork));

    expect(second.fromCache).toBe(true);
    expect(second.renderKey).toBe(first.renderKey);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(renderer.getStats()).toMatchObject({ masterRenders: 1, cacheHits: 1 });
  });

  it('exposes a strong ETag built from the render key', async () => {
    const result = await renderer.renderCard(cardInput(artwork));
    expect(result.etag).toBe(`"${result.renderKey}"`);
  });
});

describe('derived widths', () => {
  it('resizes from the master instead of re-running the rasterizer', async () => {
    const master = await renderer.renderCard(cardInput(artwork));
    expect(renderer.getStats().masterRenders).toBe(1);

    const small = await renderer.renderCard(cardInput(artwork, { width: 512 }));

    expect(renderer.getStats()).toMatchObject({ masterRenders: 1, derivativeRenders: 1 });
    expect(small.renderKey).toBe(master.renderKey);
    expect(small.width).toBe(512);
    expect(await dimensionsOf(small.bytes)).toEqual({ width: 512, height: 717 });
    expect(isWebp(small.bytes)).toBe(true);
  });

  it('creates the master on demand when a derivative is the first request', async () => {
    const small = await renderer.renderCard(cardInput(artwork, { width: 256 }));
    expect(renderer.getStats()).toMatchObject({ masterRenders: 1, derivativeRenders: 1 });
    expect(await listFiles(cacheRoot)).toEqual([
      `alley_catgirl/${small.renderKey}.webp`,
      `alley_catgirl/${small.renderKey}@256.webp`,
    ]);
  });

  it('keeps one master across every display bucket', async () => {
    const keys: string[] = [];
    for (const width of [256, 512, 1024]) {
      const result = await renderer.renderCard(cardInput(artwork, { width }));
      keys.push(result.renderKey);
      expect(result.width).toBe(width);
    }
    const masterKey = await renderer.computeMasterRenderKey(cardInput(artwork));

    expect(new Set(keys)).toEqual(new Set([masterKey]));
    expect(renderer.getStats()).toMatchObject({ masterRenders: 1, derivativeRenders: 3 });
    const files = await listFiles(cacheRoot);
    expect(files.filter((f) => !f.includes('@'))).toEqual([`alley_catgirl/${masterKey}.webp`]);
  });

  it('serves a cached derivative without touching the master', async () => {
    await renderer.renderCard(cardInput(artwork, { width: 512 }));
    const fresh = createCardRenderer({ cacheRoot });
    const cached = await fresh.renderCard(cardInput(artwork, { width: 512 }));

    expect(cached.fromCache).toBe(true);
    expect(fresh.getStats()).toMatchObject({ masterRenders: 0, derivativeRenders: 0, cacheHits: 1 });
    expect(cached.etag).toBe(`"${cached.renderKey}@512"`);
  });

  it('rejects a width outside the supported range', async () => {
    await expect(renderer.renderCard(cardInput(artwork, { width: 0 }))).rejects.toBeInstanceOf(
      CardOutputWidthError,
    );
    await expect(renderer.renderCard(cardInput(artwork, { width: 99_999 }))).rejects.toBeInstanceOf(
      CardOutputWidthError,
    );
  });
});

describe('invalidation', () => {
  it('renders a new master when the artwork bytes change', async () => {
    const mutable = await writeArtwork(path.join(workdir, `mutating-${caseIndex}.png`), {
      r: 10,
      g: 10,
      b: 10,
    });
    const before = await renderer.renderCard(cardInput(mutable));

    await writeArtwork(mutable, { r: 250, g: 250, b: 250 });
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(mutable, future, future);

    const after = await renderer.renderCard(cardInput(mutable));

    expect(after.renderKey).not.toBe(before.renderKey);
    expect(after.fromCache).toBe(false);
    expect(after.bytes.equals(before.bytes)).toBe(false);
    expect(await listFiles(cacheRoot)).toHaveLength(2);
  });

  it('renders a new master when the kit VERSION is bumped', async () => {
    const kit = await copyAssetKit(path.join(workdir, `kit-${caseIndex}`));
    const scoped = { assetRoot: kit, cacheRoot };

    const before = await createCardRenderer(scoped).renderCard(cardInput(artwork));
    await bumpKitVersion(kit);
    const after = await createCardRenderer(scoped).renderCard(cardInput(artwork));

    expect(after.renderKey).not.toBe(before.renderKey);
    expect(after.fromCache).toBe(false);
    expect(await listFiles(cacheRoot)).toHaveLength(2);
  });

  it('renders a new master when a kit asset itself changes', async () => {
    const kit = await copyAssetKit(path.join(workdir, `kit-asset-${caseIndex}`));
    const scoped = { assetRoot: kit, cacheRoot };
    const overlay = path.join(kit, 'rarities', 'ssr.svg');

    const before = await createCardRenderer(scoped).renderCard(cardInput(artwork));

    const svg = await fs.readFile(overlay, 'utf8');
    await fs.writeFile(overlay, svg.replace('</svg>', '<circle cx="500" cy="700" r="200" fill="#0f0"/></svg>'));
    // Asset edits are only picked up through a VERSION bump — that is the whole
    // point of VERSION, and this asserts the documented workflow works.
    await bumpKitVersion(kit);

    const after = await createCardRenderer(scoped).renderCard(cardInput(artwork));
    expect(after.renderKey).not.toBe(before.renderKey);
    expect(after.bytes.equals(before.bytes)).toBe(false);
  });
});

describe('missing artwork', () => {
  it('raises a typed error rather than substituting other art', async () => {
    const missing = path.join(workdir, 'does-not-exist.png');
    const promise = renderer.renderCard(cardInput(missing));

    await expect(promise).rejects.toBeInstanceOf(CardArtworkMissingError);
    await expect(promise).rejects.toMatchObject({
      code: 'CARD_ARTWORK_MISSING',
      artworkPath: missing,
    });
  });

  it('writes nothing to the cache when artwork is missing', async () => {
    await renderer
      .renderCard(cardInput(path.join(workdir, 'also-missing.png')))
      .catch(() => undefined);
    expect(await listFiles(cacheRoot)).toEqual([]);
  });
});

describe('concurrency and write failures', () => {
  it('de-duplicates concurrent identical renders down to a single master', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => renderer.renderCard(cardInput(artwork))),
    );

    const stats = renderer.getStats();
    expect(stats.masterRenders).toBe(1);
    expect(stats.dedupedRenders).toBeGreaterThanOrEqual(1);

    const first = results[0]!;
    for (const result of results) {
      expect(result.renderKey).toBe(first.renderKey);
      expect(result.bytes.equals(first.bytes)).toBe(true);
    }
    expect(await listFiles(cacheRoot)).toEqual([`alley_catgirl/${first.renderKey}.webp`]);
  });

  it('de-duplicates concurrent identical derivative renders too', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => renderer.renderCard(cardInput(artwork, { width: 512 }))),
    );
    expect(renderer.getStats()).toMatchObject({ masterRenders: 1, derivativeRenders: 1 });
    expect(new Set(results.map((r) => r.bytes.length)).size).toBe(1);
  });

  it('still serves bytes, and leaves no partial artifacts, when the cache write fails', async () => {
    const key = await renderer.computeMasterRenderKey(cardInput(artwork));
    // Occupy the master's path with a non-empty directory so the atomic rename
    // cannot land — the same shape of failure as a full or read-only disk.
    const blocked = path.join(cacheRoot, 'alley_catgirl', `${key}.webp`);
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, 'occupied'), 'in the way');

    const result = await renderer.renderCard(cardInput(artwork));

    expect(isWebp(result.bytes)).toBe(true);
    expect(result.fromCache).toBe(false);
    const files = await listFiles(cacheRoot);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toEqual([`alley_catgirl/${key}.webp/occupied`]);
  });
});
