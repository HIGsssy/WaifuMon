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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { fallbackFor, noteImageLoadFailure, resolveAsset } from './provider';
import { assetKey, type AssetId } from './types';

export interface UseImageOptions {
  /** Display name of the resource, e.g. a species name. */
  name?: string | undefined;
  /** Rarity label, appended to the alt text when present. */
  rarityLabel?: string | undefined;
  /** Render the silhouette regardless — undiscovered species (§8.7). */
  forceSilhouette?: boolean | undefined;
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
  isLoaded: boolean;
}

function buildAlt(id: AssetId, options: UseImageOptions): string {
  if (options.forceSilhouette) return 'Undiscovered Waifumon silhouette';
  const name = options.name?.trim();
  if (!name) return `${id.kind} artwork`;
  return options.rarityLabel ? `${name} — ${options.rarityLabel}` : name;
}

export function useImage(id: AssetId, options: UseImageOptions = {}): UseImageResult {
  const key = assetKey(id);
  const [failed, setFailed] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // A card recycled onto a different species must not inherit the previous
  // one's failure or loaded state.
  useEffect(() => {
    setFailed(false);
    setIsLoaded(false);
  }, [key, options.forceSilhouette]);

  const resolved = useMemo(() => {
    if (options.forceSilhouette || failed) return fallbackFor(id);
    return resolveAsset(id);
    // `key` stands in for the structural identity of `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, failed, options.forceSilhouette]);

  const onError = useCallback(() => {
    if (failed) return;
    noteImageLoadFailure();
    setFailed(true);
  }, [failed]);

  const onLoad = useCallback(() => setIsLoaded(true), []);

  return {
    url: resolved.url,
    isFallback: resolved.isFallback,
    providerId: resolved.providerId,
    alt: buildAlt(id, options),
    onError,
    onLoad,
    isLoaded,
  };
}
