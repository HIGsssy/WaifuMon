/**
 * Whose ownership unlocks what — the regression suite for the public
 * Collection leak.
 *
 * **The bug.** `/players/:id/collection` and `/players/:id/collection/:waifuId`
 * reuse the same `WaifumonCard` / `WaifumonHero` / `WaifumonDetail` components
 * the viewer's own collection uses. Those were written under a premise that is
 * true in `self` mode and false in `public` mode:
 *
 *     the copy is in this collection, therefore the viewer has unlocked the
 *     species
 *
 * In public mode the collection is somebody else's. Alice owning a Void Empress
 * is what puts the tile on screen; it is not a reason for Bob to learn her
 * artwork, name, type, affinity, content rating, lore, tags, worn look or Buddy
 * Bonus. The Portal showed him all of it.
 *
 * **The rule these tests defend** is the one the Encyclopedia and the related
 * species rail already apply, unchanged and asked about the viewer:
 *
 *     species knowledge is revealed  ⟺  *the viewer* owns an active copy
 *
 * What is deliberately *not* gated is instance information the public profile
 * exists to publish: that the trainer owns her, her level, her nickname, her
 * favourite and buddy status, and the day she was caught. Hiding those would
 * break the feature rather than fix it, and several tests below assert they
 * survive.
 *
 * The API half — the public owned-artwork route refusing the bytes, and the
 * payload arriving with `assetId: null` — lives in
 * `tests/integration/api/playerDirectory.test.ts`.
 */
import { screen, within } from '@testing-library/react';
import { http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ContentSpecies,
  OwnedEntry,
  PublicOwnedEntry,
  Race,
  Rarity,
  Species,
} from '@/api/types';
import { routes } from '@/app/router';
import { setImageProviderChain } from '@/images/provider';
import { createArtworkApiProvider } from '@/images/providers/artworkApi';
import { createSilhouetteProvider } from '@/images/providers/silhouette';
import { renderRoutes } from '@/test/renderWithProviders';
import * as fixtures from '../../../msw/fixtures';
import { data, page } from '../../../msw/handlers';
import { server } from '../../../msw/server';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The trainer being viewed. Never the session's own player. */
const OWNER = 42;

/**
 * One archetype for both, so each appears in the other's related-species rail
 * and the rail's own gating is exercised by the same fixtures.
 */
const ARCHETYPE = 'spirit';

/** A species the viewer owns, and one only the owner does. */
const SHARED = 'gate_shared';
const ALIEN = 'gate_alien';

const SHARED_COPY = 701;
const ALIEN_COPY = 702;
const VIEWER_COPY = 801;

function speciesRow(id: number, slug: string, name: string, rarity: Rarity): Species {
  return {
    id,
    slug,
    name,
    rarity,
    archetype: ARCHETYPE,
    race: ARCHETYPE as Race,
    affinity: 'submissive',
    contentRating: 'explicit',
    description: `Everything the encyclopedia knows about ${name}.`,
    tags: [],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances: [fixtures.standardAppearance(slug)],
  };
}

const SHARED_ROW = speciesRow(911, SHARED, 'Shared Species', 'SR');
const ALIEN_ROW = speciesRow(912, ALIEN, 'Alien Species', 'UR');

function contentOf(row: Species): ContentSpecies {
  const { id: _id, ...rest } = row;
  return rest;
}

/** The Buddy Bonus is authored content and rides on the snapshot, not the row. */
const CONTENT: ContentSpecies[] = [
  contentOf(SHARED_ROW),
  {
    ...contentOf(ALIEN_ROW),
    buddyBonus: {
      name: 'Void Communion',
      flavorText: 'She whispers the odds into your ear.',
      effectId: 'capture_chance',
      value: 10,
      target: null,
      targetLabel: null,
      effectSummary: '+10% capture chance',
    },
  },
];

function publicCopy(
  waifuId: number,
  row: Species,
  extra: { nickname: string | null; level: number; isFavorite: boolean; isBuddy?: boolean },
): PublicOwnedEntry {
  return {
    waifu: {
      id: waifuId,
      playerId: OWNER,
      level: extra.level,
      nickname: extra.nickname,
      isFavorite: extra.isFavorite,
      variant: 'standard',
      selectedAppearance: {
        ...fixtures.standardAppearance(row.slug),
        name: 'Midnight Gala',
        isUnlocked: true,
        isSelected: true,
      },
      caughtAt: '2026-05-11',
    },
    species: row,
    isBuddy: extra.isBuddy ?? false,
  };
}

/**
 * The owner's collection: one species the viewer also owns, one they do not —
 * and the alien copy carries no nickname, so the tile has nothing but the
 * species name to title itself with. That is exactly the case that used to
 * print it.
 */
const OWNER_COLLECTION: PublicOwnedEntry[] = [
  publicCopy(SHARED_COPY, SHARED_ROW, { nickname: 'Sage', level: 12, isFavorite: false }),
  publicCopy(ALIEN_COPY, ALIEN_ROW, {
    nickname: null,
    level: 40,
    isFavorite: true,
    isBuddy: true,
  }),
];

/** The viewer's own collection — `SHARED` only. This is their whole dex. */
function viewerCollection(): OwnedEntry[] {
  return [
    {
      waifu: {
        id: VIEWER_COPY,
        playerId: fixtures.PLAYER_ID,
        speciesId: SHARED_ROW.id,
        level: 7,
        xp: 300,
        affection: 20,
        nickname: null,
        isFavorite: false,
        variant: 'standard',
        cosmetics: [],
        selectedAppearance: {
          ...fixtures.standardAppearance(SHARED),
          isUnlocked: true,
          isSelected: true,
        },
        caughtAt: '2026-07-02T18:30:00.000Z',
        releasedAt: null,
      },
      species: SHARED_ROW,
      progress: { level: 7, xp: 300, xpIntoLevel: 40, xpToNext: 80, atMaxLevel: false },
    },
  ];
}

/**
 * `owns` names the species the *viewer* has. What the owner has never varies:
 * the whole point is that it cannot move the viewer's line.
 */
function handlers(owns: readonly string[]): void {
  const mine = viewerCollection().filter((entry) => owns.includes(entry.species.slug));
  server.use(
    http.get('/api/v1/content/species', () => data(CONTENT)),
    http.get('/api/v1/content/species/:slug', ({ params }) =>
      data(CONTENT.find((entry) => entry.slug === params.slug)),
    ),
    http.get('/api/v1/players/:playerId/collection/stats', () =>
      data({ owned: mine.length, distinctSpecies: mine.length, totalSpecies: CONTENT.length }),
    ),
    http.get('/api/v1/players/:playerId/collection/owned', () => page(mine)),
    http.get('/api/v1/players/:playerId/collection/owned/:waifuId', ({ params }) =>
      data(mine.find((entry) => String(entry.waifu.id) === params.waifuId)),
    ),
    http.get('/api/v1/players/:playerId/collection/buddy', () => data(null)),
    http.get('/api/v1/players/:playerId/public', ({ params }) =>
      data({ ...fixtures.publicProfile, id: Number(params.playerId), displayName: 'Aiko' }),
    ),
    http.get('/api/v1/players/:playerId/public/collection', () => page(OWNER_COLLECTION)),
    http.get('/api/v1/players/:playerId/public/collection/:waifuId', ({ params }) =>
      data(OWNER_COLLECTION.find((entry) => String(entry.waifu.id) === params.waifuId)),
    ),
  );
}

/** Every tile or hero currently showing the locked treatment. */
function silhouettes(): HTMLElement[] {
  return screen.queryAllByAltText('Undiscovered Waifumon silhouette');
}

beforeEach(() => {
  // Two providers only, so a `src` is either real artwork or the silhouette.
  setImageProviderChain([createArtworkApiProvider(), createSilhouetteProvider()]);
});

// ── 1. The viewer owns it: nothing changes ──────────────────────────────────

describe('a species the viewer owns, seen in another trainer’s collection', () => {
  it('shows everything the viewer has already unlocked', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${SHARED_COPY}`] });

    expect(await screen.findByRole('heading', { name: 'Sage', level: 1 })).toBeInTheDocument();
    // The species name as the subtitle under the owner's nickname, the lore and
    // the pills — all of it, because this viewer has met her.
    expect(await screen.findByText('Shared Species')).toBeInTheDocument();
    expect(
      screen.getByText('Everything the encyclopedia knows about Shared Species.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Submissive')).toBeInTheDocument();
    expect(screen.getByAltText(/Shared Species/)).toBeInTheDocument();
  });
});

// ── 2 & 3. The owner owns it and the viewer does not ────────────────────────

describe('a species only the profile owner owns', () => {
  it('withholds the artwork, the name and the species metadata', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${ALIEN_COPY}`] });

    // The page renders — the copy is legitimately public — but as a locked
    // entry, in the same words the Encyclopedia uses.
    expect(await screen.findByText(/not currently owned/i)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: '???', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Alien Species')).toBeNull();
    expect(screen.queryByText('Everything the encyclopedia knows about Alien Species.')).toBeNull();
    // Type, affinity and content rating are encyclopedia facts, not this
    // trainer's to disclose.
    expect(screen.queryByText('Affinity:')).toBeNull();
    expect(screen.queryByText('Type:')).toBeNull();
    // The Buddy Bonus is authored lore as much as it is a rule.
    expect(screen.queryByText('Void Communion')).toBeNull();
    // So is the name of the look she is wearing.
    expect(screen.queryByText('Midnight Gala')).toBeNull();
    expect(silhouettes().length).toBeGreaterThan(0);
  });

  it('never requests her artwork, by any route', async () => {
    handlers([SHARED]);
    const requested: string[] = [];
    server.events.on('request:start', ({ request }) => {
      requested.push(new URL(request.url, 'http://localhost').pathname);
    });

    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${ALIEN_COPY}`] });
    await screen.findByText(/not currently owned/i);

    // Neither the public owned-artwork route — which the server now refuses for
    // an undiscovered species — nor the slug route, which always did.
    expect(requested).not.toContain(
      `/api/v1/players/${OWNER}/public/collection/${ALIEN_COPY}/artwork`,
    );
    expect(requested).not.toContain(`/api/v1/assets/waifumon/${ALIEN}`);
  });

  it('keeps the real name out of the accessibility tree as well as the pixels', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${ALIEN_COPY}`] });

    await screen.findByText(/not currently owned/i);
    expect(screen.queryByAltText(/Alien Species/)).toBeNull();
  });

  it('locks the grid tile too, with no nickname to fall back on', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection`] });

    // The owner's other copy has resolved, so the overlay has certainly
    // answered by the time these assertions run.
    expect(await screen.findByText('Sage')).toBeInTheDocument();
    expect(screen.getByText('???')).toBeInTheDocument();
    expect(screen.queryByText('Alien Species')).toBeNull();
    expect(silhouettes().length).toBeGreaterThan(0);
  });

  it('is not unlocked by the owner owning several copies', async () => {
    // The same species twice in the owner's collection. Ownership is theirs
    // however many copies it is, and none of them is the viewer's.
    handlers([SHARED]);
    server.use(
      http.get('/api/v1/players/:playerId/public/collection', () =>
        page([
          ...OWNER_COLLECTION,
          publicCopy(703, ALIEN_ROW, { nickname: null, level: 5, isFavorite: false }),
        ]),
      ),
    );
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection`] });

    await screen.findByText('Sage');
    expect(screen.queryByText('Alien Species')).toBeNull();
    expect(screen.getAllByText('???')).toHaveLength(2);
  });
});

// ── 4. Direct navigation, no grid in between ────────────────────────────────

describe('direct navigation to the details route', () => {
  it('is gated exactly as the grid path is', async () => {
    handlers([SHARED]);
    // Straight to the copy's URL — no public collection page visited first, so
    // nothing can be relying on state the grid happened to leave behind.
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${ALIEN_COPY}`] });

    expect(await screen.findByText(/not currently owned/i)).toBeInTheDocument();
    expect(screen.queryByText('Alien Species')).toBeNull();
  });

  it('stays locked when the viewer owns nothing at all', async () => {
    handlers([]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${SHARED_COPY}`] });

    // Even the species the other tests unlock: an empty dex unlocks nothing,
    // and the owner's nickname is all that is left to identify her by.
    expect(await screen.findByText(/not currently owned/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sage', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Shared Species')).toBeNull();
  });
});

// ── 6. The related-species rail keeps its own gate ──────────────────────────

describe('the related-species rail on a public copy', () => {
  it('silhouettes a neighbour the viewer has not discovered', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${SHARED_COPY}`] });

    await screen.findByRole('heading', { name: 'Sage', level: 1 });
    // `ALIEN` shares the archetype, so it is in the rail — as `???`.
    const rail = (await screen.findByText('Related species')).closest('section') as HTMLElement;
    expect(within(rail).getByText('???')).toBeInTheDocument();
    expect(within(rail).queryByText('Alien Species')).toBeNull();
  });
});

// ── 7 & 8. What the gate must leave alone ───────────────────────────────────

describe('what the gate must leave alone', () => {
  it('still publishes the public instance facts for a locked species', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/players/${OWNER}/collection/${ALIEN_COPY}`] });

    await screen.findByText(/not currently owned/i);
    // That this trainer owns her, her level, her badges and her capture day are
    // the public profile working as intended. Rarity stays too — it is the
    // hook, and an unowned encyclopedia entry shows it as well.
    expect(screen.getByText('Level 40')).toBeInTheDocument();
    expect(screen.getByText('Favourite')).toBeInTheDocument();
    expect(screen.getByText('Their buddy')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.getAllByText(/ultra rare/i).length).toBeGreaterThan(0);
  });

  it('leaves the viewer’s own collection completely unchanged', async () => {
    handlers([SHARED]);
    renderRoutes({ routes, initialEntries: [`/collection/${VIEWER_COPY}`] });

    // Self mode asks no dex question — the copy is the proof — so everything
    // renders: the species name, the lore and the real artwork.
    expect(
      await screen.findByRole('heading', { name: 'Shared Species', level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Everything the encyclopedia knows about Shared Species.'),
    ).toBeInTheDocument();
    expect(screen.getByAltText(/Shared Species/)).toBeInTheDocument();
    expect(screen.queryByText(/not currently owned/i)).toBeNull();
  });
});
