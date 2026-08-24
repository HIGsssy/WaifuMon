/**
 * Composition — the layer plan and the two vector layers.
 *
 * Everything the composer produces is decided before a pixel is drawn, so all
 * of it is testable without rendering: where the artwork is cropped, where the
 * icons land, and what the SVG layers actually say. The assertions here are
 * about *invariants* rather than exact pixel values — the coordinates come from
 * `geometry.json`, which is regenerated whenever a frame is re-exported, and a
 * test that pinned them would fail on every legitimate art update.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ASSET_ROOT, LAYOUT, planArtworkCrop, planIconPlacement, planOwnedBadge } from '../../../src/modules/cards';
import type { FrameGeometry } from '../../../src/modules/cards';
import { CardAssetLoader } from '../../../src/modules/cards/assets/loader';
import {
  buildOverlaySvg,
  buildUnderlaySvg,
  type ComposeCardInput,
} from '../../../src/modules/cards/composer/cardComposer';
import { CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../../../src/modules/cards/version';

const loader = new CardAssetLoader(DEFAULT_ASSET_ROOT);
const CANVAS = { width: CARD_MASTER_WIDTH, height: CARD_MASTER_HEIGHT };

/** Icon bytes are never inspected by the composer — only measured and placed. */
const STUB = Buffer.from('icon');

let geometry: FrameGeometry;

beforeAll(async () => {
  geometry = await loader.frameGeometry('UR');
});

function compose(overrides: Partial<ComposeCardInput> = {}): ComposeCardInput {
  return {
    geometry,
    name: 'Void Empress',
    race: 'demon',
    affinity: 'primal',
    rarity: 'UR',
    level: 50,
    description: 'Reality bends politely out of her way. You should too.',
    card: { artist: 'Whistler', cardNumber: '004/100' },
    icons: { race: STUB, affinity: STUB, rarity: STUB },
    ...overrides,
  };
}

describe('planArtworkCrop', () => {
  const window = { x: 91, y: 129, w: 1314, h: 1611 };

  it('covers the window without stretching', () => {
    const crop = planArtworkCrop({ width: 1248, height: 1824 }, window);
    // One uniform scale on both axes: the ratio of the scaled size must match
    // the ratio of the source, or the character has been distorted.
    expect(crop.scaledWidth / crop.scaledHeight).toBeCloseTo(1248 / 1824, 2);
    expect(crop.scaledWidth).toBeGreaterThanOrEqual(window.w);
    expect(crop.scaledHeight).toBeGreaterThanOrEqual(window.h);
  });

  it('crops to exactly the window', () => {
    const crop = planArtworkCrop({ width: 1248, height: 1824 }, window);
    expect(crop.width).toBe(window.w);
    expect(crop.height).toBe(window.h);
  });

  it('never crops outside the scaled image', () => {
    for (const source of [
      { width: 1248, height: 1824 },
      { width: 2000, height: 1000 },
      { width: 500, height: 4000 },
      { width: 1314, height: 1611 },
    ]) {
      const crop = planArtworkCrop(source, window);
      expect(crop.cropLeft).toBeGreaterThanOrEqual(0);
      expect(crop.cropTop).toBeGreaterThanOrEqual(0);
      expect(crop.cropLeft + crop.width).toBeLessThanOrEqual(crop.scaledWidth);
      expect(crop.cropTop + crop.height).toBeLessThanOrEqual(crop.scaledHeight);
    }
  });

  it('biases the vertical crop toward the face', () => {
    const crop = planArtworkCrop({ width: 1248, height: 1824 }, window);
    const surplus = crop.scaledHeight - window.h;
    // Less comes off the top than the bottom, but not zero: hair and ears sit
    // against the top edge in these compositions.
    expect(crop.cropTop).toBeGreaterThan(0);
    expect(crop.cropTop).toBeLessThan(surplus / 2);
    expect(crop.cropTop).toBe(Math.round(surplus * LAYOUT.artFocusY));
  });

  it('centres the horizontal crop', () => {
    const crop = planArtworkCrop({ width: 4000, height: 1000 }, window);
    const left = crop.cropLeft;
    const right = crop.scaledWidth - crop.width - left;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  });
});

describe('planIconPlacement', () => {
  it('centres a square on the holder, larger than the hole', () => {
    const disc = geometry.circles.race;
    const placed = planIconPlacement(disc, STUB);
    expect(placed.width).toBe(placed.height);
    expect(placed.width).toBe(Math.round(disc.d * LAYOUT.iconFill));
    expect(placed.left + placed.width / 2).toBeCloseTo(disc.cx, 0);
    expect(placed.top + placed.height / 2).toBeCloseTo(disc.cy, 0);
    // Substantially fills the holder — the ring must lap the rim, not float
    // inside it with artwork showing through the gap.
    expect(placed.width).toBeGreaterThan(disc.d);
  });

  it('places the three slots in holder order', () => {
    const race = planIconPlacement(geometry.circles.race, STUB);
    const affinity = planIconPlacement(geometry.circles.affinity, STUB);
    const rarity = planIconPlacement(geometry.circles.rarity, STUB);
    expect(race.top).toBeLessThan(affinity.top);
    expect(affinity.top).toBeLessThan(rarity.top);
  });
});

describe('planOwnedBadge', () => {
  it('stays inside the artwork window', () => {
    const placed = planOwnedBadge(geometry.art, STUB, { width: 1312, height: 1199 });
    expect(placed.left).toBeGreaterThanOrEqual(geometry.art.x);
    expect(placed.top).toBeGreaterThanOrEqual(geometry.art.y);
    expect(placed.left + placed.width).toBeLessThanOrEqual(geometry.art.x + geometry.art.w);
    expect(placed.top + placed.height).toBeLessThanOrEqual(geometry.art.y + geometry.art.h);
  });

  it('preserves the badge’s aspect ratio', () => {
    const placed = planOwnedBadge(geometry.art, STUB, { width: 1312, height: 1199 });
    expect(placed.width / placed.height).toBeCloseTo(1312 / 1199, 2);
  });

  it('stays restrained relative to the card', () => {
    const placed = planOwnedBadge(geometry.art, STUB, { width: 1312, height: 1199 });
    expect(placed.width).toBeLessThan(CARD_MASTER_WIDTH * 0.4);
  });

  it('clamps an oversized badge rather than overflowing the frame', () => {
    const placed = planOwnedBadge(geometry.art, STUB, { width: 100, height: 10_000 });
    expect(placed.top).toBeGreaterThanOrEqual(geometry.art.y);
    expect(placed.top + placed.height).toBeLessThanOrEqual(geometry.art.y + geometry.art.h);
  });
});

describe('buildUnderlaySvg', () => {
  it('is a canvas-sized document with no embedded raster', () => {
    const svg = buildUnderlaySvg(geometry, CANVAS);
    expect(svg).toContain(`width="${CARD_MASTER_WIDTH}"`);
    expect(svg).toContain(`height="${CARD_MASTER_HEIGHT}"`);
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('base64');
  });

  it('plates the two transparent holes text has to sit in', () => {
    const svg = buildUnderlaySvg(geometry, CANVAS);
    expect(svg).toContain(`x="${geometry.panel.x}"`);
    expect(svg).toContain(`width="${geometry.panel.w}"`);
    expect(svg).toContain('<ellipse');
  });
});

describe('buildOverlaySvg', () => {
  it('is a canvas-sized document with no embedded raster', () => {
    const svg = buildOverlaySvg(compose(), CANVAS);
    expect(svg).toContain(`viewBox="0 0 ${CARD_MASTER_WIDTH} ${CARD_MASTER_HEIGHT}"`);
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('base64');
  });

  it('draws the level as text, never as a baked image', () => {
    const svg = buildOverlaySvg(compose({ level: 37 }), CANVAS);
    expect(svg).toContain('>LVL<');
    expect(svg).toContain('>37<');
  });

  it('clamps a nonsense level rather than printing it', () => {
    expect(buildOverlaySvg(compose({ level: 0 }), CANVAS)).toContain('>1<');
    expect(buildOverlaySvg(compose({ level: 12.7 }), CANVAS)).toContain('>12<');
  });

  it('centres both shield lines and makes the number dominant', () => {
    const svg = buildOverlaySvg(compose({ level: 50 }), CANVAS);
    const label = /<text ([^>]*)>LVL</.exec(svg)?.[1] ?? '';
    const value = /<text ([^>]*)>50</.exec(svg)?.[1] ?? '';
    const size = (attrs: string) => Number(/font-size="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const x = (attrs: string) => Number(/x="(\d+)"/.exec(attrs)?.[1] ?? 0);

    expect(label).toContain('text-anchor="middle"');
    expect(value).toContain('text-anchor="middle"');
    expect(x(label)).toBe(x(value));
    expect(size(value)).toBeGreaterThan(size(label) * 2);
  });

  it('makes the name the strongest element in the panel', () => {
    const svg = buildOverlaySvg(compose(), CANVAS);
    const sizes = [...svg.matchAll(/font-size="(\d+)"[^>]*>([^<]+)</g)].map((m) => ({
      size: Number(m[1]),
      content: m[2],
    }));
    const name = sizes.find((s) => s.content === 'VOID EMPRESS');
    expect(name).toBeDefined();
    const description = sizes.find((s) => s.content?.startsWith('Reality bends'));
    expect(name?.size).toBeGreaterThan(description?.size ?? Infinity);
  });

  it('upper-cases the name', () => {
    expect(buildOverlaySvg(compose({ name: 'Alley Catgirl' }), CANVAS)).toContain(
      '>ALLEY CATGIRL<',
    );
  });

  it('shrinks a long name instead of overflowing the panel', () => {
    const short = buildOverlaySvg(compose({ name: 'Nyx' }), CANVAS);
    const long = buildOverlaySvg(
      compose({ name: 'Archduchess Seraphina Of The Shattered Moon' }),
      CANVAS,
    );
    const nameSize = (svg: string, text: string) =>
      Number(new RegExp(`font-size="(\\d+)"[^>]*>${text}`).exec(svg)?.[1] ?? 0);
    expect(nameSize(long, 'ARCHDUCHESS')).toBeLessThan(nameSize(short, 'NYX'));
  });

  it('wraps a long description to two lines', () => {
    const svg = buildOverlaySvg(
      compose({
        description:
          'She arrived without announcement and the room rearranged itself around her, ' +
          'which everyone agreed afterwards had been the only reasonable outcome.',
      }),
      CANVAS,
    );
    const baselines = [...svg.matchAll(/<text [^>]*y="(\d+)"[^>]*>/g)].map((m) => Number(m[1]));
    // Two distinct description baselines exist, so the second line has a home.
    expect(new Set(baselines).size).toBeGreaterThanOrEqual(5);
  });

  it('centres a one-line description instead of leaving a hole under it', () => {
    const oneLine = buildOverlaySvg(compose({ description: 'Short.' }), CANVAS);
    const y = Number(/<text [^>]*y="(\d+)"[^>]*>Short\.</.exec(oneLine)?.[1] ?? 0);
    const band = geometry.panelText;
    const first = band.y + LAYOUT.panel.descriptionBaseline1 * band.h;
    const second = band.y + LAYOUT.panel.descriptionBaseline2 * band.h;
    expect(y).toBeGreaterThan(first);
    expect(y).toBeLessThan(second);
  });

  it('always carries the branding, and the credits when they exist', () => {
    const svg = buildOverlaySvg(compose(), CANVAS);
    expect(svg).toContain('>WAIFUMON<');
    expect(svg).toContain('>Artist — Whistler<');
    expect(svg).toContain('>004/100<');
  });

  it('drops absent credits rather than rendering empty ones', () => {
    const svg = buildOverlaySvg(compose({ card: {} }), CANVAS);
    expect(svg).toContain('>WAIFUMON<');
    expect(svg).not.toContain('Artist —');
    expect(svg).not.toMatch(/><\/text>/);
  });

  it('drops a blank description rather than reserving space for it', () => {
    for (const description of [null, '', '   ']) {
      const svg = buildOverlaySvg(compose({ description }), CANVAS);
      expect(svg).not.toMatch(/><\/text>/);
    }
  });

  it('escapes authored text rather than emitting broken markup', () => {
    const svg = buildOverlaySvg(
      compose({ name: 'Rock & <Roll>', card: { artist: '"Quo" & Co' } }),
      CANVAS,
    );
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<Roll>');
    expect(svg).toContain('&quot;');
  });

  it('never labels the icons — the artwork carries them', () => {
    const svg = buildOverlaySvg(compose(), CANVAS);
    expect(svg).not.toContain('>DEMON<');
    expect(svg).not.toContain('>PRIMAL<');
    expect(svg).not.toContain('>UR<');
  });

  it('lays out identically across every frame', async () => {
    for (const rarity of ['N', 'R', 'SR', 'SSR', 'UR', 'LR'] as const) {
      const frame = await loader.frameGeometry(rarity);
      const svg = buildOverlaySvg(compose({ geometry: frame, rarity }), CANVAS);
      expect(svg, rarity).toContain('>LVL<');
      expect(svg, rarity).toContain('>VOID EMPRESS<');
      expect(svg, rarity).toContain('>WAIFUMON<');

      // Every drawn baseline lands inside the band it belongs to.
      for (const [, yAttr] of svg.matchAll(/<text [^>]*y="(\d+)"[^>]*>/g)) {
        const y = Number(yAttr);
        const inShield = y >= frame.shield.y && y <= frame.shield.y + frame.shield.h;
        const inPanel = y >= frame.panel.y && y <= frame.panel.y + frame.panel.h;
        expect(inShield || inPanel, `${rarity}: baseline ${y} is outside both holes`).toBe(true);
      }
    }
  });
});
