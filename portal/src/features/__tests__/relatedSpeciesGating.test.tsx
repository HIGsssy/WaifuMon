/**
 * Artwork gating is fail-closed — the regression suite for the Related Species
 * leak.
 *
 * **The bug.** `/collection/:waifuId` drew its own copy of the Related Species
 * rail, and that copy rendered `speciesAsset(candidate)` straight into
 * `<Artwork>` with no `silhouette` prop and no reference to the ownership
 * overlay. Every neighbour of an owned Waifumon therefore showed her real
 * artwork, discovered or not. It read as a *flash* rather than as a permanent
 * reveal because the rail only exists once the content snapshot lands, and the
 * two things that hide it again — a slower ownership walk settling, or the
 * player navigating on — both arrive afterwards.
 *
 * **The rule these tests defend**, in one line:
 *
 *     real artwork is rendered  ⟺  discovery is positively known to be true
 *
 * Everything else — `false`, still loading, an overlay belonging to another
 * player, a refetch in flight — draws the silhouette. The opposite mistake, a
 * silhouette shown briefly for a species the player *does* own, is acceptable
 * and is what several tests below deliberately assert.
 *
 * No species is hard-coded: the fixtures are generated, and which of them the
 * player owns is the only thing that varies.
 *
 * The server-side half of the same rule — that the artwork URL itself refuses
 * an undiscovered species rather than trusting the client to hide it — lives in
 * `tests/integration/api/speciesArtworkGating.test.ts` in the bot repo, since
 * it is an API contract rather than a Portal one.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ContentSpecies, OwnedEntry, Rarity, Race, Species } from '@/api/types';
import { queryKeys } from '@/api/queryKeys';
import type { OwnedSlugSummary } from '@/api/hooks/useOwnedSlugs';
import { routes } from '@/app/router';
import { setImageProviderChain } from '@/images/provider';
import { createArtworkApiProvider } from '@/images/providers/artworkApi';
import { createSilhouetteProvider } from '@/images/providers/silhouette';
import { renderRoutes } from '@/test/renderWithProviders';
import * as fixtures from '../../../msw/fixtures';
import { apiError, data, page } from '../../../msw/handlers';
import { server } from '../../../msw/server';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * One archetype for all three, because "related" *is* "same archetype" — this
 * is what makes each of them appear in the others' rail.
 */
const ARCHETYPE = 'spirit';

/** The copy being viewed, a related species the player owns, and one they do not. */
const SUBJECT = 'gating_subject';
const KNOWN = 'gating_known';
const UNKNOWN = 'gating_unknown';

const SUBJECT_WAIFU = 501;
const KNOWN_WAIFU = 502;

function speciesRow(id: number, slug: string, name: string, rarity: Rarity): Species {
  return {
    id,
    slug,
    name,
    rarity,
    archetype: ARCHETYPE,
    race: ARCHETYPE as Race,
    affinity: 'switch',
    contentRating: 'suggestive',
    description: `Everything the encyclopedia knows about ${name}.`,
    tags: [],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances: [fixtures.standardAppearance(slug)],
  };
}

const ROWS: Species[] = [
  speciesRow(901, SUBJECT, 'Subject Species', 'UR'),
  speciesRow(902, KNOWN, 'Known Species', 'SR'),
  speciesRow(903, UNKNOWN, 'Unknown Species', 'R'),
];

const CONTENT: ContentSpecies[] = ROWS.map(({ id: _id, ...rest }) => rest);

function ownedEntry(waifuId: number, row: Species): OwnedEntry {
  return {
    waifu: {
      id: waifuId,
      playerId: fixtures.PLAYER_ID,
      speciesId: row.id,
      level: 5,
      xp: 100,
      affection: 10,
      nickname: null,
      isFavorite: false,
      variant: 'standard',
      cosmetics: [],
      selectedAppearance: {
        ...fixtures.standardAppearance(row.slug),
        isUnlocked: true,
        isSelected: true,
      },
      caughtAt: '2026-07-02T18:30:00.000Z',
      releasedAt: null,
    },
    species: row,
    progress: { level: 5, xp: 100, xpIntoLevel: 20, xpToNext: 80, atMaxLevel: false },
  };
}

/** The player owns the subject and one related species. Never `UNKNOWN`. */
const OWNED: OwnedEntry[] = [ownedEntry(SUBJECT_WAIFU, ROWS[0]!), ownedEntry(KNOWN_WAIFU, ROWS[1]!)];

const OWNED_SLUGS_KEY = queryKeys.ownedSlugs(fixtures.PLAYER_ID, OWNED.length);

/**
 * The collection walk, optionally held open so a test can observe the window in
 * which the content snapshot has landed and the ownership overlay has not.
 */
function collectionHandlers(options: { holdWalk?: boolean } = {}) {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const walkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = options.holdWalk
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();

  server.use(
    http.get('/api/v1/content/species', () => data(CONTENT)),
    http.get('/api/v1/content/species/:slug', ({ params }) => {
      const found = CONTENT.find((entry) => entry.slug === params.slug);
      return data(found);
    }),
    http.get('/api/v1/players/:playerId/collection/stats', () =>
      data({ owned: OWNED.length, distinctSpecies: 2, totalSpecies: CONTENT.length }),
    ),
    http.get('/api/v1/players/:playerId/collection/owned', async () => {
      started();
      await gate;
      return page(OWNED);
    }),
    http.get('/api/v1/players/:playerId/collection/owned/:waifuId', ({ params }) => {
      const found = OWNED.find((entry) => String(entry.waifu.id) === params.waifuId);
      return data(found);
    }),
    http.get('/api/v1/players/:playerId/collection/buddy', () => data(OWNED[0])),
    http.get('/api/v1/players/:playerId/collection/owned/:waifuId/appearances', ({ params }) => {
      const found = OWNED.find((entry) => String(entry.waifu.id) === params.waifuId)!;
      return data({
        selected: 'standard',
        appearances: [found.waifu.selectedAppearance],
      });
    }),
  );

  return { walkStarted, release: () => release() };
}

// ── Observing what the DOM ever showed ──────────────────────────────────────

/**
 * Every `src` any `<img>` has held since this was started.
 *
 * A single assertion after the dust settles cannot catch a *flash* — the whole
 * defect was artwork that appeared and then corrected itself. Recording the
 * history turns "must never be rendered" into something a test can actually
 * check, rather than "is not rendered at the one moment we happened to look".
 */
function watchImageSources(): { seen: () => string[]; stop: () => string[] } {
  const seen = new Set<string>();

  const record = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLImageElement) seen.add(node.getAttribute('src') ?? '');
    for (const img of node.querySelectorAll('img')) seen.add(img.getAttribute('src') ?? '');
  };

  const observer = new MutationObserver((records) => {
    for (const entry of records) {
      if (entry.type === 'attributes') record(entry.target);
      for (const added of entry.addedNodes) record(added);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  const snapshot = () => {
    record(document.body);
    return [...seen];
  };

  return {
    seen: snapshot,
    stop: () => {
      const final = snapshot();
      observer.disconnect();
      return final;
    },
  };
}

/** The authenticated base-artwork route for one species, at any rendition. */
function artworkRouteFor(slug: string): RegExp {
  return new RegExp(`/v1/assets/waifumon/${slug}(\\?|$)`);
}

function currentImageSources(): string[] {
  return [...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '');
}

/** Every rendered tile that is showing the locked treatment. */
function silhouettes(): HTMLElement[] {
  return screen.queryAllByAltText('Undiscovered Waifumon silhouette');
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Two providers only, so "real artwork" and "silhouette" are the only two
  // shapes a `src` can take and neither assertion is ambiguous. Also clears the
  // resolver's memo table between tests.
  setImageProviderChain([createArtworkApiProvider(), createSilhouetteProvider()]);
});

// ── 1. An undiscovered related species ──────────────────────────────────────

describe('a related species the player has not discovered', () => {
  it('never renders its real artwork on the owned-copy page', async () => {
    collectionHandlers();
    const watcher = watchImageSources();

    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    // Wait for the rail to be fully settled: the species the player *does* own
    // has resolved, so the overlay has certainly answered by now.
    await screen.findByText('Known Species');
    expect(currentImageSources().some((src) => artworkRouteFor(KNOWN).test(src))).toBe(true);

    const everSeen = watcher.stop();
    expect(everSeen.some((src) => artworkRouteFor(UNKNOWN).test(src))).toBe(false);
  });

  it('shows the locked treatment and withholds the name', async () => {
    collectionHandlers();
    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    await screen.findByText('Known Species');
    expect(screen.getByText('???')).toBeInTheDocument();
    expect(screen.queryByText('Unknown Species')).toBeNull();
    expect(silhouettes().length).toBeGreaterThan(0);
  });

  it('keeps the real name out of the accessibility tree as well as the pixels', async () => {
    // A locked tile that still carried `alt="Unknown Species — Rare"` would be
    // a spoiler for anyone using a screen reader, and invisible to a test that
    // only checked the image bytes.
    collectionHandlers();
    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    await screen.findByText('Known Species');
    expect(screen.queryByAltText(/Unknown Species/)).toBeNull();
  });
});

// ── 2 & 3. Loading, and content arriving before ownership ───────────────────

describe('while discovery is still unknown', () => {
  it('renders the locked state and no real artwork for anything', async () => {
    const { walkStarted, release } = collectionHandlers({ holdWalk: true });
    const watcher = watchImageSources();

    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });
    // Inside `act`: the walk signals from an MSW handler, so React work that
    // was already queued lands while the gate is still shut.
    await act(async () => {
      await walkStarted;
    });

    // The content snapshot has landed — the rail is on screen and reads its
    // headings from it — while the ownership walk is still in flight. This is
    // the exact ordering the leak was visible in.
    await screen.findByRole('heading', { name: 'Related species' });

    const duringLoad = watcher.seen();
    for (const slug of [KNOWN, UNKNOWN]) {
      expect(duringLoad.some((src) => artworkRouteFor(slug).test(src))).toBe(false);
    }
    // Locked, not blank: an unknown answer is presented exactly like "no".
    expect(silhouettes().length).toBeGreaterThan(0);

    await act(async () => {
      release();
    });
    await screen.findByText('Known Species');
    watcher.stop();
  });

  it('does not flash the undiscovered artwork once the overlay lands', async () => {
    const { walkStarted, release } = collectionHandlers({ holdWalk: true });
    const watcher = watchImageSources();

    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });
    // Inside `act`: the walk signals from an MSW handler, so React work that
    // was already queued lands while the gate is still shut.
    await act(async () => {
      await walkStarted;
    });
    await screen.findByRole('heading', { name: 'Related species' });
    // Wrapped: releasing the walk resolves a query outside React's knowledge,
    // and the state updates it triggers are the ones under test.
    await act(async () => {
      release();
    });

    // 4. Authorization is now positively known, and the species the player owns
    //    reveals — the gate opens, it does not merely stay shut.
    await screen.findByText('Known Species');
    await waitFor(() =>
      expect(currentImageSources().some((src) => artworkRouteFor(KNOWN).test(src))).toBe(true),
    );

    // Let every other query on the page settle before asserting on history:
    // a late arrival is exactly the kind of thing that could reveal artwork.
    await screen.findByText(/Everything the encyclopedia knows about Subject Species/);
    await waitFor(() => expect(screen.getByLabelText(/Affection/)).toBeInTheDocument());

    const everSeen = watcher.stop();
    expect(everSeen.some((src) => artworkRouteFor(UNKNOWN).test(src))).toBe(false);
  });
});

// ── 5. Navigating from an unlocked species to a locked one ──────────────────

describe('navigating between species', () => {
  it('cannot carry the previous species’ artwork into a locked one', async () => {
    collectionHandlers();
    const watcher = watchImageSources();

    // Start on a species the player owns, whose hero is genuinely unlocked.
    renderRoutes({ routes, initialEntries: [`/encyclopedia/${KNOWN}`] });
    await screen.findByRole('heading', { level: 1, name: 'Known Species' });
    await waitFor(() =>
      expect(currentImageSources().some((src) => artworkRouteFor(KNOWN).test(src))).toBe(true),
    );

    // Follow the rail to a species they have not discovered.
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /\?\?\?/ }));

    await screen.findByRole('heading', { level: 1, name: '???' });
    expect(screen.getByText('Not yet discovered')).toBeInTheDocument();

    const everSeen = watcher.stop();
    expect(everSeen.some((src) => artworkRouteFor(UNKNOWN).test(src))).toBe(false);
  });
});

// ── 6. A cached overlay that is not this player's ───────────────────────────

describe('a cached overlay belonging to someone else', () => {
  it('cannot authorize anything, even though the query reads as settled', async () => {
    // This is the shape `placeholderData: keepPreviousData` produces the
    // instant the session's player changes: the previous trainer's dex, served
    // under the new player's key, with `status: 'success'` and `isPending`
    // false. Before the summary carried a `playerId`, every consumer read it as
    // an authoritative answer about the *current* player.
    collectionHandlers();
    const { client } = renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    await screen.findByText('Known Species');
    const mine = client.getQueryData<OwnedSlugSummary>(OWNED_SLUGS_KEY)!;
    expect(mine.playerId).toBe(fixtures.PLAYER_ID);

    const watcher = watchImageSources();
    act(() => {
      // Same slugs, same counts — only the owner differs. A summary that says
      // "somebody owns these" must not be read as "you own these".
      client.setQueryData<OwnedSlugSummary>(OWNED_SLUGS_KEY, {
        ...mine,
        playerId: fixtures.PLAYER_ID + 1,
      });
    });

    // Everything reverts to locked, including the species the player really
    // does own: that is the acceptable direction of failure.
    await waitFor(() => expect(screen.queryByText('Known Species')).toBeNull());
    for (const slug of [KNOWN, UNKNOWN]) {
      expect(currentImageSources().some((src) => artworkRouteFor(slug).test(src))).toBe(false);
    }
    watcher.stop();
  });

  it('does not let one species’ authorization stand in for another’s', async () => {
    // The overlay is the *only* input, and it is consulted per slug. A rail
    // holding one authorized tile must not widen that to its neighbours.
    collectionHandlers();
    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    await screen.findByText('Known Species');
    const sources = currentImageSources();
    expect(sources.some((src) => artworkRouteFor(KNOWN).test(src))).toBe(true);
    expect(sources.some((src) => artworkRouteFor(UNKNOWN).test(src))).toBe(false);
  });
});

// ── A walk that never answers ───────────────────────────────────────────────

describe('when the ownership walk fails outright', () => {
  it('locks everything rather than stalling the page on a skeleton', async () => {
    // "Unknown" means *keep waiting*, and a page that keeps waiting shows a
    // skeleton. A failed walk is never going to answer, so it has to settle —
    // and the only safe value to settle on is "nothing is authorized".
    collectionHandlers();
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );
    const watcher = watchImageSources();

    renderRoutes({ routes, initialEntries: ['/encyclopedia'] });

    // The grid renders, from the catalog alone, with every entry locked.
    const locked = await screen.findAllByText('???');
    expect(locked.length).toBe(CONTENT.length);
    expect(screen.queryByLabelText('Loading the encyclopedia')).toBeNull();
    expect(screen.getByText(`0 / ${CONTENT.length} discovered`)).toBeInTheDocument();

    const everSeen = watcher.stop();
    for (const slug of [SUBJECT, KNOWN, UNKNOWN]) {
      expect(everSeen.some((src) => artworkRouteFor(slug).test(src))).toBe(false);
    }
  });
});

// ── 8. The unlocked paths still work ────────────────────────────────────────

describe('unlocked artwork is unaffected', () => {
  it('still renders an owned copy’s own appearance through the authenticated route', async () => {
    collectionHandlers();
    renderRoutes({ routes, initialEntries: [`/collection/${SUBJECT_WAIFU}`] });

    await screen.findByRole('heading', { level: 1, name: 'Subject Species' });
    await waitFor(() =>
      expect(
        currentImageSources().some((src) =>
          src.includes(`/collection/owned/${SUBJECT_WAIFU}/artwork`),
        ),
      ).toBe(true),
    );
  });

  it('still reveals a discovered species’ base artwork on its encyclopedia entry', async () => {
    collectionHandlers();
    renderRoutes({ routes, initialEntries: [`/encyclopedia/${KNOWN}`] });

    await screen.findByRole('heading', { level: 1, name: 'Known Species' });
    await waitFor(() =>
      expect(currentImageSources().some((src) => artworkRouteFor(KNOWN).test(src))).toBe(true),
    );
    // And the lore that rides with it, so the reveal is the whole entry rather
    // than just the picture.
    expect(screen.getByText(/Everything the encyclopedia knows about Known Species/)).toBeVisible();
  });
});
