/**
 * Nothing of the character may be visible inside the level shield.
 *
 * The shield is a hole in the frame artwork, and the plate behind it is what
 * makes the level legible over whatever happens to be under it. An earlier
 * plate was fitted *inside* the hole's bounding box, which left the point and
 * the shoulders bare — bright artwork then ringed the level badge, worst on the
 * frames whose art is pale.
 *
 * The test does not try to recognise "artwork". It renders the same card twice
 * over two maximally different artworks and asserts the shield opening comes out
 * the same both times. If any of the character reaches the opening, the two
 * renders diverge there; if the plate covers it, they cannot. That holds for
 * every frame without encoding a single expected pixel value.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  createCardRenderer,
  DEFAULT_ASSET_ROOT,
  RENDERABLE_RARITIES,
  type CardRenderer,
  type Rarity,
} from '../../../src/modules/cards';
import { CardAssetLoader } from '../../../src/modules/cards/assets/loader';
import { cardInput, makeTempDir, writeArtwork } from '../../helpers/cardFixtures';

const loader = new CardAssetLoader(DEFAULT_ASSET_ROOT);

let workdir: string;
let whiteArt: string;
let blackArt: string;
let renderer: CardRenderer;

beforeAll(async () => {
  workdir = await makeTempDir('cards-shield');
  // Maximally different: every subpixel differs by the full range.
  whiteArt = await writeArtwork(path.join(workdir, 'art', 'white.png'), { r: 255, g: 255, b: 255 });
  blackArt = await writeArtwork(path.join(workdir, 'art', 'black.png'), { r: 0, g: 0, b: 0 });
  renderer = createCardRenderer({ cacheRoot: path.join(workdir, 'cache') });
}, 60_000);

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

interface Raw {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function renderRaw(artwork: string, rarity: Rarity): Promise<Raw> {
  const result = await renderer.renderCard(
    cardInput(artwork, { slug: `shield_${rarity.toLowerCase()}`, name: 'Shield Fixture', rarity, level: 50 }),
  );
  const { data, info } = await sharp(result.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Mean absolute per-channel difference over a region, 0–255. */
function meanDelta(a: Raw, b: Raw, region: { x: number; y: number; w: number; h: number }): number {
  let total = 0;
  let samples = 0;
  for (let y = region.y; y < region.y + region.h; y += 1) {
    for (let x = region.x; x < region.x + region.w; x += 1) {
      const i = (y * a.width + x) * a.channels;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0));
        samples += 1;
      }
    }
  }
  return samples === 0 ? 0 : total / samples;
}

describe('level shield coverage', () => {
  for (const rarity of RENDERABLE_RARITIES) {
    it(`shows none of the character inside the ${rarity} shield`, async () => {
      const [light, dark] = await Promise.all([renderRaw(whiteArt, rarity), renderRaw(blackArt, rarity)]);
      const g = await loader.frameGeometry(rarity);

      // Control: the artwork window must differ enormously, or the fixtures are
      // not actually different and the shield assertion would prove nothing.
      const artDelta = meanDelta(light, dark, g.art);
      expect(artDelta, `${rarity}: fixtures are not distinguishable`).toBeGreaterThan(100);

      // The opening itself. A couple of levels of tolerance absorbs the lossy
      // WebP encode, which perturbs blocks near any boundary.
      const shieldDelta = meanDelta(light, dark, g.shield);
      expect(shieldDelta, `${rarity}: artwork is visible inside the level shield`).toBeLessThan(2);
    }, 60_000);
  }

  it('covers the exact region the old inset plate left bare', async () => {
    // The regression, stated geometrically: everything inside the shield's box
    // but outside the ellipse that used to plate it.
    const rarity: Rarity = 'LR';
    const [light, dark] = await Promise.all([renderRaw(whiteArt, rarity), renderRaw(blackArt, rarity)]);
    const g = await loader.frameGeometry(rarity);
    const s = g.shield;

    const rx = s.w * 0.52;
    const ry = s.h * 0.46;
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h * 0.45;

    let worst = 0;
    let sampled = 0;
    for (let y = s.y; y < s.y + s.h; y += 1) {
      for (let x = s.x; x < s.x + s.w; x += 1) {
        const outsideOldPlate = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1;
        if (!outsideOldPlate) continue;
        sampled += 1;
        const i = (y * light.width + x) * light.channels;
        for (let c = 0; c < 3; c += 1) {
          worst = Math.max(worst, Math.abs((light.data[i + c] ?? 0) - (dark.data[i + c] ?? 0)));
        }
      }
    }

    expect(sampled, 'the old plate did leave part of the box bare').toBeGreaterThan(5_000);
    expect(worst, 'the formerly-bare region still leaks artwork').toBeLessThan(24);
  }, 60_000);

  it('keeps the level legible on the plate', async () => {
    const result = await renderer.renderCard(
      cardInput(whiteArt, { slug: 'shield_legible', name: 'Shield Fixture', rarity: 'LR', level: 50 }),
    );
    const g = await loader.frameGeometry('LR');
    const band = g.shieldText;
    const { data, info } = await sharp(result.bytes)
      .extract({ left: band.x, top: band.y, width: band.w, height: band.h })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const lum = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    // Light glyphs on a dark plate: the band must still hold real contrast.
    expect(min, 'the plate is not dark').toBeLessThan(60);
    expect(max, 'the level glyphs are not light').toBeGreaterThan(150);
  }, 60_000);
});
