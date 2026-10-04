/**
 * Simplified dungeon authoring: the three-question creation wizard, the
 * room-by-room editor (outline, add / branch / duplicate / delete, a room
 * editor that shows only what its type uses, artwork picked and uploaded
 * inside the room), the procedural editor's Basic / Advanced split, the mode
 * badge on the list, and a preview that adapts to the layout.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import type { ArtworkAsset, EnemyArtworkEntry } from '@/api/adminArtworkAssets';
import * as api from '@/api/adminDungeons';
import type {
  DungeonPreview,
  DungeonRoomDoc,
  DungeonZoneDetail,
  DungeonZoneDoc,
  DungeonZoneIssue,
} from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import {
  assetFixture,
  enemyFixture,
  pngFile,
  stubObjectUrls,
} from '@/features/adminArtwork/__tests__/artworkFixtures';

import { DungeonCreatePage } from '../DungeonCreatePage';
import { DungeonPreviewPage } from '../DungeonPreviewPage';
import { DungeonZoneEditorPage } from '../DungeonZoneEditorPage';
import { DungeonsListPage } from '../DungeonsListPage';
import { newRoom, newZone } from '../dungeonModel';

const room = (
  id: string,
  type: DungeonRoomDoc['type'],
  next: string[],
  over: Partial<DungeonRoomDoc> = {},
): DungeonRoomDoc => ({
  ...newRoom(
    id,
    type,
    type === 'boss' ? 'scrapheap_colossus' : 'scrapyard_drone',
    'abandoned_cache',
  ),
  next,
  ...over,
});

/** Tunnel Mouth → Repair Bay → (Security Post | Salvage Cache) → Antechamber → Far Gate. */
const AUTHORED: DungeonZoneDoc = {
  ...newZone(),
  key: 'blacksite_lab',
  name: 'Blacksite Lab',
  availableRegions: ['base-80085'],
  layoutMode: 'authored',
  backgroundArtworkPath: 'dungeons/backgrounds/blacksite.webp',
  authored: {
    startRoomId: 'tunnel_mouth',
    rooms: [
      room('tunnel_mouth', 'combat', ['repair_bay'], { name: 'Tunnel Mouth' }),
      room('repair_bay', 'rest', ['security_post', 'salvage_cache'], {
        name: 'Repair Bay',
        extraction: true,
      }),
      room('security_post', 'elite', ['antechamber'], { name: 'Security Post' }),
      room('salvage_cache', 'reward', ['antechamber'], {
        name: 'Salvage Cache',
        reward: {
          rewardTable: null,
          equipmentRewardTable: 'cache-v1',
          currency: { min: 3, max: 5 },
        },
      }),
      room('antechamber', 'rest', ['far_gate'], { name: 'Antechamber', healBasisPoints: 2000 }),
      room('far_gate', 'boss', [], { name: 'Far Gate' }),
    ],
  },
};

const PROCEDURAL: DungeonZoneDoc = {
  ...newZone(),
  key: 'scrapheap_gauntlet',
  name: 'Scrapheap Gauntlet',
  enabled: true,
  availableRegions: ['flaccid-foothills'],
  pools: {
    combat: [
      {
        id: 'drone',
        enemyKey: 'scrapyard_drone',
        enabled: true,
        weight: 50,
        minDepth: 1,
        maxDepth: 4,
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
): DungeonZoneDetail => {
  const authored = zone.layoutMode === 'authored';
  const rooms = zone.authored?.rooms.length ?? 0;
  return {
    key: zone.key,
    name: zone.name,
    enabled: zone.enabled,
    order: zone.order,
    tags: zone.tags,
    layoutMode: zone.layoutMode ?? 'procedural',
    minNodes: authored ? rooms - 1 : zone.generation.minNodes,
    maxNodes: authored ? rooms - 1 : zone.generation.maxNodes,
    roomCount: authored ? rooms : null,
    artworkAssetId: zone.artworkAssetId ?? null,
    artworkPath: zone.artworkPath,
    poolCount: 2,
    poolEntryCount: 2,
    rewardBandCount: zone.rewards.bands.length,
    availableRegions: zone.availableRegions ?? [],
    revision: 3,
    origin: 'custom',
    matchesShipped: null,
    updatedAt: '2026-10-01T12:00:00.000Z',
    updatedBy: '777',
    regionBackfill: null,
    zone,
    issues: [],
    ...over,
  };
};

const authoredPreview: DungeonPreview = {
  zoneKey: 'blacksite_lab',
  layoutMode: 'authored',
  seed: 42,
  names: {
    enemies: { scrapyard_drone: 'Scrapyard Drone', scrapheap_colossus: 'Scrapheap Colossus' },
    events: {},
  },
  structure: {
    availableRegions: [{ id: 'base-80085', name: 'Base 80085' }],
    artworkPath: null,
    backgroundArtworkPath: null,
    restNodes: [{ id: 'n2', depth: 2, extraction: true }],
    extractionNodes: [{ id: 'n2', depth: 2, type: 'rest' }],
    bossNodeId: 'n3',
    restBeforeBoss: { required: false, satisfied: true },
  },
  graph: {
    format: 'waifumon-dungeon-graph',
    generatorVersion: 1,
    zoneKey: 'blacksite_lab',
    seed: 42,
    depthCount: 3,
    startNodeId: 'n1',
    terminalNodeId: 'n3',
    attempts: 1,
    nodes: [
      {
        id: 'n1',
        depth: 1,
        lane: 0,
        type: 'combat',
        outgoing: ['e1'],
        content: { kind: 'enemy', key: 'scrapyard_drone' },
        source: null,
        rewardBandId: 'fights',
        extraction: false,
        terminal: false,
        boss: false,
        roomId: 'tunnel_mouth',
        name: 'Tunnel Mouth',
      },
      {
        id: 'n2',
        depth: 2,
        lane: 0,
        type: 'rest',
        outgoing: ['e2'],
        content: null,
        source: null,
        rewardBandId: null,
        extraction: true,
        terminal: false,
        boss: false,
        roomId: 'repair_bay',
        name: 'Repair Bay',
        restHealBasisPoints: 2000,
      },
      {
        id: 'n3',
        depth: 3,
        lane: 0,
        type: 'boss',
        outgoing: [],
        content: { kind: 'enemy', key: 'scrapheap_colossus' },
        source: null,
        rewardBandId: null,
        extraction: false,
        terminal: true,
        boss: true,
        roomId: 'far_gate',
        name: 'Far Gate',
        reward: { rewardTable: null, equipmentRewardTable: null, currency: { min: 10, max: 15 } },
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ],
  },
};

let zones: Record<string, DungeonZoneDetail>;
let issues: DungeonZoneIssue[];
let assets: ArtworkAsset[];
let enemies: EnemyArtworkEntry[];
let droneSprite: ArtworkAsset;
let labBackground: ArtworkAsset;
let createSpy: MockInstance<typeof api.createDungeonZone>;
let updateSpy: MockInstance<typeof api.updateDungeonZone>;
let previewSpy: MockInstance<typeof api.previewDungeon>;
let simulateSpy: MockInstance<typeof api.simulateDungeon>;
let uploadSpy: MockInstance<typeof artworkApi.uploadArtworkAsset>;
let sceneSpy: MockInstance<typeof artworkApi.scenePreviewBlob>;

beforeEach(() => {
  stubObjectUrls();
  issues = [];
  zones = {
    blacksite_lab: detailOf(AUTHORED),
    scrapheap_gauntlet: detailOf(PROCEDURAL, { origin: 'shipped' }),
  };
  droneSprite = assetFixture({ name: 'Drone Sprite', category: 'enemy_sprite', hasAlpha: true });
  labBackground = assetFixture({ name: 'Lab Corridor', category: 'dungeon_background' });
  assets = [droneSprite, labBackground];
  enemies = [
    enemyFixture({
      key: 'scrapyard_drone',
      name: 'Scrapyard Drone',
      visual: {
        artworkAssetId: null,
        artworkPath: 'combat/enemies/scrapyard_drone.webp',
        spriteAssetId: droneSprite.id,
        spriteArtworkPath: null,
        spritePlacement: { anchor: 'bottom-left', scaleBasisPoints: 7000, offsetX: 10, offsetY: 0 },
      },
    }),
    enemyFixture({ key: 'scrapheap_colossus', name: 'Scrapheap Colossus' }),
  ];

  vi.spyOn(api, 'getDungeonReference').mockResolvedValue({
    nodeTypes: [...api.DUNGEON_NODE_TYPES],
    enemies: [
      { key: 'scrapyard_drone', name: 'Scrapyard Drone', enabled: true, tags: [] },
      { key: 'alley_bruiser', name: 'Alley Bruiser', enabled: true, tags: [] },
      { key: 'scrapheap_colossus', name: 'Scrapheap Colossus', enabled: true, tags: ['boss'] },
    ],
    events: [{ key: 'abandoned_cache', name: 'Abandoned Cache', enabled: true, tags: [] }],
    rewardTables: [{ id: 'cache-v1', enabled: true }],
    currencies: [
      { key: 'ascension_currency', singularName: 'Token', pluralName: 'Tokens', enabled: true },
    ],
    regions: [
      { id: 'flaccid-foothills', name: 'Flaccid Foothills', enabled: true },
      { id: 'base-80085', name: 'Base 80085', enabled: true },
    ],
  });
  vi.spyOn(api, 'listDungeonZones').mockImplementation(async () => ({
    zones: Object.values(zones),
  }));
  vi.spyOn(api, 'getDungeonZone').mockImplementation(async (key) => {
    const found = zones[key];
    if (!found) throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'Not found.' });
    return found;
  });
  vi.spyOn(api, 'validateDungeonZone').mockImplementation(async () => ({ issues }));
  vi.spyOn(api, 'getDungeonSettings').mockResolvedValue({
    dailyRunLimit: 3,
    dailyRunLimitMin: 0,
    dailyRunLimitMax: 50,
    updatedAt: null,
    updatedBy: null,
  });
  vi.spyOn(api, 'listProgressionCurrencies').mockResolvedValue({ currencies: [] });
  vi.spyOn(api, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
  createSpy = vi.spyOn(api, 'createDungeonZone').mockImplementation(async (zone) => {
    zones[zone.key] = detailOf(zone, { revision: 1 });
    return zones[zone.key]!;
  });
  updateSpy = vi.spyOn(api, 'updateDungeonZone').mockImplementation(async (key, zone, revision) => {
    zones[key] = detailOf(zone, { revision: revision + 1 });
    return zones[key]!;
  });
  previewSpy = vi.spyOn(api, 'previewDungeon').mockImplementation(async () => authoredPreview);
  simulateSpy = vi.spyOn(api, 'simulateDungeon');

  vi.spyOn(artworkApi, 'listArtworkAssets').mockImplementation(async (query = {}) => {
    const found = assets.filter((a) => !query.category || a.category === query.category);
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
      });
      assets = [created, ...assets];
      return created;
    });
  sceneSpy = vi
    .spyOn(artworkApi, 'scenePreviewBlob')
    .mockImplementation(async () => new Blob(['scene']));
  vi.spyOn(artworkApi, 'listEnemyArtwork').mockImplementation(async () => ({ enemies }));
});
afterEach(() => vi.restoreAllMocks());

const ALL = ['dungeons.read', 'dungeons.write', 'artwork.read', 'artwork.write'];
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
      <Route path="/admin/dungeons/new" element={<DungeonCreatePage />} />
      <Route path="/admin/dungeons/preview" element={<DungeonPreviewPage />} />
      <Route path="/admin/dungeons/zones/:key" element={<DungeonZoneEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

const LAB = '/admin/dungeons/zones/blacksite_lab';
const GAUNTLET = '/admin/dungeons/zones/scrapheap_gauntlet';
type User = ReturnType<typeof userEvent.setup>;
const savedZone = () => updateSpy.mock.calls.at(-1)![1];
const save = async (user: User) => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save dungeon' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save dungeon' }));
  await waitFor(() => expect(updateSpy).toHaveBeenCalled());
};
const cards = () => screen.getAllByTestId('room-card');
const titles = () => cards().map((card) => within(card).getByTestId('room-title').textContent);
const card = (title: string) => {
  const found = cards().find((c) => within(c).getByTestId('room-title').textContent === title);
  if (!found) throw new Error(`no room card titled ${title} among ${titles().join(', ')}`);
  return within(found);
};
const roomsOf = (zone: DungeonZoneDoc) => zone.authored!.rooms;
const nextOf = (zone: DungeonZoneDoc, id: string) => roomsOf(zone).find((r) => r.id === id)!.next;
/** Open a room's editor and return queries scoped to it. */
const edit = async (user: User, title: string) => {
  await user.click(card(title).getByRole('button', { name: `Edit ${title}` }));
  return within(await screen.findByTestId('room-editor'));
};

/* ───────────────────────── creation wizard ───────────────────────── */

describe('create dungeon', () => {
  it('asks three things — name, where, and layout — and nothing about pools, rules, rewards or art', async () => {
    renderAt('/admin/dungeons/new');
    const wizard = within(await screen.findByTestId('dungeon-wizard'));
    expect(wizard.getByLabelText('Dungeon name')).toBeInTheDocument();
    expect(wizard.getByLabelText('Available in')).toBeInTheDocument();
    expect(wizard.getByLabelText('Procedural')).toBeInTheDocument();
    expect(wizard.getByLabelText('Build room-by-room')).toBeInTheDocument();
    // That is the whole form: one name, one region, two layouts (and the key, folded away).
    expect(wizard.getAllByRole('combobox')).toHaveLength(1);
    expect(wizard.getAllByRole('radio')).toHaveLength(2);
    expect(wizard.getAllByRole('textbox').map((box) => box.getAttribute('aria-label'))).toEqual([
      'Dungeon name',
      'Dungeon key',
    ]);
    expect(wizard.getByLabelText('Dungeon key')).not.toBeVisible();
    expect(wizard.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(wizard.queryByRole('button', { name: /Upload|Select|Add/ })).not.toBeInTheDocument();
    // Nothing is created until all three are answered.
    expect(wizard.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('needs a layout to be chosen: neither is preselected', async () => {
    const user = renderAt('/admin/dungeons/new');
    await user.type(await screen.findByLabelText('Dungeon name'), 'Rust Warrens');
    expect(screen.getByLabelText('Procedural')).not.toBeChecked();
    expect(screen.getByLabelText('Build room-by-room')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    await user.click(screen.getByLabelText('Procedural'));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('creates a room-by-room dungeon from the Start → Combat → Rest → Boss template and opens its editor', async () => {
    const user = renderAt('/admin/dungeons/new');
    await user.type(await screen.findByLabelText('Dungeon name'), 'Rust Warrens');
    await user.selectOptions(screen.getByLabelText('Available in'), 'base-80085');
    await user.click(screen.getByLabelText('Build room-by-room'));
    // The key is made from the name; nobody has to think about it.
    expect(screen.getByTestId('wizard-key')).toHaveTextContent('rust_warrens');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const created = createSpy.mock.calls[0]![0];
    expect(created).toMatchObject({
      key: 'rust_warrens',
      name: 'Rust Warrens',
      enabled: false,
      layoutMode: 'authored',
      availableRegions: ['base-80085'],
    });
    expect(roomsOf(created).map((r) => [r.name, r.type, r.next])).toEqual([
      ['Start', 'combat', ['combat']],
      ['Combat', 'combat', ['rest']],
      ['Rest', 'rest', ['boss']],
      ['Boss', 'boss', []],
    ]);
    expect(created.authored!.startRoomId).toBe('start');
    expect(roomsOf(created)[3]!.enemyKey).toBe('scrapheap_colossus');

    // Only after creation does the editor open — on the rooms.
    expect(await screen.findByTestId('zone-rooms')).toBeInTheDocument();
    expect(titles()).toEqual(['Start', 'Combat', 'Rest', 'Boss']);
    expect(screen.queryByTestId('zone-shape')).not.toBeInTheDocument();
  });

  it('creates a procedural dungeon from a one-pool, one-boss template and opens the generator settings', async () => {
    const user = renderAt('/admin/dungeons/new');
    await user.type(await screen.findByLabelText('Dungeon name'), 'Rust Warrens');
    await user.click(screen.getByLabelText('Procedural'));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const created = createSpy.mock.calls[0]![0];
    expect(created).toMatchObject({
      layoutMode: 'procedural',
      enabled: false,
      availableRegions: ['flaccid-foothills'],
    });
    expect(created.pools.combat.map((e) => e.enemyKey)).toEqual(['scrapyard_drone']);
    expect(created.pools.boss.map((e) => e.enemyKey)).toEqual(['scrapheap_colossus']);
    expect(created.generation).toMatchObject({
      boss: { required: true },
      rest: { minNodes: 1, beforeBoss: true },
      extraction: { minPoints: 1 },
    });
    expect(created.authored).toEqual({ startRoomId: null, rooms: [] });

    expect(await screen.findByTestId('zone-shape')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-rooms')).not.toBeInTheDocument();
  });

  it('picks a free key when the name is taken, and shows what the server refused', async () => {
    createSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'DUNGEON_ZONE_INVALID',
        message: 'Invalid dungeon zone',
        details: { issues: [{ path: 'name', message: 'Name: too long', severity: 'error' }] },
      }),
    );
    const user = renderAt('/admin/dungeons/new');
    await user.type(await screen.findByLabelText('Dungeon name'), 'Blacksite Lab');
    await waitFor(() =>
      expect(screen.getByTestId('wizard-key')).toHaveTextContent('blacksite_lab_2'),
    );
    await user.click(screen.getByLabelText('Procedural'));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Name: too long')).toBeInTheDocument();
    // Still on the wizard; nothing was opened.
    expect(screen.getByTestId('dungeon-wizard')).toBeInTheDocument();
  });
});

/* ───────────────────────── dungeon list ───────────────────────── */

describe('dungeon list', () => {
  it('shows each dungeon’s layout, region and size at a glance', async () => {
    renderAt('/admin/dungeons');
    const rows = await screen.findAllByTestId('dungeon-zone-row');
    const lab = within(rows.find((r) => within(r).queryByText('Blacksite Lab'))!);
    const gauntlet = within(rows.find((r) => within(r).queryByText('Scrapheap Gauntlet'))!);
    expect(lab.getByTestId('zone-mode-badge')).toHaveTextContent('Authored');
    await waitFor(() =>
      expect(lab.getByTestId('zone-glance')).toHaveTextContent('Authored · Base 80085 · 6 rooms'),
    );
    expect(lab.getByText('Disabled')).toBeInTheDocument();
    expect(lab.getByText('Portal only')).toBeInTheDocument();
    expect(gauntlet.getByTestId('zone-mode-badge')).toHaveTextContent('Procedural');
    expect(gauntlet.getByTestId('zone-glance')).toHaveTextContent(
      'Procedural · Flaccid Foothills · 6–9 rooms',
    );
    expect(gauntlet.getByText('Shipped')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create dungeon' })).toHaveAttribute(
      'href',
      '/admin/dungeons/new',
    );
    expect(screen.getByRole('link', { name: 'Preview dungeon' })).toBeInTheDocument();
  });

  it('shows the zone cover as a thumbnail when there is one', async () => {
    zones.scrapheap_gauntlet = detailOf({
      ...PROCEDURAL,
      artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
    });
    renderAt('/admin/dungeons');
    expect(await screen.findByTestId('zone-thumb-scrapheap_gauntlet-image')).toBeInTheDocument();
    expect(screen.getByTestId('zone-thumb-blacksite_lab-empty')).toBeInTheDocument();
  });
});

/* ───────────────────────── room-by-room editor ───────────────────────── */

describe('room list', () => {
  it('draws the layout as an outline: the trunk, the branches under their fork, and where they rejoin', async () => {
    renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    expect(titles()).toEqual([
      'Tunnel Mouth',
      'Repair Bay',
      'Security Post',
      'Salvage Cache',
      'Antechamber',
      'Far Gate',
    ]);
    expect(card('Tunnel Mouth').getByText('Start')).toBeInTheDocument();
    expect(card('Far Gate').getByText('Final room')).toBeInTheDocument();
    expect(card('Repair Bay').getByText('Extraction')).toBeInTheDocument();
    expect(card('Security Post').getByText('Branch A')).toBeInTheDocument();
    expect(card('Salvage Cache').getByText('Branch B')).toBeInTheDocument();
    // Both branches point on to the room they rejoin at, which is drawn once.
    expect(screen.getAllByTestId('room-rejoin').map((r) => r.textContent)).toEqual([
      '↳ continues to Antechamber',
      '↳ continues to Antechamber',
    ]);
    expect(screen.queryByText('Not connected')).not.toBeInTheDocument();
  });

  it('says what each room holds, and shows its background', async () => {
    renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const summary = (title: string) => card(title).getByTestId('room-summary').textContent;
    expect(summary('Tunnel Mouth')).toBe('Scrapyard Drone');
    expect(summary('Repair Bay')).toBe('Heals 30%'); // the dungeon default
    expect(summary('Antechamber')).toBe('Heals 20%'); // its own
    expect(summary('Salvage Cache')).toBe('3–5 currency · cache-v1');
    expect(summary('Far Gate')).toBe('Scrapheap Colossus');
    // No room has its own background, so each shows the dungeon default.
    expect(await screen.findByTestId('room-thumb-tunnel_mouth-image')).toBeInTheDocument();
  });

  it('is the room editor, not the generator settings — and both share the basics', async () => {
    renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    expect(screen.getByLabelText('Zone name')).toHaveValue('Blacksite Lab');
    expect(screen.getByTestId('zone-layout-mode')).toHaveTextContent('Room by room');
    expect(screen.getByLabelText('Available in Base 80085')).toBeChecked();
    expect(screen.getByTestId('zone-artwork-asset')).toBeInTheDocument();
    expect(screen.getByTestId('zone-background-asset')).toBeInTheDocument();
    for (const absent of [
      'zone-shape',
      'zone-anchors',
      'pool-combat',
      'zone-extraction',
      'zone-advanced',
    ]) {
      expect(screen.queryByTestId(absent)).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Basics',
      'Artwork',
      'Rooms',
      'Rest',
      'Rewards & defaults',
    ]);
  });

  it('is read-only without write permission', async () => {
    renderAt(LAB, ['dungeons.read']);
    await screen.findByTestId('zone-rooms');
    expect(screen.queryByRole('button', { name: '+ Add room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(card('Tunnel Mouth').getByRole('button', { name: 'Edit Tunnel Mouth' }));
    expect(within(screen.getByTestId('room-editor')).getByLabelText('Enemy')).toBeDisabled();
  });
});

describe('adding, duplicating and deleting rooms', () => {
  it('adds a next room: it slots in after the room and takes over where that room led', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(
      card('Tunnel Mouth').getByRole('button', { name: 'Add next room after Tunnel Mouth' }),
    );

    // The new room opens for editing straight away.
    const editor = within(await screen.findByTestId('room-editor'));
    await user.type(editor.getByLabelText('Room name'), 'Pump Room');
    expect(titles().slice(0, 3)).toEqual(['Tunnel Mouth', 'Pump Room', 'Repair Bay']);

    await save(user);
    const saved = savedZone();
    const added = roomsOf(saved).find((r) => r.name === 'Pump Room')!;
    expect(added).toMatchObject({
      type: 'combat',
      enemyKey: 'scrapyard_drone',
      next: ['repair_bay'],
    });
    expect(nextOf(saved, 'tunnel_mouth')).toEqual([added.id]);
    // Nothing was written until Save.
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('adds a room with the + Add room button just before the final Boss', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(screen.getByRole('button', { name: '+ Add room' }));
    await screen.findByTestId('room-editor');
    expect(titles().at(-1)).toBe('Far Gate');
    await save(user);
    const saved = savedZone();
    const added = roomsOf(saved).find(
      (r) => r.next.includes('far_gate') && r.id !== 'antechamber',
    )!;
    expect(nextOf(saved, 'antechamber')).toEqual([added.id]);
    expect(nextOf(saved, 'far_gate')).toEqual([]);
  });

  it('adds a branch: a second way on that rejoins where the first one does', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(
      card('Tunnel Mouth').getByRole('button', { name: 'Add branch from Tunnel Mouth' }),
    );
    const editor = within(await screen.findByTestId('room-editor'));
    await user.selectOptions(editor.getByLabelText('Room type'), 'event');
    await user.type(editor.getByLabelText('Room name'), 'Side Door');

    expect(card('Repair Bay').getByText('Branch A')).toBeInTheDocument();
    expect(card('Side Door').getByText('Branch B')).toBeInTheDocument();
    await save(user);
    const saved = savedZone();
    const branch = roomsOf(saved).find((r) => r.name === 'Side Door')!;
    expect(nextOf(saved, 'tunnel_mouth')).toEqual(['repair_bay', branch.id]);
    // Repair Bay leads to the two alternatives; so does the new branch.
    expect(branch).toMatchObject({ type: 'event', eventKey: 'abandoned_cache', enemyKey: null });
    expect(branch.next).toEqual(['security_post', 'salvage_cache']);
  });

  it('will not offer a fourth way on from one room', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const add = () =>
      card('Repair Bay').getByRole('button', { name: 'Add branch from Repair Bay' });
    expect(add()).toBeEnabled();
    await user.click(add());
    expect(add()).toBeDisabled();
  });

  it('duplicates a room right after the original, keeping what it holds', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(card('Antechamber').getByRole('button', { name: 'Duplicate Antechamber' }));
    expect(titles()).toContain('Antechamber copy');
    await save(user);
    const saved = savedZone();
    const copy = roomsOf(saved).find((r) => r.name === 'Antechamber copy')!;
    expect(copy).toMatchObject({ type: 'rest', healBasisPoints: 2000, next: ['far_gate'] });
    expect(copy.id).not.toBe('antechamber');
    expect(nextOf(saved, 'antechamber')).toEqual([copy.id]);
  });

  it('deletes a room and closes the gap, so nothing is left pointing at it', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(card('Antechamber').getByRole('button', { name: 'Delete Antechamber' }));
    expect(titles()).not.toContain('Antechamber');
    await save(user);
    const saved = savedZone();
    expect(roomsOf(saved).map((r) => r.id)).not.toContain('antechamber');
    expect(nextOf(saved, 'security_post')).toEqual(['far_gate']);
    expect(nextOf(saved, 'salvage_cache')).toEqual(['far_gate']);
  });

  it('makes the next room the start when the start room is deleted', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(card('Tunnel Mouth').getByRole('button', { name: 'Delete Tunnel Mouth' }));
    expect(card('Repair Bay').getByText('Start')).toBeInTheDocument();
    await save(user);
    expect(savedZone().authored!.startRoomId).toBe('repair_bay');
  });
});

describe('editing a room', () => {
  it('shows a fight its enemy, scene, reward and extraction — and no rest or event controls', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    expect(editor.getByLabelText('Enemy')).toHaveValue('scrapyard_drone');
    expect(editor.getByTestId('room-scene')).toBeInTheDocument();
    expect(editor.getByTestId('room-reward')).toBeInTheDocument();
    expect(editor.getByLabelText('Extraction available')).not.toBeChecked();
    expect(editor.queryByLabelText('Event')).not.toBeInTheDocument();
    expect(editor.queryByTestId('room-heal')).not.toBeInTheDocument();
    expect(editor.queryByLabelText('Heal (% of max HP)')).not.toBeInTheDocument();

    await user.selectOptions(editor.getByLabelText('Enemy'), 'alley_bruiser');
    await user.click(editor.getByLabelText('Extraction available'));
    await save(user);
    expect(roomsOf(savedZone())[0]).toMatchObject({ enemyKey: 'alley_bruiser', extraction: true });
  });

  it('shows a rest its heal, background and extraction — and no enemy', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Repair Bay');
    expect(editor.queryByLabelText('Enemy')).not.toBeInTheDocument();
    expect(editor.queryByTestId('room-reward')).not.toBeInTheDocument();
    expect(editor.queryByText(/Enemy artwork/)).not.toBeInTheDocument();
    expect(editor.getByTestId('room-background')).toBeInTheDocument();
    expect(editor.getByLabelText('Extraction available')).toBeChecked();
    // It heals the dungeon default until the author asks for its own.
    expect(editor.getByTestId('room-heal')).toHaveTextContent(
      'Heals 30% of max HP — the dungeon default.',
    );
    await user.click(editor.getByRole('button', { name: 'Set a heal for this room' }));
    const heal = editor.getByLabelText('Heal (% of max HP)');
    await user.clear(heal);
    await user.type(heal, '45');
    await save(user);
    expect(roomsOf(savedZone())[1]!.healBasisPoints).toBe(4500);
  });

  it('shows a reward room its reward table and currency range', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Salvage Cache');
    expect(editor.getByLabelText('Equipment reward table')).toHaveValue('cache-v1');
    expect(editor.getByLabelText('Currency min')).toHaveValue(3);
    expect(editor.queryByLabelText('Enemy')).not.toBeInTheDocument();
    await user.selectOptions(editor.getByLabelText('Reward table'), 'cache-v1');
    await save(user);
    expect(roomsOf(savedZone())[3]!.reward).toEqual({
      rewardTable: 'cache-v1',
      equipmentRewardTable: 'cache-v1',
      currency: { min: 3, max: 5 },
    });
  });

  it('lets a fight use the dungeon’s default reward, or set its own', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Security Post');
    expect(editor.getByTestId('room-reward')).toHaveTextContent(
      'Uses the dungeon default for Elite rooms.',
    );
    await user.click(editor.getByRole('button', { name: 'Set a reward for this room' }));
    const max = editor.getByLabelText('Currency max');
    await user.clear(max);
    await user.type(max, '6');
    await save(user);
    expect(roomsOf(savedZone())[2]!.reward).toEqual({
      rewardTable: null,
      equipmentRewardTable: null,
      currency: { min: 0, max: 6 },
    });
  });

  it('shows the final Boss no extraction toggle and no way on', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Far Gate');
    expect(editor.getByLabelText('Enemy')).toHaveValue('scrapheap_colossus');
    expect(editor.queryByLabelText('Extraction available')).not.toBeInTheDocument();
    expect(editor.getByText('A Boss is the final room: it leads nowhere.')).toBeInTheDocument();
    expect(card('Far Gate').queryByRole('button', { name: /Add branch/ })).not.toBeInTheDocument();
  });

  it('changing a room’s type swaps the controls and drops what the new type cannot hold', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Antechamber');
    await user.selectOptions(editor.getByLabelText('Room type'), 'event');
    expect(editor.getByLabelText('Event')).toHaveValue('abandoned_cache');
    expect(editor.queryByTestId('room-heal')).not.toBeInTheDocument();
    await user.selectOptions(editor.getByLabelText('Room type'), 'exit');
    expect(editor.getByTestId('room-exit-note')).toHaveTextContent('A way out');
    await save(user);
    expect(roomsOf(savedZone())[4]).toMatchObject({
      type: 'exit',
      eventKey: null,
      healBasisPoints: null,
    });
  });

  it('relinks rooms by hand without offering a link that would loop', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Security Post');
    // Rooms that lead here are not candidates; rooms ahead are.
    expect(editor.queryByLabelText('Security Post leads to Tunnel Mouth')).not.toBeInTheDocument();
    expect(editor.queryByLabelText('Security Post leads to Repair Bay')).not.toBeInTheDocument();
    expect(editor.getByLabelText('Security Post leads to Antechamber')).toBeChecked();
    await user.click(editor.getByLabelText('Security Post leads to Antechamber'));
    await user.click(editor.getByLabelText('Security Post leads to Far Gate'));
    await save(user);
    expect(nextOf(savedZone(), 'security_post')).toEqual(['far_gate']);
  });

  it('shows a problem on the room it is about, in words, and refuses to save', async () => {
    issues = [
      {
        path: 'authored.rooms[4].next',
        message: 'Room "Antechamber" points to a room that no longer exists.',
        severity: 'error',
      },
      {
        path: 'authored.rooms',
        message: 'This dungeon has no rooms yet — add a room to start building it.',
        severity: 'warning',
      },
    ];
    renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    expect(
      await card('Antechamber').findByText(
        'Room "Antechamber" points to a room that no longer exists.',
      ),
    ).toBeInTheDocument();
    expect(card('Tunnel Mouth').queryByText(/no longer exists/)).not.toBeInTheDocument();
    // Never a document path.
    expect(screen.queryByText(/authored\.rooms/)).not.toBeInTheDocument();
    // Shown once, on the room — not repeated in the save summary.
    expect(
      within(screen.getByTestId('zone-save')).queryByText(/no longer exists/),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('validation-status')).toHaveTextContent(
        '1 problem to fix before saving.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Save dungeon' })).toBeDisabled();
  });
});

/* ───────────────────────── artwork inside the room ───────────────────────── */

describe('room artwork', () => {
  it('starts every room on the defaults, with nothing to configure', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    expect(editor.getByTestId('room-background-fallback')).toHaveTextContent(
      'No uploaded artwork — uses the dungeon’s default background.',
    );
    expect(editor.getByTestId('room-scene-defaults')).toHaveTextContent(
      'Enemy artwork: Use enemy default',
    );
    expect(editor.getByTestId('room-scene-defaults')).toHaveTextContent(
      'Placement: Use enemy default',
    );
    expect(editor.queryByTestId('room-sprite')).not.toBeInTheDocument();
    expect(editor.queryByTestId('placement-controls')).not.toBeInTheDocument();
    expect(editor.getByRole('button', { name: 'Override scene' })).toBeInTheDocument();
  });

  it('uploads a background from inside the room, selects it automatically and shows it', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    const file = pngFile('flooded_tunnel.png');
    await user.upload(editor.getByTestId('room-background-file'), file);

    await waitFor(() =>
      expect(uploadSpy).toHaveBeenCalledWith(file, { category: 'dungeon_background' }),
    );
    // Selected without another click, with its preview.
    expect(await editor.findByTestId('room-background-selected')).toHaveTextContent(
      'flooded_tunnel · Dungeon background',
    );
    expect(await editor.findByTestId('room-background-preview-image')).toBeInTheDocument();
    // Still in the room editor: the author never left for the asset library.
    expect(screen.getByTestId('room-editor')).toBeInTheDocument();

    await save(user);
    expect(roomsOf(savedZone())[0]!.backgroundAssetId).toBe(assets[0]!.id);
    // Only that room changed.
    expect(roomsOf(savedZone())[1]!.backgroundAssetId).toBeNull();
  });

  it('selects an existing background from the picker, and clearing it restores the dungeon default', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    await user.click(editor.getByRole('button', { name: 'Select room background' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Filter by category')).toHaveValue('dungeon_background');
    await user.click(await dialog.findByTestId(`asset-card-${labBackground.id}`));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await editor.findByTestId('room-background-selected')).toHaveTextContent('Lab Corridor');

    await user.click(editor.getByRole('button', { name: 'Clear room background' }));
    expect(editor.getByTestId('room-background-fallback')).toHaveTextContent(
      'the dungeon’s default background',
    );
    // Back to exactly what was loaded: nothing to save.
    await waitFor(() =>
      expect(screen.getByTestId('validation-status')).toHaveTextContent('No unsaved changes.'),
    );
  });

  it('only exposes the scene override when asked, and removes it again on request', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    await user.click(editor.getByRole('button', { name: 'Override scene' }));
    const override = within(editor.getByTestId('room-scene-override'));
    expect(override.getByTestId('room-sprite-fallback')).toHaveTextContent(
      'the enemy’s own sprite',
    );
    expect(override.getByTestId('room-full-art-fallback')).toHaveTextContent(
      'the enemy’s own full art',
    );

    await user.click(override.getByLabelText('Custom sprite placement'));
    // Starts from where the enemy already stands.
    expect(override.getByLabelText('Sprite position')).toHaveValue('bottom-left');
    await user.selectOptions(override.getByLabelText('Sprite position'), 'center');
    await save(user);
    expect(roomsOf(savedZone())[0]!.scene).toEqual({
      spriteAssetId: null,
      artworkAssetId: null,
      spritePlacement: { anchor: 'center', scaleBasisPoints: 7000, offsetX: 10, offsetY: 0 },
    });

    await user.click(editor.getByRole('button', { name: 'Use enemy defaults' }));
    expect(editor.getByTestId('room-scene-defaults')).toBeInTheDocument();
    await save(user);
    expect(roomsOf(savedZone())[0]!.scene).toBeNull();
  });

  it('previews the scene through the production compositor, from the draft, without saving', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Tunnel Mouth');
    await user.click(editor.getByRole('button', { name: 'Preview Scene' }));
    // The dungeon's default background with the enemy's own sprite and placement.
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith({
        background: { assetId: null, artworkPath: 'dungeons/backgrounds/blacksite.webp' },
        sprite: { assetId: droneSprite.id, artworkPath: null },
        placement: { anchor: 'bottom-left', scaleBasisPoints: 7000, offsetX: 10, offsetY: 0 },
      }),
    );
    expect(await editor.findByTestId('room-scene-preview-image')).toBeInTheDocument();

    // Give the room its own background: the preview follows the unsaved draft.
    await user.click(editor.getByRole('button', { name: 'Select room background' }));
    await user.click(
      await within(await screen.findByRole('dialog')).findByTestId(
        `asset-card-${labBackground.id}`,
      ),
    );
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ background: { assetId: labBackground.id, artworkPath: null } }),
      ),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('previews a room that is not a fight as its background alone', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const editor = await edit(user, 'Repair Bay');
    await user.click(editor.getByRole('button', { name: 'Preview Scene' }));
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith({
        background: { assetId: null, artworkPath: 'dungeons/backgrounds/blacksite.webp' },
      }),
    );
  });
});

/* ───────────────────────── saving ───────────────────────── */

describe('saving', () => {
  it('keeps room edits in the draft until Save dungeon, and warns before leaving with unsaved changes', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument();

    await user.click(card('Antechamber').getByRole('button', { name: 'Delete Antechamber' }));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await screen.findByTestId('unsaved-badge')).toHaveTextContent('Unsaved changes');
    expect(leave()).toBe(true);

    await save(user);
    expect(updateSpy).toHaveBeenCalledWith('blacksite_lab', expect.anything(), 3);
    await waitFor(() => expect(screen.queryByTestId('unsaved-badge')).not.toBeInTheDocument());
    expect(leave()).toBe(false);
  });

  it('discards a draft back to what was loaded', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(card('Antechamber').getByRole('button', { name: 'Delete Antechamber' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(titles()).toContain('Antechamber');
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── layout mode ───────────────────────── */

describe('changing the layout mode', () => {
  it('is out of the way, asks first, and is only sent as a confirmed change', async () => {
    const user = renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    const internal = screen.getByTestId('zone-internal');
    expect(internal).not.toHaveAttribute('open');
    await user.click(
      within(internal).getByRole('button', { name: 'Change layout to room by room…' }),
    );

    const confirm = within(screen.getByTestId('layout-change-confirm'));
    expect(
      confirm.getByText(/The generator settings and pools are kept, unused/),
    ).toBeInTheDocument();
    // Backing out changes nothing.
    await user.click(confirm.getByRole('button', { name: 'Keep procedural' }));
    expect(screen.getByTestId('zone-shape')).toBeInTheDocument();
    expect(screen.getByTestId('validation-status')).toHaveTextContent('No unsaved changes.');

    await user.click(
      within(internal).getByRole('button', { name: 'Change layout to room by room…' }),
    );
    await user.click(screen.getByRole('button', { name: 'Change layout' }));
    // The room editor opens on the starter rooms; nothing is saved yet.
    expect(await screen.findByTestId('zone-rooms')).toBeInTheDocument();
    expect(titles()).toEqual(['Start', 'Combat', 'Rest', 'Boss']);
    expect(updateSpy).not.toHaveBeenCalled();

    await save(user);
    expect(updateSpy).toHaveBeenCalledWith('scrapheap_gauntlet', expect.anything(), 3, {
      confirmLayoutChange: true,
    });
    const saved = savedZone();
    expect(saved.layoutMode).toBe('authored');
    // The generator's configuration was not destroyed.
    expect(saved.generation).toEqual(PROCEDURAL.generation);
    expect(saved.pools).toEqual(PROCEDURAL.pools);
  });

  it('keeps the rooms when an authored dungeon goes procedural', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(screen.getByRole('button', { name: 'Change layout to procedural…' }));
    await user.click(screen.getByRole('button', { name: 'Change layout' }));
    expect(await screen.findByTestId('zone-shape')).toBeInTheDocument();
    await save(user);
    expect(savedZone().layoutMode).toBe('procedural');
    expect(roomsOf(savedZone())).toHaveLength(6);
  });

  it('does not offer the change to a reader', async () => {
    renderAt(GAUNTLET, ['dungeons.read']);
    await screen.findByTestId('zone-shape');
    expect(screen.queryByRole('button', { name: /Change layout/ })).not.toBeInTheDocument();
  });
});

/* ───────────────────────── procedural: basic and advanced ───────────────────────── */

describe('procedural editor', () => {
  it('opens on the basics, with the generator tuning folded away', async () => {
    renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    // Basic: run length, branch frequency, fixed rooms, pools, rest heal, extraction, rewards, backgrounds.
    for (const label of [
      'Min nodes',
      'Max nodes',
      'Branch chance (%)',
      'First room',
      'Final boss required',
      'Always Rest before final Boss',
      'Combat pool 1 enemy',
      'Boss pool 1 enemy',
      'Rest heals (% of max HP)',
      'Extraction from depth',
      'Kept on defeat (%)',
    ]) {
      expect(screen.getByLabelText(label), label).toBeVisible();
    }
    expect(screen.getByTestId('zone-backgrounds')).toBeVisible();

    // Advanced: raw weights, depth bounds, counts, guarantees, limits, windows.
    for (const fold of [
      'zone-advanced',
      'zone-shape-advanced',
      'zone-rest-advanced',
      'zone-extraction-advanced',
    ]) {
      expect(screen.getByTestId(fold)).not.toHaveAttribute('open');
    }
    for (const label of [
      'Combat weight',
      'Elite min depth',
      'Rest never twice in a row',
      'Min branches',
      'Max branch length',
      'Minimum Rest nodes',
      'Latest Rest depth',
      'Extraction offered at: Rest',
      'Same enemy in a row, at most',
      'Combat pool 1 weight',
      'Combat pool 1 min depth',
    ]) {
      expect(screen.getByLabelText(label), label).not.toBeVisible();
    }
    expect(
      within(screen.getByTestId('zone-advanced')).getByText('Room types & weights'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('zone-advanced')).getByText('Guarantees & limits'),
    ).toBeInTheDocument();
  });

  it('still edits everything under Advanced once it is opened', async () => {
    const user = renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    await user.click(
      within(screen.getByTestId('zone-advanced')).getByText('Advanced generator rules'),
    );
    const weight = screen.getByLabelText('Combat weight');
    expect(weight).toBeVisible();
    await user.clear(weight);
    await user.type(weight, '75');
    await save(user);
    expect(savedZone().generation.nodeWeights.combat).toBe(75);
  });

  it('opens Advanced by itself when the problem is in there', async () => {
    issues = [
      {
        path: 'generation.limits[0].max',
        message: 'at most 0 elite contradicts "at least 1 elite"',
        severity: 'error',
      },
    ];
    renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    await waitFor(() => expect(screen.getByTestId('zone-advanced')).toHaveAttribute('open'));
  });

  it('pins the first room, says what every run looks like, and unpins it without leaving a trace', async () => {
    const user = renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent(
      'Every run: Any first room → generated rooms → Boss.',
    );
    await user.selectOptions(screen.getByLabelText('First room'), 'combat');
    await user.click(screen.getByLabelText('Always Rest before final Boss'));
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent(
      'Every run: Combat first → generated rooms → Rest → Boss.',
    );
    await save(user);
    expect(savedZone().generation).toMatchObject({
      firstNodeType: 'combat',
      rest: { beforeBoss: true },
    });

    await user.selectOptions(screen.getByLabelText('First room'), '');
    await save(user);
    expect(savedZone().generation).not.toHaveProperty('firstNodeType');
  });

  it('makes a room type appear as soon as its pool has an entry — no weight to find under Advanced', async () => {
    const user = renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    // The fixture's event weight is 10 already; its miniboss weight is 0.
    await user.click(
      within(screen.getByTestId('pool-miniboss')).getByRole('button', { name: 'Add enemy' }),
    );
    await user.click(
      within(screen.getByTestId('pool-event')).getByRole('button', { name: 'Add event' }),
    );
    await save(user);
    const saved = savedZone();
    expect(saved.pools.miniboss).toHaveLength(1);
    expect(saved.generation.nodeWeights.miniboss).toBe(10);
    // A weight the author already chose is never touched.
    expect(saved.generation.nodeWeights.event).toBe(PROCEDURAL.generation.nodeWeights.event);
    expect(saved.generation.nodeWeights.combat).toBe(PROCEDURAL.generation.nodeWeights.combat);
  });

  it('describes the extraction rules in a sentence, without opening the windows', async () => {
    zones.scrapheap_gauntlet = detailOf({
      ...PROCEDURAL,
      generation: {
        ...PROCEDURAL.generation,
        extraction: {
          minDepth: 3,
          nodeTypes: ['rest', 'exit'],
          minPoints: 1,
          windows: [
            { minDepth: 3, maxDepth: 4, required: true },
            { minDepth: 6, maxDepth: null, required: false },
          ],
        },
      },
    });
    renderAt(GAUNTLET);
    expect(await screen.findByTestId('extraction-summary')).toHaveTextContent(
      'An early way out between depth 3 and 4, in every run. A later way out from depth 6, when the run is long enough.',
    );
  });

  it('saves an untouched procedural dungeon exactly as it loaded — the redesign adds nothing to the document', async () => {
    const user = renderAt(GAUNTLET);
    await screen.findByTestId('zone-shape');
    const name = screen.getByLabelText('Zone name');
    await user.type(name, '!');
    await save(user);
    expect(savedZone()).toEqual({ ...PROCEDURAL, name: 'Scrapheap Gauntlet!' });
  });
});

/* ───────────────────────── preview ───────────────────────── */

describe('preview dungeon', () => {
  it('shows an authored dungeon as its layout: no seed, no simulation, and a layout check', async () => {
    const user = renderAt('/admin/dungeons/preview?zone=blacksite_lab');
    expect(await screen.findByRole('heading', { name: 'Preview dungeon' })).toBeInTheDocument();
    await screen.findByTestId('authored-preview-note');
    expect(screen.queryByLabelText('Seed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Simulate/ })).not.toBeInTheDocument();
    expect(await screen.findByTestId('layout-check')).toHaveTextContent('No problems');

    await user.click(screen.getByRole('button', { name: 'Show layout' }));
    await waitFor(() =>
      expect(previewSpy).toHaveBeenCalledWith({ key: 'blacksite_lab' }, undefined),
    );
    expect(await screen.findByTestId('dungeon-graph-summary')).toHaveTextContent(
      'Room-by-room layout · 3 rooms · depth 3 · 0 branches · 1 extraction point',
    );
    const nodes = screen.getAllByTestId('dungeon-node');
    expect(within(nodes[0]!).getByText('Tunnel Mouth')).toBeInTheDocument();
    expect(within(nodes[1]!).getByText(/heals 20%/)).toBeInTheDocument();
    expect(within(nodes[2]!).getByText(/pays its own reward/)).toBeInTheDocument();
    expect(simulateSpy).not.toHaveBeenCalled();
  });

  it('lists what is wrong with an authored layout instead of pretending to generate it', async () => {
    zones.blacksite_lab = detailOf(AUTHORED, {
      issues: [
        {
          path: 'authored.rooms[2]',
          message:
            'Room "Security Post" cannot be reached from the start — link another room to it, or delete it.',
          severity: 'warning',
        },
      ],
    });
    renderAt('/admin/dungeons/preview?zone=blacksite_lab');
    expect(await screen.findByTestId('layout-check')).toHaveTextContent(
      'Room "Security Post" cannot be reached from the start',
    );
  });

  it('keeps the seed and the simulation for a procedural dungeon', async () => {
    renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet');
    expect(await screen.findByLabelText('Seed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate with a random seed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Simulate 1,000 runs/ })).toBeInTheDocument();
    expect(screen.queryByTestId('layout-check')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show layout' })).not.toBeInTheDocument();
  });

  it('previews an authored draft from the editor without saving it', async () => {
    const user = renderAt(LAB);
    await screen.findByTestId('zone-rooms');
    await user.click(card('Antechamber').getByRole('button', { name: 'Delete Antechamber' }));
    await user.click(screen.getByRole('button', { name: 'Preview this draft' }));
    expect(await screen.findByTestId('dungeon-graph')).toBeInTheDocument();
    const target = previewSpy.mock.calls[0]![0] as { zone: DungeonZoneDoc };
    expect(roomsOf(target.zone).map((r) => r.id)).not.toContain('antechamber');
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
