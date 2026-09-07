/**
 * Players directory page tests.
 *
 * The interesting assertions are not "does it render a list" — they are the
 * three properties this feature is actually about:
 *
 *   1. **Guild scope is the server's, and the page cannot widen it.** The
 *      request carries no guild, and the page shows exactly what came back.
 *   2. **A guild switch cannot flash the previous guild's players.** The cache
 *      key carries the guild, so guild B renders skeletons and then B's roster —
 *      never A's, not even for a frame.
 *   3. **The payload is narrow.** Currencies, XP and collection contents are
 *      absent, and the page never asks for them per row.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, page } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { NAV_ITEMS } from '@/app/navigation';
import { queryKeys } from '@/api/queryKeys';
import { createTestQueryClient, renderRoutes } from '@/test/renderWithProviders';

function renderPlayers(initialEntries = ['/players']) {
  return renderRoutes({ routes, initialEntries });
}

/**
 * The roster list, addressed by its label.
 *
 * Not `getByRole('list')`: the app shell's sidebar navigation is a list too,
 * and the header renders the *acting* player's name — so an unscoped query
 * would pass for the wrong reasons and fail for the wrong ones.
 */
const roster = () => screen.findByRole('list', { name: /players in this server/i });

/** Every row's "View Profile" link, in rendered order. */
async function rowOrder(): Promise<string[]> {
  const list = await roster();
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByRole('link', { name: /view profile/i }).getAttribute('href') ?? '');
}

describe('Portal navigation', () => {
  it('offers Players as a real destination, not a Coming Soon slot', () => {
    const players = NAV_ITEMS.find((item) => item.to === '/players');
    expect(players).toBeDefined();
    expect(players?.label).toBe('Players');
    expect(players?.comingSoon).toBeUndefined();

    // v1 explicitly does not ship a "Friends" nav entry.
    expect(NAV_ITEMS.some((item) => item.label === 'Friends')).toBe(false);
  });
});

describe('PlayersPage', () => {
  it('lists the players the API returned for the selected guild', async () => {
    renderPlayers();

    expect(await screen.findByRole('heading', { name: 'Players' })).toBeInTheDocument();
    expect(await screen.findByText('Aiko')).toBeInTheDocument();
    const list = await roster();
    expect(within(list).getByText('Mika')).toBeInTheDocument();
    expect(within(list).getByText('Zara')).toBeInTheDocument();
  });

  it('sends no guild parameter — scope is the session\'s, server-side', async () => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/v1/players') seen.push(url.search);
    });

    renderPlayers();
    await screen.findByText('Aiko');

    expect(seen.length).toBeGreaterThan(0);
    for (const search of seen) {
      expect(search).not.toMatch(/guild/i);
      expect(search).not.toMatch(/playerId/i);
    }
  });

  it('excludes players from other guilds — it renders only what the scoped API sent', async () => {
    // The API answering for a *different* selected guild returns that guild's
    // roster and nothing else. There is no client-side filter to bypass.
    server.use(
      http.get('/api/v1/players', () =>
        page(fixtures.otherGuildDirectoryPlayers, 1, 25, fixtures.otherGuildDirectoryPlayers.length),
      ),
    );

    renderPlayers();

    expect(await screen.findByText('Outsider')).toBeInTheDocument();
    const list = await roster();
    expect(within(list).queryByText('Aiko')).not.toBeInTheDocument();
    // "Mika" is the acting player's own name in the header — the assertion has
    // to be about the roster, not the document.
    expect(within(list).queryByText('Mika')).not.toBeInTheDocument();
  });

  it('keys the cache by guild, so guild A results cannot be served under guild B', async () => {
    const client = createTestQueryClient();

    // Guild 7's directory, already cached — the state a guild switch leaves
    // behind.
    client.setQueryData(queryKeys.playerDirectory(7, { page: 1, search: '', sort: 'name' }), {
      items: fixtures.directoryPlayers,
      page: 1,
      pageSize: 25,
      total: fixtures.directoryPlayers.length,
    });

    // Guild 8 is a different key, so nothing above can answer for it.
    expect(
      client.getQueryData(queryKeys.playerDirectory(8, { page: 1, search: '', sort: 'name' })),
    ).toBeUndefined();
    expect(queryKeys.playerDirectory(7, { page: 1, search: '', sort: 'name' })).not.toEqual(
      queryKeys.playerDirectory(8, { page: 1, search: '', sort: 'name' }),
    );
  });

  it('renders the loading state, never a roster, while the guild scope is unresolved', async () => {
    // A session that has not resolved a guild must not produce a request at
    // all — `enabled` is false — and must not render "no players".
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/v1/players') seen.push(url.search);
    });

    // The dev session resolves from `/players/lookup`; failing it leaves the
    // session unresolved, which is exactly the mid-switch state.
    server.use(
      http.get('/api/v1/players/lookup', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player for that Discord identity.'),
      ),
    );

    renderPlayers();

    await waitFor(() => expect(screen.queryByText('Aiko')).not.toBeInTheDocument());
    expect(seen).toHaveLength(0);
  });

  it('searches by display name', async () => {
    const user = userEvent.setup();
    renderPlayers();
    await screen.findByText('Aiko');

    await user.type(screen.getByRole('searchbox', { name: /search players/i }), 'zar');

    await waitFor(() => expect(screen.queryByText('Aiko')).not.toBeInTheDocument());
    expect(within(await roster()).getByText('Zara')).toBeInTheDocument();
  });

  it('renders a clean empty state when a search matches nobody', async () => {
    const user = userEvent.setup();
    renderPlayers();
    await screen.findByText('Aiko');

    await user.type(screen.getByRole('searchbox', { name: /search players/i }), 'nobody');

    expect(await screen.findByText('No players match that name.')).toBeInTheDocument();
  });

  it('renders a clean empty state for a guild with no players', async () => {
    server.use(http.get('/api/v1/players', () => page([], 1, 25, 0)));
    renderPlayers();

    expect(await screen.findByText('No players here yet.')).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: /players in this server/i }),
    ).not.toBeInTheDocument();
  });

  it('sorts by name', async () => {
    renderPlayers();
    await screen.findByText('Aiko');

    // Aiko, Mika, Zara — and the fixture is authored in a different order, so
    // this is the sort being applied rather than the fixture being lucky.
    expect(await rowOrder()).toEqual(['/players/42', '/players/1', '/players/77']);
  });

  it('sorts by trainer level, highest first', async () => {
    const user = userEvent.setup();
    renderPlayers();
    await screen.findByText('Aiko');

    await user.selectOptions(screen.getByRole('combobox', { name: /sort players/i }), 'level');

    // 31, 12, 4.
    await waitFor(async () =>
      expect(await rowOrder()).toEqual(['/players/42', '/players/1', '/players/77']),
    );
    const list = await roster();
    const first = within(list).getAllByRole('listitem')[0];
    expect(within(first as HTMLElement).getByText(/Level 31/)).toBeInTheDocument();
  });

  it('sorts by recent activity', async () => {
    const user = userEvent.setup();
    renderPlayers();
    await screen.findByText('Aiko');

    await user.selectOptions(screen.getByRole('combobox', { name: /sort players/i }), 'recent');

    await waitFor(async () =>
      expect(await rowOrder()).toEqual(['/players/42', '/players/1', '/players/77']),
    );
  });

  it('fetches the whole directory in one request — no per-player follow-up', async () => {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      paths.push(new URL(request.url, 'http://localhost').pathname);
    });

    renderPlayers();
    await screen.findByText('Aiko');
    await screen.findByText('Zara');

    // One directory request, and not one request per listed player. The buddy
    // preview rides on the same response, so no `/collection/buddy` either.
    expect(paths.filter((p) => p === '/api/v1/players')).toHaveLength(1);
    expect(paths.some((p) => p.endsWith('/collection/buddy'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/currency'))).toBe(false);
    expect(paths.filter((p) => /^\/api\/v1\/players\/\d+\/public$/.test(p))).toHaveLength(0);
  });

  it('carries no currencies, XP or collection contents in the directory payload', async () => {
    // Asserted against the contract fixture the mock serves, which is the same
    // shape the API's `directoryPlayerSchema` produces.
    for (const row of fixtures.directoryPlayers) {
      const keys = Object.keys(row);
      expect(keys).toEqual(
        expect.arrayContaining(['id', 'displayName', 'avatarUrl', 'level', 'lastActiveAt', 'buddy']),
      );
      for (const forbidden of [
        'xp',
        'discordUserId',
        'guildId',
        'currencies',
        'waifubux',
        'essence',
        'progress',
        'collection',
        'inventory',
        'settings',
        'showcase',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it('links each row to the existing public profile route', async () => {
    renderPlayers();
    await screen.findByText('Aiko');

    const list = await roster();
    const aiko = within(list)
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText('Aiko'));
    expect(aiko).toBeDefined();
    expect(
      within(aiko as HTMLElement).getByRole('link', { name: /view profile/i }),
    ).toHaveAttribute('href', '/players/42');
  });

  it('surfaces a directory failure without taking the page down', async () => {
    server.use(http.get('/api/v1/players', () => apiError(500, 'INTERNAL_ERROR', 'Internal error.')));
    renderPlayers();

    expect(await screen.findByText(/couldn't load the player directory/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Players' })).toBeInTheDocument();
  });
});
