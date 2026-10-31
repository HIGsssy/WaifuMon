/**
 * Per-copy Seductive Power in the Collection.
 *
 * The Portal only displays and orders what the API served, so these fixtures use
 * values no formula would produce: a recalculating client fails on them. The API
 * half (the roll, level scaling, gear, the public allowlist) is pinned by
 * `tests/integration/api/collectionSeductivePower.test.ts`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import * as fixtures from '../../../../msw/fixtures';
import { data, page as pageEnvelope } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import type { OwnedEntry } from '@/api/types';
import { routes } from '@/app/router';
import { PUBLIC_SORT_OPTIONS, sortEntries } from '@/content/species';
import { renderRoutes } from '@/test/renderWithProviders';

function copy(
  id: number,
  nickname: string,
  current: number,
  overrides: { base?: number; level?: number; rarity?: OwnedEntry['species']['rarity'] } = {},
): OwnedEntry {
  const source = fixtures.ownedEntries[0]!;
  return {
    ...source,
    waifu: {
      ...source.waifu,
      id,
      nickname,
      level: overrides.level ?? source.waifu.level,
      seductivePower: { base: overrides.base ?? 100, current, formulaVersion: 1 },
    },
    species: { ...source.species, rarity: overrides.rarity ?? source.species.rarity },
  };
}

function serveCollection(entries: OwnedEntry[]) {
  server.use(
    http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
      const requested = Number(new URL(request.url).searchParams.get('page') ?? '1');
      const start = (requested - 1) * 25;
      return pageEnvelope(entries.slice(start, start + 25), requested, 25, entries.length);
    }),
  );
}

function renderUrl(url: string) {
  return renderRoutes({ routes, initialEntries: [url] });
}

const cardNames = async (pattern: RegExp) =>
  (await screen.findAllByRole('link', { name: pattern })).map(
    (card) => card.getAttribute('aria-label')?.split(',')[0] ?? '',
  );

describe('Collection cards', () => {
  it('shows each copy its own SP, even for two copies of one species', async () => {
    serveCollection([copy(1, 'Low Roll', 91), copy(2, 'High Roll', 247)]);
    renderUrl('/collection');

    const low = await screen.findByRole('link', { name: /^Low Roll/ });
    const high = screen.getByRole('link', { name: /^High Roll/ });

    expect(within(low).getByText('SP 91')).toBeInTheDocument();
    expect(within(high).getByText('SP 247')).toBeInTheDocument();
    expect(low).toHaveAccessibleName(/level \d+, SP 91/);
  });

  it('shows the served Current SP rather than the Base roll, and does not rescale it', async () => {
    serveCollection([copy(1, 'Levelled', 333, { base: 100, level: 50 })]);
    renderUrl('/collection');

    const card = await screen.findByRole('link', { name: /^Levelled/ });
    expect(within(card).getByText('SP 333')).toBeInTheDocument();
    expect(within(card).queryByText('SP 100')).toBeNull();
    expect(within(card).queryByText('SP 223')).toBeNull();
  });
});

describe('SP sorting', () => {
  // Lexicographically these would run 1003, 247, 99.
  const entries = [copy(1, 'Mid', 247), copy(2, 'Big', 1003), copy(3, 'Small', 99)];

  it('orders numerically in both directions', () => {
    const names = (sort: 'sp_desc' | 'sp_asc') =>
      sortEntries(entries, sort).map((entry) => entry.waifu.nickname);

    expect(names('sp_desc')).toEqual(['Big', 'Mid', 'Small']);
    expect(names('sp_asc')).toEqual(['Small', 'Mid', 'Big']);
  });

  it('breaks an SP tie by name', () => {
    const tied = [copy(1, 'Zed', 200), copy(2, 'Ann', 200)];
    for (const sort of ['sp_desc', 'sp_asc'] as const) {
      expect(sortEntries(tied, sort).map((entry) => entry.waifu.nickname)).toEqual(['Ann', 'Zed']);
    }
  });

  it('is offered with player-readable labels and writes the URL', async () => {
    const user = userEvent.setup();
    serveCollection(entries);
    renderUrl('/collection');

    await screen.findByRole('link', { name: /^Big/ });
    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    await user.click(await screen.findByRole('option', { name: 'SP: Lowest First' }));

    await waitFor(async () =>
      expect(await cardNames(/^(Big|Mid|Small)/)).toEqual(['Small', 'Mid', 'Big']),
    );
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('SP: Lowest First');

    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    expect(await screen.findByRole('option', { name: 'SP: Highest First' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Rarest first' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Name (A–Z)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Highest level' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Recently caught' })).toBeInTheDocument();
  });

  it('sorts the complete collection before slicing a page', async () => {
    // Ascending by id, so the strongest copies sit on the last API page.
    serveCollection(Array.from({ length: 60 }, (_, i) => copy(i + 1, `Copy ${i}`, 100 + i)));
    renderUrl('/collection?sort=sp_desc');

    const names = await cardNames(/^Copy/);
    expect(names).toHaveLength(25);
    expect(names.slice(0, 3)).toEqual(['Copy 59', 'Copy 58', 'Copy 57']);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  });

  it('applies filters first, then orders what remains by SP', async () => {
    serveCollection([
      copy(1, 'Rare Low', 120, { rarity: 'SR' }),
      copy(2, 'Ultra Top', 900, { rarity: 'UR' }),
      copy(3, 'Rare High', 480, { rarity: 'SR' }),
      copy(4, 'Other', 300, { rarity: 'SR' }),
    ]);
    renderUrl('/collection?rarity=SR&search=rare&sort=sp_desc');

    expect(await cardNames(/^(Rare|Ultra|Other)/)).toEqual(['Rare High', 'Rare Low']);
  });

  it('leaves the existing sorts unchanged', async () => {
    serveCollection([copy(1, 'Bravo', 900, { level: 2 }), copy(2, 'Alpha', 100, { level: 30 })]);
    renderUrl('/collection?sort=name');
    expect(await cardNames(/^(Alpha|Bravo)/)).toEqual(['Alpha', 'Bravo']);
  });

  it('falls back to the default for an unrecognised sort', async () => {
    serveCollection(entries);
    renderUrl('/collection?sort=sp_sideways');

    await screen.findByRole('link', { name: /^Big/ });
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Rarest first');
  });
});

describe('Owned detail', () => {
  it('shows Current SP with its Base roll and says gear is excluded', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId', () =>
        data(copy(101, 'Nyx', 333, { base: 150, level: 22 })),
      ),
    );
    renderUrl('/collection/101');

    await screen.findByRole('heading', { name: 'Nyx' });
    expect(screen.getByText('Seductive Power')).toBeInTheDocument();
    expect(screen.getByText(/333 SP/)).toBeInTheDocument();
    expect(screen.getByText('· base 150')).toBeInTheDocument();
    expect(screen.getByText(/Equipment bonuses are not included/)).toBeInTheDocument();
  });

  it('calls a Level 1 copy its base roll', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId', () =>
        data(copy(101, 'Fresh', 94, { base: 94, level: 1 })),
      ),
    );
    renderUrl('/collection/101');

    await screen.findByRole('heading', { name: 'Fresh' });
    expect(screen.getByText('· base roll')).toBeInTheDocument();
  });
});

describe('A guild-mate’s collection', () => {
  const OWNER_URL = `/players/42/collection`;

  it('never offers SP sorts', () => {
    expect(PUBLIC_SORT_OPTIONS.map((option) => option.value)).toEqual([
      'rarity',
      'name',
      'level',
      'caught',
    ]);
  });

  it('shows no SP on a card and no SP sort option', async () => {
    const user = userEvent.setup();
    renderUrl(OWNER_URL);

    await screen.findByRole('link', { name: /Vesper/ });
    expect(screen.queryByText(/^SP \d+/)).toBeNull();
    expect(screen.getByRole('link', { name: /Vesper/ })).not.toHaveAccessibleName(/SP \d+/);

    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    expect(await screen.findByRole('option', { name: 'Rarest first' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /SP:/ })).toBeNull();
  });

  it('treats a shared SP sort link as the default sort', async () => {
    renderUrl(`${OWNER_URL}?sort=sp_desc`);

    await screen.findByRole('link', { name: /Vesper/ });
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Rarest first');
  });

  it('shows no SP on a public copy’s detail', async () => {
    renderUrl(`${OWNER_URL}/501`);

    await screen.findByText('Level 40');
    expect(screen.queryByText('Seductive Power')).toBeNull();
    expect(screen.queryByText(/\d+ SP/)).toBeNull();
  });
});
