/**
 * The Load Testing page against MSW.
 *
 * Pinned:
 *   - `system.loadtest.run` gates the nav entry and the route; System Metrics
 *     access alone does not show it, and without it nothing is fetched;
 *   - a server without LOAD_TESTING_ENABLED (404) reads as "disabled on this
 *     server", with no controls;
 *   - the form offers the presets, validates custom values against the
 *     server's limits before sending, and posts exactly what was chosen;
 *   - an active run shows state, progress, counts, failures, ops/sec and
 *     latency percentiles, and Stop posts to the stop route;
 *   - System Metrics is one click away, in a new tab;
 *   - recorded runs are listed for comparison.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';

import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import { NavList } from '@/components/layout/NavList';
import type { LoadTestRun, LoadTestStatus } from '@/api/adminLoadTesting';

import { apiError, data } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { LoadTestingPage } from '../LoadTestingPage';
import { validateForm } from '../format';

const PERM = ['system.loadtest.run', 'system.metrics.read'];
const STATUS_URL = '/api/v1/admin/load-testing';

function sessionState(permissions: readonly string[]): SessionState {
  const session: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Owner',
    avatarUrl: null,
    permissions,
  };
  return { status: 'ready', session, error: null, configuredPlayerId: undefined, retry: () => {} };
}

function Wrap({
  children,
  permissions = PERM,
}: {
  children: React.ReactNode;
  permissions?: readonly string[];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        <MemoryRouter initialEntries={['/admin/load-testing']}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

const LIMITS = {
  profiles: ['normal', 'portal', 'cards', 'mixed'] as const,
  concurrencyPresets: [1, 5, 10, 25, 50],
  durationPresetsSeconds: [60, 300, 600],
  maxConcurrency: 100,
  minDurationSeconds: 30,
  maxDurationSeconds: 1800,
};

function status(overrides: Partial<LoadTestStatus> = {}): LoadTestStatus {
  return {
    enabled: true,
    hostLabel: '3400GE staging',
    cardsAvailable: true,
    limits: { ...LIMITS, profiles: [...LIMITS.profiles] },
    current: null,
    last: null,
    ...overrides,
  };
}

function activeRun(overrides: Partial<LoadTestRun> = {}): LoadTestRun {
  return {
    runKey: 'lt-1',
    state: 'running',
    profile: 'mixed',
    cardMode: null,
    concurrency: 25,
    durationSeconds: 300,
    seed: 1337,
    label: null,
    resetMetricsWindow: true,
    operatorDiscordId: '1',
    requestedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endsAt: new Date().toISOString(),
    elapsedMs: 90_000,
    remainingMs: 210_000,
    error: null,
    resultId: null,
    progress: {
      phase: 'running',
      elapsedMs: 90_000,
      activePlayers: 25,
      attempted: 1234,
      completed: 1200,
      failures: { total: 7, http4xx: 1, http5xx: 4, timeout: 2, network: 0 },
      canceled: 0,
      actions: 400,
      opsPerSecond: 13.33,
      latency: {
        count: 1200,
        minMs: 1,
        meanMs: 20,
        maxMs: 900,
        p50Ms: 12.5,
        p95Ms: 180,
        p99Ms: 1450,
      },
      recent: {
        intervalMs: 1000,
        opsPerSecond: 14,
        latency: { count: 14, minMs: 1, meanMs: 9, maxMs: 40, p50Ms: 8, p95Ms: 30, p99Ms: 40 },
      },
      cards: { coldRequested: 3, coldPlanned: 60, coldExhausted: 0, notModified: 11 },
      generatorCpuPercentOfOneCore: 4.2,
    },
    ...overrides,
  };
}

let posts: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  posts = [];
});
afterEach(() => server.resetHandlers());

function serve(s: LoadTestStatus | (() => Response)) {
  server.use(
    http.get(STATUS_URL, () => (typeof s === 'function' ? s() : data(s))),
    http.get(`${STATUS_URL}/results`, () =>
      data([
        {
          id: 3,
          runKey: 'lt-0',
          status: 'completed',
          profile: 'mixed',
          cardMode: null,
          concurrency: 10,
          durationSeconds: 300,
          elapsedSeconds: 300,
          seed: 1337,
          label: 'baseline',
          hostLabel: 'Scale VM',
          operatorDiscordId: '1',
          hostInfo: { hostname: 'vm' },
          summary: {
            completed: 4000,
            failures: { total: 0, http4xx: 0, http5xx: 0, timeout: 0, network: 0 },
            opsPerSecond: 13.3,
            latency: {
              count: 4000,
              minMs: 1,
              meanMs: 9,
              maxMs: 90,
              p50Ms: 6,
              p95Ms: 40,
              p99Ms: 80,
            },
          },
          metricsStart: null,
          metricsEnd: null,
          error: null,
          startedAt: '2026-09-01T10:00:00.000Z',
          endedAt: '2026-09-01T10:05:00.000Z',
        },
      ]),
    ),
    http.post(`${STATUS_URL}/runs`, async ({ request }) => {
      posts.push({ url: request.url, body: await request.json() });
      return HttpResponse.json({ data: activeRun({ state: 'preparing' }) }, { status: 202 });
    }),
    http.post(`${STATUS_URL}/runs/current/stop`, ({ request }) => {
      posts.push({ url: request.url, body: null });
      return data(activeRun({ state: 'stopping' }));
    }),
  );
}

function findRoute(path: string): (typeof routes)[number] | undefined {
  const walk = (list: typeof routes): (typeof routes)[number] | undefined => {
    for (const r of list) {
      if (r.path === path) return r;
      const nested = r.children ? walk(r.children) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(routes);
}

describe('permission and navigation', () => {
  it('shows the nav entry with system.loadtest.run', () => {
    render(
      <Wrap>
        <NavList />
      </Wrap>,
    );
    expect(screen.getByRole('link', { name: /Admin — Load Testing/ })).toHaveAttribute(
      'href',
      '/admin/load-testing',
    );
  });

  it('hides it from a session with System Metrics but not load testing', () => {
    render(
      <Wrap permissions={['system.metrics.read', 'admin.access', 'gallery.read']}>
        <NavList />
      </Wrap>,
    );
    expect(screen.queryByRole('link', { name: /Load Testing/ })).toBeNull();
    expect(screen.getByRole('link', { name: /System Metrics/ })).toBeInTheDocument();
  });

  it('guards the route: without the permission nothing renders and nothing is fetched', async () => {
    let fetched = 0;
    server.use(
      http.get(STATUS_URL, () => {
        fetched += 1;
        return data(status());
      }),
    );
    const route = findRoute('admin/load-testing');
    expect(route).toBeDefined();
    render(<Wrap permissions={['system.metrics.read']}>{route!.element}</Wrap>);
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched).toBe(0);
  });
});

describe('a server without load testing', () => {
  it('says it is disabled and offers no controls', async () => {
    serve(() => apiError(404, 'NOT_FOUND', 'Not found.'));
    render(
      <Wrap>
        <LoadTestingPage />
      </Wrap>,
    );
    expect(await screen.findByTestId('load-testing-disabled')).toHaveTextContent(
      /disabled on this server/,
    );
    expect(screen.queryByRole('button', { name: /Start load test/ })).toBeNull();
  });
});

describe('starting a run', () => {
  it('offers presets, a link to System Metrics, and posts what was chosen', async () => {
    serve(status());
    const user = userEvent.setup();
    render(
      <Wrap>
        <LoadTestingPage idlePollMs={60_000} />
      </Wrap>,
    );
    await screen.findByRole('button', { name: /Start load test/ });
    expect(screen.getByTestId('host-label')).toHaveTextContent('3400GE staging');

    const link = screen.getByRole('link', { name: /Open System Metrics/ });
    expect(link).toHaveAttribute('href', '/admin/system');
    expect(link).toHaveAttribute('target', '_blank');

    const players = screen.getByRole('group', { name: /players presets/ });
    for (const n of ['1', '5', '10', '25', '50']) {
      expect(within(players).getByRole('button', { name: n })).toBeInTheDocument();
    }
    await user.click(within(players).getByRole('button', { name: '25' }));
    await user.click(
      within(screen.getByRole('group', { name: /Duration.*presets/ })).getByRole('button', {
        name: '10 min',
      }),
    );
    await user.click(screen.getByRole('radio', { name: /Card Rendering/ }));
    await user.click(screen.getByRole('radio', { name: /Cold \(forced renders\)/ }));
    await user.type(screen.getByPlaceholderText(/pool max/), 'after pool bump');
    await user.click(screen.getByRole('button', { name: /Start load test/ }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      profile: 'cards',
      concurrency: 25,
      durationSeconds: 600,
      cardMode: 'cold',
      label: 'after pool bump',
      resetMetricsWindow: true,
    });
  });

  it('refuses a custom value outside the limits without calling the server', async () => {
    serve(status());
    const user = userEvent.setup();
    render(
      <Wrap>
        <LoadTestingPage idlePollMs={60_000} />
      </Wrap>,
    );
    const input = await screen.findByLabelText('Simulated active players');
    await user.clear(input);
    await user.type(input, '500');
    await user.click(screen.getByRole('button', { name: /Start load test/ }));
    expect(await screen.findByText(/whole number from 1 to 100/)).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('disables the cards profile when the server has no renderer', async () => {
    serve(status({ cardsAvailable: false }));
    render(
      <Wrap>
        <LoadTestingPage idlePollMs={60_000} />
      </Wrap>,
    );
    expect(await screen.findByRole('radio', { name: /Card Rendering/ })).toBeDisabled();
  });

  it('lists recorded runs for comparison', async () => {
    serve(status());
    render(
      <Wrap>
        <LoadTestingPage idlePollMs={60_000} />
      </Wrap>,
    );
    const table = await screen.findByTestId('results-table');
    expect(within(table).getByText('Scale VM')).toBeInTheDocument();
    expect(within(table).getByText('baseline')).toBeInTheDocument();
    expect(within(table).getByText(/6\.0 ms \/ 40\.0 ms \/ 80\.0 ms/)).toBeInTheDocument();
  });
});

describe('an active run', () => {
  it('shows state, progress and every headline number, and Stop posts', async () => {
    serve(status({ current: activeRun() }));
    const user = userEvent.setup();
    render(
      <Wrap>
        <LoadTestingPage activePollMs={60_000} />
      </Wrap>,
    );
    const panel = await screen.findByTestId('active-run');
    expect(within(panel).getByTestId('run-state')).toHaveAttribute('data-state', 'running');
    expect(within(panel).getByText(/Mixed Players · 25 players · 5 min/)).toBeInTheDocument();
    expect(within(panel).getByText('Elapsed 1:30')).toBeInTheDocument();
    expect(within(panel).getByText('Remaining 3:30')).toBeInTheDocument();
    expect(within(panel).getByTestId('stat-active')).toHaveTextContent('25 / 25');
    expect(within(panel).getByTestId('stat-attempted')).toHaveTextContent('1,234');
    expect(within(panel).getByTestId('stat-completed')).toHaveTextContent('1,200');
    expect(within(panel).getByTestId('stat-failures')).toHaveTextContent('7');
    expect(within(panel).getByTestId('stat-failures')).toHaveTextContent('5xx 4');
    expect(within(panel).getByTestId('stat-ops')).toHaveTextContent('13.33');
    expect(within(panel).getByTestId('stat-p50')).toHaveTextContent('12.5 ms');
    expect(within(panel).getByTestId('stat-p95')).toHaveTextContent('180 ms');
    expect(within(panel).getByTestId('stat-p99')).toHaveTextContent('1.45 s');
    expect(screen.queryByRole('button', { name: /Start load test/ })).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Stop' }));
    await waitFor(() =>
      expect(posts.map((p) => new URL(p.url).pathname)).toEqual([
        '/api/v1/admin/load-testing/runs/current/stop',
      ]),
    );
  });

  it('explains priming while it happens', async () => {
    serve(
      status({
        current: activeRun({
          state: 'priming',
          startedAt: null,
          elapsedMs: 0,
          remainingMs: null,
          progress: {
            ...activeRun().progress!,
            phase: 'priming',
            primeProgress: { done: 40, total: 120 },
          },
        }),
      }),
    );
    render(
      <Wrap>
        <LoadTestingPage activePollMs={60_000} />
      </Wrap>,
    );
    expect(
      await screen.findByText(/Priming: touching every read once \(40\/120\)/),
    ).toBeInTheDocument();
  });
});

describe('validateForm', () => {
  const base = {
    profile: 'mixed' as const,
    cardMode: 'warm' as const,
    concurrency: '10',
    durationMinutes: '5',
    label: '',
    resetMetricsWindow: false,
  };
  const limits = { ...LIMITS, profiles: [...LIMITS.profiles] };
  it('accepts the presets and bounds', () => {
    expect(validateForm(base, limits, true)).toEqual({});
    expect(
      validateForm({ ...base, concurrency: '100', durationMinutes: '30' }, limits, true),
    ).toEqual({});
    expect(validateForm({ ...base, durationMinutes: '0.5' }, limits, true)).toEqual({});
  });
  it('refuses values outside them', () => {
    expect(validateForm({ ...base, concurrency: '0' }, limits, true).concurrency).toBeDefined();
    expect(validateForm({ ...base, concurrency: '2.5' }, limits, true).concurrency).toBeDefined();
    expect(
      validateForm({ ...base, durationMinutes: '31' }, limits, true).durationMinutes,
    ).toBeDefined();
    expect(validateForm({ ...base, profile: 'cards' }, limits, false).profile).toBeDefined();
  });
});
