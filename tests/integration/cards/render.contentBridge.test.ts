/**
 * The end-to-end Phase 2 proof: a species read off disk, exactly as an author
 * wrote it, becomes a rendered card.
 *
 * This is the seam that would break silently otherwise — the schema could
 * accept a field the renderer never reads, or the bridge could drop one, and
 * every isolated unit test would still pass. So this test starts from the real
 * `content/species/*.json` and the real artwork under `assets/waifumon/`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readContentFiles } from '../../../src/modules/content/loader';
import { toCardRenderInput } from '../../../src/modules/content/speciesCardInput';
import type { SpeciesContent } from '../../../src/modules/content/schemas';
import {
  createCardRenderer,
  CARD_MASTER_HEIGHT,
  CARD_MASTER_WIDTH,
  type CardRenderer,
} from '../../../src/modules/cards';
import { dimensionsOf, isWebp, makeTempDir } from '../../helpers/cardFixtures';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

let workdir: string;
let renderer: CardRenderer;
let species: SpeciesContent[];

beforeAll(async () => {
  workdir = await makeTempDir('cards-bridge');
  renderer = createCardRenderer({ cacheRoot: path.join(workdir, 'cache') });
  species = readContentFiles(path.join(REPO_ROOT, 'content')).species;
});

afterAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

function bySlug(slug: string): SpeciesContent {
  const found = species.find((s) => s.slug === slug);
  if (!found) throw new Error(`Fixture species "${slug}" is missing from content`);
  return found;
}

/**
 * The species' default artwork as a resolved-asset shape — the same value the
 * shared appearance resolver hands the route.
 */
function artworkFor(entry: SpeciesContent): {
  absolutePath: string;
  assetId: { kind: string; slug: string; variant: string };
} {
  return {
    absolutePath: path.join(ASSETS_DIR, entry.imagePath),
    assetId: { kind: 'waifumon', slug: entry.slug, variant: 'standard' },
  };
}

describe('real content renders', () => {
  const SEEDED = [
    { slug: 'alley_catgirl', label: 'full card metadata' },
    { slug: 'chrome_valkyrie', label: 'partial card metadata' },
    { slug: 'the_first_waifu', label: 'explicit race, no card block' },
  ];

  for (const { slug, label } of SEEDED) {
    it(`renders ${slug} (${label}) from authored content`, async () => {
      const entry = bySlug(slug);
      const input = toCardRenderInput(entry, {
        artwork: artworkFor(entry),
        level: 12,
      });

      const result = await renderer.renderCard(input);

      expect(isWebp(result.bytes)).toBe(true);
      expect(await dimensionsOf(result.bytes)).toEqual({
        width: CARD_MASTER_WIDTH,
        height: CARD_MASTER_HEIGHT,
      });
      expect(result.renderKey).toMatch(/^[0-9a-f]{16}$/);
    });
  }

  it('renders a species that has neither race nor card metadata', async () => {
    const legacy = species.find((s) => !s.race && !s.card);
    expect(legacy, 'corpus should still contain unmigrated species').toBeDefined();

    const input = toCardRenderInput(legacy!, { artwork: artworkFor(legacy!) });
    const result = await renderer.renderCard(input);

    expect(isWebp(result.bytes)).toBe(true);
    expect(result.width).toBe(CARD_MASTER_WIDTH);
  });

  it('resolves a race for every species in the corpus', () => {
    for (const entry of species) {
      const input = toCardRenderInput(entry, { artwork: artworkFor(entry) });
      expect(input.species.race, entry.slug).toBeTruthy();
    }
  });

  it('gives authored metadata the card draws a different render key', async () => {
    const entry = bySlug('alley_catgirl');
    expect(entry.card, 'alley_catgirl is a seeded example').toBeDefined();

    const plain = toCardRenderInput(entry, { artwork: artworkFor(entry) });
    const credited = toCardRenderInput(entry, {
      artwork: artworkFor(entry),
      overrides: { artist: 'Someone Specific', cardNumber: '042/100' },
    });

    const [a, b] = await Promise.all([
      renderer.computeMasterRenderKey(plain),
      renderer.computeMasterRenderKey(credited),
    ]);
    expect(a).not.toBe(b);
  });

  /**
   * The production panel has room for a name, two description lines and a
   * credit row. `subtitle`, `ability` and `flavorQuote` stay in content — the
   * admin panel and the API still carry them — but they reach no pixel, so
   * editing one must not mint a second master of an identical image.
   */
  it('does not re-key on authored metadata the card face does not draw', async () => {
    const entry = bySlug('alley_catgirl');

    const withCard = toCardRenderInput(entry, { artwork: artworkFor(entry) });
    const withoutCard = toCardRenderInput(
      { ...entry, card: { artist: entry.card?.artist, cardNumber: entry.card?.cardNumber } },
      { artwork: artworkFor(entry) },
    );

    const [a, b] = await Promise.all([
      renderer.computeMasterRenderKey(withCard),
      renderer.computeMasterRenderKey(withoutCard),
    ]);
    expect(a).toBe(b);
  });

  it('re-keys on the species description, which the panel does draw', async () => {
    const entry = bySlug('alley_catgirl');

    const [a, b] = await Promise.all([
      renderer.computeMasterRenderKey(toCardRenderInput(entry, { artwork: artworkFor(entry) })),
      renderer.computeMasterRenderKey(
        toCardRenderInput(
          { ...entry, description: 'A completely different flavour line.' },
          { artwork: artworkFor(entry) },
        ),
      ),
    ]);
    expect(a).not.toBe(b);
  });

  it('renders a derivative width from real content without a second master', async () => {
    const entry = bySlug('chrome_valkyrie');
    const base = { artwork: artworkFor(entry), level: 5 };

    const master = await renderer.renderCard(toCardRenderInput(entry, base));
    const small = await renderer.renderCard(toCardRenderInput(entry, { ...base, width: 512 }));

    expect(small.renderKey).toBe(master.renderKey);
    expect(small.width).toBe(512);
  });
});
