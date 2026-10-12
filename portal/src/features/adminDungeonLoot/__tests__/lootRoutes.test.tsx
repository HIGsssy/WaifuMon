import { Suspense, type ReactNode } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';
import * as loot from '@/api/adminDungeonLootTables';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { install as installDungeons } from '@/features/adminDungeons/__tests__/dungeonFixtures';
import { install } from './lootFixtures';

const flatten = (table: RouteObject[]): RouteObject[] =>
  table.flatMap((r) => (r.path === undefined && r.children ? flatten(r.children) : [r]));
const admin = flatten(routes).filter((r) => r.path?.startsWith('admin/'));
function Routed() {
  return useRoutes(admin);
}
function at(path: string, permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, permissions },
    error: null,
  } as unknown as SessionState;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={<p>Loading route…</p>}>{children}</Suspense>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  render(<Routed />, { wrapper });
}
beforeEach(() => {
  installDungeons();
  install();
});

it('is reached from the dungeon list', async () => {
  const user = userEvent.setup();
  at('/admin/dungeons', ['dungeons.read']);
  await user.click(await screen.findByRole('link', { name: 'Dungeon Loot Tables' }));
  expect(await screen.findByRole('heading', { name: 'Dungeon Loot Tables' })).toBeVisible();
  expect(await screen.findByRole('link', { name: 'Tunnel Cache' })).toBeVisible();
});
it('lets a reader open a table but not the create page', async () => {
  at('/admin/dungeons/loot/tunnel_cache', ['dungeons.read']);
  expect(await screen.findByRole('heading', { name: 'Loot table — Tunnel Cache' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Save table' })).not.toBeInTheDocument();
});
it('protects creation with write permission and never reads "new" as a table', async () => {
  at('/admin/dungeons/loot/new', ['dungeons.read']);
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(loot.getDungeonLootTable).not.toHaveBeenCalled();
});
it('serves the create page to a writer', async () => {
  at('/admin/dungeons/loot/new', ['dungeons.read', 'dungeons.write']);
  expect(await screen.findByRole('heading', { name: 'New loot table' })).toBeVisible();
  expect(loot.getDungeonLootTable).not.toHaveBeenCalled();
});
it.each(['/admin/dungeons/loot', '/admin/dungeons/loot/tunnel_cache'])(
  'protects %s with dungeon read permission; reward-table access is not enough',
  async (path) => {
    at(path, ['rewards.read', 'rewards.write']);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(loot.listDungeonLootTables).not.toHaveBeenCalled();
    expect(loot.getDungeonLootTable).not.toHaveBeenCalled();
  },
);
