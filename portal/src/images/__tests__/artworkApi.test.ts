import { describe, expect, it } from 'vitest';
import type { Appearance, ContentSpecies, OwnedWaifu } from '@/api/types';
import { appearanceArtworkAsset, speciesAsset } from '../assets';
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
    const waifu = {
      id: 77,
      playerId: 3,
      variant: 'standard',
      selectedAppearance: selected,
    } as OwnedWaifu;

    expect(artworkUrlFor(speciesAsset(subject, waifu), 256)).toBe(
      '/api/v1/players/3/collection/owned/77/artwork?width=256&selected=standard',
    );
  });

  it('uses the selected appearance only as an owned-artwork cache discriminator', () => {
    const subject = species('onsen_maid');
    const selected = {
      ...subject.appearances[0]!,
      assetId: { kind: 'waifumon' as const, slug: 'onsen_maid', variant: 'level_20' },
      isUnlocked: true,
      isSelected: true,
    };
    const waifu = {
      id: 77,
      playerId: 3,
      variant: 'level_20',
      selectedAppearance: selected,
    } as OwnedWaifu;

    expect(artworkUrlFor(speciesAsset(subject, waifu), 512)).toBe(
      '/api/v1/players/3/collection/owned/77/artwork?width=512&selected=level_20',
    );
  });

  it('does not claim gallery appearances or reconstruct locked artwork', () => {
    expect(
      provider.resolve({ kind: 'waifumon', slug: 'onsen_maid', variant: 'level_20' }),
    ).toBeNull();
  });
});

describe('gallery appearance artwork', () => {
  function appearance(id: string, variant: string, isUnlocked = true): Appearance {
    return {
      id,
      name: id,
      description: null,
      flavorText: null,
      cosmeticRarity: 'standard',
      introducedVersion: null,
      assetId: isUnlocked ? { kind: 'waifumon', slug: 'bimbo_valkyrie', variant } : null,
      unlock: id === 'standard' ? { type: 'owned' } : { type: 'level', atLevel: 10 },
      unlockLabel: id === 'standard' ? 'Owned' : 'Reach Level 10',
      isUnlocked,
      isSelected: false,
    };
  }

  it('routes each unlocked tile through the same owned-artwork helper as the hero', () => {
    const asset = appearanceArtworkAsset(3, 77, appearance('level_10', 'level_10'));
    expect(asset).not.toBeNull();
    // Same authenticated owned route the hero resolves through — no second
    // image architecture, just this tile's own appearance id as the selector.
    expect(artworkUrlFor(asset!, 256)).toBe(
      '/api/v1/players/3/collection/owned/77/artwork?width=256&appearance=level_10',
    );
  });

  it('gives every appearance a distinct URL keyed by its own id, never the worn look', () => {
    const urls = ['standard', 'level_10', 'level_20', 'level_30'].map((id) => {
      const asset = appearanceArtworkAsset(3, 77, appearance(id, id));
      return artworkUrlFor(asset!, 256);
    });

    // Six-of-one regression guard: no two tiles collapse to one URL, and none
    // of them is the bare `standard` hero URL.
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      expect(url).toContain('/owned/77/artwork');
      expect(url).not.toContain('selected=');
    }
    expect(urls[0]).toContain('appearance=standard');
    expect(urls[1]).toContain('appearance=level_10');
  });

  it('names no URL for a locked appearance — the API withheld its assetId', () => {
    const locked = appearanceArtworkAsset(3, 77, appearance('level_40', 'level_40', false));
    expect(locked).toBeNull();
  });

  it('is not the hero’s worn-artwork URL: the hero uses selected, a tile uses appearance', () => {
    const subject = species('bimbo_valkyrie');
    const waifu = {
      id: 77,
      playerId: 3,
      variant: 'level_30',
      selectedAppearance: {
        ...subject.appearances[0]!,
        assetId: { kind: 'waifumon' as const, slug: 'bimbo_valkyrie', variant: 'level_30' },
        isUnlocked: true,
        isSelected: true,
      },
    } as OwnedWaifu;

    const hero = artworkUrlFor(speciesAsset(subject, waifu), 256);
    const tile = artworkUrlFor(appearanceArtworkAsset(3, 77, appearance('level_10', 'level_10'))!, 256);

    expect(hero).toContain('selected=level_30');
    expect(tile).toContain('appearance=level_10');
    expect(hero).not.toBe(tile);
  });
});
