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
import {
  appearanceAssetRelativePath,
  appearanceRelativePathForSpecies,
  defaultAssetId,
} from '../../src/modules/appearance/appearanceContent';

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

describe('appearanceAssetRelativePath', () => {
  it('is the one definition of the on-disk layout', () => {
    expect(appearanceAssetRelativePath(level20)).toBe('waifumon/test_species/level_20.png');
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
      assetId: level20,
      source: 'appearance',
    });
  });

  it('falls back to the species default and reports the asset it actually used', () => {
    const logger = warnSpy();
    const resolved = resolveAppearanceAsset(ctx(logger), missing);

    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'waifumon', SLUG, 'standard.png'),
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

describe('appearanceRelativePathForSpecies', () => {
  it('places core appearance art beside the species image, matching the canonical layout', () => {
    // For a core species (imagePath under waifumon/<slug>/) this is byte-for-byte
    // the same path the assetId maps to — so core resolution never changes.
    expect(appearanceRelativePathForSpecies('waifumon/test_species/standard.png', 'level_20')).toBe(
      'waifumon/test_species/level_20.png',
    );
    expect(appearanceRelativePathForSpecies('waifumon/test_species/standard.png', 'level_20')).toBe(
      appearanceAssetRelativePath(level20),
    );
  });

  it('keeps expansion appearance art under the pack directory, not forced into waifumon/', () => {
    expect(
      appearanceRelativePathForSpecies('expansions/twin_peaks/onsen_maid/standard.png', 'level_20'),
    ).toBe('expansions/twin_peaks/onsen_maid/level_20.png');
  });
});

describe('resolveAppearanceAssetOrLegacyPath — artwork beside the species image', () => {
  const PACK_SLUG = 'expo_species';
  const packImagePath = `expansions/pack/${PACK_SLUG}/standard.png`;

  beforeAll(() => {
    fs.mkdirSync(path.join(assetsDir, 'expansions', 'pack', PACK_SLUG), { recursive: true });
    for (const variant of ['standard', 'level_20']) {
      fs.writeFileSync(
        path.join(assetsDir, 'expansions', 'pack', PACK_SLUG, `${variant}.png`),
        'png',
      );
    }
  });

  it('resolves an expansion milestone from its pack directory, not from waifumon/', () => {
    // The assetId maps canonically to waifumon/<slug>/level_20.png, which does
    // not exist for a pack species — the file is beside the species imagePath.
    const resolved = resolveAppearanceAssetOrLegacyPath(
      ctx(),
      defaultAssetId(PACK_SLUG, 'level_20'),
      packImagePath,
    );
    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'expansions', 'pack', PACK_SLUG, 'level_20.png'),
      assetId: defaultAssetId(PACK_SLUG, 'level_20'),
      source: 'appearance',
    });
  });

  it('falls back to the pack standard image when a milestone has no art', () => {
    const resolved = resolveAppearanceAssetOrLegacyPath(
      ctx(),
      defaultAssetId(PACK_SLUG, 'level_50'),
      packImagePath,
    );
    expect(resolved).toEqual({
      absolutePath: path.resolve(assetsDir, 'expansions', 'pack', PACK_SLUG, 'standard.png'),
      assetId: defaultAssetId(PACK_SLUG, 'standard'),
      source: 'species-default',
    });
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
