/**
 * Ownership → appearance unlock → rendered artwork.
 *
 * The bug these lock down: a Waifumon the player had just captured kept
 * rendering as a silhouette. The unlock state was never wrong — `isUnlocked`
 * for an `owned` appearance is `true` by construction on the server, from the
 * instant the row exists — but the Portal reached the silhouette by two other
 * routes, and both looked identical to a locked appearance from the outside.
 *
 *   1. **A guessed asset identity.** `speciesAsset` ignored the appearance
 *      catalog the API had already sent and asked for `<slug>/standard.png`.
 *      A species whose `owned` entry is authored under any other id has no
 *      such file, the load fails, and `useImage` degrades to the silhouette.
 *      Species-dependent, which is exactly how it was reported.
 *   2. **A stale ownership overlay.** The Encyclopedia's `discovered` flag
 *      comes from a whole-collection walk that was cached for five minutes and
 *      never refetched on focus. Capture happens in Discord, so nothing told
 *      the Portal to look again.
 *
 * The rule being defended in both directions: **artwork the player does not
 * own stays hidden, and artwork they do own renders immediately.** Neither
 * test below reaches that by relaxing the silhouette — the source of truth
 * stays ownership and the server's unlock state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Appearance, AppearanceCatalogEntry, ContentSpecies, OwnedWaifu } from '@/api/types';
import { routes } from '@/app/router';
import { Artwork } from '@/components/media/Artwork';
import { appearanceAsset, defaultAppearanceOf, speciesAsset } from '@/images/assets';
import { resolveAsset, setImageProviderChain } from '@/images/provider';
import { createArtworkApiProvider } from '@/images/providers/artworkApi';
import { createLocalDevAssetsProvider } from '@/images/providers/localDevAssets';
import { createSilhouetteProvider } from '@/images/providers/silhouette';
import { ARTWORK_WIDTH } from '@/images/sizes';
import { renderRoutes } from '@/test/renderWithProviders';
import * as fixtures from '../../../msw/fixtures';
import { apiError, data, page } from '../../../msw/handlers';
import { server } from '../../../msw/server';

beforeEach(() => {
  setImageProviderChain([
    createArtworkApiProvider(),
    createLocalDevAssetsProvider(),
    createSilhouetteProvider(),
  ]);
});

// ── Species shapes ──────────────────────────────────────────────────────────

function catalogEntry(
  slug: string,
  id: string,
  unlock: AppearanceCatalogEntry['unlock'],
): AppearanceCatalogEntry {
  return {
    id,
    name: id,
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    // Mirrors the catalog endpoint: it has no player in scope, so it reveals
    // artwork only for the ungated `owned` entry. A gated entry travels as a
    // named slot with `assetId: null`.
    assetId: unlock.type === 'owned' ? { kind: 'waifumon', slug, variant: id } : null,
    unlock,
    unlockLabel: unlock.type === 'owned' ? 'Owned' : `Reach Level ${unlock.atLevel}`,
  };
}

function species(slug: string, appearances: AppearanceCatalogEntry[]): ContentSpecies {
  return {
    slug,
    name: slug,
    rarity: 'R',
    archetype: 'spirit',
    race: 'spirit',
    affinity: 'switch',
    contentRating: 'suggestive',
    description: '',
    tags: [],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances,
  };
}

/** No authored catalog: the API synthesizes the implicit `standard` entry. */
const implicitStandard = species('implicit_one', [
  catalogEntry('implicit_one', 'standard', { type: 'owned' }),
]);

/** An explicit catalog whose default happens to use the canonical id. */
const explicitStandard = species('explicit_one', [
  catalogEntry('explicit_one', 'standard', { type: 'owned' }),
  catalogEntry('explicit_one', 'level_10', { type: 'level', atLevel: 10 }),
]);

/**
 * An explicit catalog whose default is named something else.
 *
 * Legal content — the schema requires exactly one `owned` entry, never that it
 * be called `standard`, and `appearances:sync` deliberately leaves an
 * author-named default alone. This is the species the bug was visible on.
 */
const explicitNonStandard = species('explicit_two', [
  catalogEntry('explicit_two', 'base_look', { type: 'owned' }),
  catalogEntry('explicit_two', 'level_20', { type: 'level', atLevel: 20 }),
]);

/** The copy as the API returns it the moment a capture commits. */
function freshlyCaptured(
  subject: ContentSpecies,
): Pick<OwnedWaifu, 'id' | 'playerId' | 'variant' | 'selectedAppearance'> {
  const owned = subject.appearances.find((entry) => entry.unlock.type === 'owned')!;
  return {
    id: 101,
    playerId: 1,
    // `player_waifus.variant` defaults to the literal string 'standard' on
    // insert whatever the catalog calls its default — which is precisely why
    // the Portal must not render from this column.
    variant: 'standard',
    selectedAppearance: { ...owned, isUnlocked: true, isSelected: true } satisfies Appearance,
  };
}

function urlFor(...args: Parameters<typeof speciesAsset>): string {
  return resolveAsset(speciesAsset(...args), { displayWidth: ARTWORK_WIDTH.gridTile }).url;
}

// ── Newly captured species render their real artwork ────────────────────────

describe('a newly captured species is visually unlocked', () => {
  it('renders the implicit standard appearance', () => {
    expect(urlFor(implicitStandard, freshlyCaptured(implicitStandard))).toContain(
      '/players/1/collection/owned/101/artwork',
    );
  });

  it('renders an explicit catalog’s canonical standard appearance', () => {
    expect(urlFor(explicitStandard, freshlyCaptured(explicitStandard))).toContain(
      '/players/1/collection/owned/101/artwork',
    );
  });

  it('renders an explicit catalog’s default even when it is not called “standard”', () => {
    // The regression. The stored `variant` still reads 'standard'; the API's
    // resolved `selectedAppearance` is the answer, and it says `base_look`.
    const url = urlFor(explicitNonStandard, freshlyCaptured(explicitNonStandard));

    expect(url).toContain('/players/1/collection/owned/101/artwork');
    expect(url).not.toContain('variant');
  });

  it('renders the species’ own default when no copy is in hand', () => {
    // The Encyclopedia path: a species resource with no owned copy attached
    // still has exactly one `owned` catalog entry to render from.
    expect(urlFor(explicitNonStandard)).toContain('/assets/waifumon/explicit_two');
    expect(urlFor(implicitStandard)).toContain('/assets/waifumon/implicit_one');
  });

  it('never falls back to a guessed filename while a catalog is present', () => {
    // The whole defect in one assertion: no resolved URL may name an
    // appearance the catalog does not contain.
    for (const subject of [implicitStandard, explicitStandard, explicitNonStandard]) {
      const ids = subject.appearances.map((entry) => entry.id);
      expect(ids).toContain(defaultAppearanceOf(subject)?.id);
      expect(urlFor(subject)).not.toContain('variant=');
    }
  });
});

// ── The rule that must survive the fix ──────────────────────────────────────

describe('unowned artwork stays hidden', () => {
  it('masks a species the player does not own', () => {
    render(
      <Artwork
        asset={speciesAsset(explicitNonStandard)}
        name={explicitNonStandard.name}
        silhouette
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );

    const img = screen.getByAltText('Undiscovered Waifumon silhouette');
    expect(img.getAttribute('src')).toContain('data:image/svg+xml');
    expect(img.getAttribute('src')).not.toContain('base_look.png');
  });

  it('keeps level-gated artwork locked for a copy that owns the species', () => {
    // Owning her unlocks the `owned` entry and nothing else. This is the
    // no-regression guard: the fix must not turn "she is mine" into "all her
    // artwork is mine".
    const gated = explicitNonStandard.appearances.find((entry) => entry.id === 'level_20')!;

    render(
      <Artwork
        asset={speciesAsset(explicitNonStandard, freshlyCaptured(explicitNonStandard))}
        name="owned"
        displayWidth={ARTWORK_WIDTH.gridTile}
      />,
    );
    expect(screen.getByAltText('owned').getAttribute('src')).toContain(
      '/players/1/collection/owned/101/artwork',
    );

    // And the gated entry cannot be drawn at all: the API sent no `assetId`
    // for it, so there is nothing for the Portal to resolve — no silhouette to
    // un-mask, no variant to reconstruct from the id.
    expect(gated.assetId).toBeNull();
    expect(appearanceAsset(gated)).toBeNull();
  });

  it('does not reconstruct a locked variant from its appearance id', () => {
    // The tempting shortcut, and the reason `appearanceAsset` refuses to take
    // it: `{ slug, variant: entry.id }` reproduces exactly the artwork the
    // server declined to name, turning a server-side control back into a
    // client-side one.
    const gated = explicitNonStandard.appearances.find((entry) => entry.id === 'level_20')!;

    expect(appearanceAsset(gated)).toBeNull();
    // The species-level helper falls through to the ungated default rather
    // than to the gated entry, even when asked about a species that has one.
    expect(urlFor(explicitNonStandard)).not.toContain('level_20');
  });
});

// ── The overlay notices a capture ───────────────────────────────────────────

/**
 * Drives the mocked API through a capture: `stats.owned` and the owned list
 * both grow, exactly as they would after a `/wm capture` in Discord.
 */
function captureInDiscord(): void {
  const newEntry = {
    ...fixtures.ownedEntries[0]!,
    waifu: { ...fixtures.ownedEntries[0]!.waifu, id: 999, speciesId: 11 },
    species: fixtures.speciesRows[0]!,
  };
  const entries = [...fixtures.ownedEntries, newEntry];

  server.use(
    http.get('/api/v1/players/:playerId/collection/stats', () =>
      data({ ...fixtures.dexStats, owned: fixtures.dexStats.owned + 1 }),
    ),
    http.get('/api/v1/players/:playerId/collection/owned', () => page(entries)),
  );
}

const ownedSlugsKey = ['player', fixtures.PLAYER_ID, 'collection', 'ownedSlugs'] as const;

/** The header tally, which only renders once both the catalog and overlay land. */
const SETTLED = /^\d+ \/ \d+ discovered$/;

describe('the ownership overlay after a capture elsewhere', () => {
  it('never presents a species as unowned while the overlay is still loading', async () => {
    // A silhouette is a statement about ownership. Until the overlay answers,
    // the page has no ownership to state — so it must show a skeleton, not the
    // locked treatment. Held open deliberately: without the gate the grid
    // renders from the catalog alone and every tile reads `???`.
    let releaseWalk: () => void = () => {};
    const walkStarted = new Promise<void>((resolveStarted) => {
      server.use(
        http.get('/api/v1/players/:playerId/collection/owned', async () => {
          resolveStarted();
          await new Promise<void>((release) => {
            releaseWalk = release;
          });
          return page(fixtures.ownedEntries);
        }),
      );
    });

    renderRoutes({ routes, initialEntries: ['/encyclopedia'] });
    await walkStarted;
    const user = userEvent.setup();

    // The catalog has arrived — the Type chips are built from it, unlike the
    // hardcoded Show chips — but the overlay has not. No species may be named,
    // and none may be masked either.
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await screen.findByRole('button', { name: 'Spirit' });
    expect(screen.getByLabelText('Loading the encyclopedia')).toBeInTheDocument();
    expect(screen.queryByText('Neko Barista')).toBeNull();
    expect(screen.queryByText('???')).toBeNull();

    releaseWalk();
    expect(await screen.findByText('Neko Barista')).toBeInTheDocument();
  });

  it('keys the walk on the owned count, so a stale overlay cannot answer for a fresh one', async () => {
    const { client } = renderRoutes({ routes, initialEntries: ['/encyclopedia'] });
    await screen.findByText(SETTLED);

    const fetched = client
      .getQueryCache()
      .findAll({ queryKey: ownedSlugsKey })
      .filter((query) => query.state.data !== undefined)
      .map((query) => query.queryKey);

    expect(fetched).toEqual([[...ownedSlugsKey, fixtures.dexStats.owned]]);
  });

  it('re-derives the overlay when a capture moves the owned count', async () => {
    const { client } = renderRoutes({ routes, initialEntries: ['/encyclopedia'] });
    await screen.findByText(SETTLED);

    const before = client.getQueryData<{ countBySlug: Record<string, number> }>([
      ...ownedSlugsKey,
      fixtures.dexStats.owned,
    ]);
    expect(before?.countBySlug['neko_barista']).toBe(1);

    captureInDiscord();

    // Refreshing the *cheap* query is what a focus refetch does after a
    // capture in Discord; the expensive walk follows because the count moved.
    // Before the fix the overlay had no such trigger and kept serving the
    // pre-capture answer — a silhouette for a species the player now owned.
    await client.invalidateQueries({
      queryKey: ['player', fixtures.PLAYER_ID, 'collection', 'stats'],
    });

    await waitFor(() => {
      const walked = client.getQueryData<{ countBySlug: Record<string, number> }>([
        ...ownedSlugsKey,
        fixtures.dexStats.owned + 1,
      ]);
      expect(walked?.countBySlug['neko_barista']).toBe(2);
    });
  });

  it('still resolves the overlay when the cheap count request fails', async () => {
    // The count is an optimisation for *when* to walk, never a precondition
    // for walking. Losing it must not cost the player their whole dex.
    server.use(
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    const { client } = renderRoutes({ routes, initialEntries: ['/encyclopedia'] });

    await waitFor(() => {
      const walked = client.getQueryData<{ countBySlug: Record<string, number> }>([
        ...ownedSlugsKey,
        'unknown',
      ]);
      expect(walked?.countBySlug['neko_barista']).toBe(1);
    });
    expect(await screen.findByText('Neko Barista')).toBeInTheDocument();
  });
});
