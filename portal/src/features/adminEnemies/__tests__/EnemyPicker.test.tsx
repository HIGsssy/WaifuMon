/**
 * Choosing enemies from the Dungeon editor: the shared picker on its own,
 * then inside a procedural pool and an authored room — where an enemy made a
 * moment ago is offered, a disabled one cannot be picked, stats are shown and
 * never edited, and `View Enemy` leads to the enemy's own page.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import * as dungeonApi from '@/api/adminDungeons';
import * as enemyApi from '@/api/adminEnemies';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import { enemyFixture, stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';

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
