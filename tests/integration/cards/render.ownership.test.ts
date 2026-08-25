/**
 * The ownership overlay.
 *
 * The same species card is drawn in places where ownership is the point (a
 * player's collection) and places where it is meaningless (the encyclopedia, a
 * hunt encounter, an admin preview). So the "CAUGHT" badge is a render-time
 * overlay, never part of a species' card master — and the two states are two
 * distinct cached images rather than one that depends on who asked last.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  createCardRenderer,
  planOwnedBadge,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
  DEFAULT_ASSET_ROOT,
  type CardRenderer,
} from '../../../src/modules/cards';
import { CardAssetLoader } from '../../../src/modules/cards/assets/loader';
import { cardInput, isWebp, makeTempDir, writeArtwork } from '../../helpers/cardFixtures';

/** The fixture card renders as SSR — see `cardInput`'s default rarity. */
const loader = new CardAssetLoader(DEFAULT_ASSET_ROOT);

let workdir: string;
let artwork: string;
let renderer: CardRenderer;

beforeAll(async () => {
  workdir = await makeTempDir('cards-owned');
  artwork = await writeArtwork(path.join(workdir, 'art', 'standard.png'), { r: 40, g: 60, b: 110 });
  renderer = createCardRenderer({ cacheRoot: path.join(workdir, 'cache') });
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

const base = () => cardInput(artwork, { slug: 'owned_fixture', name: 'Owned Fixture' });
const owned = () => cardInput(artwork, { slug: 'owned_fixture', name: 'Owned Fixture', owned: true });

describe('ownership overlay', () => {
  it('is off by default — an unowned card is the plain master', async () => {
    const [plain, explicitlyUnowned] = await Promise.all([
      renderer.computeMasterRenderKey(base()),
      renderer.computeMasterRenderKey(
        cardInput(artwork, { slug: 'owned_fixture', name: 'Owned Fixture', owned: false }),
      ),
    ]);
    expect(plain).toBe(explicitlyUnowned);
  });

  it('gives the owned presentation its own render key', async () => {
    const [plain, stamped] = await Promise.all([
      renderer.computeMasterRenderKey(base()),
      renderer.computeMasterRenderKey(owned()),
    ]);
    expect(plain).not.toBe(stamped);
  });

  it('changes the pixels, and only by adding to them', async () => {
    const [plain, stamped] = await Promise.all([
      renderer.renderCard(base()),
      renderer.renderCard(owned()),
    ]);

    expect(isWebp(stamped.bytes)).toBe(true);
    expect(stamped.bytes.equals(plain.bytes)).toBe(false);
    // Same canvas — the badge is composited onto the card, not beside it.
    for (const result of [plain, stamped]) {
      const meta = await sharp(result.bytes).metadata();
      expect(meta.width).toBe(CARD_MASTER_WIDTH);
      expect(meta.height).toBe(CARD_MASTER_HEIGHT);
    }
  });

  /**
   * The masters are lossy WebP, so adding a badge anywhere perturbs blocks
   * across the whole image by a few levels. Asserting byte-equality outside the
   * badge would be testing the codec, not the layout. What actually matters is
   * *concentration*: the badge's own box should change enormously, and the
   * shield and information panel should change only by encoder noise.
   */
  it('leaves the frame furniture untouched — the badge sits over the artwork', async () => {
    const [plain, stamped] = await Promise.all([
      renderer.renderCard(base()).then((r) => sharp(r.bytes).raw().toBuffer({ resolveWithObject: true })),
      renderer.renderCard(owned()).then((r) => sharp(r.bytes).raw().toBuffer({ resolveWithObject: true })),
    ]);

    const { data: a, info } = plain;
    const { data: b } = stamped;
    const channels = info.channels;

    /** Mean absolute per-channel difference over a region, 0–255. */
    const meanDelta = (region: { x: number; y: number; w: number; h: number }): number => {
      let total = 0;
      let samples = 0;
      for (let y = region.y; y < region.y + region.h; y += 2) {
        for (let x = region.x; x < region.x + region.w; x += 2) {
          const i = (y * info.width + x) * channels;
          for (let c = 0; c < Math.min(channels, 3); c += 1) {
            total += Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
            samples += 1;
          }
        }
      }
      return samples === 0 ? 0 : total / samples;
    };

    const geometry = await loader.frameGeometry('SSR');
    const placed = planOwnedBadge(geometry.art, Buffer.alloc(0), { width: 1312, height: 1199 });
    const badge = { x: placed.left, y: placed.top, w: placed.width, h: placed.height };

    const badgeDelta = meanDelta(badge);
    const shieldDelta = meanDelta(geometry.shield);
    const panelDelta = meanDelta(geometry.panel);

    expect(badgeDelta, 'the badge must actually draw something').toBeGreaterThan(20);
    expect(shieldDelta, 'the level shield must stay clean').toBeLessThan(2);
    expect(panelDelta, 'the information panel must stay clean').toBeLessThan(2);
    expect(badgeDelta).toBeGreaterThan(shieldDelta * 10);
    expect(badgeDelta).toBeGreaterThan(panelDelta * 10);
  });

  it('caches the two states separately rather than overwriting one with the other', async () => {
    await renderer.renderCard(base());
    await renderer.renderCard(owned());

    const first = await renderer.renderCard(base());
    const second = await renderer.renderCard(owned());

    expect(first.fromCache).toBe(true);
    expect(second.fromCache).toBe(true);
    expect(first.bytes.equals(second.bytes)).toBe(false);
  });
});
