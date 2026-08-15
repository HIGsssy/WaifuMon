/**
 * Seven renders — one per rarity — chosen so the set also covers all seven
 * races and all five affinities at least once.
 *
 * This deliberately replaces the 245-combination Cartesian sweep the V1 plan
 * proposed. Exhaustive per-dimension coverage lives in the unit suite, which is
 * where it belongs: rasterizing 245 cards to prove a lookup table is correct is
 * a slow way to test a `Record`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AFFINITIES, RARITIES } from '../../../src/db/schema';
import {
  createCardRenderer,
  MASTER_HEIGHT,
  MASTER_WIDTH,
  RACE_CODES,
  type Affinity,
  type CardRenderer,
  type RaceCode,
  type Rarity,
} from '../../../src/modules/cards';
import {
  cardInput,
  dimensionsOf,
  isWebp,
  makeTempDir,
  writeArtwork,
} from '../../helpers/cardFixtures';

interface Combo {
  rarity: Rarity;
  race: RaceCode;
  affinity: Affinity;
}

const COMBOS: Combo[] = [
  { rarity: 'N', race: 'angel', affinity: 'caregiver' },
  { rarity: 'R', race: 'human', affinity: 'switch' },
  { rarity: 'SR', race: 'demi-human', affinity: 'dominant' },
  { rarity: 'SSR', race: 'demon', affinity: 'submissive' },
  { rarity: 'UR', race: 'valkyrie', affinity: 'primal' },
  { rarity: 'LR', race: 'spirit', affinity: 'caregiver' },
  { rarity: 'EX', race: 'android', affinity: 'dominant' },
];

let workdir: string;
let artwork: string;
let renderer: CardRenderer;

beforeAll(async () => {
  workdir = await makeTempDir('cards-rarity');
  artwork = await writeArtwork(path.join(workdir, 'art', 'standard.png'), { r: 90, g: 30, b: 120 });
  renderer = createCardRenderer({ cacheRoot: path.join(workdir, 'cache') });
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('representative render matrix', () => {
  it('covers every rarity, race, and affinity between them', () => {
    expect(new Set(COMBOS.map((c) => c.rarity))).toEqual(new Set(RARITIES));
    expect(new Set(COMBOS.map((c) => c.race))).toEqual(new Set(RACE_CODES));
    expect(new Set(COMBOS.map((c) => c.affinity))).toEqual(new Set(AFFINITIES));
  });

  for (const combo of COMBOS) {
    const label = `${combo.rarity} / ${combo.race} / ${combo.affinity}`;

    it(`renders ${label} as a 1000×1400 WebP`, async () => {
      const result = await renderer.renderCard(
        cardInput(artwork, {
          slug: `fixture_${combo.rarity.toLowerCase()}`,
          name: `${combo.race} ${combo.affinity}`,
          rarity: combo.rarity,
          race: combo.race,
          affinity: combo.affinity,
        }),
      );

      expect(isWebp(result.bytes), `${label} is WebP`).toBe(true);
      expect(result.contentType).toBe('image/webp');
      expect(await dimensionsOf(result.bytes)).toEqual({
        width: MASTER_WIDTH,
        height: MASTER_HEIGHT,
      });
      expect(result.width).toBe(MASTER_WIDTH);
      expect(result.height).toBe(MASTER_HEIGHT);
    });
  }

  it('gives every combination its own render key and cache file', async () => {
    const keys = await Promise.all(
      COMBOS.map((combo) =>
        renderer.computeMasterRenderKey(
          cardInput(artwork, {
            slug: `fixture_${combo.rarity.toLowerCase()}`,
            name: `${combo.race} ${combo.affinity}`,
            rarity: combo.rarity,
            race: combo.race,
            affinity: combo.affinity,
          }),
        ),
      ),
    );
    expect(new Set(keys).size).toBe(COMBOS.length);
  });

  it('produces visibly different bytes for EX and UR of an otherwise identical card', async () => {
    const [ex, ur] = await Promise.all(
      (['EX', 'UR'] as const).map((rarity) =>
        renderer.renderCard(
          cardInput(artwork, { slug: 'ex_vs_ur', name: 'Same Card', rarity }),
        ),
      ),
    );
    expect(ex!.renderKey).not.toBe(ur!.renderKey);
    expect(ex!.bytes.equals(ur!.bytes)).toBe(false);
  });
});
