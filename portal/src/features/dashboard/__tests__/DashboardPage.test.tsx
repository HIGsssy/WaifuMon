/**
 * Dashboard page tests (plan §22.2): loading, success, empty and error.
 *
 * Two rules the redesign made testable, and both are asserted below:
 *
 *   - **Nothing here computes a game rule.** The trainer's XP bar and the Energy
 *     ceiling are rendered from `player.progress` and `currencies.maxHuntEnergy`
 *     exactly as the API sends them. The tests feed values that do *not* follow
 *     from the level and prove the page still prints them, which is what a
 *     recomputed curve could not do.
 *   - **Each figure appears once.** The collection counts used to render both on
 *     the progress card and as quick-launch captions.
 *
 * The error case is worth reading closely — it asserts §19's "partial
 * responses" rule, that a failing tile does not take the page with it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data, page } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderDashboard() {
  return renderRoutes({ routes, initialEntries: ['/dashboard'] });
}

/** Serves a profile with the fixture defaults overridden. */
function withProfile(player: object = {}, currencies: object = {}) {
  server.use(
    http.get('/api/v1/players/:playerId/profile', () =>
      data({
        player: { ...fixtures.player, ...player },
        currencies: { ...fixtures.currencies, ...currencies },
      }),
    ),
  );
}

describe('DashboardPage', () => {
  it('renders the trainer, buddy, balances and dex progress', async () => {
    renderDashboard();

    // The API's display name wins over the "Trainer #id" fallback.
    expect(await screen.findAllByText('Mika')).not.toHaveLength(0);
    expect(await screen.findByText('Level 12')).toBeInTheDocument();

    // Buddy hero — the nickname, not the species name.
    expect(await screen.findAllByText('Nyx')).not.toHaveLength(0);
    expect(screen.getByText('Active buddy')).toBeInTheDocument();

    // Balances, thousands-separated, with Energy read as a meter.
    expect(await screen.findByText('34 / 35')).toBeInTheDocument();
    expect(screen.getByText('1,820')).toBeInTheDocument();
    expect(screen.getByText('46')).toBeInTheDocument();

    // Dex progress: 18 of 58 distinct species, 23 owned.
    expect(await screen.findByText('18 / 58')).toBeInTheDocument();
    expect(screen.getByText('23')).toBeInTheDocument();
  });

  // ── Server-owned calculations ─────────────────────────────────────────────

  describe('trainer progression', () => {
    it('draws the bar from the API’s progress block', async () => {
      renderDashboard();

      const bar = await screen.findByLabelText('Trainer experience to next level');
      expect(bar).toBeInTheDocument();
      // 280 of a 650-XP level, and the caption names the level being climbed to.
      expect(screen.getByText('280 / 930 XP to level 13')).toBeInTheDocument();
    });

    /**
     * The proof that no curve is reimplemented here: these figures do not
     * follow from level 12 on the shipped curve. A client deriving progression
     * from `xp` would print something else; one rendering what it was handed
     * prints exactly this.
     */
    it('renders whatever progression the server sends, without re-deriving it', async () => {
      withProfile({
        xp: 3480,
        progress: { level: 12, totalXp: 3480, xpIntoLevel: 7, xpToNext: 11, atMaxLevel: false },
      });

      renderDashboard();

      expect(await screen.findByText('7 / 18 XP to level 13')).toBeInTheDocument();
    });

    it('says max level rather than drawing a bar to nowhere', async () => {
      withProfile({
        level: 50,
        progress: { level: 50, totalXp: 99_999, xpIntoLevel: 0, xpToNext: 0, atMaxLevel: true },
      });

      renderDashboard();

      expect(await screen.findByLabelText('Trainer experience: max level')).toBeInTheDocument();
      expect(screen.getByText('Max level')).toBeInTheDocument();
    });
  });

  describe('the Energy meter', () => {
    it('shows the balance against the ceiling the API returned', async () => {
      renderDashboard();
      expect(await screen.findByText('34 / 35')).toBeInTheDocument();
    });

    /** A ceiling the Portal could not have guessed from the level. */
    it('uses the server’s ceiling rather than a constant', async () => {
      withProfile({}, { huntEnergy: 12, maxHuntEnergy: 99 });

      renderDashboard();

      expect(await screen.findByText('12 / 99')).toBeInTheDocument();
    });
  });

  // ── Current location ──────────────────────────────────────────────────────

  describe('current location', () => {
    it('names the region from the player resource', async () => {
      renderDashboard();

      expect(await screen.findByText('Twin Peeks')).toBeInTheDocument();
    });

    /**
     * The Portal prints the API's `name` and never derives one from the id —
     * content is free to call a place something its slug does not spell.
     */
    it('prints the API’s name rather than title-casing the id', async () => {
      withProfile({ currentRegion: { id: 'twin-peeks', name: 'The Ridge at Twin Peeks' } });

      renderDashboard();

      expect(await screen.findByText('The Ridge at Twin Peeks')).toBeInTheDocument();
      expect(screen.queryByText('Twin Peeks')).toBeNull();
    });
  });

  // ── Recent catches ────────────────────────────────────────────────────────

  describe('recent catches', () => {
    it('asks for one short newest-first page, never the whole collection', async () => {
      const requests: URL[] = [];
      server.events.on('request:start', ({ request }) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/collection/owned')) requests.push(url);
      });

      renderDashboard();
      await screen.findByRole('heading', { name: 'Recent catches' });
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));

      // Exactly one listing request, for five rows, in newest order.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.searchParams.get('sort')).toBe('newest');
      expect(requests[0]!.searchParams.get('pageSize')).toBe('5');
      expect(requests[0]!.searchParams.get('page')).toBe('1');

      server.events.removeAllListeners();
    });

    /**
     * The fixtures are authored rarest-first and the mock honours `sort`, so
     * the strip's order is the server's answer — not a re-sort of a page the
     * Portal was handed.
     */
    it('renders the strip in the order the server returned', async () => {
      renderDashboard();

      const strip = await screen.findByRole('region', { name: 'Recent catches' });
      // The heading paints before the query lands, so wait for the tiles.
      const links = await within(strip).findAllByRole('link');

      // Newest first: neko_barista (Aug 1), neon_kitsune (Jul 20), Nyx (Jul 2).
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        '/collection/103',
        '/collection/102',
        '/collection/101',
      ]);
    });

    it('says the shelf is empty rather than showing nothing at all', async () => {
      server.use(
        http.get('/api/v1/players/:playerId/collection/owned', () => page([], 1, 5, 0)),
      );

      renderDashboard();

      expect(await screen.findByText(/Nothing caught yet/i)).toBeInTheDocument();
    });
  });

  // ── Links ─────────────────────────────────────────────────────────────────

  it('links the buddy card to that owned copy’s detail page', async () => {
    renderDashboard();

    const link = await screen.findByRole('link', { name: 'View Nyx' });
    expect(link).toHaveAttribute('href', `/collection/${fixtures.buddyEntry.waifu.id}`);
  });

  // ── No duplicated figures ─────────────────────────────────────────────────

  /**
   * `owned`, `distinctSpecies` and `totalSpecies` used to render twice each —
   * once on the progress card, once as a quick-launch caption. Each is now
   * stated in exactly one place.
   */
  it('states each collection figure once', async () => {
    renderDashboard();

    await screen.findByText('18 / 58');
    expect(screen.getAllByText('18 / 58')).toHaveLength(1);
    expect(screen.getAllByText('23')).toHaveLength(1);
    // The old captions are gone from the Explore strip.
    expect(screen.queryByText('23 caught')).toBeNull();
    expect(screen.queryByText('18 of 58 discovered')).toBeNull();
  });

  it('derives duplicates from the two counts the API returned', async () => {
    renderDashboard();

    // 23 owned − 18 distinct = 5 duplicate copies.
    const label = await screen.findByText('Duplicates');
    expect(label.parentElement).toHaveTextContent('5');
  });

  // ── Loading, empty and error ──────────────────────────────────────────────

  it('shows skeletons — never a spinner — while data is in flight', async () => {
    // Hold the responses open so the loading state is observable at all.
    server.use(
      http.get('/api/v1/players/:playerId/profile', async () => {
        await delay(120);
        return data({ player: fixtures.player, currencies: fixtures.currencies });
      }),
    );

    renderDashboard();

    // §14: the page frame paints as soon as the route resolves; the body fills
    // in beneath it. There is no full-page loading state to wait through.
    const heading = await screen.findByRole('heading', { name: 'Dashboard' });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);

    expect(await screen.findByText('Level 12')).toBeInTheDocument();
  });

  it('renders an intentional layout for a brand-new player', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/profile', () =>
        data({
          player: {
            ...fixtures.player,
            level: 1,
            xp: 0,
            buddyWaifuId: null,
            progress: {
              level: 1,
              totalXp: 0,
              xpIntoLevel: 0,
              xpToNext: 100,
              atMaxLevel: false,
            },
          },
          currencies: {
            ...fixtures.currencies,
            huntEnergy: 0,
            maxHuntEnergy: 25,
            waifubux: 0,
            essence: 0,
          },
        }),
      ),
      http.get('/api/v1/players/:playerId/collection/buddy', () =>
        apiError(404, 'BUDDY_NOT_SET', 'No buddy is set.'),
      ),
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        data({ owned: 0, distinctSpecies: 0, totalSpecies: 58 }),
      ),
      http.get('/api/v1/players/:playerId/collection/owned', () => page([], 1, 5, 0)),
    );

    renderDashboard();

    expect(await screen.findByText('No buddy set')).toBeInTheDocument();
    expect(await screen.findByText('0 / 58')).toBeInTheDocument();
    expect(await screen.findByText('0 / 25')).toBeInTheDocument();
    expect(await screen.findByText(/Nothing caught yet/i)).toBeInTheDocument();
    // Zeros, not an error screen.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps rendering when one tile fails, and offers a retry', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderDashboard();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load your collection progress.")).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // The rest of the page is unaffected — §19 "partial responses".
    await waitFor(() => expect(screen.getByText('Level 12')).toBeInTheDocument());
    expect(screen.getAllByText('Nyx').length).toBeGreaterThan(0);
    expect(screen.getByText('Twin Peeks')).toBeInTheDocument();
  });

  it('falls back to Trainer #id when the API cannot resolve an identity', async () => {
    // Concrete id, not `:playerId` — a param pattern also matches
    // `/players/lookup`, which the dev session provider needs to keep working.
    server.use(http.get('/api/v1/players/1', () => data({ ...fixtures.player, identity: null })));

    renderDashboard();

    expect(await screen.findAllByText('Trainer #1')).not.toHaveLength(0);
  });
});
