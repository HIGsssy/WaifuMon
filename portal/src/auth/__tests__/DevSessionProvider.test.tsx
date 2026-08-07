/**
 * Dev-auth behaviour (plan §22.3).
 *
 * Vitest runs with `import.meta.env.DEV === true`, so these exercise the
 * developer-login provider — the one a `npm run dev` Portal actually uses.
 * `vitest.setup.ts` seeds the stored identity, which stands in for "signed in
 * last time".
 *
 * Overrides here name `/api/v1/players/1` rather than `/api/v1/players/:id`:
 * the param pattern also matches `/players/lookup`, and shadowing the identity
 * bridge would break the session for a reason that has nothing to do with the
 * case under test.
 */
import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data } from '../../../msw/handlers';
import * as fixtures from '../../../msw/fixtures';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

describe('DevLoginSessionProvider', () => {
  it('restores the stored developer identity and lets routed pages render', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('bridges the Discord pair to an internal player id via /players/lookup', async () => {
    const asked: Array<string | null> = [];
    server.use(
      http.get('/api/v1/players/lookup', ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query.get('discordUserId'), query.get('discordGuildId'));
        return data({ playerId: fixtures.PLAYER_ID });
      }),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByRole('heading', { name: 'Dashboard' });

    expect(asked).toEqual([fixtures.DISCORD_USER_ID, fixtures.DISCORD_GUILD_ID]);
  });

  it("shows the API's display name in the header", async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    expect(await screen.findAllByText('Mika')).not.toHaveLength(0);
  });

  it('falls back to Trainer #id when the API resolves no identity', async () => {
    // `identity` is documented as nullable — a reconnecting gateway, an
    // unresolvable user, or an API running without a Discord client.
    server.use(http.get('/api/v1/players/1', () => data({ ...fixtures.player, identity: null })));

    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    expect(await screen.findAllByText('Trainer #1')).not.toHaveLength(0);
  });

  it('shows the login screen when nothing is stored', async () => {
    localStorage.clear();

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByRole('heading', { name: 'Developer login' })).toBeInTheDocument();
  });

  it('explains that a Discord account has never played here, without provisioning one', async () => {
    localStorage.setItem(
      'waifumon-portal:dev-identity',
      JSON.stringify({ discordUserId: '111111111111111111', discordGuildId: '222222222222222222' }),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(
      await screen.findByText('This Discord account hasn’t played here yet'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Players are created the first time someone plays/),
    ).toBeInTheDocument();
  });

  it('explains an unreachable Platform API rather than crashing', async () => {
    server.use(http.get('/api/v1/players/lookup', () => Response.error()));

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText("Can't reach the Waifumon server")).toBeInTheDocument();
  });

  it('explains a rejected bearer token', async () => {
    server.use(
      http.get('/api/v1/players/lookup', () => apiError(401, 'UNAUTHORIZED', 'Unauthorized.')),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText('The Platform API rejected the token')).toBeInTheDocument();
  });

  it('surfaces a failure to load the player the lookup resolved', async () => {
    server.use(
      http.get('/api/v1/players/1', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText('No player with that id')).toBeInTheDocument();
  });
});
