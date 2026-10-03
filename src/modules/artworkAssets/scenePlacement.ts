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
 * canvas.
 */
export function layoutSprite(
  source: { width: number; height: number },
  placement: SpritePlacement,
  output: SceneOutputSpec = SCENE_OUTPUT,
): SpriteLayout {
  const aspect = source.width / source.height;
  let height = Math.max(1, Math.round((output.height * placement.scaleBasisPoints) / 10_000));
  let width = Math.max(1, Math.round(height * aspect));
  if (width > output.width) {
    width = output.width;
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
