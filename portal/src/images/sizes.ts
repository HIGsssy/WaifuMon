/**
 * The widths the Portal actually draws artwork at.
 *
 * Every `<Artwork displayWidth>` call site names one of these rather than a
 * literal, for the same reason `queryKeys` exists: the numbers have to agree
 * with the layout, and scattered magic numbers drift from it silently. If a
 * grid gains a column, the number changes here and every grid follows.
 *
 * These are **CSS pixels** — the width of the element on screen. The resolver
 * applies device pixel ratio itself (`bucketFor`), so nothing here needs to
 * think about retina.
 */
export const ARTWORK_WIDTH = {
  /** Trainer avatars: 64–96 px circles in the header and on the profile. */
  avatar: 96,

  /**
   * The small strips — appearance galleries, "related species" rails. Roughly
   * 120 px wide, so this lands in the smallest bucket on a 2× screen.
   */
  strip: 128,

  /** Collection and encyclopedia grid tiles: ~256 px at every breakpoint. */
  gridTile: 256,

  /**
   * Page heroes: the detail pages' `minmax(0, 24rem)` column, the buddy card,
   * and the dashboard's buddy panel. 384 CSS px, so 1024 on a 2× screen.
   */
  hero: 384,
} as const;

export type ArtworkWidth = (typeof ARTWORK_WIDTH)[keyof typeof ARTWORK_WIDTH];
