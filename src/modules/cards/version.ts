/**
 * Renderer identity and canvas geometry.
 *
 * `CARD_RENDERER_VERSION` and the kit's `VERSION` both participate in the
 * master render key, so changing either invalidates every cached card.
 */

/**
 * Bump whenever renderer code changes what pixels come out — composer layout,
 * text fitting, rasterizer options, composite order, WebP encode settings.
 * Refactors that provably cannot move a pixel do not need a bump.
 */
export const CARD_RENDERER_VERSION = '4';

/**
 * The canonical card canvas.
 *
 * **Derived from the source artwork, not the other way round.** Character art
 * is authored at 1248×1824 (13:19, ≈0.6842), and it is authored *full frame*:
 * these compositions put ears and hair against the top edge and feet against
 * the bottom, and one pose runs a leg off the top. Vertical crop is therefore
 * the destructive axis — anything that trims height clips anatomy.
 *
 * 1500×2200 is ≈0.6818, within 0.35% of the source ratio. With the art
 * full-bleed behind the frame that costs **1.65% of width and 0% of height** —
 * about five pixels of background off each side. The alternative shape, an
 * inset art *window* with furniture above and below, forces a 1420×1850 window
 * and throws away **10.9% of the height**, which is a head or a pair of boots.
 *
 * So the art fills the card and the frame, badges and text sit *over* it,
 * weighted to the bottom where these compositions carry legs and background
 * rather than faces.
 *
 * Everything downstream derives from these two numbers — derivative sizing,
 * reported dimensions, the composer's layout table. Nothing else should
 * hard-code a card dimension.
 */
export const CARD_MASTER_WIDTH = 1500;
export const CARD_MASTER_HEIGHT = 2200;

/** Card aspect ratio, for callers reserving a box before the bytes arrive. */
export const CARD_ASPECT_RATIO = CARD_MASTER_WIDTH / CARD_MASTER_HEIGHT;

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
 *
 * The ladder survives the bigger canvas unchanged, and is better for it: at the
 * old 1000 px master a `width=1024` request *upscaled*, which is the one thing
 * a resize should never do. Against a 1500 px master every bucket is a genuine
 * downscale — 1024 is the Portal's 384 CSS px hero on a 2× screen, 512 the same
 * hero on a 1× screen, 256 a grid tile.
 */
export const CARD_WIDTH_BUCKETS = [256, 512, 1024] as const;

/** Every width the API accepts: the buckets plus the canonical master. */
export const SUPPORTED_CARD_WIDTHS: readonly number[] = [
  ...CARD_WIDTH_BUCKETS,
  CARD_MASTER_WIDTH,
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
  return width === undefined || width === CARD_MASTER_WIDTH
    ? `"${renderKey}"`
    : `"${renderKey}@${width}"`;
}
