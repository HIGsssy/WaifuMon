/**
 * Where the Boss Management pages live: the real route table's `/admin/bosses`
 * routes and their permissions, and the navigation entry beside Enemies.
 */
import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';

import { NAV_ITEMS } from '@/app/navigation';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { bossFixture, installBossApi, type BossApi } from './bossFixtures';

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

let boss: BossApi;
beforeEach(() => {
  boss = installBossApi([bossFixture({ id: 'iron_matron', name: 'Iron Matron' })]);
});
afterEach(() => vi.restoreAllMocks());

describe('boss routes', () => {
  it('serves the list to `bosses.read`', async () => {
    renderAt('/admin/bosses', ['bosses.read']);
    expect(await screen.findByRole('heading', { name: 'Boss Management' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Iron Matron' })).toHaveAttribute(
      'href',
      '/admin/bosses/iron_matron',
    );
  });

  it('serves the editor to `bosses.read`, read-only', async () => {
    renderAt('/admin/bosses/iron_matron', ['bosses.read']);
    expect(await screen.findByRole('heading', { name: 'Boss — Iron Matron' })).toBeInTheDocument();
    expect(screen.getByLabelText('Boss name')).toBeDisabled();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
  });

  it('keeps `new` for the creation page, and gates it on `bosses.write`', async () => {
    renderAt('/admin/bosses/new', ['bosses.read', 'bosses.write']);
    expect(await screen.findByRole('heading', { name: 'New boss' })).toBeInTheDocument();
    // It is the creation page, not an editor for a boss called "new".
    expect(boss.get).not.toHaveBeenCalled();
  });

  it('shows the not-found page for the creation page without `bosses.write`', async () => {
    renderAt('/admin/bosses/new', ['bosses.read']);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Boss id')).not.toBeInTheDocument();
  });

  it('keeps `activity` for the Activity page, served to `bosses.read` without the mutating actions', async () => {
    renderAt('/admin/bosses/activity', ['bosses.read']);
    expect(await screen.findByRole('heading', { name: 'Boss Activity' })).toBeInTheDocument();
    expect(boss.get).not.toHaveBeenCalled();
    expect(await screen.findByTestId('boss-scheduler')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Spawn Now' })).not.toBeInTheDocument();
  });

  it.each([
    '/admin/bosses',
    '/admin/bosses/iron_matron',
    '/admin/bosses/activity',
    '/admin/bosses/new',
  ])('does not open %s without `bosses.read`', async (path) => {
    // Another section's permissions do not open it.
    renderAt(path, ['enemies.read', 'enemies.write', 'rewards.read', 'dungeons.read']);
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
    expect(boss.list).not.toHaveBeenCalled();
    expect(boss.get).not.toHaveBeenCalled();
    expect(boss.activity).not.toHaveBeenCalled();
    expect(boss.diagnostics).not.toHaveBeenCalled();
  });
});

describe('navigation', () => {
  it('lists Boss Management right after Enemies, for `bosses.read`', () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    const at = labels.indexOf('Admin — Boss Management');
    expect(labels[at - 1]).toBe('Admin — Enemies');
    expect(labels[at + 1]).toBe('Admin — Artwork Assets');
    expect(NAV_ITEMS[at]).toMatchObject({
      to: '/admin/bosses',
      requiresPermission: 'bosses.read',
    });
  });
});
