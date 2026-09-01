import { describe, expect, it } from 'vitest';
import type { ContentSpecies, OwnedWaifu } from '@/api/types';
import { speciesAsset } from '../assets';
import { ARTWORK_API_ID, artworkUrlFor, createArtworkApiProvider } from '../providers/artworkApi';

function species(slug: string): ContentSpecies {
  return {
    slug,
    name: slug,
    rarity: 'R',
    archetype: 'spirit',
    affinity: 'switch',
    contentRating: 'suggestive',
    description: '',
    tags: [],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances: [
      {
        id: 'standard',
        name: 'Standard',
        description: null,
        flavorText: null,
        cosmeticRarity: 'standard',
        introducedVersion: null,
        assetId: { kind: 'waifumon', slug, variant: 'standard' },
        unlock: { type: 'owned' },
        unlockLabel: 'Owned',
      },
    ],
  };
}

describe('API-backed base artwork', () => {
  const provider = createArtworkApiProvider();

  it('loads starter species through the authenticated API origin', () => {
    expect(provider.resolve(speciesAsset(species('alley_catgirl')), 512)).toEqual({
      url: '/api/v1/assets/waifumon/alley_catgirl?width=512',
      isFallback: false,
      providerId: ARTWORK_API_ID,
    });
  });

  it('loads expansion species through the identical canonical rule', () => {
    const url = artworkUrlFor(speciesAsset(species('onsen_maid')), 512);
    expect(url).toBe('/api/v1/assets/waifumon/onsen_maid?width=512');
    expect(url).not.toContain('assets/assets');
    expect(url).not.toContain('expansions/');
  });

  it('resolves an owned copy server-side instead of trusting its variant', () => {
    const subject = species('onsen_maid');
    const selected = {
      ...subject.appearances[0]!,
      isUnlocked: true,
      isSelected: true,
    };
    const waifu = { id: 77, playerId: 3, variant: 'standard', selectedAppearance: selected } as OwnedWaifu;

    expect(artworkUrlFor(speciesAsset(subject, waifu), 256)).toBe(
      '/api/v1/players/3/collection/owned/77/artwork?width=256',
    );
  });

  it('does not claim gallery appearances or reconstruct locked artwork', () => {
    expect(
      provider.resolve({ kind: 'waifumon', slug: 'onsen_maid', variant: 'level_20' }),
    ).toBeNull();
  });
});
