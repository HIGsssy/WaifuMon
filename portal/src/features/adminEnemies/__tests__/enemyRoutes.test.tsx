/**
 * Where the Enemy pages live: the real route table's `/admin/enemies` routes
 * and their permissions, the old Enemy Artwork path redirecting to the list,
 * and the navigation entry between Dungeons and Boss Management.
 */
import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import * as dungeonApi from '@/api/adminDungeons';
import * as api from '@/api/adminEnemies';
import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

import { enemyDetailFixture } from './enemyFixtures';

/** Every route of the real table, flattened: layout routes contribute their children. */
function flatten(table: RouteObject[]): RouteObject[] {
  return table.flatMap((route) =>
    route.path === undefined && route.children ? flatten(route.children) : [route],
  );
}
/** The admin routes exactly as the app registers them, without the shell and the session guard. */
const ADMIN_ROUTES = flatten(routes).filter((route) => route.path?.startsWith('admin/'));

function Routed() {
  return useRoutes(ADMIN_ROUTES);
}

function renderAt(path: string, permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
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

const DRONE = enemyDetailFixture({ key: 'scrapyard_drone', name: 'Scrapyard Drone' });

beforeEach(() => {
  stubObjectUrls();
  vi.spyOn(api, 'listEnemies').mockResolvedValue({ enemies: [DRONE] });
  vi.spyOn(api, 'getEnemy').mockResolvedValue(DRONE);
  vi.spyOn(dungeonApi, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
  vi.spyOn(artworkApi, 'artworkAssetBlob').mockImplementation(async () => new Blob(['asset']));
});
afterEach(() => vi.restoreAllMocks());

describe('enemy routes', () => {
  it('redirects the old Enemy Artwork page to the Enemies list', async () => {
    renderAt('/admin/dungeons/enemies', ['enemies.read', 'dungeons.read']);
    expect(await screen.findByRole('heading', { name: 'Enemies' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Scrapyard Drone' })).toHaveAttribute(
      'href',
      '/admin/enemies/scrapyard_drone',
    );
  });

  it('serves the list and the editor to `enemies.read`, the editor read-only', async () => {
    renderAt('/admin/enemies/scrapyard_drone', ['enemies.read']);
    expect(
      await screen.findByRole('heading', { name: 'Enemy — Scrapyard Drone' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Enemy name')).toBeDisabled();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
  });

  it('keeps `new` for the creation page, and gates it on `enemies.write`', async () => {
    renderAt('/admin/enemies/new', ['enemies.read', 'enemies.write']);
    expect(await screen.findByRole('heading', { name: 'New enemy' })).toBeInTheDocument();
    // It is the creation page, not an editor for an enemy called "new".
    expect(api.getEnemy).not.toHaveBeenCalled();
  });

  it('shows the not-found page for the creation page without `enemies.write`', async () => {
    renderAt('/admin/enemies/new', ['enemies.read']);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(screen.queryByTestId('enemy-create')).not.toBeInTheDocument();
  });

  it('does not open the Enemies pages to a dungeon-only admin', async () => {
    renderAt('/admin/enemies', ['dungeons.read', 'dungeons.write']);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(api.listEnemies).not.toHaveBeenCalled();
  });
});

describe('navigation', () => {
  it('lists Enemies between Dungeons and Boss Management, for `enemies.read`', () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    const at = labels.indexOf('Admin — Enemies');
    expect(labels[at - 1]).toBe('Admin — Dungeons');
    expect(labels[at + 1]).toBe('Admin — Boss Management');
    expect(NAV_ITEMS[at]).toMatchObject({
      to: '/admin/enemies',
      requiresPermission: 'enemies.read',
    });
  });
});
