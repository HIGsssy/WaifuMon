/**
 * The image resolver contract (plan §12).
 *
 * Pages never touch a URL, a filesystem path, or a CDN hostname. They name a
 * *logical* asset — kind + slug + variant — and the resolver answers with a URL
 * and whether that URL is a real asset or a placeholder. Swapping the physical
 * source (Platform API image endpoint §25.3, a CDN §25.10, object storage) is
 * then a change under `src/images/` and nowhere else.
 */

/**
 * `'waifumon'` is the kind the **Platform API** emits on every `assetId`, and
 * `'species'` is the Portal's own long-standing name for the same artwork.
 * Both are accepted and resolve identically, which is what lets an API
 * `assetId` be dropped straight into `useImage` with no adapter — see
 * `speciesAsset` and the local-assets provider.
 */
export type AssetKind = 'species' | 'waifumon' | 'item' | 'avatar' | 'ui' | 'card';

/** The two kinds that name Waifumon artwork. */
export const WAIFUMON_ASSET_KINDS: readonly AssetKind[] = ['species', 'waifumon'];

export interface AssetId {
  kind: AssetKind;
  /** Logical id — the species or item slug. */
  slug: string;
  /** Art variant; `standard` when omitted. */
  variant?: string | undefined;
  /**
   * This identity is being used as the species/copy's primary artwork.
   *
   * The API-backed provider claims only this form. A gallery appearance has no
   * such marker, so locked entries cannot be converted into a guessable API
   * URL and unlocked appearance tiles keep using their existing provider.
   */
  baseArtwork?: boolean | undefined;
  /**
   * An absolute URL the **Platform API itself supplied** for this asset —
   * today only `player.identity.avatarUrl`, which points at Discord's CDN.
   *
   * This is not a hole in §12's "no physical paths leak" rule; it is the same
   * rule applied to a different kind of value. `imagePath` is an *internal
   * detail* the Portal must not turn into a URL, so it never crosses into a
   * page. An avatar URL is the opposite: it is already the authoritative,
   * externally-addressable location, and no provider could derive it. Pages
   * still never construct it — they forward what the API returned, and the
   * `apiSuppliedUrl` provider decides whether to honour it.
   */
  href?: string | null | undefined;
  /**
   * Owned-copy context for server-resolved cards or raw artwork. The server
   * reads the copy's current level and selected appearance rather than trusting
   * client-supplied gameplay state.
   *
   * These are the same logical ids the API addresses its own resources by, not
   * a location — the provider turns them into a route, exactly as it turns a
   * slug into one for every other kind. A card with no `owned` is the species
   * preview: level 1, default appearance.
   */
  owned?: { playerId: number; waifuId: number } | undefined;
  /**
   * A specific appearance id to render for an `owned` copy, rather than the
   * look she is wearing. This is what a gallery tile uses to show *its own*
   * unlocked appearance: the API re-validates the id against the copy's
   * ownership and level before serving it, so it names *what* to draw and is
   * never an authorization input. Ignored without `owned`.
   */
  appearanceId?: string | undefined;
}

export interface ResolvedImage {
  url: string;
  /** True when the URL is a placeholder rather than real artwork. */
  isFallback: boolean;
  /** Which provider answered — reported on the diagnostics page (§23). */
  providerId: string;
}

export interface ImageProvider {
  readonly id: string;
  /**
   * Returns a URL, or `null` to defer to the next provider in the chain. Only
   * the silhouette provider is required to always answer.
   *
   * `bucket` is the size the caller wants, or `null` for the original. A
   * provider that cannot serve sizes ignores it and answers with what it has —
   * asking for a thumbnail is a preference, never a precondition.
   */
  resolve(id: AssetId, bucket?: ImageSizeBucket | null): ResolvedImage | null;
}

/**
 * A provider that can never decline. Exactly one exists (the silhouette), and
 * typing it separately is what lets the resolver be total without a non-null
 * assertion at the end of the chain.
 */
export interface TerminalImageProvider extends ImageProvider {
  resolve(id: AssetId, bucket?: ImageSizeBucket | null): ResolvedImage;
}

export const DEFAULT_VARIANT = 'standard';

// ── Size negotiation ────────────────────────────────────────────────────────

/**
 * The sizes artwork is published at.
 *
 * Source art is ~1500×2100 and 4.5 MB per file. A collection grid renders 25 of
 * them at roughly 256 CSS px wide, so shipping the original is two orders of
 * magnitude more pixels than the screen can show — and, because artwork and the
 * API share one HTTP/1.1 origin in dev, those bytes are what starve JSON
 * requests of connections.
 *
 * Three buckets rather than arbitrary widths, because every distinct width is a
 * separate file to generate, store and cache. These cover the three things the
 * Portal actually draws: a grid tile, a card hero, a detail hero.
 */
export const IMAGE_SIZE_BUCKETS = [256, 512, 1024] as const;

export type ImageSizeBucket = (typeof IMAGE_SIZE_BUCKETS)[number];

/** Above this, serve the original: no bucket would be an improvement. */
const LARGEST_BUCKET = IMAGE_SIZE_BUCKETS[IMAGE_SIZE_BUCKETS.length - 1] as ImageSizeBucket;

/**
 * Cap on the device-pixel-ratio multiplier.
 *
 * A 3× phone asking for 3× pixels on a 256 px tile lands in the 1024 bucket,
 * which is most of the way back to shipping the original. Beyond 2× the return
 * on a photographic image is not visible, so 2× is where it stops.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * The bucket to serve for a given rendered CSS width, or `null` to serve the
 * original.
 *
 * `displayWidth` is CSS pixels — what the element actually occupies. The device
 * pixel ratio is applied here rather than at call sites so a component says
 * "I draw this 256 px wide" and never has to think about screen density.
 */
export function bucketFor(displayWidth: number | undefined): ImageSizeBucket | null {
  if (displayWidth === undefined || !Number.isFinite(displayWidth) || displayWidth <= 0) {
    return null;
  }

  const ratio = typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1);
  const needed = displayWidth * Math.min(Math.max(ratio, 1), MAX_PIXEL_RATIO);

  return IMAGE_SIZE_BUCKETS.find((bucket) => bucket >= needed) ?? LARGEST_BUCKET;
}

/** What a caller asks the resolver for, beyond the asset's identity. */
export interface ResolveOptions {
  /** Rendered width in CSS pixels. Omitted means "give me the original". */
  displayWidth?: number | undefined;
}

/** Stable cache key for an asset — also the React key for a resolved image. */
export function assetKey(id: AssetId, bucket: ImageSizeBucket | null = null): string {
  // `owned` participates: two trainers' copies of one species are different
  // cards (different level, possibly different appearance), and memoising them
  // under one key would serve the first player's card to the second.
  const owned = id.owned ? `${id.owned.playerId}/${id.owned.waifuId}` : '';
  // `appearanceId` participates: a gallery renders several unlocked looks of
  // one owned copy, and they must key apart even if two shared an art variant.
  const appearance = id.appearanceId ?? '';
  // `href` participates: the same avatar slug with a new CDN hash is a
  // genuinely different image and must not serve the memoised old one.
  // The bucket participates for the same reason: two sizes are two URLs.
  return `${id.kind}:${id.slug}:${id.variant ?? DEFAULT_VARIANT}:${id.baseArtwork === true ? 'base' : ''}:${id.href ?? ''}:${owned}:${appearance}:${bucket ?? 'full'}`;
}
