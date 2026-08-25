/**
 * Provider selection and the resolve entry point (plan §12).
 *
 * The chain is tried in order and the first non-null answer wins. The
 * silhouette provider is appended unconditionally, so `resolveAsset` is total —
 * there is no "image failed to resolve" branch for a page to handle.
 *
 * The chain is env-driven (`VITE_IMAGE_PROVIDERS`) purely so a developer can
 * force the silhouette path while working on empty states. Adding the §25.3 API
 * endpoint provider or a §25.10 CDN provider is a new entry in `FACTORIES` plus
 * a default-order change — no page or component is touched.
 */
import { portalEnv } from '@/lib/env';
import { API_SUPPLIED_URL_ID, createApiSuppliedUrlProvider } from './providers/apiSuppliedUrl';
import { CARD_API_ID, createCardApiProvider } from './providers/cardApi';
import { createLocalDevAssetsProvider, LOCAL_DEV_ASSETS_ID } from './providers/localDevAssets';
import { createPlatformCdnProvider, PLATFORM_CDN_ID } from './providers/platformCdn';
import { createSilhouetteProvider, SILHOUETTE_ID } from './providers/silhouette';
import {
  assetKey,
  bucketFor,
  type AssetId,
  type ImageProvider,
  type ImageSizeBucket,
  type ResolveOptions,
  type ResolvedImage,
} from './types';

const FACTORIES: Record<string, () => ImageProvider> = {
  [API_SUPPLIED_URL_ID]: () => createApiSuppliedUrlProvider(),
  [CARD_API_ID]: () => createCardApiProvider(),
  [LOCAL_DEV_ASSETS_ID]: () => createLocalDevAssetsProvider(),
  // Present but not in DEFAULT_ORDER: opting in is a config change, and the
  // provider declines everything until VITE_ASSET_CDN_URL is set anyway.
  [PLATFORM_CDN_ID]: () => createPlatformCdnProvider({ baseUrl: portalEnv.assetCdnUrl }),
  [SILHOUETTE_ID]: () => createSilhouetteProvider(),
};

/**
 * API-supplied URLs win: when the API states where an asset lives, that is
 * authoritative and nothing derived should override it.
 *
 * `cardApi` sits next because it is the only provider that can answer
 * `kind: 'card'` — those are composed on request, not stored as files, so
 * falling through to the filesystem provider would be meaningless. It declines
 * every other kind, so artwork resolution below it is unchanged.
 */
const DEFAULT_ORDER = [API_SUPPLIED_URL_ID, CARD_API_ID, LOCAL_DEV_ASSETS_ID];

function buildChain(): ImageProvider[] {
  const requested = portalEnv.imageProviders ?? DEFAULT_ORDER;
  const chain: ImageProvider[] = [];

  for (const id of requested) {
    if (id === SILHOUETTE_ID) continue; // appended below, always last
    const factory = FACTORIES[id];
    if (!factory) {
      console.warn(`[portal] unknown image provider "${id}" — ignored`);
      continue;
    }
    chain.push(factory());
  }

  chain.push(createSilhouetteProvider());
  return chain;
}

let chain: ImageProvider[] = buildChain();

/** Test seam, and the hook a future runtime provider switch would use. */
export function setImageProviderChain(next: ImageProvider[]): void {
  chain = next;
  resolutionCache.clear();
}

export function getImageProviderChain(): readonly ImageProvider[] {
  return chain;
}

// ── Fallback accounting, for the diagnostics page (§23) ─────────────────────

let resolvedCount = 0;
let fallbackCount = 0;
let loadFailureCount = 0;

/** Counted when the browser fails to load a URL a provider was confident about. */
export function noteImageLoadFailure(): void {
  loadFailureCount += 1;
}

export function imageResolverStats(): {
  resolved: number;
  fallbacks: number;
  loadFailures: number;
  fallbackRate: number;
} {
  return {
    resolved: resolvedCount,
    fallbacks: fallbackCount,
    loadFailures: loadFailureCount,
    fallbackRate: resolvedCount === 0 ? 0 : fallbackCount / resolvedCount,
  };
}

// ── Resolution ──────────────────────────────────────────────────────────────

const resolutionCache = new Map<string, ResolvedImage>();

/**
 * Total by construction: the silhouette provider terminates every chain.
 * Results are memoised per asset key so a 25-card grid resolves each URL once.
 *
 * `options.displayWidth` is the width the caller will draw the image at, in CSS
 * pixels. It is a *hint*: the resolver turns it into a size bucket and offers
 * that to each provider, and a provider with only one rendition ignores it. The
 * bucket is part of the memo key, so the same asset at grid size and at hero
 * size are two entries rather than one overwriting the other.
 */
export function resolveAsset(id: AssetId, options: ResolveOptions = {}): ResolvedImage {
  const bucket = bucketFor(options.displayWidth);
  const key = assetKey(id, bucket);
  const cached = resolutionCache.get(key);
  if (cached) return cached;

  for (const provider of chain) {
    const resolved = provider.resolve(id, bucket);
    if (resolved) {
      resolutionCache.set(key, resolved);
      resolvedCount += 1;
      if (resolved.isFallback) fallbackCount += 1;
      return resolved;
    }
  }

  // Unreachable while the silhouette provider is appended, but a chain replaced
  // through `setImageProviderChain` could in principle omit it.
  const emergency: ResolvedImage = {
    url: createSilhouetteProvider().resolve(id).url,
    isFallback: true,
    providerId: SILHOUETTE_ID,
  };
  resolutionCache.set(key, emergency);
  resolvedCount += 1;
  fallbackCount += 1;
  return emergency;
}

/** The size bucket a given rendered width resolves to. Exposed for tests. */
export function bucketForWidth(displayWidth: number | undefined): ImageSizeBucket | null {
  return bucketFor(displayWidth);
}

/** The fallback for an asset, used when a resolved URL fails to load. */
export function fallbackFor(id: AssetId): ResolvedImage {
  return createSilhouetteProvider().resolve(id);
}
