/**
 * Admin Gallery catalog + the loader diagnostics it depends on.
 *
 * Runs the real `loadContent` over a small content tree so every assertion is
 * about what the shipped loader actually does:
 *
 *   - the loader's gameplay output is unchanged — the pre-flight still drops a
 *     non-default appearance with no artwork and still disables a species with
 *     no default artwork; the only addition is typed diagnostics;
 *   - the gallery still returns every *authored* appearance, and says which
 *     ones the runtime lost and why;
 *   - species from a disabled expansion pack are inspectable, clearly marked
 *     not loaded, and never enter the gameplay snapshot;
 *   - artwork is examined through the shared containment check: a symlink out
 *     of the assets root is `unsafe`, never available, and nothing is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadContent,
  preflightSpeciesAssets,
  readContentFiles,
  validateSpeciesAssets,
} from '../../src/modules/content/loader';
import {
  buildGalleryCatalog,
  buildGallerySpeciesDetail,
  GALLERY_ISSUE_CODES,
} from '../../src/modules/adminGallery/galleryCatalog';
import {
  inspectSpeciesArtwork,
  locateSpeciesArtwork,
} from '../../src/modules/assets/speciesArtworkFile';
import type { LoadedContent, SpeciesContent } from '../../src/modules/content/schemas';
import { createLogger } from '../../src/shared/logger';
import { createGalleryTree, gallerySpecies, type GalleryTree } from '../helpers/galleryFixtures';

const silent = () => createLogger('silent');

let tree: GalleryTree | undefined;
afterEach(() => {
  tree?.cleanup();
  tree = undefined;
});

/** All three looks on disk, as WebP. */
function fullArt(t: GalleryTree, slug: string): void {
  for (const id of ['standard', 'level_10', 'level_20']) t.art(`waifumon/${slug}/${id}.webp`);
}

/**
 * The scenario tree most tests share:
 *
 *   complete_girl — everything present
 *   dropped_girl  — `level_20` artwork missing → dropped from the runtime
 *   ghost_girl    — no artwork at all → disabled by the loader
 *   future_girl   — in the disabled `future_pack`; `level_10` missing
 *   live_girl     — in the enabled `live_pack`; everything present
 */
function scenario(): GalleryTree {
  const t = createGalleryTree({
    core: [
      gallerySpecies('complete_girl'),
      gallerySpecies('dropped_girl'),
      gallerySpecies('ghost_girl'),
    ],
    packs: [
      { id: 'future_pack', enabled: false, species: [gallerySpecies('future_girl')] },
      { id: 'live_pack', enabled: true, species: [gallerySpecies('live_girl')] },
    ],
  });
  fullArt(t, 'complete_girl');
  t.art('waifumon/dropped_girl/standard.webp');
  t.art('waifumon/dropped_girl/level_10.webp');
  t.art('waifumon/future_girl/standard.webp');
  t.art('waifumon/future_girl/level_20.webp');
  fullArt(t, 'live_girl');
  return t;
}

function load(t: GalleryTree): LoadedContent {
  return loadContent(t.contentDir, t.assetsDir, silent());
}

const ids = (s: SpeciesContent | undefined) => (s?.appearances ?? []).map((a) => a.id);

describe('loader diagnostics add observability without changing gameplay output', () => {
  it('the runtime species are exactly what validateSpeciesAssets produces', () => {
    tree = scenario();
    const loaded = load(tree);
    const expected = validateSpeciesAssets(
      readContentFiles(tree.contentDir).species,
      tree.assetsDir,
      silent(),
    );
    expect(loaded.species).toEqual(expected);
  });

  it('preflightSpeciesAssets returns the same species as validateSpeciesAssets', () => {
    tree = scenario();
    const input = readContentFiles(tree.contentDir).species;
    const { species } = preflightSpeciesAssets(input, tree.assetsDir, silent());
    expect(species).toEqual(validateSpeciesAssets(input, tree.assetsDir, silent()));
  });

  it('still drops a non-default appearance whose artwork is missing, and records why', () => {
    tree = scenario();
    const loaded = load(tree);
    const dropped = loaded.species.find((s) => s.slug === 'dropped_girl');
    expect(dropped?.enabled).toBe(true);
    expect(ids(dropped)).toEqual(['standard', 'level_10']);
    expect(loaded.authoring?.artworkDiagnostics).toContainEqual({
      code: 'appearance_dropped_artwork_missing',
      slug: 'dropped_girl',
      appearanceId: 'level_20',
      assetId: { kind: 'waifumon', slug: 'dropped_girl', variant: 'level_20' },
    });
  });

  it('still disables a species with no default artwork, and records why', () => {
    tree = scenario();
    const loaded = load(tree);
    const ghost = loaded.species.find((s) => s.slug === 'ghost_girl');
    expect(ghost?.enabled).toBe(false);
    // Disabling short-circuits the per-appearance pass, as it always has.
    expect(ids(ghost)).toEqual(['standard', 'level_20', 'level_10']);
    expect(loaded.authoring?.artworkDiagnostics).toContainEqual({
      code: 'species_disabled_default_artwork_missing',
      slug: 'ghost_girl',
      appearanceId: 'standard',
      assetId: { kind: 'waifumon', slug: 'ghost_girl', variant: 'standard' },
    });
  });

  it('keeps a default appearance with no file when a legacy image exists, and records it', () => {
    tree = createGalleryTree({
      core: [gallerySpecies('legacy_girl', { imagePath: 'legacy/legacy_girl.png' })],
    });
    tree.art('legacy/legacy_girl.png');
    tree.art('waifumon/legacy_girl/level_10.webp');
    tree.art('waifumon/legacy_girl/level_20.webp');
    const loaded = load(tree);
    const legacy = loaded.species.find((s) => s.slug === 'legacy_girl');
    expect(legacy?.enabled).toBe(true);
    expect(ids(legacy)).toContain('standard');
    expect(loaded.authoring?.artworkDiagnostics).toEqual([
      {
        code: 'default_appearance_artwork_missing',
        slug: 'legacy_girl',
        appearanceId: 'standard',
        assetId: { kind: 'waifumon', slug: 'legacy_girl', variant: 'standard' },
      },
    ]);
  });

  it('records nothing for content whose artwork is complete', () => {
    tree = createGalleryTree({ core: [gallerySpecies('complete_girl')] });
    fullArt(tree, 'complete_girl');
    expect(load(tree).authoring?.artworkDiagnostics).toEqual([]);
  });

  it('keeps the authored species untouched beside the runtime ones', () => {
    tree = scenario();
    const loaded = load(tree);
    const authored = loaded.authoring!.species;
    expect(authored.map((s) => s.slug)).toEqual(loaded.species.map((s) => s.slug));
    expect(ids(authored.find((s) => s.slug === 'dropped_girl'))).toEqual([
      'standard',
      'level_20',
      'level_10',
    ]);
    expect(authored.find((s) => s.slug === 'ghost_girl')?.enabled).toBe(true);
  });

  it('never merges a disabled pack into gameplay content', () => {
    tree = scenario();
    const loaded = load(tree);
    expect(loaded.species.map((s) => s.slug)).not.toContain('future_girl');
    expect(loaded.species.map((s) => s.slug)).toContain('live_girl');
    expect(loaded.expansions.find((e) => e.id === 'future_pack')?.enabled).toBe(false);
    expect(loaded.authoring?.unloadedSpecies.map((u) => [u.expansionId, u.species.slug])).toEqual([
      ['future_pack', 'future_girl'],
    ]);
  });
});

describe('gallery catalog (list)', () => {
  it('lists every authored species — loaded, loader-disabled and unloaded — in one answer', () => {
    tree = scenario();
    const catalog = buildGalleryCatalog(load(tree), tree.assetsDir);
    expect(catalog.species.map((s) => s.slug).sort()).toEqual([
      'complete_girl',
      'dropped_girl',
      'future_girl',
      'ghost_girl',
      'live_girl',
    ]);
  });

  it('separates authored, runtime and expansion state', () => {
    tree = scenario();
    const bySlug = new Map(
      buildGalleryCatalog(load(tree), tree.assetsDir).species.map((s) => [s.slug, s]),
    );

    expect(bySlug.get('complete_girl')).toMatchObject({
      source: { kind: 'core' },
      authoredEnabled: true,
      runtime: { loaded: true, enabled: true, disabledByLoader: false },
      appearanceCounts: { authored: 3, inRuntime: 3, artworkAvailable: 3 },
      issues: [],
    });
    expect(bySlug.get('dropped_girl')).toMatchObject({
      runtime: { loaded: true, enabled: true, disabledByLoader: false },
      appearanceCounts: { authored: 3, inRuntime: 2, artworkAvailable: 2 },
    });
    expect(bySlug.get('ghost_girl')).toMatchObject({
      authoredEnabled: true,
      runtime: { loaded: true, enabled: false, disabledByLoader: true },
      appearanceCounts: { authored: 3, inRuntime: 3, artworkAvailable: 0 },
      primary: { appearanceId: 'standard', status: 'missing', format: null },
    });
    expect(bySlug.get('future_girl')).toMatchObject({
      source: {
        kind: 'expansion',
        expansionId: 'future_pack',
        expansionName: 'Pack future_pack',
        expansionEnabled: false,
      },
      authoredEnabled: true,
      runtime: { loaded: false, enabled: null, disabledByLoader: false },
      appearanceCounts: { authored: 3, inRuntime: null, artworkAvailable: 2 },
    });
    expect(bySlug.get('live_girl')).toMatchObject({
      source: { kind: 'expansion', expansionId: 'live_pack', expansionEnabled: true },
      runtime: { loaded: true, enabled: true },
    });
  });

  it('reports the objective issues, and nothing for a clean species', () => {
    tree = scenario();
    const bySlug = new Map(
      buildGalleryCatalog(load(tree), tree.assetsDir).species.map((s) => [s.slug, s]),
    );
    const codes = (slug: string) =>
      bySlug.get(slug)!.issues.map((i) => `${i.code}:${i.appearanceId}`);

    expect(codes('dropped_girl')).toEqual([
      'appearance_artwork_missing:level_20',
      'appearance_not_in_runtime:level_20',
    ]);
    expect(codes('ghost_girl')).toEqual([
      'species_disabled_by_loader:standard',
      'default_artwork_missing:standard',
      'appearance_artwork_missing:level_10',
      'appearance_artwork_missing:level_20',
    ]);
    // Not loaded at all is the species' state, not an appearance finding.
    expect(codes('future_girl')).toEqual(['appearance_artwork_missing:level_10']);
    expect(codes('complete_girl')).toEqual([]);
  });

  it('summarizes the catalog with every issue code present', () => {
    tree = scenario();
    const { summary } = buildGalleryCatalog(load(tree), tree.assetsDir);
    expect(summary).toMatchObject({
      authoredSpecies: 5,
      runtimeLoadedSpecies: 4,
      runtimeEnabledSpecies: 3,
      loaderDisabledSpecies: 1,
      unloadedSpecies: 1,
      authoredAppearances: 15,
      runtimeAppearances: 11,
      artworkAvailableAppearances: 10,
      speciesWithIssues: 3,
    });
    expect(Object.keys(summary.issueCounts).sort()).toEqual([...GALLERY_ISSUE_CODES].sort());
    expect(summary.issueCounts).toMatchObject({
      species_disabled_by_loader: 1,
      default_artwork_missing: 1,
      appearance_artwork_missing: 4,
      appearance_not_in_runtime: 1,
      renditions_missing: 0,
    });
  });

  it('returns raw tags for the Portal to derive Zone from, and derives none itself', () => {
    tree = createGalleryTree({
      core: [gallerySpecies('tagged_girl', { tags: ['expansion', 'twin_peeks'] })],
    });
    fullArt(tree, 'tagged_girl');
    const [entry] = buildGalleryCatalog(load(tree), tree.assetsDir).species;
    expect(entry!.tags).toEqual(['expansion', 'twin_peeks']);
    expect(entry).not.toHaveProperty('zone');
  });

  it('never exposes imagePath or any absolute path', () => {
    tree = createGalleryTree({
      core: [gallerySpecies('legacy_girl', { imagePath: 'legacy/secret_location.png' })],
    });
    tree.art('legacy/secret_location.png');
    const content = load(tree);
    const json = JSON.stringify([
      buildGalleryCatalog(content, tree.assetsDir),
      buildGallerySpeciesDetail(content, tree.assetsDir, 'legacy_girl'),
    ]);
    expect(json).not.toContain('imagePath');
    expect(json).not.toContain('secret_location');
    expect(json).not.toContain(tree.root);
  });

  it('reads a hand-built snapshot with no authoring record as authored == runtime', () => {
    tree = createGalleryTree({ core: [gallerySpecies('complete_girl')] });
    fullArt(tree, 'complete_girl');
    const { authoring: _authoring, ...bare } = load(tree);
    const catalog = buildGalleryCatalog(bare, tree.assetsDir);
    expect(catalog.species[0]).toMatchObject({
      runtime: { loaded: true, disabledByLoader: false },
      appearanceCounts: { authored: 3, inRuntime: 3 },
    });
    expect(catalog.summary.unloadedSpecies).toBe(0);
  });
});

describe('gallery species detail', () => {
  it('returns every authored appearance, including one the runtime dropped', () => {
    tree = scenario();
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'dropped_girl')!;
    expect(detail.appearances.map((a) => [a.id, a.inRuntime, a.artwork.status])).toEqual([
      ['standard', true, 'available'],
      ['level_10', true, 'available'],
      ['level_20', false, 'missing'],
    ]);
    const lost = detail.appearances[2]!;
    expect(lost.loaderDiagnostics).toEqual(['appearance_dropped_artwork_missing']);
    expect(lost.issues.map((i) => i.code)).toEqual([
      'appearance_artwork_missing',
      'appearance_not_in_runtime',
    ]);
    expect(detail.loaderDiagnostics).toHaveLength(1);
  });

  it('orders by sortOrder and carries unlock, default and AssetId metadata', () => {
    tree = scenario();
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'complete_girl')!;
    expect(detail.appearances.map((a) => a.id)).toEqual(['standard', 'level_10', 'level_20']);
    expect(detail.appearances[0]).toMatchObject({
      isDefault: true,
      implicit: false,
      unlock: { type: 'owned' },
      unlockLabel: 'Owned',
      assetId: { kind: 'waifumon', slug: 'complete_girl', variant: 'standard' },
      artwork: {
        status: 'available',
        format: 'webp',
        storageStem: 'waifumon/complete_girl/standard',
      },
    });
    expect(detail.appearances[2]).toMatchObject({
      isDefault: false,
      unlock: { type: 'level', atLevel: 20 },
      unlockLabel: 'Reach Level 20',
      sortOrder: 20,
    });
  });

  it('distinguishes an overridden content rating from an inherited one', () => {
    tree = createGalleryTree({
      core: [
        gallerySpecies('rated_girl', {
          contentRating: 'suggestive',
          appearances: [
            { id: 'standard', name: 'Standard', sortOrder: 0, unlock: { type: 'owned' } },
            {
              id: 'level_10',
              name: 'After Dark',
              sortOrder: 10,
              contentRating: 'explicit',
              description: 'A later look.',
              flavorText: 'Shh.',
              cosmeticRarity: 'rare',
              introducedVersion: 'v2.0',
              tags: ['night'],
              unlockLabel: 'Hit ten',
              unlock: { type: 'level', atLevel: 10 },
            },
          ],
        }),
      ],
    });
    tree.art('waifumon/rated_girl/standard.webp');
    tree.art('waifumon/rated_girl/level_10.webp');
    const [standard, night] = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'rated_girl')!
      .appearances;
    expect(standard).toMatchObject({ contentRating: 'suggestive', contentRatingSource: 'species' });
    expect(night).toMatchObject({
      contentRating: 'explicit',
      contentRatingSource: 'appearance',
      description: 'A later look.',
      flavorText: 'Shh.',
      cosmeticRarity: 'rare',
      introducedVersion: 'v2.0',
      tags: ['night'],
      unlockLabel: 'Hit ten',
    });
  });

  it('shows the implicit standard entry for a species with no authored catalog', () => {
    tree = createGalleryTree({ core: [gallerySpecies('plain_girl', { appearances: undefined })] });
    tree.art('waifumon/plain_girl/standard.webp');
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'plain_girl')!;
    expect(detail.appearances).toHaveLength(1);
    expect(detail.appearances[0]).toMatchObject({ id: 'standard', isDefault: true, implicit: true });
    expect(detail.appearanceCounts).toEqual({ authored: 1, inRuntime: 1, artworkAvailable: 1 });
  });

  it('inspects a species from a disabled pack', () => {
    tree = scenario();
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'future_girl')!;
    expect(detail.runtime.loaded).toBe(false);
    expect(detail.appearances.map((a) => [a.id, a.inRuntime, a.artwork.status])).toEqual([
      ['standard', false, 'available'],
      ['level_10', false, 'missing'],
      ['level_20', false, 'available'],
    ]);
  });

  it('reports rendition presence, and flags a missing size', () => {
    tree = createGalleryTree({ core: [gallerySpecies('complete_girl')] });
    fullArt(tree, 'complete_girl');
    for (const w of [256, 512, 1024]) {
      tree.art(`.thumbnails/${w}/waifumon/complete_girl/standard.webp`);
    }
    tree.art('.thumbnails/256/waifumon/complete_girl/level_10.webp');
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'complete_girl')!;
    expect(detail.appearances[0]!.artwork.renditions).toEqual({ 256: true, 512: true, 1024: true });
    expect(detail.appearances[0]!.issues).toEqual([]);
    expect(detail.appearances[1]!.artwork.renditions).toEqual({ 256: true, 512: false, 1024: false });
    expect(detail.appearances[1]!.issues.map((i) => i.code)).toEqual(['renditions_missing']);
  });

  it('flags PNG-only artwork', () => {
    tree = createGalleryTree({ core: [gallerySpecies('png_girl')] });
    tree.art('waifumon/png_girl/standard.png');
    tree.art('waifumon/png_girl/level_10.webp');
    tree.art('waifumon/png_girl/level_20.webp');
    const detail = buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'png_girl')!;
    expect(detail.appearances[0]!.artwork.format).toBe('png');
    expect(detail.appearances[0]!.issues.map((i) => i.code)).toContain('artwork_png_only');
    expect(detail.primary.format).toBe('png');
  });

  it('answers null for a slug no content file defines', () => {
    tree = scenario();
    expect(buildGallerySpeciesDetail(load(tree), tree.assetsDir, 'nobody_girl')).toBeNull();
  });
});

describe('artwork containment', () => {
  function symlinkScenario(): { t: GalleryTree; secret: string } {
    const t = createGalleryTree({ core: [gallerySpecies('sym_girl')] });
    const secret = path.join(t.root, 'outside-secret.webp');
    fs.writeFileSync(secret, 'TOP-SECRET-BYTES');
    t.art('waifumon/sym_girl/standard.webp');
    t.art('waifumon/sym_girl/level_10.webp');
    fs.symlinkSync(secret, path.join(t.assetsDir, 'waifumon/sym_girl/level_20.webp'));
    return { t, secret };
  }

  it('treats a symlink out of the assets root as unsafe, never available', () => {
    const { t } = symlinkScenario();
    tree = t;
    const assetId = { kind: 'waifumon', slug: 'sym_girl', variant: 'level_20' } as const;
    expect(inspectSpeciesArtwork(t.assetsDir, assetId)).toEqual({ status: 'unsafe' });
    expect(locateSpeciesArtwork(t.assetsDir, assetId)).toBeNull();

    const content = load(t);
    // The loader treats it exactly as missing — dropped, as before.
    expect(ids(content.species[0])).toEqual(['standard', 'level_10']);

    const detail = buildGallerySpeciesDetail(content, t.assetsDir, 'sym_girl')!;
    const escaped = detail.appearances.find((a) => a.id === 'level_20')!;
    expect(escaped.artwork).toMatchObject({ status: 'unsafe', format: null });
    expect(escaped.artwork.renditions).toBeUndefined();
    expect(escaped.issues.map((i) => i.code)).toContain('artwork_unsafe');
    expect(JSON.stringify(detail)).not.toContain('TOP-SECRET');
  });

  it('keeps the format preference: an escaping WebP falls through to a contained PNG', () => {
    const { t } = symlinkScenario();
    tree = t;
    // level_20.webp is the escaping symlink; a real PNG sits beside it.
    t.art('waifumon/sym_girl/level_20.png');
    const assetId = { kind: 'waifumon', slug: 'sym_girl', variant: 'level_20' } as const;
    const inspected = inspectSpeciesArtwork(t.assetsDir, assetId);
    expect(inspected.status).toBe('available');
    expect(inspected.status === 'available' && inspected.file.extension).toBe('png');
    expect(locateSpeciesArtwork(t.assetsDir, assetId)?.extension).toBe('png');
  });

  it('does not count a rendition symlinked out of the assets root', () => {
    const { t, secret } = symlinkScenario();
    tree = t;
    fs.mkdirSync(path.join(t.assetsDir, '.thumbnails/256/waifumon/sym_girl'), { recursive: true });
    fs.symlinkSync(secret, path.join(t.assetsDir, '.thumbnails/256/waifumon/sym_girl/standard.webp'));
    const detail = buildGallerySpeciesDetail(load(t), t.assetsDir, 'sym_girl')!;
    expect(detail.appearances[0]!.artwork.renditions?.[256]).toBe(false);
  });

  it('treats a species directory symlinked out of the root as unsafe', () => {
    tree = createGalleryTree({ core: [gallerySpecies('dir_girl')] });
    const outside = path.join(tree.root, 'elsewhere');
    fs.mkdirSync(outside);
    for (const id of ['standard', 'level_10', 'level_20']) {
      fs.writeFileSync(path.join(outside, `${id}.webp`), 'OUTSIDE');
    }
    fs.mkdirSync(path.join(tree.assetsDir, 'waifumon'), { recursive: true });
    fs.symlinkSync(outside, path.join(tree.assetsDir, 'waifumon/dir_girl'));
    const content = load(tree);
    expect(content.species[0]!.enabled).toBe(false);
    const [entry] = buildGalleryCatalog(content, tree.assetsDir).species;
    expect(entry!.primary.status).toBe('unsafe');
    expect(entry!.appearanceCounts.artworkAvailable).toBe(0);
  });
});
