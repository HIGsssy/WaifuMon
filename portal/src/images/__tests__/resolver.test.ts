/**
 * Image resolver contract (plan §22.4).
 *
 * Covers the three properties pages depend on without knowing it: the chain
 * order decides the URL, the silhouette always answers, and URLs are stable for
 * a given asset so the browser and any future CDN can cache them.
 */
import { describe, expect, it } from 'vitest';

import { createLocalDevAssetsProvider, LOCAL_DEV_ASSETS_ID } from '../providers/localDevAssets';
import { createSilhouetteProvider, SILHOUETTE_ID, silhouetteUrl } from '../providers/silhouette';
import { fallbackFor, resolveAsset, setImageProviderChain } from '../provider';

describe('the local dev-assets provider', () => {
  const provider = createLocalDevAssetsProvider();

  it('derives the repo asset layout from the slug', () => {
    expect(provider.resolve({ kind: 'species', slug: 'neon_kitsune' })).toEqual({
      url: '/dev-assets/waifumon/neon_kitsune/standard.png',
      isFallback: false,
      providerId: LOCAL_DEV_ASSETS_ID,
    });
  });

  it('honours a non-default variant', () => {
    expect(provider.resolve({ kind: 'species', slug: 'neon_kitsune', variant: 'holo' })?.url).toBe(
      '/dev-assets/waifumon/neon_kitsune/holo.png',
    );
  });

  it('declines kinds it has no artwork for, so the chain continues', () => {
    // Items carry an emoji, not an image path — see docs/portal.md API feedback.
    expect(provider.resolve({ kind: 'item', slug: 'basic_charm' })).toBeNull();
    expect(provider.resolve({ kind: 'avatar', slug: 'trainer' })).toBeNull();
  });

  it('declines a slug that could escape the asset root', () => {
    expect(provider.resolve({ kind: 'species', slug: '../../etc/passwd' })).toBeNull();
    expect(provider.resolve({ kind: 'species', slug: 'ok', variant: '../secret' })).toBeNull();
  });
});

describe('the silhouette provider', () => {
  it('always answers, and marks itself as a fallback', () => {
    // Typed as a `TerminalImageProvider`, so this is non-null by construction.
    const resolved = createSilhouetteProvider().resolve({ kind: 'item', slug: 'anything' });
    expect(resolved.isFallback).toBe(true);
    expect(resolved.providerId).toBe(SILHOUETTE_ID);
    expect(resolved.url.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('is deterministic for a given slug', () => {
    expect(silhouetteUrl('neon_kitsune')).toBe(silhouetteUrl('neon_kitsune'));
    expect(silhouetteUrl('neon_kitsune')).not.toBe(silhouetteUrl('void_empress'));
  });
});

describe('the provider chain', () => {
  it('prefers the first provider that answers', () => {
    setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);
    const resolved = resolveAsset({ kind: 'species', slug: 'void_empress' });
    expect(resolved.providerId).toBe(LOCAL_DEV_ASSETS_ID);
    expect(resolved.isFallback).toBe(false);
  });

  it('falls through to the silhouette when nothing else can answer', () => {
    setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);
    const resolved = resolveAsset({ kind: 'item', slug: 'basic_charm' });
    expect(resolved.providerId).toBe(SILHOUETTE_ID);
    expect(resolved.isFallback).toBe(true);
  });

  it('still answers when a caller installs a chain with no terminator', () => {
    setImageProviderChain([createLocalDevAssetsProvider()]);
    expect(resolveAsset({ kind: 'ui', slug: 'splash' }).isFallback).toBe(true);
  });

  it('produces a stable URL for the same asset', () => {
    setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);
    const first = resolveAsset({ kind: 'species', slug: 'neko_barista' }).url;
    const second = resolveAsset({ kind: 'species', slug: 'neko_barista' }).url;
    expect(first).toBe(second);
  });

  it('offers the silhouette as the runtime fallback for any asset', () => {
    expect(fallbackFor({ kind: 'species', slug: 'neko_barista' }).isFallback).toBe(true);
  });
});
