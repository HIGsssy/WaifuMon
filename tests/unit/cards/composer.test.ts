/**
 * Base-SVG composition. Everything here is about the composer touching exactly
 * what it should: the base document, structurally, and nothing else — in
 * particular not the rarity overlay, whose gradient and filter ids are only
 * safe because they never share a document with anything.
 */
import fs from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ASSET_ROOT } from '../../../src/modules/cards';
import { CardAssetLoader } from '../../../src/modules/cards/assets/loader';
import { composeBaseSvg, type ComposeBaseSvgInput } from '../../../src/modules/cards/composer/baseComposer';
import { ARTWORK_HREF } from '../../../src/modules/cards/composer/artworkHref';
import {
  findById,
  getAttr,
  parseXml,
  childrenOf,
} from '../../../src/modules/cards/composer/xmlTree';
import { AFFINITY_DESCRIPTIONS } from '../../../src/modules/cards';
import { renderOverlayPng } from '../../../src/modules/cards/rasterizer/renderer';

const loader = new CardAssetLoader(DEFAULT_ASSET_ROOT);

let baseSvg: string;
let raceIconSvg: string;
let affinityIconSvg: string;

beforeAll(async () => {
  [baseSvg, raceIconSvg, affinityIconSvg] = await Promise.all([
    loader.baseTemplate(),
    loader.raceIcon('demi-human'),
    loader.affinityIcon('dominant'),
  ]);
});

function compose(overrides: Partial<ComposeBaseSvgInput> = {}): string {
  return composeBaseSvg({
    baseSvg,
    raceIconSvg,
    affinityIconSvg,
    name: 'Alley Catgirl',
    race: 'demi-human',
    affinity: 'dominant',
    level: 12,
    card: {
      subtitle: 'Curious Companion',
      artist: 'Artist Name',
      ability: { name: 'Nine Lives', text: 'Ignores the first failed capture attempt each encounter.' },
      flavorQuote: 'She was here before the city was.',
      cardNumber: '012/100',
    },
    ...overrides,
  }).svg;
}

/** Text content of the element with `id`, or `null` when the element is gone. */
function textOf(svg: string, id: string): string | null {
  const found = findById(parseXml(svg), id);
  if (!found) return null;
  const children = childrenOf(found.node) ?? [];
  return children.map((c) => String((c as Record<string, unknown>)['#text'] ?? '')).join('');
}

function has(svg: string, id: string): boolean {
  return findById(parseXml(svg), id) !== null;
}

describe('text substitution', () => {
  it('replaces every dynamic field by element id', () => {
    const svg = compose();
    expect(textOf(svg, 'character-name')).toBe('Alley Catgirl');
    expect(textOf(svg, 'character-subtitle')).toBe('Curious Companion');
    expect(textOf(svg, 'level')).toBe('12');
    expect(textOf(svg, 'race-label')).toBe('DEMI-HUMAN');
    expect(textOf(svg, 'affinity-label')).toBe('DOMINANT');
    expect(textOf(svg, 'ability-name')).toBe('Nine Lives');
    expect(textOf(svg, 'artist-credit')).toBe('Artist - Artist Name');
    expect(textOf(svg, 'card-number')).toBe('012/100');
  });

  it('leaves the template placeholders behind', () => {
    const svg = compose();
    expect(svg).not.toContain('CHARACTER NAME');
    expect(svg).not.toContain('Subtitle / Epithet');
    expect(svg).not.toContain('Ability description goes here.');
  });

  it('quotes the flavor text', () => {
    expect(textOf(compose(), 'flavor-quote')).toBe('“She was here before the city was.”');
  });

  it('renders the affinity blurb across the two available lines', () => {
    const svg = compose({ affinity: 'dominant' });
    const line1 = textOf(svg, 'affinity-description') ?? '';
    const line2 = textOf(svg, 'affinity-description-2') ?? '';
    expect(line1.length).toBeGreaterThan(0);
    expect(line2.length).toBeGreaterThan(0);
    const rejoined = `${line1} ${line2}`.trim();
    expect(rejoined).toBe(AFFINITY_DESCRIPTIONS.dominant);
  });

  it('wraps long ability text onto the second line', () => {
    const svg = compose({
      card: {
        ability: {
          name: 'Nine Lives',
          text: 'Ignores the first failed capture attempt of every encounter, then spends the rest of the night pretending it never happened.',
        },
      },
    });
    expect((textOf(svg, 'ability-text') ?? '').length).toBeGreaterThan(0);
    expect((textOf(svg, 'ability-text-2') ?? '').length).toBeGreaterThan(0);
  });
});

describe('escaping', () => {
  it('escapes XML metacharacters in authored text', () => {
    const svg = compose({ name: 'Tom & Jerry' });
    expect(svg).toContain('Tom &amp; Jerry');
    expect(textOf(svg, 'character-name')).toBe('Tom &amp; Jerry');
  });

  it('cannot be used to inject markup', () => {
    const svg = compose({
      card: { subtitle: '</text><rect id="pwned" width="9999" height="9999"/><text>' },
    });
    expect(has(svg, 'pwned')).toBe(false);
    expect(svg).toContain('&lt;rect');
    // The document still parses to exactly one root <svg>.
    expect(parseXml(svg)).toHaveLength(1);
  });
});

describe('optional element removal', () => {
  it('removes every optional element when no card metadata is supplied', () => {
    const svg = compose({ card: {} });
    for (const id of [
      'character-subtitle',
      'ability-block',
      'ability-name',
      'ability-text',
      'flavor-quote',
      'artist-credit',
      'card-number',
    ]) {
      expect(has(svg, id), id).toBe(false);
    }
  });

  it('treats blank strings the same as absent ones', () => {
    const svg = compose({ card: { subtitle: '   ', artist: '', flavorQuote: '\n' } });
    expect(has(svg, 'character-subtitle')).toBe(false);
    expect(has(svg, 'artist-credit')).toBe(false);
    expect(has(svg, 'flavor-quote')).toBe(false);
  });

  it('keeps the non-optional elements no matter what', () => {
    const svg = compose({ card: {} });
    for (const id of [
      'card-background',
      'character-art',
      'character-name',
      'level',
      'race-icon',
      'race-label',
      'affinity-icon',
      'affinity-label',
    ]) {
      expect(has(svg, id), id).toBe(true);
    }
  });

  it('drops the whole ability panel when only half the ability is authored', () => {
    expect(has(compose({ card: { ability: { name: 'Nine Lives', text: '' } } }), 'ability-block')).toBe(
      false,
    );
    expect(has(compose({ card: { ability: { name: '', text: 'Does a thing.' } } }), 'ability-block')).toBe(
      false,
    );
  });

  it('drops the unused second line when wrapped text fits on one', () => {
    const svg = compose({
      card: { ability: { name: 'Nap', text: 'Short.' } },
    });
    expect(has(svg, 'ability-text')).toBe(true);
    expect(has(svg, 'ability-text-2')).toBe(false);
  });
});

describe('character-name fitting', () => {
  it('keeps the largest size for a short name', () => {
    const found = findById(parseXml(compose({ name: 'Mika' })), 'character-name');
    // The largest tier in the composer's LAYOUT.nameTiers.
    expect(getAttr(found!.node, 'font-size')).toBe('84');
  });

  it('steps the size down for a long name', () => {
    const found = findById(
      parseXml(compose({ name: 'Abyssal Shrine Oracle of the Drowned Moon' })),
      'character-name',
    );
    expect(Number(getAttr(found!.node, 'font-size'))).toBeLessThan(84);
  });

  it('truncates a name no size can fit', () => {
    const svg = compose({ name: 'W'.repeat(200) });
    expect(textOf(svg, 'character-name')?.endsWith('…')).toBe(true);
  });
});

describe('icon injection', () => {
  it('injects race icon children into the placeholder group and sets its color', () => {
    const found = findById(parseXml(compose()), 'race-icon');
    expect(found).not.toBeNull();
    expect(childrenOf(found!.node)?.length).toBeGreaterThan(0);
    // Both classification discs are dark on this canvas, so both icons are light.
    expect(getAttr(found!.node, 'color')).toBe('#f4f4f8');
    // Children are lifted out of the icon document — no nested <svg> root.
    expect(childrenOf(found!.node)?.some((c) => 'svg' in c)).toBe(false);
  });

  it('injects affinity icon children with a light color for the dark disc', () => {
    const found = findById(parseXml(compose()), 'affinity-icon');
    expect(childrenOf(found!.node)?.length).toBeGreaterThan(0);
    expect(getAttr(found!.node, 'color')).toBe('#f4f4f8');
  });

  it('injects a different icon per race', async () => {
    const angel = await loader.raceIcon('angel');
    const withAngel = compose({ raceIconSvg: angel, race: 'angel' });
    const withDemiHuman = compose();
    expect(withAngel).not.toBe(withDemiHuman);
  });
});

describe('artwork wiring', () => {
  it('rewrites the template placeholder href to the renderer sentinel', () => {
    const composed = composeBaseSvg({
      baseSvg,
      raceIconSvg,
      affinityIconSvg,
      name: 'Alley Catgirl',
      race: 'demi-human',
      affinity: 'dominant',
      level: 1,
      card: {},
    });
    const art = findById(parseXml(composed.svg), 'character-art');
    expect(getAttr(art!.node, 'href')).toBe(ARTWORK_HREF);
    expect(composed.imageHrefs).toEqual([ARTWORK_HREF]);
    expect(composed.svg).not.toContain('character-art.png');
  });

  it('never writes a filesystem path into the document', () => {
    const svg = compose();
    expect(svg).not.toContain('file://');
    expect(svg).not.toContain('assets/');
    // A drive letter directly after a quote or space, e.g. href="D:/art/…".
    expect(svg).not.toMatch(/["'\s][A-Za-z]:[\\/]/);
  });

  it('preserves the template crop behaviour', () => {
    const art = findById(parseXml(compose()), 'character-art');
    expect(getAttr(art!.node, 'preserveAspectRatio')).toBe('xMidYMid slice');
  });
});

describe('rarity overlays stay independent', () => {
  it('is never merged into the composed base document', async () => {
    const svg = compose();
    for (const rarity of ['EX', 'UR'] as const) {
      const overlay = await loader.rarityOverlay(rarity);
      expect(svg).not.toContain('rarity-badge');
      expect(svg).not.toContain('rarityStroke');
      expect(overlay).toContain('rarity-badge');
    }
  });

  it('is rasterized verbatim, so two rarities produce different pixels', async () => {
    const fonts = loader.fontPaths();
    const [ex, ur] = await Promise.all([loader.rarityOverlay('EX'), loader.rarityOverlay('UR')]);
    const exPng = renderOverlayPng(ex, fonts);
    const urPng = renderOverlayPng(ur, fonts);
    expect(exPng.length).toBeGreaterThan(0);
    expect(exPng.equals(urPng)).toBe(false);
  });

  it('leaves the overlay file on disk untouched', async () => {
    const before = await fs.readFile(loader.rarityOverlayPath('EX'), 'utf8');
    compose();
    renderOverlayPng(before, loader.fontPaths());
    const after = await fs.readFile(loader.rarityOverlayPath('EX'), 'utf8');
    expect(after).toBe(before);
  });
});
