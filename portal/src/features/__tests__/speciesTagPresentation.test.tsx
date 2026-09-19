/**
 * Species tag presentation on both detail surfaces.
 *
 * The Waifumon detail (an owned copy) and the encyclopedia entry (a species)
 * render the same species metadata. Every assertion here runs against both, so
 * one page cannot start showing a tag the other hides.
 */
import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { data, page as pageEnvelope } from '../../../msw/handlers';
import * as fixtures from '../../../msw/fixtures';
import { server } from '../../../msw/server';
import { routes } from '@/app/router';
import { renderRoutes } from '@/test/renderWithProviders';

/** Copy 101 is a Void Empress, which also makes her discovered in the encyclopedia. */
const OWNED = fixtures.ownedEntries[0]!;
const SLUG = OWNED.species.slug;

const surfaces = [
  {
    name: 'Waifumon detail',
    heading: 'Nyx',
    render(tags: string[]) {
      server.use(
        http.get('/api/v1/players/:playerId/collection/owned/:waifuId', () =>
          data({ ...OWNED, species: { ...OWNED.species, tags } }),
        ),
      );
      renderRoutes({ routes, initialEntries: [`/collection/${OWNED.waifu.id}`] });
    },
  },
  {
    name: 'encyclopedia entry',
    heading: 'Void Empress',
    render(tags: string[]) {
      const species = fixtures.contentSpecies.find((s) => s.slug === SLUG)!;
      server.use(http.get('/api/v1/content/species/:slug', () => data({ ...species, tags })));
      renderRoutes({ routes, initialEntries: [`/encyclopedia/${SLUG}`] });
    },
  },
];

const RAW_TAGS =
  /waifu_valley|twin_peeks|twin_peaks|flaccid_foothills|thirstlands|region_exclusive|\bstarter\b|\bexpansion\b|internal_flag/;

describe.each(surfaces)('$name', (surface) => {
  async function show(tags: string[]): Promise<void> {
    surface.render(tags);
    await screen.findByRole('heading', { name: surface.heading, level: 1 });
  }

  it.each([
    [['starter', 'waifu_valley'], 'Waifu Valley'],
    [['expansion', 'region_exclusive', 'twin_peeks'], 'Twin Peeks'],
    [['expansion', 'region_exclusive', 'flaccid_foothills'], 'Flaccid Foothills'],
    [['expansion', 'region_exclusive', 'thirstlands'], 'Thirstlands'],
  ])('shows %j as the Zone "%s", never as raw tags', async (tags, label) => {
    await show(tags);

    expect(screen.getByText('Origin:', { exact: false }).parentElement).toHaveTextContent(
      `Origin: ${label}`,
    );
    expect(document.body.textContent).not.toMatch(RAW_TAGS);
  });

  it('labels region_exclusive as "Zone Exclusive"', async () => {
    await show(['expansion', 'region_exclusive', 'twin_peeks']);
    expect(screen.getByText('Zone Exclusive')).toBeInTheDocument();
  });

  it('shows no classification chip for a starter species', async () => {
    await show(['starter', 'waifu_valley']);
    expect(screen.queryByText(/Exclusive/)).toBeNull();
    expect(screen.queryByText(/^starter$/i)).toBeNull();
  });

  it('renders normally, with no Zone field, when no zone tag is recognised', async () => {
    await show(['expansion', 'region_exclusive']);

    expect(screen.queryByText('Origin:', { exact: false })).toBeNull();
    expect(screen.getByText('Rarity: Ultra Rare')).toBeInTheDocument();
    expect(screen.getByText('Zone Exclusive')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(RAW_TAGS);
  });

  it('does not leak unknown or legacy tags', async () => {
    await show(['internal_flag', 'twin_peaks', 'some_future_flag']);

    expect(screen.queryByText('Origin:', { exact: false })).toBeNull();
    expect(document.body.textContent).not.toMatch(RAW_TAGS);
    expect(document.body.textContent).not.toMatch(/some_future_flag/);
  });
});

/**
 * The Zone is the one piece of species metadata an undiscovered entry shows —
 * it says where to look, not what she is. Everything else stays gated.
 */
describe('undiscovered encyclopedia entry', () => {
  async function showUndiscovered(tags: string[]): Promise<void> {
    server.use(
      http.get('/api/v1/players/:playerId/collection/owned', () => pageEnvelope([], 1, 25, 0)),
    );
    surfaces[1]!.render(tags);
    await screen.findByText('Not currently owned');
    expect(screen.getByRole('heading', { name: '???', level: 1 })).toBeInTheDocument();
  }

  it('shows the Zone before discovery', async () => {
    await showUndiscovered(['expansion', 'region_exclusive', 'twin_peeks']);

    expect(screen.getByText('Origin:', { exact: false }).parentElement).toHaveTextContent(
      'Origin: Twin Peeks',
    );
    expect(document.body.textContent).not.toMatch(RAW_TAGS);
  });

  it('still withholds Type, Affinity, Content rating and tags', async () => {
    await showUndiscovered(['expansion', 'region_exclusive', 'twin_peeks']);

    expect(screen.queryByText('Type:', { exact: false })).toBeNull();
    expect(screen.queryByText('Affinity:', { exact: false })).toBeNull();
    expect(screen.queryByText('Content rating:', { exact: false })).toBeNull();
    expect(screen.queryByText('Zone Exclusive')).toBeNull();
    expect(screen.queryByText(/placeholder description/)).toBeNull();
  });

  it('omits the Zone when no zone tag is recognised', async () => {
    await showUndiscovered(['expansion', 'region_exclusive']);
    expect(screen.queryByText('Origin:', { exact: false })).toBeNull();
  });
});
