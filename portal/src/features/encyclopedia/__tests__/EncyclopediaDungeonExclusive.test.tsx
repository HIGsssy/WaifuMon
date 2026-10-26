/**
 * The Encyclopedia's Dungeon Exclusive filter.
 *
 * It filters on the species' `dungeon_exclusive` classification tag over the
 * same enabled-only catalogue the page always shows, so the rules these tests
 * hold are the Zone filter's: undiscovered dungeon-exclusive species stay in
 * as silhouettes revealing nothing new, and a disabled one never appears.
 *
 * The dataset: 4 dungeon-exclusive species (Valkyrie and Moth owned; Kitsune
 * and Imp not), 1 disabled dungeon-exclusive (never listed), and 4 regular
 * species (2 owned). 8 enabled species, 4 discovered.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { data, page as pageEnvelope } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';
import type { ContentSpecies, OwnedEntry, Rarity } from '@/api/types';

interface Spec {
  slug: string;
  name: string;
  tags: string[];
  owned: boolean;
  rarity: Rarity;
  enabled?: boolean;
}

const DX = ['dungeon_exclusive'];

const SPECS: Spec[] = [
  { slug: 'forgotten_valkyrie', name: 'Forgotten Valkyrie', tags: DX, owned: true, rarity: 'SSR' },
  { slug: 'glint_moth', name: 'Glint Moth', tags: DX, owned: true, rarity: 'R' },
  { slug: 'copper_kitsune', name: 'Copper Kitsune', tags: DX, owned: false, rarity: 'SR' },
  { slug: 'boiler_imp', name: 'Boiler Imp', tags: DX, owned: false, rarity: 'N' },
  {
    slug: 'sealed_wyrm',
    name: 'Sealed Wyrm',
    tags: DX,
    owned: false,
    rarity: 'SR',
    enabled: false,
  },
  ...[0, 1, 2, 3].map((i) => ({
    slug: `wv_${i}`,
    name: `Valley Maid ${i}`,
    tags: ['starter', 'waifu_valley'],
    owned: i < 2,
    rarity: (i % 2 === 0 ? 'SR' : 'N') as Rarity,
  })),
];

const BASE_SPECIES = fixtures.contentSpecies[0]!;
const BASE_OWNED = fixtures.ownedEntries[0]!;

function contentSpecies(): ContentSpecies[] {
  return SPECS.map(({ slug, name, tags, rarity, enabled }) => {
    const { buddyBonus: _bonus, ...rest } = BASE_SPECIES;
    return { ...rest, slug, name, tags, rarity, enabled: enabled ?? true, appearances: [] };
  });
}

function ownedCollection(): OwnedEntry[] {
  return SPECS.filter((spec) => spec.owned).map((spec, index) => ({
    ...BASE_OWNED,
    waifu: { ...BASE_OWNED.waifu, id: 7_000 + index, nickname: null },
    species: { ...BASE_OWNED.species, slug: spec.slug, name: spec.name, tags: spec.tags },
  }));
}

function serve(): void {
  const owned = ownedCollection();
  server.use(
    http.get('/api/v1/content/species', () => data(contentSpecies())),
    http.get('/api/v1/players/:playerId/collection/owned', () =>
      pageEnvelope(owned, 1, 25, owned.length),
    ),
  );
}

async function renderAt(url: string): Promise<void> {
  serve();
  renderRoutes({ routes, initialEntries: [url] });
  await screen.findByText(/\d+ \/ \d+ owned$/);
}

function tiles(): HTMLElement[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.startsWith('/encyclopedia/'));
}

function undiscoveredTiles(): HTMLElement[] {
  return tiles().filter((tile) => /^Not owned, /.test(tile.getAttribute('aria-label') ?? ''));
}

function hrefs(): string[] {
  return tiles()
    .map((tile) => tile.getAttribute('href') ?? '')
    .sort();
}

const UNDISCOVERED_NAMES = SPECS.filter((spec) => !spec.owned).map((spec) => spec.name);

function expectNoUndiscoveredNames(): void {
  const text = document.body.textContent ?? '';
  for (const name of UNDISCOVERED_NAMES) expect(text).not.toContain(name);
}

describe('Encyclopedia Dungeon Exclusive filter', () => {
  it('lists every enabled species, regular and dungeon-exclusive, without the filter', async () => {
    await renderAt('/encyclopedia');

    expect(await screen.findByText('4 / 8 owned')).toBeInTheDocument();
    expect(tiles()).toHaveLength(8);
    expect(screen.queryByRole('button', { name: 'Dungeon Exclusive' })).toBeNull();
  });

  it('?exclusive=dungeon keeps only enabled dungeon-exclusive species, discovered or not', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon');

    await waitFor(() => expect(tiles()).toHaveLength(4));
    expect(hrefs()).toEqual([
      '/encyclopedia/boiler_imp',
      '/encyclopedia/copper_kitsune',
      '/encyclopedia/forgotten_valkyrie',
      '/encyclopedia/glint_moth',
    ]);
    expect(screen.getByText('Forgotten Valkyrie')).toBeInTheDocument();
    expect(screen.getByText('Glint Moth')).toBeInTheDocument();
    // The chip names the active filter; the disabled one never appears.
    expect(screen.getByRole('button', { name: 'Dungeon Exclusive' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Sealed Wyrm');
  });

  it('keeps undiscovered dungeon-exclusive species gated: silhouettes, ???, no names', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon');

    await waitFor(() => expect(tiles()).toHaveLength(4));
    expect(undiscoveredTiles()).toHaveLength(2);
    expect(screen.getAllByText('???')).toHaveLength(2);
    expect(screen.getAllByAltText('Undiscovered Waifumon silhouette')).toHaveLength(2);
    for (const tile of undiscoveredTiles()) {
      expect(tile).not.toHaveTextContent(/Kitsune|Imp|Dungeon/);
    }
    expectNoUndiscoveredNames();
  });

  it('combines with rarity across discovery states', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon&rarity=SR');

    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(hrefs()).toEqual(['/encyclopedia/copper_kitsune']);
    expect(undiscoveredTiles()).toHaveLength(1);
    expectNoUndiscoveredNames();
  });

  it('combines with ownership', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon&discovery=undiscovered');

    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(undiscoveredTiles()).toHaveLength(2);
    // The tally still describes the whole dex, not the narrowed list.
    expect(screen.getByText('4 / 8 owned')).toBeInTheDocument();
  });

  it('combines with search, which still only matches discovered species', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon&search=moth');

    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(hrefs()).toEqual(['/encyclopedia/glint_moth']);
  });

  it('never finds an undiscovered dungeon-exclusive species by name', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon&search=kitsune');

    expect(await screen.findByText('No species match your filters')).toBeInTheDocument();
    expectNoUndiscoveredNames();
  });

  it('shows the empty state when nothing matches', async () => {
    await renderAt('/encyclopedia?exclusive=dungeon&zone=waifu_valley');

    expect(await screen.findByText('No species match your filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear All' })).toBeInTheDocument();
  });

  it.each(['region', 'all', 'DUNGEON', ''])('treats ?exclusive=%s as no filter', async (value) => {
    await renderAt(`/encyclopedia?exclusive=${value}`);

    await waitFor(() => expect(tiles()).toHaveLength(8));
    expect(screen.queryByRole('button', { name: 'Dungeon Exclusive' })).toBeNull();
  });

  it('selects from the panel, and the chip and Clear All both remove it', async () => {
    const user = userEvent.setup();
    await renderAt('/encyclopedia');

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const group = await screen.findByRole('group', { name: 'Exclusivity' });
    expect(within(group).getByRole('button', { name: 'Any' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: 'Dungeon Exclusive' }));
    await waitFor(() => expect(tiles()).toHaveLength(4));
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Dungeon Exclusive' }));
    await waitFor(() => expect(tiles()).toHaveLength(8));

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(
      within(await screen.findByRole('group', { name: 'Exclusivity' })).getByRole('button', {
        name: 'Dungeon Exclusive',
      }),
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tiles()).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    await waitFor(() => expect(tiles()).toHaveLength(8));
  });
});
