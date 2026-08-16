/**
 * The detail page's Art ↔ Card switch and card export (plan §12, §22.2).
 *
 * Two properties are load-bearing and easy to regress:
 *
 *   1. **Artwork stays the default.** Cards are opt-in; a change that made them
 *      the landing state would put a render on every detail-page visit.
 *   2. **The control only exists when the backend can serve it.** Rendering is
 *      behind a backend flag, and the Portal learns that from
 *      `/v1/capabilities` rather than by requesting a card and reading the 404.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { data } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

function renderDetail(waifuId: string | number = 101) {
  return renderRoutes({ routes, initialEntries: [`/collection/${waifuId}`] });
}

/** Turns the backend feature off for one test. */
function withCardsDisabled(): void {
  server.use(http.get('/api/v1/capabilities', () => data({ cards: false })));
}

/** The hero `<img>` — the only image inside the sticky hero column. */
function heroImage(): HTMLImageElement {
  const images = screen.getAllByRole('img');
  const hero = images.find((img) => (img as HTMLImageElement).src.length > 0);
  return hero as HTMLImageElement;
}

describe('when the renderer is available', () => {
  it('defaults to raw artwork, not the card', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    const art = await screen.findByRole('button', { name: 'Art' });
    expect(art).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Card' })).toHaveAttribute('aria-pressed', 'false');
    expect(heroImage().src).not.toContain('/cards/');
  });

  it('offers the switch and the export control', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    expect(await screen.findByRole('group', { name: 'Hero image view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export card/i })).toBeInTheDocument();
  });

  it('switches the hero to the owned-copy card route', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));

    await waitFor(() => {
      // The owned route: it carries her level and equipped look server-side, so
      // the URL has neither.
      expect(heroImage().src).toContain('/api/v1/players/1/collection/owned/101/card');
    });
    expect(heroImage().src).not.toContain('level=');
    expect(heroImage().src).not.toContain('variant=');
  });

  it('requests a display-sized derivative, not the master', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));

    await waitFor(() => expect(heroImage().src).toContain('/card?width='));
  });

  it('switches back to artwork', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await waitFor(() => expect(heroImage().src).toContain('/cards/'.replace('/cards/', '/card')));

    await user.click(screen.getByRole('button', { name: 'Art' }));

    await waitFor(() => expect(heroImage().src).not.toContain('/card?'));
    expect(screen.getByRole('button', { name: 'Art' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('when the renderer is unavailable', () => {
  beforeEach(() => {
    withCardsDisabled();
  });

  it('still renders the page and the artwork', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
    expect(heroImage().src.length).toBeGreaterThan(0);
  });

  it('hides both card controls rather than offering something broken', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    expect(screen.queryByRole('group', { name: 'Hero image view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export card/i })).not.toBeInTheDocument();
  });

  it('never requests a card', async () => {
    const requested: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/card')) requested.push(request.url);
    });

    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requested).toEqual([]);
  });
});

describe('export', () => {
  beforeEach(() => {
    // jsdom implements neither, and the download helper needs both.
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn(() => 'blob:card'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() });
  });

  it('downloads the full-resolution master, not the displayed derivative', async () => {
    const requestedUrls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/card')) requestedUrls.push(request.url);
    });

    const clicks: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function mockClick(this: HTMLAnchorElement) {
      clicks.push(this);
    };

    try {
      const user = userEvent.setup();
      renderDetail();
      await screen.findByRole('heading', { name: 'Nyx' });

      await user.click(await screen.findByRole('button', { name: /export card/i }));

      await waitFor(() => expect(clicks).toHaveLength(1));

      // A real filename, and no internal ids in it.
      expect(clicks[0]?.download).toMatch(/^waifumon-void_empress.*\.webp$/);
      expect(clicks[0]?.download).not.toContain('101');

      // The export request carried no width — that is the full-size master.
      const exportUrl = requestedUrls.find((url) => !url.includes('width='));
      expect(exportUrl).toBeDefined();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('reports a failed save without breaking the page', async () => {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned/:waifuId/card', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
      ),
    );

    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Nyx' });

    await user.click(await screen.findByRole('button', { name: /export card/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/couldn.t save that card/i);
    // The page is still the page.
    expect(screen.getByRole('heading', { name: 'Nyx' })).toBeInTheDocument();
  });
});
