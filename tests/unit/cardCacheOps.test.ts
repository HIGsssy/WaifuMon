/**
 * `cards:warm` and `cards:gc` — the logic behind the two CLIs.
 *
 * Everything runs against a temp content dir, a temp assets root and a temp
 * cache, so no test can warm into (or collect from) the real
 * `assets/.card-cache/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  planCardWarm,
  runCardGc,
  runCardWarm,
  WARM_LEVEL,
} from '../../src/tools/cardCacheOps';
import { createCardRenderer, type CardRenderer } from '../../src/modules/cards';
import { makeTempDir } from '../helpers/cardFixtures';

let workdir: string;
let contentDir: string;
let assetsDir: string;
let cacheRoot: string;
let renderer: CardRenderer;

const SPECIES = [
  {
    slug: 'warm_one',
    name: 'Warm One',
    rarity: 'N',
    archetype: 'demi-human',
    race: 'demi-human',
    contentRating: 'suggestive',
    affinity: 'dominant',
    imagePath: 'waifumon/warm_one/standard.png',
    enabled: true,
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'level_20', name: 'Level 20', unlock: { type: 'level', atLevel: 20 } },
    ],
  },
  {
    slug: 'warm_two',
    name: 'Warm Two',
    rarity: 'SR',
    archetype: 'angel',
    contentRating: 'suggestive',
    affinity: 'caregiver',
    imagePath: 'waifumon/warm_two/standard.png',
    enabled: true,
  },
  {
    slug: 'warm_disabled',
    name: 'Warm Disabled',
    rarity: 'R',
    archetype: 'spirit',
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: 'waifumon/warm_disabled/standard.png',
    enabled: false,
  },
  {
    slug: 'warm_no_art',
    name: 'Warm No Art',
    rarity: 'R',
    archetype: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    imagePath: 'waifumon/warm_no_art/standard.png',
    enabled: true,
  },
];

const REPO_CONTENT = path.resolve(__dirname, '../../content');

async function writeArt(slug: string, variant: string, tint: number): Promise<void> {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: tint, g: 60, b: 120 } },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, `${variant}.png`), png);
}

beforeAll(async () => {
  workdir = await makeTempDir('card-ops');
  contentDir = path.join(workdir, 'content');
  assetsDir = path.join(workdir, 'assets');
  fs.mkdirSync(path.join(contentDir, 'species'), { recursive: true });

  // Only the species are fixtures. `items.json` and `tables.json` are copied
  // verbatim because `readContentFiles` validates the whole set, and
  // hand-rolling a valid tuning table here would test the fixture, not the tool.
  fs.writeFileSync(path.join(contentDir, 'species', 'test.json'), JSON.stringify(SPECIES));
  for (const file of ['items.json', 'tables.json']) {
    fs.copyFileSync(path.join(REPO_CONTENT, file), path.join(contentDir, file));
  }

  await writeArt('warm_one', 'standard', 200);
  await writeArt('warm_one', 'level_20', 40);
  await writeArt('warm_two', 'standard', 120);
  await writeArt('warm_disabled', 'standard', 80);
  // `warm_no_art` deliberately has no file at all.
});

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  cacheRoot = path.join(workdir, `cache-${Math.floor(process.hrtime()[1])}-${Date.now()}`);
  renderer = createCardRenderer({ cacheRoot });
});

function baseOptions(): { contentDir: string; assetsDir: string } {
  return { contentDir, assetsDir };
}

describe('planCardWarm', () => {
  it('plans the default appearance of every enabled species', () => {
    const plan = planCardWarm(baseOptions());
    expect(plan.inputs.map((i) => i.species.slug).sort()).toEqual(['warm_one', 'warm_two']);
    expect(plan.speciesConsidered).toBe(3);
  });

  it('skips disabled species — warming a card nobody can meet is wasted work', () => {
    const plan = planCardWarm(baseOptions());
    expect(plan.inputs.some((i) => i.species.slug === 'warm_disabled')).toBe(false);
  });

  it('includes disabled species on request', () => {
    const plan = planCardWarm({ ...baseOptions(), includeDisabled: true });
    expect(plan.inputs.some((i) => i.species.slug === 'warm_disabled')).toBe(true);
  });

  it('reports a species whose artwork does not resolve instead of planning it', () => {
    const plan = planCardWarm(baseOptions());
    expect(plan.inputs.some((i) => i.species.slug === 'warm_no_art')).toBe(false);
    expect(plan.skipped).toEqual([
      { slug: 'warm_no_art', appearanceId: 'standard', reason: 'no artwork resolved' },
    ]);
  });

  it('warms exactly one level, because level is part of the render key', () => {
    const plan = planCardWarm({ ...baseOptions(), allAppearances: true });
    expect(new Set(plan.inputs.map((i) => i.progress?.level))).toEqual(new Set([WARM_LEVEL]));
  });

  it('covers every appearance when asked', () => {
    const plan = planCardWarm({ ...baseOptions(), allAppearances: true });
    const warmOne = plan.inputs.filter((i) => i.species.slug === 'warm_one');
    expect(warmOne.map((i) => i.variant.appearanceId).sort()).toEqual(['level_20', 'standard']);
  });

  it('plans the master before any derivative of it', () => {
    const plan = planCardWarm({ ...baseOptions(), widths: [512] });
    const forWarmTwo = plan.inputs.filter((i) => i.species.slug === 'warm_two');
    expect(forWarmTwo.map((i) => i.output?.width)).toEqual([undefined, 512]);
  });
});

describe('runCardWarm', () => {
  it('renders the planned cards and writes them to the cache', async () => {
    const report = await runCardWarm({ ...baseOptions(), renderer });

    expect(report.rendered).toBe(2);
    expect(report.cached).toBe(0);
    expect(report.failed).toEqual([]);
    expect(fs.readdirSync(cacheRoot).sort()).toEqual(['warm_one', 'warm_two']);
  });

  it('is idempotent — a second run renders nothing', async () => {
    await runCardWarm({ ...baseOptions(), renderer });
    const second = await runCardWarm({ ...baseOptions(), renderer });

    expect(second.rendered).toBe(0);
    expect(second.cached).toBe(2);
  });

  it('warms derivatives without re-rasterizing the master', async () => {
    const report = await runCardWarm({ ...baseOptions(), renderer, widths: [512] });

    expect(report.rendered).toBe(4); // 2 masters + 2 derivatives
    const stats = renderer.getStats();
    expect(stats.masterRenders).toBe(2);
    expect(stats.derivativeRenders).toBe(2);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await runCardWarm({
      ...baseOptions(),
      renderer,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2]);
  });
});

describe('runCardGc', () => {
  /** A cache file with a chosen age, for a given slug. */
  function seedCacheFile(slug: string, name: string, ageDays: number): string {
    const dir = path.join(cacheRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'not really a webp');
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, when, when);
    return file;
  }

  it('is safe on an empty cache', async () => {
    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer });
    expect(result).toMatchObject({ scanned: 0, kept: 0, bytesReclaimed: 0 });
    expect(result.removed).toEqual([]);
  });

  it('removes everything under a species content no longer has', async () => {
    seedCacheFile('deleted_species', 'aaaaaaaaaaaaaaaa.webp', 0);
    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer });

    expect(result.removed.map((r) => r.reason)).toEqual(['unknown-species']);
    expect(fs.existsSync(path.join(cacheRoot, 'deleted_species'))).toBe(false);
  });

  it('keeps a recent file for a species that still exists', async () => {
    seedCacheFile('warm_one', 'bbbbbbbbbbbbbbbb.webp', 1);
    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer });

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  it('expires a stale file past the age limit', async () => {
    seedCacheFile('warm_one', 'cccccccccccccccc.webp', 90);
    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });

    expect(result.removed.map((r) => r.reason)).toEqual(['expired']);
  });

  it('keeps a warm-set card however old it is', async () => {
    // Render the real warm set, then age it well past the limit.
    await runCardWarm({ ...baseOptions(), renderer });
    for (const slug of fs.readdirSync(cacheRoot)) {
      for (const file of fs.readdirSync(path.join(cacheRoot, slug))) {
        const when = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(cacheRoot, slug, file), when, when);
      }
    }

    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });

    expect(result.removed).toEqual([]);
    expect(result.kept).toBeGreaterThan(0);
  });

  it('collects a derivative of an expired master alongside it', async () => {
    seedCacheFile('warm_one', 'dddddddddddddddd.webp', 90);
    seedCacheFile('warm_one', 'dddddddddddddddd@512.webp', 90);

    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });

    expect(result.removed.map((r) => r.file).sort()).toEqual([
      'warm_one/dddddddddddddddd.webp',
      'warm_one/dddddddddddddddd@512.webp',
    ]);
  });

  it('keeps a derivative whose master is in the warm set', async () => {
    const report = await runCardWarm({ ...baseOptions(), renderer, widths: [512] });
    expect(report.rendered).toBeGreaterThan(0);

    for (const slug of fs.readdirSync(cacheRoot)) {
      for (const file of fs.readdirSync(path.join(cacheRoot, slug))) {
        const when = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(cacheRoot, slug, file), when, when);
      }
    }

    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 1 });
    expect(result.removed).toEqual([]);
  });

  it('changes nothing on a dry run but reports the same decisions', async () => {
    const file = seedCacheFile('warm_one', 'eeeeeeeeeeeeeeee.webp', 90);

    const dry = await runCardGc({
      ...baseOptions(),
      cacheRoot,
      renderer,
      maxAgeDays: 30,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(true);

    const wet = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });
    expect(wet.removed.map((r) => r.file)).toEqual(dry.removed.map((r) => r.file));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores files that are not ours and never leaves the cache root', async () => {
    const dir = path.join(cacheRoot, 'warm_one');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.ffffffffffffffff.webp.abc.tmp');
    fs.writeFileSync(tmp, 'partial write in flight');
    const when = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    fs.utimesSync(tmp, when, when);

    // A sibling of the cache root, which a path bug could reach.
    const outsider = path.join(workdir, 'outside.webp');
    fs.writeFileSync(outsider, 'do not touch');

    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });

    expect(result.scanned).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('reports bytes reclaimed', async () => {
    const file = seedCacheFile('warm_one', 'aaaabbbbccccdddd.webp', 90);
    const size = fs.statSync(file).size;

    const result = await runCardGc({ ...baseOptions(), cacheRoot, renderer, maxAgeDays: 30 });
    expect(result.bytesReclaimed).toBe(size);
  });
});
