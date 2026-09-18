/**
 * The artwork build tool: PNG masters → full-size runtime WebP + renditions.
 *
 * The properties pinned here are the ones a bulk conversion depends on:
 *
 *   - every output is encoded **directly from the master** — a rendition is
 *     never a resize of the lossy full-size WebP;
 *   - the full-size output keeps the master's dimensions;
 *   - rebuilds are decided by content hash and settings, never by mtime;
 *   - a failure leaves no partial file and no manifest claim, and never lets a
 *     WebP from an older master keep masquerading as current;
 *   - only runtime artwork — what the species content names — is built; a
 *     backup or working PNG beside it never is.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FULL_WEBP_OPTIONS,
  MANIFEST_FILE,
  readManifest,
  readRuntimeArtworkCatalog,
  runArtworkBuild,
  runtimeArtworkStems,
  THUMBNAIL_KEYS,
  THUMBNAIL_WEBP_OPTIONS,
  type ArtworkBuildOptions,
} from '../../src/tools/artworkBuild';

let assetsDir: string;
/** The runtime artwork the content "names"; `addMaster` registers into it. */
let catalog: Set<string>;

/** A deterministic, non-trivial image: a gradient with per-master colour. */
async function masterBytes(seed: number, width = 600, height = 876): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = ((x ^ y) + seed * 40) & 0xff;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A master the content references. */
async function addMaster(slug: string, variant: string, seed = 1): Promise<string> {
  catalog.add(`waifumon/${slug}/${variant}`);
  return addPng(slug, variant, seed);
}

/** A PNG on disk that no content references: a backup, a working file. */
async function addPng(slug: string, name: string, seed = 1): Promise<string> {
  const file = path.join(assetsDir, 'waifumon', slug, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await masterBytes(seed));
  return file;
}

const full = (slug: string, variant: string): string =>
  path.join(assetsDir, 'waifumon', slug, `${variant}.webp`);
const thumb = (width: number, slug: string, variant: string): string =>
  path.join(assetsDir, '.thumbnails', String(width), 'waifumon', slug, `${variant}.webp`);

function build(overrides: Partial<ArtworkBuildOptions> = {}) {
  return runArtworkBuild({
    assetsDir,
    runtimeArtwork: catalog,
    selection: { all: true },
    concurrency: 2,
    ...overrides,
  });
}

function allFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-artwork-build-'));
  catalog = new Set();
});

afterEach(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

describe('outputs', () => {
  it('writes the full-size WebP beside the master and three renditions', async () => {
    await addMaster('alley_catgirl', 'standard');

    const report = await build();

    expect(report.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(report.failed).toEqual([]);
    const meta = await sharp(full('alley_catgirl', 'standard')).metadata();
    expect(meta.format).toBe('webp');
    // Native dimensions: the full-size output is never resized.
    expect([meta.width, meta.height]).toEqual([600, 876]);
    for (const width of [256, 512]) {
      const t = await sharp(thumb(width, 'alley_catgirl', 'standard')).metadata();
      expect(t.format).toBe('webp');
      expect(t.width).toBe(width);
      expect(t.height).toBe(Math.round((876 * width) / 600));
    }
    // `withoutEnlargement`: a 600-wide master is never upscaled to 1024.
    expect((await sharp(thumb(1024, 'alley_catgirl', 'standard')).metadata()).width).toBe(600);
  });

  it('encodes the full-size WebP from the master with the runtime settings', async () => {
    const master = await addMaster('alley_catgirl', 'standard');
    await build();
    const expected = await sharp(fs.readFileSync(master)).webp(FULL_WEBP_OPTIONS).toBuffer();
    expect(fs.readFileSync(full('alley_catgirl', 'standard')).equals(expected)).toBe(true);
  });

  it('encodes every rendition from the master, never from the full-size WebP', async () => {
    const master = fs.readFileSync(await addMaster('alley_catgirl', 'standard'));
    await build();

    const fromMaster = await sharp(master)
      .resize({ width: 512, withoutEnlargement: true })
      .webp(THUMBNAIL_WEBP_OPTIONS)
      .toBuffer();
    const fromFull = await sharp(fs.readFileSync(full('alley_catgirl', 'standard')))
      .resize({ width: 512, withoutEnlargement: true })
      .webp(THUMBNAIL_WEBP_OPTIONS)
      .toBuffer();
    const actual = fs.readFileSync(thumb(512, 'alley_catgirl', 'standard'));

    expect(fromMaster.equals(fromFull)).toBe(false); // the test can tell them apart
    expect(actual.equals(fromMaster)).toBe(true);
  });

  it('preserves transparency in every output', async () => {
    // Live species masters are opaque, but a master with alpha must not come
    // out with its transparent pixels flattened onto a background.
    catalog.add('waifumon/ghost_girl/standard');
    const file = path.join(assetsDir, 'waifumon', 'ghost_girl', 'standard.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 600, height: 876, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0 } } })
      .composite([{ input: await masterBytes(3, 300, 438), left: 150, top: 219 }])
      .png()
      .toFile(file);

    await build();

    for (const out of [full('ghost_girl', 'standard'), thumb(256, 'ghost_girl', 'standard')]) {
      const { channels } = await sharp(out).stats();
      expect(channels).toHaveLength(4);
      expect(channels[3]!.min).toBe(0); // the transparent border survived
      expect(channels[3]!.max).toBe(255); // and the opaque centre
    }
  });

  it('builds a non-milestone appearance the content names', async () => {
    // The catalog comes from content, not a milestone list, so a seasonal
    // drop needs no code change.
    await addMaster('alley_catgirl', 'winter_2026');
    await build();
    expect(fs.existsSync(full('alley_catgirl', 'winter_2026'))).toBe(true);
    expect(fs.existsSync(thumb(512, 'alley_catgirl', 'winter_2026'))).toBe(true);
  });

  it('builds only renditions with --only thumbnails, leaving the live source alone', async () => {
    await addMaster('alley_catgirl', 'standard');
    await build({ outputs: THUMBNAIL_KEYS });
    expect(fs.existsSync(full('alley_catgirl', 'standard'))).toBe(false);
    expect(fs.existsSync(thumb(256, 'alley_catgirl', 'standard'))).toBe(true);

    // The full-size output is built later without redoing the renditions.
    const later = await build();
    expect(later.built).toEqual(['waifumon/alley_catgirl/standard']);
    const manifest = readManifest(path.join(assetsDir, MANIFEST_FILE)).manifest;
    expect(Object.keys(manifest.assets['waifumon/alley_catgirl/standard']!.outputs).sort()).toEqual(
      ['1024', '256', '512', 'full'],
    );
  });

  it('ignores anything that is not a well-formed <slug>/<variant>.png master', async () => {
    await addMaster('alley_catgirl', 'standard');
    fs.writeFileSync(path.join(assetsDir, 'waifumon', 'alley_catgirl', 'old.old'), 'x');
    fs.writeFileSync(path.join(assetsDir, 'waifumon', 'alley_catgirl', 'Bad Name.png'), 'x');
    const report = await build();
    expect(report.sourcesChecked).toBe(1);
  });
});

describe('runtime artwork only', () => {
  it('--all ignores backup, working and unreferenced PNGs', async () => {
    await addMaster('alley_catgirl', 'standard');
    await addMaster('alley_catgirl', 'level_10', 2);
    await addPng('alley_catgirl', 'standard_placeholder_backup', 3);
    await addPng('alley_catgirl', 'standard_r1_backup', 4);
    await addPng('alley_catgirl', 'level_10_wip', 5);
    await addPng('unauthored_girl', 'standard', 6); // art for a species no content defines

    const report = await build();

    expect(report.built).toEqual([
      'waifumon/alley_catgirl/level_10',
      'waifumon/alley_catgirl/standard',
    ]);
    expect(report.ignored).toEqual([
      'waifumon/alley_catgirl/level_10_wip.png',
      'waifumon/alley_catgirl/standard_placeholder_backup.png',
      'waifumon/alley_catgirl/standard_r1_backup.png',
      'waifumon/unauthored_girl/standard.png',
    ]);
    const webps = allFiles(assetsDir)
      .filter((f) => f.endsWith('.webp'))
      .map((f) => path.relative(assetsDir, f));
    expect(webps.filter((f) => /backup|wip|unauthored/.test(f))).toEqual([]);
    const manifest = readManifest(path.join(assetsDir, MANIFEST_FILE)).manifest;
    expect(Object.keys(manifest.assets).sort()).toEqual([
      'waifumon/alley_catgirl/level_10',
      'waifumon/alley_catgirl/standard',
    ]);
  });

  it('refuses to build a non-runtime PNG even when selected by name', async () => {
    await addMaster('alley_catgirl', 'standard');
    await addPng('alley_catgirl', 'standard_r1_backup');

    const report = await build({
      selection: { assets: ['alley_catgirl/standard_r1_backup'], species: ['unauthored_girl'] },
    });

    expect(report.unknown).toEqual(['unauthored_girl', 'alley_catgirl/standard_r1_backup']);
    expect(report.built).toEqual([]);
    expect(fs.existsSync(full('alley_catgirl', 'standard_r1_backup'))).toBe(false);
  });
});

describe('the runtime artwork catalog', () => {
  const species = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    name: slug,
    rarity: 'N',
    archetype: 'demi-human',
    baseCaptureRate: null,
    description: '',
    tags: [],
    contentRating: 'suggestive',
    affinity: 'switch',
    imagePath: `waifumon/${slug}/standard.png`,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...extra,
  });
  const appearance = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    cosmeticRarity: 'standard',
    sortOrder: 10,
    unlock: id === 'standard' ? { type: 'owned' } : { type: 'level', atLevel: 10 },
    ...extra,
  });

  let contentDir: string;
  beforeEach(() => {
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-artwork-content-'));
    fs.mkdirSync(path.join(contentDir, 'species'));
  });
  afterEach(() => fs.rmSync(contentDir, { recursive: true, force: true }));

  function writeJson(relative: string, value: unknown): void {
    const file = path.join(contentDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }

  it('is every appearance asset, the standard fallback, and a legacy species imagePath', () => {
    writeJson('species/core.json', [
      species('alley_catgirl', {
        appearances: [
          appearance('standard'),
          appearance('level_10'),
          appearance('winter_2026', { assetId: { kind: 'waifumon', slug: 'alley_catgirl', variant: 'snow' } }),
        ],
      }),
      // No authored catalog: the implicit standard look.
      species('cafe_maid'),
      // A legacy imagePath naming another master of the species.
      species('old_timer', { imagePath: 'waifumon/old_timer/classic.png' }),
    ]);

    expect([...readRuntimeArtworkCatalog(contentDir)].sort()).toEqual([
      'waifumon/alley_catgirl/level_10',
      'waifumon/alley_catgirl/snow',
      'waifumon/alley_catgirl/standard',
      'waifumon/cafe_maid/standard',
      'waifumon/old_timer/classic',
      'waifumon/old_timer/standard',
    ]);
  });

  it('includes species of enabled and disabled expansion packs', () => {
    writeJson('species/core.json', [species('alley_catgirl')]);
    for (const [id, enabled] of [['twin_peaks', true], ['moon_base', false]] as const) {
      writeJson(`expansions/${id}/expansion.json`, { id, name: id, enabled });
      writeJson(`expansions/${id}/species/locals.json`, [species(`${id}_local`)]);
    }

    expect([...readRuntimeArtworkCatalog(contentDir)].sort()).toEqual([
      'waifumon/alley_catgirl/standard',
      'waifumon/moon_base_local/standard',
      'waifumon/twin_peaks_local/standard',
    ]);
  });

  it('never names a non-species or malformed image', () => {
    const stems = runtimeArtworkStems([
      { slug: 'alley_catgirl', contentRating: 'suggestive', imagePath: 'ui/splash.png' },
    ] as Parameters<typeof runtimeArtworkStems>[0]);
    expect([...stems]).toEqual(['waifumon/alley_catgirl/standard']);
  });
});

describe('incremental builds', () => {
  it('skips everything on a second run', async () => {
    await addMaster('alley_catgirl', 'standard');
    await addMaster('alley_catgirl', 'level_20', 2);
    await build();

    const again = await build();

    expect(again.built).toEqual([]);
    expect(again.skipped).toBe(2);
  });

  it('does not rebuild when only modification times change (a fresh checkout)', async () => {
    const master = await addMaster('alley_catgirl', 'standard');
    await build();
    const future = new Date(Date.now() + 3_600_000);
    for (const file of allFiles(assetsDir)) fs.utimesSync(file, future, future);
    fs.utimesSync(master, new Date(Date.now() + 7_200_000), new Date(Date.now() + 7_200_000));

    const again = await build();

    expect(again.built).toEqual([]);
  });

  it('rebuilds when the master content changes', async () => {
    const master = await addMaster('alley_catgirl', 'standard', 1);
    await build();
    const before = fs.readFileSync(full('alley_catgirl', 'standard'));
    fs.writeFileSync(master, await masterBytes(7));

    const again = await build();

    expect(again.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(fs.readFileSync(full('alley_catgirl', 'standard')).equals(before)).toBe(false);
  });

  it('rebuilds a missing or modified output, and only that output', async () => {
    await addMaster('alley_catgirl', 'standard');
    await build();
    const fullBefore = fs.statSync(full('alley_catgirl', 'standard')).mtimeMs;
    fs.rmSync(thumb(256, 'alley_catgirl', 'standard'));
    fs.appendFileSync(thumb(512, 'alley_catgirl', 'standard'), 'garbage');

    const again = await build({ onAsset: () => undefined });

    expect(again.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(fs.existsSync(thumb(256, 'alley_catgirl', 'standard'))).toBe(true);
    expect((await sharp(thumb(512, 'alley_catgirl', 'standard')).metadata()).width).toBe(512);
    expect(fs.statSync(full('alley_catgirl', 'standard')).mtimeMs).toBe(fullBefore);
  });

  it('rebuilds an output whose recorded settings differ from the current ones', async () => {
    await addMaster('alley_catgirl', 'standard');
    await build();
    const file = path.join(assetsDir, MANIFEST_FILE);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.assets['waifumon/alley_catgirl/standard'].outputs.full.settingsHash = 'older-encoder';
    fs.writeFileSync(file, JSON.stringify(manifest));

    const lines: string[] = [];
    await build({ onAsset: (l) => lines.push(l) });

    expect(lines).toEqual(['built waifumon/alley_catgirl/standard [full]']);
  });

  it('treats an unreadable manifest as empty and rebuilds, with a warning', async () => {
    await addMaster('alley_catgirl', 'standard');
    await build();
    fs.writeFileSync(path.join(assetsDir, MANIFEST_FILE), '{ not json');

    const again = await build();

    expect(again.manifestWarning).toBeDefined();
    expect(again.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(readManifest(path.join(assetsDir, MANIFEST_FILE)).warning).toBeUndefined();
  });

  it('rebuilds everything selected with force', async () => {
    await addMaster('alley_catgirl', 'standard');
    await build();
    const again = await build({ force: true });
    expect(again.built).toEqual(['waifumon/alley_catgirl/standard']);
  });

  it('writes nothing on a dry run', async () => {
    await addMaster('alley_catgirl', 'standard');
    const report = await build({ dryRun: true });
    expect(report.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(allFiles(assetsDir).map((f) => path.relative(assetsDir, f))).toEqual([
      'waifumon/alley_catgirl/standard.png',
    ]);
  });
});

describe('failures', () => {
  it('reports a bad master, writes no output or manifest claim for it, and builds the rest', async () => {
    await addMaster('alley_catgirl', 'standard');
    catalog.add('waifumon/broken_girl/standard');
    const broken = path.join(assetsDir, 'waifumon', 'broken_girl', 'standard.png');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, 'this is not a png');

    const report = await build();

    expect(report.built).toEqual(['waifumon/alley_catgirl/standard']);
    expect(report.failed.map((f) => f.asset)).toEqual(['waifumon/broken_girl/standard']);
    expect(fs.existsSync(full('broken_girl', 'standard'))).toBe(false);
    const entry = readManifest(path.join(assetsDir, MANIFEST_FILE)).manifest.assets[
      'waifumon/broken_girl/standard'
    ];
    expect(entry?.outputs ?? {}).toEqual({});
    // No temporary files survive a failed encode.
    expect(allFiles(assetsDir).filter((f) => f.includes('.tmp-'))).toEqual([]);

    // Not recorded as done, so the next run tries again.
    expect((await build()).failed.map((f) => f.asset)).toEqual(['waifumon/broken_girl/standard']);
  });

  it('removes a WebP built from an older master when the new master fails to build', async () => {
    const master = await addMaster('alley_catgirl', 'standard');
    await build();
    fs.writeFileSync(master, 'corrupted replacement');

    const report = await build();

    expect(report.failed).toHaveLength(1);
    // Otherwise the resolver would keep serving the old artwork as current.
    expect(fs.existsSync(full('alley_catgirl', 'standard'))).toBe(false);
    expect(report.removedStale).toContain('waifumon/alley_catgirl/standard.webp');
  });

  it('removes a full-size WebP from an older master when only thumbnails are rebuilt', async () => {
    const master = await addMaster('alley_catgirl', 'standard', 1);
    await build();
    fs.writeFileSync(master, await masterBytes(9));

    const report = await build({ outputs: THUMBNAIL_KEYS });

    expect(report.removedStale).toEqual(['waifumon/alley_catgirl/standard.webp']);
    expect(fs.existsSync(full('alley_catgirl', 'standard'))).toBe(false);
  });
});

describe('selection', () => {
  beforeEach(async () => {
    await addMaster('alley_catgirl', 'standard');
    await addMaster('alley_catgirl', 'level_20', 2);
    await addMaster('cafe_maid', 'standard', 3);
  });

  it('builds one species', async () => {
    const report = await build({ selection: { species: ['alley_catgirl'] } });
    expect(report.built).toEqual([
      'waifumon/alley_catgirl/level_20',
      'waifumon/alley_catgirl/standard',
    ]);
    expect(fs.existsSync(full('cafe_maid', 'standard'))).toBe(false);
  });

  it('builds one artwork', async () => {
    const report = await build({ selection: { assets: ['alley_catgirl/level_20'] } });
    expect(report.built).toEqual(['waifumon/alley_catgirl/level_20']);
    expect(fs.existsSync(full('alley_catgirl', 'standard'))).toBe(false);
  });

  it('keeps manifest entries for assets outside a later, narrower run', async () => {
    await build({ selection: { species: ['cafe_maid'] } });
    await build({ selection: { species: ['alley_catgirl'] } });
    const manifest = readManifest(path.join(assetsDir, MANIFEST_FILE)).manifest;
    expect(Object.keys(manifest.assets).sort()).toEqual([
      'waifumon/alley_catgirl/level_20',
      'waifumon/alley_catgirl/standard',
      'waifumon/cafe_maid/standard',
    ]);
  });

  it('reports a selection that names no master', async () => {
    const report = await build({
      selection: { species: ['nobody_here'], assets: ['alley_catgirl/level_99'] },
    });
    expect(report.unknown).toEqual(['nobody_here', 'alley_catgirl/level_99']);
    expect(report.built).toEqual([]);
  });
});

describe('the CLI', () => {
  it('builds only the artwork the content names with --all', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-artwork-cli-'));
    try {
      fs.mkdirSync(path.join(contentDir, 'species'));
      fs.writeFileSync(
        path.join(contentDir, 'species', 'core.json'),
        JSON.stringify([
          {
            slug: 'alley_catgirl',
            name: 'Alley Catgirl',
            rarity: 'N',
            archetype: 'demi-human',
            baseCaptureRate: null,
            description: '',
            tags: [],
            contentRating: 'suggestive',
            affinity: 'switch',
            imagePath: 'waifumon/alley_catgirl/standard.png',
            enabled: true,
            eventKey: null,
            perSpeciesWeight: 1,
          },
        ]),
      );
      await addPng('alley_catgirl', 'standard');
      await addPng('alley_catgirl', 'standard_placeholder_backup', 2);

      const result = spawnSync(
        process.execPath,
        [
          require.resolve('tsx/cli'),
          'src/tools/buildArtwork.ts',
          '--all',
          '--assets',
          assetsDir,
          '--content',
          contentDir,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Sources checked: 1');
      expect(result.stdout).toMatch(/Ignored: +1 PNG/);
      expect(fs.existsSync(full('alley_catgirl', 'standard'))).toBe(true);
      expect(fs.existsSync(full('alley_catgirl', 'standard_placeholder_backup'))).toBe(false);
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

  it('refuses to run without a selection, so the library is never converted by accident', () => {
    const result = spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), 'src/tools/buildArtwork.ts', '--assets', assetsDir],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Nothing selected');
    expect(fs.existsSync(path.join(assetsDir, MANIFEST_FILE))).toBe(false);
  });
});
