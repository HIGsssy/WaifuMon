/**
 * Scene composition: a background, optionally with one sprite layered over
 * it, rendered to a single raster a Discord embed can show.
 *
 *     background  +  enemy sprite  →  1200×675 WebP
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
 * `sha256(renderer version, background hash, sprite hash, placement, output)`
 * — and stored once under the cache directory. The same inputs name the same
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
  SCENE_OUTPUT,
  SpritePlacementSchema,
  layoutSprite,
  type SceneOutputSpec,
  type SpritePlacement,
} from './scenePlacement';

/** Bump when the rendering itself changes, so old cache entries stop matching. */
export const SCENE_RENDERER_VERSION = 1;
export const SCENE_CONTENT_TYPE = 'image/webp';
const SCENE_WEBP_QUALITY = 86;

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
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Render a scene to WebP bytes. Throws on undecodable input. */
export async function renderScene(input: {
  background: Buffer;
  sprite?: { bytes: Buffer; placement: SpritePlacement } | null;
  output?: SceneOutputSpec;
}): Promise<Buffer> {
  const output = input.output ?? SCENE_OUTPUT;
  const decode = (bytes: Buffer) => sharp(bytes, { limitInputPixels: ARTWORK_MAX_PIXELS, failOn: 'error' });

  // Cover: fill the canvas, cropping the overflow, never stretching.
  const canvas = decode(input.background)
    .rotate()
    .resize(output.width, output.height, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#000000' });

  const layers: sharp.OverlayOptions[] = [];
  if (input.sprite) {
    const meta = await decode(input.sprite.bytes).metadata();
    if (!meta.width || !meta.height) throw new Error('sprite has no dimensions');
    const box = layoutSprite({ width: meta.width, height: meta.height }, input.sprite.placement, output);
    const sprite = await decode(input.sprite.bytes)
      .ensureAlpha()
      // `fill` into a box already computed at the sprite's own aspect ratio.
      .resize(box.width, box.height, { fit: 'fill' })
      .png()
      .toBuffer();
    layers.push({ input: sprite, left: box.left, top: box.top });
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

  async function render(key: string, request: SceneRequest): Promise<ComposedScene | null> {
    const target = fileOf(key);
    try {
      if ((await fs.stat(target)).isFile()) {
        return { cacheKey: key, absolutePath: target, contentType: SCENE_CONTENT_TYPE, cached: true };
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

    let rendered: Buffer;
    try {
      rendered = await renderScene({ background, sprite, ...(request.output ? { output: request.output } : {}) });
    } catch (err) {
      deps.logger?.warn({ tag: 'scene/render-failed', cacheKey: key, err }, 'scene could not be composed — falling back');
      return null;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temp, rendered);
    await fs.rename(temp, target);
    return { cacheKey: key, absolutePath: target, contentType: SCENE_CONTENT_TYPE, cached: false };
  }

  return {
    cacheKeyOf: sceneCacheKey,
    compose(request) {
      const key = sceneCacheKey(request);
      // Two screens asking for the same scene at once share one render.
      const running = inFlight.get(key);
      if (running) return running;
      const work = render(key, request).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
      return work;
    },
  };
}
