/**
 * The shared `AssetId → file` resolver.
 *
 * This logic used to live in `src/discord/assets/` and had no direct tests —
 * it was only exercised through embed-building. Lifting it out for the card
 * renderer is exactly the moment to pin its behaviour down, because the whole
 * point of the move is that a second consumer now depends on it behaving the
 * same way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appearanceAssetPath,
  resolveAppearanceAsset,
  resolveAppearanceAssetOrLegacyPath,
} from '../../src/modules/appearance/assetResolver';
import { defaultAssetId } from '../../src/modules/appearance/appearanceContent';
import {
  locateSpeciesArtwork,
  resolveArtworkRendition,
  speciesArtworkCandidatePaths,
} from '../../src/modules/assets/speciesArtworkFile';

/** The format fields every resolved artwork carries. */
const PNG = { extension: 'png', contentType: 'image/png' } as const;
const WEBP = { extension: 'webp', contentType: 'image/webp' } as const;

let assetsDir: string;

const SLUG = 'test_species';
const standard = defaultAssetId(SLUG, 'standard');
const level20 = defaultAssetId(SLUG, 'level_20');
const missing = defaultAssetId(SLUG, 'never_authored');

function ctx(logger?: unknown): { assetsDir: string; logger?: never } {
  return { assetsDir, ...(logger ? { logger: logger as never } : {}) };
}

function warnSpy(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

beforeAll(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-assets-'));
  fs.mkdirSync(path.join(assetsDir, 'waifumon', SLUG), { recursive: true });
  for (const variant of ['standard', 'level_20']) {
    fs.writeFileSync(path.join(assetsDir, 'waifumon', SLUG, `${variant}.png`), 'png');
  }
  fs.writeFileSync(path.join(assetsDir, 'legacy.png'), 'png');
});

afterAll(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('speciesArtworkCandidatePaths', () => {
  it('is the one definition of the on-disk layout, WebP before PNG', () => {
    expect(speciesArtworkCandidatePaths(level20)).toEqual([
      'waifumon/test_species/level_20.webp',
      'waifumon/test_species/level_20.png',
    ]);
  });
});

describe('appearanceAssetPath', () => {
  it('resolves an appearance that exists', () => {
    expect(appearanceAssetPath(ctx(), level20)).toBe(
      path.resolve(assetsDir, 'waifumon', SLUG, 'level_20.png'),
    );
  });

  it('returns null for a file that does not exist', () => {
    expect(appearanceAssetPath(ctx(), missing)).toBeNull();
  });

  it('returns null rather than throwing when the id would escape the assets root', () => {
    const traversal = { kind: 'waifumon', slug: '../../etc', variant: 'passwd' } as const;
    expect(appearanceAssetPath(ctx(), traversal)).toBeNull();
  });
});

describe('resolveAppearanceAsset', () => {
  it('resolves the requested appearance and says so', () => {
    expect(resolveAppearanceAsset(ctx(), level20)).toEqual({
      absolutePath: path.resolve(assetsDir, 'waifumon', SLUG, 'level_20.png'),
      ...PNG,
      assetId: level20,
      source: 'appearance',
    });
  });

  it('falls back to the species default and reports the asset it actually used', () => {
    const logger = warnSpy();
    const resolved = resolveAppearanceAsset(ctx(logger), missing);

    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'waifumon', SLUG, 'standard.png'),
      ...PNG,
      assetId: standard,
      source: 'species-default',
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not re-probe the default when the default is what was asked for', () => {
    const logger = warnSpy();
    expect(resolveAppearanceAsset(ctx(logger), standard)?.source).toBe('appearance');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns null and warns when nothing resolves', () => {
    const logger = warnSpy();
    const unknown = defaultAssetId('no_such_species', 'standard');

    expect(resolveAppearanceAsset(ctx(logger), unknown)).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('works without a logger', () => {
    expect(() => resolveAppearanceAsset(ctx(), missing)).not.toThrow();
  });
});

describe('resolveAppearanceAssetOrLegacyPath', () => {
  it('prefers a resolvable appearance over the legacy path', () => {
    const resolved = resolveAppearanceAssetOrLegacyPath(ctx(), level20, 'legacy.png');
    expect(resolved?.source).toBe('appearance');
  });

  it('degrades to the legacy image path as a last resort', () => {
    const unknown = defaultAssetId('no_such_species', 'standard');
    const resolved = resolveAppearanceAssetOrLegacyPath(ctx(), unknown, 'legacy.png');

    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'legacy.png'),
      ...PNG,
      assetId: unknown,
      source: 'legacy-image-path',
    });
  });

  it('returns null when even the legacy path is missing', () => {
    const unknown = defaultAssetId('no_such_species', 'standard');
    expect(resolveAppearanceAssetOrLegacyPath(ctx(), unknown, 'nope.png')).toBeNull();
  });

  it('returns null rather than throwing on a traversing legacy path', () => {
    const unknown = defaultAssetId('no_such_species', 'standard');
    expect(resolveAppearanceAssetOrLegacyPath(ctx(), unknown, '../../../etc/passwd')).toBeNull();
  });
});

describe('resolveAppearanceAssetOrLegacyPath — expansion species', () => {
  const PACK_SLUG = 'expo_species';
  const packImagePath = `waifumon/${PACK_SLUG}/standard.png`;

  beforeAll(() => {
    fs.mkdirSync(path.join(assetsDir, 'waifumon', PACK_SLUG), { recursive: true });
    for (const variant of ['standard', 'level_20']) {
      fs.writeFileSync(
        path.join(assetsDir, 'waifumon', PACK_SLUG, `${variant}.png`),
        'png',
      );
    }
  });

  it('resolves an expansion milestone from the canonical AssetId path', () => {
    const resolved = resolveAppearanceAssetOrLegacyPath(
      ctx(),
      defaultAssetId(PACK_SLUG, 'level_20'),
      packImagePath,
    );
    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'waifumon', PACK_SLUG, 'level_20.png'),
      ...PNG,
      assetId: defaultAssetId(PACK_SLUG, 'level_20'),
      source: 'appearance',
    });
  });

  it('falls back to the canonical standard image when a milestone has no art', () => {
    const resolved = resolveAppearanceAssetOrLegacyPath(
      ctx(),
      defaultAssetId(PACK_SLUG, 'level_50'),
      packImagePath,
    );
    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'waifumon', PACK_SLUG, 'standard.png'),
      ...PNG,
      assetId: defaultAssetId(PACK_SLUG, 'standard'),
      source: 'species-default',
    });
  });
});

/**
 * The format matrix. Each species gets its own directory so every case states
 * exactly which files exist; the resolver must pick WebP whenever it is there
 * and fall back to PNG otherwise, without any caller naming a format.
 */
describe('format-agnostic resolution', () => {
  let dir: string;

  /** Writes `<slug>/<file>` for each file name given. */
  function species(slug: string, ...files: string[]): void {
    fs.mkdirSync(path.join(dir, 'waifumon', slug), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(dir, 'waifumon', slug, file), file);
  }

  function art(slug: string, file: string): string {
    return path.resolve(dir, 'waifumon', slug, file);
  }

  const fmtCtx = (): { assetsDir: string } => ({ assetsDir: dir });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-assets-fmt-'));
    species('webp_only', 'standard.webp');
    species('png_only', 'standard.png');
    species('both', 'standard.webp', 'standard.png');
    species('alt_webp', 'standard.png', 'level_20.webp');
    species('alt_png', 'standard.webp', 'level_20.png');
    species('alt_missing', 'standard.webp');
    species('no_art');
    fs.mkdirSync(path.join(dir, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'legacy', 'old.webp'), 'webp');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('selects WebP when only WebP exists', () => {
    expect(locateSpeciesArtwork(dir, defaultAssetId('webp_only', 'standard'))).toEqual({
      absolutePath: art('webp_only', 'standard.webp'),
      ...WEBP,
    });
  });

  it('selects PNG when only PNG exists', () => {
    expect(locateSpeciesArtwork(dir, defaultAssetId('png_only', 'standard'))).toEqual({
      absolutePath: art('png_only', 'standard.png'),
      ...PNG,
    });
  });

  it('selects WebP when both exist', () => {
    expect(resolveAppearanceAsset(fmtCtx(), defaultAssetId('both', 'standard'))).toEqual({
      absolutePath: art('both', 'standard.webp'),
      ...WEBP,
      assetId: defaultAssetId('both', 'standard'),
      source: 'appearance',
    });
  });

  it('returns null when neither format exists', () => {
    const logger = warnSpy();
    const assetId = defaultAssetId('no_art', 'standard');
    expect(locateSpeciesArtwork(dir, assetId)).toBeNull();
    expect(resolveAppearanceAsset({ assetsDir: dir, logger: logger as never }, assetId)).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('resolves an alternate appearance stored as WebP', () => {
    const resolved = resolveAppearanceAsset(fmtCtx(), defaultAssetId('alt_webp', 'level_20'));
    expect(resolved).toMatchObject({
      absolutePath: art('alt_webp', 'level_20.webp'),
      ...WEBP,
      source: 'appearance',
    });
  });

  it('resolves an alternate appearance stored as PNG', () => {
    const resolved = resolveAppearanceAsset(fmtCtx(), defaultAssetId('alt_png', 'level_20'));
    expect(resolved).toMatchObject({
      absolutePath: art('alt_png', 'level_20.png'),
      ...PNG,
      source: 'appearance',
    });
  });

  it('falls back to the species default, in its own format, when an alternate is missing', () => {
    const resolved = resolveAppearanceAsset(fmtCtx(), defaultAssetId('alt_missing', 'level_20'));
    expect(resolved).toEqual({
      absolutePath: art('alt_missing', 'standard.webp'),
      ...WEBP,
      assetId: defaultAssetId('alt_missing', 'standard'),
      source: 'species-default',
    });
  });

  it('treats the legacy imagePath as a stem, so a converted legacy file still resolves', () => {
    const resolved = resolveAppearanceAssetOrLegacyPath(
      fmtCtx(),
      defaultAssetId('no_art', 'standard'),
      'legacy/old.png',
    );
    expect(resolved).toEqual({
      absolutePath: path.resolve(dir, 'legacy', 'old.webp'),
      ...WEBP,
      assetId: defaultAssetId('no_art', 'standard'),
      source: 'legacy-image-path',
    });
  });
});

describe('resolveArtworkRendition', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-assets-rend-'));
    fs.mkdirSync(path.join(dir, 'waifumon', 's'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'waifumon', 's', 'standard.png'), 'png');
    fs.writeFileSync(path.join(dir, 'waifumon', 's', 'level_20.webp'), 'webp');
    fs.mkdirSync(path.join(dir, '.thumbnails', '512', 'waifumon', 's'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.thumbnails', '512', 'waifumon', 's', 'standard.webp'), 't');
    fs.writeFileSync(path.join(dir, '.thumbnails', '512', 'waifumon', 's', 'level_20.webp'), 't');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const artwork = (variant: string) =>
    locateSpeciesArtwork(dir, { kind: 'waifumon', slug: 's', variant })!;

  it('serves the pre-generated WebP rendition for a PNG source', async () => {
    expect(await resolveArtworkRendition(dir, artwork('standard'), 512)).toEqual({
      absolutePath: path.resolve(dir, '.thumbnails', '512', 'waifumon', 's', 'standard.webp'),
      ...WEBP,
    });
  });

  it('serves the same rendition path for a WebP source', async () => {
    expect((await resolveArtworkRendition(dir, artwork('level_20'), 512)).absolutePath).toBe(
      path.resolve(dir, '.thumbnails', '512', 'waifumon', 's', 'level_20.webp'),
    );
  });

  it('falls back to the artwork itself, with its own format, when no rendition exists', async () => {
    expect(await resolveArtworkRendition(dir, artwork('standard'), 256)).toEqual(
      artwork('standard'),
    );
  });

  it('returns the artwork untouched when no width is asked for', async () => {
    expect(await resolveArtworkRendition(dir, artwork('standard'), undefined)).toEqual(
      artwork('standard'),
    );
  });
});

describe('the Discord adapter is a thin consumer', () => {
  it('holds no filesystem or layout knowledge of its own', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/discord/assets/resolveAppearanceAsset.ts'),
      'utf8',
    );
    // The generic lookup lives in the shared module now; if any of this creeps
    // back into the Discord layer, there are two implementations again.
    expect(source).not.toContain('existsSync');
    expect(source).not.toContain("from 'node:fs'");
    // Path construction from an AssetId's parts — the layout knowledge itself.
    expect(source).not.toContain('assetId.kind');
    expect(source).not.toContain('assetId.variant');
    expect(source).toContain('modules/appearance/assetResolver');
  });
});

describe('the low-level artwork locator stays low-level', () => {
  it('imports nothing that knows about fallback, content loading, Discord or HTTP', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/assets/speciesArtworkFile.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    // The loader and the appearance resolver both import this module; if it
    // imported either of them back, the Phase 2A cycle would return.
    expect(imports.filter((i) => /content\/loader|appearance\/|discord|api\//.test(i!))).toEqual(
      [],
    );
  });

  it('is what the content loader and the appearance resolver share', () => {
    for (const consumer of [
      '../../src/modules/content/loader.ts',
      '../../src/modules/appearance/assetResolver.ts',
      '../../src/tools/appearanceSync.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(__dirname, consumer), 'utf8');
      expect(source, consumer).toContain('assets/speciesArtworkFile');
    }
    const resolver = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/appearance/assetResolver.ts'),
      'utf8',
    );
    expect(resolver).not.toContain('content/loader');
  });
});
