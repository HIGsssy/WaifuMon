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
import type { OwnedEntry } from '@/api/types';

function renderCollection(url = '/collection') {
  return renderRoutes({ routes, initialEntries: [url] });
}

function collectionSpreadAcrossPages(matchCount = 4): OwnedEntry[] {
  const matchIndexes = new Set(
    Array.from({ length: matchCount }, (_, index) =>
      Math.floor((index * 59) / Math.max(1, matchCount - 1)),
    ),
  );

  return Array.from({ length: 60 }, (_, index) => {
    const matches = matchIndexes.has(index);
    const source = fixtures.ownedEntries[matches ? 1 : 0]!;
    return {
      ...source,
      waifu: {
        ...source.waifu,
        id: matches && index === 59 ? fixtures.buddyEntry.waifu.id : 1_000 + index,
        nickname: matches ? `Needle Match ${index}` : `Other Copy ${index}`,
        isFavorite: matches,
      },
      species: {
        ...source.species,
        rarity: matches ? 'SR' : 'UR',
        race: matches ? 'spirit' : 'demon',
        affinity: matches ? 'submissive' : 'primal',
      },
    };
  });
}

function servePagedCollection(entries: OwnedEntry[]) {
  server.use(
    http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
      const requested = Number(new URL(request.url).searchParams.get('page') ?? '1');
      const pageSize = 25;
      const start = (requested - 1) * pageSize;
      return pageEnvelope(
        entries.slice(start, start + pageSize),
        requested,
        pageSize,
        entries.length,
      );
    }),
  );
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

    // The full collection is loaded first, then rarity is applied locally.
    expect(await screen.findByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull());
  });

  it('searches the complete collection before pagination', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Nyx/ });

    await user.type(screen.getByLabelText('Search your collection'), 'kitsune');

    await waitFor(() => expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull());
    expect(screen.getByRole('link', { name: /Neon Kitsune/ })).toBeInTheDocument();
  });

  it('applies a rarity filter without blanking the retained matching cards', async () => {
    const user = userEvent.setup();
    renderCollection();

    await screen.findByRole('link', { name: /Neko Barista/ });

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'UR' }));

    // Filtering an already-loaded collection does not enter a loading state.
    expect(screen.getByRole('link', { name: /Nyx/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading your collection')).toBeNull();
    expect(screen.queryByRole('link', { name: /Neko Barista/ })).toBeNull();
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
    servePagedCollection(collectionSpreadAcrossPages(4));

    renderCollection();

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
  });

  it('compacts affinity matches from multiple source pages before calculating pages', async () => {
    servePagedCollection(collectionSpreadAcrossPages(4));

    renderCollection('/collection?affinity=submissive');

    expect(await screen.findAllByRole('link', { name: /Needle Match/ })).toHaveLength(4);
    expect(screen.queryByRole('link', { name: /Other Copy/ })).toBeNull();
    expect(screen.queryByLabelText('Collection pages')).toBeNull();
  });

  it.each([
    ['rarity', '/collection?rarity=SR', 4],
    ['type', '/collection?type=spirit', 4],
    ['search', '/collection?search=Needle', 4],
    ['favourites', '/collection?ownership=favorites', 4],
    ['buddy', '/collection?ownership=buddy', 1],
  ])('applies %s across the complete dataset before pagination', async (_filter, url, count) => {
    servePagedCollection(collectionSpreadAcrossPages(4));

    renderCollection(url);

    expect(await screen.findAllByRole('link', { name: /Needle Match/ })).toHaveLength(count);
    expect(screen.queryByLabelText('Collection pages')).toBeNull();
  });

  it('bases page count on the filtered total', async () => {
    servePagedCollection(collectionSpreadAcrossPages(28));

    renderCollection('/collection?affinity=submissive');

    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Needle Match/ })).toHaveLength(25);
  });

  it('resets a later page when a filter changes', async () => {
    const user = userEvent.setup();
    servePagedCollection(collectionSpreadAcrossPages(4));
    renderCollection('/collection?page=3');

    expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'Submissive' }));

    expect(await screen.findAllByRole('link', { name: /Needle Match/ })).toHaveLength(4);
    expect(screen.queryByLabelText('Collection pages')).toBeNull();
  });

  it('clamps an out-of-range page against the filtered result', async () => {
    servePagedCollection(collectionSpreadAcrossPages(28));
    renderCollection('/collection?affinity=submissive&page=3');

    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Needle Match/ })).toHaveLength(3);
  });
});
