/**
 * Where Region Pools live: the real route table's `/admin/region-pools`
 * routes behind `regions.read`, and the navigation entry gated the same way.
 */
import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';

import * as api from '@/api/adminRegionPools';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { CATALOGUE, LIST, analysis, poolView } from './regionPoolFixtures';

function flatten(table: RouteObject[]): RouteObject[] {
  return table.flatMap((route) =>
    route.path === undefined && route.children ? flatten(route.children) : [route],
  );
}
const ADMIN_ROUTES = flatten(routes).filter((route) => route.path?.startsWith('admin/'));

function Routed() {
  return useRoutes(ADMIN_ROUTES);
}

function renderAt(path: string, permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Admin', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={<p>Loading page…</p>}>{children}</Suspense>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  render(<Routed />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.spyOn(api, 'listRegionPools').mockResolvedValue({ regions: LIST });
  vi.spyOn(api, 'getRegionPool').mockResolvedValue(poolView());
  vi.spyOn(api, 'getRegionPoolSpecies').mockResolvedValue({ species: CATALOGUE });
  vi.spyOn(api, 'analyseRegionPool').mockResolvedValue(analysis());
  vi.spyOn(api, 'regionSpeciesArtworkBlob').mockRejectedValue(new Error('no artwork in this test'));
  vi.spyOn(api, 'getRegionPoolDrift').mockResolvedValue({
    status: 'clean',
    publishedRevision: 2,
    species: [],
    exclusiveConflicts: [],
    emptyTiers: [],
    shipped: { available: true, differs: false, diff: null },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('region pool routes', () => {
  it('serves the overview and the editor to `regions.read`', async () => {
    renderAt('/admin/region-pools', ['regions.read']);
    expect(await screen.findByRole('heading', { name: 'Region Pools' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Twin Peeks' })).toHaveAttribute(
      'href',
      '/admin/region-pools/twin-peeks',
    );
  });

  it('opens the editor by region id', async () => {
    renderAt('/admin/region-pools/twin-peeks', ['regions.read']);
    expect(
      await screen.findByRole('heading', { name: 'Region Pool — Twin Peeks' }),
    ).toBeInTheDocument();
  });

  it('hides the pages from a session without `regions.read`', async () => {
    renderAt('/admin/region-pools', ['regions.write', 'regions.publish', 'dungeons.read']);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(api.listRegionPools).not.toHaveBeenCalled();
  });

  it('adds a navigation entry gated on `regions.read`', () => {
    const entry = NAV_ITEMS.find((item) => item.to === '/admin/region-pools');
    expect(entry).toMatchObject({
      label: 'Admin — Region Pools',
      requiresPermission: 'regions.read',
    });
  });
});
