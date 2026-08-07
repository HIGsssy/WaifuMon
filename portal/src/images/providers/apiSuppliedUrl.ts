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
import type { AssetId, ImageProvider, ImageSizeBucket, ResolvedImage } from '../types';

export const API_SUPPLIED_URL_ID = 'apiSuppliedUrl';

/** Discord's CDN sizes are powers of two; anything else is rejected outright. */
const DISCORD_CDN_HOST = 'cdn.discordapp.com';
const DISCORD_SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Ask Discord for an avatar at the size we are about to draw it.
 *
 * A default avatar URL serves 1024×1024 — around 100 KB for something rendered
 * at 64 px in the header. Discord resizes at the edge via `?size=`, so this is
 * free bandwidth back. Applied only to Discord's own CDN: adding a query
 * parameter to an arbitrary host is at best ignored and at worst a cache miss.
 */
function withDiscordSize(url: URL, bucket: ImageSizeBucket | null): string {
  if (bucket === null || url.hostname !== DISCORD_CDN_HOST) return url.toString();

  const size = DISCORD_SIZES.find((candidate) => candidate >= bucket);
  if (size === undefined) return url.toString();

  const sized = new URL(url);
  sized.searchParams.set('size', String(size));
  return sized.toString();
}

export function createApiSuppliedUrlProvider(): ImageProvider {
  return {
    id: API_SUPPLIED_URL_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      const href = id.href;
      if (typeof href !== 'string' || href.length === 0) return null;

      const url = parseHttpsUrl(href);
      if (!url) return null;

      return {
        url: withDiscordSize(url, bucket),
        isFallback: false,
        providerId: API_SUPPLIED_URL_ID,
      };
    },
  };
}
