/**
 * Shared, non-visual pieces of the managed-artwork editors.
 */
import { useQuery } from '@tanstack/react-query';

import {
  ARTWORK_ASSETS_QUERY_KEY,
  FALLBACK_ARTWORK_META,
  formatBytes,
  getArtworkAsset,
  type ArtworkAsset,
} from '@/api/adminArtworkAssets';
import { isPortalApiError } from '@/api/client';

export function assetSummary(asset: ArtworkAsset): string {
  const type = asset.mimeType.replace('image/', '').toUpperCase();
  return `${asset.width}×${asset.height} · ${type} · ${formatBytes(asset.fileSize)}${asset.hasAlpha ? ' · transparent' : ''}`;
}

export const ACCEPTED_UPLOAD_TYPES = FALLBACK_ARTWORK_META.mimeTypes.join(',');

/** What went wrong with an upload, in the server's own words where it has some. */
export function describeUploadError(error: unknown): string {
  if (isPortalApiError(error)) {
    if (error.status === 413) {
      return `That file is too large — the limit is ${formatBytes(FALLBACK_ARTWORK_META.maxBytes)}.`;
    }
    if (error.status === 403) return 'You do not have permission to upload artwork.';
    if (error.isTransportError) return 'Could not reach the server. Try again in a moment.';
    // A server that does not know the route yet (an older API build) answers 404.
    if (error.status === 404)
      return `The server has no upload route (HTTP 404, ${error.code}) — is the API up to date?`;
    if (error.message) return `${error.message} (${error.code}, HTTP ${error.status})`;
  }
  return 'The upload failed.';
}

/** The asset behind an id, cached; `undefined` while loading, `null` when it no longer exists. */
export function useArtworkAsset(id: string | null): ArtworkAsset | null | undefined {
  const query = useQuery({
    queryKey: [...ARTWORK_ASSETS_QUERY_KEY, 'asset', id],
    queryFn: async ({ signal }) => (await getArtworkAsset(id!, signal)).asset,
    enabled: id !== null,
    retry: false,
    staleTime: 30_000,
  });
  if (id === null) return null;
  if (query.isError) return null;
  return query.data;
}
