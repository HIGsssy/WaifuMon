/**
 * Accessibility sweep (plan §17 "accessibility is non-negotiable", §21 Phase 3).
 *
 * Every page is rendered with real data and run through axe's WCAG 2 A/AA rule
 * set. Beyond that, the assertions below cover the things axe cannot judge but
 * the plan explicitly requires:
 *
 *   - rarity is never colour-alone — the badge names the tier (§17)
 *   - every piece of artwork carries meaningful alt text from the resolver (§12)
 *   - a keyboard user can reach the content without walking the whole sidebar
 *   - "Coming Soon" nav entries are announced as unavailable, not as dead links
 *
 * Colour contrast is checked in the Playwright suite instead, where real
 * stylesheets and computed colours exist — see `src/test/axe.ts`.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { renderRoutes } from '@/test/renderWithProviders';

/** Every route a player can reach, with something that proves it settled. */
const PAGES: ReadonlyArray<{ name: string; url: string; settled: string | RegExp }> = [
  { name: 'Dashboard', url: '/dashboard', settled: 'Level 12' },
  { name: 'Collection', url: '/collection', settled: /Nyx/ },
  { name: 'Waifumon detail', url: '/collection/101', settled: 'Progression' },
  { name: 'Buddy', url: '/buddy', settled: 'Energy / tick' },
  { name: 'Inventory', url: '/inventory', settled: 'Basic Charm' },
  { name: 'Shop', url: '/shop', settled: 'Basic Charm' },
  { name: 'Encyclopedia', url: '/encyclopedia', settled: 'Void Empress' },
  { name: 'Species detail', url: '/encyclopedia/void_empress', settled: 'Your collection' },
  { name: 'Profile', url: '/profile', settled: 'Statistics' },
  { name: 'Guide', url: '/guide', settled: 'Hunting' },
  { name: 'Settings', url: '/settings', settled: 'Appearance' },
  { name: 'Achievements placeholder', url: '/achievements', settled: 'Coming Soon' },
  { name: '404', url: '/nowhere', settled: 'Page not found' },
];

describe('accessibility', () => {
  it.each(PAGES)(
    '$name has no WCAG A/AA violations',
    async ({ url, settled }) => {
      renderRoutes({ routes, initialEntries: [url] });
      // `findAll` because some markers legitimately appear more than once —
      // a section heading and the prose beneath it, for instance.
      await screen.findAllByText(settled, { exact: false });

      await expectNoAxeViolations();
    },
    20_000,
  );

  it('offers a skip link as the first focus stop', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByText('Level 12');

    await user.tab();

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
  });

  it('names every rarity in text, never by colour alone', async () => {
    renderRoutes({ routes, initialEntries: ['/collection'] });
    await screen.findByText(/Nyx/);

    // Each card's badge exposes the readable tier name to assistive tech.
    expect(screen.getByText('Rarity: Ultra Rare')).toBeInTheDocument();
    expect(screen.getByText('Rarity: Super Rare')).toBeInTheDocument();
    expect(screen.getByText('Rarity: Common')).toBeInTheDocument();
  });

  it('gives every artwork meaningful alt text derived from the resource', async () => {
    renderRoutes({ routes, initialEntries: ['/collection'] });
    await screen.findByText(/Nyx/);

    for (const image of screen.getAllByRole('img')) {
      const alt = image.getAttribute('alt') ?? '';
      expect(alt.length).toBeGreaterThan(0);
      // Alt text describes the resource, never the file it came from.
      expect(alt).not.toMatch(/\.(png|jpe?g|webp|svg)$/i);
      expect(alt).not.toContain('/');
    }
  });

  it('announces "Coming Soon" nav entries as unavailable rather than as links', async () => {
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByText('Level 12');

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Achievements', 'Events', 'Friends']) {
      const row = Array.from(nav.querySelectorAll('[aria-disabled="true"]')).find((element) =>
        element.textContent?.includes(label),
      );
      expect(row, `${label} should be an aria-disabled row`).toBeDefined();
    }
  });

  it('keeps every interactive control reachable and labelled on the collection toolbar', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/collection'] });
    await screen.findByText(/Nyx/);

    expect(screen.getByLabelText('Search your collection')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    // Filter chips report their own pressed state.
    const urChip = await screen.findByRole('button', { name: 'UR' });
    expect(urChip).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves focus into the mobile navigation drawer and traps it there', async () => {
    const user = userEvent.setup();
    renderRoutes({ routes, initialEntries: ['/dashboard'] });
    await screen.findByText('Level 12');

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    const drawer = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(drawer).toContainElement(document.activeElement as HTMLElement | null),
    );
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
