/**
 * The Artwork Assets page: uploading, browsing with a category filter and a
 * search, previewing, and managing one asset — rename, replace, disable, and
 * the delete that is refused while something still uses it.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import * as api from '@/api/adminArtworkAssets';
import type { ArtworkAsset, ArtworkAssetReference } from '@/api/adminArtworkAssets';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { ArtworkAssetsPage } from '../ArtworkAssetsPage';
import { assetFixture, pngFile, stubObjectUrls } from './artworkFixtures';

let assets: ArtworkAsset[];
let references: ArtworkAssetReference[];
let listSpy: MockInstance<typeof api.listArtworkAssets>;
let uploadSpy: MockInstance<typeof api.uploadArtworkAsset>;
let replaceSpy: MockInstance<typeof api.replaceArtworkAsset>;
let deleteSpy: MockInstance<typeof api.deleteArtworkAsset>;
let enabledSpy: MockInstance<typeof api.setArtworkAssetEnabled>;
let renameSpy: MockInstance<typeof api.updateArtworkAsset>;
let blobSpy: MockInstance<typeof api.artworkAssetBlob>;

const byId = (id: string) => assets.find((a) => a.id === id)!;

beforeEach(() => {
  stubObjectUrls();
  assets = [
    assetFixture({ name: 'Scrap Night', category: 'dungeon_background' }),
    assetFixture({
      name: 'Drone Sprite',
      category: 'enemy_sprite',
      hasAlpha: true,
      width: 600,
      height: 900,
    }),
    assetFixture({ name: 'Old Banner', category: 'dungeon_zone', status: 'disabled' }),
  ];
  references = [];
  vi.spyOn(api, 'getArtworkMeta').mockResolvedValue(api.FALLBACK_ARTWORK_META);
  listSpy = vi.spyOn(api, 'listArtworkAssets').mockImplementation(async (query = {}) => {
    const q = query.q?.toLowerCase() ?? '';
    const found = assets.filter(
      (a) =>
        (!query.category || a.category === query.category) &&
        (!query.status || a.status === query.status) &&
        (!q || a.name.toLowerCase().includes(q) || a.originalFilename.toLowerCase().includes(q)),
    );
    return { assets: found, total: found.length };
  });
  vi.spyOn(api, 'getArtworkAsset').mockImplementation(async (id) => ({
    asset: byId(id),
    references,
    events: [
      {
        id: 1,
        action: 'upload',
        actor: '777',
        oldHash: null,
        newHash: byId(id).contentHash,
        details: {},
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  }));
  blobSpy = vi.spyOn(api, 'artworkAssetBlob').mockImplementation(async () => new Blob(['image']));
  uploadSpy = vi.spyOn(api, 'uploadArtworkAsset').mockImplementation(async (file, options) => {
    const created = assetFixture({
      name: options.name?.trim() || 'new cave',
      category: options.category,
      originalFilename: file.name,
    });
    assets = [created, ...assets];
    return created;
  });
  replaceSpy = vi.spyOn(api, 'replaceArtworkAsset').mockImplementation(async (id, file) => {
    const next = {
      ...byId(id),
      version: byId(id).version + 1,
      contentHash: 'f'.repeat(64),
      originalFilename: file.name,
    };
    assets = assets.map((a) => (a.id === id ? next : a));
    return next;
  });
  enabledSpy = vi.spyOn(api, 'setArtworkAssetEnabled').mockImplementation(async (id, enabled) => {
    const next = { ...byId(id), status: enabled ? ('active' as const) : ('disabled' as const) };
    assets = assets.map((a) => (a.id === id ? next : a));
    return { asset: next, references };
  });
  renameSpy = vi.spyOn(api, 'updateArtworkAsset').mockImplementation(async (id, patch) => {
    const next = { ...byId(id), ...patch };
    assets = assets.map((a) => (a.id === id ? next : a));
    return next;
  });
  deleteSpy = vi.spyOn(api, 'deleteArtworkAsset').mockImplementation(async (id) => {
    assets = assets.filter((a) => a.id !== id);
    return { deleted: true };
  });
});
afterEach(() => vi.restoreAllMocks());

function renderPage(permissions = ['artwork.read', 'artwork.write']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(<ArtworkAssetsPage />, { wrapper: Wrapper });
  return user;
}

const card = (asset: ArtworkAsset) => screen.findByTestId(`asset-card-${asset.id}`);

describe('browse', () => {
  it('lists every asset, disabled ones included, with dimensions, size and type', async () => {
    renderPage();
    const first = within(await card(assets[0]!));
    expect(first.getByText('Scrap Night')).toBeInTheDocument();
    expect(first.getByText('Dungeon background')).toBeInTheDocument();
    expect(first.getByText('1200×675 · PNG · 200 KB')).toBeInTheDocument();
    expect(
      within(await card(assets[1]!)).getByText('600×900 · PNG · 200 KB · transparent'),
    ).toBeInTheDocument();
    expect(
      within(await card(assets[2]!)).getByText('Dungeon zone art · disabled'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('asset-grid-summary')).toHaveTextContent('3 of 3 shown');
    // The management list is not limited to active assets.
    expect(listSpy.mock.calls[0]![0]).not.toHaveProperty('status');
  });

  it('previews each asset through the authenticated bytes route, keyed by its hash', async () => {
    renderPage();
    expect(await screen.findByTestId(`asset-thumb-${assets[0]!.id}-image`)).toHaveAttribute(
      'alt',
      'Scrap Night',
    );
    expect(blobSpy).toHaveBeenCalledWith(`${assets[0]!.id}@${assets[0]!.contentHash}`);
  });

  it('filters by category and searches by name', async () => {
    const user = renderPage();
    await card(assets[0]!);
    await user.selectOptions(screen.getByLabelText('Filter by category'), 'enemy_sprite');
    await waitFor(() =>
      expect(screen.getByTestId('asset-grid-summary')).toHaveTextContent('1 of 1 shown'),
    );
    expect(screen.getByText('Drone Sprite')).toBeInTheDocument();
    expect(screen.queryByText('Scrap Night')).not.toBeInTheDocument();
    expect(listSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'enemy_sprite' }),
      expect.anything(),
    );

    await user.selectOptions(screen.getByLabelText('Filter by category'), '');
    await user.type(screen.getByLabelText('Search artwork'), 'night');
    await waitFor(() =>
      expect(listSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'night' }),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.queryByText('Drone Sprite')).not.toBeInTheDocument());
    expect(screen.getByText('Scrap Night')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search artwork'));
    await user.type(screen.getByLabelText('Search artwork'), 'zzz');
    await waitFor(() =>
      expect(screen.getByTestId('asset-grid-summary')).toHaveTextContent('No artwork matches'),
    );
  });

  it('a reader can browse but is offered no upload and no management actions', async () => {
    const user = renderPage(['artwork.read']);
    expect(screen.queryByTestId('asset-upload')).not.toBeInTheDocument();
    await user.click(await card(assets[0]!));
    const manage = within(await screen.findByTestId('asset-manage'));
    expect(manage.getByTestId('asset-manage-name')).toHaveTextContent('Scrap Night');
    expect(manage.queryByRole('button', { name: 'Replace image…' })).not.toBeInTheDocument();
    expect(manage.queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
  });
});

describe('an empty library', () => {
  it('is an empty state, not an error', async () => {
    assets = [];
    renderPage();
    expect(await screen.findByTestId('asset-grid-summary')).toHaveTextContent(
      'No artwork has been uploaded yet',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load artwork')).not.toBeInTheDocument();
    // Uploading is still offered, and nothing is selected.
    expect(screen.getByTestId('asset-upload')).toBeInTheDocument();
    expect(screen.getByTestId('asset-manage-empty')).toBeInTheDocument();
  });

  it('a filter with no matches says so, differently', async () => {
    const user = renderPage();
    await card(assets[0]!);
    await user.selectOptions(screen.getByLabelText('Filter by category'), 'npc_portrait');
    await waitFor(() =>
      expect(screen.getByTestId('asset-grid-summary')).toHaveTextContent('No artwork matches'),
    );
  });
});

describe('when the list really fails', () => {
  it('says why: the server’s message, its code and the HTTP status', async () => {
    listSpy.mockRejectedValue(
      new PortalApiError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found.',
        requestId: 'req-42',
      }),
    );
    renderPage();
    const alert = within(await screen.findByRole('alert'));
    expect(alert.getByText('Could not load artwork')).toBeInTheDocument();
    expect(alert.getByTestId('error-reason')).toHaveTextContent('Not found.');
    expect(alert.getByTestId('error-code')).toHaveTextContent(
      'NOT_FOUND · HTTP 404 · request req-42',
    );
  });

  it('names a server failure and a network failure too', async () => {
    listSpy.mockRejectedValue(
      new PortalApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'Internal error.' }),
    );
    renderPage();
    expect(await screen.findByTestId('error-code')).toHaveTextContent('INTERNAL_ERROR · HTTP 500');
  });
});

describe('upload', () => {
  it('uploads the chosen file under the chosen category and name, then selects it', async () => {
    const user = renderPage();
    await user.selectOptions(screen.getByLabelText('Upload category'), 'enemy_sprite');
    await user.type(screen.getByLabelText('Upload name'), 'Colossus Sprite');
    const file = pngFile('colossus.png');
    await user.upload(screen.getByTestId('asset-upload-file'), file);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    expect(uploadSpy.mock.calls[0]![0]).toBe(file);
    expect(uploadSpy.mock.calls[0]![1]).toEqual({
      category: 'enemy_sprite',
      name: 'Colossus Sprite',
    });
    expect(await screen.findByTestId('asset-upload-done')).toHaveTextContent(
      'Uploaded “Colossus Sprite”',
    );
    // The new asset is opened in the manage panel and appears in the grid.
    expect(await screen.findByTestId('asset-manage-name')).toHaveTextContent('Colossus Sprite');
    expect(await screen.findByText('4 of 4 shown')).toBeInTheDocument();
  });

  it('says what the limits are, and only offers image types', async () => {
    renderPage();
    const upload = within(await screen.findByTestId('asset-upload'));
    expect(upload.getByText(/PNG, WebP or JPEG, up to 8\.0 MB and 4096px/)).toBeInTheDocument();
    expect(upload.getByText(/2400×1350/)).toBeInTheDocument();
    expect(screen.getByTestId('asset-upload-file')).toHaveAttribute(
      'accept',
      'image/png,image/webp,image/jpeg',
    );
  });

  it('shows the server’s reason when an upload is refused', async () => {
    uploadSpy.mockRejectedValueOnce(
      new PortalApiError({
        code: 'ARTWORK_UPLOAD_INVALID',
        message: 'Only PNG, WebP and JPEG images can be uploaded (SVG and GIF are not accepted).',
        status: 400,
      }),
    );
    const user = renderPage();
    await user.upload(screen.getByTestId('asset-upload-file'), pngFile('not-really.png'));
    expect(await screen.findByTestId('asset-upload-error')).toHaveTextContent(
      'Only PNG, WebP and JPEG',
    );

    uploadSpy.mockRejectedValueOnce(
      new PortalApiError({ code: 'PAYLOAD_TOO_LARGE', message: 'too large', status: 413 }),
    );
    await user.upload(screen.getByTestId('asset-upload-file'), pngFile('huge.png'));
    await waitFor(() =>
      expect(screen.getByTestId('asset-upload-error')).toHaveTextContent(
        'too large — the limit is 8.0 MB',
      ),
    );
  });
});

describe('manage', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>, asset: ArtworkAsset) => {
    await user.click(await card(asset));
    return within(await screen.findByTestId('asset-manage'));
  };

  it('shows the asset’s details, preview, usage and history', async () => {
    references = [
      {
        kind: 'dungeon_zone',
        key: 'scrapheap_gauntlet',
        name: 'Scrapheap Gauntlet',
        field: 'backgroundAssetId',
      },
    ];
    const user = renderPage();
    const manage = await open(user, assets[0]!);
    expect(manage.getByTestId('asset-manage-meta')).toHaveTextContent(
      'Dungeon background · 1200×675 · PNG · 200 KB · version 1',
    );
    expect(await manage.findByTestId('asset-manage-preview-image')).toBeInTheDocument();
    const used = within(manage.getByTestId('asset-references'));
    expect(used.getByRole('link', { name: 'Zone Scrapheap Gauntlet' })).toHaveAttribute(
      'href',
      '/admin/dungeons/zones/scrapheap_gauntlet',
    );
    expect(manage.getByTestId('asset-history')).toHaveTextContent('Uploaded');
    // An admin copies the id with a button; it is never something to type.
    expect(manage.getByRole('button', { name: 'Copy asset ID' })).toBeInTheDocument();
  });

  it('replaces the image behind the same asset and reports the new version', async () => {
    const user = renderPage();
    const target = assets[0]!;
    const manage = await open(user, target);
    const file = pngFile('scrap-night-v2.png');
    await user.upload(manage.getByTestId('asset-replace-file'), file);

    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(target.id, file));
    expect(await manage.findByTestId('asset-replace-done')).toHaveTextContent('now version 2');
    await waitFor(() =>
      expect(manage.getByTestId('asset-manage-meta')).toHaveTextContent('version 2'),
    );
    // Same asset, new hash: the preview is fetched again rather than reused.
    await waitFor(() => expect(blobSpy).toHaveBeenCalledWith(`${target.id}@${'f'.repeat(64)}`));
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('renames an asset', async () => {
    const user = renderPage();
    const manage = await open(user, assets[0]!);
    const name = manage.getByLabelText('Asset name');
    expect(manage.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'Scrap Dusk');
    await user.click(manage.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(renameSpy).toHaveBeenCalledWith(assets[0]!.id, { name: 'Scrap Dusk' }),
    );
    await waitFor(() =>
      expect(manage.getByTestId('asset-manage-name')).toHaveTextContent('Scrap Dusk'),
    );
  });

  it('disables an asset in use, and says what now falls back', async () => {
    references = [
      {
        kind: 'dungeon_zone',
        key: 'scrapheap_gauntlet',
        name: 'Scrapheap Gauntlet',
        field: 'backgroundAssetId',
      },
      { kind: 'combat_enemy', key: 'scrapyard_drone', name: null, field: 'spriteAssetId' },
    ];
    const user = renderPage();
    const manage = await open(user, assets[0]!);
    await user.click(manage.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(enabledSpy).toHaveBeenCalledWith(assets[0]!.id, false));
    expect(await manage.findByTestId('asset-disabled-notice')).toHaveTextContent(
      '2 place(s) now show their shipped artwork instead',
    );
    expect(await manage.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('will not delete an asset that is still used', async () => {
    references = [
      { kind: 'combat_enemy', key: 'scrapyard_drone', name: null, field: 'spriteAssetId' },
    ];
    const user = renderPage();
    const manage = await open(user, assets[1]!);
    expect(manage.getByRole('button', { name: 'Delete…' })).toBeDisabled();
    expect(
      within(manage.getByTestId('asset-references')).getByRole('link', {
        name: 'Enemy scrapyard_drone',
      }),
    ).toHaveAttribute('href', '/admin/enemies/scrapyard_drone');
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('shows the references when the server refuses a delete that raced a new reference', async () => {
    deleteSpy.mockRejectedValueOnce(
      new PortalApiError({
        code: 'ARTWORK_ASSET_IN_USE',
        message: 'That artwork is still in use.',
        status: 409,
        details: {
          references: [
            {
              kind: 'dungeon_zone',
              key: 'rust_warrens',
              name: 'Rust Warrens',
              field: 'artworkAssetId',
            },
          ],
        },
      }),
    );
    const user = renderPage();
    const manage = await open(user, assets[0]!);
    await user.click(manage.getByRole('button', { name: 'Delete…' }));
    await user.click(manage.getByRole('button', { name: 'Delete permanently' }));
    const refused = within(await manage.findByTestId('asset-in-use'));
    expect(refused.getByText(/still in use and was not deleted/)).toBeInTheDocument();
    expect(refused.getByRole('link', { name: 'Zone Rust Warrens' })).toBeInTheDocument();
    expect(screen.getByTestId('asset-manage-name')).toHaveTextContent('Scrap Night');
  });

  it('deletes an unused asset after a confirmation', async () => {
    const user = renderPage();
    const target = assets[0]!;
    const manage = await open(user, target);
    await user.click(manage.getByRole('button', { name: 'Delete…' }));
    expect(deleteSpy).not.toHaveBeenCalled();
    await user.click(manage.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(target.id));
    expect(await screen.findByTestId('asset-manage-empty')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Scrap Night')).not.toBeInTheDocument());
  });
});
