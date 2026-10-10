/**
 * The boss editor's Artwork section: what the boss shows now, choosing from
 * the library (uploaded and shipped), uploading a new image, clearing back to
 * the shipped file, the delete guard — and that without `bosses.write` it can
 * all be seen and none of it changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';

import type { BossArtworkAsset, BossArtworkLibrary } from '@/api/adminBosses';

import { BossEditorPage } from '../BossEditorPage';
import { BossesListPage } from '../BossesListPage';
import {
  ALL,
  READ_ONLY,
  REFERENCE,
  apiError,
  bossFixture,
  inputOfDetail,
  installBossApi,
  renderWithSession,
  type BossApi,
} from './bossFixtures';

const ASSET_A = '11111111-1111-4111-8111-111111111111';
const ASSET_B = '22222222-2222-4222-8222-222222222222';
const ASSET_NEW = '33333333-3333-4333-8333-333333333333';
const MATRON = '/admin/bosses/iron_matron';
const HYDRA = '/admin/bosses/neon_hydra';

const asset = (
  id: string,
  name: string,
  over: Partial<BossArtworkAsset> = {},
): BossArtworkAsset => ({
  id,
  name,
  originalFilename: `${name}.png`,
  mimeType: 'image/webp',
  width: 1200,
  height: 800,
  fileSize: 204_800,
  contentHash: 'a'.repeat(64),
  version: 1,
  status: 'active',
  uploadedBy: '777',
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z',
  ...over,
});

const LIMITS = {
  mimeTypes: ['image/webp', 'image/png', 'image/jpeg'],
  maxBytes: 8 * 1024 * 1024,
  maxDimension: 4096,
  storedMaxEdge: 2048,
};

let boss: BossApi;
let library: BossArtworkLibrary;

beforeEach(() => {
  boss = installBossApi([
    bossFixture({ id: 'iron_matron', name: 'Iron Matron' }),
    bossFixture({ id: 'neon_hydra', name: 'Neon Hydra', artworkAssetId: ASSET_A }),
  ]);
  library = {
    shipped: [
      {
        path: 'bosses/iron_matron.webp',
        exists: true,
        usedBy: [{ id: 'iron_matron', name: 'Iron Matron', status: 'active' }],
      },
      {
        path: 'bosses/neon_hydra.webp',
        exists: true,
        usedBy: [{ id: 'neon_hydra', name: 'Neon Hydra', status: 'active' }],
      },
      { path: 'bosses/spare.webp', exists: true, usedBy: [] },
    ],
    managed: [
      {
        asset: asset(ASSET_A, 'Hydra repaint'),
        usedBy: [{ id: 'neon_hydra', name: 'Neon Hydra', status: 'active' }],
      },
      { asset: asset(ASSET_B, 'Unused sketch'), usedBy: [] },
    ],
    limits: LIMITS,
  };
  boss.reference.mockImplementation(async () => ({ ...REFERENCE, managedArtwork: true }));
  boss.library.mockImplementation(async () => library);
});
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string, permissions = ALL) {
  return renderWithSession(
    <Routes>
      <Route path="/admin/bosses" element={<BossesListPage />} />
      <Route path="/admin/bosses/new" element={<BossEditorPage />} />
      <Route path="/admin/bosses/:id" element={<BossEditorPage />} />
    </Routes>,
    path,
    permissions,
  );
}

async function openLibrary(user: ReturnType<typeof renderAt>) {
  await user.click(await screen.findByRole('button', { name: 'Browse artwork library' }));
  return within(await screen.findByTestId('boss-artwork-library'));
}

const pngFile = (name = 'new boss.png', size = 1024) => {
  const file = new File([new Uint8Array(size)], name, { type: 'image/png' });
  return file;
};

describe('what the boss shows now', () => {
  it('a boss on shipped artwork shows the path and previews the shipped file', async () => {
    renderAt(MATRON);
    const current = within(await screen.findByTestId('boss-artwork-current'));
    expect(current.getByText('Shipped')).toBeInTheDocument();
    expect(current.getByTestId('boss-artwork-identifier')).toHaveTextContent(
      'bosses/iron_matron.webp',
    );
    expect(await screen.findByTestId('boss-artwork-preview-image')).toBeInTheDocument();
    expect(boss.artwork).toHaveBeenCalledWith('bosses/iron_matron.webp');
    expect(boss.assetArtwork).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Clear uploaded artwork' }),
    ).not.toBeInTheDocument();
  });

  it('a boss on uploaded artwork shows its name and id, previews the upload, and keeps the shipped path as fallback', async () => {
    renderAt(HYDRA);
    const current = within(await screen.findByTestId('boss-artwork-current'));
    expect(current.getByText('Uploaded')).toBeInTheDocument();
    await waitFor(() =>
      expect(current.getByTestId('boss-artwork-current-name')).toHaveTextContent('Hydra repaint'),
    );
    expect(current.getByTestId('boss-artwork-identifier')).toHaveTextContent(ASSET_A);
    expect(await screen.findByTestId('boss-artwork-preview-image')).toBeInTheDocument();
    expect(boss.assetArtwork).toHaveBeenCalledWith(ASSET_A);
    expect(screen.getByLabelText('Boss artwork')).toHaveValue('bosses/neon_hydra.webp');
    expect(screen.getByText('Shipped artwork (fallback)')).toBeInTheDocument();
  });

  it('the boss list shows the uploaded picture for a boss that has one', async () => {
    renderAt('/admin/bosses');
    expect(await screen.findByTestId('boss-art-neon_hydra-image')).toBeInTheDocument();
    expect(boss.assetArtwork).toHaveBeenCalledWith(ASSET_A);
    expect(boss.artwork).toHaveBeenCalledWith('bosses/iron_matron.webp');
    expect(boss.artwork).not.toHaveBeenCalledWith('bosses/neon_hydra.webp');
  });

  it('server issues about the upload appear in the section', async () => {
    boss = installBossApi([
      bossFixture({
        id: 'neon_hydra',
        name: 'Neon Hydra',
        artworkAssetId: ASSET_A,
        issues: [
          {
            path: 'artworkAssetId',
            message: 'The uploaded artwork "Hydra repaint" is disabled.',
            severity: 'warning',
          },
        ],
      }),
    ]);
    boss.reference.mockImplementation(async () => ({ ...REFERENCE, managedArtwork: true }));
    boss.library.mockImplementation(async () => library);
    renderAt(HYDRA);
    expect(await screen.findByTestId('boss-artwork-asset-issues')).toHaveTextContent('is disabled');
    expect(screen.queryByTestId('boss-other-issues')).not.toBeInTheDocument();
  });
});

describe('the artwork library', () => {
  it('lists uploads and shipped files with who uses each', async () => {
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    expect(boss.library).toHaveBeenCalled();
    expect(lib.getByTestId(`boss-artwork-usage-${ASSET_A}`)).toHaveTextContent(
      'Used by Neon Hydra',
    );
    expect(lib.getByTestId(`boss-artwork-usage-${ASSET_B}`)).toHaveTextContent(
      'Not used by any boss',
    );
    expect(lib.getByTestId('boss-artwork-shipped-usage-bosses/iron_matron.webp')).toHaveTextContent(
      'Used by Iron Matron',
    );
    expect(lib.getByTestId('boss-artwork-shipped-usage-bosses/spare.webp')).toHaveTextContent(
      'Not used by any boss',
    );
    expect(
      within(lib.getByTestId(`boss-artwork-usage-${ASSET_A}`)).getByRole('link', {
        name: 'Neon Hydra',
      }),
    ).toHaveAttribute('href', HYDRA);
    expect(
      within(lib.getByTestId(`boss-artwork-asset-${ASSET_A}`)).getByText(/1200×800 · 200 KB/),
    ).toBeInTheDocument();
    // Shipped files are never deletable here.
    expect(
      within(lib.getByTestId('boss-artwork-shipped-bosses/spare.webp')).queryByRole('button', {
        name: /Delete/,
      }),
    ).not.toBeInTheDocument();
  });

  it('choosing an upload selects it on the form, and saving assigns it', async () => {
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    await user.click(lib.getByRole('button', { name: 'Use Unused sketch' }));

    expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(ASSET_B);
    expect(screen.getByTestId('boss-artwork-current-name')).toHaveTextContent('Unused sketch');
    expect(lib.getByRole('button', { name: 'Use Unused sketch' })).toBeDisabled();
    await waitFor(() => expect(boss.assetArtwork).toHaveBeenCalledWith(ASSET_B));
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();
    expect(boss.update).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save boss' }));
    await waitFor(() =>
      expect(boss.update).toHaveBeenCalledWith(
        'iron_matron',
        {
          ...inputOfDetail(boss.store().iron_matron!),
          artwork: 'bosses/iron_matron.webp',
          artworkAssetId: ASSET_B,
        },
        3,
      ),
    );
  });

  it('choosing a shipped file from the grid sets the path', async () => {
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    await user.click(lib.getByRole('button', { name: 'Use shipped bosses/spare.webp' }));
    expect(screen.getByLabelText('Boss artwork')).toHaveValue('bosses/spare.webp');
    expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent('bosses/spare.webp');
  });

  it('clearing the upload goes back to the shipped file', async () => {
    const user = renderAt(HYDRA);
    await user.click(await screen.findByRole('button', { name: 'Clear uploaded artwork' }));
    const current = within(screen.getByTestId('boss-artwork-current'));
    expect(current.getByText('Shipped')).toBeInTheDocument();
    expect(current.getByTestId('boss-artwork-identifier')).toHaveTextContent(
      'bosses/neon_hydra.webp',
    );
    await user.click(screen.getByRole('button', { name: 'Save boss' }));
    await waitFor(() =>
      expect(boss.update).toHaveBeenCalledWith(
        'neon_hydra',
        expect.objectContaining({ artwork: 'bosses/neon_hydra.webp', artworkAssetId: null }),
        3,
      ),
    );
  });
});

describe('uploading', () => {
  it('uploads the chosen file, selects the new image and refreshes the library', async () => {
    const created = asset(ASSET_NEW, 'new boss');
    boss.uploadArtwork.mockImplementation(async () => {
      library = { ...library, managed: [{ asset: created, usedBy: [] }, ...library.managed] };
      return created;
    });
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    const calls = boss.library.mock.calls.length;
    const file = pngFile();
    await user.upload(screen.getByLabelText('Upload boss artwork'), file);

    await waitFor(() => expect(boss.uploadArtwork).toHaveBeenCalledTimes(1));
    expect(boss.uploadArtwork.mock.calls[0]![0]).toBe(file);
    await waitFor(() =>
      expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(ASSET_NEW),
    );
    await waitFor(() => expect(boss.library.mock.calls.length).toBeGreaterThan(calls));
    expect(await lib.findByTestId(`boss-artwork-asset-${ASSET_NEW}`)).toBeInTheDocument();
    // Uploading alone assigns nothing: the boss changes when it is saved.
    expect(boss.update).not.toHaveBeenCalled();
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();
  });

  it('a new boss can be created with an image uploaded on the spot', async () => {
    const created = asset(ASSET_NEW, 'new boss');
    boss.uploadArtwork.mockImplementation(async () => created);
    const user = renderAt('/admin/bosses/new');
    await user.type(await screen.findByLabelText('Boss name'), 'Glass Widow');
    await user.upload(screen.getByLabelText('Upload boss artwork'), pngFile());
    await waitFor(() =>
      expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(ASSET_NEW),
    );
    await user.click(screen.getByRole('button', { name: 'Create boss' }));
    await waitFor(() =>
      expect(boss.create).toHaveBeenCalledWith(
        'glass_widow',
        expect.objectContaining({ artwork: null, artworkAssetId: ASSET_NEW }),
      ),
    );
    // The editor it lands on shows the same upload.
    expect(await screen.findByRole('heading', { name: 'Boss — Glass Widow' })).toBeInTheDocument();
    expect(await screen.findByTestId('boss-artwork-preview-image')).toBeInTheDocument();
  });

  it('shows the server’s reason when the file is refused, and selects nothing', async () => {
    boss.uploadArtwork.mockRejectedValue(
      apiError(
        400,
        'ARTWORK_UPLOAD_INVALID',
        'Only PNG, WebP and JPEG images can be uploaded (SVG and GIF are not accepted).',
      ),
    );
    const user = renderAt(MATRON);
    await user.upload(await screen.findByLabelText('Upload boss artwork'), pngFile('sneaky.png'));
    expect(await screen.findByTestId('boss-artwork-upload-error')).toHaveTextContent(
      'Only PNG, WebP and JPEG',
    );
    expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(
      'bosses/iron_matron.webp',
    );
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();
  });

  it('refuses a file over the limit before sending it', async () => {
    library = { ...library, limits: { ...LIMITS, maxBytes: 2048 } };
    const user = renderAt(MATRON);
    await openLibrary(user);
    await user.upload(screen.getByLabelText('Upload boss artwork'), pngFile('big.png', 4096));
    expect(await screen.findByTestId('boss-artwork-upload-error')).toHaveTextContent(
      'too large — the limit is 2 KB',
    );
    expect(boss.uploadArtwork).not.toHaveBeenCalled();
  });
});

describe('deleting an upload', () => {
  it('cannot delete an image a boss uses, and says why', async () => {
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    const inUse = lib.getByRole('button', { name: 'Delete Hydra repaint' });
    expect(inUse).toBeDisabled();
    expect(inUse).toHaveAttribute('title', expect.stringContaining('In use'));
    expect(boss.deleteArtwork).not.toHaveBeenCalled();
  });

  it('deletes an unused image only after a second, explicit click', async () => {
    boss.deleteArtwork.mockImplementation(async (id) => {
      library = { ...library, managed: library.managed.filter((m) => m.asset.id !== id) };
      return { deleted: true as const };
    });
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    await user.click(lib.getByRole('button', { name: 'Delete Unused sketch' }));
    expect(boss.deleteArtwork).not.toHaveBeenCalled();
    await user.click(lib.getByRole('button', { name: 'Cancel' }));
    expect(boss.deleteArtwork).not.toHaveBeenCalled();

    await user.click(lib.getByRole('button', { name: 'Delete Unused sketch' }));
    await user.click(lib.getByRole('button', { name: 'Confirm delete Unused sketch' }));
    await waitFor(() => expect(boss.deleteArtwork).toHaveBeenCalledWith(ASSET_B));
    await waitFor(() =>
      expect(lib.queryByTestId(`boss-artwork-asset-${ASSET_B}`)).not.toBeInTheDocument(),
    );
  });

  it('shows who still uses it when the server refuses the delete', async () => {
    boss.deleteArtwork.mockRejectedValue(
      apiError(409, 'ARTWORK_ASSET_IN_USE', 'That artwork is still in use.', {
        references: [
          { kind: 'boss', key: 'old_guard', name: 'Old Guard', field: 'artworkAssetId' },
          { kind: 'boss', key: 'neon_hydra', name: 'Neon Hydra', field: 'liveEncounter[41]' },
        ],
      }),
    );
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    await user.click(lib.getByRole('button', { name: 'Delete Unused sketch' }));
    await user.click(lib.getByRole('button', { name: 'Confirm delete Unused sketch' }));
    const error = await lib.findByTestId('boss-artwork-delete-error');
    expect(error).toHaveTextContent(
      'Still in use by Old Guard, an encounter of Neon Hydra that is still open.',
    );
    expect(lib.getByTestId(`boss-artwork-asset-${ASSET_B}`)).toBeInTheDocument();
  });

  it('will not delete the image selected on this very form', async () => {
    const user = renderAt(MATRON);
    const lib = await openLibrary(user);
    await user.click(lib.getByRole('button', { name: 'Use Unused sketch' }));
    expect(lib.getByRole('button', { name: 'Delete Unused sketch' })).toBeDisabled();
  });
});

describe('read-only access', () => {
  it('views the current artwork and the library, with nothing to upload, choose or delete', async () => {
    const user = renderAt(HYDRA, READ_ONLY);
    expect(await screen.findByTestId('boss-artwork-preview-image')).toBeInTheDocument();
    expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(ASSET_A);
    expect(screen.getByLabelText('Boss artwork')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Upload new artwork' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Upload boss artwork')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Clear uploaded artwork' }),
    ).not.toBeInTheDocument();

    const lib = await openLibrary(user);
    expect(lib.getByTestId(`boss-artwork-usage-${ASSET_A}`)).toHaveTextContent(
      'Used by Neon Hydra',
    );
    expect(await lib.findByTestId(`boss-artwork-tile-${ASSET_B}-image`)).toBeInTheDocument();
    expect(lib.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument();
    expect(lib.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(boss.uploadArtwork).not.toHaveBeenCalled();
    expect(boss.deleteArtwork).not.toHaveBeenCalled();
  });
});

describe('a server without managed artwork', () => {
  it('offers the shipped picker only, exactly as before', async () => {
    boss.reference.mockImplementation(async () => REFERENCE);
    const user = renderAt(MATRON);
    expect(await screen.findByLabelText('Boss artwork')).toHaveValue('bosses/iron_matron.webp');
    expect(
      screen.queryByRole('button', { name: 'Browse artwork library' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload new artwork' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Boss artwork'), 'bosses/neon_hydra.webp');
    expect(screen.getByTestId('boss-artwork-identifier')).toHaveTextContent(
      'bosses/neon_hydra.webp',
    );
    expect(boss.library).not.toHaveBeenCalled();
  });
});
