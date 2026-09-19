/**
 * Admin Waifumon Gallery artwork provider.
 *
 * Claims only identities marked `adminGallery: true` and answers with the
 * `gallery.read`-gated route that serves **exactly** the named appearance:
 *
 *   `/api/v1/admin/gallery/species/<slug>/appearances/<appearance>/artwork?width=<bucket>`
 *
 * The URL is built from two logical ids the gallery API returned — never a
 * path, a storage stem or a token. The browser authenticates it with the
 * Portal session cookie like any same-origin request.
 *
 * It is prepended to every provider chain (see `provider.ts`), so a marked
 * identity can never fall through to a player provider: an invalid one
 * resolves to the silhouette marked as a fallback rather than to, say, the
 * development asset server.
 */
import { portalEnv } from '@/lib/env';

import type { AssetId, ImageProvider, ImageSizeBucket, ResolvedImage } from '../types';
import { createSilhouetteProvider } from './silhouette';

export const ADMIN_GALLERY_API_ID = 'adminGalleryApi';

/** The server's identifier rule for slugs and appearance ids. */
const SAFE_ID = /^[a-z0-9_]+$/;

/**
 * The secure admin artwork URL for one appearance, or `null` for ids that are
 * not valid identifiers. `width` omitted (or `null`) is the original file —
 * only ever requested on an explicit admin action.
 */
export function adminGalleryArtworkUrl(
  slug: string,
  appearanceId: string,
  width: ImageSizeBucket | null = null,
): string | null {
  if (!SAFE_ID.test(slug) || !SAFE_ID.test(appearanceId)) return null;
  const path = `${portalEnv.apiUrl}/v1/admin/gallery/species/${slug}/appearances/${appearanceId}/artwork`;
  return width === null ? path : `${path}?width=${width}`;
}

export function createAdminGalleryApiProvider(): ImageProvider {
  return {
    id: ADMIN_GALLERY_API_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      if (id.adminGallery !== true) return null;
      const url =
        id.kind === 'waifumon' || id.kind === 'species'
          ? adminGalleryArtworkUrl(id.slug, id.variant ?? '', bucket)
          : null;
      if (url === null) {
        return {
          url: createSilhouetteProvider().resolve(id).url,
          isFallback: true,
          providerId: ADMIN_GALLERY_API_ID,
        };
      }
      return { url, isFallback: false, providerId: ADMIN_GALLERY_API_ID };
    },
  };
}
