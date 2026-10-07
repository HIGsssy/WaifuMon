/**
 * Scene composition: a background, optionally with sprites layered over it,
 * rendered to a single raster a Discord embed can show.
 *
 *     background  +  player Buddy  +  enemy sprite  →  1200×675 WebP
 *
 * ## Layer order
 *
 * Fixed, bottom to top ({@link SCENE_LAYER_ORDER}):
 *
 *   1. `background` — covers the canvas;
 *   2. `playerBuddy` — the reserved left-side actor, placed by
 *      `layoutPlayerBuddy`, never by the request;
 *   3. `sprite` — the enemy, at its authored placement.
 *
 * The enemy is drawn over the Buddy, so where an author does place an enemy
 * into the player's side it is the enemy — the thing they are placing — that
 * stays whole. There are no scene overlays and no UI layer: text and controls
 * are the Discord embed's, outside the image.
 *
 * The Buddy may be mirrored (`playerBuddy.mirror`) so one sprite file serves a
 * species drawn facing either way; the flip happens inside her reserved box.
 * She needs no enemy: a request with a Buddy and no `sprite` is a valid scene.
 *
 * The Buddy is decoration on top of a scene that is complete without her: if
 * her image is gone or will not decode, the scene is composed without her
 * (and cached under the Buddy-less key) rather than not at all.
 *
 * Independent of dungeons: it takes image layers and a placement and knows
 * nothing about zones, runs or enemies. The dungeon presenter and the Admin
 * scene preview both call {@link SceneCompositionService.compose}, so a
 * preview is the production render.
 *
 * ## Raster, not SVG
 *
 * Layers are composited directly with `sharp`. No SVG document is built and
 * no uploaded markup is ever interpreted: every input is decoded as a raster
 * (uploads are PNG / WebP / JPEG only — see `imageInspection.ts`), and layout
 * is integers from `layoutSprite`.
 *
 * ## Cache
 *
 * A render is keyed by what determines its pixels —
 * `sha256(renderer version, background hash, sprite hash, placement, output)`,
 * plus the Buddy's hash and reserved layout when she is in the scene — and stored once under the cache directory. The same inputs name the same
 * file; replacing an asset changes its hash and so names a new one. Nothing
 * is rendered up front, and the directory is disposable: a missing file is
 * simply rendered again.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ARTWORK_MAX_PIXELS } from './imageInspection';
import {
  PLAYER_BUDDY_MAX_WIDTH_SHARE,
  PLAYER_BUDDY_PLACEMENT,
  SCENE_OUTPUT,
  SpritePlacementSchema,
  layoutPlayerBuddy,
  layoutSprite,
  type SceneOutputSpec,
  type SpriteLayout,
  type SpritePlacement,
} from './scenePlacement';

/** Bump when the rendering itself changes, so old cache entries stop matching. */
export const SCENE_RENDERER_VERSION = 1;
export const SCENE_CONTENT_TYPE = 'image/webp';
const SCENE_WEBP_QUALITY = 86;
/** The z-order of a scene, bottom to top. See the module comment. */
export const SCENE_LAYER_ORDER = ['background', 'playerBuddy', 'sprite'] as const;

/** One image going into a scene. `load` is only called on a cache miss. */
export interface SceneLayer {
  /** Identifies the pixels: a content hash, or anything that changes when they do. */
  hash: string;
  /** The image bytes, or null when they are no longer available. */
  load(): Promise<Buffer | null>;
}

export interface SceneRequest {
  background: SceneLayer;
  sprite?: { layer: SceneLayer; placement: SpritePlacement } | null;
  /**
   * The player's Buddy, drawn in the reserved left side under the enemy. No
   * placement: where she stands is the compositor's. `mirror` flips her
   * horizontally inside her box (a sprite drawn facing away from the enemy).
   * `label` (a species slug) only names her in a warning.
   */
  playerBuddy?: { layer: SceneLayer; mirror?: boolean; label?: string } | null;
  /** Defaults to the canonical scene size. */
  output?: SceneOutputSpec;
}

export interface ComposedScene {
  /** Stable for these inputs; also the cached file's name. */
  cacheKey: string;
  absolutePath: string;
  contentType: typeof SCENE_CONTENT_TYPE;
  /** False when this call rendered it. */
  cached: boolean;
  /** Whether the requested player Buddy is in the picture; false when she was not asked for or had to be left out. */
  playerBuddy: boolean;
}

/** Where a request's sprites land; null for one that is absent or unreadable. */
export interface SceneActorLayouts {
  sprite: SpriteLayout | null;
  playerBuddy: SpriteLayout | null;
}

export interface SceneCompositionService {
  /**
   * The composed scene for a request, rendering it once. Null when a layer's
   * bytes are gone or cannot be decoded — the caller falls back to other art.
   * Never throws for bad image data.
   */
  compose(request: SceneRequest): Promise<ComposedScene | null>;
  /** The cache key a request maps to, without rendering. */
  cacheKeyOf(request: SceneRequest): string;
  /**
   * The rectangles a request's enemy sprite and Buddy occupy, read from the
   * images' real dimensions — for a preview to report a collision. Reads the
   * layers; renders nothing. Never throws.
   */
  layouts(request: SceneRequest): Promise<SceneActorLayouts>;
}

export function sceneCacheKey(request: SceneRequest): string {
  const output = request.output ?? SCENE_OUTPUT;
  const sprite = request.sprite
    ? { hash: request.sprite.layer.hash, placement: SpritePlacementSchema.parse(request.sprite.placement) }
    : null;
  const identity = [
    'scene',
    SCENE_RENDERER_VERSION,
    request.background.hash,
    sprite && [sprite.hash, sprite.placement.anchor, sprite.placement.scaleBasisPoints, sprite.placement.offsetX, sprite.placement.offsetY],
    [output.width, output.height],
    SCENE_CONTENT_TYPE,
  ];
  // Appended only when she is there, so a Buddy-less scene keeps the key it always had.
  if (request.playerBuddy) {
    const p = PLAYER_BUDDY_PLACEMENT;
    identity.push([
      'playerBuddy',
      request.playerBuddy.layer.hash,
      p.anchor,
      p.scaleBasisPoints,
      p.offsetX,
      p.offsetY,
      PLAYER_BUDDY_MAX_WIDTH_SHARE,
      // Only when set, so an unmirrored Buddy keeps the key she had.
      ...(request.playerBuddy.mirror ? ['mirrored'] : []),
    ]);
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Render a scene to WebP bytes. Throws on undecodable input. */
export async function renderScene(input: {
  background: Buffer;
  sprite?: { bytes: Buffer; placement: SpritePlacement } | null;
  playerBuddy?: { bytes: Buffer; mirror?: boolean } | null;
  output?: SceneOutputSpec;
}): Promise<Buffer> {
  const output = input.output ?? SCENE_OUTPUT;
  const decode = (bytes: Buffer) => sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS, failOn: 'error' });

  // Cover: fill the canvas, cropping the overflow, never stretching.
  const canvas = decode(input.background)
    .rotate()
    .resize(output.width, output.height, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#000000' });

  const overlay = async (
    bytes: Buffer,
    layout: (source: { width: number; height: number }) => SpriteLayout,
    mirror = false,
  ): Promise<sharp.OverlayOptions> => {
    const meta = await decode(bytes).metadata();
    if (!meta.width || !meta.height) throw new Error('sprite has no dimensions');
    const box = layout({ width: meta.width, height: meta.height });
    const sprite = await decode(bytes)
      .flop(mirror)
      .ensureAlpha()
      // `fill` into a box already computed at the sprite's own aspect ratio.
      .resize(box.width, box.height, { fit: 'fill' })
      .png()
      .toBuffer();
    return { input: sprite, left: box.left, top: box.top };
  };

  // Pushed in SCENE_LAYER_ORDER: the Buddy first, the enemy over her.
  const layers: sharp.OverlayOptions[] = [];
  if (input.playerBuddy) {
    layers.push(await overlay(input.playerBuddy.bytes, (source) => layoutPlayerBuddy(source, output), input.playerBuddy.mirror === true));
  }
  if (input.sprite) {
    const { placement } = input.sprite;
    layers.push(await overlay(input.sprite.bytes, (source) => layoutSprite(source, placement, output)));
  }
  return canvas.composite(layers).webp({ quality: SCENE_WEBP_QUALITY }).toBuffer();
}

export interface SceneCompositionDeps {
  /** Disposable cache directory. Created on first render. */
  cacheDir: string;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

export function createSceneCompositionService(deps: SceneCompositionDeps): SceneCompositionService {
  const root = path.resolve(deps.cacheDir);
  const inFlight = new Map<string, Promise<ComposedScene | null>>();
  const fileOf = (key: string) => path.join(root, key.slice(0, 2), `${key}.webp`);

  /** The same scene without the Buddy, under its own key — so the Buddy-keyed file only ever shows her. */
  function withoutBuddy(request: SceneRequest, reason: string, err?: unknown): Promise<ComposedScene | null> {
    deps.logger?.warn(
      { tag: 'scene/player-buddy-omitted', speciesSlug: request.playerBuddy?.label ?? null, reason, ...(err ? { err } : {}) },
      'player Buddy sprite could not be drawn — composing the scene without her',
    );
    return compose({ ...request, playerBuddy: null });
  }

  async function render(key: string, request: SceneRequest): Promise<ComposedScene | null> {
    const target = fileOf(key);
    const withBuddy = request.playerBuddy != null;
    try {
      if ((await fs.stat(target)).isFile()) {
        return { cacheKey: key, absolutePath: target, contentType: SCENE_CONTENT_TYPE, cached: true, playerBuddy: withBuddy };
      }
    } catch {
      // Not cached (or the cache was cleaned): render it.
    }

    const background = await request.background.load();
    if (!background) return null;
    let sprite: { bytes: Buffer; placement: SpritePlacement } | null = null;
    if (request.sprite) {
      const bytes = await request.sprite.layer.load();
      if (!bytes) return null;
      sprite = { bytes, placement: SpritePlacementSchema.parse(request.sprite.placement) };
    }

    let playerBuddy: { bytes: Buffer; mirror: boolean } | null = null;
    if (request.playerBuddy) {
      const bytes = await request.playerBuddy.layer.load();
      if (!bytes) return withoutBuddy(request, 'sprite file unavailable');
      playerBuddy = { bytes, mirror: request.playerBuddy.mirror === true };
    }

    let rendered: Buffer;
    try {
      rendered = await renderScene({ background, sprite, playerBuddy, ...(request.output ? { output: request.output } : {}) });
    } catch (err) {
      // With her in the scene the failure may be hers alone: try once more without.
      if (request.playerBuddy) return withoutBuddy(request, 'scene would not render with the sprite', err);
      deps.logger?.warn({ tag: 'scene/render-failed', cacheKey: key, err }, 'scene could not be composed — falling back');
      return null;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temp, rendered);
    await fs.rename(temp, target);
    return { cacheKey: key, absolutePath: target, contentType: SCENE_CONTENT_TYPE, cached: false, playerBuddy: withBuddy };
  }

  function compose(request: SceneRequest): Promise<ComposedScene | null> {
    const key = sceneCacheKey(request);
    // Two screens asking for the same scene at once share one render.
    const running = inFlight.get(key);
    if (running) return running;
    const work = render(key, request).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  }

  /** A layer's pixel size, or null when it is gone or is not an image. */
  async function sizeOf(layer: SceneLayer | undefined): Promise<{ width: number; height: number } | null> {
    try {
      const bytes = await layer?.load();
      if (!bytes) return null;
      const meta = await sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS }).metadata();
      return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
    } catch {
      return null;
    }
  }

  return {
    cacheKeyOf: sceneCacheKey,
    compose,
    async layouts(request) {
      const output = request.output ?? SCENE_OUTPUT;
      const [sprite, buddy] = await Promise.all([sizeOf(request.sprite?.layer), sizeOf(request.playerBuddy?.layer)]);
      return {
        sprite: sprite && request.sprite ? layoutSprite(sprite, SpritePlacementSchema.parse(request.sprite.placement), output) : null,
        playerBuddy: buddy ? layoutPlayerBuddy(buddy, output) : null,
      };
    },
  };
}
