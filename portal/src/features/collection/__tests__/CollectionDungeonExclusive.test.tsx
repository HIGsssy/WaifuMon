/**
 * The Collection's Dungeon Exclusive filter.
 *
 * It filters on the species' `dungeon_exclusive` classification tag — never on
 * where a copy was acquired — over the complete owned collection, before sort
 * and pagination, alongside every existing filter. In public mode it also
 * never matches a copy whose species the *viewer* has not discovered, because
 * those tiles withhold the species' tags.
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
import type { OwnedEntry, PublicOwnedEntry, Rarity } from '@/api/types';

const DX = ['dungeon_exclusive'];

/**
 * 60 copies over three API pages. Every fifth copy (0, 5, … 55 — 12 copies,
 * on every source page) is dungeon-exclusive; of those, the even indexes are
 * SR favourites and the odd ones are N. Regular copies are SR too, so rarity
 * alone never isolates the dungeon set.
 */
function mixedCollection(): OwnedEntry[] {
  const source = fixtures.ownedEntries[0]!;
  return Array.from({ length: 60 }, (_, index) => {
    const dungeon = index % 5 === 0;
    const even = index % 2 === 0;
    return {
      ...source,
      waifu: {
        ...source.waifu,
        id: 3_000 + index,
        nickname: `${dungeon ? 'delve' : 'field'} copy ${index}`,
        isFavorite: dungeon && even,
      },
      species: {
        ...source.species,
        slug: dungeon ? 'forgotten_valkyrie' : 'field_maid',
        rarity: (dungeon && !even ? 'N' : 'SR') as Rarity,
        tags: dungeon ? DX : ['starter', 'waifu_valley'],
      },
    };
  });
}

/** 30 dungeon-exclusive copies plus 30 regular ones — enough to need two pages. */
function manyDungeonCopies(): OwnedEntry[] {
  const source = fixtures.ownedEntries[0]!;
  return Array.from({ length: 60 }, (_, index) => ({
    ...source,
    waifu: { ...source.waifu, id: 4_000 + index, nickname: `${index % 2 ? 'field' : 'delve'} copy ${index}` },
    species: { ...source.species, tags: index % 2 ? ['starter'] : DX },
  }));
}

function servePaged(entries: OwnedEntry[]): void {
  server.use(
    http.get('/api/v1/players/:playerId/collection/owned', ({ request }) => {
      const requested = Number(new URL(request.url).searchParams.get('page') ?? '1');
      const start = (requested - 1) * 25;
      return pageEnvelope(entries.slice(start, start + 25), requested, 25, entries.length);
    }),
  );
}

function renderAt(url: string) {
  return renderRoutes({ routes, initialEntries: [url] });
}

const titles = (cards: HTMLElement[]) =>
  cards.map((card) => card.getAttribute('aria-label')?.split(',')[0] ?? '');

describe('Collection Dungeon Exclusive filter', () => {
  it('keeps only dungeon-exclusive copies, drawn from every source page', async () => {
    servePaged(mixedCollection());
    renderAt('/collection?exclusive=dungeon');

    expect(await screen.findAllByRole('link', { name: /^delve copy/ })).toHaveLength(12);
    expect(screen.queryByRole('link', { name: /^field copy/ })).toBeNull();
    expect(screen.queryByLabelText('Collection pages')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dungeon Exclusive' })).toBeInTheDocument();
  });

  it.each([
    ['rarity', '/collection?exclusive=dungeon&rarity=N', 6],
    ['favourites', '/collection?exclusive=dungeon&ownership=favorites', 6],
    ['search', '/collection?exclusive=dungeon&search=copy%205', 3],
  ])('combines with %s', async (_filter, url, count) => {
    servePaged(mixedCollection());
    renderAt(url);

    expect(await screen.findAllByRole('link', { name: /^delve copy/ })).toHaveLength(count);
    expect(screen.queryByRole('link', { name: /^field copy/ })).toBeNull();
  });

  it('shows the filtered empty state when nothing matches', async () => {
    servePaged(mixedCollection());
    renderAt('/collection?exclusive=dungeon&zone=waifu_valley');

    expect(await screen.findByText('Nothing matches those filters')).toBeInTheDocument();
  });

  it('paginates the filtered set and sorts it globally first', async () => {
    const user = userEvent.setup();
    servePaged(manyDungeonCopies());
    renderAt('/collection?exclusive=dungeon&sort=name');

    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    const first = titles(screen.getAllByRole('link', { name: /^delve copy/ }));
    expect(first).toHaveLength(25);
    expect(first).toEqual([...first].sort((a, b) => a.localeCompare(b)));

    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^delve copy/ })).toHaveLength(5);
    expect(screen.queryByRole('link', { name: /^field copy/ })).toBeNull();
  });

  it('ignores an unrecognised value in the URL', async () => {
    servePaged(mixedCollection());
    renderAt('/collection?exclusive=region');

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dungeon Exclusive' })).toBeNull();
  });

  it('selects from the compact panel, resets the page, and the chip removes it', async () => {
    const user = userEvent.setup();
    servePaged(mixedCollection());
    renderAt('/collection?page=3');

    expect(await screen.findByText('Page 3 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    const group = await screen.findByRole('group', { name: 'Exclusivity' });
    expect(within(group).getByRole('button', { name: 'Any' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: 'Dungeon Exclusive' }));

    expect(await screen.findAllByRole('link', { name: /^delve copy/ })).toHaveLength(12);
    expect(screen.queryByLabelText('Collection pages')).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Dungeon Exclusive' }));
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
  });
});

// ── Public mode: the viewer's dex decides what may be classified ────────────

const OWNER = 42;

function row(id: number, slug: string, name: string, tags: string[]) {
  return { ...fixtures.ownedEntries[0]!.species, id, slug, name, tags };
}

const VALKYRIE = row(951, 'forgotten_valkyrie', 'Forgotten Valkyrie', DX);
const KITSUNE = row(952, 'copper_kitsune', 'Copper Kitsune', DX);
const MAID = row(953, 'field_maid', 'Field Maid', ['starter']);

function publicCopy(id: number, species: typeof VALKYRIE, nickname: string): PublicOwnedEntry {
  const source = fixtures.ownedEntries[0]!;
  return {
    waifu: {
      id,
      playerId: OWNER,
      level: 10,
      nickname,
      isFavorite: false,
      variant: 'standard',
      selectedAppearance: source.waifu.selectedAppearance,
      caughtAt: '2026-10-01',
    },
    species,
    isBuddy: false,
  };
}

function servePublic(): void {
  const viewer: OwnedEntry[] = [
    { ...fixtures.ownedEntries[0]!, waifu: { ...fixtures.ownedEntries[0]!.waifu, id: 9_001 }, species: VALKYRIE },
    { ...fixtures.ownedEntries[0]!, waifu: { ...fixtures.ownedEntries[0]!.waifu, id: 9_002 }, species: MAID },
  ];
  server.use(
    http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope(viewer)),
    http.get('/api/v1/players/:playerId/public', ({ params }) =>
      data({ ...fixtures.publicProfile, id: Number(params.playerId), displayName: 'Aiko' }),
    ),
    http.get('/api/v1/players/:playerId/public/collection', () =>
      pageEnvelope([
        publicCopy(801, VALKYRIE, 'Known Delver'),
        publicCopy(802, KITSUNE, 'Secret Delver'),
        publicCopy(803, MAID, 'Field Hand'),
      ]),
    ),
  );
}

describe('Collection Dungeon Exclusive filter, public view', () => {
  it('lists every copy without the filter', async () => {
    servePublic();
    renderAt(`/players/${OWNER}/collection`);

    expect(await screen.findByRole('link', { name: /^Secret Delver/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Known Delver/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Field Hand/ })).toBeInTheDocument();
  });

  it('never classifies a copy whose species the viewer has not discovered', async () => {
    servePublic();
    renderAt(`/players/${OWNER}/collection?exclusive=dungeon`);

    expect(await screen.findByRole('link', { name: /^Known Delver/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /^Secret Delver/ })).toBeNull(),
    );
    expect(screen.queryByRole('link', { name: /^Field Hand/ })).toBeNull();
    expect(document.body.textContent).not.toContain('Copper Kitsune');
  });
});
