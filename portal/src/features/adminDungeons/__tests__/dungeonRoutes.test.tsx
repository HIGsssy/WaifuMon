import { Suspense, type ReactNode } from 'react';
import { beforeEach, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';
import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { install } from './dungeonFixtures';
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
beforeEach(() => install());
it.each(['/admin/dungeons/definitions/tunnels', '/admin/dungeons/zones/tunnels'])(
  'serves management at %s',
  async (path) => {
    at(path, ['dungeons.read']);
    expect(await screen.findByText('Draft metadata')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  },
);
it('redirects the old generation preview to dungeon management', async () => {
  at('/admin/dungeons/preview', ['dungeons.read']);
  expect(await screen.findByRole('heading', { name: 'Dungeons' })).toBeInTheDocument();
  expect(screen.queryByText('Generate preview')).not.toBeInTheDocument();
});
it.each(['/admin/dungeons', '/admin/dungeons/definitions/tunnels'])(
  'protects %s with dungeon read permission',
  async (path) => {
    at(path, []);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Dungeon name')).not.toBeInTheDocument();
  },
);
it('protects draft creation with write permission', async () => {
  at('/admin/dungeons/new', ['dungeons.read']);
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
});
