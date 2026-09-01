import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readExpansionPacks } from '../../src/modules/content/loader';
import { resolveAppearances } from '../../src/modules/appearance/appearanceContent';
import { SpeciesContentSchema } from '../../src/modules/content/schemas';
import { toContentSpeciesResource } from '../../src/api/resources';

const expansionSpecies = SpeciesContentSchema.parse({
  slug: 'onsen_maid',
  name: 'Onsen Maid',
  rarity: 'R',
  archetype: 'spirit',
  contentRating: 'suggestive',
  imagePath: 'waifumon/onsen_maid/standard.png',
  appearances: [
    { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
    { id: 'level_20', name: 'Level 20', sortOrder: 20, unlock: { type: 'level', atLevel: 20 } },
  ],
});

describe('expansion species API artwork', () => {
  it('publishes the canonical standard AssetId without leaking a physical path', () => {
    const resource = toContentSpeciesResource(
      expansionSpecies,
      resolveAppearances(expansionSpecies),
    );

    expect(resource.appearances[0]?.assetId).toEqual({
      kind: 'waifumon',
      slug: 'onsen_maid',
      variant: 'standard',
    });
    expect(resource).not.toHaveProperty('imagePath');
    expect(JSON.stringify(resource)).not.toContain('expansions/');
  });

  it('continues withholding AssetIds for locked appearances', () => {
    const resource = toContentSpeciesResource(
      expansionSpecies,
      resolveAppearances(expansionSpecies),
    );

    expect(resource.appearances.find((entry) => entry.id === 'level_20')?.assetId).toBeNull();
  });
});

describe('Thirstlands species artwork, read from shipped content', () => {
  const CONTENT_DIR = path.resolve(__dirname, '..', '..', 'content');
  const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets');
  const scan = readExpansionPacks(CONTENT_DIR);
  const pack = scan.expansionSpecies.filter((s) => scan.speciesOrigin[s.slug] === 'thirstlands');

  it('ships a roster', () => {
    expect(pack.length).toBeGreaterThan(0);
  });

  it.each(pack.map((s) => [s.slug, s] as const))(
    '%s resolves to canonical waifumon AssetIds and hides locked variants',
    (slug, species) => {
      const resource = toContentSpeciesResource(species, resolveAppearances(species));
      // The unlocked entry publishes an AssetId; nothing publishes a path, and
      // nothing anywhere in the payload mentions the authoring directory.
      expect(resource.appearances[0]?.assetId).toEqual({
        kind: 'waifumon',
        slug,
        variant: 'standard',
      });
      expect(resource).not.toHaveProperty('imagePath');
      expect(JSON.stringify(resource)).not.toContain('expansions/');
      // Level gates are earned, not browsed: a locked appearance must not hand
      // out the id that would fetch its artwork.
      for (const entry of resource.appearances.slice(1)) {
        expect(entry.assetId).toBeNull();
      }
    },
  );

  it.each(pack.map((s) => [s.slug, s] as const))(
    '%s has a file on disk for every declared appearance',
    (slug, species) => {
      // `assets/waifumon/<slug>/<variant>.png` is the only runtime convention;
      // a declared variant with no file is an unlockable that renders nothing.
      for (const appearance of resolveAppearances(species)) {
        const file = path.join(ASSETS_DIR, 'waifumon', slug, `${appearance.id}.png`);
        expect(fs.existsSync(file), file).toBe(true);
      }
    },
  );
});
