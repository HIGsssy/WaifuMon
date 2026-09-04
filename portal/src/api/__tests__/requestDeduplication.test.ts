/**
 * Startup request budget.
 *
 * React Query deduplicates by query key, which does nothing about two different
 * endpoints returning the same row. `/players/{id}` (the session) and
 * `/players/{id}/profile` (the dashboard) both carry the player, so the Portal
 * used to fetch it twice on every dashboard load and again on every window
 * focus. These tests count actual HTTP calls rather than inspecting the cache,
 * because the number of round trips is the thing that was wrong.
 */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import * as fixtures from '../../../msw/fixtures';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { queryKeys } from '@/api/queryKeys';
import { renderRoutes } from '@/test/renderWithProviders';

/** Counts requests per path for the rest of the test. */
function countRequests(): Map<string, number> {
  const counts = new Map<string, number>();
  server.events.on('request:start', ({ request }) => {
    const path = new URL(request.url).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return counts;
}

afterEach(() => {
  // `resetHandlers` does not touch event listeners, and a counter left attached
  // would keep tallying another test's traffic.
  server.events.removeAllListeners();
});

/** The dashboard has painted *and* its player data has landed. */
async function dashboardReady(): Promise<void> {
  await screen.findByRole('heading', { name: 'Dashboard' });
  await waitFor(() => expect(screen.getByText('Level 12')).toBeInTheDocument());
}

describe('dashboard startup requests', () => {
  it('fetches the player record once, not once per endpoint that returns it', async () => {
    const counts = countRequests();

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    expect(counts.get('/api/v1/players/1')).toBe(1);
    expect(counts.get('/api/v1/players/1/profile')).toBe(1);
  });

  it('writes the profile’s player back into the session’s cache entry', async () => {
    // This is what makes the single fetch above hold: the session's query is
    // kept fresh by the dashboard's response instead of going back to the API.
    const { client } = renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    await waitFor(() => {
      expect(client.getQueryData(queryKeys.playerRecord(fixtures.PLAYER_ID))).toMatchObject({
        id: fixtures.PLAYER_ID,
      });
    });
  });

  /**
   * The strip is one request whatever the collection's size. Before the API
   * grew `sort=newest`, page 1 was the *rarest* twenty-five copies, so the only
   * way to find the newest five was to read every page — which would have made
   * this count grow with the player's collection.
   */
  it('reads the recent catches in a single listing request', async () => {
    const counts = countRequests();

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    expect(counts.get('/api/v1/players/1/collection/owned')).toBe(1);
  });

  it('does not fetch the species catalogue as part of first paint', async () => {
    // It is still prefetched for the Collection and Encyclopedia, but on idle —
    // no dashboard widget reads it, and on a slow link it was a fourth request
    // competing with the three that first paint waits on.
    const counts = countRequests();

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    expect(counts.get('/api/v1/content/species')).toBeUndefined();
  });

  it('keeps the whole dashboard boot inside a small, known request budget', async () => {
    const counts = countRequests();

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    // lookup → player → (profile, buddy, stats, recent). A regression that
    // reintroduces a duplicate or an eager prefetch pushes past this — and so
    // would a recent-catches strip that walked the collection instead of asking
    // for one newest-first page.
    expect(total).toBeLessThanOrEqual(6);
  });

  it('serves a second mount from cache, inside the stale window', async () => {
    const { client } = renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await dashboardReady();

    const counts = countRequests();
    renderRoutes({ routes, initialEntries: ['/dashboard'], client });
    await screen.findAllByRole('heading', { name: 'Dashboard' });

    expect([...counts.values()]).toEqual([]);
  });
});
