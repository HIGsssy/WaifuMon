import { describe, expect, it } from 'vitest';
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
