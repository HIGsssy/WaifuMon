/**
 * Metadata states. Phase 1 does not change content validation, so the renderer
 * has to cope with everything from a fully-authored card to nothing at all to
 * strings far past their intended caps — all without failing and without
 * printing placeholder text where content is missing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCardRenderer,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
  type CardRenderer,
} from '../../../src/modules/cards';
import {
  cardInput,
  dimensionsOf,
  isWebp,
  makeTempDir,
  writeArtwork,
} from '../../helpers/cardFixtures';

let workdir: string;
let artwork: string;
let renderer: CardRenderer;

beforeAll(async () => {
  workdir = await makeTempDir('cards-metadata');
  artwork = await writeArtwork(path.join(workdir, 'art', 'standard.png'), { r: 30, g: 90, b: 120 });
  renderer = createCardRenderer({ cacheRoot: path.join(workdir, 'cache') });
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

const LONG = 'Extraordinarily Verbose '.repeat(20).trim();

const CASES: { label: string; input: () => Parameters<CardRenderer['renderCard']>[0] }[] = [
  {
    label: 'full metadata',
    input: () => cardInput(artwork, { slug: 'meta_full' }),
  },
  {
    label: 'no card metadata block at all',
    input: () => {
      const base = cardInput(artwork, { slug: 'meta_none', card: undefined });
      return { ...base, species: { ...base.species, card: undefined } };
    },
  },
  {
    label: 'partial metadata (ability, no flavor or artist)',
    input: () =>
      cardInput(artwork, {
        slug: 'meta_partial',
        card: { ability: { name: 'Nine Lives', text: 'Shrugs off the first failure.' } },
      }),
  },
  {
    label: 'partial metadata (subtitle only)',
    input: () => cardInput(artwork, { slug: 'meta_subtitle', card: { subtitle: 'Just A Subtitle' } }),
  },
  {
    label: 'long metadata requiring wrapping and truncation',
    input: () =>
      cardInput(artwork, {
        slug: 'meta_long',
        name: LONG,
        card: {
          subtitle: LONG,
          artist: LONG,
          ability: { name: LONG, text: LONG },
          flavorQuote: LONG,
          cardNumber: LONG,
        },
      }),
  },
  {
    label: 'blank strings everywhere',
    input: () =>
      cardInput(artwork, {
        slug: 'meta_blank',
        card: { subtitle: '', artist: '   ', flavorQuote: '\n', cardNumber: '' },
      }),
  },
  {
    label: 'text full of XML metacharacters',
    input: () =>
      cardInput(artwork, {
        slug: 'meta_xml',
        name: 'Tom & Jerry',
        card: {
          subtitle: '</text><rect width="9999" height="9999" fill="red"/><text>',
          flavorQuote: `"quoted" & <angled>`,
        },
      }),
  },
];

describe('metadata states', () => {
  for (const testCase of CASES) {
    it(`renders a valid master with ${testCase.label}`, async () => {
      const result = await renderer.renderCard(testCase.input());
      expect(isWebp(result.bytes)).toBe(true);
      expect(await dimensionsOf(result.bytes)).toEqual({
        width: CARD_MASTER_WIDTH,
        height: CARD_MASTER_HEIGHT,
      });
    });
  }

  it('produces a smaller file for a bare card than a fully-populated one', async () => {
    const full = await renderer.renderCard(cardInput(artwork, { slug: 'size_full' }));
    const bareBase = cardInput(artwork, { slug: 'size_bare' });
    const bare = await renderer.renderCard({
      ...bareBase,
      species: { ...bareBase.species, card: undefined },
    });
    // Fewer glyphs and one fewer panel is fewer bytes; this is the cheap proxy
    // for "the optional elements really were removed, not rendered blank".
    expect(bare.bytes.length).toBeLessThan(full.bytes.length);
  });

  it('defaults an omitted level to 1 without changing anything else', async () => {
    const base = cardInput(artwork, { slug: 'level_default' });
    const explicit = await renderer.computeMasterRenderKey({ ...base, progress: { level: 1 } });
    const omitted = await renderer.computeMasterRenderKey({ ...base, progress: undefined });
    expect(omitted).toBe(explicit);
  });
});
