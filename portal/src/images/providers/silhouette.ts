/**
 * Silhouette provider — the end of every chain (plan §12).
 *
 * Never returns null and never fetches anything: the placeholder is an inline
 * SVG data URI, so a missing asset costs no request and cannot flash. The hue
 * is derived from the slug, which keeps the URL deterministic (§12's first
 * rule) and makes an undiscovered encyclopedia grid look composed rather than
 * uniformly grey.
 *
 * The same asset is what the encyclopedia renders for undiscovered species
 * (§8.7), so the shape reads as "a Waifumon you haven't met" rather than "a
 * broken image".
 */
import {
  DEFAULT_VARIANT,
  type AssetId,
  type ResolvedImage,
  type TerminalImageProvider,
} from '../types';

export const SILHOUETTE_ID = 'silhouette';

/** FNV-1a — small, stable, and dependency-free. Presentation only. */
function hashSlug(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A portrait-shaped figure, not a broken-image glyph. */
function silhouetteSvg(hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400" role="presentation">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 24% 22%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 40) % 360} 20% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="400" fill="url(#bg)"/>
  <g fill="hsl(${hue} 18% 8%)" opacity="0.55">
    <circle cx="150" cy="150" r="58"/>
    <path d="M150 218c-58 0-102 38-112 92-2 12 6 22 18 22h188c12 0 20-10 18-22-10-54-54-92-112-92z"/>
  </g>
</svg>`;
}

function toDataUri(svg: string): string {
  // `encodeURIComponent` rather than base64: it keeps the URI readable in
  // devtools and avoids a btoa/unicode edge case for no size benefit.
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
}

const cache = new Map<string, string>();

export function silhouetteUrl(slug: string): string {
  const cached = cache.get(slug);
  if (cached) return cached;
  const url = toDataUri(silhouetteSvg(hashSlug(slug) % 360));
  cache.set(slug, url);
  return url;
}

export function createSilhouetteProvider(): TerminalImageProvider {
  return {
    id: SILHOUETTE_ID,
    resolve(id: AssetId): ResolvedImage {
      return {
        url: silhouetteUrl(`${id.kind}:${id.slug}:${id.variant ?? DEFAULT_VARIANT}`),
        isFallback: true,
        providerId: SILHOUETTE_ID,
      };
    },
  };
}
