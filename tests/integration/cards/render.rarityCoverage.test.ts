/**
 * A render per renderable rarity, chosen so the set also covers all seven races
 * and all five affinities at least once — plus the one rarity that must *not*
 * render.
 *
 * This deliberately replaces the 245-combination Cartesian sweep the V1 plan
 * proposed. Exhaustive per-dimension coverage lives in the unit suite, which is
 * where it belongs: rasterizing 245 cards to prove a lookup table is correct is
 * a slow way to test a `Record`.
 *
 * `EX` has no frame artwork yet. It stays in the game's rarity ladder and keeps
 * its own roundel, but asking to draw one is a hard failure rather than a card
 * wearing somebody else's frame — that is the assertion at the bottom.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AFFINITIES, RARITIES } from '../../../src/db/schema';
import {
  createCardRenderer,
  CardAssetMissingError,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
  RACE_CODES,
  RENDERABLE_RARITIES,
  UNSUPPORTED_RARITIES,
  type Affinity,
  type CardRenderer,
  type RaceCode,
  type Rarity,
} from '../../../src/modules/cards';
import {
  cardInput,
  dimensionsOf,
  isWebp,
  listFiles,
  makeTempDir,
  writeArtwork,
} from '../../helpers/cardFixtures';

interface Combo {
  slug: string;
  rarity: Rarity;
  race: RaceCode;
  affinity: Affinity;
}

/**
 * Six renderable rarities against seven races, so one rarity carries two
 * entries — `N` draws both `angel` and `android`. Race coverage is the
 * constraint worth keeping whole; which frame it happens to wear is not.
 */
const COMBOS: Combo[] = [
  { slug: 'fixture_n_angel', rarity: 'N', race: 'angel', affinity: 'caregiver' },
  { slug: 'fixture_r_human', rarity: 'R', race: 'human', affinity: 'switch' },
  { slug: 'fixture_sr_demihuman', rarity: 'SR', race: 'demi-human', affinity: 'dominant' },
  { slug: 'fixture_ssr_demon', rarity: 'SSR', race: 'demon', affinity: 'submissive' },
  { slug: 'fixture_ur_valkyrie', rarity: 'UR', race: 'valkyrie', affinity: 'primal' },
  { slug: 'fixture_lr_spirit', rarity: 'LR', race: 'spirit', affinity: 'caregiver' },
  { slug: 'fixture_n_android', rarity: 'N', race: 'android', affinity: 'dominant' },
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
  it('covers every renderable rarity, race, and affinity between them', () => {
    expect(new Set(COMBOS.map((c) => c.rarity))).toEqual(new Set(RENDERABLE_RARITIES));
    expect(new Set(COMBOS.map((c) => c.race))).toEqual(new Set(RACE_CODES));
    expect(new Set(COMBOS.map((c) => c.affinity))).toEqual(new Set(AFFINITIES));
  });

  it('accounts for every rarity in the game, renderable or not', () => {
    expect([...RENDERABLE_RARITIES, ...UNSUPPORTED_RARITIES].sort()).toEqual([...RARITIES].sort());
  });

  for (const combo of COMBOS) {
    const label = `${combo.rarity} / ${combo.race} / ${combo.affinity}`;

    it(`renders ${label} as a full-size WebP`, async () => {
      const result = await renderer.renderCard(
        cardInput(artwork, {
          slug: combo.slug,
          name: `${combo.race} ${combo.affinity}`,
          rarity: combo.rarity,
          race: combo.race,
          affinity: combo.affinity,
        }),
      );

      expect(isWebp(result.bytes), `${label} is WebP`).toBe(true);
      expect(result.contentType).toBe('image/webp');
      expect(await dimensionsOf(result.bytes)).toEqual({
        width: CARD_MASTER_WIDTH,
        height: CARD_MASTER_HEIGHT,
      });
      expect(result.width).toBe(CARD_MASTER_WIDTH);
      expect(result.height).toBe(CARD_MASTER_HEIGHT);
    });
  }

  it('gives every combination its own render key and cache file', async () => {
    const keys = await Promise.all(
      COMBOS.map((combo) =>
        renderer.computeMasterRenderKey(
          cardInput(artwork, {
            slug: combo.slug,
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

  it('produces visibly different bytes for LR and UR of an otherwise identical card', async () => {
    const [lr, ur] = await Promise.all(
      (['LR', 'UR'] as const).map((rarity) =>
        renderer.renderCard(
          cardInput(artwork, { slug: 'lr_vs_ur', name: 'Same Card', rarity }),
        ),
      ),
    );
    expect(lr!.renderKey).not.toBe(ur!.renderKey);
    expect(lr!.bytes.equals(ur!.bytes)).toBe(false);
  });
});

/**
 * The frameless rarity. `EX` is real in the game and has its own roundel; only
 * the frame is missing. Substituting one would ship a card that lies about what
 * it is, so the renderer refuses — and it must refuse with the same typed error
 * a broken install produces, so an operator sees the exact missing path.
 */
describe('a rarity with no frame artwork', () => {
  const exInput = () =>
    cardInput(artwork, {
      slug: 'fixture_ex_android',
      name: 'Frameless',
      rarity: 'EX',
      race: 'android',
      affinity: 'dominant',
    });

  it('fails loudly rather than borrowing another rarity’s frame', async () => {
    await expect(renderer.renderCard(exInput())).rejects.toBeInstanceOf(CardAssetMissingError);
    await expect(renderer.renderCard(exInput())).rejects.toMatchObject({
      code: 'CARD_ASSET_MISSING',
    });
  });

  it('names the exact asset that is missing', async () => {
    await expect(renderer.renderCard(exInput())).rejects.toMatchObject({
      assetPath: expect.stringContaining(path.join('frames', 'ex.png')) as unknown as string,
    });
  });

  it('does not stop the other six rarities from validating', async () => {
    await expect(renderer.validateAssets()).resolves.toBeUndefined();
  });

  it('writes nothing to the cache for a card it could not draw', async () => {
    await expect(renderer.renderCard(exInput())).rejects.toBeTruthy();
    const files = await listFiles(path.join(workdir, 'cache'));
    expect(files.filter((f) => f.includes('fixture_ex_android'))).toEqual([]);
  });
});
