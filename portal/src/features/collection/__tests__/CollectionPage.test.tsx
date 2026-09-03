/**
 * Collection page tests (plan §22.2, §22.6).
 *
 * Beyond the four required states, two tests exist because the plan singles
 * them out as things that regress quietly:
 *
 *   - **Previous-data retention** (§14, §22.6, §24.15): changing a filter must
 *     keep the current grid on screen rather than blanking it.
 *   - **URL-backed filters** (§7): the query string is the state, so back and
 *     forward have to move through filter history.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, page as pageEnvelope } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderCollection(url = '/collection') {
  return renderRoutes({ routes, initialEntries: [url] });
}

describe('CollectionPage', () => {
  it('renders a card per owned copy, with rarity named as well as coloured', async () => {
    renderCollection();

    expect(await screen.findByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Neon Kitsune/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Neko Barista/ })).toBeInTheDocument();

    // §17: rarity is never colour-alone — the badge carries an accessible name.
    expect(screen.getByText('Rarity: Ultra Rare')).toBeInTheDocument();
    expect(screen.getByText('Rarity: Super Rare')).toBeInTheDocument();
  });

  it('shows skeleton cards on a cold load', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', async () => {
        await delay(120);
        return pageEnvelope(fixtures.ownedEntries);
      }),
    );

    renderCollection();

    const grid = await screen.findByLabelText('Loading your collection');
    // Card skeletons mirror the real card's footprint, so the grid does not
    // shift when the artwork lands (§14).
    expect(grid.querySelectorAll('.skeleton').length).toBeGreaterThan(0);

    expect(await screen.findByRole('link', { name: /Nyx/ })).toBeInTheDocument();
  });

  it('invites the player to Discord when the collection is empty', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope([], 1, 25, 0)),
    );

    renderCollection();

    expect(await screen.findByText('Your collection is empty')).toBeInTheDocument();
    expect(screen.getByText(/waifumon hunt/)).toBeInTheDocument();
  });

  it('offers a retry when the collection fails to load', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderCollection();

    expect(await screen.findByText("Couldn't load your collection.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('reads filters from the URL on first render', async () => {
    renderCollection('/collection?rarity=UR');

    // The rarity filter is server-side, so the mock returns only the UR copy.
    expect(await screen.findByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull());
  });

  it('narrows the current page client-side and says that is what it did', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Nyx/ });

    await user.type(screen.getByLabelText('Search the current page of your collection'), 'kitsune');

    expect(await screen.findByText('Showing 1 of 3 on this page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Neon Kitsune/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull();
  });

  it('keeps the previous grid on screen while a filter change loads', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Neko Barista/ });

    // Make the next response slow enough that a blanking bug would be visible.
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', async () => {
        await delay(150);
        return pageEnvelope(fixtures.ownedEntries.filter((e) => e.species.rarity === 'UR'));
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'UR' }));

    // §14 / §24.15: the old cards stay put, and a quiet indicator explains why.
    expect(screen.getByRole('link', { name: /Neko Barista/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing...');
    expect(screen.queryByLabelText('Loading your collection')).toBeNull();

    await waitFor(() => expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull());
  });

  it('opens and closes compact filters without losing the selected type', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Nyx/ });
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'Spirit' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByText('Type')).toBeNull();
    expect(screen.getByRole('button', { name: /Type: Spirit/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Neon Kitsune/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Nyx/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const popover = await screen.findByRole('button', { name: 'Spirit' });
    expect(popover).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes individual filter chips and clears all collection filters', async () => {
    const user = userEvent.setup();
    renderCollection('/collection?type=spirit&affinity=submissive&ownership=favorites');

    await screen.findByRole('heading', { name: 'Collection' });
    await user.click(screen.getByRole('button', { name: /Affinity: Submissive/ }));

    expect(screen.queryByRole('button', { name: /Affinity: Submissive/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Type: Spirit/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Clear All' }));

    expect(screen.queryByRole('button', { name: /Type: Spirit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Favourites/ })).toBeNull();
    expect(await screen.findByRole('link', { name: /Nyx/ })).toBeInTheDocument();
  });

  it('keeps favourite and buddy ownership filters working in the compact panel', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Nyx/ });
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'Favourites' }));

    expect(screen.getByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Neon Kitsune/ })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Buddy' }));

    expect(screen.getByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull();
  });

  it('uses canonical race values for Type filters instead of malformed archetype prose', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () =>
        pageEnvelope([
          {
            ...fixtures.ownedEntries[0]!,
            species: {
              ...fixtures.ownedEntries[0]!.species,
              archetype: 'bronze-scaled dragongirl caravan master',
              race: 'demi-human',
            },
          },
        ]),
      ),
    );

    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Nyx/ });
    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(screen.getByRole('button', { name: 'Demi Human' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bronze Scaled Dragongirl/ })).toBeNull();
  });

  it('paginates, and the page lives in the URL', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
        const requested = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return pageEnvelope(fixtures.ownedEntries, requested, 25, 60);
      }),
    );

    renderCollection();

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
  });
});
