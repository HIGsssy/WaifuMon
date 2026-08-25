/**
 * Owned-card warming, against the real renderer and a real cache directory.
 *
 * The unit suite proves *which* cards get planned; this one proves the files
 * actually land, that the master is drawn once for all three of them, and that
 * `@1024` — the hero bucket — is never written by a grid warm. Those are
 * statements about bytes on disk, so nothing here is stubbed.
 *
 * `workers: 0` renders in-process: identical output, no threads to start and
 * tear down for a suite whose subject is the cache rather than the pool.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OwnedCardWarmer,
  warmOwnedCards,
  type OwnedCardWarmSubject,
} from '../../../src/modules/appearance/ownedCardWarm';
import {
  ownedCardRequest,
  type CardPresentationDeps,
} from '../../../src/modules/appearance/cardPresentation';
import { createAppearanceService } from '../../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema } from '../../../src/modules/content/schemas';
import { createCardRenderer, type CardRenderer } from '../../../src/modules/cards';
import { listFiles, makeTempDir, writeArtwork } from '../../helpers/cardFixtures';

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'warm_owned',
    name: 'Warm Owned',
    rarity: 'SR',
    archetype: 'demon',
    race: 'demon',
    contentRating: 'suggestive',
    affinity: 'primal',
    description: 'She is warmed, and she is owned.',
    imagePath: 'waifumon/warm_owned/standard.png',
    appearances: [
      { id: 'standard', name: 'Standard', unlock: { type: 'owned' } },
      { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
    ],
  },
]);

let workdir: string;
let assetsDir: string;
let cacheRoot: string;
let renderer: CardRenderer;
let deps: CardPresentationDeps;

function copy(id: number, level: number, variant: string | null): OwnedCardWarmSubject {
  return { waifu: { id, level, variant }, species: { slug: 'warm_owned' } };
}

/** Cache filenames for one species, e.g. `<key>.webp`, `<key>@256.webp`. */
async function cacheFiles(): Promise<string[]> {
  return listFiles(path.join(cacheRoot, 'warm_owned'));
}

/** The `@<width>` suffixes present in the cache, master reported as `master`. */
async function cachedWidths(): Promise<string[]> {
  const files = await cacheFiles();
  return files
    .map((file) => /@(\d+)\.webp$/.exec(file)?.[1] ?? 'master')
    .sort();
}

beforeAll(async () => {
  workdir = await makeTempDir('cards-owned-warm');
  assetsDir = path.join(workdir, 'assets');
  cacheRoot = path.join(workdir, 'cache');

  await writeArtwork(path.join(assetsDir, 'waifumon', 'warm_owned', 'standard.png'), {
    r: 30,
    g: 90,
    b: 140,
  });
  await writeArtwork(path.join(assetsDir, 'waifumon', 'warm_owned', 'level_20.png'), {
    r: 140,
    g: 30,
    b: 90,
  });

  const content = { items: [], species: SPECIES, tables: {} } as never;
  const appearance = createAppearanceService({ db: null as never, getContent: () => content });
  deps = { appearance, assetsDir };
});

afterAll(async () => {
  await renderer?.shutdown();
  await fs.rm(workdir, { recursive: true, force: true });
});

beforeEach(async () => {
  await renderer?.shutdown();
  await fs.rm(cacheRoot, { recursive: true, force: true });
  renderer = createCardRenderer({ cacheRoot, workers: 0 });
});

describe('warmOwnedCards, on a cold cache', () => {
  it('writes the master and both grid derivatives, and nothing else', async () => {
    const result = await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });

    expect(result.mastersRendered).toBe(1);
    expect(result.derivativesCreated).toBe(2);
    expect(await cachedWidths()).toEqual(['256', '512', 'master']);
  });

  it('does not produce @1024 — a grid tile never asks for the hero bucket', async () => {
    await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });
    expect(await cachedWidths()).not.toContain('1024');
  });

  /**
   * The whole point of ordering the master first: three cards, one resvg pass.
   * A plan that warmed the derivatives independently would rasterize per width.
   */
  it('rasterizes exactly once for the three files it produces', async () => {
    await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });

    const stats = renderer.getStats();
    expect(stats.masterRenders).toBe(1);
    expect(stats.derivativeRenders).toBe(2);
  });

  it('warms the appearance she is wearing, keyed apart from her other look', async () => {
    await warmOwnedCards(deps, [copy(1, 25, 'level_20')], { renderer });
    const wearingLevel20 = await cacheFiles();

    await warmOwnedCards(deps, [copy(1, 25, 'standard')], { renderer });
    const both = await cacheFiles();

    // Two distinct masters plus their derivatives: six files, not three.
    expect(both).toHaveLength(6);
    expect(both).toEqual(expect.arrayContaining(wearingLevel20));
  });
});

describe('warmOwnedCards, on a warm cache', () => {
  it('renders nothing the second time and reports every card as cached', async () => {
    await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });
    const before = renderer.getStats();

    const second = await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });

    expect(second.mastersCached).toBe(1);
    expect(second.derivativesCached).toBe(2);
    expect(second.mastersRendered + second.derivativesCreated).toBe(0);
    expect(renderer.getStats().masterRenders).toBe(before.masterRenders);
    expect(renderer.getStats().derivativeRenders).toBe(before.derivativeRenders);
  });

  /**
   * A probe is a `stat`, not a read. `cacheHits` counts responses served from
   * disk, so an all-cached warm leaving it untouched is the evidence that the
   * warm never read a single cached card back into memory.
   */
  it('probes rather than reading the cached bytes back', async () => {
    await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });
    const before = renderer.getStats().cacheHits;

    await warmOwnedCards(deps, [copy(1, 12, 'standard')], { renderer });

    expect(renderer.getStats().cacheHits).toBe(before);
  });

  it('creates only the missing derivative when the master is already there', async () => {
    // Exactly the post-capture situation: the 1024 render left a master behind.
    await renderer.renderCard(ownedCardRequest(deps, copy(1, 12, 'standard'), { width: 1024 }).input);
    const beforeMasters = renderer.getStats().masterRenders;

    const result = await warmOwnedCards(deps, [copy(1, 12, 'standard')], {
      renderer,
      includeMaster: false,
    });

    expect(result.derivativesCreated).toBe(2);
    expect(renderer.getStats().masterRenders).toBe(beforeMasters);
    expect(await cachedWidths()).toEqual(['1024', '256', '512', 'master']);
  });
});

describe('failure isolation', () => {
  it('warms the healthy copies and reports the broken one', async () => {
    const result = await warmOwnedCards(
      deps,
      [
        { waifu: { id: 1, level: 3, variant: null }, species: { slug: 'departed_species' } },
        copy(2, 12, 'standard'),
      ],
      { renderer },
    );

    expect(result.ownedConsidered).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.slug).toBe('departed_species');
    expect(result.mastersRendered).toBe(1);
    expect(result.derivativesCreated).toBe(2);
    expect(await cachedWidths()).toEqual(['256', '512', 'master']);
  });
});

describe('OwnedCardWarmer, against the real renderer', () => {
  it('warms a player’s collection in the background and settles', async () => {
    const warmer = new OwnedCardWarmer({
      presentation: deps,
      listSubjects: async () => [copy(1, 12, 'standard'), copy(2, 25, 'level_20')],
      renderer,
    });

    expect(warmer.schedulePlayerWarm(1)).toBe('started');
    await warmer.whenIdle();

    // Two copies, two distinct looks: two masters and four derivatives.
    expect(await cacheFiles()).toHaveLength(6);
    expect(renderer.getStats().masterRenders).toBe(2);
  });
});
