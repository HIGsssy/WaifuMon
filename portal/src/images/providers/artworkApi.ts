/**
 * API-backed raw artwork provider.
 *
 * Base/species artwork must work anywhere the authenticated Platform API works,
 * not only while Vite's development-only `/dev-assets` middleware is running.
 * The API chooses the actual appearance and enforces ownership/unlock state;
 * this provider only turns that logical context into a same-origin URL.
 */
import { portalEnv } from '@/lib/env';
import type { AssetId, ImageProvider, ImageSizeBucket, ResolvedImage } from '../types';

export const ARTWORK_API_ID = 'artworkApi';

const SAFE_SLUG = /^[a-z0-9_]+$/;

export function artworkUrlFor(
  id: AssetId,
  bucket: ImageSizeBucket | null = null,
): string | null {
  if (!id.baseArtwork) return null;
  if (id.kind !== 'species' && id.kind !== 'waifumon') return null;
  if (!SAFE_SLUG.test(id.slug)) return null;

  const base = portalEnv.apiUrl;
  const path = id.owned
    ? `${base}/v1/players/${id.owned.playerId}/collection/owned/${id.owned.waifuId}/artwork`
    : `${base}/v1/assets/waifumon/${id.slug}`;
  return bucket === null ? path : `${path}?width=${bucket}`;
}

export function createArtworkApiProvider(): ImageProvider {
  return {
    id: ARTWORK_API_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      const url = artworkUrlFor(id, bucket);
      return url === null ? null : { url, isFallback: false, providerId: ARTWORK_API_ID };
    },
  };
}
