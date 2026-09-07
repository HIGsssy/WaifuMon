/**
 * Leaderboards page tests (plan §13, §30–§32).
 *
 * The load-bearing behaviours: the page renders a ranked list, switches metric,
 * links each row to the existing public profile, highlights the caller's own
 * row — and, above all, **never renders a raw metric value** (plan §10). The
 * fixture carries no value, so the page cannot, and this suite locks that in.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { data } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderLeaderboards(url = '/leaderboards') {
  return renderRoutes({ routes, initialEntries: [url] });
}

describe('LeaderboardsPage', () => {
  it('renders a ranked list for the default metric', async () => {
    renderLeaderboards();
    expect(await screen.findByRole('link', { name: /Vex/ })).toBeInTheDocument();
    expect(screen.getByText('Aiko')).toBeInTheDocument();
  });

  it('links each row to the existing public profile', async () => {
    renderLeaderboards();
    const row = await screen.findByRole('link', { name: /Vex/ });
    expect(row).toHaveAttribute('href', '/players/7');
  });

  it('highlights the caller\'s own row', async () => {
    renderLeaderboards();
    const mine = await screen.findByRole('link', { name: /You/ });
    expect(mine).toHaveAttribute('href', `/players/${fixtures.PLAYER_ID}`);
  });

  it('never renders a raw metric value', async () => {
    // A board whose (backend-only) values are large; the API still omits them,
    // so no digits from a score may appear on screen.
    renderLeaderboards();
    await screen.findByRole('link', { name: /Vex/ });
    // Ranks 1, 2, 2, 4 are the only numerals expected — never a score.
    expect(screen.queryByText(/125000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bxp\b/i)).not.toBeInTheDocument();
  });

  it('switches metric from the toolbar', async () => {
    const user = userEvent.setup();
    let requestedMetric: string | null = null;
    server.use(
      http.get('/api/v1/leaderboards', ({ request }) => {
        requestedMetric = new URL(request.url).searchParams.get('metric');
        return data({ ...fixtures.leaderboardResponse, metric: requestedMetric ?? 'trainer' });
      }),
    );

    renderLeaderboards();
    await screen.findByRole('link', { name: /Vex/ });
    await user.click(screen.getByRole('tab', { name: 'Elite Hunters' }));
    await waitFor(() => expect(requestedMetric).toBe('hunter'));
  });

  it('shows the caller\'s rank when they are outside the visible page', async () => {
    server.use(
      http.get('/api/v1/leaderboards', () =>
        data({
          metric: 'trainer',
          entries: [
            { rank: 1, playerId: 7, displayName: 'Vex', avatarUrl: null, isMe: false },
          ],
          me: { rank: 12 },
        }),
      ),
    );
    renderLeaderboards();
    await screen.findByRole('link', { name: /Vex/ });
    expect(await screen.findByText(/not in the top/)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
