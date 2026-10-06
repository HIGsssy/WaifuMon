/**
 * Choosing enemies from the Dungeon editor: the shared picker on its own,
 * then inside a procedural pool and an authored room — where an enemy made a
 * moment ago is offered, a disabled one cannot be picked, stats are shown and
 * never edited, and `View Enemy` leads to the enemy's own page.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import * as dungeonApi from '@/api/adminDungeons';
import type { DungeonZoneDetail, DungeonZoneDoc } from '@/api/adminDungeons';
import * as enemyApi from '@/api/adminEnemies';
import type { EnemyRef } from '@/api/adminEnemies';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { enemyFixture, stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { DungeonZoneEditorPage } from '@/features/adminDungeons/DungeonZoneEditorPage';
import { newRoom, starterZone } from '@/features/adminDungeons/dungeonModel';

import { EnemyCreatePage } from '../EnemyCreatePage';
import { EnemyPicker } from '../EnemyPicker';
import { enemyDetailFixture } from './enemyFixtures';

const DRONE = enemyFixture({
  key: 'scrapyard_drone',
  name: 'Scrapyard Drone',
  attack: 12,
  defense: 4,
  hp: 60,
  tags: ['robotic'],
});
const COLOSSUS = enemyFixture({
  key: 'scrapheap_colossus',
  name: 'Scrapheap Colossus',
  attack: 55,
  defense: 30,
  hp: 300,
  tags: ['boss'],
});
/** Withdrawn from new use: listed, never pickable. */
const OLD_GUARD = enemyFixture({
  key: 'old_guard',
  name: 'Old Guard',
  enabled: false,
  attack: 30,
  defense: 20,
  hp: 200,
});
/** Made on the Enemies page after the dungeon was built. */
const HOUND = enemyFixture({
  key: 'rust_hound',
  name: 'Rust Hound',
  attack: 20,
  defense: 6,
  hp: 90,
});

const withSession = (permissions: string[], path: string, client: QueryClient) => {
  const session = {
    status: 'ready',
    session: { playerId: 1, guildDbId: 1, displayName: 'Author', avatarUrl: null, permissions },
    error: null,
  } as unknown as SessionState;
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
};
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  stubObjectUrls();
  vi.spyOn(dungeonApi, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
  vi.spyOn(artworkApi, 'scenePreviewBlob').mockImplementation(async () => new Blob(['scene']));
});
afterEach(() => vi.restoreAllMocks());

/* ───────────────────────── the picker itself ───────────────────────── */

describe('enemy picker', () => {
  const ROWS = [DRONE, COLOSSUS, OLD_GUARD];
  async function renderPicker(props: Partial<Parameters<typeof EnemyPicker>[0]> = {}) {
    const onPick = vi.fn<(keys: string[]) => void>();
    const onClose = vi.fn<() => void>();
    render(
      <EnemyPicker
        open
        title="Choose an enemy"
        enemies={ROWS}
        onPick={onPick}
        onClose={onClose}
        {...props}
      />,
      // Enemies without `dungeons.read` or `artwork.read`: the picker needs neither to list them.
      { wrapper: withSession([], '/', newClient()) },
    );
    // Let the thumbnails finish loading, so nothing updates after the test has ended.
    await waitFor(() => expect(screen.queryAllByTestId(/-loading$/)).toHaveLength(0));
    return { user: userEvent.setup(), onPick, onClose };
  }

  it('lists each enemy with its name, status, stats and tags', async () => {
    await renderPicker();
    const drone = within(screen.getByTestId('enemy-option-scrapyard_drone'));
    expect(drone.getByText('Scrapyard Drone')).toBeInTheDocument();
    expect(drone.getByText('Enabled')).toBeInTheDocument();
    expect(drone.getByText('ATK 12 · DEF 4 · HP 60')).toBeInTheDocument();
    expect(drone.getByText('robotic')).toBeInTheDocument();
    expect(drone.getByTestId(/^enemy-option-thumb-scrapyard_drone/)).toBeInTheDocument();
    // Nobody is asked to read or type a key.
    expect(screen.queryByText('scrapyard_drone')).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('searches by name and by tag', async () => {
    const { user } = await renderPicker();
    const names = () =>
      screen.getAllByTestId(/^enemy-option-(?!thumb)/).map((b) => b.getAttribute('aria-label'));
    await user.type(screen.getByLabelText('Search enemies'), 'colos');
    expect(names()).toEqual(['Scrapheap Colossus']);
    await user.clear(screen.getByLabelText('Search enemies'));
    await user.type(screen.getByLabelText('Search enemies'), 'robotic');
    expect(names()).toEqual(['Scrapyard Drone']);
    await user.clear(screen.getByLabelText('Search enemies'));
    await user.type(screen.getByLabelText('Search enemies'), 'zzz');
    expect(screen.getByTestId('enemy-picker-empty')).toHaveTextContent('No enemy matches.');
  });

  it('picks one enemy and closes, in single mode', async () => {
    const { user, onPick, onClose } = await renderPicker({ selectedKey: 'scrapyard_drone' });
    expect(screen.getByRole('button', { name: 'Scrapyard Drone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Scrapheap Colossus' }));
    expect(onPick).toHaveBeenCalledWith(['scrapheap_colossus']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ticks several and adds them together, in multiple mode', async () => {
    const { user, onPick, onClose } = await renderPicker({ multiple: true });
    expect(screen.getByRole('button', { name: 'Add enemies' })).toBeDisabled();
    // Ticked out of order, unticked and re-ticked: what comes back is in list order.
    await user.click(screen.getByRole('button', { name: 'Scrapheap Colossus' }));
    await user.click(screen.getByRole('button', { name: 'Scrapyard Drone' }));
    await user.click(screen.getByRole('button', { name: 'Scrapheap Colossus' }));
    expect(screen.getByRole('button', { name: 'Add 1 enemy' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Scrapheap Colossus' }));
    expect(onPick).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add 2 enemies' }));
    expect(onPick).toHaveBeenCalledWith(['scrapyard_drone', 'scrapheap_colossus']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a disabled enemy greyed and labelled, and will not let it be picked', async () => {
    const { user, onPick } = await renderPicker({ multiple: true });
    const guard = screen.getByRole('button', { name: 'Old Guard (disabled)' });
    expect(guard).toBeDisabled();
    expect(within(guard).getByText('Disabled')).toBeInTheDocument();
    expect(guard.className).toContain('opacity-50');
    await user.click(guard);
    expect(screen.getByRole('button', { name: 'Add enemies' })).toBeDisabled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says so when there are no enemies at all', async () => {
    await renderPicker({ enemies: [] });
    expect(screen.getByTestId('enemy-picker-empty')).toHaveTextContent('There are no enemies yet.');
  });
});

/* ───────────────────────── inside the Dungeon editor ───────────────────────── */

describe('enemies in the dungeon editor', () => {
  let enemies: EnemyRef[];
  let stored: DungeonZoneDetail;
  let updateSpy: MockInstance<typeof dungeonApi.updateDungeonZone>;
  let referenceSpy: MockInstance<typeof dungeonApi.getDungeonReference>;

  const detailOf = (zone: DungeonZoneDoc): DungeonZoneDetail => ({
    key: zone.key,
    name: zone.name,
    enabled: zone.enabled,
    order: zone.order,
    tags: zone.tags,
    layoutMode: zone.layoutMode ?? 'procedural',
    minNodes: zone.generation.minNodes,
    maxNodes: zone.generation.maxNodes,
    poolCount: 2,
    poolEntryCount: 2,
    rewardBandCount: zone.rewards.bands.length,
    availableRegions: zone.availableRegions ?? [],
    revision: 3,
    origin: 'custom',
    matchesShipped: null,
    updatedAt: '2026-10-01T12:00:00.000Z',
    updatedBy: 'seed',
    zone,
    issues: [],
  });
  const zoneOf = (layoutMode: 'procedural' | 'authored') =>
    starterZone(
      { name: 'Scrapheap Gauntlet', key: 'scrapheap_gauntlet', regions: ['foothills'], layoutMode },
      { enemies: [DRONE, COLOSSUS] },
    );

  beforeEach(() => {
    enemies = [DRONE, COLOSSUS, OLD_GUARD];
    stored = detailOf(zoneOf('procedural'));
    // Enemies reach the Dungeon editor with its own reference data.
    referenceSpy = vi.spyOn(dungeonApi, 'getDungeonReference').mockImplementation(async () => ({
      nodeTypes: [...dungeonApi.DUNGEON_NODE_TYPES],
      enemies,
      events: [],
      rewardTables: [],
      currencies: [
        { key: 'ascension_currency', singularName: 'Token', pluralName: 'Tokens', enabled: true },
      ],
      regions: [{ id: 'foothills', name: 'Foothills', enabled: true }],
    }));
    vi.spyOn(dungeonApi, 'getDungeonZone').mockImplementation(async () => stored);
    vi.spyOn(dungeonApi, 'validateDungeonZone').mockResolvedValue({ issues: [] });
    updateSpy = vi
      .spyOn(dungeonApi, 'updateDungeonZone')
      .mockImplementation(async (_key, zone, revision) => {
        stored = { ...detailOf(zone), revision: revision + 1 };
        return stored;
      });
    // The catalogue's own routes belong to another permission; the Dungeon editor must not call them.
    const forbidden = async () => {
      throw new PortalApiError({ status: 403, code: 'PORTAL_PERMISSION_DENIED', message: 'No.' });
    };
    vi.spyOn(enemyApi, 'listEnemies').mockImplementation(forbidden);
    vi.spyOn(enemyApi, 'getEnemyReference').mockImplementation(forbidden);
    vi.spyOn(enemyApi, 'getEnemy').mockImplementation(forbidden);
  });

  const EDITOR = '/admin/dungeons/zones/scrapheap_gauntlet';
  /** A dungeon author who may also look at enemies — but the catalogue's routes are still never called. */
  function renderEditor(permissions = ['dungeons.read', 'dungeons.write', 'enemies.read']) {
    const user = userEvent.setup();
    render(
      <Routes>
        <Route path="/admin/dungeons/zones/:key" element={<DungeonZoneEditorPage />} />
      </Routes>,
      { wrapper: withSession(permissions, EDITOR, newClient()) },
    );
    return user;
  }
  const save = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save dungeon' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save dungeon' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
  };
  const savedZone = () => updateSpy.mock.calls.at(-1)![1];
  const entries = (pool: string) =>
    within(screen.getByTestId(`pool-${pool}`)).getAllByTestId('pool-entry');

  it('shows each pool entry as a row: name, stats, weight, depth and a link to the enemy', async () => {
    stored = detailOf({
      ...zoneOf('procedural'),
      pools: {
        ...zoneOf('procedural').pools,
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
          {
            id: 'colossus_late',
            enemyKey: 'scrapheap_colossus',
            enabled: true,
            weight: 5,
            minDepth: 3,
            maxDepth: null,
            tags: [],
          },
        ],
      },
    });
    renderEditor();
    await screen.findByTestId('pool-combat');
    const [first, second] = entries('combat').map((e) => within(e));
    expect(first!.getByTestId('pool-entry-name')).toHaveTextContent('Scrapyard Drone');
    expect(first!.getByTestId('pool-entry-stats')).toHaveTextContent('ATK 12 · DEF 4 · HP 60');
    expect(first!.getByTestId('pool-entry-odds')).toHaveTextContent('Weight 50 · Depth 1–4');
    expect(second!.getByTestId('pool-entry-odds')).toHaveTextContent('Weight 5 · Depth 3+');
    expect(within(entries('boss')[0]!).getByTestId('pool-entry-odds')).toHaveTextContent(
      'Weight 10 · any depth',
    );

    // `View Enemy` opens the enemy's own page in a new tab, leaving the draft alone.
    const link = first!.getByRole('link', { name: /^View Enemy: Scrapyard Drone/ });
    expect(link).toHaveTextContent('View Enemy');
    expect(link).toHaveAttribute('href', '/admin/enemies/scrapyard_drone');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));

    // Stats belong to the enemy: the dungeon shows them and offers no way to change them.
    const pool = within(screen.getByTestId('pool-combat'));
    expect(pool.queryByLabelText(/ATK|DEF|HP/)).not.toBeInTheDocument();
    expect(pool.queryByRole('combobox')).not.toBeInTheDocument();
    // The tuning that is the pool's to set is still here.
    expect(pool.getByLabelText('Combat pool 1 weight')).toHaveValue(50);
    expect(pool.getByLabelText('Combat pool 1 min depth')).toHaveValue(1);
    expect(pool.getByLabelText('Combat pool 1 max depth')).toHaveValue(4);
    expect(pool.getByLabelText('Combat pool 1 id')).toHaveValue('drone');
    expect(pool.getByLabelText('Combat pool 1 enabled')).toBeChecked();
  });

  it('offers an enemy added since, adds one entry per enemy picked, and saves them', async () => {
    // Someone made Rust Hound on the Enemies page: the reference data now carries it.
    enemies = [...enemies, HOUND];
    const user = renderEditor();
    const combat = within(await screen.findByTestId('pool-combat'));
    await waitFor(() =>
      expect(within(entries('combat')[0]!).getByTestId('pool-entry-name')).toHaveTextContent(
        'Scrapyard Drone',
      ),
    );
    await user.click(combat.getByRole('button', { name: '+ Add Enemy' }));

    const picker = within(await screen.findByTestId('enemy-picker'));
    const hound = within(picker.getByRole('button', { name: 'Rust Hound' }));
    expect(hound.getByText('ATK 20 · DEF 6 · HP 90')).toBeInTheDocument();
    // A disabled enemy is shown, and cannot be newly chosen.
    expect(picker.getByRole('button', { name: 'Old Guard (disabled)' })).toBeDisabled();

    await user.click(picker.getByRole('button', { name: 'Rust Hound' }));
    // The same enemy may be in a pool twice (say, at two depths): its entry gets its own id.
    await user.click(picker.getByRole('button', { name: 'Scrapyard Drone' }));
    await user.click(picker.getByRole('button', { name: 'Add 2 enemies' }));
    await waitFor(() => expect(screen.queryByTestId('enemy-picker')).not.toBeInTheDocument());

    expect(
      entries('combat').map((e) => within(e).getByTestId('pool-entry-name').textContent),
    ).toEqual(['Scrapyard Drone', 'Scrapyard Drone', 'Rust Hound']);
    expect(within(entries('combat')[2]!).getByTestId('pool-entry-stats')).toHaveTextContent(
      'ATK 20 · DEF 6 · HP 90',
    );
    expect(
      within(entries('combat')[2]!).getByRole('link', { name: /^View Enemy: Rust Hound/ }),
    ).toHaveAttribute('href', '/admin/enemies/rust_hound');

    await save(user);
    expect(savedZone().pools.combat).toEqual([
      expect.objectContaining({ id: 'scrapyard_drone', enemyKey: 'scrapyard_drone' }),
      {
        id: 'scrapyard_drone_2',
        enemyKey: 'scrapyard_drone',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
      {
        id: 'rust_hound',
        enemyKey: 'rust_hound',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ]);
    // All of it from the dungeon's own reference data.
    expect(referenceSpy).toHaveBeenCalled();
    expect(enemyApi.listEnemies).not.toHaveBeenCalled();
    expect(enemyApi.getEnemyReference).not.toHaveBeenCalled();
  });

  it('lets a dungeon-only author pick enemies and see their stats, without a link they cannot open', async () => {
    enemies = [...enemies, HOUND];
    const user = renderEditor(['dungeons.read', 'dungeons.write']);
    const combat = within(await screen.findByTestId('pool-combat'));
    await waitFor(() =>
      expect(within(entries('combat')[0]!).getByTestId('pool-entry-stats')).toHaveTextContent(
        'ATK 12 · DEF 4 · HP 60',
      ),
    );
    expect(screen.queryByRole('link', { name: /^View Enemy/ })).not.toBeInTheDocument();

    await user.click(combat.getByRole('button', { name: '+ Add Enemy' }));
    const picker = within(await screen.findByTestId('enemy-picker'));
    await user.click(picker.getByRole('button', { name: 'Rust Hound' }));
    await user.click(picker.getByRole('button', { name: 'Add 1 enemy' }));
    await save(user);
    expect(savedZone().pools.combat.map((e) => e.enemyKey)).toEqual([
      'scrapyard_drone',
      'rust_hound',
    ]);
    expect(enemyApi.listEnemies).not.toHaveBeenCalled();
    expect(enemyApi.getEnemyReference).not.toHaveBeenCalled();
  });

  it('removes a pool entry, and keeps the event pool on its own controls', async () => {
    const user = renderEditor();
    const boss = within(await screen.findByTestId('pool-boss'));
    await user.click(boss.getByRole('button', { name: 'Remove Boss pool 1' }));
    expect(boss.getByText('No entries.')).toBeInTheDocument();
    const events = within(screen.getByTestId('pool-event'));
    expect(events.getByRole('button', { name: 'Add event' })).toBeInTheDocument();
    expect(events.queryByRole('button', { name: '+ Add Enemy' })).not.toBeInTheDocument();
  });

  it('warns on an entry whose enemy is disabled, and names an entry whose enemy is gone', async () => {
    stored = detailOf({
      ...zoneOf('procedural'),
      pools: {
        ...zoneOf('procedural').pools,
        combat: [
          {
            id: 'guard',
            enemyKey: 'old_guard',
            enabled: true,
            weight: 10,
            minDepth: 1,
            maxDepth: null,
            tags: [],
          },
          {
            id: 'ghost',
            enemyKey: 'ghost',
            enabled: true,
            weight: 10,
            minDepth: 1,
            maxDepth: null,
            tags: [],
          },
        ],
      },
    });
    renderEditor();
    await screen.findByTestId('pool-combat');
    await waitFor(() =>
      expect(within(entries('combat')[0]!).getByTestId('pool-entry-name')).toHaveTextContent(
        'Old Guard',
      ),
    );
    const [guard, ghost] = entries('combat').map((e) => within(e));
    expect(guard!.getByTestId('pool-entry-disabled')).toHaveTextContent('disabled — not drawn');
    // The reference is kept and still leads to the enemy, where it can be enabled.
    expect(guard!.getByRole('link', { name: /^View Enemy/ })).toHaveAttribute(
      'href',
      '/admin/enemies/old_guard',
    );
    expect(ghost!.getByTestId('pool-entry-name')).toHaveTextContent('(unknown enemy)');
    expect(ghost!.queryByTestId('pool-entry-stats')).not.toBeInTheDocument();
    expect(ghost!.queryByRole('link', { name: /^View Enemy/ })).not.toBeInTheDocument();
    expect(ghost!.getByRole('button', { name: 'Remove Combat pool 2' })).toBeInTheDocument();
  });

  it('picks a room’s enemy from the picker, showing its stats read-only and a link to it', async () => {
    enemies = [...enemies, HOUND];
    stored = detailOf(zoneOf('authored'));
    const user = renderEditor();
    await screen.findByTestId('zone-rooms');
    await user.click(screen.getByRole('button', { name: 'Edit Start' }));
    const editor = within(await screen.findByTestId('room-editor'));

    const field = within(editor.getByTestId('room-enemy'));
    expect(field.getByRole('button', { name: 'Enemy: Scrapyard Drone' })).toBeInTheDocument();
    expect(field.getByTestId('room-enemy-stats')).toHaveTextContent('ATK 12 · DEF 4 · HP 60');
    const link = field.getByRole('link', { name: /^View Enemy: Scrapyard Drone/ });
    expect(link).toHaveAttribute('href', '/admin/enemies/scrapyard_drone');
    expect(link).toHaveAttribute('target', '_blank');
    // No select of keys, and no stat is editable from a room.
    expect(field.queryByRole('combobox')).not.toBeInTheDocument();
    expect(editor.queryByLabelText(/^(ATK|DEF|HP)$/)).not.toBeInTheDocument();

    await user.click(field.getByRole('button', { name: 'Enemy: Scrapyard Drone' }));
    const picker = within(await screen.findByTestId('enemy-picker'));
    // One enemy per room: the current one is marked, and there is nothing to confirm.
    expect(picker.getByRole('button', { name: 'Scrapyard Drone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(picker.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
    expect(picker.getByRole('button', { name: 'Old Guard (disabled)' })).toBeDisabled();
    await user.click(picker.getByRole('button', { name: 'Rust Hound' }));
    await waitFor(() => expect(screen.queryByTestId('enemy-picker')).not.toBeInTheDocument());

    expect(field.getByRole('button', { name: 'Enemy: Rust Hound' })).toBeInTheDocument();
    expect(field.getByTestId('room-enemy-stats')).toHaveTextContent('ATK 20 · DEF 6 · HP 90');
    await save(user);
    expect(savedZone().authored!.rooms[0]).toMatchObject({ id: 'start', enemyKey: 'rust_hound' });
    expect(enemyApi.getEnemy).not.toHaveBeenCalled();
  });

  it('keeps a room’s disabled enemy, with a warning, until the author changes it', async () => {
    const zone = zoneOf('authored');
    stored = detailOf({
      ...zone,
      authored: {
        ...zone.authored!,
        rooms: zone.authored!.rooms.map((room) =>
          room.id === 'start' ? { ...room, enemyKey: 'old_guard' } : room,
        ),
      },
    });
    const user = renderEditor();
    await screen.findByTestId('zone-rooms');
    await user.click(screen.getByRole('button', { name: 'Edit Start' }));
    const editor = within(await screen.findByTestId('room-editor'));
    expect(editor.getByRole('button', { name: 'Enemy: Old Guard' })).toBeInTheDocument();
    expect(editor.getByTestId('room-enemy-disabled')).toHaveTextContent(
      'This enemy is disabled. The room keeps it and still fights it',
    );

    // Editing something else leaves the reference exactly as it was.
    await user.type(editor.getByLabelText('Room notes'), 'check this one');
    await save(user);
    expect(savedZone().authored!.rooms[0]).toMatchObject({ id: 'start', enemyKey: 'old_guard' });
  });

  it('shows a room with no enemy, and one whose enemy no longer exists, without a key to type', async () => {
    const zone = zoneOf('authored');
    stored = detailOf({
      ...zone,
      authored: {
        startRoomId: 'start',
        rooms: [
          { ...newRoom('start', 'combat', null, null), name: 'Start', next: ['gone'] },
          { ...newRoom('gone', 'boss', 'ghost', null), name: 'Gone' },
        ],
      },
    });
    const user = renderEditor();
    await screen.findByTestId('zone-rooms');
    await user.click(screen.getByRole('button', { name: 'Edit Start' }));
    let editor = within(await screen.findByTestId('room-editor'));
    expect(editor.getByRole('button', { name: 'Enemy: none chosen' })).toHaveTextContent(
      'Choose an enemy…',
    );
    expect(editor.queryByTestId('room-enemy-stats')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit Gone' }));
    editor = within(await screen.findByTestId('room-editor'));
    expect(editor.getByRole('button', { name: 'Enemy: unknown enemy' })).toHaveTextContent(
      '(unknown enemy)',
    );
  });
});

/* ───────────────────────── a new enemy reaches the picker ───────────────────────── */

describe('after an enemy write', () => {
  it('refreshes the Dungeon editor’s reference data, so the new enemy is pickable there', async () => {
    const client = newClient();
    const referenceKey = [...dungeonApi.DUNGEONS_QUERY_KEY, 'reference'];
    // The Dungeon editor loaded its reference data before the enemy existed.
    client.setQueryData(referenceKey, { enemies: [DRONE] });
    client.setQueryData([...enemyApi.ENEMIES_QUERY_KEY, 'list'], { enemies: [] });
    vi.spyOn(enemyApi, 'createEnemy').mockImplementation(async (key, enemy) =>
      enemyDetailFixture({ key, ...enemy }),
    );
    vi.spyOn(enemyApi, 'getEnemy').mockImplementation(async (key) =>
      enemyDetailFixture({ key, name: 'Rust Hound' }),
    );

    const user = userEvent.setup();
    render(
      <Routes>
        <Route path="/admin/enemies/new" element={<EnemyCreatePage />} />
        <Route path="/admin/enemies/:key" element={<p>editor</p>} />
      </Routes>,
      { wrapper: withSession(['enemies.read', 'enemies.write'], '/admin/enemies/new', client) },
    );
    await user.type(screen.getByLabelText('Enemy name'), 'Rust Hound');
    await user.click(screen.getByRole('button', { name: 'Create enemy' }));
    expect(await screen.findByText('editor')).toBeInTheDocument();

    expect(client.getQueryState(referenceKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState([...enemyApi.ENEMIES_QUERY_KEY, 'list'])?.isInvalidated).toBe(true);
  });
});
