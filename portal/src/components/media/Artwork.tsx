/**
 * `<Artwork>` — the only component in the Portal that renders an `<img>` for a
 * game asset (plan §12, §24.13). Feature code names an asset; this renders it.
 *
 * What it guarantees, so no page has to:
 *   - space is reserved before the image loads, so grids never shift (§15)
 *   - off-screen tiles are `loading="lazy"`; an above-the-fold hero opts into
 *     `priority` and gets `fetchPriority="high"`
 *   - a failed load degrades to the silhouette rather than a broken glyph
 *   - alt text comes from the resolver, derived from the resource (§12)
 */
import { memo } from 'react';

import { useImage } from '@/images/useImage';
import type { AssetId } from '@/images/types';
import { cn } from '@/lib/cn';

export interface ArtworkProps {
  asset: AssetId;
  /** Display name of the resource — feeds the generated alt text. */
  name?: string | undefined;
  /** Rarity label, appended to the alt text. */
  rarityLabel?: string | undefined;
  /** Render the silhouette regardless of availability (undiscovered, §8.7). */
  silhouette?: boolean | undefined;
  /** Above-the-fold hero art: eager, high priority. */
  priority?: boolean | undefined;
  /** Tailwind aspect-ratio utility for the reserved box. */
  aspect?: string;
  /** `cover` crops to fill; `contain` fits the whole asset (item thumbnails). */
  fit?: 'cover' | 'contain';
  className?: string;
  imgClassName?: string;
  /** View Transitions name for the card → detail morph (§14). */
  viewTransitionName?: string | undefined;
}

export const Artwork = memo(function Artwork({
  asset,
  name,
  rarityLabel,
  silhouette,
  priority = false,
  aspect = 'aspect-[3/4]',
  fit = 'cover',
  className,
  imgClassName,
  viewTransitionName,
}: ArtworkProps) {
  const image = useImage(asset, {
    name,
    rarityLabel,
    forceSilhouette: silhouette,
  });

  return (
    <div
      className={cn('relative overflow-hidden bg-surface-sunken', aspect, className)}
      // The reserved box is painted before the asset arrives, so the shimmer
      // and the final art occupy exactly the same footprint (§14).
      {...(viewTransitionName ? { style: { viewTransitionName } } : {})}
    >
      {!image.isLoaded && <div className="skeleton absolute inset-0" aria-hidden="true" />}
      <img
        src={image.url}
        alt={image.alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
        draggable={false}
        onError={image.onError}
        onLoad={image.onLoad}
        className={cn(
          'h-full w-full transition-opacity duration-500',
          fit === 'cover' ? 'object-cover' : 'object-contain',
          image.isLoaded ? 'opacity-100' : 'opacity-0',
          imgClassName,
        )}
      />
    </div>
  );
});
