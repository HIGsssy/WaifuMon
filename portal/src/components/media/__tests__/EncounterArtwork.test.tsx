/**
 * `<EncounterArtwork>` — the admin editor's preview of an authored path.
 *
 * Three states an author has to be able to tell apart: no artwork authored
 * (normal — encounters render text-only), a path with no file behind it
 * (almost always a typo), and the image itself. The component fetches bytes
 * through the permission-gated admin client rather than constructing a URL
 * from the path, which is what keeps the Portal's "physical paths never reach
 * pages" rule intact while still letting an author see what they typed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { EncounterArtwork } from '../EncounterArtwork';
import * as adminEncounters from '@/api/adminEncounters';

// jsdom implements neither `URL.createObjectURL` nor `URL.revokeObjectURL`.
// The component's create/revoke pairing is part of what these tests check, so
// both are installed as counting stubs and removed afterwards.
const created: string[] = [];
const revoked: string[] = [];

type ObjectUrlStatics = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  const statics = URL as unknown as ObjectUrlStatics;
  statics.createObjectURL = (_blob: Blob) => {
    const url = `blob:mock/${created.length}`;
    created.push(url);
    return url;
  };
  statics.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

// Deliberately left installed rather than deleted: Testing Library's own
// auto-cleanup unmounts components *after* this hook, and the component
// revokes its object URL on unmount. Tearing the stubs down here would make
// every test that rendered an image throw during cleanup.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('EncounterArtwork', () => {
  it('shows an explicit empty state when no artwork is authored', () => {
    const fetchSpy = vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob');
    render(<EncounterArtwork path={null} />);

    expect(screen.getByTestId('encounter-artwork-empty')).toBeTruthy();
    // Nothing to fetch — an unset optional field is not a request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an all-whitespace path as empty rather than fetching it', () => {
    const fetchSpy = vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob');
    render(<EncounterArtwork path="   " />);

    expect(screen.getByTestId('encounter-artwork-empty')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders the image once the API returns bytes', async () => {
    vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob').mockResolvedValue(
      new Blob(['fake-bytes'], { type: 'image/webp' }),
    );
    render(<EncounterArtwork path="encounters/bandit_ambush.webp" />);

    const img = await screen.findByTestId('encounter-artwork-image');
    expect(img.getAttribute('src')).toBe('blob:mock/0');
    expect(img.getAttribute('alt')).toContain('encounters/bandit_ambush.webp');
  });

  it('asks the API for exactly the path it was given', async () => {
    const fetchSpy = vi
      .spyOn(adminEncounters, 'adminEncounterArtworkBlob')
      .mockResolvedValue(new Blob(['x']));
    render(<EncounterArtwork path="encounters/valley_shrine.webp" />);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('encounters/valley_shrine.webp'),
    );
  });

  it('shows a typo-shaped message when the path resolves to nothing', async () => {
    vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob').mockRejectedValue(
      new Error('404'),
    );
    render(<EncounterArtwork path="encounters/typo.webp" />);

    const missing = await screen.findByTestId('encounter-artwork-missing');
    expect(missing.textContent).toContain('encounters/typo.webp');
  });

  it('revokes the object URL when the path changes, so typing does not leak', async () => {
    vi.spyOn(adminEncounters, 'adminEncounterArtworkBlob').mockResolvedValue(new Blob(['x']));
    const { rerender, unmount } = render(<EncounterArtwork path="encounters/a.webp" />);
    await screen.findByTestId('encounter-artwork-image');

    rerender(<EncounterArtwork path="encounters/b.webp" />);
    await waitFor(() => expect(revoked).toContain('blob:mock/0'));

    unmount();
    await waitFor(() => expect(revoked.length).toBe(created.length));
  });
});
