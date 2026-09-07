/**
 * Achievements page tests (plan §7, §27–§29).
 *
 * The load-bearing behaviours: the page renders the wall, filters by category
 * without refetching, shows progress for in-progress badges, and never reveals
 * a hidden, locked achievement's name, description or criteria — it shows the
 * concealed presentation the API sends and nothing more.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderAchievements(url = '/achievements') {
  return renderRoutes({ routes, initialEntries: [url] });
}

describe('AchievementsPage', () => {
  it('renders the summary and a card per achievement', async () => {
    renderAchievements();
    expect(await screen.findByText('2 / 5 Unlocked')).toBeInTheDocument();
    expect(await screen.findByText('First Hunt')).toBeInTheDocument();
    expect(screen.getByText('Budding Collector')).toBeInTheDocument();
  });

  it('shows progress for an in-progress achievement', async () => {
    renderAchievements();
    expect(await screen.findByText('Seasoned Hunter')).toBeInTheDocument();
    expect(screen.getByText('82 / 100')).toBeInTheDocument();
  });

  it('conceals a hidden, locked achievement and leaks no criteria', async () => {
    renderAchievements();
    // The hidden badge shows the generic presentation.
    expect(await screen.findByText('Hidden Achievement')).toBeInTheDocument();
    expect(screen.getByText('???')).toBeInTheDocument();
    // Its real name and threshold never render.
    expect(screen.queryByText('Soulbound')).not.toBeInTheDocument();
    expect(screen.queryByText(/5000/)).not.toBeInTheDocument();
  });

  it('filters by category from the toolbar without dropping the view', async () => {
    const user = userEvent.setup();
    renderAchievements();
    await screen.findByText('First Hunt');

    // Switch to Collection — hunting badges disappear, collection stays.
    await user.click(screen.getByRole('tab', { name: 'Collection' }));
    await waitFor(() => expect(screen.queryByText('First Hunt')).not.toBeInTheDocument());
    expect(screen.getByText('Budding Collector')).toBeInTheDocument();
  });

  it('reads the category filter from the URL on first render', async () => {
    renderAchievements('/achievements?category=collection');
    expect(await screen.findByText('Budding Collector')).toBeInTheDocument();
    expect(screen.queryByText('First Hunt')).not.toBeInTheDocument();
  });

  it('marks unlocked and locked cards distinctly', async () => {
    renderAchievements();
    await screen.findByText('First Hunt');
    const cards = screen.getAllByTestId('achievement-card');
    const unlocked = cards.filter((c) => c.getAttribute('data-unlocked') === 'true');
    expect(unlocked.length).toBe(2);
    // The unlocked cards announce their state for assistive tech.
    expect(within(unlocked[0]!).getByLabelText('Unlocked')).toBeInTheDocument();
  });
});
