/**
 * Staging Test Controls pages against MSW.
 *
 * Pinned:
 *   - `players.testcontrols` gates the nav entry and both routes; without it
 *     nothing renders and nothing is fetched;
 *   - a server without the flag (404) reads as "not available on this server",
 *     with no controls;
 *   - the page is visibly a staging tool (the banner) and shows the account's
 *     current state;
 *   - each control posts exactly the chosen value, and the result panel shows
 *     what the server said changed;
 *   - an out-of-range value is caught before any request;
 *   - the Staging Boost, the Belt reset and revoking the Beacon ask first, and
 *     Cancel sends nothing;
 *   - the picker lists players from the directory and links to their controls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';

import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import { NavList } from '@/components/layout/NavList';
import type {
  TestControlResult,
  TestControlsInfo,
  TestControlsPlayerState,
} from '@/api/adminTestControls';

import { apiError, data, page } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { TestControlsPickerPage } from '../TestControlsPickerPage';
import { TestControlsPlayerPage } from '../TestControlsPlayerPage';

const PERM = ['players.testcontrols'];
const INFO_URL = '/api/v1/admin/test-controls';
const PLAYER_URL = `${INFO_URL}/players/7`;

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
  path = '/admin/test-controls/7',
}: {
  children: React.ReactNode;
  permissions?: readonly string[];
  path?: string;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

function renderPlayerPage() {
  return render(
    <Wrap>
      <Routes>
        <Route path="/admin/test-controls/:playerId" element={<TestControlsPlayerPage />} />
        <Route path="/admin/test-controls" element={<p>picker</p>} />
      </Routes>
    </Wrap>,
  );
}

const INFO: TestControlsInfo = {
  enabled: true,
  deploymentEnv: 'staging',
  stagingBoost: { level: 40, waifubux: 10_000 },
  maxWaifubuxPerAction: 1_000_000,
};

function playerState(overrides: Partial<TestControlsPlayerState> = {}): TestControlsPlayerState {
  return {
    playerId: 7,
    discordUserId: '777',
    displayName: 'Tester Tina',
    level: 12,
    xp: 3_000,
    maxLevel: 50,
    waifubux: 5_000,
    energy: 4,
    maxEnergy: 20,
    currentRegion: 'waifu-valley',
    currentRegionName: 'Waifu Valley',
    beacon: {
      slug: 'transporter_beacon',
      name: 'Transporter Beacon',
      owned: false,
      requiredLevel: null,
    },
    beltComponents: [
      { slug: 'cracked_teleport_core', name: 'Cracked Teleport Core', owned: 0, required: 1 },
    ],
    legacyBeltRoute: false,
    beltEncounterCooldowns: 0,
    passes: [{ id: 'caravan_pass', name: 'Caravan Pass', owned: false }],
    routes: [{ regionId: 'twin-peeks', name: 'Twin Peeks', unlocked: false, requiredLevel: 15 }],
    ...overrides,
  };
}

let posts: Array<{ path: string; body: unknown }> = [];
beforeEach(() => {
  posts = [];
});
afterEach(() => server.resetHandlers());

function serve(info: TestControlsInfo | (() => Response) = INFO) {
  server.use(
    http.get(INFO_URL, () => (typeof info === 'function' ? info() : data(info))),
    http.get(PLAYER_URL, () => data(playerState())),
    http.post(`${PLAYER_URL}/*`, async ({ request }) => {
      const path = new URL(request.url).pathname.replace(`${PLAYER_URL}/`, '');
      const body = await request.json().catch(() => ({}));
      posts.push({ path, body });
      const result: TestControlResult = {
        action: 'test_set_player_level',
        changed: true,
        message: `did ${path}`,
        changes: [{ field: 'level', before: 12, after: 35 }],
        state: playerState({ level: 35 }),
      };
      return HttpResponse.json({ data: result });
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
  it('shows the nav entry with players.testcontrols', () => {
    render(
      <Wrap>
        <NavList />
      </Wrap>,
    );
    expect(screen.getByRole('link', { name: /Staging Test Controls/ })).toHaveAttribute(
      'href',
      '/admin/test-controls',
    );
  });

  it('hides it without the permission', () => {
    render(
      <Wrap permissions={['admin.access', 'system.metrics.read']}>
        <NavList />
      </Wrap>,
    );
    expect(screen.queryByRole('link', { name: /Test Controls/ })).toBeNull();
  });

  it('guards both routes: without the permission nothing renders and nothing is fetched', async () => {
    let fetched = 0;
    server.use(
      http.get(`${INFO_URL}*`, () => {
        fetched += 1;
        return data(INFO);
      }),
    );
    for (const path of ['admin/test-controls', 'admin/test-controls/:playerId']) {
      const route = findRoute(path);
      expect(route, path).toBeDefined();
      const { unmount } = render(<Wrap permissions={['admin.access']}>{route!.element}</Wrap>);
      expect(screen.getByText('Page not found')).toBeInTheDocument();
      unmount();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched).toBe(0);
  });
});

describe('a server without test controls', () => {
  it('says they are not available and offers no controls', async () => {
    serve(() => apiError(404, 'NOT_FOUND', 'Not found.'));
    renderPlayerPage();
    expect(await screen.findByTestId('test-controls-disabled')).toHaveTextContent(
      /not available on this server/,
    );
    expect(screen.queryByRole('button', { name: /Prepare Player/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Set$/ })).toBeNull();
  });
});

describe('the player page', () => {
  it('is labelled as a staging tool and shows the current state', async () => {
    serve();
    renderPlayerPage();
    const summary = await screen.findByTestId('test-controls-summary');
    expect(screen.getByTestId('staging-banner')).toHaveTextContent(/Staging test controls/i);
    expect(screen.getByTestId('staging-banner')).toHaveTextContent('[staging]');
    expect(within(summary).getByText('12 / 50')).toBeInTheDocument();
    expect(within(summary).getByText('5,000')).toBeInTheDocument();
    expect(within(summary).getByText('4 / 20')).toBeInTheDocument();
  });

  it('reports the Belt as having no level requirement, and routes by their level', async () => {
    serve();
    renderPlayerPage();
    const summary = await screen.findByTestId('test-controls-summary');
    expect(within(summary).getByText('Belt level requirement')).toBeInTheDocument();
    expect(within(summary).getByText('No level requirement')).toBeInTheDocument();
    expect(within(summary).queryByText(/Lv 1/)).toBeNull();
    const access = screen.getByLabelText('Travel access');
    expect(access).toHaveTextContent('Twin Peeks (Lv 15)');
  });

  it('sets the level and shows what changed', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    const input = await screen.findByLabelText('Level');
    await user.clear(input);
    await user.type(input, '35');
    const setButtons = screen.getAllByRole('button', { name: 'Set' });
    await user.click(setButtons[0]!);
    await waitFor(() => expect(posts).toEqual([{ path: 'level', body: { level: 35 } }]));
    const result = await screen.findByTestId('test-controls-result');
    expect(result).toHaveTextContent('did level');
    expect(result).toHaveTextContent('35');
  });

  it('adds and removes WaifuBux', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    const input = await screen.findByLabelText('WaifuBux');
    await user.clear(input);
    await user.type(input, '250');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { path: 'waifubux/add', body: { amount: 250 } },
      { path: 'waifubux/remove', body: { amount: 250 } },
    ]);
  });

  it('refuses an out-of-range value before sending anything', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    const energy = await screen.findByLabelText(/Energy/);
    await user.clear(energy);
    await user.type(energy, '99');
    await user.click(screen.getAllByRole('button', { name: 'Set' })[1]!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Energy must be a whole number from 0 to 20/);
    expect(posts).toEqual([]);
  });

  it('grants the Beacon and standard travel with a single click each', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    await user.click(await screen.findByRole('button', { name: 'Grant Transporter Beacon' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Grant All Standard Travel Access' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.map((p) => p.path)).toEqual(['beacon/grant', 'travel/grant-standard']);
  });

  it('asks before the Staging Boost, and Cancel sends nothing', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    await user.click(await screen.findByRole('button', { name: 'Prepare Player for Current Content' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Set Trainer Level to 40');
    expect(dialog).toHaveTextContent('Add 10,000 WaifuBux');
    expect(dialog).toHaveTextContent(/Does not grant the Transporter Beacon/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Prepare Player for Current Content' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply Staging Boost' }),
    );
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['staging-boost']));
  });

  it('asks before resetting the Belt and before revoking the Beacon', async () => {
    serve();
    const user = userEvent.setup();
    renderPlayerPage();
    await user.click(
      await screen.findByRole('button', { name: 'Reset Assteroid Belt Unlock Test State' }),
    );
    const reset = await screen.findByRole('dialog');
    expect(reset).toHaveTextContent('Cracked Teleport Core');
    expect(posts).toEqual([]);
    await user.click(within(reset).getByRole('button', { name: 'Reset Belt state' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['reset-assteroid-belt']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Revoke Transporter Beacon' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke Beacon' }),
    );
    await waitFor(() =>
      expect(posts.map((p) => p.path)).toEqual(['reset-assteroid-belt', 'beacon/revoke']),
    );
  });

  it('shows the Equipment onboarding state and asks before resetting it', async () => {
    serve();
    server.use(
      http.get(PLAYER_URL, () =>
        data(
          playerState({
            equipmentOnboarding: {
              phase: 'in_progress',
              nextStep: 'defense',
              unlocked: false,
              starters: [
                { slot: 'attack', definitionKey: 'rusty_pipe', granted: true, removed: false },
                { slot: 'defense', definitionKey: '', granted: false, removed: false },
                { slot: 'health', definitionKey: '', granted: false, removed: false },
              ],
            },
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    renderPlayerPage();
    const list = await screen.findByRole('list', { name: 'Equipment onboarding state' });
    expect(list).toHaveTextContent('Onboarding: in progress (next: defense)');
    expect(list).toHaveTextContent('Starter attack (rusty_pipe)');

    await user.click(screen.getByRole('button', { name: 'Reset Equipment Onboarding' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Revoke the Equipment feature unlock');
    expect(posts).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Reset onboarding' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['reset-equipment-onboarding']));
  });

  it('shows today’s Delve runs and resets them with one click', async () => {
    serve();
    server.use(
      http.get(PLAYER_URL, () =>
        data(playerState({ delve: { limit: 3, used: 2, remaining: 1, periodKey: '2026-10-03' } })),
      ),
    );
    const user = userEvent.setup();
    renderPlayerPage();
    const list = await screen.findByRole('list', { name: 'Delve daily runs' });
    expect(list).toHaveTextContent('Daily Delve runs: 1 / 3 remaining (2 started on 2026-10-03)');
    await user.click(screen.getByRole('button', { name: 'Reset Today’s Delve Runs' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['reset-delve-usage']));
  });

  it('disables the Delve reset when nothing was started, and hides it without the dungeon service', async () => {
    serve();
    server.use(
      http.get(PLAYER_URL, () =>
        data(playerState({ delve: { limit: 3, used: 0, remaining: 3, periodKey: '2026-10-03' } })),
      ),
    );
    const { unmount } = renderPlayerPage();
    expect(await screen.findByRole('button', { name: 'Reset Today’s Delve Runs' })).toBeDisabled();
    unmount();
    server.use(http.get(PLAYER_URL, () => data(playerState())));
    renderPlayerPage();
    await screen.findByRole('button', { name: 'Reset Assteroid Belt Unlock Test State' });
    expect(screen.queryByRole('button', { name: 'Reset Today’s Delve Runs' })).toBeNull();
  });

  it('offers no onboarding reset on a server without the Equipment onboarding', async () => {
    serve();
    renderPlayerPage();
    await screen.findByRole('button', { name: 'Reset Assteroid Belt Unlock Test State' });
    expect(screen.queryByRole('button', { name: 'Reset Equipment Onboarding' })).toBeNull();
  });

  it('shows the server refusal for a failed action', async () => {
    serve();
    server.use(
      http.post(`${PLAYER_URL}/waifubux/remove`, () =>
        apiError(422, 'INSUFFICIENT_FUNDS', 'You need 9000 WaifuBux but only have 5000.'),
      ),
    );
    const user = userEvent.setup();
    renderPlayerPage();
    const input = await screen.findByLabelText('WaifuBux');
    await user.clear(input);
    await user.type(input, '9000');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/only have 5000/);
  });
});

describe('the picker', () => {
  it('lists players from the directory and links to their controls', async () => {
    server.use(
      http.get(INFO_URL, () => data(INFO)),
      http.get('/api/v1/players', () =>
        page([
          {
            id: 7,
            displayName: 'Tester Tina',
            avatarUrl: null,
            level: 12,
            lastActiveAt: '2026-09-01T10:00:00.000Z',
            buddy: null,
          },
        ]),
      ),
    );
    render(
      <Wrap path="/admin/test-controls">
        <TestControlsPickerPage />
      </Wrap>,
    );
    const link = await screen.findByRole('link', { name: /Tester Tina/ });
    expect(link).toHaveAttribute('href', '/admin/test-controls/7');
    expect(screen.getByTestId('staging-banner')).toBeInTheDocument();
  });
});
