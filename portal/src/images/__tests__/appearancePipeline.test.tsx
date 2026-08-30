/**
 * The Portal half of the authoring pipeline: **appearance id → asset identity
 * → resolved URL → generated rendition → rendered gallery.**
 *
 * The bot-side half (artwork → content JSON → the appearance data the API
 * serves) lives in `tests/integration/appearancePipeline.test.ts` in the root
 * package. It cannot live here and this cannot live there: the Portal is a
 * separate package whose own architecture test forbids importing the bot's
 * `src/`. The two files meet at the `assetId` — `{ kind, slug, variant }` — and
 * that is the entire contract between them.
 *
 * What this file is defending is a property, not a feature: **nothing in the
 * Portal knows the names of appearances.** No enum, no list, no image map, no
 * switch. An appearance the API invents tomorrow renders today. Several tests
 * below deliberately use `winter_2026`, an id no code in this repository has
 * ever heard of.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Appearance } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { appearanceAsset } from '@/images/assets';
import type { AssetId } from '@/images/types';
import { createLocalDevAssetsProvider } from '../providers/localDevAssets';
import { createSilhouetteProvider } from '../providers/silhouette';
import { resolveAsset, setImageProviderChain } from '../provider';
import { ARTWORK_WIDTH } from '../sizes';

const SLUG = 'test_species';
const portalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * `appearanceAsset` for an entry this file has already declared unlocked.
 *
 * It returns `AssetId | null` because a locked entry arrives with no `assetId`
 * — that is the access control. Every appearance here is unlocked, so the
 * assertion is a statement about the fixture rather than a hope about the code.
 */
function assetOf(appearance: Appearance): AssetId {
  const asset = appearanceAsset(appearance);
  if (asset === null) throw new Error(`fixture ${appearance.id} has no assetId`);
  return asset;
}

beforeEach(() => {
  setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);
});

// ── assetId → URL ───────────────────────────────────────────────────────────

/** The API's shape, which is structurally identical to the Portal's `AssetId`. */
function apiAppearance(id: string, overrides: Partial<Appearance> = {}): Appearance {
  return {
    id,
    name: id,
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    assetId: { kind: 'waifumon', slug: SLUG, variant: id },
    unlock: { type: 'owned' },
    unlockLabel: 'Owned',
    // Unlocked throughout: this file is about *resolution*, not about access
    // control. `appearanceAsset` returns `null` for a locked entry — that path
    // is covered in `AppearanceGallery.test.tsx`, where the rendering decision
    // it drives actually lives.
    isUnlocked: true,
    isSelected: false,
    ...overrides,
  };
}

describe('appearance identity → image URL', () => {
  it('resolves a level appearance to its own artwork, not the species default', () => {
    const resolved = resolveAsset(assetOf(apiAppearance('level_20')), {
      displayWidth: ARTWORK_WIDTH.gridTile,
    });

    expect(resolved.url).toContain(`waifumon/${SLUG}/level_20.png`);
    expect(resolved.url).not.toContain('standard');
    expect(resolved.isFallback).toBe(false);
  });

  it('asks for a rendition sized to what is being drawn', () => {
    const tile = resolveAsset(assetOf(apiAppearance('level_20')), {
      displayWidth: ARTWORK_WIDTH.gridTile,
    });
    const hero = resolveAsset(assetOf(apiAppearance('level_20')), {
      displayWidth: ARTWORK_WIDTH.hero,
    });

    expect(tile.url).toMatch(/\/t\/\d+\//);
    // Two sizes of one appearance are two URLs, not one overwriting the other.
    expect(tile.url).not.toBe(hero.url);
  });

  it('resolves an appearance id this codebase has never heard of', () => {
    // If this needed a code change, every seasonal drop would need one too.
    const resolved = resolveAsset(assetOf(apiAppearance('winter_2026')), {
      displayWidth: ARTWORK_WIDTH.gridTile,
    });

    expect(resolved.url).toContain(`waifumon/${SLUG}/winter_2026.png`);
  });

  it('keeps each appearance of one species distinct', () => {
    const urls = ['standard', 'level_10', 'level_50', 'winter_2026'].map(
      (id) =>
        resolveAsset(assetOf(apiAppearance(id)), {
          displayWidth: ARTWORK_WIDTH.gridTile,
        }).url,
    );

    expect(new Set(urls).size).toBe(urls.length);
  });
});

// ── Rendition generation ────────────────────────────────────────────────────

/**
 * Runs the real `generate-thumbnails.mjs` against a throwaway assets tree.
 *
 * Spawned rather than imported because the script is a CLI that runs its work
 * on load — and spawning is what exercises the thing authors actually invoke.
 * `sharp` is a devDependency of this package, so this is skipped rather than
 * failed where it is absent: renditions are an optimisation, and a test suite
 * that cannot run without native binaries would make them feel mandatory.
 */
const hasSharp = fs.existsSync(path.join(portalRoot, 'node_modules', 'sharp'));

describe.skipIf(!hasSharp)('rendition generation', () => {
  let assetsDir: string;
  let pngFixture: Buffer;

  beforeAll(() => {
    // A real image, so sharp has something it can actually decode and resize.
    pngFixture = fs.readFileSync(
      path.resolve(portalRoot, '..', 'assets', 'waifumon', 'alley_catgirl', 'standard.png'),
    );
  });

  beforeEach(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waifumon-thumbs-'));
  });

  afterEach(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  function addArtwork(...appearanceIds: string[]): void {
    const dir = path.join(assetsDir, 'waifumon', SLUG);
    fs.mkdirSync(dir, { recursive: true });
    for (const id of appearanceIds) fs.writeFileSync(path.join(dir, `${id}.png`), pngFixture);
  }

  function generate(): string {
    return execFileSync(
      process.execPath,
      ['scripts/generate-thumbnails.mjs', '--assets', assetsDir],
      { cwd: portalRoot, encoding: 'utf8' },
    );
  }

  function rendition(width: number, appearanceId: string): string {
    return path.join(assetsDir, '.thumbnails', String(width), 'waifumon', SLUG, `${appearanceId}.webp`);
  }

  it('renders the same set for an appearance as for the default artwork', () => {
    addArtwork('standard', 'level_10');

    generate();

    for (const width of [256, 512, 1024]) {
      expect(fs.existsSync(rendition(width, 'standard')), `standard @${width}`).toBe(true);
      expect(fs.existsSync(rendition(width, 'level_10')), `level_10 @${width}`).toBe(true);
    }
  });

  it('renders an appearance id it was never told about', () => {
    // The generator walks the artwork tree; it does not consult a milestone
    // list. That is what keeps `assets:thumbs` useful for seasonal drops that
    // `appearances:sync` knows nothing about.
    addArtwork('standard', 'winter_2026');

    generate();

    expect(fs.existsSync(rendition(512, 'winter_2026'))).toBe(true);
  });

  it('produces renditions far smaller than the source', () => {
    addArtwork('level_10');
    generate();

    const source = fs.statSync(path.join(assetsDir, 'waifumon', SLUG, 'level_10.png')).size;
    expect(fs.statSync(rendition(512, 'level_10')).size).toBeLessThan(source / 10);
  });

  it('is idempotent, and never treats its own output as source artwork', () => {
    addArtwork('standard', 'level_10');
    generate();
    const first = fs.readFileSync(rendition(512, 'level_10'));

    const output = generate();

    expect(output).toContain('0 written');
    // A second pass must not re-encode a rendition from a rendition, which
    // would degrade the image a little more on every run.
    expect(fs.readFileSync(rendition(512, 'level_10')).equals(first)).toBe(true);
    expect(fs.existsSync(path.join(assetsDir, '.thumbnails', '512', '.thumbnails'))).toBe(false);
  });

  it('picks up artwork added after an earlier run', () => {
    addArtwork('standard');
    generate();

    addArtwork('level_20');
    const output = generate();

    expect(fs.existsSync(rendition(512, 'level_20'))).toBe(true);
    expect(output).toContain('3 written');
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

/** jsdom never loads images; these getters stand in for a warm browser cache. */
const cached = new Set<string>();

function installCacheStub(): void {
  Object.defineProperty(HTMLImageElement.prototype, 'complete', {
    configurable: true,
    get(this: HTMLImageElement) {
      return cached.has(this.getAttribute('src') ?? '');
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get(this: HTMLImageElement) {
      return cached.has(this.getAttribute('src') ?? '') ? 300 : 0;
    },
  });
}

describe('rendering an appearance', () => {
  beforeAll(installCacheStub);
  afterAll(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, 'complete');
    Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  });
  beforeEach(() => cached.clear());

  function renderAppearance(id: string) {
    return render(
      <Artwork
        asset={assetOf(apiAppearance(id))}
        name={id}
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
  }

  it('draws the artwork the appearance names', () => {
    renderAppearance('level_20');

    expect(screen.getByAltText('level_20')).toHaveAttribute(
      'src',
      expect.stringContaining(`waifumon/${SLUG}/level_20.png`),
    );
  });

  it('swaps artwork when the rendered appearance changes, and back again', () => {
    // What a player sees when the copy they are looking at changes what it is
    // wearing: the API reports a new `variant`, and every surface follows.
    const { rerender } = renderAppearance('standard');
    expect(screen.getByAltText('standard').getAttribute('src')).toContain('standard.png');

    rerender(
      <Artwork
        asset={assetOf(apiAppearance('level_20'))}
        name="level_20"
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
    expect(screen.getByAltText('level_20').getAttribute('src')).toContain('level_20.png');

    rerender(
      <Artwork
        asset={assetOf(apiAppearance('standard'))}
        name="standard"
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
    expect(screen.getByAltText('standard').getAttribute('src')).toContain('standard.png');
  });

  it('does not strand an appearance on its skeleton when returning to it', () => {
    // Guards the cached-image lifecycle fix specifically for appearance
    // artwork: a look you have already seen must render instantly on the way
    // back, not sit on a shimmer forever.
    const first = renderAppearance('level_20');
    const url = screen.getByAltText('level_20').getAttribute('src') ?? '';
    fireEvent.load(screen.getByAltText('level_20'));
    first.unmount();

    cached.add(url);
    renderAppearance('level_20');

    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('falls back to a silhouette rather than a broken card when art is absent', () => {
    // Renditions are an optimisation. If one is missing the dev server serves
    // the original; if the original is missing too, the chain still ends
    // somewhere renderable.
    renderAppearance('level_20');
    fireEvent.error(screen.getByAltText('level_20'));

    expect(screen.getByAltText('level_20').getAttribute('src')).toContain('data:image/svg+xml');
  });
});
