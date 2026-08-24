/**
 * Derives `assets/cardart/geometry.json` from the frame PNGs.
 *
 * The frames are ornate raster artwork, not something a human should be
 * measuring by eye. Every frame carries exactly six transparent holes — the
 * artwork window, the information panel, the level shield, and three circular
 * icon holders down the left edge — and this tool finds them by connected
 * component analysis of the alpha channel, then writes them out in *canvas*
 * coordinates so the renderer never does geometry maths at request time.
 *
 * Run it whenever a frame PNG is added or replaced, or when the canvas
 * constants in `src/modules/cards/version.ts` change:
 *
 * ```
 * npm run cards:geometry
 * ```
 *
 * A frame that is not on disk is skipped, not faked. `EX` currently has no
 * frame, so it gets no entry, and the loader turns that into a loud
 * `CardAssetMissingError` rather than a card that wears the wrong rarity.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { RARITIES, type Rarity } from '../db/schema';
import { rarityFrameFile } from '../modules/cards/rarity';
import { DEFAULT_ASSET_ROOT } from '../modules/cards/paths';
import {
  GEOMETRY_FILE,
  GEOMETRY_SCHEMA_VERSION,
  type CardGeometryFile,
  type FrameGeometry,
  type Rect,
} from '../modules/cards/frameGeometry';
import { CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../modules/cards/version';

/** Alpha at or below this counts as a hole. Frame edges are hard, not feathered. */
const ALPHA_THRESHOLD = 60;

/** Components smaller than this are sparkles and ornament gaps, not structure. */
const MIN_COMPONENT_AREA = 10_000;

/**
 * A text band is the set of rows where a hole is at least this fraction of its
 * own widest extent. It deliberately excludes the rounded ends of the panel and
 * the tapered point of the shield, which is exactly the region text must avoid.
 */
const TEXT_BAND_FRACTION = 0.9;

interface Component {
  id: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  touchesEdge: boolean;
}

interface Analysis {
  width: number;
  height: number;
  labels: Int32Array;
  components: Component[];
}

/** Labels every 4-connected run of transparent pixels. */
async function analyzeAlpha(file: string): Promise<Analysis> {
  const image = sharp(file).ensureAlpha();
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const raw = await image.raw().toBuffer();

  const transparent = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    transparent[i] = (raw[i * 4 + 3] ?? 255) < ALPHA_THRESHOLD ? 1 : 0;
  }

  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const components: Component[] = [];

  for (let seed = 0; seed < width * height; seed += 1) {
    if (!transparent[seed] || labels[seed] !== -1) continue;
    const id = components.length;
    let top = 0;
    stack[top++] = seed;
    labels[seed] = id;

    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let touchesEdge = false;

    while (top > 0) {
      const p = stack[--top] as number;
      const x = p % width;
      const y = (p - x) / width;
      area += 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && transparent[p - 1] && labels[p - 1] === -1) {
        labels[p - 1] = id;
        stack[top++] = p - 1;
      }
      if (x < width - 1 && transparent[p + 1] && labels[p + 1] === -1) {
        labels[p + 1] = id;
        stack[top++] = p + 1;
      }
      if (y > 0 && transparent[p - width] && labels[p - width] === -1) {
        labels[p - width] = id;
        stack[top++] = p - width;
      }
      if (y < height - 1 && transparent[p + width] && labels[p + width] === -1) {
        labels[p + width] = id;
        stack[top++] = p + width;
      }
    }

    components.push({ id, area, minX, maxX, minY, maxY, touchesEdge });
  }

  return { width, height, labels, components };
}

/**
 * Rows of one component that run at least {@link TEXT_BAND_FRACTION} of its
 * widest extent, intersected across those rows. This is the widest rectangle
 * text can occupy without poking into a rounded corner or a taper.
 */
function textBand(analysis: Analysis, component: Component): Rect {
  const { labels, width } = analysis;
  const fullWidth = component.maxX - component.minX + 1;
  const minimum = TEXT_BAND_FRACTION * fullWidth;

  let bandTop = -1;
  let bandBottom = -1;
  let left = 0;
  let right = width;

  for (let y = component.minY; y <= component.maxY; y += 1) {
    let rowStart = -1;
    let rowEnd = -1;
    for (let x = component.minX; x <= component.maxX; x += 1) {
      if (labels[y * width + x] === component.id) {
        if (rowStart < 0) rowStart = x;
        rowEnd = x;
      }
    }
    if (rowStart < 0 || rowEnd - rowStart + 1 < minimum) continue;

    if (bandTop < 0) {
      bandTop = y;
      left = rowStart;
      right = rowEnd;
    }
    bandBottom = y;
    left = Math.max(left, rowStart);
    right = Math.min(right, rowEnd);
  }

  if (bandTop < 0) {
    // Degenerate shape — fall back to the bounding box so a new frame with an
    // unusual hole still produces a usable (if conservative) manifest.
    return {
      x: component.minX,
      y: component.minY,
      w: fullWidth,
      h: component.maxY - component.minY + 1,
    };
  }

  return { x: left, y: bandTop, w: right - left + 1, h: bandBottom - bandTop + 1 };
}

function boundingRect(component: Component): Rect {
  return {
    x: component.minX,
    y: component.minY,
    w: component.maxX - component.minX + 1,
    h: component.maxY - component.minY + 1,
  };
}

/** Scales a source-pixel rect onto the canvas. */
function scaleRect(rect: Rect, sx: number, sy: number): Rect {
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    w: Math.round(rect.w * sx),
    h: Math.round(rect.h * sy),
  };
}

export function deriveFrameGeometry(analysis: Analysis, rarity: Rarity): FrameGeometry {
  const structural = analysis.components
    .filter((c) => !c.touchesEdge && c.area >= MIN_COMPONENT_AREA)
    .sort((a, b) => b.area - a.area);

  if (structural.length < 6) {
    throw new Error(
      `${rarity} frame: expected 6 structural holes (art, panel, shield, 3 circles), found ${structural.length}`,
    );
  }

  const [art, panel, ...rest] = structural as [Component, Component, ...Component[]];

  // The shield is the only structural hole on the right half of the frame.
  const shield = rest
    .filter((c) => c.minX > analysis.width * 0.5)
    .sort((a, b) => b.area - a.area)[0];
  if (!shield) throw new Error(`${rarity} frame: no level shield found on the right half`);

  // The three icon holders run down the left edge, top to bottom.
  const circles = rest
    .filter((c) => c.minX < analysis.width * 0.4)
    .sort((a, b) => a.minY - b.minY)
    .slice(0, 3);
  if (circles.length !== 3) {
    throw new Error(`${rarity} frame: expected 3 icon circles, found ${circles.length}`);
  }

  const sx = CARD_MASTER_WIDTH / analysis.width;
  const sy = CARD_MASTER_HEIGHT / analysis.height;

  const toDisc = (component: Component) => {
    const box = boundingRect(component);
    return {
      cx: Math.round((box.x + box.w / 2) * sx),
      cy: Math.round((box.y + box.h / 2) * sy),
      // Averaged across both axes: the holes are circles, and averaging keeps a
      // non-uniform frame scale (the N frame) from producing an oval icon.
      d: Math.round((box.w * sx + box.h * sy) / 2),
    };
  };

  const [race, affinity, rarityDisc] = circles as [Component, Component, Component];

  return {
    source: { width: analysis.width, height: analysis.height },
    art: scaleRect(boundingRect(art), sx, sy),
    panel: scaleRect(boundingRect(panel), sx, sy),
    panelText: scaleRect(textBand(analysis, panel), sx, sy),
    shield: scaleRect(boundingRect(shield), sx, sy),
    shieldText: scaleRect(textBand(analysis, shield), sx, sy),
    circles: {
      race: toDisc(race),
      affinity: toDisc(affinity),
      rarity: toDisc(rarityDisc),
    },
  };
}

async function main(): Promise<void> {
  const assetRoot = DEFAULT_ASSET_ROOT;
  const frames: Partial<Record<Rarity, FrameGeometry>> = {};
  const skipped: Rarity[] = [];

  for (const rarity of RARITIES) {
    const file = path.join(assetRoot, 'frames', rarityFrameFile(rarity));
    try {
      await fs.access(file);
    } catch {
      skipped.push(rarity);
      continue;
    }
    const analysis = await analyzeAlpha(file);
    frames[rarity] = deriveFrameGeometry(analysis, rarity);
    const geometry = frames[rarity] as FrameGeometry;
    console.log(
      `${rarity.padEnd(4)} ${analysis.width}x${analysis.height}` +
        `  art ${geometry.art.x},${geometry.art.y} ${geometry.art.w}x${geometry.art.h}` +
        `  panel ${geometry.panel.x},${geometry.panel.y} ${geometry.panel.w}x${geometry.panel.h}` +
        `  shield ${geometry.shield.x},${geometry.shield.y} ${geometry.shield.w}x${geometry.shield.h}`,
    );
  }

  const output: CardGeometryFile = {
    schemaVersion: GEOMETRY_SCHEMA_VERSION,
    canvas: { width: CARD_MASTER_WIDTH, height: CARD_MASTER_HEIGHT },
    frames,
  };

  const target = path.join(assetRoot, GEOMETRY_FILE);
  await fs.writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`\nWrote ${target}`);
  if (skipped.length > 0) {
    console.log(
      `No frame PNG for: ${skipped.join(', ')} — those rarities will fail to render, by design.`,
    );
  }
  console.log('Remember to bump assets/cardart/VERSION.');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
