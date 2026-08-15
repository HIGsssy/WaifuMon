/**
 * Renderer identity constants. Both of these participate in the master render
 * key, so changing either one invalidates every cached card.
 */

/**
 * Bump whenever renderer code changes what pixels come out — composer layout,
 * text fitting, rasterizer options, composite order, WebP encode settings.
 * Refactors that provably cannot move a pixel do not need a bump.
 */
export const CARD_RENDERER_VERSION = '3';

/** The canonical card is always rendered at the SVG kit's viewBox size. */
export const MASTER_WIDTH = 1000;
export const MASTER_HEIGHT = 1400;

/**
 * WebP encode quality is renderer-owned, not a per-request knob: it is part of
 * the renderer's identity (bump {@link CARD_RENDERER_VERSION} to change it)
 * rather than part of a card's identity. Callers cannot ask for a different
 * quality and thereby fork the cache.
 */
export const CARD_WEBP_QUALITY = 88;

/**
 * Display widths a client may ask for, besides the master.
 *
 * Mirrors the Portal's `IMAGE_SIZE_BUCKETS`. It is duplicated rather than
 * imported because `portal/` is a separate package with its own lockfile and
 * no build-time link to the server — but the two lists must agree, so changing
 * one means changing the other.
 *
 * A closed set, not a range: every distinct width is a cache file, so letting
 * callers ask for arbitrary sizes turns the cache into unbounded storage that
 * any client can fill.
 */
export const CARD_WIDTH_BUCKETS = [256, 512, 1024] as const;

/** Every width the API accepts: the buckets plus the canonical master. */
export const SUPPORTED_CARD_WIDTHS: readonly number[] = [
  ...CARD_WIDTH_BUCKETS,
  MASTER_WIDTH,
].sort((a, b) => a - b);

/**
 * The strong ETag for one rendered card.
 *
 * The master render key identifies the *card*; two different widths of it are
 * different HTTP entities, so the width joins the tag but never the key. One
 * definition, used by both the renderer's result and the route's conditional
 * check — computing it in two places is how a 304 starts lying.
 */
export function cardEtag(renderKey: string, width?: number): string {
  return width === undefined || width === MASTER_WIDTH
    ? `"${renderKey}"`
    : `"${renderKey}@${width}"`;
}
