/**
 * Reads the SVG kit off disk and memoizes it per loader instance.
 *
 * Memoization is per-instance rather than module-global so a test can point a
 * loader at a temp copy of the kit and get a clean read, and so a `VERSION`
 * bump takes effect on the next process/renderer rather than being pinned by a
 * stale global. Card assets are small (the whole kit is well under a megabyte
 * of SVG plus ~1.9 MB of fonts) and change only on deploy, so caching them for
 * the life of the renderer is free.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CardAssetMissingError } from '../errors';
import { affinityIconFile, AFFINITIES, type Affinity } from '../affinity';
import { rarityOverlayFile, RARITIES, type Rarity } from '../rarity';
import { RACE_CODES, type RaceCode } from '../race';

/** Font files loaded into resvg, in `assets/cardart/fonts/`. */
export const FONT_FILES = [
  'Inter-Regular.ttf',
  'Inter-Bold.ttf',
  'Inter-ExtraBold.ttf',
  'Inter-Black.ttf',
  'NotoSerif-Italic.ttf',
] as const;

export const BASE_TEMPLATE_FILE = path.join('templates', 'card-base.svg');
export const VERSION_FILE = 'VERSION';

export class CardAssetLoader {
  readonly assetRoot: string;
  private readonly textCache = new Map<string, Promise<string>>();
  private versionCache: Promise<string> | undefined;

  constructor(assetRoot: string) {
    this.assetRoot = assetRoot;
  }

  /** Absolute path for a kit-relative path, e.g. `rarities/ex.svg`. */
  resolve(relative: string): string {
    return path.join(this.assetRoot, relative);
  }

  rarityOverlayPath(rarity: Rarity): string {
    return this.resolve(path.join('rarities', rarityOverlayFile(rarity)));
  }

  raceIconPath(race: RaceCode): string {
    return this.resolve(path.join('icons', 'races', `${race}.svg`));
  }

  affinityIconPath(affinity: Affinity): string {
    return this.resolve(path.join('icons', 'affinities', affinityIconFile(affinity)));
  }

  baseTemplatePath(): string {
    return this.resolve(BASE_TEMPLATE_FILE);
  }

  fontPaths(): string[] {
    return FONT_FILES.map((f) => this.resolve(path.join('fonts', f)));
  }

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

  baseTemplate(): Promise<string> {
    return this.readText(BASE_TEMPLATE_FILE, 'base template');
  }

  rarityOverlay(rarity: Rarity): Promise<string> {
    return this.readText(path.join('rarities', rarityOverlayFile(rarity)), `rarity overlay ${rarity}`);
  }

  raceIcon(race: RaceCode): Promise<string> {
    return this.readText(path.join('icons', 'races', `${race}.svg`), `race icon ${race}`);
  }

  affinityIcon(affinity: Affinity): Promise<string> {
    return this.readText(
      path.join('icons', 'affinities', affinityIconFile(affinity)),
      `affinity icon ${affinity}`,
    );
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

  /** Every file the renderer requires, as kit-relative paths. */
  requiredFiles(): { relative: string; what: string }[] {
    return [
      { relative: VERSION_FILE, what: 'kit VERSION' },
      { relative: BASE_TEMPLATE_FILE, what: 'base template' },
      ...RARITIES.map((r) => ({
        relative: path.join('rarities', rarityOverlayFile(r)),
        what: `rarity overlay ${r}`,
      })),
      ...RACE_CODES.map((race) => ({
        relative: path.join('icons', 'races', `${race}.svg`),
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
