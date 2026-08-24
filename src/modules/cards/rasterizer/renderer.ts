/**
 * Rasterization — SVG → PNG via resvg, and every layer → WebP via sharp.
 *
 * The layering strategy is the important part. Supplied artwork never passes
 * through resvg: the frame, the icons and the badge are decoded, scaled and
 * composited by sharp, which both preserves their detail (Lanczos, rather than
 * an SVG rasterizer's image scaling) and avoids base64-embedding several
 * megabytes of PNG into a document on every render.
 *
 * resvg only ever sees two small, purely vector documents — the plates and the
 * text — each rasterized on its own transparent canvas and composited in at
 * the right depth. That is what lets a frame be swapped for a redrawn one
 * without any risk to the text layer, and vice versa.
 *
 * Fonts are embedded and system font loading is switched off, so output does
 * not depend on what happens to be installed on the host.
 */
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import sharp from 'sharp';
import type { ArtworkCrop, RasterPlacement } from '../composer/cardComposer';
import { CardTemplateError } from '../errors';
import type { Rect } from '../frameGeometry';
import { CARD_WEBP_QUALITY, CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../version';

/** Family names the embedded fonts register under, matched to the SVG's stacks. */
const SANS_FAMILY = 'Inter';
const SERIF_FAMILY = 'Noto Serif';

/** The card's ground. Only ever visible in the frame's outermost feathered edge. */
const CARD_BACKGROUND = { r: 8, g: 8, b: 14, alpha: 1 } as const;

function renderOptions(fontFiles: string[]): ResvgRenderOptions {
  return {
    font: {
      loadSystemFonts: false,
      fontFiles,
      defaultFontFamily: SANS_FAMILY,
      sansSerifFamily: SANS_FAMILY,
      serifFamily: SERIF_FAMILY,
      cursiveFamily: SERIF_FAMILY,
      fantasyFamily: SANS_FAMILY,
      monospaceFamily: SANS_FAMILY,
    },
    fitTo: { mode: 'original' },
    logLevel: 'off',
  };
}

/**
 * Rasterizes one of the composer's vector layers onto a transparent canvas.
 *
 * A layer that comes back the wrong size would silently shift every element it
 * carries, so the dimensions are checked rather than trusted.
 */
export function renderVectorLayer(svg: string, fontFiles: string[], what: string): Buffer {
  const rendered = new Resvg(svg, renderOptions(fontFiles)).render();
  if (rendered.width !== CARD_MASTER_WIDTH || rendered.height !== CARD_MASTER_HEIGHT) {
    throw new CardTemplateError(
      `${what} layer rasterized to ${rendered.width}x${rendered.height}, expected ${CARD_MASTER_WIDTH}x${CARD_MASTER_HEIGHT}`,
    );
  }
  return rendered.asPng();
}

/** Native pixel size of an encoded image. */
export async function imageSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) {
    throw new CardTemplateError('Could not read the dimensions of a card asset');
  }
  return { width: meta.width, height: meta.height };
}

/**
 * Cover-crops artwork into the art window.
 *
 * Two steps, both in sharp: a single uniform upscale to the covering size, then
 * an extract of exactly the window. The crop offsets come from the composer, so
 * the "which part of the image survives" decision stays with layout and this
 * function stays a pure pixel operation.
 */
export async function renderArtwork(artwork: Buffer, crop: ArtworkCrop): Promise<Buffer> {
  return sharp(artwork)
    .resize(crop.scaledWidth, crop.scaledHeight, { fit: 'fill' })
    .extract({
      left: crop.cropLeft,
      top: crop.cropTop,
      width: crop.width,
      height: crop.height,
    })
    .png()
    .toBuffer();
}

/**
 * Scales the rarity frame to the canvas.
 *
 * `fit: 'fill'` is deliberate. Five of the six frames are already the canvas'
 * aspect ratio and scale uniformly; the sixth (`N`) is off by ~2.3% and takes a
 * matching stretch. Cover-cropping it instead would cut into the decorative
 * border that defines the card's edge, which is the one part of a frame that
 * cannot be trimmed.
 */
export async function renderFrame(frame: Buffer): Promise<Buffer> {
  return sharp(frame)
    .resize(CARD_MASTER_WIDTH, CARD_MASTER_HEIGHT, { fit: 'fill' })
    .png()
    .toBuffer();
}

/** Scales one placed raster asset (an icon, the badge) to its planned box. */
export async function renderPlacement(placement: RasterPlacement): Promise<Buffer> {
  const pipeline = sharp(placement.bytes).resize(placement.width, placement.height, {
    fit: 'fill',
  });
  if (placement.opacity !== undefined && placement.opacity < 1) {
    // Multiplies the existing alpha rather than replacing it, so the asset's
    // own transparent edges survive the fade.
    pipeline.composite([
      {
        input: Buffer.from([255, 255, 255, Math.round(placement.opacity * 255)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in',
      },
    ]);
  }
  return pipeline.png().toBuffer();
}

export interface MasterLayers {
  artwork: Buffer;
  artWindow: Rect;
  underlay: Buffer;
  frame: Buffer;
  /** Icons, then the owned badge when present — drawn in array order. */
  placements: { bytes: Buffer; left: number; top: number }[];
  overlay: Buffer;
}

/**
 * Composites every layer in order and encodes the full-size master.
 *
 * Order is the contract, back to front: background, artwork, plates, frame,
 * icons, badge, text. WebP quality is a renderer constant, not a request
 * parameter — see `version.ts` for why.
 */
export async function compositeMasterWebp(layers: MasterLayers): Promise<Buffer> {
  const canvas = sharp({
    create: {
      width: CARD_MASTER_WIDTH,
      height: CARD_MASTER_HEIGHT,
      channels: 4,
      background: CARD_BACKGROUND,
    },
  });

  return canvas
    .composite([
      { input: layers.artwork, left: layers.artWindow.x, top: layers.artWindow.y },
      { input: layers.underlay, left: 0, top: 0 },
      { input: layers.frame, left: 0, top: 0 },
      ...layers.placements.map((p) => ({ input: p.bytes, left: p.left, top: p.top })),
      { input: layers.overlay, left: 0, top: 0 },
    ])
    .webp({ quality: CARD_WEBP_QUALITY, effort: 4 })
    .toBuffer();
}

export interface ResizedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * Derives a display-width WebP from the cached master. Never re-runs the
 * composite: the master is the canonical render, and every smaller (or
 * slightly larger) size is a pure resize of it.
 */
export async function resizeFromMaster(master: Buffer, width: number): Promise<ResizedImage> {
  const bytes = await sharp(master)
    .resize({ width, fit: 'inside', withoutEnlargement: false })
    .webp({ quality: CARD_WEBP_QUALITY, effort: 4 })
    .toBuffer();
  const meta = await sharp(bytes).metadata();
  return {
    bytes,
    width: meta.width ?? width,
    height: meta.height ?? Math.round((width * CARD_MASTER_HEIGHT) / CARD_MASTER_WIDTH),
  };
}
