/**
 * Local dev-assets provider — development-only filesystem fallback (plan §12).
 *
 * The Vite dev server mounts the bot repo's `assets/` directory at
 * `/dev-assets/*` (see vite.config.ts), so a species resolves to
 * `/dev-assets/waifumon/<slug>/<variant>.png` — exactly the layout the content
 * files already use in their `imagePath` field.
 *
 * **Why derive the path rather than read `imagePath`?** §12's last rule: the
 * API's `imagePath` is an internal detail and must not leak into pages. Feeding
 * it through the resolver would mean every call site carried a physical path
 * around, which is the coupling the resolver exists to prevent. Deriving from
 * the slug keeps the URL deterministic and cache-friendly, and a species whose
 * author chose a non-conventional path simply falls through to the silhouette —
 * a missing image never breaks a layout.
 *
 * §25.3's Platform API image endpoint replaces this provider outright, and that
 * migration is a one-line change to the chain in `provider.ts`.
 *
 * Items have no artwork in the content model at all today (they carry an
 * `emoji`, not an `imagePath`), so item ids are declined here and always land
 * on the silhouette. Filed as API feedback — see docs/portal.md.
 */
import {
  DEFAULT_VARIANT,
  WAIFUMON_ASSET_KINDS,
  type AssetId,
  type ImageProvider,
  type ImageSizeBucket,
  type ResolvedImage,
} from '../types';

export const LOCAL_DEV_ASSETS_ID = 'localDevAssets';

/** Matches the slug rule the API enforces on content (`^[a-z0-9_]+$`). */
const SAFE_SLUG = /^[a-z0-9_]+$/;

/**
 * Path segment the dev server's asset route recognises as a size request.
 *
 * `/dev-assets/t/512/waifumon/<slug>/<variant>.png` means "the 512-wide
 * rendition of this asset". The dev server serves the pre-generated WebP if one
 * exists and quietly falls back to the original file if not, setting the
 * Content-Type from whichever it actually sends — so the `.png` in the URL is a
 * logical name, never a promise about the bytes. That fallback is what lets
 * this ship before anyone has run the thumbnail script.
 */
const SIZE_PREFIX = 't';

export function createLocalDevAssetsProvider(basePath = '/dev-assets'): ImageProvider {
  return {
    id: LOCAL_DEV_ASSETS_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      // Accepts both the Portal's own `species` kind and the API's `waifumon`
      // — they name the same artwork.
      if (!WAIFUMON_ASSET_KINDS.includes(id.kind)) return null;
      if (!SAFE_SLUG.test(id.slug)) return null;

      const variant = id.variant ?? DEFAULT_VARIANT;
      if (!SAFE_SLUG.test(variant)) return null;

      const asset = `waifumon/${id.slug}/${variant}.png`;
      const url = bucket ? `${basePath}/${SIZE_PREFIX}/${bucket}/${asset}` : `${basePath}/${asset}`;

      return { url, isFallback: false, providerId: LOCAL_DEV_ASSETS_ID };
    },
  };
}
