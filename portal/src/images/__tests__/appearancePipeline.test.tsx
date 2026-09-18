/**
 * The Portal half of the authoring pipeline: **appearance id → asset identity
 * → resolved URL → rendered gallery.**
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
import { render, screen, fireEvent } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Appearance } from '@/api/types';
import { Artwork } from '@/components/media/Artwork';
import { appearanceAsset } from '@/images/assets';
import type { AssetId } from '@/images/types';
import { createLocalDevAssetsProvider } from '../providers/localDevAssets';
import { createSilhouetteProvider } from '../providers/silhouette';
import { resolveAsset, setImageProviderChain } from '../provider';
import { ARTWORK_WIDTH } from '../sizes';

const SLUG = 'test_species';

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

    expect(resolved.url).toMatch(new RegExp(`waifumon/${SLUG}/level_20$`));
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

    expect(resolved.url).toMatch(new RegExp(`waifumon/${SLUG}/winter_2026$`));
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
//
// Renditions are produced by the bot's artwork build tool
// (`npm run artwork:build`, root `src/tools/artworkBuild.ts`), which encodes
// every size directly from the PNG master. Its tests — including "an
// appearance id it was never told about" — live beside it in the root package
// (`tests/unit/artworkBuild.test.ts`), since this package may not import the
// bot's `src/`.

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
      expect.stringMatching(new RegExp(`waifumon/${SLUG}/level_20$`)),
    );
  });

  it('swaps artwork when the rendered appearance changes, and back again', () => {
    // What a player sees when the copy they are looking at changes what it is
    // wearing: the API reports a new `variant`, and every surface follows.
    const { rerender } = renderAppearance('standard');
    expect(screen.getByAltText('standard').getAttribute('src')).toMatch(new RegExp(`waifumon/${SLUG}/standard$`));

    rerender(
      <Artwork
        asset={assetOf(apiAppearance('level_20'))}
        name="level_20"
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
    expect(screen.getByAltText('level_20').getAttribute('src')).toMatch(new RegExp(`waifumon/${SLUG}/level_20$`));

    rerender(
      <Artwork
        asset={assetOf(apiAppearance('standard'))}
        name="standard"
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
    expect(screen.getByAltText('standard').getAttribute('src')).toMatch(new RegExp(`waifumon/${SLUG}/standard$`));
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
