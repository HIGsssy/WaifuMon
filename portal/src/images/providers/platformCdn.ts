/**
 * Platform CDN provider — **shipped disabled**, wired for the migration.
 *
 * The point of the whole `AssetId` contract is that moving artwork off local
 * dev assets and onto a CDN or object store is a *consumer-side* change: the
 * Platform API keeps returning `{ kind, slug, variant }` and no response shape,
 * no route, and no other Portal file moves. This provider is that change,
 * written out in advance so the migration is a config flip rather than a
 * design exercise.
 *
 * Enabling it is two steps, both outside this file:
 *   1. set `VITE_ASSET_CDN_URL` to the CDN origin;
 *   2. put `platformCdn` ahead of `artworkApi` in `VITE_IMAGE_PROVIDERS`.
 *
 * Without a configured origin it declines every id, so leaving it in the
 * default chain would be harmless — it is simply not there yet, because v1 has
 * no CDN to point at.
 *
 * Everything a real CDN wants — content hashes, size negotiation, WebP
 * fallbacks, edge routing — belongs *here*, inside the resolver. None of it
 * ever appears in an API response.
 */
import {
  DEFAULT_VARIANT,
  WAIFUMON_ASSET_KINDS,
  type AssetId,
  type ImageProvider,
  type ImageSizeBucket,
  type ResolvedImage,
} from '../types';

export const PLATFORM_CDN_ID = 'platformCdn';

/** Matches the slug rule the API enforces on content (`^[a-z0-9_]+$`). */
const SAFE_SLUG = /^[a-z0-9_]+$/;

export interface PlatformCdnOptions {
  /** Origin, e.g. `https://cdn.example.com/waifumon`. Empty disables the provider. */
  baseUrl?: string | undefined;
}

export function createPlatformCdnProvider(options: PlatformCdnOptions = {}): ImageProvider {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');

  return {
    id: PLATFORM_CDN_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      if (baseUrl.length === 0) return null;
      if (!WAIFUMON_ASSET_KINDS.includes(id.kind)) return null;
      if (!SAFE_SLUG.test(id.slug)) return null;

      const variant = id.variant ?? DEFAULT_VARIANT;
      if (!SAFE_SLUG.test(variant)) return null;

      // Size lives in the path, not a query string: a CDN caches paths without
      // configuration, whereas query-string variance is an origin setting
      // somebody has to remember to turn on.
      const url = bucket
        ? `${baseUrl}/${id.slug}/${variant}@${bucket}.webp`
        : `${baseUrl}/${id.slug}/${variant}.png`;

      return { url, isFallback: false, providerId: PLATFORM_CDN_ID };
    },
  };
}
