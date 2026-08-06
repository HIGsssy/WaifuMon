/**
 * Phase 0 smoke test (plan §21): the shell renders and navigation works.
 *
 * Exercises the real provider stack, the real router config, and the real
 * `DevSessionProvider` resolving against MSW — so a break in any of those three
 * fails here rather than in a browser.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

describe('AppShell', () => {
  it('renders the shell, the dev-mode marker and the full navigation', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    // The dev-auth marker is always present — §26's mitigation for "users
    // mistake dev-auth for real auth".
    expect(screen.getAllByText(/dev/i).length).toBeGreaterThan(0);

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
      'Achievements',
      'Events',
      'Friends',
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
    // The shell survives the route change (§14).
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('renders "Coming Soon" entries as inert, not as links', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByRole('heading', { name: 'Dashboard' });

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: /Achievements/ })).toBeNull();
    expect(within(nav).getByText('Achievements').closest('[aria-disabled="true"]')).not.toBeNull();
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
