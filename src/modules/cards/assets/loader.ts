/**
 * Reads the card kit off disk and memoizes it per loader instance.
 *
 * The kit is now mostly raster: seven ornate transparent frames, nineteen
 * icons, one ownership badge, five fonts, and one generated geometry manifest.
 * Memoization is per-instance rather than module-global so a test can point a
 * loader at a temp copy of the kit and get a clean read, and so a `VERSION`
 * bump takes effect on the next process/renderer rather than being pinned by a
 * stale global.
 *
 * The kit is a few megabytes and changes only on deploy, so holding it for the
 * life of the renderer is the right trade — it takes the frame and icon reads
 * off the hot path entirely, leaving only the artwork read per card.
 *
 * **This is the only place that maps a taxonomy value to a file.** Nothing in
 * the composer or the rasterizer builds an asset path; they receive bytes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CardAssetMissingError } from '../errors';
import { affinityIconFile, AFFINITIES, type Affinity } from '../affinity';
import {
  isRenderableRarity,
  rarityFrameFile,
  rarityIconFile,
  RENDERABLE_RARITIES,
  RARITIES,
  type Rarity,
} from '../rarity';
import { RACE_CODES, type RaceCode } from '../race';
import {
  frameGeometryFor,
  parseCardGeometry,
  GEOMETRY_FILE,
  type CardGeometryFile,
  type FrameGeometry,
} from '../frameGeometry';
import { CARD_MASTER_HEIGHT, CARD_MASTER_WIDTH } from '../version';

/** Font files loaded into resvg, in `assets/cardart/fonts/`. */
export const FONT_FILES = [
  'Inter-Regular.ttf',
  'Inter-Bold.ttf',
  'Inter-ExtraBold.ttf',
  'Inter-Black.ttf',
  'NotoSerif-Italic.ttf',
] as const;

export const VERSION_FILE = 'VERSION';
export const OWNED_BADGE_FILE = path.join('badges', 'owned.png');

export class CardAssetLoader {
  readonly assetRoot: string;
  private readonly textCache = new Map<string, Promise<string>>();
  private readonly binaryCache = new Map<string, Promise<Buffer>>();
  private versionCache: Promise<string> | undefined;
  private geometryCache: Promise<CardGeometryFile> | undefined;

  constructor(assetRoot: string) {
    this.assetRoot = assetRoot;
  }

  /** Absolute path for a kit-relative path, e.g. `frames/ur.png`. */
  resolve(relative: string): string {
    return path.join(this.assetRoot, relative);
  }

  // ---------------------------------------------------------------- paths

  framePath(rarity: Rarity): string {
    return this.resolve(path.join('frames', rarityFrameFile(rarity)));
  }

  raceIconPath(race: RaceCode): string {
    return this.resolve(path.join('icons', 'races', `${race}.png`));
  }

  affinityIconPath(affinity: Affinity): string {
    return this.resolve(path.join('icons', 'affinities', affinityIconFile(affinity)));
  }

  rarityIconPath(rarity: Rarity): string {
    return this.resolve(path.join('icons', 'rarity', rarityIconFile(rarity)));
  }

  ownedBadgePath(): string {
    return this.resolve(OWNED_BADGE_FILE);
  }

  fontPaths(): string[] {
    return FONT_FILES.map((f) => this.resolve(path.join('fonts', f)));
  }

  // ----------------------------------------------------------------- reads

  /**
   * Reads a kit file as UTF-8, memoized. A missing file surfaces as a typed
   * {@link CardAssetMissingError} rather than a raw ENOENT so callers upstack
   * can distinguish "install is broken" from "this species has no artwork".
   */
  async readText(relative: string, what: string): Promise<string> {
    const cached = this.textCache.get(relative);
    if (cached) return cached;

    const absolute = this.resolve(relative);
    const pending = fs.readFile(absolute, 'utf8').catch((err: unknown) => {
      this.textCache.delete(relative);
      if (isNotFound(err)) throw new CardAssetMissingError(absolute, what);
      throw err;
    });
    this.textCache.set(relative, pending);
    return pending;
  }

  /** As {@link readText}, for the raster half of the kit. */
  async readBinary(relative: string, what: string): Promise<Buffer> {
    const cached = this.binaryCache.get(relative);
    if (cached) return cached;

    const absolute = this.resolve(relative);
    const pending = fs.readFile(absolute).catch((err: unknown) => {
      this.binaryCache.delete(relative);
      if (isNotFound(err)) throw new CardAssetMissingError(absolute, what);
      throw err;
    });
    this.binaryCache.set(relative, pending);
    return pending;
  }

  /**
   * The rarity frame. `EX` has no artwork yet, so it fails here with the same
   * missing-asset error a broken install produces — never another rarity's
   * frame.
   */
  frame(rarity: Rarity): Promise<Buffer> {
    if (!isRenderableRarity(rarity)) {
      return Promise.reject(
        new CardAssetMissingError(this.framePath(rarity), `frame for rarity ${rarity}`),
      );
    }
    return this.readBinary(path.join('frames', rarityFrameFile(rarity)), `frame ${rarity}`);
  }

  raceIcon(race: RaceCode): Promise<Buffer> {
    return this.readBinary(path.join('icons', 'races', `${race}.png`), `race icon ${race}`);
  }

  affinityIcon(affinity: Affinity): Promise<Buffer> {
    return this.readBinary(
      path.join('icons', 'affinities', affinityIconFile(affinity)),
      `affinity icon ${affinity}`,
    );
  }

  rarityIcon(rarity: Rarity): Promise<Buffer> {
    return this.readBinary(
      path.join('icons', 'rarity', rarityIconFile(rarity)),
      `rarity icon ${rarity}`,
    );
  }

  ownedBadge(): Promise<Buffer> {
    return this.readBinary(OWNED_BADGE_FILE, 'owned badge');
  }

  /**
   * The generated geometry manifest, parsed and checked against the canvas the
   * renderer is built for. See `frameGeometry.ts` for why that check matters.
   */
  geometry(): Promise<CardGeometryFile> {
    this.geometryCache ??= this.readText(GEOMETRY_FILE, 'frame geometry').then((json) =>
      parseCardGeometry(
        json,
        { width: CARD_MASTER_WIDTH, height: CARD_MASTER_HEIGHT },
        this.resolve(GEOMETRY_FILE),
      ),
    );
    return this.geometryCache;
  }

  /** Geometry for one rarity, or {@link CardAssetMissingError} if it has none. */
  async frameGeometry(rarity: Rarity): Promise<FrameGeometry> {
    return frameGeometryFor(await this.geometry(), rarity, this.framePath(rarity));
  }

  /**
   * Contents of `assets/cardart/VERSION`, trimmed. Read once per loader: a
   * long-running process picks up a bump on restart, which is the documented
   * workflow (a deploy ships new assets and a new process together).
   */
  kitVersion(): Promise<string> {
    this.versionCache ??= this.readText(VERSION_FILE, 'kit VERSION').then((v) => v.trim());
    return this.versionCache;
  }

  /**
   * Every file the renderer requires, as kit-relative paths.
   *
   * Rarities without frame artwork are excluded on purpose: `EX` failing at
   * *render* time is the designed behaviour, but it must not stop the process
   * from starting and serving the six rarities that do have frames.
   */
  requiredFiles(): { relative: string; what: string }[] {
    return [
      { relative: VERSION_FILE, what: 'kit VERSION' },
      { relative: GEOMETRY_FILE, what: 'frame geometry' },
      { relative: OWNED_BADGE_FILE, what: 'owned badge' },
      ...RENDERABLE_RARITIES.map((r) => ({
        relative: path.join('frames', rarityFrameFile(r)),
        what: `frame ${r}`,
      })),
      ...RARITIES.map((r) => ({
        relative: path.join('icons', 'rarity', rarityIconFile(r)),
        what: `rarity icon ${r}`,
      })),
      ...RACE_CODES.map((race) => ({
        relative: path.join('icons', 'races', `${race}.png`),
        what: `race icon ${race}`,
      })),
      ...AFFINITIES.map((a) => ({
        relative: path.join('icons', 'affinities', affinityIconFile(a)),
        what: `affinity icon ${a}`,
      })),
      ...FONT_FILES.map((f) => ({ relative: path.join('fonts', f), what: `font ${f}` })),
    ];
  }
}

export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
