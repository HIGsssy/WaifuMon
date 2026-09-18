/**
 * Canonical containment for artwork that is about to be read or served
 * (`modules/assets/assetContainment.ts`), and the read paths built on it.
 *
 * The policy: what matters is where the *final* target of a path really is.
 * A symlink (or chain) that stays inside the real assets root is fine; one
 * that leaves it is refused, as is anything that is not a regular file.
 * Broken links and loops are simply "missing". Lexical checks are unchanged
 * and still come first.
 *
 * Built in the OS temp dir so real symlinks can be made. `assets` has a
 * sibling `assets2` to pin that containment is by path segment, not prefix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assetPathWithin,
  isPathInside,
  resolveExistingAssetFile,
} from '../../src/modules/assets/assetContainment';
import { locateArtworkFile } from '../../src/modules/assets/artworkFile';
import {
  locateLegacyArtwork,
  locateSpeciesArtwork,
  resolveArtworkRendition,
} from '../../src/modules/assets/speciesArtworkFile';
import { SUPPORTED_ARTWORK_EXTENSIONS } from '../../src/modules/assets/artworkPath';
import { resolveAssetPath, validateBossAssets } from '../../src/modules/content/loader';
import { resolveBossArtwork } from '../../src/discord/bossArtwork';
import { resolveRegionBanner } from '../../src/discord/regionBanner';
import type { AppContext } from '../../src/discord/types';
import type { BossContent } from '../../src/modules/content/schemas';
import type { BossEncounterRow } from '../../src/db/schema';

let tmp: string;
let assets: string;

function write(abs: string, body = 'x') {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
const link = (target: string, at: string) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-containment-'));
  assets = path.join(tmp, 'assets');
  const A = (rel: string) => path.join(assets, rel);

  for (const ext of SUPPORTED_ARTWORK_EXTENSIONS) write(A(`results/scene.${ext}`), `bytes-${ext}`);
  write(path.join(tmp, 'secret.png'), 'outside');
  write(path.join(tmp, 'assets2', 'sibling.png'), 'sibling');
  fs.mkdirSync(A('results/folder.png'));

  // Allowed: links whose final target stays inside assets/.
  link(A('results/scene.webp'), A('results/alias.webp'));
  link('../results/scene.png', A('shared/relative-alias.png'));
  link(A('results/alias.webp'), A('results/hop2.webp')); // alias → scene
  link(A('results/hop2.webp'), A('results/hop3.webp')); // hop2 → alias → scene
  link(A('results'), A('linked-dir')); // a symlinked folder inside assets

  // Refused: links whose final target leaves assets/.
  link(path.join(tmp, 'secret.png'), A('results/escape.png'));
  link(A('results/escape.png'), A('results/escape-hop.png')); // inside → inside → outside
  link(tmp, A('results/outside-dir')); // folder link out of assets
  link(path.join(tmp, 'assets2', 'sibling.png'), A('results/sibling.png'));

  // Unavailable.
  link(A('results/nowhere.png'), A('results/broken.png'));
  link(A('results/loop-b.png'), A('results/loop-a.png'));
  link(A('results/loop-a.png'), A('results/loop-b.png'));

  // Species layout, for the AssetId resolvers.
  write(A('waifumon/alpha/standard.webp'));
  link(path.join(tmp, 'secret.png'), A('waifumon/beta/standard.png'));
  write(A('.thumbnails/256/waifumon/alpha/standard.webp'));
  write(A('waifumon/gamma/standard.webp'));
  link(path.join(tmp, 'secret.png'), A('.thumbnails/256/waifumon/gamma/standard.webp'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isPathInside', () => {
  it.each([
    ['/assets', '/assets', true],
    ['/assets', '/assets/a.png', true],
    ['/assets', '/assets/a/b/c.png', true],
    ['/assets', '/assets/..foo/a.png', true],
    ['/assets', '/assets2/a.png', false],
    ['/assets', '/assets2', false],
    ['/assets', '/asset', false],
    ['/assets', '/', false],
    ['/assets', '/etc/passwd', false],
    ['/', '/anything', true],
  ])('%s contains %s → %s', (root, candidate, expected) => {
    expect(isPathInside(root, candidate)).toBe(expected);
  });

  it('assetPathWithin is lexical and still refuses the sibling prefix', () => {
    expect(assetPathWithin(assets, 'results/not-yet-built.webp')).toBe(
      path.join(assets, 'results/not-yet-built.webp'),
    );
    expect(assetPathWithin(assets, '../assets2/sibling.png')).toBeNull();
    expect(assetPathWithin(assets, '../secret.png')).toBeNull();
  });
});

describe('resolveExistingAssetFile — allowed', () => {
  it.each(SUPPORTED_ARTWORK_EXTENSIONS)('an ordinary .%s file', (ext) => {
    expect(resolveExistingAssetFile(assets, `results/scene.${ext}`)).toEqual({
      status: 'available',
      absolutePath: path.join(assets, 'results', `scene.${ext}`),
    });
  });

  it.each([
    'results/alias.webp',
    'shared/relative-alias.png',
    'results/hop2.webp',
    'results/hop3.webp',
    'linked-dir/scene.gif',
  ])('%s — a symlink (or chain, or linked folder) that stays inside assets', (rel) => {
    const found = resolveExistingAssetFile(assets, rel);
    expect(found.status).toBe('available');
    // The caller gets the path it asked for, not the link target.
    expect(found).toMatchObject({ absolutePath: path.join(assets, rel) });
  });

  it('works when the assets directory itself is reached through a symlink', () => {
    const viaLink = path.join(tmp, 'assets-link');
    fs.symlinkSync(assets, viaLink);
    try {
      expect(resolveExistingAssetFile(viaLink, 'results/scene.png').status).toBe('available');
      expect(resolveExistingAssetFile(viaLink, 'results/escape.png').status).toBe('unsafe');
    } finally {
      fs.unlinkSync(viaLink);
    }
  });
});

describe('resolveExistingAssetFile — refused or unavailable', () => {
  it.each([
    ['results/escape.png', 'symlink → outside assets'],
    ['results/escape-hop.png', 'symlink chain escaping assets'],
    ['results/outside-dir/secret.png', 'through a folder symlink out of assets'],
    ['results/sibling.png', 'symlink into the sibling-prefix directory assets2/'],
  ])('%s is unsafe (%s)', (rel) => {
    const found = resolveExistingAssetFile(assets, rel);
    expect(found.status).toBe('unsafe');
    expect(JSON.stringify(found)).not.toContain(tmp);
  });

  it.each([
    ['results/broken.png', 'broken symlink'],
    ['results/loop-a.png', 'symlink loop'],
    ['results/folder.png', 'a directory where a file is expected'],
    ['results/absent.png', 'nothing there'],
    ['results/scene.png/deeper.png', 'a file used as a folder'],
  ])('%s is missing (%s), without throwing', (rel) => {
    expect(resolveExistingAssetFile(assets, rel)).toEqual({ status: 'missing' });
  });

  it.each(['../secret.png', '../assets2/sibling.png', '/etc/passwd'])('%s is refused lexically', (rel) => {
    expect(resolveExistingAssetFile(assets, rel).status).toBe('unsafe');
  });

  it('an absolute path to a real file outside assets is refused lexically', () => {
    expect(resolveExistingAssetFile(assets, path.join(tmp, 'secret.png')).status).toBe('unsafe');
  });

  it('a missing assets directory is "missing", not a crash', () => {
    expect(resolveExistingAssetFile(path.join(tmp, 'no-such-dir'), 'a.png')).toEqual({
      status: 'missing',
    });
  });
});

describe('locateArtworkFile (authored artwork: presentations, encounters)', () => {
  it.each(SUPPORTED_ARTWORK_EXTENSIONS)('serves an ordinary .%s', (ext) => {
    expect(locateArtworkFile(assets, `results/scene.${ext}`)).toMatchObject({
      status: 'available',
      extension: ext,
    });
  });

  it('serves a safe symlink and chain', () => {
    expect(locateArtworkFile(assets, 'results/hop3.webp').status).toBe('available');
  });

  it.each(['results/escape.png', 'results/escape-hop.png', 'results/sibling.png'])(
    'refuses %s as unsafe',
    (rel) => {
      expect(locateArtworkFile(assets, rel).status).toBe('unsafe');
    },
  );

  it.each(['results/broken.png', 'results/loop-a.png', 'results/folder.png'])('%s is missing', (rel) => {
    expect(locateArtworkFile(assets, rel).status).toBe('missing');
  });

  it.each(['../secret.png', '/etc/passwd.png', 'results\\scene.png', 'C:/x.png', 'results/scene'])(
    'still rejects the malformed path %s by shape',
    (rel) => {
      expect(locateArtworkFile(assets, rel).status).toBe('unsafe');
    },
  );
});

describe('species artwork', () => {
  it('resolves an ordinary AssetId', () => {
    expect(locateSpeciesArtwork(assets, { kind: 'waifumon', slug: 'alpha', variant: 'standard' })).toMatchObject({
      extension: 'webp',
    });
  });

  it('treats an AssetId whose file is a symlink out of assets as absent', () => {
    expect(locateSpeciesArtwork(assets, { kind: 'waifumon', slug: 'beta', variant: 'standard' })).toBeNull();
    expect(locateLegacyArtwork(assets, 'waifumon/beta/standard.png')).toBeNull();
  });

  it('serves a rendition when it is safe, and ignores one that escapes', async () => {
    const alpha = locateSpeciesArtwork(assets, { kind: 'waifumon', slug: 'alpha', variant: 'standard' })!;
    const rendition = await resolveArtworkRendition(assets, alpha, 256);
    expect(rendition.absolutePath).toBe(path.join(assets, '.thumbnails/256/waifumon/alpha/standard.webp'));

    const gamma = locateSpeciesArtwork(assets, { kind: 'waifumon', slug: 'gamma', variant: 'standard' })!;
    // The rendition is a link out of assets: fall back to the artwork itself.
    expect((await resolveArtworkRendition(assets, gamma, 256)).absolutePath).toBe(gamma.absolutePath);
  });
});

describe('output/shape paths stay lexical', () => {
  it('resolveAssetPath still resolves a file that does not exist yet', () => {
    expect(resolveAssetPath(assets, 'results/new-build-output.webp')).toBe(
      path.join(assets, 'results/new-build-output.webp'),
    );
    expect(() => resolveAssetPath(assets, '../escape.png')).toThrow();
  });
});

describe('boss and region artwork', () => {
  const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

  it('load-time boss validation keeps real artwork and nulls an escaping link', () => {
    const log = logger();
    const bosses = [
      { id: 'ok', artwork: 'results/scene.png' },
      { id: 'escape', artwork: 'results/escape.png' },
      { id: 'broken', artwork: 'results/broken.png' },
    ] as unknown as BossContent[];
    const out = validateBossAssets(bosses, assets, log as never);
    expect(out.map((b) => b.artwork)).toEqual(['results/scene.png', null, null]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('boss post-time artwork degrades to text-only for an escaping link', () => {
    const log = logger();
    const ctx = { config: { assetsDir: assets }, logger: log } as unknown as AppContext;
    const row = (bossArtwork: string) => ({ id: 1, bossArtwork }) as unknown as BossEncounterRow;
    expect(resolveBossArtwork(ctx, row('results/scene.png'))).toEqual({
      artworkPath: path.join(assets, 'results/scene.png'),
    });
    expect(resolveBossArtwork(ctx, row('results/escape.png'))).toEqual({});
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'boss/artwork-unsafe' }),
      expect.any(String),
    );
  });

  it('a region banner that links out of assets renders without a banner', () => {
    const log = logger();
    const ctx = { config: { assetsDir: assets }, logger: log } as unknown as AppContext;
    expect(resolveRegionBanner(ctx, 'valley', 'results/scene.png')).not.toBeNull();
    expect(resolveRegionBanner(ctx, 'valley', 'results/escape.png')).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
