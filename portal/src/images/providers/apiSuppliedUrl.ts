/**
 * API-supplied URL provider — first in the chain (plan §12).
 *
 * Honours `AssetId.href`, the absolute URL the Platform API itself returned for
 * an asset. Today that is only `player.identity.avatarUrl` (a Discord CDN
 * link), which no provider could derive from a slug because it embeds an avatar
 * hash the Portal never sees.
 *
 * Only `https:` URLs are accepted. A `data:`, `javascript:` or relative value
 * arriving in an API field would be a contract violation on the API's side, and
 * the right answer to one is the silhouette — not rendering it.
 */
import type { AssetId, ImageProvider, ResolvedImage } from '../types';

export const API_SUPPLIED_URL_ID = 'apiSuppliedUrl';

function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function createApiSuppliedUrlProvider(): ImageProvider {
  return {
    id: API_SUPPLIED_URL_ID,
    resolve(id: AssetId): ResolvedImage | null {
      const href = id.href;
      if (typeof href !== 'string' || href.length === 0) return null;
      if (!isSafeHttpsUrl(href)) return null;

      return { url: href, isFallback: false, providerId: API_SUPPLIED_URL_ID };
    },
  };
}
