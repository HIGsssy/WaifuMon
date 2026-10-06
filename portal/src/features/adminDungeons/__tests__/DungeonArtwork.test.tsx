/**
 * Managed artwork in dungeon authoring: choosing and uploading zone artwork
 * from inside the zone editor, clearing it back to the shipped path, editing
 * the background pool, and the scene preview with an enemy's sprite. (An
 * enemy's own artwork is edited on its page: see `adminEnemies/__tests__`.)
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import type { ArtworkAsset } from '@/api/adminArtworkAssets';
import * as api from '@/api/adminDungeons';
import type { DungeonZoneDetail, DungeonZoneDoc } from '@/api/adminDungeons';
import type { EnemyRef } from '@/api/adminEnemies';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import {
  assetFixture,
  enemyFixture,
  pngFile,
  stubObjectUrls,
} from '@/features/adminArtwork/__tests__/artworkFixtures';

import { DungeonZoneEditorPage } from '../DungeonZoneEditorPage';
import { DungeonsListPage } from '../DungeonsListPage';
import { newZone } from '../dungeonModel';

const ZONE: DungeonZoneDoc = {
  ...newZone(),
  key: 'scrapheap_gauntlet',
  name: 'Scrapheap Gauntlet',
  enabled: true,
  artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
  backgroundArtworkPath: 'dungeons/backgrounds/scrapheap_gauntlet.webp',
  availableRegions: ['flaccid-foothills'],
  pools: {
    combat: [
      {
        id: 'drone',
        enemyKey: 'scrapyard_drone',
        enabled: true,
        weight: 50,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ],
    elite: [],
    miniboss: [],
    boss: [
      {
        id: 'colossus',
        enemyKey: 'scrapheap_colossus',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ],
    event: [],
  },
};

const detailOf = (
  zone: DungeonZoneDoc,
  over: Partial<DungeonZoneDetail> = {},
): DungeonZoneDetail => ({
  key: zone.key,
  name: zone.name,
  enabled: zone.enabled,
  order: zone.order,
  tags: zone.tags,
  minNodes: zone.generation.minNodes,
  maxNodes: zone.generation.maxNodes,
  poolCount: 2,
  poolEntryCount: 2,
  rewardBandCount: 0,
  availableRegions: zone.availableRegions ?? [],
  revision: 3,
  origin: 'edited',
  matchesShipped: false,
  updatedAt: '2026-10-01T12:00:00.000Z',
  updatedBy: '777',
  regionBackfill: null,
  zone,
  issues: [],
  ...over,
});

let assets: ArtworkAsset[];
let enemies: EnemyRef[];
let stored: DungeonZoneDetail;
let updateSpy: MockInstance<typeof api.updateDungeonZone>;
let uploadSpy: MockInstance<typeof artworkApi.uploadArtworkAsset>;
let sceneSpy: MockInstance<typeof artworkApi.scenePreviewBlob>;
let zoneArt: ArtworkAsset;
let nightBg: ArtworkAsset;
let caveBg: ArtworkAsset;
let droneSprite: ArtworkAsset;

beforeEach(() => {
  stubObjectUrls();
  zoneArt = assetFixture({ name: 'Gauntlet Banner', category: 'dungeon_zone' });
  nightBg = assetFixture({ name: 'Scrap Night', category: 'dungeon_background' });
  caveBg = assetFixture({ name: 'Rust Cave', category: 'dungeon_background' });
  droneSprite = assetFixture({ name: 'Drone Sprite', category: 'enemy_sprite', hasAlpha: true });
  assets = [zoneArt, nightBg, caveBg, droneSprite];
  enemies = [
    enemyFixture({ key: 'scrapyard_drone', name: 'Scrapyard Drone' }),
    enemyFixture({ key: 'scrapheap_colossus', name: 'Scrapheap Colossus' }),
  ];
  stored = detailOf(ZONE);

  // Enemy sprites and placement reach the editor with the reference data.
  vi.spyOn(api, 'getDungeonReference').mockImplementation(async () => ({
    nodeTypes: [...api.DUNGEON_NODE_TYPES],
    enemies,
    events: [],
    rewardTables: [],
    currencies: [
      {
        key: 'ascension_currency',
        singularName: 'Ascension Token',
        pluralName: 'Ascension Tokens',
        enabled: true,
      },
    ],
    regions: [{ id: 'flaccid-foothills', name: 'Flaccid Foothills', enabled: true }],
  }));
  vi.spyOn(api, 'getDungeonZone').mockImplementation(async () => stored);
  vi.spyOn(api, 'listDungeonZones').mockImplementation(async () => ({ zones: [stored] }));
  vi.spyOn(api, 'validateDungeonZone').mockResolvedValue({ issues: [] });
  vi.spyOn(api, 'getDungeonSettings').mockResolvedValue({
    dailyRunLimit: 3,
    dailyRunLimitMin: 0,
    dailyRunLimitMax: 50,
    updatedAt: null,
    updatedBy: null,
  });
  vi.spyOn(api, 'listProgressionCurrencies').mockResolvedValue({ currencies: [] });
  vi.spyOn(api, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
  updateSpy = vi
    .spyOn(api, 'updateDungeonZone')
    .mockImplementation(async (_key, zone, revision) => {
      stored = detailOf(zone, { revision: revision + 1 });
      return stored;
    });

  vi.spyOn(artworkApi, 'listArtworkAssets').mockImplementation(async (query = {}) => {
    const found = assets.filter(
      (a) =>
        (!query.category || a.category === query.category) &&
        (!query.status || a.status === query.status),
    );
    return { assets: found, total: found.length };
  });
  vi.spyOn(artworkApi, 'getArtworkAsset').mockImplementation(async (id) => {
    const asset = assets.find((a) => a.id === id);
    if (!asset) throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'Not found.' });
    return { asset, references: [], events: [] };
  });
  vi.spyOn(artworkApi, 'artworkAssetBlob').mockImplementation(async () => new Blob(['asset']));
  uploadSpy = vi
    .spyOn(artworkApi, 'uploadArtworkAsset')
    .mockImplementation(async (file, options) => {
      const created = assetFixture({
        name: file.name.replace(/\.\w+$/, ''),
        category: options.category,
        originalFilename: file.name,
      });
      assets = [created, ...assets];
      return created;
    });
  sceneSpy = vi
    .spyOn(artworkApi, 'scenePreviewBlob')
    .mockImplementation(async () => new Blob(['scene']));
});
afterEach(() => vi.restoreAllMocks());

const ALL = ['dungeons.read', 'dungeons.write', 'artwork.read', 'artwork.write', 'enemies.read'];
function renderAt(path: string, permissions = ALL) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  render(
    <Routes>
      <Route path="/admin/dungeons" element={<DungeonsListPage />} />
      <Route path="/admin/dungeons/zones/:key" element={<DungeonZoneEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

const EDITOR = '/admin/dungeons/zones/scrapheap_gauntlet';
const savedZone = () => updateSpy.mock.calls.at(-1)![1];
const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() => expect(screen.getByRole('button', { name: /^Save/ })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /^Save/ }));
  await waitFor(() => expect(updateSpy).toHaveBeenCalled());
};
/** Pick an asset in whichever picker dialog is open. */
const pick = async (user: ReturnType<typeof userEvent.setup>, asset: ArtworkAsset) => {
  const dialog = within(await screen.findByRole('dialog'));
  await user.click(await dialog.findByTestId(`asset-card-${asset.id}`));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
};

describe('zone artwork', () => {
  it('with nothing uploaded, says it uses the shipped path', async () => {
    renderAt(EDITOR);
    const field = within(await screen.findByTestId('zone-artwork-asset'));
    expect(field.getByTestId('zone-artwork-asset-fallback')).toHaveTextContent(
      'No uploaded artwork — uses the image shipped with the game.',
    );
    // The shipped path field is still there and still editable, under Internal details.
    expect(screen.getByLabelText('Artwork path')).toHaveValue(
      'dungeons/zones/scrapheap_gauntlet.webp',
    );
  });

  it('selects an existing asset from the picker — by clicking it, never by typing an id', async () => {
    const user = renderAt(EDITOR);
    const field = within(await screen.findByTestId('zone-artwork-asset'));
    await user.click(field.getByRole('button', { name: 'Select zone cover' }));
    // The picker opens on this field's category.
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Filter by category')).toHaveValue('dungeon_zone');
    expect(await dialog.findByText('Gauntlet Banner')).toBeInTheDocument();
    expect(dialog.queryByText('Scrap Night')).not.toBeInTheDocument();
    await pick(user, zoneArt);

    expect(await field.findByTestId('zone-artwork-asset-selected')).toHaveTextContent(
      'Gauntlet Banner · Dungeon zone art · 1200×675 · PNG · 200 KB',
    );
    expect(await field.findByTestId('zone-artwork-asset-preview-image')).toHaveAttribute(
      'alt',
      'Zone cover: Gauntlet Banner',
    );
    await save(user);
    expect(savedZone()).toMatchObject({
      artworkAssetId: zoneArt.id,
      artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
    });
  });

  it('uploads a new image without leaving the editor, and selects it automatically', async () => {
    const user = renderAt(EDITOR);
    const field = within(await screen.findByTestId('zone-background-asset'));
    const file = pngFile('boiler_room.png');
    await user.upload(field.getByTestId('zone-background-asset-file'), file);

    await waitFor(() =>
      expect(uploadSpy).toHaveBeenCalledWith(file, { category: 'dungeon_background' }),
    );
    expect(await field.findByTestId('zone-background-asset-selected')).toHaveTextContent(
      'boiler_room · Dungeon background',
    );
    await save(user);
    expect(savedZone().backgroundAssetId).toBe(
      uploadSpy.mock.results[0]!.value ? assets[0]!.id : null,
    );
    // Still on the editor.
    expect(screen.getByTestId('zone-artwork')).toBeInTheDocument();
  });

  it('shows why an upload was refused, and selects nothing', async () => {
    uploadSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'ARTWORK_UPLOAD_INVALID',
        message: 'The image is 9000×9000 — the longest edge may be at most 4096px.',
      }),
    );
    const user = renderAt(EDITOR);
    const field = within(await screen.findByTestId('zone-artwork-asset'));
    await user.upload(field.getByTestId('zone-artwork-asset-file'), pngFile('huge.png'));
    expect(await field.findByTestId('zone-artwork-asset-upload-error')).toHaveTextContent(
      'longest edge may be at most 4096px',
    );
    expect(field.getByTestId('zone-artwork-asset-fallback')).toBeInTheDocument();
  });

  it('clearing a managed override falls back to the shipped path', async () => {
    stored = detailOf({ ...ZONE, artworkAssetId: zoneArt.id });
    const user = renderAt(EDITOR);
    const field = within(await screen.findByTestId('zone-artwork-asset'));
    expect(await field.findByTestId('zone-artwork-asset-selected')).toHaveTextContent(
      'Gauntlet Banner',
    );
    await user.click(field.getByRole('button', { name: 'Clear zone cover' }));
    expect(field.getByTestId('zone-artwork-asset-fallback')).toHaveTextContent(
      'uses the image shipped with the game',
    );
    await save(user);
    expect(savedZone()).toMatchObject({
      artworkAssetId: null,
      artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
    });
  });

  it('says so when the selected asset is disabled or gone', async () => {
    assets = assets.map((a) => (a.id === zoneArt.id ? { ...a, status: 'disabled' } : a));
    stored = detailOf({
      ...ZONE,
      artworkAssetId: zoneArt.id,
      backgroundAssetId: '99999999-0000-4000-8000-999999999999',
    });
    renderAt(EDITOR);
    expect(
      await within(await screen.findByTestId('zone-artwork-asset')).findByText(
        /disabled, so the image shipped with the game/,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('zone-background-asset-selected')).toHaveTextContent(
        'This artwork no longer exists',
      ),
    );
  });

  it('an author without artwork permissions sees the reference but no pickers', async () => {
    stored = detailOf({ ...ZONE, artworkAssetId: zoneArt.id });
    renderAt(EDITOR, ['dungeons.read', 'dungeons.write']);
    const field = within(await screen.findByTestId('zone-artwork-asset'));
    expect(field.getByTestId('zone-artwork-asset-selected')).toHaveTextContent(
      'Uploaded artwork is selected.',
    );
    expect(field.queryByRole('button', { name: 'Select zone cover' })).not.toBeInTheDocument();
    expect(field.queryByRole('button', { name: 'Upload zone cover' })).not.toBeInTheDocument();
    // They can still clear it back to the shipped path.
    expect(field.getByRole('button', { name: 'Clear zone cover' })).toBeInTheDocument();
  });
});

describe('background pool', () => {
  it('starts empty and explains what that means', async () => {
    renderAt(EDITOR);
    expect(await screen.findByTestId('background-pool-empty')).toHaveTextContent(
      'every node uses the zone background',
    );
  });

  it('adds uploaded backgrounds, edits weight, depth and enabled, removes one, and saves the pool', async () => {
    const user = renderAt(EDITOR);
    const pool = within(await screen.findByTestId('zone-backgrounds'));
    await user.click(pool.getByRole('button', { name: 'Add uploaded background…' }));
    await pick(user, nightBg);
    await user.click(pool.getByRole('button', { name: 'Add uploaded background…' }));
    await pick(user, caveBg);

    expect(await pool.findByTestId('background-scrap_night')).toBeInTheDocument();
    expect(pool.getByTestId('background-rust_cave')).toBeInTheDocument();
    expect(
      await pool.findByTestId('background-scrap_night-asset-preview-image'),
    ).toBeInTheDocument();

    const setNumber = async (label: string, value: string) => {
      const field = pool.getByLabelText(label);
      await user.clear(field);
      if (value) await user.type(field, value);
    };
    await setNumber('Background 1 weight', '40');
    await setNumber('Background 1 to depth', '4');
    await setNumber('Background 2 weight', '20');
    await setNumber('Background 2 from depth', '5');
    await user.click(pool.getByLabelText('Background 2 enabled'));

    await save(user);
    expect(savedZone().backgrounds).toEqual([
      {
        id: 'scrap_night',
        enabled: true,
        weight: 40,
        minDepth: 1,
        maxDepth: 4,
        assetId: nightBg.id,
        artworkPath: null,
      },
      {
        id: 'rust_cave',
        enabled: false,
        weight: 20,
        minDepth: 5,
        maxDepth: null,
        assetId: caveBg.id,
        artworkPath: null,
      },
    ]);

    await user.click(pool.getByRole('button', { name: 'Remove background 1' }));
    await waitFor(() =>
      expect(pool.queryByTestId('background-scrap_night')).not.toBeInTheDocument(),
    );
    await save(user);
    expect(savedZone().backgrounds!.map((b) => b.id)).toEqual(['rust_cave']);
  });

  it('gives two backgrounds from the same image distinct ids', async () => {
    const user = renderAt(EDITOR);
    const pool = within(await screen.findByTestId('zone-backgrounds'));
    for (let i = 0; i < 2; i++) {
      await user.click(pool.getByRole('button', { name: 'Add uploaded background…' }));
      await pick(user, nightBg);
    }
    await save(user);
    expect(savedZone().backgrounds!.map((b) => b.id)).toEqual(['scrap_night', 'scrap_night_2']);
  });

  it('shows a shipped background by its path, and server issues on the entry they belong to', async () => {
    stored = detailOf({
      ...ZONE,
      backgrounds: [
        {
          id: 'git',
          enabled: true,
          weight: 10,
          minDepth: 1,
          maxDepth: null,
          assetId: null,
          artworkPath: 'dungeons/backgrounds/scrap.webp',
        },
        {
          id: 'gone',
          enabled: true,
          weight: 10,
          minDepth: 1,
          maxDepth: null,
          assetId: '99999999-0000-4000-8000-999999999999',
          artworkPath: null,
        },
      ],
    });
    vi.mocked(api.validateDungeonZone).mockResolvedValue({
      issues: [
        {
          path: 'backgrounds[1].assetId',
          message: 'that artwork no longer exists — choose another or clear it',
          severity: 'error',
        },
      ],
    });
    renderAt(EDITOR);
    const git = within(await screen.findByTestId('background-git'));
    expect(git.getByText('dungeons/backgrounds/scrap.webp')).toBeInTheDocument();
    expect(await git.findByTestId('background-git-preview-image')).toBeInTheDocument();
    expect(
      await within(screen.getByTestId('background-gone')).findByText(
        /that artwork no longer exists/,
      ),
    ).toBeInTheDocument();
    expect(git.queryByText(/no longer exists/)).not.toBeInTheDocument();
  });
});

describe('scene rules and preview', () => {
  it('states the precedence for fights and for other rooms', async () => {
    renderAt(EDITOR);
    const rules = within(await screen.findByTestId('zone-scene-rules'));
    expect(
      rules.getByText('The node’s background with the enemy’s sprite over it'),
    ).toBeInTheDocument();
    expect(rules.getByText('The event’s own artwork')).toBeInTheDocument();
    expect(rules.getByRole('link', { name: 'Enemies' })).toHaveAttribute('href', '/admin/enemies');
  });

  it('previews the zone background alone, then with an enemy’s sprite at that enemy’s placement', async () => {
    const placement = {
      anchor: 'bottom-center' as const,
      scaleBasisPoints: 7000,
      offsetX: -20,
      offsetY: 0,
    };
    enemies = [
      enemyFixture({
        key: 'scrapyard_drone',
        name: 'Scrapyard Drone',
        visual: {
          artworkAssetId: null,
          artworkPath: null,
          spriteAssetId: droneSprite.id,
          spriteArtworkPath: null,
          spritePlacement: placement,
        },
      }),
      enemyFixture({ key: 'scrapheap_colossus', name: 'Scrapheap Colossus' }),
      // Has a sprite, but is not in this zone's pools.
      enemyFixture({
        key: 'elsewhere',
        name: 'Elsewhere',
        visual: {
          artworkAssetId: null,
          artworkPath: null,
          spriteAssetId: droneSprite.id,
          spriteArtworkPath: null,
          spritePlacement: placement,
        },
      }),
    ];
    stored = detailOf({
      ...ZONE,
      backgroundAssetId: nightBg.id,
      backgrounds: [
        {
          id: 'cave',
          enabled: true,
          weight: 10,
          minDepth: 1,
          maxDepth: null,
          assetId: caveBg.id,
          artworkPath: null,
        },
      ],
    });
    const user = renderAt(EDITOR);
    const preview = within(await screen.findByTestId('zone-scene-preview'));

    // The first pool background, no sprite.
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenCalledWith({
        background: { assetId: caveBg.id, artworkPath: null },
      }),
    );
    expect(await preview.findByTestId('zone-scene-image')).toBeInTheDocument();

    // Only this zone's enemies that have a sprite are offered.
    const options = within(preview.getByLabelText('Preview enemy sprite'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['None — background only', 'Scrapyard Drone']);

    await user.selectOptions(preview.getByLabelText('Preview enemy sprite'), 'scrapyard_drone');
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith({
        background: { assetId: caveBg.id, artworkPath: null },
        sprite: { assetId: droneSprite.id, artworkPath: null },
        placement,
        playerBuddy: {},
      }),
    );

    await user.selectOptions(preview.getByLabelText('Preview background'), 'Zone background');
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          background: {
            assetId: nightBg.id,
            artworkPath: 'dungeons/backgrounds/scrapheap_gauntlet.webp',
          },
        }),
      ),
    );
  });

  it('says when no enemy in the zone has a sprite', async () => {
    renderAt(EDITOR);
    expect(await screen.findByTestId('zone-scene-no-sprites')).toHaveTextContent(
      'fights show the enemy’s full artwork',
    );
  });
});

describe('region compatibility notice', () => {
  it('asks for a review on a zone opened everywhere by the backfill — in the list and the editor', async () => {
    stored = detailOf(ZONE, { regionBackfill: 'all_enabled_regions' });
    renderAt('/admin/dungeons');
    expect(await screen.findByText('Review regions')).toBeInTheDocument();
  });

  it('shows the notice in the editor, and not on an ordinary zone', async () => {
    stored = detailOf(ZONE, { regionBackfill: 'all_enabled_regions' });
    renderAt(EDITOR);
    expect(await screen.findByTestId('region-backfill-notice')).toHaveTextContent(
      'made before regions existed',
    );
  });

  it('is absent on a zone whose regions were authored', async () => {
    renderAt(EDITOR);
    await screen.findByTestId('zone-availability');
    expect(screen.queryByTestId('region-backfill-notice')).not.toBeInTheDocument();
  });
});
