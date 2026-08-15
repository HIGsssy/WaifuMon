/**
 * The `cardApi` provider (plan §12).
 *
 * A card is the first asset kind with no file behind it — it is composed by the
 * API on request — so this provider derives a *route* where the others derive a
 * path. The tests below are mostly about it staying in its lane: answering
 * every card, claiming nothing else, and never emitting anything that looks
 * like a filesystem location.
 */
import { describe, expect, it } from 'vitest';

import { CARD_API_ID, cardUrlFor, createCardApiProvider } from '../providers/cardApi';
import { ownedCardAsset, speciesCardAsset } from '../assets';
import type { AssetId } from '../types';

const provider = createCardApiProvider();

const speciesCard: AssetId = { kind: 'card', slug: 'alley_catgirl' };
const withVariant: AssetId = { kind: 'card', slug: 'alley_catgirl', variant: 'level_20' };
const ownedCard: AssetId = {
  kind: 'card',
  slug: 'alley_catgirl',
  variant: 'level_20',
  owned: { playerId: 1, waifuId: 77 },
};

describe('claiming', () => {
  it('answers card assets', () => {
    const resolved = provider.resolve(speciesCard);
    expect(resolved).toMatchObject({ isFallback: false, providerId: CARD_API_ID });
  });

  it('declines every other kind, so artwork resolution is untouched', () => {
    for (const kind of ['species', 'waifumon', 'item', 'avatar', 'ui'] as const) {
      expect(provider.resolve({ kind, slug: 'alley_catgirl' }), kind).toBeNull();
    }
  });

  it('declines a card whose slug is not a content slug', () => {
    for (const slug of ['../../etc/passwd', 'Alley Catgirl', 'a/b', '']) {
      expect(provider.resolve({ kind: 'card', slug }), slug).toBeNull();
    }
  });

  it('declines a card whose variant is not an appearance id', () => {
    expect(provider.resolve({ kind: 'card', slug: 'ok_slug', variant: '../x' })).toBeNull();
  });

  it('declines an owned card with unusable ids', () => {
    for (const owned of [
      { playerId: 0, waifuId: 1 },
      { playerId: 1, waifuId: -3 },
      { playerId: 1.5, waifuId: 2 },
    ]) {
      expect(provider.resolve({ kind: 'card', slug: 'ok_slug', owned }), JSON.stringify(owned)).toBeNull();
    }
  });
});

describe('species preview route', () => {
  it('addresses the species card endpoint', () => {
    expect(cardUrlFor(speciesCard)).toBe('/api/v1/cards/species/alley_catgirl');
  });

  it('passes the appearance through as variant', () => {
    expect(cardUrlFor(withVariant)).toBe(
      '/api/v1/cards/species/alley_catgirl?variant=level_20',
    );
  });

  it('turns a size bucket into width', () => {
    expect(cardUrlFor(withVariant, 512)).toBe(
      '/api/v1/cards/species/alley_catgirl?width=512&variant=level_20',
    );
  });

  it('omits width for the master, which is what no width means', () => {
    expect(cardUrlFor(speciesCard, null)).not.toContain('width');
  });

  it('serves each bucket from its own URL', () => {
    const urls = ([256, 512, 1024] as const).map((bucket) => cardUrlFor(speciesCard, bucket));
    expect(new Set(urls).size).toBe(3);
    expect(urls[0]).toContain('width=256');
    expect(urls[2]).toContain('width=1024');
  });
});

describe('owned copy route', () => {
  it('addresses the owned card endpoint', () => {
    expect(cardUrlFor(ownedCard)).toBe('/api/v1/players/1/collection/owned/77/card');
  });

  it('sends no level or variant — the server owns both', () => {
    const url = cardUrlFor(ownedCard, 512) ?? '';
    expect(url).toContain('width=512');
    expect(url).not.toContain('variant');
    expect(url).not.toContain('level');
  });

  it('is a different URL per player and per copy', () => {
    const other = cardUrlFor({ ...ownedCard, owned: { playerId: 2, waifuId: 77 } });
    expect(other).not.toBe(cardUrlFor(ownedCard));
  });
});

describe('no path leaks', () => {
  it('never emits a filesystem-shaped URL', () => {
    for (const asset of [speciesCard, withVariant, ownedCard]) {
      for (const bucket of [null, 256, 512, 1024] as const) {
        const url = cardUrlFor(asset, bucket) ?? '';
        expect(url.startsWith('/api/')).toBe(true);
        expect(url).not.toContain('dev-assets');
        expect(url).not.toContain('assets/');
        expect(url).not.toContain('.png');
        expect(url).not.toContain('.webp');
      }
    }
  });
});

describe('the asset helpers feed it correctly', () => {
  const species = {
    slug: 'alley_catgirl',
    appearances: [
      {
        id: 'standard',
        unlock: { type: 'owned' as const },
        assetId: { kind: 'waifumon' as const, slug: 'alley_catgirl', variant: 'standard' },
      },
    ],
  };

  it('speciesCardAsset produces a card the provider can address', () => {
    const asset = speciesCardAsset(species as never);
    expect(asset.kind).toBe('card');
    expect(asset.owned).toBeUndefined();
    expect(cardUrlFor(asset)).toBe('/api/v1/cards/species/alley_catgirl?variant=standard');
  });

  it('ownedCardAsset carries the copy, not the level', () => {
    const asset = ownedCardAsset(1, {
      waifu: {
        id: 77,
        selectedAppearance: {
          assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_20' },
        },
      },
      species: { slug: 'alley_catgirl' },
    } as never);

    expect(asset.owned).toEqual({ playerId: 1, waifuId: 77 });
    expect(cardUrlFor(asset)).toBe('/api/v1/players/1/collection/owned/77/card');
  });
});
