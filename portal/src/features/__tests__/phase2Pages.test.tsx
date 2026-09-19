/**
 * Phase 2 page tests (plan §21, §22.2) — Buddy, Inventory, Shop, Encyclopedia,
 * Profile, Guide and Settings.
 *
 * Each page gets its happy path plus one error path, per the phase's
 * verification criteria. Three assertions recur because they encode rules
 * rather than behaviour:
 *
 *   - no page offers a gameplay control (§4)
 *   - missing data is a stated gap, never a fabricated value (§16)
 *   - the Guide never prints a raw tuning dump (§8.9)
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { apiError, data, page as pageEnvelope } from '../../../msw/handlers';
import * as fixtures from '../../../msw/fixtures';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderAt(url: string) {
  return renderRoutes({ routes, initialEntries: [url] });
}

// ── Buddy ───────────────────────────────────────────────────────────────────

describe('BuddyPage', () => {
  it('renders the buddy hero, progression and care state', async () => {
    renderAt('/buddy');

    expect(await screen.findByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
    expect(screen.getByText('Care Mode')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    // Energy comes from the care response, rendered as the API returned it.
    expect(screen.getByLabelText('Energy: 34 of 50')).toBeInTheDocument();
  });

  it('offers no care controls — the game happens in Discord', async () => {
    renderAt('/buddy');
    await screen.findByRole('heading', { name: 'Nyx' });

    for (const label of [/enter care/i, /exit care/i, /change target/i, /start care/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('shows a friendly empty state when no buddy is set', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/buddy', () =>
        apiError(404, 'BUDDY_NOT_SET', 'No buddy is set.'),
      ),
    );

    renderAt('/buddy');

    expect(await screen.findByText('No buddy set')).toBeInTheDocument();
    expect(screen.getByText(/Choose a companion in Discord/)).toBeInTheDocument();
  });

  it('keeps the buddy hero when the care read fails', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/care', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderAt('/buddy');

    expect(await screen.findByText("Couldn't load Care Mode state.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nyx' })).toBeInTheDocument());
  });
});

// ── Inventory ───────────────────────────────────────────────────────────────

describe('InventoryPage', () => {
  it('groups items by category with quantities', async () => {
    renderAt('/inventory');

    expect(await screen.findByRole('heading', { name: 'Capture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Materials' })).toBeInTheDocument();
    expect(screen.getByText('Basic Charm')).toBeInTheDocument();
    expect(screen.getByText('×12')).toBeInTheDocument();
    expect(screen.getByText('Moon Shard')).toBeInTheDocument();
    expect(screen.getByText('Not for sale')).toBeInTheDocument();
  });

  it('marks only items sold in no regional shop as not for sale', async () => {
    renderAt('/inventory');

    // The API sends `shopRegions`, not a `purchasable` flag: Basic Charm is
    // stocked in a region, Moon Shard in none.
    const charm = (await screen.findByRole('heading', { name: 'Basic Charm' })).closest('li')!;
    const shard = screen.getByRole('heading', { name: 'Moon Shard' }).closest('li')!;
    expect(within(charm).queryByText('Not for sale')).toBeNull();
    expect(within(shard).getByText('Not for sale')).toBeInTheDocument();
  });

  it('offers no "use item" control', async () => {
    renderAt('/inventory');
    await screen.findByText('Basic Charm');
    expect(screen.queryByRole('button', { name: /use/i })).toBeNull();
  });

  it('points at Discord when the bag is empty', async () => {
    server.use(http.get('/api/v1/players/:playerId/inventory', () => data([])));

    renderAt('/inventory');

    expect(await screen.findByText('Your inventory is empty')).toBeInTheDocument();
    expect(screen.getByText(/waifumon daily/)).toBeInTheDocument();
  });

  it('offers a retry when the inventory fails to load', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/inventory', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderAt('/inventory');
    expect(await screen.findByText("Couldn't load your inventory.")).toBeInTheDocument();
  });
});

// ── Shop ────────────────────────────────────────────────────────────────────

describe('ShopPage', () => {
  it("renders the catalogue with prices and the service's availability note", async () => {
    renderAt('/shop');

    expect(await screen.findByText('Basic Charm')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    // Rendered verbatim from the service — the Portal never re-derives it.
    expect(screen.getByText('Not currently available')).toBeInTheDocument();
  });

  it('offers no purchase control, and says where buying happens', async () => {
    renderAt('/shop');
    await screen.findByText('Basic Charm');

    expect(screen.queryByRole('button', { name: /buy|purchase/i })).toBeNull();
    expect(screen.getByText(/waifumon shop/)).toBeInTheDocument();
  });

  it('shows a closed-shop empty state', async () => {
    server.use(http.get('/api/v1/shop/catalog', () => data([])));
    renderAt('/shop');
    expect(await screen.findByText('The shop is currently closed')).toBeInTheDocument();
  });

  it('offers a retry when the catalogue fails to load', async () => {
    server.use(
      http.get('/api/v1/shop/catalog', () => apiError(503, 'DB_UNAVAILABLE', 'Try again shortly.')),
    );
    renderAt('/shop');
    expect(await screen.findByText("Couldn't load the shop.")).toBeInTheDocument();
  });
});

// ── Encyclopedia ────────────────────────────────────────────────────────────

describe('EncyclopediaPage', () => {
  it('overlays ownership and silhouettes what has not been discovered', async () => {
    renderAt('/encyclopedia');

    // Owned species are named; the third fixture species is not owned.
    expect(await screen.findByText('Void Empress')).toBeInTheDocument();
    expect(screen.getByText('Neon Kitsune')).toBeInTheDocument();
    expect(screen.getByText('3 / 3 owned')).toBeInTheDocument();
  });

  it('hides undiscovered names behind ??? and a silhouette', async () => {
    // Own nothing: every species should be locked.
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope([], 1, 25, 0)),
    );

    renderAt('/encyclopedia');

    await waitFor(() => expect(screen.getAllByText('???').length).toBe(3));
    expect(screen.queryByText('Void Empress')).toBeNull();
    expect(screen.getAllByAltText('Undiscovered Waifumon silhouette').length).toBe(3);
    expect(screen.getByText('0 / 3 owned')).toBeInTheDocument();
  });

  it('filters by discovery state', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () =>
        pageEnvelope([fixtures.ownedEntries[0]!], 1, 25, 1),
      ),
    );

    renderAt('/encyclopedia');

    await screen.findByText('Void Empress');
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(screen.getByRole('button', { name: 'Not owned' }));

    await waitFor(() => expect(screen.queryByText('Void Empress')).toBeNull());
    expect(screen.getAllByText('???').length).toBe(2);
  });

  it('opens compact filters, keeps selections after close, and removes chips', async () => {
    const user = userEvent.setup();
    renderAt('/encyclopedia');

    await screen.findByText('Void Empress');
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'Spirit' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByText('Type')).toBeNull();
    expect(screen.getByRole('button', { name: /Type: Spirit/ })).toBeInTheDocument();
    expect(screen.getByText('Neon Kitsune')).toBeInTheDocument();
    expect(screen.queryByText('Void Empress')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    expect(await screen.findByRole('button', { name: 'Spirit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Type: Spirit/ }));
    expect(await screen.findByText('Void Empress')).toBeInTheDocument();
  });

  it('clears all encyclopedia filters', async () => {
    const user = userEvent.setup();
    renderAt('/encyclopedia?type=spirit&affinity=submissive&rarity=SR');

    expect(await screen.findByText('Neon Kitsune')).toBeInTheDocument();
    expect(screen.queryByText('Void Empress')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear All' }));

    expect(await screen.findByText('Void Empress')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Type: Spirit/ })).toBeNull();
  });

  it('filters encyclopedia entries by affinity', async () => {
    const user = userEvent.setup();
    renderAt('/encyclopedia');

    await screen.findByText('Void Empress');
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(await screen.findByRole('button', { name: 'Primal' }));

    expect(screen.getByText('Void Empress')).toBeInTheDocument();
    expect(screen.queryByText('Neon Kitsune')).toBeNull();
  });

  it('uses canonical race values for Type filters instead of malformed archetype prose', async () => {
    server.use(
      http.get('/api/v1/content/species', () =>
        data([
          {
            ...fixtures.contentSpecies[0]!,
            archetype: 'bronze-scaled dragongirl caravan master',
            race: 'demi-human',
          },
        ]),
      ),
    );

    const user = userEvent.setup();
    renderAt('/encyclopedia');

    await screen.findByText('Neko Barista');
    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(screen.getByRole('button', { name: 'Demi Human' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Bronze Scaled Dragongirl/ })).toBeNull();
  });

  it('offers a retry when the catalogue fails to load', async () => {
    server.use(
      http.get('/api/v1/content/species', () => apiError(500, 'INTERNAL_ERROR', 'Internal error.')),
    );
    renderAt('/encyclopedia');
    expect(await screen.findByText("Couldn't load the species catalogue.")).toBeInTheDocument();
  });
});

describe('SpeciesDetailPage', () => {
  it('renders a discovered entry with its lore and owned count', async () => {
    renderAt('/encyclopedia/void_empress');

    expect(await screen.findByRole('heading', { name: 'Void Empress' })).toBeInTheDocument();
    expect(screen.getByText(fixtures.contentSpecies[2]!.description)).toBeInTheDocument();
    expect(await screen.findByText('You own 1 copy.')).toBeInTheDocument();
  });

  it('locks an undiscovered entry without leaking its name or lore', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope([], 1, 25, 0)),
    );

    renderAt('/encyclopedia/void_empress');

    expect(await screen.findByRole('heading', { name: '???' })).toBeInTheDocument();
    expect(screen.getByText('Not currently owned')).toBeInTheDocument();
    expect(screen.queryByText(fixtures.contentSpecies[2]!.description)).toBeNull();
  });

  it('renders a 404 for an unknown slug', async () => {
    server.use(
      http.get('/api/v1/content/species/:slug', () =>
        apiError(404, 'SPECIES_NOT_FOUND', 'No species with that slug.'),
      ),
    );

    renderAt('/encyclopedia/nope');
    expect(await screen.findByText('No such species')).toBeInTheDocument();
  });
});

// ── Profile ─────────────────────────────────────────────────────────────────

describe('ProfilePage', () => {
  it('renders identity, statistics and the buddy summary', async () => {
    renderAt('/profile');

    expect(await screen.findByRole('heading', { name: 'Mika' })).toBeInTheDocument();
    expect(await screen.findByText(/Level 12/)).toHaveTextContent('3,480 XP');
    expect(screen.getByText('Owned')).toBeInTheDocument();
    expect(await screen.findByText('18 / 58')).toBeInTheDocument();
  });

  it('links shipped progress features and reserves a slot for unbuilt ones', async () => {
    renderAt('/profile');

    await screen.findByRole('heading', { name: 'Mika' });
    // Scoped to the section: the sidebar has its own Achievements link.
    const section = screen.getByRole('region', { name: 'More progress' });
    expect(within(section).getByRole('link', { name: /Achievements/ })).toHaveAttribute(
      'href',
      '/achievements',
    );
    expect(within(section).getByRole('link', { name: /Leaderboards/ })).toHaveAttribute(
      'href',
      '/leaderboards',
    );
    expect(within(section).getByText('Seasonal progress')).toBeInTheDocument();
    expect(within(section).getAllByText('Coming Soon').length).toBe(1);
  });

  it('explains that Owned excludes released copies and where lifetime captures count', async () => {
    renderAt('/profile');
    expect(await screen.findByText(/counts your active Waifumon/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Most Captures' })).toHaveAttribute(
      'href',
      '/leaderboards?metric=hunter',
    );
  });

  it('keeps the page usable when statistics fail', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/stats', () =>
        apiError(500, 'INTERNAL_ERROR', 'Internal error.'),
      ),
    );

    renderAt('/profile');
    expect(
      await screen.findByText("Couldn't load your collection statistics."),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mika' })).toBeInTheDocument();
  });
});

// ── Guide ───────────────────────────────────────────────────────────────────

describe('GuidePage', () => {
  it('reads tuning values into prose rather than dumping the table', async () => {
    renderAt('/guide');

    expect(await screen.findByRole('heading', { name: 'Hunting' })).toBeInTheDocument();
    // 120 seconds, presented to a player as minutes.
    expect(await screen.findByText('2 minutes')).toBeInTheDocument();
    expect(screen.getByText('2-second cooldown')).toBeInTheDocument();
    expect(screen.getByText('25 Energy')).toBeInTheDocument();

    // §8.9: no raw JSON and no tuning key names anywhere on the page.
    for (const key of ['encounterExpirySeconds', 'baseRatesByRarity', 'levelCurve', '{"']) {
      expect(document.body.textContent).not.toContain(key);
    }
  });

  it('turns base capture rates into a player-facing table', async () => {
    renderAt('/guide');

    expect(await screen.findByRole('heading', { name: 'Capturing Waifumon' })).toBeInTheDocument();
    const oddsRegion = await screen.findByRole('region', { name: 'Base capture chance table' });
    const oddsTable = within(oddsRegion).getByRole('table');
    expect(within(oddsTable).getByText('50%')).toBeInTheDocument();
    expect(within(oddsTable).getByText('Rarity: Ultra Rare')).toBeInTheDocument();
  });

  it('omits a section entirely when a balance patch removes its tuning key', async () => {
    server.use(http.get('/api/v1/content/tables', () => data({ hunt: {}, energy: {} })));

    renderAt('/guide');

    expect(await screen.findByRole('heading', { name: 'Hunting' })).toBeInTheDocument();
    // The section still renders; only the data-backed lines are gone, and the
    // base-rate table drops out rather than rendering empty.
    expect(await screen.findByText(/Rarity is rolled separately/)).toBeInTheDocument();
    expect(screen.queryByText('2 minutes')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Capturing Waifumon' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Base capture chance table' })).toBeNull();
  });

  it('builds the charm table from the item catalogue', async () => {
    renderAt('/guide');

    // Two tables on the page once both content queries land — charms (from the
    // item catalogue) and base capture odds (from tuning).
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2));
    const charmTable = screen
      .getAllByRole('table')
      .find((table) => table.textContent?.includes('Basic Charm'))!;
    expect(within(charmTable).getByText(/Basic Charm/)).toBeInTheDocument();
    expect(within(charmTable).getByText('×1.5 base capture chance')).toBeInTheDocument();
  });

  it('says evolution is not modelled yet rather than inventing it', async () => {
    renderAt('/guide');
    expect(await screen.findByText('There is currently no separate evolution system.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Evolution/ })).toBeNull();
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  it('switches theme and restates the dev-auth caveat', async () => {
    const user = userEvent.setup();
    renderAt('/settings');

    const light = await screen.findByRole('radio', { name: /Light/ });
    expect(screen.getByRole('radio', { name: /Dark/ })).toBeChecked();

    await user.click(light);

    await waitFor(() => expect(document.documentElement).not.toHaveClass('dark'));
    expect(light).toBeChecked();

    // Restated in full on the page, not only as the header chip (§26).
    expect(screen.getByText('This is a development build')).toBeInTheDocument();
    expect(screen.getByText(/acts as whichever player/i)).toBeInTheDocument();
  });

  it('reports the build identity without revealing the token', async () => {
    renderAt('/settings');

    expect(await screen.findByText('About')).toBeInTheDocument();
    expect(screen.getByText('Portal version')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('test-token');
  });
});
