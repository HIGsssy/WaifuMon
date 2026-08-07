/**
 * `useImage` — the hook `<Artwork>` is built on (plan §12).
 *
 * Resolution itself is synchronous, so this hook is not about loading state in
 * the fetch sense. What it owns is the *runtime* fallback: a provider can be
 * confident about a URL that turns out to 404 (an author pointed `imagePath`
 * somewhere non-conventional, an asset was never dropped in). When the browser
 * reports that failure, the hook swaps to the silhouette so the layout survives
 * — §12's "graceful degradation" rule.
 *
 * Alt text is generated here rather than at call sites, which is what makes
 * §12's "alt text is generated at the resolver" true: a page passes the
 * resource's name and rarity, never a string it composed itself.
 *
 * ### Why the state is two identity values rather than two booleans
 *
 * `isLoaded` and `failed` used to be flags, reset by an effect whenever the
 * asset changed. That is the shape that produced the bug where cached artwork
 * stayed on its skeleton forever after navigating back to it, and it failed in
 * two directions at once:
 *
 *   - **A reset can land after the thing it is resetting.** Passive effects run
 *     after paint. A cached image can finish first, and the reset then puts the
 *     component back into loading with no second `load` event coming to rescue
 *     it. `<StrictMode>` runs that effect twice per mount, which is why it was
 *     so reproducible in development.
 *   - **A boolean cannot say *what* loaded.** A `load` event from the previous
 *     URL — an `<img>` mid-swap, a rendition superseded by its fallback — set
 *     the same flag the new URL reads.
 *
 * Storing *which* URL loaded and *which* asset failed fixes both by
 * construction. Nothing is reset, so nothing can be reset at the wrong moment;
 * a value that no longer matches the current identity is simply not a match, so
 * a stale callback is inert rather than wrong. `isLoaded` becomes a comparison,
 * which is a fact about the render rather than a flag someone has to maintain.
 *
 * ### Why the DOM is consulted as well as the event
 *
 * An `<img>` whose source is already in the browser's cache can be `complete`
 * by the time React attaches a listener — the browser has nothing left to do,
 * so it will not fire `load` again to tell us so. `ref` and a layout effect
 * check `complete && naturalWidth > 0` and settle immediately. The event
 * remains the normal path; this is the case the event cannot cover.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { fallbackFor, noteImageLoadFailure, resolveAsset } from './provider';
import { assetKey, bucketFor, type AssetId } from './types';

export interface UseImageOptions {
  /** Display name of the resource, e.g. a species name. */
  name?: string | undefined;
  /** Rarity label, appended to the alt text when present. */
  rarityLabel?: string | undefined;
  /** Render the silhouette regardless — undiscovered species (§8.7). */
  forceSilhouette?: boolean | undefined;
  /**
   * Width the image will actually be drawn at, in CSS pixels. Lets the resolver
   * pick a rendition instead of shipping source art; omitted means "original".
   */
  displayWidth?: number | undefined;
}

export interface UseImageResult {
  url: string;
  isFallback: boolean;
  providerId: string;
  alt: string;
  /** Wire to the `<img>`'s `onError`. */
  onError: () => void;
  /** Wire to the `<img>`'s `onLoad` — drives the blur-up reveal. */
  onLoad: () => void;
  /**
   * Wire to the `<img>`'s `ref`. Required, not optional: it is what catches an
   * image that was already complete before React could listen for it.
   */
  ref: (node: HTMLImageElement | null) => void;
  isLoaded: boolean;
}

function buildAlt(id: AssetId, options: UseImageOptions): string {
  if (options.forceSilhouette) return 'Undiscovered Waifumon silhouette';
  const name = options.name?.trim();
  if (!name) return `${id.kind} artwork`;
  return options.rarityLabel ? `${name} — ${options.rarityLabel}` : name;
}

export function useImage(id: AssetId, options: UseImageOptions = {}): UseImageResult {
  const key = assetKey(id, bucketFor(options.displayWidth));

  // Which URL has finished, and which asset gave up — not "has something
  // finished" and "has something failed". See the note at the top of the file.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  // A card recycled onto a different species does not inherit the previous
  // one's failure, because the previous one's key no longer matches. No reset,
  // and therefore no window in which a reset can arrive too late.
  const failed = failedKey === key;

  const resolved = useMemo(() => {
    if (options.forceSilhouette || failed) return fallbackFor(id);
    return resolveAsset(id, { displayWidth: options.displayWidth });
    // `key` stands in for the structural identity of `id` *and* its size bucket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, failed, options.forceSilhouette]);

  const url = resolved.url;
  const isLoaded = loadedUrl === url;

  const onError = useCallback(() => {
    if (failed) return;
    noteImageLoadFailure();
    setFailedKey(key);
  }, [failed, key]);

  const onLoad = useCallback(() => setLoadedUrl(url), [url]);

  // ── The already-complete path ─────────────────────────────────────────────

  const node = useRef<HTMLImageElement | null>(null);

  /**
   * Settle from the DOM if the browser is already done.
   *
   * Two guards, both deliberate:
   *
   *   - **The element must be showing the URL this render asked for.** React
   *     reuses one `<img>` across a source change, so mid-swap the node can
   *     still carry the previous `src` while it is already `complete` from that
   *     previous load. Comparing the attribute — not `img.src`, which the DOM
   *     resolves to an absolute URL — is what keeps a finished image from
   *     vouching for a different one.
   *   - **It only ever marks *loaded*.** A complete image with no intrinsic
   *     width is either broken, in which case the `error` event is
   *     authoritative and already on its way, or an SVG without dimensions,
   *     which is not a failure at all. Guessing here would risk marking the
   *     silhouette itself as failed, and the silhouette is the one thing that
   *     has to always work.
   */
  const settleIfComplete = useCallback(() => {
    const img = node.current;
    if (!img || img.getAttribute('src') !== url) return;
    if (img.complete && img.naturalWidth > 0) setLoadedUrl(url);
  }, [url]);

  const ref = useCallback(
    (element: HTMLImageElement | null) => {
      node.current = element;
      settleIfComplete();
    },
    [settleIfComplete],
  );

  // The ref only fires when the element mounts. A `src` swap on the *same*
  // element — rendition to fallback, one card recycled onto another species —
  // needs its own check, and a layout effect runs before paint so the skeleton
  // never flashes over an image that was ready all along.
  useLayoutEffect(settleIfComplete, [settleIfComplete]);

  return {
    url,
    isFallback: resolved.isFallback,
    providerId: resolved.providerId,
    alt: buildAlt(id, options),
    onError,
    onLoad,
    ref,
    isLoaded,
  };
}
