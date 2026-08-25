/**
 * Fixtures for the card renderer suites.
 *
 * Artwork is generated rather than borrowed from `assets/waifumon/` so tests
 * can mutate bytes to prove cache invalidation, and so they don't silently
 * start failing when content art is re-exported.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Affinity, Rarity } from '../../src/db/schema';
import type { CardRenderInput, RaceCode } from '../../src/modules/cards';
import { DEFAULT_ASSET_ROOT } from '../../src/modules/cards';

/** A temp directory that the caller is responsible for removing. */
export async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `wm-${prefix}-`));
}

/**
 * Writes a solid-colour PNG. The colour is the only thing that varies, so two
 * fixtures differ in bytes without differing in size — exactly the case a
 * size-based fingerprint would miss.
 */
export async function writeArtwork(
  filePath: string,
  rgb: { r: number; g: number; b: number },
): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const png = await sharp({
    create: { width: 512, height: 512, channels: 3, background: rgb },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  await fs.writeFile(filePath, png);
  return filePath;
}

/** A copy of the shipped SVG kit that a test may edit (e.g. to bump VERSION). */
export async function copyAssetKit(destination: string): Promise<string> {
  await fs.cp(DEFAULT_ASSET_ROOT, destination, { recursive: true });
  return destination;
}

export interface CardInputOverrides {
  slug?: string;
  name?: string;
  rarity?: Rarity;
  race?: RaceCode;
  affinity?: Affinity;
  appearanceId?: string;
  level?: number;
  description?: string;
  card?: CardRenderInput['species']['card'];
  showCaughtBadge?: boolean;
  width?: number;
}

/** A fully-populated card input; every field is overridable. */
export function cardInput(artworkPath: string, overrides: CardInputOverrides = {}): CardRenderInput {
  const input: CardRenderInput = {
    species: {
      slug: overrides.slug ?? 'alley_catgirl',
      name: overrides.name ?? 'Alley Catgirl',
      rarity: overrides.rarity ?? 'SSR',
      race: overrides.race ?? 'demi-human',
      affinity: overrides.affinity ?? 'dominant',
      description:
        overrides.description ??
        'Prowls the fire-escape network at midnight. Trades secrets for tuna and eye contact.',
      card:
        overrides.card === undefined
          ? {
              subtitle: 'Curious Companion',
              artist: 'Artist Name',
              ability: {
                name: 'Nine Lives',
                text: 'Ignores the first failed capture attempt of each encounter.',
              },
              flavorQuote: 'She was here before the city was.',
              cardNumber: '012/100',
            }
          : overrides.card,
    },
    variant: {
      appearanceId: overrides.appearanceId ?? 'standard',
      artworkAbsolutePath: artworkPath,
    },
    progress: { level: overrides.level ?? 12 },
    ...(overrides.showCaughtBadge === undefined
      ? {}
      : { context: { showCaughtBadge: overrides.showCaughtBadge } }),
  };
  return overrides.width === undefined ? input : { ...input, output: { width: overrides.width } };
}

/** WebP magic: `RIFF....WEBP`. */
export function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/** Actual decoded dimensions, so a test never trusts the renderer's own report. */
export async function dimensionsOf(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(bytes).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Every file under `dir`, as paths relative to it. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
      .sort();
  } catch {
    return [];
  }
}
