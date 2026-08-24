/**
 * Composition — turns one card's data plus a frame's geometry into a layer
 * plan.
 *
 * The division of labour here is the whole design:
 *
 *   - **Raster assets stay raster.** The frame, the three icons and the owned
 *     badge are supplied artwork. They are placed, scaled and composited as
 *     pixels by sharp; nothing here redraws them, recolours them, or routes
 *     them through an SVG rasterizer.
 *   - **SVG is the layout and text layer only.** Two small transparent
 *     documents come out of this module: an *underlay* of dark plates that sits
 *     beneath the frame, and an *overlay* of dynamic text that sits above
 *     everything. Both are pure vector — no embedded images.
 *
 * Every coordinate is read from `geometry.json` (derived from the frame PNGs)
 * and every size is expressed as a fraction of the box it lives in, so the six
 * frames — which differ by tens of pixels in every dimension — all lay out
 * correctly from one table.
 *
 * Changing anything in {@link LAYOUT} changes pixels: bump
 * `CARD_RENDERER_VERSION`.
 */
import type { Affinity } from '../../../db/schema';
import { escapeXml, fitText, normalizeWhitespace, TEXT_LIMITS, truncate, wrapToTwoLines } from '../text';
import type { Disc, FrameGeometry, Rect } from '../frameGeometry';
import type { RaceCode } from '../race';
import type { Rarity } from '../rarity';
import type { SpeciesCardMeta } from '../types';

/**
 * The card's layout, in units relative to the box each element occupies.
 *
 * Absolute pixels appear nowhere in this file. The frames were drawn at
 * slightly different scales and their holes sit at slightly different offsets,
 * so a fixed pixel table would need six copies and would be wrong again the
 * first time a frame is re-exported.
 */
export const LAYOUT = {
  /**
   * Side of the square an icon PNG is drawn at, as a multiple of its holder's
   * diameter.
   *
   * The icons are 512px squares whose ring is ~412px across, with diamond
   * points reaching ~436px. At 1.38 the ring lands at ~1.11x the hole, so it
   * laps the holder's inner rim — no sliver of artwork shows through the gap —
   * and the points overhang slightly onto the frame, which reads as intended
   * rather than as an overflow.
   */
  iconFill: 1.38,

  /**
   * Fraction of the surplus height removed from the *top* when cover-cropping
   * artwork into the art window.
   *
   * The window is much squarer than the 13:19 source, so a cover fit always
   * has height to discard. Faces outrank boots, so most of it comes off the
   * bottom — but not all of it: hair and ears sit hard against the top edge in
   * these compositions, and cropping nothing off the top clips them.
   */
  artFocusY: 0.25,

  /** Level shield. Both lines are centred; the number is the dominant element. */
  shield: {
    labelText: 'LVL',
    labelSize: 0.2,
    labelBaseline: 0.24,
    labelTracking: 3,
    valueSize: 0.62,
    valueBaseline: 0.92,
  },

  /** Information panel. Four rows: name, two description lines, credit row. */
  panel: {
    nameSize: 0.32,
    nameBaseline: 0.3,
    nameTracking: 4,
    /** Tried in order against the panel's text width before truncating. */
    nameTiers: [1, 0.84, 0.7] as const,

    descriptionSize: 0.115,
    descriptionBaseline1: 0.505,
    descriptionBaseline2: 0.645,

    creditSize: 0.082,
    creditBaseline: 0.94,
    brandText: 'WAIFUMON',
    brandTracking: 6,

    /** Corner radius of the dark plate, as a fraction of the panel's height. */
    plateRadius: 0.44,
  },

  /**
   * Ownership badge — provisional placement.
   *
   * The supplied "CAUGHT" emblem is a large, near-full-bleed graphic, so it is
   * deliberately restrained here: a stamp in the lower-left of the artwork
   * window, clear of the icon column and of the panel below it. All four
   * numbers are named so a test render can be re-judged and retuned without
   * touching composition logic.
   *
   * `width` is a fraction of the *art window* width, not the card, so it stays
   * proportional across frames. The anchor is the badge's own bottom-left
   * corner, expressed as a fraction of the art window.
   */
  ownedBadge: {
    width: 0.3,
    anchorX: 0.06,
    anchorY: 0.97,
    opacity: 0.94,
  },
} as const;

/** Icons in holder order, top to bottom. Never labelled — the art carries it. */
export type IconSlot = 'race' | 'affinity' | 'rarity';

/** One raster asset placed on the canvas. */
export interface RasterPlacement {
  bytes: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity?: number;
}

export interface ComposeCardInput {
  geometry: FrameGeometry;
  name: string;
  race: RaceCode;
  affinity: Affinity;
  rarity: Rarity;
  level: number;
  description: string | null;
  card: SpeciesCardMeta;
  icons: Record<IconSlot, Buffer>;
  /** Present only when the caller asked for an ownership presentation. */
  ownedBadge?: Buffer | undefined;
}

/** Where the artwork lands inside the art window, after a cover fit. */
export interface ArtworkCrop {
  /** Size the source is scaled to before cropping. */
  scaledWidth: number;
  scaledHeight: number;
  /** Top-left of the crop rectangle within the scaled image. */
  cropLeft: number;
  cropTop: number;
  /** The crop, which is exactly the art window. */
  width: number;
  height: number;
}

/**
 * Cover fit: scale until both axes are covered, then crop the surplus —
 * horizontally centred, vertically biased toward the face.
 *
 * Never stretches. The scale is a single factor applied to both axes, so a
 * character's proportions survive whatever shape the window happens to be.
 */
export function planArtworkCrop(
  source: { width: number; height: number },
  window: Rect,
  focusY: number = LAYOUT.artFocusY,
): ArtworkCrop {
  const scale = Math.max(window.w / source.width, window.h / source.height);
  const scaledWidth = Math.max(window.w, Math.round(source.width * scale));
  const scaledHeight = Math.max(window.h, Math.round(source.height * scale));

  const cropLeft = Math.round((scaledWidth - window.w) / 2);
  const cropTop = Math.round((scaledHeight - window.h) * focusY);

  return {
    scaledWidth,
    scaledHeight,
    cropLeft: clamp(cropLeft, 0, scaledWidth - window.w),
    cropTop: clamp(cropTop, 0, scaledHeight - window.h),
    width: window.w,
    height: window.h,
  };
}

/** The square an icon PNG is drawn at, centred on its holder. */
export function planIconPlacement(disc: Disc, bytes: Buffer): RasterPlacement {
  const side = Math.round(disc.d * LAYOUT.iconFill);
  return {
    bytes,
    width: side,
    height: side,
    left: Math.round(disc.cx - side / 2),
    top: Math.round(disc.cy - side / 2),
  };
}

/**
 * The owned badge, anchored inside the art window.
 *
 * Clamped to the art window so a future badge with a different aspect ratio
 * cannot push itself off the artwork and over the frame's border.
 */
export function planOwnedBadge(
  window: Rect,
  bytes: Buffer,
  source: { width: number; height: number },
): RasterPlacement {
  const cfg = LAYOUT.ownedBadge;

  // Width drives the size, but a badge whose aspect ratio makes it taller than
  // the window it lives in has to shrink instead of overflowing onto the frame.
  // Today's asset is landscape and never hits this; a redrawn one might.
  let width = Math.max(1, Math.round(window.w * cfg.width));
  let height = Math.max(1, Math.round((width * source.height) / source.width));
  if (height > window.h) {
    height = window.h;
    width = Math.max(1, Math.round((height * source.width) / source.height));
  }

  const left = Math.round(window.x + window.w * cfg.anchorX);
  const top = Math.round(window.y + window.h * cfg.anchorY - height);

  return {
    bytes,
    width,
    height,
    left: clamp(left, window.x, window.x + window.w - width),
    top: clamp(top, window.y, window.y + window.h - height),
    opacity: cfg.opacity,
  };
}

/**
 * The plates that sit under the frame.
 *
 * Both the panel and the shield are *holes* in the frame artwork — without a
 * plate behind them the character shows through and the text becomes
 * unreadable over a busy image. The plates are drawn under the frame so its
 * ornate border laps over their edges, which is what makes them read as part
 * of the frame rather than as rectangles dropped on top of it.
 */
export function buildUnderlaySvg(
  geometry: FrameGeometry,
  canvas: { width: number; height: number },
): string {
  const p = geometry.panel;
  const s = geometry.shield;
  const radius = Math.round(p.h * LAYOUT.panel.plateRadius);

  return [
    svgOpen(canvas),
    '<defs>',
    '<linearGradient id="panelPlate" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#120b16" stop-opacity="0.95"/>',
    '<stop offset="1" stop-color="#07050a" stop-opacity="0.98"/>',
    '</linearGradient>',
    '<radialGradient id="shieldPlate">',
    '<stop offset="0" stop-color="#1a0d18" stop-opacity="0.95"/>',
    '<stop offset="1" stop-color="#07050a" stop-opacity="0.92"/>',
    '</radialGradient>',
    '</defs>',
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${radius}" fill="url(#panelPlate)"/>`,
    `<ellipse cx="${round(s.x + s.w / 2)}" cy="${round(s.y + s.h * 0.45)}"` +
      ` rx="${round(s.w * 0.52)}" ry="${round(s.h * 0.46)}" fill="url(#shieldPlate)"/>`,
    '</svg>',
  ].join('');
}

/**
 * The dynamic text layer.
 *
 * Every string on a card is drawn here, at render time, from data — nothing is
 * baked into a raster asset. Styling is deliberately restrained: a gradient
 * fill and a dark `paint-order` stroke on the two headline elements, a drop
 * shadow on everything, and nothing else. The type is Inter, bundled with the
 * kit, so output never depends on what fonts the host happens to have.
 *
 * Elements whose data is absent are simply not emitted, so a card with no
 * artist credit reads as a clean card rather than a card with a hole in it.
 */
export function buildOverlaySvg(
  input: ComposeCardInput,
  canvas: { width: number; height: number },
): string {
  const parts: string[] = [
    svgOpen(canvas),
    '<defs>',
    '<linearGradient id="headline" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#fff6e0"/>',
    '<stop offset="0.55" stop-color="#f6d488"/>',
    '<stop offset="1" stop-color="#c99433"/>',
    '</linearGradient>',
    '<filter id="textShadow" x="-30%" y="-30%" width="160%" height="160%">',
    '<feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#000000" flood-opacity="0.85"/>',
    '</filter>',
    '</defs>',
    '<g font-family="Inter" filter="url(#textShadow)">',
  ];

  parts.push(...shieldText(input.geometry.shieldText, input.level));
  parts.push(...panelText(input));

  parts.push('</g>', '</svg>');
  return parts.join('');
}

/** `LVL` over the level itself, both centred, the number dominant. */
function shieldText(band: Rect, level: number): string[] {
  const cfg = LAYOUT.shield;
  const cx = round(band.x + band.w / 2);
  const value = String(Math.max(1, Math.trunc(level)));

  return [
    text({
      x: cx,
      y: round(band.y + cfg.labelBaseline * band.h),
      size: round(cfg.labelSize * band.h),
      anchor: 'middle',
      weight: 800,
      tracking: cfg.labelTracking,
      fill: '#e7d6a6',
      content: cfg.labelText,
    }),
    text({
      x: cx,
      y: round(band.y + cfg.valueBaseline * band.h),
      size: round(cfg.valueSize * band.h),
      anchor: 'middle',
      weight: 900,
      fill: 'url(#headline)',
      stroke: '#2b1206',
      strokeWidth: 2.5,
      content: value,
    }),
  ];
}

/**
 * Name, flavour text, and the credit row.
 *
 * The credit row is one baseline carrying three anchors — artist at the left
 * edge, the wordmark centred, the collector number at the right — so it stays
 * balanced whether or not the optional fields are present.
 */
function panelText(input: ComposeCardInput): string[] {
  const cfg = LAYOUT.panel;
  const band = input.geometry.panelText;
  const cx = round(band.x + band.w / 2);
  const out: string[] = [];

  const name = truncate(normalizeWhitespace(input.name), TEXT_LIMITS.characterName).toUpperCase();
  const nameSize = cfg.nameSize * band.h;
  const fitted = fitText(
    name,
    band.w,
    cfg.nameTiers.map((tier) => round(nameSize * tier)),
    true,
  );
  out.push(
    text({
      x: cx,
      y: round(band.y + cfg.nameBaseline * band.h),
      size: fitted.fontSize,
      anchor: 'middle',
      weight: 900,
      tracking: cfg.nameTracking,
      fill: 'url(#headline)',
      stroke: '#2b1206',
      strokeWidth: 2.5,
      content: fitted.text,
    }),
  );

  const descriptionSize = round(cfg.descriptionSize * band.h);
  const description = input.description === null ? '' : normalizeWhitespace(input.description);
  if (description.length > 0) {
    const [line1, line2] = wrapToTwoLines(description, band.w, descriptionSize);
    // A description that fits on one line is centred between the two baselines
    // rather than left sitting on the first. Otherwise a short flavour line
    // hangs under the name with a hole beneath it, and the panel reads as
    // though something failed to render.
    const baselines =
      line2.length > 0
        ? [cfg.descriptionBaseline1, cfg.descriptionBaseline2]
        : [(cfg.descriptionBaseline1 + cfg.descriptionBaseline2) / 2];

    for (const [index, line] of [line1, line2].entries()) {
      const baseline = baselines[index];
      if (line.length === 0 || baseline === undefined) continue;
      out.push(
        text({
          x: cx,
          y: round(band.y + baseline * band.h),
          size: descriptionSize,
          anchor: 'middle',
          fill: '#e9e2f2',
          content: line,
        }),
      );
    }
  }

  const creditSize = round(cfg.creditSize * band.h);
  const creditY = round(band.y + cfg.creditBaseline * band.h);

  out.push(
    text({
      x: cx,
      y: creditY,
      size: creditSize,
      anchor: 'middle',
      weight: 700,
      tracking: cfg.brandTracking,
      fill: '#c8a35e',
      content: cfg.brandText,
    }),
  );

  const artist = cleanForPanel(input.card.artist, TEXT_LIMITS.artist);
  if (artist) {
    out.push(
      text({
        x: band.x,
        y: creditY,
        size: creditSize,
        anchor: 'start',
        fill: '#a99cb8',
        content: `Artist — ${artist}`,
      }),
    );
  }

  const cardNumber = cleanForPanel(input.card.cardNumber, TEXT_LIMITS.cardNumber);
  if (cardNumber) {
    out.push(
      text({
        x: band.x + band.w,
        y: creditY,
        size: creditSize,
        anchor: 'end',
        fill: '#a99cb8',
        content: cardNumber,
      }),
    );
  }

  return out;
}

interface TextSpec {
  x: number;
  y: number;
  size: number;
  anchor: 'start' | 'middle' | 'end';
  content: string;
  weight?: number;
  tracking?: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * One `<text>` element. Content is XML-escaped here — this is the single place
 * authored strings become markup, which is what keeps a name containing `&` or
 * `<` from producing an unparseable document.
 */
function text(spec: TextSpec): string {
  const attrs = [
    `x="${spec.x}"`,
    `y="${spec.y}"`,
    `font-size="${spec.size}"`,
    `text-anchor="${spec.anchor}"`,
    `fill="${spec.fill}"`,
  ];
  if (spec.weight !== undefined) attrs.push(`font-weight="${spec.weight}"`);
  if (spec.tracking !== undefined) attrs.push(`letter-spacing="${spec.tracking}"`);
  if (spec.stroke !== undefined) {
    attrs.push(`stroke="${spec.stroke}"`);
    attrs.push(`stroke-width="${spec.strokeWidth ?? 2}"`);
    attrs.push('paint-order="stroke"');
    attrs.push('stroke-linejoin="round"');
  }
  return `<text ${attrs.join(' ')}>${escapeXml(spec.content)}</text>`;
}

function cleanForPanel(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) return null;
  return truncate(normalized, maxChars);
}

function svgOpen(canvas: { width: number; height: number }): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"` +
    ` viewBox="0 0 ${canvas.width} ${canvas.height}">`
  );
}

function round(value: number): number {
  return Math.round(value);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
