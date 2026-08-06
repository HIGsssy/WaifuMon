/**
 * Waifumon detail tests (plan §22.2, §8.3).
 *
 * The placeholder assertions matter as much as the data ones: §16 requires
 * missing data to be shown as an honest gap, so a future change that quietly
 * invents a stat block should fail here.
 */
import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderDetail(waifuId: string | number) {
  return renderRoutes({ routes, initialEntries: [`/collection/${waifuId}`] });
}

describe('WaifumonDetailPage', () => {
  it('renders the hero, identity, progression and capture cards', async () => {
    renderDetail(101);

    expect(await screen.findByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
    // Nickname is the title; the species name becomes the subtitle.
    expect(screen.getByText('Void Empress')).toBeInTheDocument();

    expect(screen.getByLabelText('Rarity: Ultra Rare')).toBeInTheDocument();
    expect(screen.getByText('Level 22')).toBeInTheDocument();
    expect(screen.getByText('5,400 XP total')).toBeInTheDocument();

    // Progression comes from the API's `progress` block, never recomputed.
    expect(screen.getByLabelText('Experience to next level')).toBeInTheDocument();
    expect(screen.getByLabelText('Affection: 64')).toBeInTheDocument();
  });

  it('shows honest placeholders instead of inventing missing data', async () => {
    renderDetail(101);

    expect(await screen.findByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
    expect(screen.getByText(/combat is not modelled/i)).toBeInTheDocument();
    expect(screen.getByText(/Evolution is not part of the content model/i)).toBeInTheDocument();
    expect(screen.getByText(/attempt chain for a catch/i)).toBeInTheDocument();
  });

  it('offers no gameplay actions — the Portal is read-only', async () => {
    renderDetail(101);
    await screen.findByRole('heading', { name: 'Nyx' });

    for (const label of [/release/i, /rename/i, /set buddy/i, /favourite this/i, /evolve/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('links to the species encyclopedia entry', async () => {
    renderDetail(101);

    const link = await screen.findByRole('link', { name: /View species/ });
    expect(link).toHaveAttribute('href', '/encyclopedia/void_empress');
  });

  it('renders a 404 for a copy the player does not own', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId', () =>
        apiError(404, 'WAIFU_NOT_OWNED', 'You do not own that Waifumon.'),
      ),
    );

    renderDetail(999);

    expect(await screen.findByText('You do not own that Waifumon')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Collection' })).toBeInTheDocument();
  });

  it('renders a 404 for an id that is not a number, without calling the API', async () => {
    renderDetail('not-an-id');
    expect(await screen.findByText('Not a Waifumon')).toBeInTheDocument();
  });

  it('shows an inline error with retry for a server failure', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderDetail(101);

    expect(await screen.findByText("Couldn't load that Waifumon.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
