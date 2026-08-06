/**
 * Dev-auth behaviour (plan §22.3).
 *
 * Three paths, all of which a developer will hit on their first afternoon:
 * a good env value signs in, a bad one lands on `/select-player`, and an
 * unreachable API says so instead of crashing (§19 "missing env config").
 */
import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError } from '../../../msw/handlers';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

describe('DevSessionProvider', () => {
  it('resolves VITE_DEFAULT_PLAYER_ID and lets routed pages render', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows the acting player in the header', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    expect(await screen.findByText('Trainer #1')).toBeInTheDocument();
  });

  it('falls back to /select-player when the id does not resolve', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText('No player selected')).toBeInTheDocument();
    expect(screen.getByText('No player with that id')).toBeInTheDocument();
    // The screen reports the env value it tried, not a generic failure — once
    // in the value table and once in the "here is what to edit" instruction.
    expect(screen.getAllByText('VITE_DEFAULT_PLAYER_ID')).toHaveLength(2);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('explains an unreachable Platform API rather than crashing', async () => {
    server.use(http.get('/api/v1/players/:playerId', () => Response.error()));

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText("Can't reach the Waifumon server")).toBeInTheDocument();
  });

  it('explains a rejected bearer token', async () => {
    server.use(
      http.get('/api/v1/players/:playerId', () => apiError(401, 'UNAUTHORIZED', 'Unauthorized.')),
    );

    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByText('The Platform API rejected the token')).toBeInTheDocument();
  });
});
