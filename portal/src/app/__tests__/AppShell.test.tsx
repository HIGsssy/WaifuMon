import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

describe('AppShell', () => {
  it('renders the shell without dev-mode presentation chrome and with the full navigation', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByText(/DEV MODE/i)).toBeNull();
    expect(screen.queryByTitle(/No authentication/i)).toBeNull();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of [
      'Dashboard',
      'Collection',
      'Buddy',
      'Inventory',
      'Shop',
      'Encyclopedia',
      'Guide',
      'Profile',
      // Players replaced the reserved "Friends" placeholder — see
      // `app/navigation.ts` for why the name changed with it.
      'Players',
      'Achievements',
      'Leaderboards',
      'Events',
      'Settings',
    ]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
  });

  it('navigates between pages without a full-page loading state', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    await screen.findByRole('heading', { name: 'Dashboard' });

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(within(nav).getByRole('link', { name: 'Collection' }));

    expect(await screen.findByRole('heading', { name: 'Collection' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('renders "Coming Soon" entries as inert, not as links', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByRole('heading', { name: 'Dashboard' });

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    // Events is still a reserved placeholder; Achievements and Leaderboards
    // have shipped and are now real links.
    expect(within(nav).queryByRole('link', { name: /Events/ })).toBeNull();
    expect(within(nav).getByText('Events').closest('[aria-disabled="true"]')).not.toBeNull();
    expect(within(nav).getByRole('link', { name: /Achievements/ })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /Leaderboards/ })).toBeInTheDocument();
  });

  it('redirects the index route to the dashboard', async () => {
    renderRoutes({ routes, initialEntries: ['/'] });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument(),
    );
  });

  it('renders the 404 page for an unknown URL', async () => {
    renderRoutes({ routes, initialEntries: ['/nope'] });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
