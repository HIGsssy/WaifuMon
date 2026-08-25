/**
 * The collection grid's Art ↔ Card switch (plan §12, §22.2).
 *
 * Four properties, and every one of them is a thing a well-meaning change
 * would break:
 *
 *   1. **Art is the default.** Cards are an opt-in rollout; a grid that landed
 *      on Card mode would turn every first page load into twenty-five card
 *      requests against a cache that may be cold.
 *   2. **The control exists only when the backend can render.**
 *      `/v1/capabilities` is the single authority — there is no `VITE_` copy of
 *      the flag to disagree with it.
 *   3. **The grid asks for a tile-sized card.** `ARTWORK_WIDTH.gridTile` goes in,
 *      the resolver's device-pixel bucket comes out — 256 at 1×, 512 at 2×. No
 *      component names a width in the URL.
 *   4. **A card that fails costs one tile.** It falls back to that copy's own
 *      artwork, and the other tiles carry on in Card mode.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { data, page as pageEnvelope } from '../../../../msw/handlers';
import * as fixtures from '../../../../msw/fixtures';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';
import { ARTWORK_WIDTH } from '@/images/sizes';

function renderCollection(url = '/collection') {
  return renderRoutes({ routes, initialEntries: [url] });
}

/** Turns the backend feature off for one test. */
function withCardsDisabled(): void {
  server.use(http.get('/api/v1/capabilities', () => data({ cards: false })));
}

/** The grid's tiles, in DOM order. Every one links at one owned copy. */
function tiles(): HTMLAnchorElement[] {
  return (screen.getAllByRole('link') as HTMLAnchorElement[]).filter((link) =>
    /^\/collection\/\d+$/.test(link.getAttribute('href') ?? ''),
  );
}

function tileImages(): HTMLImageElement[] {
  return tiles().map((tile) => within(tile).getByRole('img') as HTMLImageElement);
}

/** Card URLs currently on screen — the owned route is the only card route here. */
function cardSrcs(): string[] {
  return tileImages()
    .map((img) => img.src)
    .filter((src) => src.includes('/collection/owned/'));
}

async function switchToCards(): Promise<void> {
  const user = userEvent.setup();
  const toggle = await screen.findByRole('group', { name: 'Collection tile view' });
  await user.click(within(toggle).getByRole('button', { name: 'Card' }));
  await waitFor(() => expect(cardSrcs().length).toBeGreaterThan(0));
}

/** `devicePixelRatio` is a getter on jsdom's window; this replaces it per test. */
function withDevicePixelRatio(ratio: number): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
  return () => {
    if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'devicePixelRatio');
  };
}

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('Art mode (the default)', () => {
  it('lands on Art, with the switch offered but not engaged', async () => {
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    const toggle = await screen.findByRole('group', { name: 'Collection tile view' });
    expect(within(toggle).getByRole('button', { name: 'Art' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(toggle).getByRole('button', { name: 'Card' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('draws raw artwork and requests no cards at all', async () => {
    const requested: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/card')) requested.push(request.url);
    });

    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    expect(cardSrcs()).toEqual([]);
    // Artwork still comes from the asset provider, exactly as before.
    expect(tileImages()[0]?.src).toContain('/dev-assets/');
    expect(requested).toEqual([]);
  });
});

describe('Card mode', () => {
  it('switches every tile to that copy’s owned card route', async () => {
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    await switchToCards();

    // The owned route carries her level and equipped look server-side, so the
    // URL says neither.
    expect(cardSrcs()).toHaveLength(fixtures.ownedEntries.length);
    expect(cardSrcs()[0]).toContain('/api/v1/players/1/collection/owned/101/card');
    for (const src of cardSrcs()) {
      expect(src).not.toContain('level=');
      expect(src).not.toContain('variant=');
    }
  });

  it('asks for the 256 bucket on a 1× display', async () => {
    restores.push(withDevicePixelRatio(1));
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    await switchToCards();

    // 256 CSS px × 1 → the 256 bucket. The component named a CSS width, not a
    // bucket; the resolver did the rest.
    expect(ARTWORK_WIDTH.gridTile).toBe(256);
    for (const src of cardSrcs()) expect(src).toContain('width=256');
  });

  it('asks for the 512 bucket on a 2× display', async () => {
    restores.push(withDevicePixelRatio(2));
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    await switchToCards();

    for (const src of cardSrcs()) expect(src).toContain('width=512');
  });

  it('never asks for the master or the hero bucket', async () => {
    restores.push(withDevicePixelRatio(2));
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    await switchToCards();

    for (const src of cardSrcs()) {
      expect(src).toContain('width=');
      expect(src).not.toContain('width=1024');
      expect(src).not.toContain('width=1500');
    }
  });

  it('keeps the first four tiles eager and lazy-loads the rest', async () => {
    // The default fixture has three copies — fewer than EAGER_CARDS — so the
    // boundary needs a bigger page to be observable at all.
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () =>
        pageEnvelope(
          Array.from({ length: 8 }, (_, index) => {
            const source = fixtures.ownedEntries[index % fixtures.ownedEntries.length]!;
            return { ...source, waifu: { ...source.waifu, id: 200 + index } };
          }),
          1,
          25,
          8,
        ),
      ),
    );

    renderCollection();
    // The page repeats the three fixture copies, so a name is not unique here —
    // wait on the tile count instead.
    await waitFor(() => expect(tiles()).toHaveLength(8));
    await switchToCards();

    const loading = tileImages().map((img) => img.getAttribute('loading'));
    expect(loading.slice(0, 4)).toEqual(['eager', 'eager', 'eager', 'eager']);
    expect(loading.slice(4)).toEqual(['lazy', 'lazy', 'lazy', 'lazy']);
  });

  it('leaves click-through to the detail page unchanged', async () => {
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await switchToCards();

    expect(tiles()[0]).toHaveAttribute('href', '/collection/101');
  });

  it('keeps filtering and sorting working', async () => {
    const user = userEvent.setup();
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await switchToCards();

    await user.type(
      screen.getByLabelText('Search the current page of your collection'),
      'Kitsune',
    );

    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Neon Kitsune/ })).toBeInTheDocument();
  });

  it('switches back to Art without leaving a card behind', async () => {
    const user = userEvent.setup();
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await switchToCards();

    const toggle = screen.getByRole('group', { name: 'Collection tile view' });
    await user.click(within(toggle).getByRole('button', { name: 'Art' }));

    await waitFor(() => expect(cardSrcs()).toEqual([]));
  });
});

describe('a card that will not load', () => {
  it('falls back to that copy’s artwork, and only that tile', async () => {
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await switchToCards();

    const before = cardSrcs().length;
    fireEvent.error(tileImages()[0]!);

    await waitFor(() => expect(cardSrcs()).toHaveLength(before - 1));
    // The failed tile shows real artwork — not a silhouette, and not a broken
    // image. The rest of the grid is still in Card mode.
    expect(tileImages()[0]!.src).toContain('/dev-assets/');
    expect(tileImages()[0]!.src).not.toContain('silhouette');
    expect(tileImages()[1]!.src).toContain('/collection/owned/');
  });

  it('does not re-request the card when the mode is toggled again', async () => {
    const user = userEvent.setup();
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await switchToCards();

    fireEvent.error(tileImages()[0]!);
    await waitFor(() => expect(tileImages()[0]!.src).toContain('/dev-assets/'));

    const toggle = screen.getByRole('group', { name: 'Collection tile view' });
    await user.click(within(toggle).getByRole('button', { name: 'Art' }));
    await user.click(within(toggle).getByRole('button', { name: 'Card' }));

    // A card that 404'd once will 404 again; asking a second time buys a
    // guaranteed-failing request.
    await waitFor(() => expect(cardSrcs()).toHaveLength(fixtures.ownedEntries.length - 1));
    expect(tileImages()[0]!.src).toContain('/dev-assets/');
  });
});

describe('when the renderer is unavailable', () => {
  it('offers no switch at all', async () => {
    withCardsDisabled();
    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });

    expect(screen.queryByRole('group', { name: 'Collection tile view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
  });

  it('draws the raw-artwork grid and requests no cards', async () => {
    withCardsDisabled();
    const requested: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/card')) requested.push(request.url);
    });

    renderCollection();
    await screen.findByRole('link', { name: /Nyx/ });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cardSrcs()).toEqual([]);
    expect(tileImages()[0]?.src).toContain('/dev-assets/');
    expect(requested).toEqual([]);
  });
});
