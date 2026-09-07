/**
 * Viewing a guild-mate's collection.
 *
 * The assertions worth reading are the ones about *confusion*, not about
 * rendering. A read-only view of somebody else's Waifumon has three ways to go
 * wrong that a screenshot would never reveal:
 *
 *   - it shows the viewer's own collection under another player's name
 *   - it flashes player A's cards while player B loads
 *   - it offers, or silently issues, a request that would mutate the owner's
 *     copies
 *
 * The fixtures are built to catch the first: `fixtures.aikoCollection` shares no
 * id, nickname or species mix with `fixtures.ownedEntries`, so a mix-up fails
 * an assertion rather than passing by coincidence.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data, page } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { queryKeys } from '@/api/queryKeys';
import { createTestQueryClient, renderRoutes } from '@/test/renderWithProviders';

const AIKO = 42;

function renderAt(path: string) {
  return renderRoutes({ routes, initialEntries: [path] });
}

/** Every card title in the grid, in rendered order. */
async function gridTitles(): Promise<string[]> {
  const links = await screen.findAllByRole('link', { name: /level \d+/i });
  return links.map((link) => link.getAttribute('aria-label') ?? '');
}

describe('public collection', () => {
  it('is reachable from the public profile', async () => {
    const user = userEvent.setup();
    renderAt(`/players/${AIKO}`);

    await screen.findByRole('heading', { name: 'Aiko', level: 1 });
    await user.click(screen.getByRole('link', { name: /view collection/i }));

    expect(
      await screen.findByRole('heading', { name: "Aiko's Collection", level: 1 }),
    ).toBeInTheDocument();
  });

  it('shows the target player\'s copies, not the viewer\'s', async () => {
    renderAt(`/players/${AIKO}/collection`);

    // Aiko's copies…
    expect(await screen.findByText('Vesper')).toBeInTheDocument();
    expect(screen.getByText('Amber')).toBeInTheDocument();

    // …and none of the viewer's own, which the fixtures make distinct.
    expect(screen.queryByText('Nyx')).not.toBeInTheDocument();
  });

  it('reads the public resource and never the viewer\'s own collection', async () => {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      paths.push(new URL(request.url, 'http://localhost').pathname);
    });

    renderAt(`/players/${AIKO}/collection`);
    await screen.findByText('Vesper');

    expect(paths).toContain(`/api/v1/players/${AIKO}/public/collection`);
    // The viewer's own collection and buddy are not fetched for somebody
    // else's grid — those hooks are disabled in public mode.
    expect(paths.some((p) => p === `/api/v1/players/${fixtures.PLAYER_ID}/collection/owned`)).toBe(
      false,
    );
    expect(paths.some((p) => p.endsWith('/collection/buddy'))).toBe(false);
  });

  it('keys the cache by guild and owner, so no other collection can answer', () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.publicCollection(7, AIKO), fixtures.aikoCollection);

    // A different owner in the same guild: different entry.
    expect(client.getQueryData(queryKeys.publicCollection(7, 77))).toBeUndefined();
    // The same owner seen from a different guild: different entry.
    expect(client.getQueryData(queryKeys.publicCollection(8, AIKO))).toBeUndefined();
    // And it shares nothing with the viewer's own collection key.
    expect(queryKeys.publicCollection(7, AIKO)).not.toEqual(
      queryKeys.collectionAll(fixtures.PLAYER_ID),
    );
  });

  it('does not flash one player\'s cards while another loads', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/public/collection', ({ params }) => {
        const id = Number(params.playerId);
        if (id === AIKO) return page(fixtures.aikoCollection);
        return page([
          { ...(fixtures.aikoCollection[0] as object), waifu: { ...fixtures.aikoCollection[0]!.waifu, id: 901, nickname: 'Borrowed' } },
        ] as never);
      }),
      http.get('/api/v1/players/:playerId/public', ({ params }) =>
        data({ ...fixtures.publicProfile, id: Number(params.playerId), displayName: `Trainer ${String(params.playerId)}` }),
      ),
    );

    const client = createTestQueryClient();
    // Aiko's grid, already cached — the state a navigation leaves behind.
    client.setQueryData(queryKeys.publicCollection(7, AIKO), fixtures.aikoCollection);

    renderRoutes({ routes, initialEntries: ['/players/77/collection'], client });

    // Player 77's page must never render Aiko's copies, not even for a frame.
    await screen.findByText('Borrowed');
    expect(screen.queryByText('Vesper')).not.toBeInTheDocument();
    expect(screen.queryByText('Amber')).not.toBeInTheDocument();
  });

  it('rejects a player outside the selected guild', async () => {
    // The API answers 404 for a player the session may not see — the same
    // answer an unknown id gets.
    server.use(
      http.get('/api/v1/players/:playerId/public', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
      http.get('/api/v1/players/:playerId/public/collection', () =>
        apiError(404, 'PLAYER_NOT_FOUND', 'No player with that id.'),
      ),
    );

    renderAt('/players/900/collection');
    expect(await screen.findByText(/that collection isn't available/i)).toBeInTheDocument();
  });

  it('searches, filters and sorts the target\'s collection', async () => {
    const user = userEvent.setup();
    renderAt(`/players/${AIKO}/collection`);
    await screen.findByText('Vesper');

    // The toolbar names whose collection it is filtering — the viewer must
    // never be left unsure which trainer's copies they are narrowing.
    const search = screen.getByRole('textbox', { name: /search aiko's collection/i });

    // Search by name — over Aiko's copies, not the viewer's.
    await user.type(search, 'amber');
    await waitFor(() => expect(screen.queryByText('Vesper')).not.toBeInTheDocument());
    expect(screen.getByText('Amber')).toBeInTheDocument();

    await user.clear(search);
    await screen.findByText('Vesper');

    // Rarity is a server-side filter on the public resource; the request goes
    // out scoped to Aiko, and the grid shows what came back.
    const titles = await gridTitles();
    expect(titles).toHaveLength(3);
  });

  it('offers no ownership actions', async () => {
    renderAt(`/players/${AIKO}/collection`);
    await screen.findByText('Vesper');

    for (const label of [
      /release/i,
      /favourite this/i,
      /set buddy/i,
      /invest/i,
      /essence/i,
      /export card/i,
    ]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  /**
   * `caughtAt` is published as a calendar day rather than the full instant the
   * self resource carries — a millisecond capture time is a record of when
   * another player was at their keyboard, and the UI only ever renders days.
   */
  it('receives caughtAt as a calendar day, with no time of day', () => {
    for (const entry of fixtures.aikoCollection) {
      expect(entry.waifu.caughtAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.waifu.caughtAt).not.toContain('T');
    }
  });

  it('leaves the viewer\'s own collection on full timestamps', () => {
    // The self fixture mirrors the self resource, which is unchanged: the
    // truncation is scoped to the public serialization boundary.
    for (const entry of fixtures.ownedEntries) {
      expect(entry.waifu.caughtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('renders a day-precision capture date and no clock time', async () => {
    renderAt(`/players/${AIKO}/collection/501`);
    await screen.findByRole('heading', { name: 'Vesper', level: 1 });

    // `formatDate` renders "11 May 2026" from either format, so the display is
    // unaffected — what must not appear is a time.
    const captureCard = screen.getByText('Caught').closest('div') as HTMLElement;
    expect(within(captureCard).getByText(/2026/)).toBeInTheDocument();
    expect(captureCard.textContent ?? '').not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('keeps the server order for copies caught on the same day', async () => {
    // Three copies, one published day, served in a deliberate order. With the
    // time of day gone the comparator cannot separate them, so the grid must
    // fall back to the order the server sent — not invent one.
    const sameDay = fixtures.aikoCollection.map((entry) => ({
      ...entry,
      waifu: { ...entry.waifu, caughtAt: '2026-06-15' },
    }));
    server.use(
      http.get('/api/v1/players/:playerId/public/collection', () => page(sameDay)),
    );

    renderAt(`/players/${AIKO}/collection?sort=caught`);
    await screen.findByText('Vesper');

    // Server order was Vesper (501), the unnamed Neko Barista (502), Amber
    // (503) — and that is what a stable sort over equal keys preserves.
    const links = await screen.findAllByRole('link', { name: /level \d+/i });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/players/${AIKO}/collection/501`,
      `/players/${AIKO}/collection/502`,
      `/players/${AIKO}/collection/503`,
    ]);
  });

  it('carries no XP, affection or release state in the payload', () => {
    for (const entry of fixtures.aikoCollection) {
      const keys = Object.keys(entry.waifu);
      expect(keys.sort()).toEqual(
        [
          'caughtAt',
          'id',
          'isFavorite',
          'level',
          'nickname',
          'playerId',
          'selectedAppearance',
          'variant',
        ].sort(),
      );
      expect(entry).not.toHaveProperty('progress');
    }
  });
});

describe('public inspect', () => {
  it('opens a read-only detail view for one of their copies', async () => {
    const user = userEvent.setup();
    renderAt(`/players/${AIKO}/collection`);
    await screen.findByText('Vesper');

    await user.click(screen.getAllByRole('link', { name: /vesper/i })[0] as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Vesper', level: 1 })).toBeInTheDocument();
    // The owner's buddy, labelled as theirs rather than the viewer's.
    expect(screen.getByText('Their buddy')).toBeInTheDocument();
  });

  it('shows no mutation controls and never loads the appearance gallery', async () => {
    const paths: string[] = [];
    server.events.on('request:start', ({ request }) => {
      paths.push(new URL(request.url, 'http://localhost').pathname);
    });

    renderAt(`/players/${AIKO}/collection/501`);
    await screen.findByRole('heading', { name: 'Vesper', level: 1 });

    // The gallery endpoint is self-only *and* it writes (it acknowledges
    // pending unlocks). It must not be reached for another player's copy.
    expect(paths.some((p) => p.endsWith('/appearances'))).toBe(false);
    expect(screen.queryByText(/appearance gallery/i)).not.toBeInTheDocument();

    for (const label of [/release/i, /set buddy/i, /export card/i, /wear this/i]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('shows public metadata but not XP or affection', async () => {
    renderAt(`/players/${AIKO}/collection/501`);
    await screen.findByRole('heading', { name: 'Vesper', level: 1 });

    expect(screen.getByText('Level 40')).toBeInTheDocument();
    // The XP total and the affection meter are the two self-only readouts on
    // this card. Neither is in the public payload, so neither renders.
    expect(screen.queryByText(/XP total/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: /affection/i })).not.toBeInTheDocument();
    expect(screen.getByText(/experience and affection are private/i)).toBeInTheDocument();
  });

  it('404s for a copy the target player does not own', async () => {
    renderAt(`/players/${AIKO}/collection/999999`);
    expect(await screen.findByText(/that waifumon isn't available/i)).toBeInTheDocument();
  });

  /**
   * Asserted on the `src` the page actually renders rather than on a network
   * event: jsdom never fetches images, so an intercepted-request assertion here
   * would pass whether the URL were right or wrong.
   */
  it('points artwork at the guild-scoped public route', async () => {
    renderAt(`/players/${AIKO}/collection/501`);
    await screen.findByRole('heading', { name: 'Vesper', level: 1 });

    const hero = await screen.findByRole('img', { name: /void empress/i });
    const src = hero.getAttribute('src') ?? '';

    expect(src).toContain(`/v1/players/${AIKO}/public/collection/501/artwork`);
    // Never the self-only owned route — it would 403 for another player's copy.
    expect(src).not.toContain('/collection/owned/');
    // And never the slug-addressed species route, which stays gated on the
    // viewer's own dex. Seeing a guild-mate's copy must not become a way to
    // read the encyclopedia.
    expect(src).not.toContain('/assets/waifumon/');
  });
});
