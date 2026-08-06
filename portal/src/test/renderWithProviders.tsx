/**
 * Test render helper.
 *
 * Mirrors the real provider stack from `app/providers.tsx` so a component test
 * exercises the same session, theme and query wiring the app does — including
 * the `DevSessionProvider`'s real resolution call against MSW. Tests therefore
 * cover §22.3 (auth) implicitly on every page test.
 *
 * The QueryClient is per-render with retries off, so an error-path test fails
 * fast instead of waiting out a backoff.
 */
import { QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, useRoutes, type RouteObject } from 'react-router';

import { Providers } from '@/app/providers';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
    },
  });
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  client?: QueryClient;
}

/** Renders a bare component inside the provider stack — no router. */
export function renderWithProviders(
  ui: ReactElement,
  { client, ...options }: RenderWithProvidersOptions = {},
): RenderResult & { client: QueryClient } {
  const queryClient = client ?? createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Providers client={queryClient}>{children}</Providers>
  );
  return { ...render(ui, { wrapper, ...options }), client: queryClient };
}

export interface RenderRoutesOptions {
  routes: RouteObject[];
  initialEntries?: string[];
  client?: QueryClient;
}

/** Renders the route table with `useRoutes` — see the note on `renderRoutes`. */
function RoutedTree({ routes }: { routes: RouteObject[] }) {
  return useRoutes(routes);
}

/**
 * Renders a route tree at a given URL — the shape most page tests want.
 *
 * Uses `<MemoryRouter>` + `useRoutes` rather than `createMemoryRouter`, and the
 * reason is an environment quirk rather than a design choice: React Router's
 * data router builds a `Request` on every navigation, jsdom supplies the
 * `AbortController` while Node supplies `Request`, and undici rejects a signal
 * that is not its own instance. The app itself still runs on
 * `createBrowserRouter` (data mode, plan §5); these tests exercise the very
 * same `RouteObject[]`, just mounted through the declarative matcher.
 */
export function renderRoutes({
  routes,
  initialEntries = ['/'],
  client,
}: RenderRoutesOptions): RenderResult & { client: QueryClient } {
  const queryClient = client ?? createTestQueryClient();
  return {
    ...render(
      <Providers client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <RoutedTree routes={routes} />
        </MemoryRouter>
      </Providers>,
    ),
    client: queryClient,
  };
}
