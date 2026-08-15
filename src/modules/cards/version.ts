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
