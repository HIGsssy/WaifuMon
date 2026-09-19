/**
 * The Admin Waifumon Gallery pages against the MSW gallery fixtures.
 *
 * Pinned: `gallery.read` gates the nav entry and both routes; one metadata
 * request per page (never one per species or appearance); filters live in the
 * URL; missing and unsafe artwork render the admin QA placeholder rather than
 * the player silhouette; every authored appearance renders with its runtime
 * and artwork state; the lightbox walks every appearance, missing ones
 * included; and previous/next follow the filtered order.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { routes } from '@/app/router';
import { SessionContext } from '@/auth/SessionContext';
import type { PortalSession, SessionState } from '@/auth/types';
import { NavList } from '@/components/layout/NavList';
import { expectNoAxeViolations } from '@/test/axe';
import { http } from 'msw';

import { apiError } from '../../../../msw/handlers';
import { adminGalleryCatalog } from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { AdminGalleryPage } from '../AdminGalleryPage';
import { AdminGallerySpeciesPage } from '../AdminGallerySpeciesPage';

const GALLERY = ['gallery.read'];

function sessionState(permissions: readonly string[]): SessionState {
  const session: PortalSession = {
    playerId: 1,
    guildDbId: 1,
    displayName: 'Curator',
    avatarUrl: null,
    permissions,
  };
  return { status: 'ready', session, error: null, configuredPlayerId: undefined, retry: () => {} };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

let requests: string[] = [];
const onRequest = ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  requests.push(url.pathname);
};

beforeEach(() => {
  requests = [];
  server.events.on('request:start', onRequest);
});
afterEach(() => {
  server.events.removeListener('request:start', onRequest);
});

const catalogRequests = () => requests.filter((p) => p === '/api/v1/admin/gallery/species');
const detailRequests = () => requests.filter((p) => p.startsWith('/api/v1/admin/gallery/species/'));

function Wrap({
  children,
  permissions = GALLERY,
  initial,
}: {
  children: React.ReactNode;
  permissions?: readonly string[];
  initial: string;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionState(permissions)}>
        <MemoryRouter initialEntries={[initial]}>
          {children}
          <LocationProbe />
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

function renderAt(initial: string, permissions: readonly string[] = GALLERY) {
  return render(
    <Wrap initial={initial} permissions={permissions}>
      <Routes>
        <Route path="/admin/gallery" element={<AdminGalleryPage />} />
        <Route path="/admin/gallery/:slug" element={<AdminGallerySpeciesPage />} />
      </Routes>
    </Wrap>,
  );
}

const location = () => screen.getByTestId('location').textContent ?? '';
const tile = (slug: string) => screen.getByTestId(`gallery-tile-${slug}`);
const visibleTiles = () =>
  screen
    .queryAllByTestId(/^gallery-tile-/)
    .map((el) => el.dataset.testid!.replace('gallery-tile-', ''));

async function loadedGallery(url = '/admin/gallery') {
  renderAt(url);
  await screen.findByTestId('gallery-summary');
}

function findRoute(path: string): (typeof routes)[number] | undefined {
  const walk = (list: typeof routes): (typeof routes)[number] | undefined => {
    for (const r of list) {
      if (r.path === path) return r;
      const nested = r.children ? walk(r.children) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(routes);
}

// ── Permission and navigation ─────────────────────────────────────────────────

describe('permission and navigation', () => {
  it('shows the nav entry with gallery.read', () => {
    render(
      <Wrap initial="/" permissions={GALLERY}>
        <NavList />
      </Wrap>,
    );
    expect(screen.getByRole('link', { name: /Admin — Waifumon Gallery/ })).toHaveAttribute(
      'href',
      '/admin/gallery',
    );
  });

  it('hides it without gallery.read, whatever else the session holds', () => {
    render(
      <Wrap
        initial="/"
        permissions={[
          'admin.access',
          'encounters.read',
          'presentations.read',
          'presentations.write',
        ]}
      >
        <NavList />
      </Wrap>,
    );
    expect(screen.queryByRole('link', { name: /Waifumon Gallery/ })).toBeNull();
  });

  it.each(['admin/gallery', 'admin/gallery/:slug'])(
    'guards %s: without gallery.read nothing renders and nothing is fetched',
    async (path) => {
      const route = findRoute(path);
      expect(route).toBeDefined();
      render(
        <Wrap initial="/admin/gallery" permissions={['admin.access', 'presentations.read']}>
          {route!.element}
        </Wrap>,
      );
      expect(screen.getByText('Page not found')).toBeInTheDocument();
      expect(screen.queryByText('Waifumon Gallery')).toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      expect(catalogRequests()).toHaveLength(0);
      expect(detailRequests()).toHaveLength(0);
    },
  );
});

// ── Gallery page ──────────────────────────────────────────────────────────────

describe('gallery page', () => {
  it('fetches the catalog once and no species detail', async () => {
    await loadedGallery();
    expect(visibleTiles()).toHaveLength(6);
    expect(catalogRequests()).toHaveLength(1);
    expect(detailRequests()).toHaveLength(0);
  });

  it('shows the API summary', async () => {
    await loadedGallery();
    const s = adminGalleryCatalog.summary;
    expect(screen.getByTestId('gallery-summary')).toHaveTextContent(
      `${s.authoredSpecies} authored · ${s.runtimeLoadedSpecies} loaded · ${s.unloadedSpecies} future · ${s.authoredAppearances} appearances · ${s.artworkAvailableAppearances} with artwork · ${s.speciesWithIssues} species with issues`,
    );
  });

  it('Refresh refetches the catalog', async () => {
    const user = userEvent.setup();
    await loadedGallery();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(catalogRequests()).toHaveLength(2));
  });

  it('renders the catalog error visibly', async () => {
    server.use(
      http.get('/api/v1/admin/gallery/species', () =>
        apiError(500, 'INTERNAL_ERROR', 'Something broke.'),
      ),
    );
    renderAt('/admin/gallery');
    expect(await screen.findByText("Couldn't load the Waifumon Gallery.")).toBeInTheDocument();
  });

  it('renders a 403 visibly rather than an empty gallery', async () => {
    server.use(
      http.get('/api/v1/admin/gallery/species', () =>
        apiError(403, 'PORTAL_PERMISSION_DENIED', 'You do not have permission to do that.'),
      ),
    );
    renderAt('/admin/gallery');
    expect(await screen.findByText("Couldn't load the Waifumon Gallery.")).toBeInTheDocument();
    expect(visibleTiles()).toHaveLength(0);
  });
});

describe('species tiles', () => {
  it('requests the primary artwork at the 256 rendition through the admin route', async () => {
    await loadedGallery();
    const img = within(tile('alley_catgirl')).getByRole('img', {
      name: 'Alley Catgirl — default artwork',
    });
    expect(img).toHaveAttribute(
      'src',
      '/api/v1/admin/gallery/species/alley_catgirl/appearances/standard/artwork?width=256',
    );
  });

  it('shows runtime and enabled state as separate, worded badges', async () => {
    await loadedGallery();
    expect(tile('star_marshal')).toHaveTextContent('Future');
    expect(tile('star_marshal')).toHaveTextContent('Enabled');
    expect(tile('alley_catgirl')).toHaveTextContent('Loaded');
    expect(tile('retired_idol')).toHaveTextContent('Loaded');
    expect(tile('retired_idol')).toHaveTextContent('Disabled');
    expect(tile('ghost_girl')).toHaveTextContent('Disabled (loader)');
  });

  it('shows zone or No Zone, and the appearance count', async () => {
    await loadedGallery();
    expect(tile('onsen_maid')).toHaveTextContent('Twin Peeks');
    expect(tile('star_marshal')).toHaveTextContent('No Zone');
    expect(tile('alley_catgirl')).toHaveTextContent('6 appearances');
  });

  it('shows an issue count in words', async () => {
    await loadedGallery();
    const onsen = adminGalleryCatalog.species.find((s) => s.slug === 'onsen_maid')!;
    expect(tile('onsen_maid')).toHaveTextContent(`${onsen.issues.length} issues`);
    expect(tile('alley_catgirl')).not.toHaveTextContent(/issue/);
  });

  it('renders known-missing primary artwork as the QA placeholder, with no request', async () => {
    await loadedGallery();
    const ghost = tile('ghost_girl');
    expect(ghost.querySelector('img')).toBeNull();
    expect(within(ghost).getByTestId('artwork-problem-missing')).toHaveTextContent(
      'Artwork Missing',
    );
    expect(within(ghost).queryByAltText(/silhouette/i)).toBeNull();
  });

  it('renders unsafe primary artwork as unavailable', async () => {
    await loadedGallery();
    expect(within(tile('chrome_corsair')).getByTestId('artwork-problem-unsafe')).toHaveTextContent(
      'Artwork Unavailable',
    );
  });

  it('keeps a tile without artwork navigable, carrying the filters', async () => {
    await loadedGallery('/admin/gallery?health=issues');
    expect(tile('ghost_girl')).toHaveAttribute('href', '/admin/gallery/ghost_girl?health=issues');
  });
});

describe('filters and URL state', () => {
  it('searches by name and by slug', async () => {
    const user = userEvent.setup();
    await loadedGallery();
    const box = screen.getByRole('textbox', { name: 'Search species by name or slug' });
    await user.type(box, 'onsen');
    await waitFor(() => expect(visibleTiles()).toEqual(['onsen_maid']));
    expect(location()).toContain('q=onsen');
    await user.clear(box);
    await user.type(box, 'star_mar');
    await waitFor(() => expect(visibleTiles()).toEqual(['star_marshal']));
  });

  it('applies filters from the URL, combined', async () => {
    await loadedGallery('/admin/gallery?runtime=future&health=issues');
    expect(visibleTiles()).toEqual(['chrome_corsair']);
    expect(screen.getByText('Runtime: Future')).toBeInTheDocument();
    expect(screen.getByText('Has Issues')).toBeInTheDocument();
  });

  it('writes filter choices to the URL', async () => {
    const user = userEvent.setup();
    await loadedGallery();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await user.click(screen.getByRole('button', { name: 'No Zone' }));
    expect(location()).toBe('/admin/gallery?zone=none');
    expect(visibleTiles()).toEqual(['chrome_corsair', 'star_marshal']);
    await user.click(screen.getByRole('button', { name: 'Disabled' }));
    expect(location()).toBe('/admin/gallery?zone=none&enabled=disabled');
    expect(await screen.findByText('No species match your filters')).toBeInTheDocument();
  });

  it.each([
    ['rarity=UR', ['ghost_girl']],
    ['type=angel', ['retired_idol']],
    ['affinity=caregiver', ['onsen_maid']],
    ['zone=waifu_valley', ['alley_catgirl', 'ghost_girl']],
    ['runtime=loaded', ['alley_catgirl', 'ghost_girl', 'onsen_maid', 'retired_idol']],
    ['enabled=enabled', ['alley_catgirl', 'chrome_corsair', 'onsen_maid', 'star_marshal']],
    ['health=clean', ['alley_catgirl', 'retired_idol', 'star_marshal']],
    ['rating=suggestive', ['alley_catgirl', 'retired_idol']],
  ])('?%s', async (query, expected) => {
    await loadedGallery(`/admin/gallery?${query}`);
    expect(visibleTiles()).toEqual(expected);
  });

  it('degrades invalid URL values to All', async () => {
    await loadedGallery(
      '/admin/gallery?rarity=ZZ&type=dragon&zone=twin_peaks&runtime=maybe&health=x&rating=gory',
    );
    expect(visibleTiles()).toHaveLength(6);
    expect(screen.queryByRole('button', { name: 'Clear All' })).toBeNull();
  });

  it('Clear All resets every filter and the URL', async () => {
    const user = userEvent.setup();
    await loadedGallery('/admin/gallery?runtime=future&rating=explicit&q=star');
    await waitFor(() => expect(visibleTiles()).toEqual(['star_marshal']));
    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    expect(location()).toBe('/admin/gallery');
    await waitFor(() => expect(visibleTiles()).toHaveLength(6));
    expect(screen.getByRole('textbox', { name: 'Search species by name or slug' })).toHaveValue('');
  });
});

// ── Species detail ────────────────────────────────────────────────────────────

describe('species detail', () => {
  async function openOnsen(query = '') {
    renderAt(`/admin/gallery/onsen_maid${query}`);
    await screen.findByRole('heading', { level: 1, name: 'Onsen Maid' });
  }
  const card = (id: string) => screen.getByTestId(`appearance-card-${id}`);

  it('makes one detail request, and no per-appearance metadata request', async () => {
    await openOnsen();
    await waitFor(() => expect(catalogRequests().length).toBeLessThanOrEqual(1));
    expect(detailRequests()).toEqual(['/api/v1/admin/gallery/species/onsen_maid']);
  });

  it('renders every authored appearance in API order', async () => {
    await openOnsen();
    const ids = screen
      .getAllByTestId(/^appearance-card-/)
      .map((el) => el.dataset.testid!.replace('appearance-card-', ''));
    expect(ids).toEqual(['standard', 'level_10', 'level_20', 'level_30', 'level_40', 'level_50']);
  });

  it('marks the default appearance and shows unlock requirements', async () => {
    await openOnsen();
    expect(within(card('standard')).getByText('Default')).toBeInTheDocument();
    expect(within(card('level_10')).queryByText('Default')).toBeNull();
    expect(card('standard')).toHaveTextContent('Owned');
    expect(card('level_30')).toHaveTextContent('Reach Level 30');
    expect(card('level_30')).toHaveTextContent('(level ≥ 30)');
  });

  it('makes an authored appearance the runtime dropped unmistakable', async () => {
    await openOnsen();
    const state = within(card('level_40')).getByRole('list', { name: 'Appearance state' });
    expect(state).toHaveTextContent('AuthoredYes');
    expect(state).toHaveTextContent('RuntimeNo');
    expect(state).toHaveTextContent('ArtworkMissing');
    expect(card('level_40')).toHaveTextContent('Loader dropped this appearance: artwork missing');
    expect(card('level_40')).toHaveTextContent('Not present in runtime catalog');
    expect(within(card('level_40')).getByTestId('artwork-problem-missing')).toBeInTheDocument();
    expect(
      within(card('level_50')).getByRole('list', { name: 'Appearance state' }),
    ).toHaveTextContent('RuntimeYes');
  });

  it('shows PNG-only artwork and missing thumbnails', async () => {
    await openOnsen();
    expect(card('level_10')).toHaveTextContent('ArtworkPNG');
    expect(card('level_10')).toHaveTextContent('PNG only');
    expect(card('level_20')).toHaveTextContent('Missing thumbnails');
    expect(card('level_20')).toHaveTextContent('512 missing');
    expect(card('level_20')).toHaveTextContent('256 present');
  });

  it('shows metadata that exists and none that does not', async () => {
    await openOnsen();
    expect(card('standard')).toHaveTextContent('waifumon/onsen_maid/standard');
    expect(card('standard')).toHaveTextContent('Mature (inherited)');
    expect(card('standard')).not.toHaveTextContent('Introduced');
    expect(card('standard')).not.toHaveTextContent('Tags');
    expect(card('standard')).not.toHaveTextContent('—');
  });

  it('requests appearance artwork at the 512 rendition', async () => {
    await openOnsen();
    expect(within(card('level_50')).getByRole('img')).toHaveAttribute(
      'src',
      '/api/v1/admin/gallery/species/onsen_maid/appearances/level_50/artwork?width=512',
    );
  });

  it('shows the species header, source and findings', async () => {
    await openOnsen();
    expect(screen.getByText('onsen_maid')).toBeInTheDocument();
    expect(screen.getByText('Twin Peaks (pack enabled)')).toBeInTheDocument();
    const findings = screen.getByRole('region', { name: 'Findings' });
    expect(findings).toHaveTextContent('Artwork missing');
    expect(findings).toHaveTextContent('PNG only');
  });

  it('a failed image switches that card to the placeholder and leaves the page intact', async () => {
    await openOnsen();
    fireEvent.error(within(card('level_30')).getByRole('img'));
    expect(within(card('level_30')).getByTestId('artwork-problem-failed')).toBeInTheDocument();
    expect(within(card('level_50')).getByRole('img')).toHaveAttribute('src');
    expect(screen.getAllByTestId(/^appearance-card-/)).toHaveLength(6);
  });

  it('shows a future species from a disabled pack', async () => {
    renderAt('/admin/gallery/star_marshal');
    await screen.findByRole('heading', { level: 1, name: 'Star Marshal' });
    expect(screen.getByText('Assteroid Belt (pack disabled)')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('appearance-card-level_10')).getByRole('list', {
        name: 'Appearance state',
      }),
    ).toHaveTextContent('RuntimeNot loaded');
  });

  it('answers an unknown slug with Species not found', async () => {
    renderAt('/admin/gallery/nobody_girl');
    expect(await screen.findByText('Species not found')).toBeInTheDocument();
  });

  it('renders a detail API error visibly', async () => {
    server.use(
      http.get('/api/v1/admin/gallery/species/:slug', () =>
        apiError(500, 'INTERNAL_ERROR', 'Something broke.'),
      ),
    );
    renderAt('/admin/gallery/onsen_maid');
    expect(await screen.findByText("Couldn't load this species.")).toBeInTheDocument();
  });

  it('pages to the previous/next species in the filtered order, keeping the filters', async () => {
    await openOnsen('?runtime=loaded');
    const prev = await screen.findByRole('link', { name: 'Previous species: Ghost Girl' });
    expect(prev).toHaveAttribute('href', '/admin/gallery/ghost_girl?runtime=loaded');
    expect(screen.getByRole('link', { name: 'Next species: Retired Idol' })).toHaveAttribute(
      'href',
      '/admin/gallery/retired_idol?runtime=loaded',
    );
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Waifumon Gallery' })).toHaveAttribute(
      'href',
      '/admin/gallery?runtime=loaded',
    );
  });

  it('navigates to the next species', async () => {
    const user = userEvent.setup();
    await openOnsen('?runtime=loaded');
    await user.click(await screen.findByRole('link', { name: 'Next species: Retired Idol' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Retired Idol' }),
    ).toBeInTheDocument();
    expect(location()).toBe('/admin/gallery/retired_idol?runtime=loaded');
  });
});

describe('lightbox', () => {
  async function openLightbox(id = 'standard') {
    const user = userEvent.setup();
    renderAt('/admin/gallery/onsen_maid');
    await screen.findByRole('heading', { level: 1, name: 'Onsen Maid' });
    const name = id === 'standard' ? 'Standard' : id.replace('level_', 'Level ');
    await user.click(screen.getByRole('button', { name: `Enlarge ${name} artwork` }));
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('opens valid artwork at the 1024 rendition with an accessible title', async () => {
    const { dialog } = await openLightbox();
    expect(
      within(dialog).getByRole('heading', { name: 'Onsen Maid — Standard' }),
    ).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('Onsen Maid — Standard');
    expect(dialog).toHaveTextContent('standard · 1 of 6');
    expect(within(dialog).getByRole('img', { name: 'Onsen Maid — Standard' })).toHaveAttribute(
      'src',
      '/api/v1/admin/gallery/species/onsen_maid/appearances/standard/artwork?width=1024',
    );
  });

  it('offers the original only as an explicit link to the same secure route', async () => {
    const { dialog } = await openLightbox();
    const link = within(dialog).getByRole('link', { name: 'Open original' });
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/admin/gallery/species/onsen_maid/appearances/standard/artwork',
    );
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('traps focus and closes on Escape', async () => {
    const { user, dialog } = await openLightbox();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves with the buttons and the arrow keys, wrapping around', async () => {
    const { user, dialog } = await openLightbox();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Onsen Maid — Level 10');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Onsen Maid — Level 20');
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Onsen Maid — Level 50');
  });

  it('reaches a missing appearance and shows its missing state, not a silhouette', async () => {
    const { user } = await openLightbox('level_30');
    await user.keyboard('{ArrowRight}');
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Onsen Maid — Level 40');
    expect(within(dialog).getByTestId('artwork-problem-missing')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Open original' })).toBeNull();
  });
});

describe('accessibility', () => {
  it('the gallery page has no axe violations', async () => {
    const { container } = renderAt('/admin/gallery');
    await screen.findByTestId('gallery-summary');
    await expectNoAxeViolations(container);
  });

  it('the species page has no axe violations', async () => {
    const { container } = renderAt('/admin/gallery/onsen_maid');
    await screen.findByRole('heading', { level: 1, name: 'Onsen Maid' });
    await expectNoAxeViolations(container);
  });

  it('the open lightbox has no axe violations', async () => {
    const user = userEvent.setup();
    renderAt('/admin/gallery/onsen_maid');
    await screen.findByRole('heading', { level: 1, name: 'Onsen Maid' });
    await user.click(screen.getByRole('button', { name: 'Enlarge Standard artwork' }));
    await screen.findByRole('dialog');
    await expectNoAxeViolations(document.body);
  });

  it('labels the search box and the filter groups', async () => {
    const user = userEvent.setup();
    await loadedGallery();
    expect(
      screen.getByRole('textbox', { name: 'Search species by name or slug' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    for (const legend of [
      'Runtime',
      'Enabled',
      'Artwork health',
      'Zone',
      'Rarity',
      'Content rating',
    ]) {
      expect(screen.getByRole('group', { name: legend })).toBeInTheDocument();
    }
  });
});
