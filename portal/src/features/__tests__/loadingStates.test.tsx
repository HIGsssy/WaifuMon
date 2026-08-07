/**
 * The loading-state sweep (plan §14, §21 Phase 3, §24.9).
 *
 * One rule, checked on every page that fetches: **while data is in flight the
 * page shows a skeleton matched to its final layout, and never a spinner.**
 *
 * Each case holds its responses open with `delay()` so the loading state is
 * genuinely observable, then asserts three things:
 *
 *   1. the page frame is already painted — §14's "never replace an entire page
 *      with a loading indicator"
 *   2. at least one skeleton is present
 *   3. no `role="progressbar"`-style spinner and no "Loading…" text stands in
 *      for the content
 *
 * Together with the per-page suites, this is what makes §24.9 true: every page
 * has loading, success, empty and error exercised somewhere in the suite.
 */
import { screen } from '@testing-library/react';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data, page as pageEnvelope } from '../../../msw/handlers';
import * as fixtures from '../../../msw/fixtures';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

/** Every skeleton in the Portal carries the `.skeleton` class. */
function skeletonCount(): number {
  return document.querySelectorAll('.skeleton').length;
}

/** Nothing in the Portal is allowed to render a spinner (§14). */
function expectNoSpinner(): void {
  expect(screen.queryByRole('progressbar', { name: /loading/i })).toBeNull();
  expect(screen.queryByText(/^loading\.\.\.$/i)).toBeNull();
  expect(screen.queryByText(/please wait/i)).toBeNull();
}

/** Holds a response open long enough for the loading state to be asserted. */
function slow<T>(path: string, body: T) {
  return http.get(path, async () => {
    await delay(150);
    return data(body);
  });
}

interface Case {
  name: string;
  url: string;
  heading: string;
  handlers: ReturnType<typeof http.get>[];
  /** Text that proves the page finished loading. */
  settled: string | RegExp;
}

const CASES: Case[] = [
  {
    name: 'Dashboard',
    url: '/dashboard',
    heading: 'Dashboard',
    handlers: [
      slow('/api/v1/players/:playerId/profile', {
        player: fixtures.player,
        currencies: fixtures.currencies,
      }),
      slow('/api/v1/players/:playerId/collection/stats', fixtures.dexStats),
    ],
    settled: 'Level 12',
  },
  {
    name: 'Collection',
    url: '/collection',
    heading: 'Collection',
    handlers: [
      http.get('/api/v1/players/:playerId/collection/owned', async () => {
        await delay(150);
        return pageEnvelope(fixtures.ownedEntries);
      }),
    ],
    settled: /Nyx/,
  },
  {
    name: 'Waifumon detail',
    url: '/collection/101',
    heading: 'Back to Collection',
    handlers: [
      slow('/api/v1/players/:playerId/collection/owned/:waifuId', fixtures.ownedEntries[0]),
    ],
    settled: 'Progression',
  },
  {
    name: 'Buddy',
    url: '/buddy',
    heading: 'Buddy',
    handlers: [
      slow('/api/v1/players/:playerId/collection/buddy', fixtures.buddyEntry),
      slow('/api/v1/players/:playerId/care', fixtures.careState),
    ],
    settled: 'Care Mode',
  },
  {
    name: 'Inventory',
    url: '/inventory',
    heading: 'Inventory',
    handlers: [slow('/api/v1/players/:playerId/inventory', fixtures.inventoryEntries)],
    settled: 'Basic Charm',
  },
  {
    name: 'Shop',
    url: '/shop',
    heading: 'Shop',
    handlers: [slow('/api/v1/shop/catalog', fixtures.shopCatalog)],
    settled: 'Basic Charm',
  },
  {
    name: 'Encyclopedia',
    url: '/encyclopedia',
    heading: 'Encyclopedia',
    handlers: [slow('/api/v1/content/species', fixtures.contentSpecies)],
    settled: 'Void Empress',
  },
  {
    name: 'Species detail',
    url: '/encyclopedia/void_empress',
    heading: 'Back to Encyclopedia',
    handlers: [slow('/api/v1/content/species/:slug', fixtures.contentSpecies[2])],
    settled: 'Your collection',
  },
  {
    name: 'Profile',
    url: '/profile',
    heading: 'Trainer Profile',
    handlers: [
      slow('/api/v1/players/:playerId/profile', {
        player: fixtures.player,
        currencies: fixtures.currencies,
      }),
      slow('/api/v1/players/:playerId/collection/stats', fixtures.dexStats),
    ],
    settled: 'Statistics',
  },
];

describe('loading states', () => {
  it.each(CASES)('$name shows skeletons, not a spinner', async (testCase) => {
    server.use(...testCase.handlers);

    renderRoutes({ routes, initialEntries: [testCase.url] });

    // The frame paints as soon as the route resolves — before any query lands.
    const frame = await screen.findByText(testCase.heading, { exact: false });
    expect(frame).toBeInTheDocument();

    expect(skeletonCount()).toBeGreaterThan(0);
    expectNoSpinner();

    // …and the skeletons give way to real content rather than persisting.
    expect(await screen.findByText(testCase.settled)).toBeInTheDocument();
  });
});

describe('empty states not covered elsewhere', () => {
  it('the encyclopedia says so when filters match nothing', async () => {
    renderRoutes({ routes, initialEntries: ['/encyclopedia?rarity=LR'] });

    // No fixture species is LR.
    expect(await screen.findByText('No species match your filters')).toBeInTheDocument();
  });

  it('the profile renders zeros for a brand-new trainer without erroring', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        data({ owned: 0, distinctSpecies: 0, totalSpecies: 58 }),
      ),
      http.get('/api/v1/players/:playerId/collection/buddy', () =>
        apiError(404, 'BUDDY_NOT_SET', 'No buddy is set.'),
      ),
    );

    renderRoutes({ routes, initialEntries: ['/profile'] });

    expect(await screen.findByText('Statistics')).toBeInTheDocument();
    expect(await screen.findByText('0%')).toBeInTheDocument();
  });
});
