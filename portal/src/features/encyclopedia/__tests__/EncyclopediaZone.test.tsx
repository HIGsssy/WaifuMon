/**
 * The Encyclopedia's Zone filter.
 *
 * Its purpose is "which Waifumon am I still missing from Twin Peeks?", so the
 * rule these tests hold is that a zone's result includes its **undiscovered**
 * species — as silhouettes, revealing nothing beyond what an undiscovered tile
 * always shows.
 *
 * The dataset below: 4 Waifu Valley (2 owned), 5 Twin Peeks (3 owned),
 * 3 Flaccid Foothills (none owned), 2 Thirstlands (both owned), and 2 species
 * with no recognised zone tag — one carrying an unreleased zone's tag, which
 * must not become a filter option. 16 species, 7 discovered.
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
  rarity?: Rarity;
}

const SPECS: Spec[] = [
  ...[0, 1, 2, 3].map((i) => ({
    slug: `wv_${i}`,
    name: `Valley Maid ${i}`,
    tags: ['starter', 'waifu_valley'],
    owned: i < 2,
  })),
  ...[0, 1, 2, 3, 4].map((i) => ({
    slug: `tp_${i}`,
    name: `Peak Oracle ${i}`,
    tags: ['expansion', 'region_exclusive', 'twin_peeks'],
    // 0, 2, 4 owned; 1 and 3 are the ones still missing.
    owned: i % 2 === 0,
    rarity: (i < 2 ? 'SR' : 'N') as Rarity,
  })),
  ...[0, 1, 2].map((i) => ({
    slug: `ff_${i}`,
    name: `Foothill Hermit ${i}`,
    tags: ['expansion', 'region_exclusive', 'flaccid_foothills'],
    owned: false,
  })),
  ...[0, 1].map((i) => ({
    slug: `th_${i}`,
    name: `Dune Courier ${i}`,
    tags: ['expansion', 'region_exclusive', 'thirstlands'],
    owned: true,
  })),
  { slug: 'nz_0', name: 'Orbit Drifter', tags: ['expansion', 'region_exclusive'], owned: false },
  {
    slug: 'nz_1',
    name: 'Asteroid Miner',
    tags: ['expansion', 'region_exclusive', 'assteroid_belt'],
    owned: false,
  },
];

const BASE_SPECIES = fixtures.contentSpecies[0]!;
const BASE_OWNED = fixtures.ownedEntries[0]!;

function contentSpecies(): ContentSpecies[] {
  return SPECS.map(({ slug, name, tags, rarity }) => {
    const { buddyBonus: _bonus, ...rest } = BASE_SPECIES;
    return { ...rest, slug, name, tags, rarity: rarity ?? 'N', appearances: [] };
  });
}

/**
 * The owned collection, padded with 50 duplicate Valley copies *ahead* of the
 * rest, so the Twin Peeks and Thirstlands copies arrive on the third API page.
 * A dex that only read page one would get those zones wrong.
 */
function ownedCollection(): OwnedEntry[] {
  const owned = SPECS.filter((spec) => spec.owned);
  const padding = Array.from({ length: 50 }, () => owned[0]!);
  return [...padding, ...owned].map((spec, index) => ({
    ...BASE_OWNED,
    waifu: { ...BASE_OWNED.waifu, id: 5_000 + index, nickname: null },
    species: { ...BASE_OWNED.species, slug: spec.slug, name: spec.name, tags: spec.tags },
  }));
}

function serve(): void {
  const owned = ownedCollection();
  server.use(
    http.get('/api/v1/content/species', () => data(contentSpecies())),
    http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
      const requested = Number(new URL(request.url).searchParams.get('page') ?? '1');
      const pageSize = 25;
      const start = (requested - 1) * pageSize;
      return pageEnvelope(owned.slice(start, start + pageSize), requested, pageSize, owned.length);
    }),
  );
}

async function renderAt(url: string): Promise<void> {
  serve();
  renderRoutes({ routes, initialEntries: [url] });
  await screen.findByText(/\d+ \/ \d+ owned$/);
}

/** Every species tile on the page. */
function tiles(): HTMLElement[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href')?.startsWith('/encyclopedia/'));
}

function undiscoveredTiles(): HTMLElement[] {
  return tiles().filter((tile) => /^Not owned, /.test(tile.getAttribute('aria-label') ?? ''));
}

const UNDISCOVERED_NAMES = SPECS.filter((spec) => !spec.owned).map((spec) => spec.name);

function expectNoUndiscoveredNames(): void {
  const text = document.body.textContent ?? '';
  for (const name of UNDISCOVERED_NAMES) expect(text).not.toContain(name);
}

describe('Encyclopedia Zone filter', () => {
  it('shows every species with All Zones, and the whole-dex tally', async () => {
    await renderAt('/encyclopedia');

    expect(await screen.findByText('7 / 16 owned')).toBeInTheDocument();
    expect(tiles()).toHaveLength(16);
    expect(screen.queryByRole('button', { name: /^Origin:/ })).toBeNull();
  });

  it.each([
    ['waifu_valley', 'Waifu Valley', 4, 2],
    ['twin_peeks', 'Twin Peeks', 5, 3],
    ['flaccid_foothills', 'Flaccid Foothills', 3, 0],
    ['thirstlands', 'Thirstlands', 2, 2],
  ])('?zone=%s shows all of %s, discovered or not', async (tag, label, total, discovered) => {
    await renderAt(`/encyclopedia?zone=${tag}`);

    await waitFor(() => expect(tiles()).toHaveLength(total));
    expect(undiscoveredTiles()).toHaveLength(total - discovered);
    expect(screen.getByText(`${label} origin: ${discovered} / ${total} owned`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Origin: ${label}` })).toBeInTheDocument();
    expectNoUndiscoveredNames();
  });

  it('keeps discovered and undiscovered Twin Peeks entries side by side, gated as ever', async () => {
    await renderAt('/encyclopedia?zone=twin_peeks');

    await waitFor(() => expect(tiles()).toHaveLength(5));
    for (const i of [0, 2, 4]) {
      expect(screen.getByText(`Peak Oracle ${i}`)).toBeInTheDocument();
    }
    // The two missing ones: silhouettes, `???`, and nothing identifying.
    expect(screen.getAllByText('???')).toHaveLength(2);
    expect(screen.getAllByAltText('Undiscovered Waifumon silhouette')).toHaveLength(2);
    for (const tile of undiscoveredTiles()) {
      expect(tile).toHaveAttribute('href', expect.stringMatching(/^\/encyclopedia\/tp_[13]$/));
      expect(tile).not.toHaveTextContent(/Peak Oracle|Demon|Primal|Explicit|placeholder/);
    }
    expectNoUndiscoveredNames();
  });

  it('combines with the Undiscovered filter to list exactly what is missing', async () => {
    await renderAt('/encyclopedia?zone=twin_peeks&discovery=undiscovered');

    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(undiscoveredTiles()).toHaveLength(2);
    // The tally still describes the zone, not the narrowed list.
    expect(screen.getByText('Twin Peeks origin: 3 / 5 owned')).toBeInTheDocument();
    expectNoUndiscoveredNames();
  });

  it('combines with the Discovered filter', async () => {
    await renderAt('/encyclopedia?zone=twin_peeks&discovery=discovered');

    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(undiscoveredTiles()).toHaveLength(0);
  });

  it('combines with the rarity filter, across discovery states', async () => {
    await renderAt('/encyclopedia?zone=twin_peeks&rarity=SR');

    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(screen.getByText('Peak Oracle 0')).toBeInTheDocument();
    expect(undiscoveredTiles()).toHaveLength(1);
    expectNoUndiscoveredNames();
  });

  it('combines with search, which still only matches discovered species', async () => {
    await renderAt('/encyclopedia?zone=twin_peeks&search=Oracle');

    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(undiscoveredTiles()).toHaveLength(0);
  });

  it.each(['twin_peaks', 'assteroid_belt', 'nowhere', ''])(
    'treats ?zone=%s as All Zones',
    async (value) => {
      await renderAt(`/encyclopedia?zone=${value}`);

      expect(await screen.findByText('7 / 16 owned')).toBeInTheDocument();
      expect(tiles()).toHaveLength(16);
      expect(screen.queryByRole('button', { name: /^Origin:/ })).toBeNull();
    },
  );

  it('offers exactly the canonical zones — never one read off a species tag', async () => {
    const user = userEvent.setup();
    await renderAt('/encyclopedia');

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const group = await screen.findByRole('group', { name: 'Origin' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['All origins', 'Waifu Valley', 'Twin Peeks', 'Flaccid Foothills', 'Thirstlands']);
    expect(within(group).getByRole('button', { name: 'All origins' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('selects, switches and clears a zone from the panel', async () => {
    const user = userEvent.setup();
    await renderAt('/encyclopedia');

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const group = await screen.findByRole('group', { name: 'Origin' });

    await user.click(within(group).getByRole('button', { name: 'Twin Peeks' }));
    await waitFor(() => expect(tiles()).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Origin: Twin Peeks' })).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: 'Flaccid Foothills' }));
    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(screen.getByText('Flaccid Foothills origin: 0 / 3 owned')).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: 'All origins' }));
    await waitFor(() => expect(tiles()).toHaveLength(16));
    expect(screen.getByText('7 / 16 owned')).toBeInTheDocument();
  });

  it('removes the Zone chip, and Clear All clears Zone with everything else', async () => {
    const user = userEvent.setup();
    await renderAt('/encyclopedia?zone=twin_peeks');

    await user.click(await screen.findByRole('button', { name: 'Origin: Twin Peeks' }));
    await waitFor(() => expect(tiles()).toHaveLength(16));

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const group = await screen.findByRole('group', { name: 'Origin' });
    await user.click(within(group).getByRole('button', { name: 'Thirstlands' }));
    await user.click(screen.getByRole('button', { name: 'Not owned' }));
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    await waitFor(() => expect(tiles()).toHaveLength(16));
    expect(screen.queryByRole('button', { name: /^Origin:/ })).toBeNull();
    expect(screen.getByText('7 / 16 owned')).toBeInTheDocument();
  });
});
