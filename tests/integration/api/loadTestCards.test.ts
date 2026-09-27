/**
 * Cold card rendering, end to end through the real renderer and the real
 * species card route.
 *
 * Pinned:
 *   - the planner's render key is exactly the key the route renders (the
 *     route's ETag carries it), so a planned card is the card requested;
 *   - an already-cached master is never planned — so nothing the cache held
 *     before a run is ever in the eviction list;
 *   - every planned request is a genuine master render (no cache hits);
 *   - eviction restores the cache to its pre-run state — the pre-existing
 *     card survives, the run's cards are gone — so the next run is cold again.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { createCardRenderer, type CardRenderer } from '../../../src/modules/cards';
import { createAppearanceService } from '../../../src/modules/appearance/appearanceService';
import { SpeciesFileSchema, type LoadedContent } from '../../../src/modules/content/schemas';
import type { AppServices } from '../../../src/discord/types';
import { evictColdCards, planColdCards } from '../../../src/modules/loadTest/coldCards';
import { GRID_CARD_WIDTH } from '../../../src/modules/loadTest/profiles';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { makeTempDir } from '../../helpers/cardFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const SPECIES = SpeciesFileSchema.parse([
  {
    slug: 'cold_a',
    name: 'Cold A',
    rarity: 'N',
    archetype: 'demi-human',
    race: 'demi-human',
    contentRating: 'suggestive',
    affinity: 'dominant',
    imagePath: 'waifumon/cold_a/standard.png',
  },
  {
    slug: 'cold_b',
    name: 'Cold B',
    rarity: 'R',
    archetype: 'android',
    race: 'android',
    contentRating: 'suggestive',
    affinity: 'primal',
    imagePath: 'waifumon/cold_b/standard.png',
  },
]);

let workdir: string;
let assetsDir: string;
let cacheRoot: string;
let content: LoadedContent;
let renderer: CardRenderer;
let api: ZodFastify;
let appearance: ReturnType<typeof createAppearanceService>;

async function writeArt(slug: string, rgb: { r: number; g: number; b: number }) {
  const dir = path.join(assetsDir, 'waifumon', slug);
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({ create: { width: 64, height: 96, channels: 3, background: rgb } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'standard.png'), png);
}

function cacheFiles(): string[] {
  if (!fs.existsSync(cacheRoot)) return [];
  return fs
    .readdirSync(cacheRoot)
    .flatMap((slug) => fs.readdirSync(path.join(cacheRoot, slug)).map((f) => `${slug}/${f}`))
    .filter((f) => f.endsWith('.webp'))
    .sort();
}

const species = (slug: string, level: number) =>
  api.inject({
    method: 'GET',
    url: `/api/v1/cards/species/${slug}?level=${level}&width=${GRID_CARD_WIDTH}`,
    headers: AUTH,
  });

beforeAll(async () => {
  workdir = await makeTempDir('load-test-cards');
  assetsDir = path.join(workdir, 'assets');
  cacheRoot = path.join(workdir, 'cache');
  content = {
    items: [],
    species: SPECIES,
    tables: { waifuProgression: { maxLevel: 50 } } as unknown as LoadedContent['tables'],
    bosses: [],
    bossRewards: [],
    expeditions: [],
    expeditionRewards: [],
    regions: [],
    expansions: [],
    speciesOrigin: {},
  };
  await writeArt('cold_a', { r: 200, g: 40, b: 90 });
  await writeArt('cold_b', { r: 40, g: 200, b: 90 });
  appearance = createAppearanceService({ db: null as never, getContent: () => content });
  renderer = createCardRenderer({ cacheRoot, workers: 0 });
  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3121, token: TEST_TOKEN, cardRendererEnabled: true },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: { appearance } as unknown as AppServices,
      getContent: () => content,
      assetsDir,
      cardRenderer: renderer,
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.close();
  await renderer?.shutdown();
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('cold card plan, render and eviction', () => {
  it('plans only uncached cards, renders each for real, and evicts back to the pre-run cache', async () => {
    // A card a real player already has cached: level 50 of cold_a.
    expect((await species('cold_a', 50)).statusCode).toBe(200);
    const preExisting = cacheFiles();
    expect(preExisting.length).toBeGreaterThan(0);

    const planned = await planColdCards(
      { renderer, presentation: { appearance, assetsDir }, maxLevel: 50 },
      ['cold_a', 'cold_b'],
      3,
    );
    expect(planned.map((p) => `${p.slug}@${p.level}`)).toEqual(['cold_b@50', 'cold_a@49', 'cold_b@49']);

    const before = renderer.getStats().masterRenders;
    for (const card of planned) {
      const res = await species(card.slug, card.level);
      expect(res.statusCode).toBe(200);
      // The route's identity for this card is the planner's.
      expect(res.headers.etag).toBe(`"${card.renderKey}@${GRID_CARD_WIDTH}"`);
    }
    // Every planned request rasterized a master: nothing was already there.
    expect(renderer.getStats().masterRenders - before).toBe(planned.length);
    expect(cacheFiles().length).toBeGreaterThan(preExisting.length);

    const removed = await evictColdCards(cacheRoot, planned);
    expect(removed).toBe(planned.length * 2); // master + the 512 derivative each
    expect(cacheFiles()).toEqual(preExisting);

    // Repeatable: the same plan is cold again.
    const again = await planColdCards(
      { renderer, presentation: { appearance, assetsDir }, maxLevel: 50 },
      ['cold_a', 'cold_b'],
      3,
    );
    expect(again).toEqual(planned);
  }, 60_000);
});
