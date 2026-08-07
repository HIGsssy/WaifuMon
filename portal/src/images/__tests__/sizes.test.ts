/**
 * Size negotiation (plan §12).
 *
 * Source art is ~4.5 MB per file and a grid tile is 256 px wide, so which
 * rendition a call site gets is not a cosmetic detail — it is the difference
 * between a 1.2 MB collection page and a 106 MB one, and on a shared HTTP/1.1
 * origin it is the difference between the API answering and timing out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalDevAssetsProvider } from '../providers/localDevAssets';
import { createApiSuppliedUrlProvider } from '../providers/apiSuppliedUrl';
import { createPlatformCdnProvider } from '../providers/platformCdn';
import { createSilhouetteProvider } from '../providers/silhouette';
import { bucketForWidth, resolveAsset, setImageProviderChain } from '../provider';
import { ARTWORK_WIDTH } from '../sizes';
import { assetKey, bucketFor, IMAGE_SIZE_BUCKETS } from '../types';

/** jsdom reports 1; the tests that care about density set it explicitly. */
function withPixelRatio(ratio: number, run: () => void): void {
  const original = window.devicePixelRatio;
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('size buckets', () => {
  it('serves the original when no width is given', () => {
    // Omitting the hint has to keep meaning "full resolution" — some views
    // genuinely want it, and a silent downgrade would be the wrong default.
    expect(bucketFor(undefined)).toBeNull();
    expect(bucketFor(0)).toBeNull();
    expect(bucketFor(Number.NaN)).toBeNull();
  });

  it('picks the smallest bucket that covers the rendered size', () => {
    withPixelRatio(1, () => {
      expect(bucketFor(100)).toBe(256);
      expect(bucketFor(256)).toBe(256);
      expect(bucketFor(257)).toBe(512);
      expect(bucketFor(1024)).toBe(1024);
    });
  });

  it('accounts for screen density so retina art is not soft', () => {
    withPixelRatio(2, () => {
      expect(bucketFor(ARTWORK_WIDTH.gridTile)).toBe(512);
      expect(bucketFor(ARTWORK_WIDTH.avatar)).toBe(256);
    });
  });

  it('caps the density multiplier so a 3× phone does not fetch the original', () => {
    // Past 2× the extra pixels are not visible on photographic art, but the
    // bytes are very much real.
    withPixelRatio(3, () => {
      expect(bucketFor(ARTWORK_WIDTH.gridTile)).toBe(512);
    });
  });

  it('never exceeds the largest published rendition', () => {
    const largest = IMAGE_SIZE_BUCKETS[IMAGE_SIZE_BUCKETS.length - 1];
    withPixelRatio(2, () => {
      expect(bucketFor(4000)).toBe(largest);
    });
  });

  it('keeps two sizes of one asset as two cache entries', () => {
    expect(assetKey({ kind: 'species', slug: 'nyx' }, 256)).not.toBe(
      assetKey({ kind: 'species', slug: 'nyx' }, 1024),
    );
  });
});

describe('the local dev-assets provider at a size', () => {
  it('points at the rendition route when a bucket is requested', () => {
    const resolved = createLocalDevAssetsProvider().resolve({ kind: 'species', slug: 'nyx' }, 512);
    expect(resolved?.url).toBe('/dev-assets/t/512/waifumon/nyx/standard.png');
  });

  it('points at the original when none is', () => {
    const resolved = createLocalDevAssetsProvider().resolve({ kind: 'species', slug: 'nyx' });
    expect(resolved?.url).toBe('/dev-assets/waifumon/nyx/standard.png');
  });

  it('keeps the variant in the rendition path', () => {
    const resolved = createLocalDevAssetsProvider().resolve(
      { kind: 'species', slug: 'nyx', variant: 'holo' },
      256,
    );
    expect(resolved?.url).toBe('/dev-assets/t/256/waifumon/nyx/holo.png');
  });
});

describe('the CDN provider at a size', () => {
  it('puts the size in the path, where a CDN caches it without configuration', () => {
    const provider = createPlatformCdnProvider({ baseUrl: 'https://cdn.example.com/waifumon' });
    expect(provider.resolve({ kind: 'species', slug: 'nyx' }, 512)?.url).toBe(
      'https://cdn.example.com/waifumon/nyx/standard@512.webp',
    );
  });
});

describe('the API-supplied URL provider at a size', () => {
  it('asks Discord for an avatar at the size it will be drawn', () => {
    const provider = createApiSuppliedUrlProvider();
    const resolved = provider.resolve(
      { kind: 'avatar', slug: 'player_1', href: 'https://cdn.discordapp.com/avatars/1/abc.png' },
      256,
    );
    expect(resolved?.url).toContain('size=256');
  });

  it('leaves a non-Discord host alone rather than guessing its API', () => {
    const provider = createApiSuppliedUrlProvider();
    const resolved = provider.resolve(
      { kind: 'avatar', slug: 'player_1', href: 'https://example.com/a.png' },
      256,
    );
    expect(resolved?.url).toBe('https://example.com/a.png');
  });
});

describe('resolveAsset with a width hint', () => {
  it('memoises each size separately instead of one clobbering the other', () => {
    setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);

    withPixelRatio(1, () => {
      const tile = resolveAsset({ kind: 'species', slug: 'nyx' }, { displayWidth: 256 });
      const hero = resolveAsset({ kind: 'species', slug: 'nyx' }, { displayWidth: 1024 });
      const full = resolveAsset({ kind: 'species', slug: 'nyx' });

      expect(tile.url).toContain('/t/256/');
      expect(hero.url).toContain('/t/1024/');
      expect(full.url).toBe('/dev-assets/waifumon/nyx/standard.png');
    });
  });

  it('exposes the bucket it would choose, so call sites can be audited', () => {
    withPixelRatio(1, () => {
      expect(bucketForWidth(ARTWORK_WIDTH.strip)).toBe(256);
      expect(bucketForWidth(ARTWORK_WIDTH.hero)).toBe(512);
    });
  });
});
