/**
 * The image resolver contract (plan §12).
 *
 * Pages never touch a URL, a filesystem path, or a CDN hostname. They name a
 * *logical* asset — kind + slug + variant — and the resolver answers with a URL
 * and whether that URL is a real asset or a placeholder. Swapping the physical
 * source (Platform API image endpoint §25.3, a CDN §25.10, object storage) is
 * then a change under `src/images/` and nowhere else.
 */

export type AssetKind = 'species' | 'item' | 'avatar' | 'ui';

export interface AssetId {
  kind: AssetKind;
  /** Logical id — the species or item slug. */
  slug: string;
  /** Art variant; `standard` when omitted. */
  variant?: string | undefined;
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
   */
  resolve(id: AssetId): ResolvedImage | null;
}

/**
 * A provider that can never decline. Exactly one exists (the silhouette), and
 * typing it separately is what lets the resolver be total without a non-null
 * assertion at the end of the chain.
 */
export interface TerminalImageProvider extends ImageProvider {
  resolve(id: AssetId): ResolvedImage;
}

export const DEFAULT_VARIANT = 'standard';

/** Stable cache key for an asset — also the React key for a resolved image. */
export function assetKey(id: AssetId): string {
  // `href` participates: the same avatar slug with a new CDN hash is a
  // genuinely different image and must not serve the memoised old one.
  return `${id.kind}:${id.slug}:${id.variant ?? DEFAULT_VARIANT}:${id.href ?? ''}`;
}
