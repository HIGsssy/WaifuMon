/**
 * Frame geometry — where the holes in each rarity frame are.
 *
 * The frames are supplied artwork. Their artwork window, information panel,
 * level shield and three icon holders sit at slightly different offsets in
 * every rarity, and nobody should be transcribing those by hand into a
 * coordinate table that silently rots the first time a frame is re-exported.
 *
 * So the numbers are *derived* from the PNGs by `src/tools/deriveFrameGeometry.ts`
 * and committed as `assets/cardart/geometry.json`. This module is the read
 * side: it parses that file, checks it was generated for the canvas the
 * renderer is currently built for, and hands back plain rects.
 *
 * Everything here is already in **canvas coordinates** (see
 * {@link CardGeometryFile.canvas}), so the composer never scales anything.
 */
import { CardAssetMissingError, CardTemplateError } from './errors';
import type { Rarity } from '../../db/schema';

/** Kit-relative path of the generated manifest. */
export const GEOMETRY_FILE = 'geometry.json';

/**
 * Bumped when the *shape* of the manifest changes, so an old `geometry.json`
 * left behind by a stale checkout fails loudly instead of being half-read.
 */
export const GEOMETRY_SCHEMA_VERSION = 1;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A circular icon holder: centre and diameter, in canvas pixels. */
export interface Disc {
  cx: number;
  cy: number;
  d: number;
}

export interface FrameGeometry {
  /** Native pixel size of the frame PNG this was measured from. */
  source: { width: number; height: number };
  /** The artwork window. Character art is cover-cropped into exactly this box. */
  art: Rect;
  /** The full information-panel hole — the dark plate is drawn here. */
  panel: Rect;
  /** The rectangular part of the panel that clears its rounded ends. Text goes here. */
  panelText: Rect;
  /** The full level-shield hole — the shield plate is drawn here. */
  shield: Rect;
  /** The rectangular part of the shield that clears its taper. Level text goes here. */
  shieldText: Rect;
  /** Top to bottom down the left edge: race, affinity, rarity. */
  circles: { race: Disc; affinity: Disc; rarity: Disc };
}

export interface CardGeometryFile {
  schemaVersion: number;
  /** The canvas the rects were scaled to. Must match the renderer's constants. */
  canvas: { width: number; height: number };
  /**
   * Partial on purpose. A rarity with no frame PNG has no entry, and asking
   * for it is a hard error — never a substituted frame from another rarity.
   */
  frames: Partial<Record<Rarity, FrameGeometry>>;
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)
  );
}

function isDisc(value: unknown): value is Disc {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return Number.isFinite(d.cx) && Number.isFinite(d.cy) && Number.isFinite(d.d);
}

function isFrameGeometry(value: unknown): value is FrameGeometry {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Record<string, unknown>;
  const circles = g.circles as Record<string, unknown> | undefined;
  return (
    isRect(g.art) &&
    isRect(g.panel) &&
    isRect(g.panelText) &&
    isRect(g.shield) &&
    isRect(g.shieldText) &&
    circles !== undefined &&
    isDisc(circles.race) &&
    isDisc(circles.affinity) &&
    isDisc(circles.rarity)
  );
}

/**
 * Parses and validates the manifest.
 *
 * The canvas check is the load-bearing one: `geometry.json` holds absolute
 * canvas pixels, so changing `CARD_MASTER_WIDTH`/`HEIGHT` without regenerating
 * would place every element at the wrong coordinates while still "working".
 * That has to fail at boot, not look slightly off in production.
 */
export function parseCardGeometry(
  json: string,
  expected: { width: number; height: number },
  sourcePath: string,
): CardGeometryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new CardTemplateError(`${sourcePath} is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CardTemplateError(`${sourcePath} is not an object`);
  }
  const file = parsed as Record<string, unknown>;

  if (file.schemaVersion !== GEOMETRY_SCHEMA_VERSION) {
    throw new CardTemplateError(
      `${sourcePath} has schemaVersion ${String(file.schemaVersion)}, expected ${GEOMETRY_SCHEMA_VERSION} — re-run "npm run cards:geometry"`,
    );
  }

  const canvas = file.canvas as { width?: unknown; height?: unknown } | undefined;
  if (canvas?.width !== expected.width || canvas?.height !== expected.height) {
    throw new CardTemplateError(
      `${sourcePath} was generated for a ${String(canvas?.width)}x${String(canvas?.height)} canvas, ` +
        `but the renderer is built for ${expected.width}x${expected.height} — re-run "npm run cards:geometry"`,
    );
  }

  const frames = file.frames;
  if (typeof frames !== 'object' || frames === null) {
    throw new CardTemplateError(`${sourcePath} has no "frames" object`);
  }

  for (const [rarity, geometry] of Object.entries(frames as Record<string, unknown>)) {
    if (!isFrameGeometry(geometry)) {
      throw new CardTemplateError(`${sourcePath}: frame geometry for "${rarity}" is malformed`);
    }
  }

  return {
    schemaVersion: GEOMETRY_SCHEMA_VERSION,
    canvas: { width: expected.width, height: expected.height },
    frames: frames as Partial<Record<Rarity, FrameGeometry>>,
  };
}

/**
 * Geometry for one rarity.
 *
 * A rarity with no entry has no frame PNG — today that is `EX`. It raises the
 * same missing-asset error as any other absent kit file, because a card that
 * wears another rarity's frame is worse than a card that refuses to render.
 */
export function frameGeometryFor(
  file: CardGeometryFile,
  rarity: Rarity,
  framePath: string,
): FrameGeometry {
  const geometry = file.frames[rarity];
  if (!geometry) {
    throw new CardAssetMissingError(framePath, `frame geometry for rarity ${rarity}`);
  }
  return geometry;
}
