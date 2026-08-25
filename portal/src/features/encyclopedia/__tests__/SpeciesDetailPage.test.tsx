/**
 * The encyclopedia's Art ↔ Card switch.
 *
 * Same control and same rules as the collection hero, one context different:
 * this is the *species preview* card — the card as a definition — so it must
 * never reach for the owned route, and it must never carry ownership.
 *
 * The extra rule that only applies here: an undiscovered species is shown as a
 * silhouette, and a rendered card would show her artwork in full. Card mode is
 * therefore offered only once she has been discovered, or the toggle becomes a
 * way around the spoiler.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { data } from '../../../../msw/handlers';
import { server } from '../../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

/** `void_empress` is owned in the fixtures, so the encyclopedia discovers her. */
const DISCOVERED = 'void_empress';

function renderDetail(slug: string = DISCOVERED) {
  return renderRoutes({ routes, initialEntries: [`/encyclopedia/${slug}`] });
}

function withCardsDisabled(): void {
  server.use(http.get('/api/v1/capabilities', () => data({ cards: false })));
}

/** The hero `<img>` — the first image with a resolved source. */
function heroImage(): HTMLImageElement {
  const images = screen.getAllByRole('img');
  return images.find((img) => (img as HTMLImageElement).src.length > 0) as HTMLImageElement;
}

describe('when the renderer is available', () => {
  it('defaults to raw artwork', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    expect(await screen.findByRole('button', { name: 'Art' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(heroImage().src).not.toContain('/cards/');
  });

  it('offers the Art / Card switch', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    expect(await screen.findByRole('group', { name: 'Species image view' })).toBeInTheDocument();
  });

  it('switches the hero to the species-preview card route', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));

    await waitFor(() => {
      expect(heroImage().src).toContain(`/api/v1/cards/species/${DISCOVERED}`);
    });
    // The species preview, never an owned copy: no ownership in this context.
    expect(heroImage().src).not.toContain('/collection/owned/');
  });

  it('requests a display-sized derivative, not the master', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await waitFor(() => expect(heroImage().src).toContain('/cards/species/'));
    expect(heroImage().src).toContain('width=');
  });
});

describe('the card viewer', () => {
  it('opens an enlarged card when the hero is clicked in Card mode', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await user.click(await screen.findByRole('button', { name: /enlarge void empress card/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
  });

  it('shows the 1024 derivative inside the viewer, never the master', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await user.click(await screen.findByRole('button', { name: /enlarge void empress card/i }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      const img = dialog.querySelector('img');
      expect(img?.src).toContain('width=1024');
    });
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await user.click(await screen.findByRole('button', { name: /enlarge void empress card/i }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is not reachable in Art mode', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    expect(screen.queryByRole('button', { name: /enlarge/i })).not.toBeInTheDocument();
  });
});

describe('when the renderer is unavailable', () => {
  it('hides the Card control entirely', async () => {
    withCardsDisabled();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Species image view' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Card' })).not.toBeInTheDocument();
  });

  it('requests no card asset at all', async () => {
    const requested: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/cards/')) requested.push(request.url);
    });

    withCardsDisabled();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });
    await waitFor(() => expect(heroImage().src.length).toBeGreaterThan(0));

    expect(requested).toEqual([]);
  });

  it('still shows the raw artwork', async () => {
    withCardsDisabled();
    renderDetail();
    await screen.findByRole('heading', { name: 'Void Empress' });

    await waitFor(() => expect(heroImage().src.length).toBeGreaterThan(0));
    expect(heroImage().src).not.toContain('/cards/');
  });
});
