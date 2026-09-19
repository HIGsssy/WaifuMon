/**
 * `AdminGalleryArtwork` — QA failure semantics on top of player `<Artwork>`.
 *
 * Missing artwork must look missing: a known-missing or unsafe file renders
 * the QA placeholder without making a request, and a browser load failure
 * switches to it instead of the player silhouette. Player `<Artwork>` still
 * degrades to the silhouette exactly as before.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAdminGalleryApiProvider } from '@/images/providers/adminGalleryApi';
import { createLocalDevAssetsProvider } from '@/images/providers/localDevAssets';
import { createSilhouetteProvider } from '@/images/providers/silhouette';
import { setImageProviderChain } from '@/images/provider';

import { AdminGalleryArtwork } from '../AdminGalleryArtwork';
import { Artwork } from '../Artwork';

beforeEach(() => {
  setImageProviderChain([
    createAdminGalleryApiProvider(),
    createLocalDevAssetsProvider(),
    createSilhouetteProvider(),
  ]);
});

describe('AdminGalleryArtwork', () => {
  it('renders available artwork through the secure admin route', () => {
    render(
      <AdminGalleryArtwork
        slug="alley_catgirl"
        appearanceId="level_20"
        status="available"
        label="Alley Catgirl — Level 20"
        displayWidth={512}
      />,
    );
    const img = screen.getByAltText('Alley Catgirl — Level 20');
    expect(img).toHaveAttribute(
      'src',
      '/api/v1/admin/gallery/species/alley_catgirl/appearances/level_20/artwork?width=512',
    );
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it.each([
    ['missing', 'Artwork Missing'],
    ['unsafe', 'Artwork Unavailable'],
  ] as const)(
    'a known %s file renders the QA placeholder and makes no request',
    (status, title) => {
      const { container } = render(
        <AdminGalleryArtwork
          slug="alley_catgirl"
          appearanceId="level_40"
          status={status}
          label="Alley Catgirl — Level 40"
          displayWidth={256}
        />,
      );
      expect(container.querySelector('img')).toBeNull();
      const placeholder = screen.getByRole('img', {
        name: `${title}: Alley Catgirl — Level 40 (level_40)`,
      });
      expect(placeholder).toHaveTextContent(title);
      expect(placeholder).toHaveTextContent('level_40');
      expect(placeholder).toHaveAttribute('data-testid', `artwork-problem-${status}`);
    },
  );

  it('a browser load failure switches to the QA placeholder, not the silhouette', () => {
    const { container } = render(
      <AdminGalleryArtwork
        slug="alley_catgirl"
        appearanceId="level_10"
        status="available"
        label="Alley Catgirl — Level 10"
        displayWidth={256}
      />,
    );
    fireEvent.error(screen.getByAltText('Alley Catgirl — Level 10'));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('artwork-problem-failed')).toHaveTextContent(
      'Artwork Failed to Load',
    );
    expect(screen.queryByAltText('Undiscovered Waifumon silhouette')).toBeNull();
  });

  it('a different appearance does not inherit a previous failure', () => {
    const { rerender } = render(
      <AdminGalleryArtwork
        slug="alley_catgirl"
        appearanceId="level_10"
        status="available"
        label="A"
        displayWidth={256}
      />,
    );
    fireEvent.error(screen.getByAltText('A'));
    rerender(
      <AdminGalleryArtwork
        slug="alley_catgirl"
        appearanceId="level_20"
        status="available"
        label="B"
        displayWidth={256}
      />,
    );
    expect(screen.getByAltText('B')).toBeInTheDocument();
  });

  it('leaves player <Artwork> degrading to the silhouette, as before', () => {
    render(<Artwork asset={{ kind: 'species', slug: 'neko_barista' }} name="Neko Barista" />);
    const img = screen.getByAltText('Neko Barista');
    fireEvent.error(img);
    expect(screen.getByRole('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.queryByTestId(/artwork-problem/)).toBeNull();
  });
});
