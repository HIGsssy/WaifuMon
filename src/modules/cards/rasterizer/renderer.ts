/**
 * Layers 2 and 3: SVG → PNG via resvg, then base + rarity → WebP via sharp.
 *
 * The two SVGs are rasterized independently and only ever meet as pixels. That
 * is what makes rarity overlays hot-swappable: the renderer treats a rarity
 * file as an opaque image, so a future overlay can use any ids, filters, or
 * gradients without risking a collision with the base document.
 *
 * Fonts are embedded and system font loading is switched off, so output does
 * not depend on what happens to be installed on the host.
 */
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import sharp from 'sharp';
import { ARTWORK_HREF } from '../composer/artworkHref';
import { CardTemplateError } from '../errors';
import { CARD_WEBP_QUALITY, MASTER_HEIGHT, MASTER_WIDTH } from '../version';

/** Family names the embedded fonts register under, matched to the SVG's stacks. */
const SANS_FAMILY = 'Inter';
const SERIF_FAMILY = 'Noto Serif';

function renderOptions(fontFiles: string[]): ResvgRenderOptions {
  return {
    font: {
      loadSystemFonts: false,
      fontFiles,
      defaultFontFamily: SANS_FAMILY,
      sansSerifFamily: SANS_FAMILY,
      serifFamily: SERIF_FAMILY,
      // The kit's stacks name Arial/Helvetica/Georgia, none of which we ship;
      // resvg falls through to the generic family, which these map to.
      cursiveFamily: SERIF_FAMILY,
      fantasyFamily: SANS_FAMILY,
      monospaceFamily: SANS_FAMILY,
    },
    fitTo: { mode: 'original' },
    logLevel: 'off',
  };
}

/**
 * Rasterizes the composed base SVG, resolving its `<image>` href to the
 * supplied artwork bytes. Using resvg's `imagesToResolve`/`resolveImage` pair
 * keeps the artwork path out of the SVG document entirely — no `file://`
 * rewriting, and nothing on disk is reachable from authored content.
 *
 * If resvg does not offer the artwork href back to us, the image node was
 * dropped during parse. That would render a card with an empty art window, so
 * it is a hard failure rather than a silent one.
 */
export function renderBasePng(
  svg: string,
  artwork: Buffer,
  fontFiles: string[],
): { png: Buffer; width: number; height: number } {
  const resvg = new Resvg(svg, renderOptions(fontFiles));
  const pending = resvg.imagesToResolve();
  if (!pending.includes(ARTWORK_HREF)) {
    throw new CardTemplateError(
      `Composed base SVG did not expose the artwork image for resolution (offered: ${JSON.stringify(pending)})`,
    );
  }
  for (const href of pending) {
    resvg.resolveImage(href, artwork);
  }
  const rendered = resvg.render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
}

/** Rasterizes a rarity overlay verbatim — no mutation, no id namespacing. */
export function renderOverlayPng(svg: string, fontFiles: string[]): Buffer {
  const resvg = new Resvg(svg, renderOptions(fontFiles));
  return resvg.render().asPng();
}

/**
 * Composites the rarity overlay over the base and encodes the 1000×1400 master.
 * WebP quality is a renderer constant, not a request parameter — see
 * `version.ts` for why.
 */
export async function compositeMasterWebp(basePng: Buffer, overlayPng: Buffer): Promise<Buffer> {
  return sharp(basePng)
    .composite([{ input: overlayPng, blend: 'over' }])
    .webp({ quality: CARD_WEBP_QUALITY, effort: 4 })
    .toBuffer();
}

export interface ResizedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * Derives a display-width WebP from the cached master. Never re-runs resvg:
 * the master is the canonical render, and every smaller (or slightly larger)
 * size is a pure resize of it.
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
    height: meta.height ?? Math.round((width * MASTER_HEIGHT) / MASTER_WIDTH),
  };
}
