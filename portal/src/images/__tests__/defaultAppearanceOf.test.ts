import { describe, expect, it } from 'vitest';
import type { AppearanceCatalogEntry, ContentSpecies } from '@/api/types';
import { defaultAppearanceOf, speciesAsset } from '../assets';

function entry(id: string, unlock: AppearanceCatalogEntry['unlock']): AppearanceCatalogEntry {
  return {
    id,
    name: id,
    description: null,
    flavorText: null,
    cosmeticRarity: id === 'standard' ? 'standard' : 'seasonal',
    introducedVersion: null,
    assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: id },
    unlock,
    unlockLabel: 'Owned',
  };
}

function species(appearances: AppearanceCatalogEntry[]): ContentSpecies {
  return {
    slug: 'alley_catgirl',
    name: 'Alley Catgirl',
    rarity: 'R',
    archetype: 'spirit',
    race: 'spirit',
    affinity: 'switch',
    contentRating: 'suggestive',
    description: '',
    tags: [],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances,
  };
}

describe('defaultAppearanceOf with several owned entries', () => {
  // The seasonal skin comes first, so only an id match keeps `standard` the default.
  const seasonal = species([
    entry('halloween_spider', { type: 'owned' }),
    entry('standard', { type: 'owned' }),
    entry('level_10', { type: 'level', atLevel: 10 }),
  ]);

  it('picks `standard` by id, not by position', () => {
    expect(defaultAppearanceOf(seasonal)?.id).toBe('standard');
    expect(speciesAsset(seasonal)).toMatchObject({ variant: 'standard' });
  });

  it('still answers a lone owned entry whatever its id', () => {
    const single = species([entry('level_10', { type: 'level', atLevel: 10 }), entry('base', { type: 'owned' })]);
    expect(defaultAppearanceOf(single)?.id).toBe('base');
  });
});
