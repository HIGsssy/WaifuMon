/**
 * The System Metrics page against MSW, with real timers and a short poll
 * interval so polling, staleness and recovery run in real time without fake
 * clocks fighting TanStack Query.
 *
 * Pinned:
 *   - `system.metrics.read` gates the nav entry and the route; without it
 *     nothing renders and nothing is fetched;
 *   - the page only ever calls the session-authenticated admin route, never
 *     the bearer-only `/metrics`;
 *   - loading, live, stale and error are each distinguishable, and last-known
 *     data is never presented as current;
 *   - polling repeats, grows the trend history, never overlaps, and stops when
 *     access is refused;
 *   - thresholded readings show a verdict in text and informational ones do not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { delay, http } from 'msw';

import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import { NavList } from '@/components/layout/NavList';
import { expectNoAxeViolations } from '@/test/axe';

import { apiError, data } from '../../../../msw/handlers';
import { systemMetricsReport } from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { SystemMetricsPage } from '../SystemMetricsPage';

const METRICS = ['system.metrics.read'];
const URL = '/api/v1/admin/system/metrics';
/** Short enough that polling tests finish in well under a second. */
const POLL = 80;

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
  permissions = METRICS,
}: {
  children: React.ReactNode;
  permissions?: readonly string[];
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        <MemoryRouter initialEntries={['/admin/system']}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

function renderPage(pollMs = POLL) {
  return render(
    <Wrap>
      <SystemMetricsPage pollMs={pollMs} />
    </Wrap>,
  );
}

let requests: string[] = [];
const onRequest = ({ request }: { request: Request }) => {
  requests.push(new globalThis.URL(request.url).pathname);
};
beforeEach(() => {
  requests = [];
  server.events.on('request:start', onRequest);
});
afterEach(() => {
  server.events.removeListener('request:start', onRequest);
});

const metricsRequests = () => requests.filter((p) => p === URL);
const status = () => screen.getByTestId('feed-status').dataset.status;

/**
 * Each response stamped with the real current instant, as the server does. The
 * spacing between samples must match the poll interval: the chart breaks the
 * line at gaps longer than 2.5 polls, so fixture instants a synthetic 5 s apart
 * under an 80 ms poll would (correctly) draw as isolated dots.
 */
function sequencedReports() {
  return () => data(systemMetricsReport(new Date().toISOString()));
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

// ─────────────────────────────────────────────────────────── permission

describe('permission and navigation', () => {
  it('shows the nav entry with system.metrics.read', () => {
    render(
      <Wrap>
        <NavList />
      </Wrap>,
    );
    expect(screen.getByRole('link', { name: /Admin — System Metrics/ })).toHaveAttribute(
      'href',
      '/admin/system',
    );
  });

  it('hides it from a session holding every other admin permission', () => {
    render(
      <Wrap
        permissions={[
          'admin.access',
          'encounters.read',
          'encounters.write',
          'encounters.publish',
          'presentations.read',
          'presentations.write',
          'gallery.read',
        ]}
      >
        <NavList />
      </Wrap>,
    );
    expect(screen.queryByRole('link', { name: /System Metrics/ })).toBeNull();
  });

  it('guards the route: without the permission nothing renders and nothing is fetched', async () => {
    const route = findRoute('admin/system');
    expect(route).toBeDefined();
    render(<Wrap permissions={['admin.access', 'gallery.read']}>{route!.element}</Wrap>);
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(metricsRequests()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────── rendering

describe('rendering a report', () => {
  it('draws all eight load gauges with the current readings', async () => {
    renderPage(60_000);
    await screen.findByTestId('metrics-body');

    const gauge = (id: string) => screen.getByTestId(id);
    // Recent ELU (0.42), not the cumulative 0.18.
    expect(within(gauge('gauge-event-loop')).getByRole('meter')).toHaveAttribute(
      'aria-valuenow',
      '42',
    );
    expect(within(gauge('gauge-process-cpu')).getByText('32%')).toBeInTheDocument();
    expect(within(gauge('gauge-memory')).getByText('412 MiB')).toBeInTheDocument();
    expect(
      within(gauge('gauge-memory')).getByText(/of 2\.00 GiB container limit/),
    ).toBeInTheDocument();
    expect(within(gauge('gauge-in-flight')).getByText('3')).toBeInTheDocument();
    expect(within(gauge('gauge-db-pool')).getByText('4 / 10')).toBeInTheDocument();
    expect(within(gauge('gauge-renderer')).getByText('1 / 2')).toBeInTheDocument();
    expect(within(gauge('gauge-host-cpu')).getByText('38%')).toBeInTheDocument();
    expect(within(gauge('gauge-host-memory')).getByText('44%')).toBeInTheDocument();
  });

  it('gives thresholded readings a verdict in words, and informational ones none', async () => {
    renderPage(60_000);
    await screen.findByTestId('metrics-body');
    // Thresholded, and inside the threshold.
    for (const id of ['gauge-event-loop', 'gauge-db-pool', 'gauge-renderer']) {
      expect(within(screen.getByTestId(id)).getByText('Healthy')).toBeInTheDocument();
    }
    // No defensible threshold — no badge implying one.
    for (const id of [
      'gauge-process-cpu',
      'gauge-in-flight',
      'gauge-host-cpu',
      'gauge-host-memory',
      'gauge-memory',
    ]) {
      const g = screen.getByTestId(id);
      expect(g.dataset.level).toBe('neutral');
      expect(within(g).queryByText(/Healthy|Elevated|Critical/)).toBeNull();
    }
  });

  it('marks a saturated pool critical', async () => {
    server.use(
      http.get(URL, () => {
        const r = systemMetricsReport();
        r.database.pool = { totalCount: 10, idleCount: 0, waitingCount: 4, max: 10 };
        return data(r);
      }),
    );
    renderPage(60_000);
    const pool = await screen.findByTestId('gauge-db-pool');
    expect(pool.dataset.level).toBe('critical');
    expect(within(pool).getByText('Critical')).toBeInTheDocument();
    expect(within(pool).getByText('4 queries waiting for a connection')).toBeInTheDocument();
  });

  it('says the host readings are the whole machine when containerized', async () => {
    renderPage(60_000);
    const note = await screen.findByTestId('host-scope-note');
    expect(note).toHaveTextContent(/whole machine/);
    expect(note).toHaveTextContent(/not this container alone/);
  });

  it('says so when LXCFS makes "host" readings per-container', async () => {
    server.use(
      http.get(URL, () => {
        const r = systemMetricsReport();
        r.system.hostViewVirtualized = true;
        return data(r);
      }),
    );
    renderPage(60_000);
    expect(await screen.findByTestId('host-scope-note')).toHaveTextContent(/LXCFS/);
    expect(screen.getByText('CPU (virtualized /proc)')).toBeInTheDocument();
  });

  it('shows every detail panel and the per-route table', async () => {
    renderPage(60_000);
    await screen.findByTestId('metrics-body');
    for (const id of [
      'panel-event-loop',
      'panel-http',
      'panel-database',
      'panel-cards',
      'panel-process',
      'panel-host',
      'panel-routes',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByText('v22.11.0')).toBeInTheDocument();
    const table = within(screen.getByTestId('panel-routes')).getByRole('table');
    const firstRow = within(table).getAllByRole('row')[1]!;
    // Busiest first.
    expect(firstRow).toHaveTextContent('/api/v1/cards/species/:slug');
  });

  it('re-sorts routes by p99', async () => {
    const user = userEvent.setup();
    renderPage(60_000);
    await screen.findByTestId('metrics-body');
    await user.click(screen.getByRole('button', { name: 'Slowest p99' }));
    const rows = within(screen.getByTestId('panel-routes')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('/api/v1/cards/species/:slug'); // p99 1480
    expect(rows[3]).toHaveTextContent('/api/v1/content/species'); // p99 25
  });
});

// ─────────────────────────────────────────────────────────── security

describe('what the page requests', () => {
  it('only ever calls the session-authenticated admin route, never the bearer-only /metrics', async () => {
    server.use(http.get(URL, sequencedReports()));
    renderPage();
    await waitFor(() => expect(metricsRequests().length).toBeGreaterThanOrEqual(2));
    expect(requests.filter((p) => p.endsWith('/metrics') && p !== URL)).toEqual([]);
    expect(requests).not.toContain('/metrics');
    expect(requests.some((p) => p.includes('/reset'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────── states

describe('feed states', () => {
  it('shows loading until the first response', async () => {
    server.use(
      http.get(URL, async () => {
        await delay('infinite');
        return data(systemMetricsReport());
      }),
    );
    renderPage();
    expect(status()).toBe('loading');
    expect(screen.getByTestId('metrics-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('feed-banner')).toBeNull();
  });

  it('is live after a successful poll', async () => {
    renderPage(60_000);
    await waitFor(() => expect(status()).toBe('live'));
    expect(screen.queryByTestId('feed-banner')).toBeNull();
  });

  it('shows "unable to retrieve" when the first request fails', async () => {
    server.use(http.get(URL, () => apiError(500, 'INTERNAL_ERROR', 'Internal error.')));
    renderPage();
    const banner = await screen.findByTestId('feed-banner');
    expect(banner).toHaveTextContent('Unable to retrieve metrics.');
    expect(status()).toBe('error');
    expect(screen.queryByTestId('metrics-body')).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
  });

  it('keeps last-known data on a later failure, dimmed and labelled as not current', async () => {
    let n = 0;
    server.use(
      http.get(URL, () => {
        n += 1;
        return n === 1 ? data(systemMetricsReport()) : apiError(503, 'UNAVAILABLE', 'Unavailable.');
      }),
    );
    renderPage();
    await screen.findByTestId('metrics-body');
    const banner = await screen.findByTestId('feed-banner');
    expect(banner).toHaveTextContent('Showing the last values received');
    expect(status()).toBe('error');
    expect(screen.getByTestId('metrics-body').dataset.current).toBe('false');
  });

  it('goes stale when a poll stops completing, without claiming an error', async () => {
    let n = 0;
    server.use(
      http.get(URL, async () => {
        n += 1;
        if (n > 1) await delay('infinite'); // the server has gone quiet
        return data(systemMetricsReport());
      }),
    );
    renderPage();
    await screen.findByTestId('metrics-body');
    // Stale after three poll intervals without a response.
    await waitFor(() => expect(status()).toBe('stale'), { timeout: 2_000 });
    expect(screen.getByTestId('feed-banner')).toHaveTextContent('Data is stale.');
    expect(screen.getByTestId('metrics-body').dataset.current).toBe('false');
    // Never overlapped: one hanging request, not one per tick.
    expect(n).toBe(2);
  });

  it('recovers to live when the server comes back', async () => {
    let n = 0;
    server.use(
      http.get(URL, () => {
        n += 1;
        return n === 1
          ? apiError(500, 'INTERNAL_ERROR', 'Internal error.')
          : data(systemMetricsReport(new Date().toISOString()));
      }),
    );
    renderPage();
    await waitFor(() => expect(status()).toBe('error'));
    await waitFor(() => expect(status()).toBe('live'), { timeout: 2_000 });
    expect(screen.queryByTestId('feed-banner')).toBeNull();
  });

  it('stops polling once access is refused, and says why', async () => {
    server.use(
      http.get(URL, () =>
        apiError(403, 'PORTAL_PERMISSION_DENIED', 'You do not have permission to do that.'),
      ),
    );
    renderPage();
    const banner = await screen.findByTestId('feed-banner');
    expect(banner).toHaveTextContent('no longer allowed');
    expect(banner).toHaveTextContent('Automatic refresh has stopped.');
    const count = metricsRequests().length;
    await new Promise((r) => setTimeout(r, POLL * 5));
    expect(metricsRequests().length).toBe(count);
  });
});

// ─────────────────────────────────────────────────────────── polling

describe('polling and trends', () => {
  it('polls on the interval and extends the trend history', async () => {
    server.use(http.get(URL, sequencedReports()));
    renderPage();
    await waitFor(() => expect(metricsRequests().length).toBeGreaterThanOrEqual(4), {
      timeout: 2_000,
    });
    const trend = within(screen.getByTestId('gauge-event-loop')).getByRole('img');
    expect(trend.getAttribute('aria-label')).toMatch(/latest 42%, peak 42%/);
    // One polyline for several consecutive samples, not isolated dots.
    await waitFor(() => expect(trend.querySelectorAll('polyline').length).toBeGreaterThan(0));
  });

  it('clears the trends without touching the server', async () => {
    const user = userEvent.setup();
    renderPage(60_000);
    await screen.findByTestId('metrics-body');
    const trend = () => within(screen.getByTestId('gauge-event-loop')).getByRole('img');
    expect(trend().getAttribute('aria-label')).toMatch(/latest/);
    const before = requests.length;

    await user.click(screen.getByRole('button', { name: 'Clear trends' }));

    expect(trend().getAttribute('aria-label')).toMatch(/no trend data yet/);
    expect(screen.getByRole('button', { name: 'Clear trends' })).toBeDisabled();
    // No request of any kind — in particular, no reset.
    expect(requests.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────── accessibility

describe('accessibility', () => {
  it('has no axe violations with a live report', async () => {
    const { container } = renderPage(60_000);
    await screen.findByTestId('metrics-body');
    await expectNoAxeViolations(container);
  });

  it('has no axe violations in the error state', async () => {
    server.use(http.get(URL, () => apiError(500, 'INTERNAL_ERROR', 'Internal error.')));
    const { container } = renderPage();
    await screen.findByTestId('feed-banner');
    await expectNoAxeViolations(container);
  });

  it('exposes each gauge as a labelled meter', async () => {
    renderPage(60_000);
    await screen.findByTestId('metrics-body');
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(8);
    expect(screen.getByRole('meter', { name: 'Database pool' })).toHaveAttribute(
      'aria-valuetext',
      '4 / 10',
    );
  });
});
