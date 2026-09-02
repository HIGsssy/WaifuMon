/**
 * Rendered-card provider — the only source of `kind: 'card'` (plan §12).
 *
 * Cards are not files on disk; they are composed on request by the Platform
 * API and cached there. So unlike `localDevAssets`, which derives a path from a
 * slug, this provider derives a *route*:
 *
 *   species preview   /api/v1/cards/species/<slug>?variant=&width=
 *   an owned copy     /api/v1/players/<p>/collection/owned/<w>/card?width=
 *
 * The owned route takes no level or variant parameter on purpose. The server
 * already knows what level she is and what she is wearing; sending the Portal's
 * copy of those would be gameplay state reconstructed on the client, wrong the
 * moment she levels up in another tab.
 *
 * **Size.** The resolver's bucket becomes `?width=`, so a 512 px hero downloads
 * the 512 px derivative instead of the full-resolution master. The API derives
 * that by resizing its own cached master — asking for a bucket costs no extra
 * render.
 *
 * **Auth.** These routes need the Platform API's bearer token, which an `<img>`
 * element cannot send. In development the Vite proxy attaches it (see
 * `vite.config.ts`); the export path uses the authenticated client instead.
 * That is why this provider emits a same-origin path rather than an absolute
 * URL — it must stay on the origin the proxy fronts.
 */
import { portalEnv } from '@/lib/env';
import type { AssetId, ImageProvider, ImageSizeBucket, ResolvedImage } from '../types';

export const CARD_API_ID = 'cardApi';

/** Matches the slug rule the API enforces on content (`^[a-z0-9_]+$`). */
const SAFE_SLUG = /^[a-z0-9_]+$/;

/** Appearance ids follow the same rule. */
const SAFE_VARIANT = /^[a-z0-9_]+$/;

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * The card route for an asset, or `null` when the asset is not a card this
 * provider can address. Exported for the export/download flow, which needs the
 * same URL but fetches it with credentials rather than handing it to an `<img>`.
 */
export function cardUrlFor(id: AssetId, bucket: ImageSizeBucket | null = null): string | null {
  if (id.kind !== 'card') return null;
  if (!SAFE_SLUG.test(id.slug)) return null;

  const base = portalEnv.apiUrl;
  const params = new URLSearchParams();
  // A null bucket means "the original" - the card's full-resolution master -
  // and omitting `width` is exactly how the API says that. Every bucket
  // (256/512/1024) is a genuine downscale the API derives from that master.
  if (bucket !== null) params.set('width', String(bucket));

  let path: string;
  if (id.owned) {
    const { playerId, waifuId } = id.owned;
    if (!isPositiveInt(playerId) || !isPositiveInt(waifuId)) return null;
    if (id.variant !== undefined) {
      if (!SAFE_VARIANT.test(id.variant)) return null;
      params.set('selected', id.variant);
    }
    path = `${base}/v1/players/${playerId}/collection/owned/${waifuId}/card`;
  } else {
    // The species preview may name an appearance; the owned route may not,
    // because the copy's own equipped look is authoritative there.
    if (id.variant !== undefined) {
      if (!SAFE_VARIANT.test(id.variant)) return null;
      params.set('variant', id.variant);
    }
    path = `${base}/v1/cards/species/${id.slug}`;
  }

  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

export function createCardApiProvider(): ImageProvider {
  return {
    id: CARD_API_ID,
    resolve(id: AssetId, bucket: ImageSizeBucket | null = null): ResolvedImage | null {
      const url = cardUrlFor(id, bucket);
      if (url === null) return null;
      return { url, isFallback: false, providerId: CARD_API_ID };
    },
  };
}
