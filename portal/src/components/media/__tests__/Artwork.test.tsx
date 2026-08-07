/**
 * `<Artwork>` behaviour (plan §22.1, §22.4).
 *
 * Alt text is the assertion that matters most: §12 puts alt-text generation at
 * the resolver precisely so no page can ship an image with a filename for a
 * label.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { Artwork } from '../Artwork';
import { createLocalDevAssetsProvider } from '@/images/providers/localDevAssets';
import { createSilhouetteProvider } from '@/images/providers/silhouette';
import { setImageProviderChain } from '@/images/provider';

beforeEach(() => {
  setImageProviderChain([createLocalDevAssetsProvider(), createSilhouetteProvider()]);
});

describe('Artwork', () => {
  it('derives alt text from the resource, not the URL', () => {
    render(
      <Artwork
        asset={{ kind: 'species', slug: 'void_empress' }}
        name="Void Empress"
        rarityLabel="Ultra Rare"
      />,
    );
    expect(screen.getByAltText('Void Empress — Ultra Rare')).toBeInTheDocument();
  });

  it('lazy-loads by default and eagerly for priority art', () => {
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" />,
    );
    expect(screen.getByAltText('Neko Barista')).toHaveAttribute('loading', 'lazy');

    rerender(
      <Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" priority />,
    );
    expect(screen.getByAltText('Neko Barista')).toHaveAttribute('loading', 'eager');
  });

  it('yields the connection pool for lazy art and claims it for a hero', () => {
    // Artwork and the API share one HTTP/1.1 origin in dev. Grid tiles marked
    // `low` are what stops twenty images holding every socket while the JSON
    // the page is actually waiting on queues behind them.
    const { rerender } = render(
      <Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" />,
    );
    expect(screen.getByAltText('Neko Barista')).toHaveAttribute('fetchpriority', 'low');

    rerender(
      <Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" priority />,
    );
    expect(screen.getByAltText('Neko Barista')).toHaveAttribute('fetchpriority', 'high');
  });

  it('requests a rendition when the call site says how wide it draws', () => {
    render(
      <Artwork
        asset={{ kind: 'species', slug: 'neko_barista' }}
        name="Neko Barista"
        displayWidth={256}
      />,
    );
    expect(screen.getByAltText('Neko Barista')).toHaveAttribute(
      'src',
      '/dev-assets/t/256/waifumon/neko_barista/standard.png',
    );
  });

  it('swaps to the silhouette when the resolved URL fails to load', () => {
    render(<Artwork asset={{ kind: 'species', slug: 'neon_kitsune' }} name="Neon Kitsune" />);

    const img = screen.getByAltText('Neon Kitsune');
    expect(img).toHaveAttribute('src', '/dev-assets/waifumon/neon_kitsune/standard.png');

    fireEvent.error(img);

    expect(screen.getByAltText('Neon Kitsune')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml'),
    );
  });

  it('renders the silhouette and an undiscovered label when forced', () => {
    render(<Artwork asset={{ kind: 'species', slug: 'secret' }} name="Secret" silhouette />);
    expect(screen.getByAltText('Undiscovered Waifumon silhouette')).toBeInTheDocument();
  });

  it('reserves space with a skeleton until the image loads', () => {
    render(<Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" />);
    const img = screen.getByAltText('Neko Barista');

    expect(document.querySelector('.skeleton')).not.toBeNull();
    fireEvent.load(img);
    expect(document.querySelector('.skeleton')).toBeNull();
  });
});
