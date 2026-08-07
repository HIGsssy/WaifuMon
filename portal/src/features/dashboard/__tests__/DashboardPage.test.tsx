/**
 * Dashboard page tests (plan §22.2): loading, success, empty and error.
 *
 * The error case is the one worth reading closely — it asserts §19's "partial
 * responses" rule, that a failing tile does not take the page with it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderDashboard() {
  return renderRoutes({ routes, initialEntries: ['/dashboard'] });
}

describe('DashboardPage', () => {
  it('renders the trainer, buddy, balances and dex progress', async () => {
    renderDashboard();

    // The API's display name wins over the "Trainer #id" fallback.
    expect(await screen.findAllByText('Mika')).not.toHaveLength(0);
    expect(await screen.findByText('Level 12')).toBeInTheDocument();

    // Buddy hero — the nickname, not the species name. It appears twice: once
    // in the hero, once as the Buddy quick-launch tile's caption.
    expect(await screen.findAllByText('Nyx')).toHaveLength(2);
    expect(screen.getByText('Active buddy')).toBeInTheDocument();

    // Balances, thousands-separated.
    expect(await screen.findByText('34')).toBeInTheDocument();
    expect(screen.getByText('1,820')).toBeInTheDocument();
    expect(screen.getByText('46')).toBeInTheDocument();

    // Dex progress: 18 of 58 distinct species.
    expect(await screen.findByText('18 / 58')).toBeInTheDocument();
    expect(screen.getByText(/23 owned/)).toBeInTheDocument();
  });

  it('shows skeletons — never a spinner — while data is in flight', async () => {
    // Hold the responses open so the loading state is observable at all.
    server.use(
      http.get('/api/v1/players/:playerId/profile', async () => {
        await delay(120);
        return data({ player: fixtures.player, currencies: fixtures.currencies });
      }),
    );

    renderDashboard();

    // §14: the page frame paints as soon as the route resolves; the body fills
    // in beneath it. There is no full-page loading state to wait through.
    const heading = await screen.findByRole('heading', { name: 'Dashboard' });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);

    expect(await screen.findByText('Level 12')).toBeInTheDocument();
  });

  it('renders an intentional layout for a brand-new player', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/profile', () =>
        data({
          player: { ...fixtures.player, level: 1, xp: 0, buddyWaifuId: null },
          currencies: { ...fixtures.currencies, huntEnergy: 0, waifubux: 0, essence: 0 },
        }),
      ),
      http.get('/api/v1/players/:playerId/collection/buddy', () =>
        apiError(404, 'BUDDY_NOT_SET', 'No buddy is set.'),
      ),
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        data({ owned: 0, distinctSpecies: 0, totalSpecies: 58 }),
      ),
    );

    renderDashboard();

    expect(await screen.findByText('No buddy set')).toBeInTheDocument();
    expect(await screen.findByText('0 / 58')).toBeInTheDocument();
    // Zeros, not an error screen.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps rendering when one tile fails, and offers a retry', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderDashboard();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load your collection progress.")).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // The rest of the page is unaffected — §19 "partial responses".
    await waitFor(() => expect(screen.getByText('Level 12')).toBeInTheDocument());
    expect(screen.getAllByText('Nyx').length).toBeGreaterThan(0);
  });

  it('falls back to Trainer #id when the API cannot resolve an identity', async () => {
    // Concrete id, not `:playerId` — a param pattern also matches
    // `/players/lookup`, which the dev session provider needs to keep working.
    server.use(http.get('/api/v1/players/1', () => data({ ...fixtures.player, identity: null })));

    renderDashboard();

    expect(await screen.findAllByText('Trainer #1')).not.toHaveLength(0);
  });
});
