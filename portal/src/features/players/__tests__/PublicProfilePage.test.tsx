/**
 * Public profile tests.
 *
 * The access rule is the API's, and this suite asserts the two halves of it
 * that are visible from the browser: a guild-mate's profile opens from the
 * directory link, and anyone the API refuses — an unknown id and a player in
 * another guild are the *same* 404 by design — lands on an unavailable state
 * rather than an error or, worse, a partially-rendered profile.
 *
 * It also pins the data boundary: the page fetches exactly one resource and
 * never the self-scoped ones, so it cannot show another player's balances even
 * by accident.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

describe('PublicProfilePage', () => {
  it('opens from a directory row and shows that player', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/players'] });

    const list = await screen.findByRole('list', { name: /players in this server/i });
    const aiko = within(list)
      .getAllByRole('listitem')
      .find((item) => within(item).queryByText('Aiko')) as HTMLElement;

    await user.click(within(aiko).getByRole('link', { name: /view profile/i }));

    expect(await screen.findByRole('heading', { name: 'Aiko', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/Level 31/)).toBeInTheDocument();
  });

  it('renders the public fields and nothing self-scoped', async () => {
    renderRoutes({ routes, initialEntries: ['/players/42'] });

    expect(await screen.findByRole('heading', { name: 'Aiko', level: 1 })).toBeInTheDocument();
    // Dex counts ship; dex *contents* do not.
    expect(screen.getByText('30/58')).toBeInTheDocument();
    expect(screen.getByText('Waifu Valley', { exact: false })).toBeInTheDocument();

    // The self profile's balances must not appear here. 1,820 and 46 are the
    // acting player's WaifuBux and Essence in the fixtures.
    expect(screen.queryByText('1,820')).not.toBeInTheDocument();
    expect(screen.queryByText('WaifuBux')).not.toBeInTheDocument();
    expect(screen.queryByText('Essence')).not.toBeInTheDocument();
  });

  it('reads one resource — never the self-scoped player endpoints', async () => {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      paths.push(new URL(request.url, 'http://localhost').pathname);
    });

    renderRoutes({ routes, initialEntries: ['/players/42'] });
    await screen.findByRole('heading', { name: 'Aiko', level: 1 });

    expect(paths).toContain('/api/v1/players/42/public');
    expect(paths).not.toContain('/api/v1/players/42/profile');
    expect(paths).not.toContain('/api/v1/players/42/currency');
    expect(paths).not.toContain('/api/v1/players/42/collection/stats');
    expect(paths).not.toContain('/api/v1/players/42/inventory');
  });

  it('shows an unavailable state for a player the API refuses', async () => {
    // The API answers 404 identically for "no such player" and "not in your
    // selected guild", so the cross-guild case is this case.
    server.use(
      http.get('/api/v1/players/:playerId/public', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    renderRoutes({ routes, initialEntries: ['/players/900'] });

    expect(await screen.findByText(/that profile isn't available/i)).toBeInTheDocument();
    expect(screen.queryByText('Outsider')).not.toBeInTheDocument();
  });

  it('renders a player with no buddy without an empty slot', async () => {
    renderRoutes({ routes, initialEntries: ['/players/42'] });
    expect(await screen.findByText('No buddy set.')).toBeInTheDocument();
  });

  it('shows the buddy preview the profile payload already carries', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/public', () =>
        data({ ...fixtures.publicProfile, ...(fixtures.directoryPlayers[0] as object) }),
      ),
    );

    renderRoutes({ routes, initialEntries: ['/players/1'] });
    expect(await screen.findByText('Nyx')).toBeInTheDocument();
  });
});
