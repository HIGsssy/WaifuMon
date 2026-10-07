/**
 * Where a sprite sits in a composed scene — the authored shape and the layout
 * arithmetic, with no image library.
 *
 * A placement is a preset anchor, a scale and two small offsets; there is no
 * freeform editor. Everything is bounded, so no authored value can push the
 * sprite off the canvas or blow up the render:
 *
 *   - `anchor` — one of six presets. The three `bottom-*` anchors stand the
 *     sprite on the floor line; `left` / `center` / `right` centre it
 *     vertically.
 *   - `scaleBasisPoints` — the sprite's height as a share of the scene's
 *     height (8500 = 85%). Width follows from the sprite's own aspect ratio;
 *     it is never stretched. A sprite too wide for the canvas at that height
 *     is shrunk to fit, still in proportion.
 *   - `offsetX` / `offsetY` — pixels in scene space, positive right / down,
 *     applied after the anchor. The result is clamped inside the canvas.
 *
 * ## The player's Buddy
 *
 * A fight scene has one more actor that is **not** authored: the run's Buddy.
 * She has no placement in any zone, room or enemy — she always stands in the
 * reserved player side, bottom-left ({@link PLAYER_BUDDY_PLACEMENT}), laid out
 * by {@link layoutPlayerBuddy} with the same arithmetic as an enemy and one
 * extra bound: she never grows wider than {@link PLAYER_BUDDY_MAX_WIDTH_SHARE}
 * of the canvas, so a wide sprite cannot spill into the enemy's side. Moving
 * her is a change to those two constants and nothing else.
 *
 * Together they are a reserved bounding region — 480×540 on the canonical
 * canvas, standing on the floor line from the left margin — and the sprite is
 * fitted inside it in proportion. Mirroring ({@link mirrorsPlayerBuddy}) flips
 * her pixels inside that same box; it never moves or resizes it.
 *
 * Enemy placement is untouched: all six anchors stay available. An enemy
 * authored into the Buddy's side is not refused — {@link layoutOverlapShare}
 * measures the collision so the preview can show and flag it.
 *
 * Pure: the compositor, the validators and the Portal preview all read the
 * same numbers from {@link layoutSprite}.
 */
import { z } from 'zod';

/** The one scene size: 16:9, what a Discord embed shows large without cropping. */
export const SCENE_WIDTH = 1200;
export const SCENE_HEIGHT = 675;
export interface SceneOutputSpec {
  width: number;
  height: number;
}
export const SCENE_OUTPUT: SceneOutputSpec = { width: SCENE_WIDTH, height: SCENE_HEIGHT };

export const SPRITE_ANCHORS = ['left', 'center', 'right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export type SpriteAnchor = (typeof SPRITE_ANCHORS)[number];

export const SPRITE_SCALE_MIN_BP = 1000;
export const SPRITE_SCALE_MAX_BP = 10_000;
export const SPRITE_OFFSET_X_MAX = SCENE_WIDTH / 2;
export const SPRITE_OFFSET_Y_MAX = Math.floor(SCENE_HEIGHT / 2);

/** Gap kept between an anchored sprite and the canvas edge, as a share of the canvas. */
const EDGE_MARGIN_X = 0.04;
const EDGE_MARGIN_BOTTOM = 0.02;

export const SpritePlacementSchema = z
  .object({
    anchor: z.enum(SPRITE_ANCHORS).default('bottom-right'),
    scaleBasisPoints: z.number().int().min(SPRITE_SCALE_MIN_BP).max(SPRITE_SCALE_MAX_BP).default(8500),
    offsetX: z.number().int().min(-SPRITE_OFFSET_X_MAX).max(SPRITE_OFFSET_X_MAX).default(0),
    offsetY: z.number().int().min(-SPRITE_OFFSET_Y_MAX).max(SPRITE_OFFSET_Y_MAX).default(0),
  })
  .strict();
export type SpritePlacement = z.infer<typeof SpritePlacementSchema>;

/** An enemy with no authored placement stands bottom-right at 85% height. */
export const DEFAULT_SPRITE_PLACEMENT: SpritePlacement = SpritePlacementSchema.parse({});

/**
 * Where the player's Buddy stands in every fight scene: on the floor line at
 * the left edge, at 80% of the scene's height — a little under an enemy's
 * default 85%, which suits the full-body 1350px-tall WaifuMon sprites. Fixed;
 * never authored.
 */
export const PLAYER_BUDDY_PLACEMENT: SpritePlacement = SpritePlacementSchema.parse({
  anchor: 'bottom-left',
  scaleBasisPoints: 8000,
});
/**
 * The way the Buddy should look from the reserved side: towards the enemy. A
 * sprite authored as facing the other way is mirrored; one with no stated
 * facing (front-on, the usual WaifuMon sprite) is drawn as it is.
 */
export const PLAYER_BUDDY_FACING = 'right' as const;

/** Whether a sprite with this authored facing is mirrored when it is the player's Buddy. */
export function mirrorsPlayerBuddy(spriteFacing: 'left' | 'right' | null | undefined): boolean {
  return spriteFacing != null && spriteFacing !== PLAYER_BUDDY_FACING;
}

/** The widest the Buddy may be drawn, as a share of the canvas: the reserved player side. */
export const PLAYER_BUDDY_MAX_WIDTH_SHARE = 0.4;
/** An enemy covering at least this share of the Buddy's box is reported as a collision. */
export const PLAYER_BUDDY_COLLISION_SHARE = 0.15;

export interface SpriteLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The rectangle a sprite of `source` size occupies in a scene of `output`
 * size. Integer pixels, aspect ratio preserved, always fully inside the
 * canvas. `bounds.maxWidth` caps the width below the canvas's, shrinking in
 * proportion like a sprite too wide for the canvas.
 */
export function layoutSprite(
  source: { width: number; height: number },
  placement: SpritePlacement,
  output: SceneOutputSpec = SCENE_OUTPUT,
  bounds: { maxWidth?: number } = {},
): SpriteLayout {
  const aspect = source.width / source.height;
  const maxWidth = Math.max(1, Math.min(output.width, bounds.maxWidth ?? output.width));
  let height = Math.max(1, Math.round((output.height * placement.scaleBasisPoints) / 10_000));
  let width = Math.max(1, Math.round(height * aspect));
  if (width > maxWidth) {
    width = maxWidth;
    height = Math.max(1, Math.round(width / aspect));
  }
  height = Math.min(height, output.height);

  const marginX = Math.round(output.width * EDGE_MARGIN_X);
  const marginBottom = Math.round(output.height * EDGE_MARGIN_BOTTOM);
  const horizontal = placement.anchor.replace('bottom-', '') as 'left' | 'center' | 'right';
  const anchoredLeft =
    horizontal === 'left' ? marginX : horizontal === 'right' ? output.width - width - marginX : (output.width - width) / 2;
  const anchoredTop = placement.anchor.startsWith('bottom-')
    ? output.height - height - marginBottom
    : (output.height - height) / 2;

  return {
    left: clamp(Math.round(anchoredLeft + placement.offsetX), 0, output.width - width),
    top: clamp(Math.round(anchoredTop + placement.offsetY), 0, output.height - height),
    width,
    height,
  };
}

/** The rectangle the player's Buddy occupies: the reserved left side, whatever her sprite's shape. */
export function layoutPlayerBuddy(
  source: { width: number; height: number },
  output: SceneOutputSpec = SCENE_OUTPUT,
): SpriteLayout {
  return layoutSprite(source, PLAYER_BUDDY_PLACEMENT, output, {
    maxWidth: Math.round(output.width * PLAYER_BUDDY_MAX_WIDTH_SHARE),
  });
}

/** How much of `of` the rectangle `by` covers, 0–1. */
export function layoutOverlapShare(of: SpriteLayout, by: SpriteLayout): number {
  const w = Math.min(of.left + of.width, by.left + by.width) - Math.max(of.left, by.left);
  const h = Math.min(of.top + of.height, by.top + by.height) - Math.max(of.top, by.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (of.width * of.height);
}
