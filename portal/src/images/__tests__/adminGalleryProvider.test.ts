/**
 * The Admin Gallery image identity and provider.
 *
 * Pins the separation both ways: an admin identity resolves only to the
 * `gallery.read`-gated route, and a player identity never does. URLs are built
 * from a slug and an appearance id — never a path, never a token.
 */
import { describe, expect, it } from 'vitest';

import {
  ADMIN_GALLERY_API_ID,
  adminGalleryArtworkUrl,
  createAdminGalleryApiProvider,
} from '../providers/adminGalleryApi';
import { getImageProviderChain, resolveAsset } from '../provider';
import { assetKey, type AssetId } from '../types';

const ADMIN: AssetId = {
  kind: 'waifumon',
  slug: 'alley_catgirl',
  variant: 'level_20',
  adminGallery: true,
};

describe('adminGalleryArtworkUrl', () => {
  it('addresses the secure admin route by species slug and appearance id', () => {
    expect(adminGalleryArtworkUrl('alley_catgirl', 'level_20')).toBe(
      '/api/v1/admin/gallery/species/alley_catgirl/appearances/level_20/artwork',
    );
  });

  it.each([256, 512, 1024] as const)('adds width=%s for a rendition', (width) => {
    expect(adminGalleryArtworkUrl('alley_catgirl', 'level_20', width)).toBe(
      `/api/v1/admin/gallery/species/alley_catgirl/appearances/level_20/artwork?width=${width}`,
    );
  });

  it.each([
    ['../etc', 'standard'],
    ['alley_catgirl', '../standard'],
    ['alley_catgirl', 'waifumon/alley_catgirl/standard.webp'],
    ['Alley', 'standard'],
    ['alley_catgirl', ''],
  ])('refuses anything that is not an identifier: %s / %s', (slug, id) => {
    expect(adminGalleryArtworkUrl(slug, id)).toBeNull();
  });
});

describe('admin gallery provider', () => {
  const provider = createAdminGalleryApiProvider();

  it('claims admin gallery identities', () => {
    expect(provider.resolve(ADMIN, 512)).toEqual({
      url: '/api/v1/admin/gallery/species/alley_catgirl/appearances/level_20/artwork?width=512',
      isFallback: false,
      providerId: ADMIN_GALLERY_API_ID,
    });
  });

  it.each<AssetId>([
    { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_20' },
    { kind: 'species', slug: 'alley_catgirl', baseArtwork: true },
    { kind: 'card', slug: 'alley_catgirl' },
    { kind: 'avatar', slug: 'x', href: 'https://cdn.example/a.png' },
  ])('declines a player identity: %o', (id) => {
    expect(provider.resolve(id, 256)).toBeNull();
  });

  it('answers an invalid admin identity with a marked fallback, never another provider’s URL', () => {
    const resolved = provider.resolve({ ...ADMIN, variant: '../x' }, 256);
    expect(resolved?.isFallback).toBe(true);
    expect(resolved?.url.startsWith('data:')).toBe(true);
  });

  it('never puts a path or a token in the URL', () => {
    const url = provider.resolve(ADMIN, 1024)!.url;
    expect(url).not.toMatch(/\.(webp|png)|assets\/|thumbnails|token|bearer|authorization/i);
  });
});

describe('provider chain', () => {
  it('always puts the admin gallery provider first', () => {
    expect(getImageProviderChain()[0]?.id).toBe(ADMIN_GALLERY_API_ID);
  });

  it('resolves an admin identity to the admin route and a player identity elsewhere', () => {
    expect(resolveAsset(ADMIN, { displayWidth: 256 }).url).toBe(
      '/api/v1/admin/gallery/species/alley_catgirl/appearances/level_20/artwork?width=256',
    );
    const player = resolveAsset(
      { kind: 'species', slug: 'alley_catgirl', baseArtwork: true },
      { displayWidth: 256 },
    );
    expect(player.url).not.toContain('/admin/');
    expect(player.url).toContain('/v1/assets/waifumon/alley_catgirl');
  });

  it('keys admin and player identities apart, and leaves player keys unchanged', () => {
    const player: AssetId = { kind: 'waifumon', slug: 'alley_catgirl', variant: 'level_20' };
    expect(assetKey(player, 256)).toBe('waifumon:alley_catgirl:level_20:::::256');
    expect(assetKey(ADMIN, 256)).toBe('admin-gallery|waifumon:alley_catgirl:level_20:::::256');
  });
});
