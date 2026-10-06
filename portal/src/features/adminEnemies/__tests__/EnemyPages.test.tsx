/**
 * The Enemy Catalogue pages: the list (search, filters, enable/disable,
 * duplicate, export), the creation flow (key made from the name, server
 * issues at their fields), and the editor — stats saved with the loaded
 * revision, the stale-save refusal, artwork uploaded and selected in place,
 * sprite placement, usage, disabling an enemy that is in use, and the delete
 * refusal.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as artworkApi from '@/api/adminArtworkAssets';
import type { ArtworkAsset } from '@/api/adminArtworkAssets';
import * as dungeonApi from '@/api/adminDungeons';
import * as api from '@/api/adminEnemies';
import type { EnemyDetail, EnemyInput, EnemyReference } from '@/api/adminEnemies';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';
import {
  assetFixture,
  pngFile,
  stubObjectUrls,
} from '@/features/adminArtwork/__tests__/artworkFixtures';

import { EnemiesListPage } from '../EnemiesListPage';
import { EnemyCreatePage } from '../EnemyCreatePage';
import { EnemyEditorPage } from '../EnemyEditorPage';
import { definitionOf, enemyDetailFixture } from './enemyFixtures';

const DRONE_REFERENCES: EnemyReference[] = [
  {
    kind: 'dungeon_zone',
    key: 'scrapheap_gauntlet',
    name: 'Scrapheap Gauntlet',
    usage: 'combat pool',
  },
  {
    kind: 'dungeon_zone',
    key: 'scrapheap_gauntlet',
    name: 'Scrapheap Gauntlet',
    usage: 'boss pool',
  },
  { kind: 'combat_trial', key: 'trial_2', name: 'Combat Trial 2', usage: 'primary enemy' },
];

let store: Record<string, EnemyDetail>;
let assets: ArtworkAsset[];
let droneSprite: ArtworkAsset;
let nightBg: ArtworkAsset;
let createSpy: MockInstance<typeof api.createEnemy>;
let updateSpy: MockInstance<typeof api.updateEnemy>;
let enabledSpy: MockInstance<typeof api.setEnemyEnabled>;
let duplicateSpy: MockInstance<typeof api.duplicateEnemy>;
let deleteSpy: MockInstance<typeof api.deleteEnemy>;
let exportSpy: MockInstance<typeof api.exportEnemies>;
let uploadSpy: MockInstance<typeof artworkApi.uploadArtworkAsset>;
let sceneSpy: MockInstance<typeof artworkApi.scenePreviewBlob>;

/** What the server does with a save: the input over the stored enemy, one revision on. */
function applied(current: EnemyDetail, input: EnemyInput): EnemyDetail {
  return enemyDetailFixture({
    ...current,
    ...input,
    description: input.description ?? current.description,
    tags: input.tags ?? current.tags,
    revision: current.revision + 1,
    updatedBy: '777',
    // Recomputed from the saved fields.
    visual: undefined as never,
  });
}

beforeEach(() => {
  stubObjectUrls();
  droneSprite = assetFixture({ name: 'Drone Sprite', category: 'enemy_sprite', hasAlpha: true });
  nightBg = assetFixture({ name: 'Scrap Night', category: 'dungeon_background' });
  assets = [droneSprite, nightBg];

  const drone = enemyDetailFixture({
    key: 'scrapyard_drone',
    name: 'Scrapyard Drone',
    description: 'A patrol unit.',
    attack: 12,
    defense: 4,
    hp: 60,
    tags: ['robotic'],
    references: DRONE_REFERENCES,
  });
  const bruiser = enemyDetailFixture({
    key: 'alley_bruiser',
    name: 'Alley Bruiser',
    enabled: false,
    attack: 18,
    defense: 9,
    hp: 140,
    tags: ['organic', 'street'],
    origin: 'edited',
    matchesShipped: false,
  });
  const hound = enemyDetailFixture({
    key: 'rust_hound',
    name: 'Rust Hound',
    attack: 20,
    defense: 6,
    hp: 90,
    artworkPath: null,
    spriteAssetId: droneSprite.id,
    origin: 'custom',
    matchesShipped: null,
  });
  store = {
    scrapyard_drone: { ...drone, shipped: definitionOf(drone) },
    // Shipped weaker and enabled; made tougher and switched off here.
    alley_bruiser: { ...bruiser, shipped: { ...definitionOf(bruiser), attack: 15, enabled: true } },
    rust_hound: hound,
  };

  const found = (key: string) => {
    const enemy = store[key];
    if (!enemy) throw new PortalApiError({ status: 404, code: 'NOT_FOUND', message: 'Not found.' });
    return enemy;
  };
  vi.spyOn(api, 'listEnemies').mockImplementation(async () => ({ enemies: Object.values(store) }));
  vi.spyOn(api, 'getEnemy').mockImplementation(async (key) => found(key));
  createSpy = vi.spyOn(api, 'createEnemy').mockImplementation(async (key, enemy) => {
    const created = enemyDetailFixture({
      key,
      ...enemy,
      artworkPath: null,
      revision: 1,
      origin: 'custom',
      matchesShipped: null,
    });
    store = { ...store, [key]: created };
    return created;
  });
  updateSpy = vi.spyOn(api, 'updateEnemy').mockImplementation(async (key, enemy) => {
    const saved = applied(found(key), enemy);
    store = { ...store, [key]: saved };
    return saved;
  });
  enabledSpy = vi.spyOn(api, 'setEnemyEnabled').mockImplementation(async (key, enabled) => {
    const saved = { ...found(key), enabled, revision: found(key).revision + 1 };
    store = { ...store, [key]: saved };
    return saved;
  });
  duplicateSpy = vi.spyOn(api, 'duplicateEnemy').mockImplementation(async (sourceKey, input) => {
    const source = found(sourceKey);
    const copy = enemyDetailFixture({
      ...source,
      key: input.key,
      name: input.name ?? `${source.name} (copy)`,
      enabled: false,
      revision: 1,
      origin: 'custom',
      matchesShipped: null,
      references: [],
      usageCount: 0,
      shipped: null,
    });
    store = { ...store, [input.key]: copy };
    return copy;
  });
  deleteSpy = vi.spyOn(api, 'deleteEnemy').mockImplementation(async (key) => {
    const { [key]: _gone, ...rest } = store;
    store = rest;
    return { ok: true };
  });
  exportSpy = vi.spyOn(api, 'exportEnemies').mockImplementation(async () => ({
    file: 'combat/enemies.json',
    document: {
      format: 'waifumon-combat-enemies',
      version: 1,
      enemies: Object.values(store).map(definitionOf),
    },
    environmentLocal: {
      note: 'Managed artwork is stored in this environment only and is not part of the document.',
      managedArtwork: Object.values(store)
        .filter((e) => e.artworkAssetId !== null || e.spriteAssetId !== null)
        .map((e) => ({
          key: e.key,
          artworkAssetId: e.artworkAssetId,
          spriteAssetId: e.spriteAssetId,
        })),
    },
  }));

  vi.spyOn(dungeonApi, 'dungeonArtworkBlob').mockImplementation(async () => new Blob(['shipped']));
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
        name: file.name.replace(/\.[a-z]+$/, ''),
        category: options.category,
      });
      assets = [created, ...assets];
      return created;
    });
  sceneSpy = vi
    .spyOn(artworkApi, 'scenePreviewBlob')
    .mockImplementation(async () => new Blob(['scene']));
});
afterEach(() => vi.restoreAllMocks());

const ALL = ['enemies.read', 'enemies.write', 'artwork.read', 'artwork.write', 'dungeons.read'];
const READ_ONLY = ['enemies.read', 'artwork.read', 'dungeons.read'];
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
      <Route path="/admin/enemies" element={<EnemiesListPage />} />
      <Route path="/admin/enemies/new" element={<EnemyCreatePage />} />
      <Route path="/admin/enemies/:key" element={<EnemyEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

const LIST = '/admin/enemies';
const DRONE = '/admin/enemies/scrapyard_drone';
const HOUND = '/admin/enemies/rust_hound';
type User = ReturnType<typeof userEvent.setup>;
const rows = () => screen.getAllByTestId('enemy-row');
const row = (name: string) => {
  const found = rows().find((r) => within(r).queryByRole('link', { name }) !== null);
  if (!found) throw new Error(`no enemy row for ${name}`);
  return within(found);
};
const rowNames = () => rows().map((r) => within(r).getAllByRole('link')[0]!.textContent);
const retype = async (user: User, label: string, value: string) => {
  const field = await screen.findByLabelText(label);
  await user.clear(field);
  if (value !== '') await user.type(field, value);
};
const save = async (user: User) => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save enemy' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save enemy' }));
};
const savedEnemy = () => updateSpy.mock.calls.at(-1)![1];
const stale = () =>
  new PortalApiError({
    status: 409,
    code: 'ENEMY_STALE',
    message: 'This enemy was changed by someone else since you opened it.',
    details: {
      expectedRevision: 3,
      currentRevision: 4,
      updatedBy: '999',
      updatedAt: '2026-10-04T12:00:00.000Z',
    },
  });

/* ───────────────────────── the list ───────────────────────── */

describe('enemy list', () => {
  it('shows every enemy with its stats, status, tags, pictures, usage and origin', async () => {
    renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    expect(rowNames()).toEqual(['Scrapyard Drone', 'Alley Bruiser', 'Rust Hound']);

    const drone = row('Scrapyard Drone');
    expect(drone.getByTestId('enemy-glance')).toHaveTextContent('ATK 12 · DEF 4 · HP 60');
    expect(drone.getByTestId('enemy-usage')).toHaveTextContent('Used in 3 places');
    expect(drone.getByText('scrapyard_drone')).toBeInTheDocument();
    expect(drone.getByText('Enabled')).toBeInTheDocument();
    expect(drone.getByText('Shipped')).toBeInTheDocument();
    expect(drone.getByText('robotic')).toBeInTheDocument();
    expect(await drone.findByTestId('enemy-art-scrapyard_drone-image')).toBeInTheDocument();
    // No sprite, so no sprite thumbnail.
    expect(drone.queryByTestId(/^enemy-sprite-/)).not.toBeInTheDocument();

    const bruiser = row('Alley Bruiser');
    expect(bruiser.getByText('Disabled')).toBeInTheDocument();
    expect(bruiser.getByText('Edited in Portal')).toBeInTheDocument();
    expect(bruiser.getByTestId('enemy-usage')).toHaveTextContent('Not used anywhere');

    const hound = row('Rust Hound');
    expect(hound.getByText('Created in Portal')).toBeInTheDocument();
    expect(await hound.findByTestId('enemy-sprite-rust_hound-image')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'New Enemy' })).toHaveAttribute(
      'href',
      '/admin/enemies/new',
    );
    expect(drone.getByRole('link', { name: 'Edit Scrapyard Drone' })).toHaveAttribute(
      'href',
      DRONE,
    );
  });

  it('searches by name, key and tag, and filters by status, tag and usage', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');

    await user.type(screen.getByLabelText('Search enemies'), 'hound');
    expect(rowNames()).toEqual(['Rust Hound']);
    expect(screen.getByTestId('enemy-count')).toHaveTextContent('1 of 3 shown');
    await retype(user, 'Search enemies', 'alley_br');
    expect(rowNames()).toEqual(['Alley Bruiser']);
    await retype(user, 'Search enemies', 'robot');
    expect(rowNames()).toEqual(['Scrapyard Drone']);
    await retype(user, 'Search enemies', 'nothing like this');
    expect(screen.getByTestId('enemy-no-match')).toBeInTheDocument();
    await retype(user, 'Search enemies', '');

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'disabled');
    expect(rowNames()).toEqual(['Alley Bruiser']);
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'enabled');
    expect(rowNames()).toEqual(['Scrapyard Drone', 'Rust Hound']);
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'all');

    // Every tag in use is offered.
    expect(
      within(screen.getByLabelText('Filter by tag'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any tag', 'organic', 'robotic', 'street']);
    await user.selectOptions(screen.getByLabelText('Filter by tag'), 'street');
    expect(rowNames()).toEqual(['Alley Bruiser']);
    await user.selectOptions(screen.getByLabelText('Filter by tag'), '');

    await user.selectOptions(screen.getByLabelText('Filter by usage'), 'used');
    expect(rowNames()).toEqual(['Scrapyard Drone']);
    await user.selectOptions(screen.getByLabelText('Filter by usage'), 'unused');
    expect(rowNames()).toEqual(['Alley Bruiser', 'Rust Hound']);
  });

  it('enables a disabled enemy, and disables an unused one, straight away', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Enable Alley Bruiser' }));
    await waitFor(() => expect(enabledSpy).toHaveBeenCalledWith('alley_bruiser', true, 3));
    expect(
      await screen.findByRole('button', { name: 'Disable Alley Bruiser' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disable Rust Hound' }));
    await waitFor(() => expect(enabledSpy).toHaveBeenCalledWith('rust_hound', false, 3));
    expect(screen.queryByTestId('disable-enemy-confirm')).not.toBeInTheDocument();
  });

  it('asks before disabling an enemy that is in use, saying its references are kept', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Disable Scrapyard Drone' }));
    const confirm = within(await screen.findByTestId('disable-enemy-confirm'));
    expect(
      confirm.getByText(/It is used in 3 places\. Those references are kept/),
    ).toBeInTheDocument();
    expect(
      confirm.getByText('The dungeon generator stops drawing it from pools.'),
    ).toBeInTheDocument();
    expect(
      confirm.getByText('Hand-placed rooms keep fighting it until someone changes them.'),
    ).toBeInTheDocument();
    expect(confirm.getByText('Combat Trials that use it become unavailable.')).toBeInTheDocument();
    expect(enabledSpy).not.toHaveBeenCalled();

    // Backing out changes nothing.
    await user.click(confirm.getByRole('button', { name: 'Keep it enabled' }));
    await waitFor(() =>
      expect(screen.queryByTestId('disable-enemy-confirm')).not.toBeInTheDocument(),
    );
    expect(enabledSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Disable Scrapyard Drone' }));
    await user.click(
      within(await screen.findByTestId('disable-enemy-confirm')).getByRole('button', {
        name: 'Disable enemy',
      }),
    );
    await waitFor(() => expect(enabledSpy).toHaveBeenCalledWith('scrapyard_drone', false, 3));
    expect(
      await screen.findByRole('button', { name: 'Enable Scrapyard Drone' }),
    ).toBeInTheDocument();
  });

  it('says so when someone else changed the enemy first', async () => {
    enabledSpy.mockRejectedValueOnce(stale());
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Enable Alley Bruiser' }));
    expect(
      await screen.findByText(
        /That enemy was changed by someone else — the list has been refreshed/,
      ),
    ).toBeInTheDocument();
  });

  it('duplicates an enemy under a suggested key, as a disabled draft, and opens the copy', async () => {
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Duplicate Scrapyard Drone' }));
    const dialog = within(await screen.findByTestId('duplicate-enemy-dialog'));
    expect(dialog.getByLabelText('Key of the copy')).toHaveValue('scrapyard_drone_copy');
    expect(dialog.getByLabelText('Copy artwork')).toBeChecked();
    expect(dialog.getByText(/The copy starts disabled/)).toBeInTheDocument();

    // A key that cannot be one is caught before the server is asked.
    await user.clear(dialog.getByLabelText('Key of the copy'));
    await user.type(dialog.getByLabelText('Key of the copy'), 'Drone Mk2');
    expect(dialog.getByRole('alert')).toHaveTextContent('lower_snake_case');
    expect(dialog.getByRole('button', { name: 'Duplicate' })).toBeDisabled();

    await user.clear(dialog.getByLabelText('Key of the copy'));
    await user.type(dialog.getByLabelText('Key of the copy'), 'drone_mk2');
    await user.type(dialog.getByLabelText('Name of the copy'), 'Drone Mk II');
    await user.click(dialog.getByLabelText('Copy artwork'));
    await user.click(dialog.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(duplicateSpy).toHaveBeenCalledWith('scrapyard_drone', {
        key: 'drone_mk2',
        name: 'Drone Mk II',
        copyArtwork: false,
      }),
    );

    // Lands in the copy's editor, where it is disabled until looked over.
    expect(await screen.findByRole('heading', { name: 'Enemy — Drone Mk II' })).toBeInTheDocument();
    expect(screen.getByTestId('enemy-key')).toHaveTextContent('drone_mk2');
    expect(screen.getByLabelText('Enemy enabled')).not.toBeChecked();
  });

  it('keeps the suggested name and the artwork unless told otherwise, and names a taken key', async () => {
    duplicateSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'ENEMY_KEY_TAKEN',
        message: 'Another enemy already uses that key.',
      }),
    );
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Duplicate Rust Hound' }));
    const dialog = within(await screen.findByTestId('duplicate-enemy-dialog'));
    await user.click(dialog.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(duplicateSpy).toHaveBeenCalledWith('rust_hound', {
        key: 'rust_hound_copy',
        copyArtwork: true,
      }),
    );
    expect(
      await dialog.findByText(/An enemy with the key “rust_hound_copy” already exists/),
    ).toBeInTheDocument();
    // Still on the list, with the dialog open to try another key.
    expect(screen.getByTestId('duplicate-enemy-dialog')).toBeInTheDocument();
  });

  it('exports enemies.json and says which enemies’ uploaded artwork is not in it', async () => {
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));

    const notice = within(await screen.findByTestId('enemy-export-notice'));
    expect(downloaded).toBe('enemies.json');
    expect(notice.getByText(/content\/combat\/enemies\.json/)).toBeInTheDocument();
    expect(
      notice.getByText(
        'Uploaded artwork is not in the file. It is stored in this environment only.',
      ),
    ).toBeInTheDocument();
    // Only the enemy with uploaded artwork is named.
    expect(notice.getByTestId('enemy-export-local')).toHaveTextContent(/^rust_hound$/);
  });

  it('exports without the warning when no enemy has uploaded artwork', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    store = { scrapyard_drone: store.scrapyard_drone! };
    const user = renderAt(LIST);
    await screen.findAllByTestId('enemy-row');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const notice = within(await screen.findByTestId('enemy-export-notice'));
    expect(notice.queryByText(/Uploaded artwork is not in the file/)).not.toBeInTheDocument();
    expect(notice.queryByTestId('enemy-export-local')).not.toBeInTheDocument();
  });

  it('is read-only without the write permission', async () => {
    renderAt(LIST, READ_ONLY);
    await screen.findAllByTestId('enemy-row');
    expect(screen.queryByRole('link', { name: 'New Enemy' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(Disable|Enable|Duplicate) / }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Scrapyard Drone' })).toHaveAttribute(
      'href',
      DRONE,
    );
    // Exporting only reads.
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });
});

/* ───────────────────────── creating ───────────────────────── */

describe('new enemy', () => {
  it('makes the key from the name until the author edits the key', async () => {
    const user = renderAt('/admin/enemies/new');
    const form = within(await screen.findByTestId('enemy-create'));
    await user.type(form.getByLabelText('Enemy name'), 'Fast Flyer!');
    expect(form.getByLabelText('Enemy key')).toHaveValue('fast_flyer');

    await user.clear(form.getByLabelText('Enemy key'));
    await user.type(form.getByLabelText('Enemy key'), 'flyer');
    // The name no longer drives it.
    await user.type(form.getByLabelText('Enemy name'), ' Mk II');
    expect(form.getByLabelText('Enemy key')).toHaveValue('flyer');
  });

  it('creates the enemy with its stats, tags and status, and opens the full editor', async () => {
    const user = renderAt('/admin/enemies/new');
    const form = within(await screen.findByTestId('enemy-create'));
    expect(form.getByRole('button', { name: 'Create enemy' })).toBeDisabled();
    await user.type(form.getByLabelText('Enemy name'), 'Fast Flyer');
    await retype(user, 'ATK', '55');
    await retype(user, 'DEF', '30');
    await retype(user, 'HP', '300');
    await user.type(form.getByLabelText('Add tag'), 'Flying Fast{Enter}');
    await user.type(form.getByLabelText('Add tag'), 'elite,');
    expect(form.getAllByTestId('enemy-tag').map((t) => t.textContent)).toEqual([
      'flying_fast×',
      'elite×',
    ]);
    await user.click(form.getByLabelText('Enemy enabled'));

    await user.click(form.getByRole('button', { name: 'Create enemy' }));
    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith('fast_flyer', {
        name: 'Fast Flyer',
        enabled: false,
        attack: 55,
        defense: 30,
        hp: 300,
        tags: ['flying_fast', 'elite'],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Enemy — Fast Flyer' })).toBeInTheDocument();
    expect(screen.getByTestId('enemy-key')).toHaveTextContent('fast_flyer');
    expect(screen.getByTestId('enemy-artwork')).toBeInTheDocument();
  });

  it('catches stats and tags outside the server’s bounds before asking it', async () => {
    const user = renderAt('/admin/enemies/new');
    const form = within(await screen.findByTestId('enemy-create'));
    await user.type(form.getByLabelText('Enemy name'), 'Fast Flyer');
    await retype(user, 'ATK', '0');
    expect(form.getByText('ATK must be a whole number from 1 to 1,000,000.')).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Create enemy' })).toBeDisabled();
    await retype(user, 'ATK', '1000001');
    expect(form.getByText('ATK must be a whole number from 1 to 1,000,000.')).toBeInTheDocument();
    await retype(user, 'ATK', '5');
    // Defense may be zero; HP may not.
    await retype(user, 'DEF', '0');
    await retype(user, 'HP', '2.5');
    expect(form.getByText('HP must be a whole number from 1 to 1,000,000.')).toBeInTheDocument();
    expect(form.queryByText(/^DEF must be/)).not.toBeInTheDocument();
    await retype(user, 'HP', '40');
    expect(form.getByRole('button', { name: 'Create enemy' })).toBeEnabled();

    await user.type(form.getByLabelText('Add tag'), 'Not a tag!{Enter}');
    expect(form.getByTestId('enemy-tag-error')).toHaveTextContent('is not a tag');
    expect(form.queryByTestId('enemy-tag')).not.toBeInTheDocument();

    await user.clear(form.getByLabelText('Enemy key'));
    await user.type(form.getByLabelText('Enemy key'), 'Fast-Flyer');
    expect(form.getByText(/The key must be lower_snake_case/)).toBeInTheDocument();
    expect(form.getByRole('button', { name: 'Create enemy' })).toBeDisabled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('shows the server’s issues at the fields they name, and a taken key at the key', async () => {
    createSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'ENEMY_INVALID',
        message: 'That enemy is not valid.',
        details: {
          issues: [
            { path: 'name', message: 'that name is reserved', severity: 'error' },
            { path: 'attack', message: 'attack is too high for a new enemy', severity: 'error' },
            { path: 'tags[0]', message: 'tag "boss" needs review', severity: 'error' },
            { path: 'key', message: '"new" is reserved — choose another key', severity: 'error' },
          ],
        },
      }),
    );
    const user = renderAt('/admin/enemies/new');
    const form = within(await screen.findByTestId('enemy-create'));
    await user.type(form.getByLabelText('Enemy name'), 'New');
    await user.click(form.getByRole('button', { name: 'Create enemy' }));

    expect(await form.findByTestId('enemy-name-issues')).toHaveTextContent('that name is reserved');
    expect(form.getByTestId('enemy-stat-issues')).toHaveTextContent(
      'attack is too high for a new enemy',
    );
    expect(form.getByTestId('enemy-tag-issues')).toHaveTextContent('tag "boss" needs review');
    expect(form.getByTestId('enemy-key-issues')).toHaveTextContent('"new" is reserved');
    // Still on the creation page, nothing lost.
    expect(form.getByLabelText('Enemy name')).toHaveValue('New');

    createSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'ENEMY_KEY_TAKEN',
        message: 'Another enemy already uses that key.',
      }),
    );
    await user.click(form.getByRole('button', { name: 'Create enemy' }));
    expect(await form.findByTestId('enemy-key-taken')).toHaveTextContent(
      'An enemy with the key “new” already exists',
    );
  });
});

/* ───────────────────────── the editor ───────────────────────── */

describe('enemy editor', () => {
  it('loads the enemy with its key as fixed text', async () => {
    renderAt(DRONE);
    expect(
      await screen.findByRole('heading', { name: 'Enemy — Scrapyard Drone' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('enemy-key')).toHaveTextContent('scrapyard_drone');
    expect(screen.queryByLabelText('Enemy key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Enemy name')).toHaveValue('Scrapyard Drone');
    expect(screen.getByLabelText('Enemy description')).toHaveValue('A patrol unit.');
    expect(screen.getByLabelText('Enemy enabled')).toBeChecked();
    expect(screen.getByLabelText('ATK')).toHaveValue('12');
    expect(screen.getByLabelText('DEF')).toHaveValue('4');
    expect(screen.getByLabelText('HP')).toHaveValue('60');
    expect(screen.getAllByTestId('enemy-tag').map((t) => t.textContent)).toEqual(['robotic×']);
    expect(screen.getByTestId('enemy-save-status')).toHaveTextContent('No unsaved changes.');
    expect(screen.getByRole('button', { name: 'Save enemy' })).toBeDisabled();
  });

  it('edits stats, tags and description and saves them with the loaded revision', async () => {
    const user = renderAt(DRONE);
    await retype(user, 'ATK', '70');
    await retype(user, 'DEF', '35');
    await retype(user, 'HP', '400');
    await retype(user, 'Enemy description', 'Now with rockets.');
    await user.type(screen.getByLabelText('Add tag'), 'rocket{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove tag robotic' }));
    expect(screen.getByTestId('unsaved-badge')).toBeInTheDocument();
    await save(user);

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith(
      'scrapyard_drone',
      {
        name: 'Scrapyard Drone',
        description: 'Now with rockets.',
        enabled: true,
        attack: 70,
        defense: 35,
        hp: 400,
        tags: ['rocket'],
        artworkAssetId: null,
        spriteAssetId: null,
        spritePlacement: null,
      },
      3,
    );
    // The shipped paths are never sent, so the server keeps them.
    expect(savedEnemy()).not.toHaveProperty('artworkPath');
    expect(savedEnemy()).not.toHaveProperty('spriteArtworkPath');
    await waitFor(() =>
      expect(screen.getByTestId('enemy-save-status')).toHaveTextContent('Saved.'),
    );

    // The next save names the revision the first one produced.
    await retype(user, 'ATK', '71');
    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect(updateSpy.mock.calls[1]![2]).toBe(4);
  });

  it('will not save a stat outside the server’s bounds', async () => {
    const user = renderAt(DRONE);
    await retype(user, 'HP', '0');
    expect(screen.getByText('HP must be a whole number from 1 to 1,000,000.')).toBeInTheDocument();
    expect(screen.getByTestId('enemy-save-status')).toHaveTextContent(
      '1 problem to fix before saving.',
    );
    expect(screen.getByRole('button', { name: 'Save enemy' })).toBeDisabled();
    await retype(user, 'HP', '1');
    expect(screen.getByRole('button', { name: 'Save enemy' })).toBeEnabled();
  });

  it('refuses a stale save, keeps it refused, and reloads the latest version on request', async () => {
    updateSpy.mockRejectedValueOnce(stale());
    const user = renderAt(DRONE);
    await retype(user, 'ATK', '70');
    await save(user);

    const banner = within(await screen.findByTestId('stale-banner'));
    expect(
      banner.getByText('This enemy was changed by someone else since you opened it.'),
    ).toBeInTheDocument();
    expect(banner.getByText(/It is now at revision 4 \(saved by 999\)/)).toBeInTheDocument();
    // The draft is still there, and cannot be forced over theirs.
    expect(screen.getByLabelText('ATK')).toHaveValue('70');
    expect(screen.getByRole('button', { name: 'Save enemy' })).toBeDisabled();

    store = {
      ...store,
      scrapyard_drone: { ...store.scrapyard_drone!, attack: 99, revision: 4, updatedBy: '999' },
    };
    await user.click(banner.getByRole('button', { name: 'Reload latest version' }));
    await waitFor(() => expect(screen.getByLabelText('ATK')).toHaveValue('99'));
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();

    await retype(user, 'ATK', '100');
    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect(updateSpy.mock.calls[1]![2]).toBe(4);
  });

  it('shows what the server refused at the field it names', async () => {
    updateSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'ENEMY_INVALID',
        message: 'That enemy is not valid.',
        details: {
          issues: [{ path: 'tags', message: 'the same tag is listed twice', severity: 'error' }],
        },
      }),
    );
    const user = renderAt(DRONE);
    await retype(user, 'ATK', '70');
    await save(user);
    expect(await screen.findByTestId('enemy-basics-issues')).toHaveTextContent(
      'the same tag is listed twice',
    );
  });

  it('shows the shipped fallback and what is in effect for each picture', async () => {
    renderAt(DRONE);
    const artwork = within(await screen.findByTestId('enemy-artwork'));
    expect(artwork.getByTestId('enemy-art-asset-fallback')).toHaveTextContent(
      'No uploaded artwork — uses the shipped file combat/enemies/scrapyard_drone.webp.',
    );
    expect(artwork.getByTestId('enemy-art-asset-in-effect')).toHaveTextContent(
      'In effect: the shipped file. Shipped fallback: combat/enemies/scrapyard_drone.webp',
    );
    expect(await artwork.findByTestId('enemy-art-asset-shipped-image')).toBeInTheDocument();
    expect(artwork.getByTestId('enemy-sprite-asset-fallback')).toHaveTextContent('uses no sprite');
    expect(artwork.getByTestId('enemy-sprite-asset-in-effect')).toHaveTextContent(
      'In effect: nothing — no sprite.',
    );
    expect(artwork.getByTestId('enemy-no-sprite')).toBeInTheDocument();
    // The library is one click away, and never required.
    expect(artwork.getByRole('link', { name: 'Artwork Assets' })).toHaveAttribute(
      'href',
      '/admin/artwork',
    );
  });

  it('uploads full artwork from inside the editor, selects it automatically and saves it', async () => {
    const user = renderAt(DRONE);
    const artwork = within(await screen.findByTestId('enemy-artwork'));
    const file = pngFile('drone_full.png');
    await user.upload(artwork.getByTestId('enemy-art-asset-file'), file);

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledWith(file, { category: 'enemy_art' }));
    expect(await artwork.findByTestId('enemy-art-asset-selected')).toHaveTextContent(
      'drone_full · Enemy full art',
    );
    expect(await artwork.findByTestId('enemy-art-asset-preview-image')).toBeInTheDocument();
    expect(artwork.getByTestId('enemy-art-asset-in-effect')).toHaveTextContent(
      'In effect: the uploaded artwork above.',
    );
    // Still in the enemy editor: the author never left for the asset library.
    expect(screen.getByTestId('enemy-basics')).toBeInTheDocument();

    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(savedEnemy()).toMatchObject({ artworkAssetId: assets[0]!.id, spriteAssetId: null });
  });

  it('selects an existing sprite from the library, and clearing it falls back again', async () => {
    const user = renderAt(DRONE);
    const artwork = within(await screen.findByTestId('enemy-artwork'));
    await user.click(artwork.getByRole('button', { name: 'Select transparent sprite' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Filter by category')).toHaveValue('enemy_sprite');
    await user.click(await dialog.findByTestId(`asset-card-${droneSprite.id}`));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await artwork.findByTestId('enemy-sprite-asset-selected')).toHaveTextContent(
      'Drone Sprite · Enemy sprite',
    );
    // With a sprite there is a scene to preview.
    expect(artwork.queryByTestId('enemy-no-sprite')).not.toBeInTheDocument();

    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(savedEnemy()).toMatchObject({ spriteAssetId: droneSprite.id });

    await user.click(artwork.getByRole('button', { name: 'Clear transparent sprite' }));
    expect(artwork.getByTestId('enemy-sprite-asset-fallback')).toHaveTextContent('uses no sprite');
    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    // Null, not absent: it clears the uploaded sprite.
    expect(savedEnemy().spriteAssetId).toBeNull();
  });

  it('places the sprite, previews the scene, and goes back to the default placement', async () => {
    const user = renderAt(HOUND);
    const placement = within(await screen.findByTestId('enemy-placement'));
    expect(placement.getByLabelText('Use default placement')).toBeChecked();
    expect(placement.queryByTestId('placement-controls')).not.toBeInTheDocument();

    await user.click(placement.getByLabelText('Use default placement'));
    await user.selectOptions(placement.getByLabelText('Sprite position'), 'bottom-left');
    const scale = placement.getByLabelText('Scale (%)');
    await user.clear(scale);
    await user.type(scale, '60');
    const offsetX = placement.getByLabelText('Offset X (px)');
    await user.clear(offsetX);
    await user.type(offsetX, '40');

    // The preview is the production compositor's, on a background chosen only for the preview.
    await user.click(placement.getByRole('button', { name: 'Select preview background' }));
    await user.click(
      await within(await screen.findByRole('dialog')).findByTestId(`asset-card-${nightBg.id}`),
    );
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith({
        background: { assetId: nightBg.id },
        sprite: { assetId: droneSprite.id, artworkPath: null },
        placement: { anchor: 'bottom-left', scaleBasisPoints: 6000, offsetX: 40, offsetY: 0 },
        playerBuddy: {},
      }),
    );
    expect(await placement.findByTestId('scene-preview-image')).toBeInTheDocument();

    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(savedEnemy().spritePlacement).toEqual({
      anchor: 'bottom-left',
      scaleBasisPoints: 6000,
      offsetX: 40,
      offsetY: 0,
    });
    // The preview background was never part of the enemy.
    expect(JSON.stringify(savedEnemy())).not.toContain(nightBg.id);

    await user.click(placement.getByLabelText('Use default placement'));
    expect(placement.queryByTestId('placement-controls')).not.toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect(savedEnemy().spritePlacement).toBeNull();
  });

  it('shows the reserved player Buddy in the preview and flags an enemy placed over her', async () => {
    const buddySpy = vi.spyOn(artworkApi, 'scenePreviewBuddy').mockReturnValue(null);
    const user = renderAt(HOUND);
    const placement = within(await screen.findByTestId('enemy-placement'));
    await user.click(placement.getByRole('button', { name: 'Select preview background' }));
    await user.click(
      await within(await screen.findByRole('dialog')).findByTestId(`asset-card-${nightBg.id}`),
    );
    // A fight preview always asks for the Buddy; she is never one of the placement controls.
    await waitFor(() =>
      expect(sceneSpy).toHaveBeenLastCalledWith(expect.objectContaining({ playerBuddy: {} })),
    );
    expect(await placement.findByTestId('scene-preview-image')).toBeInTheDocument();
    // Nothing reported (no sprite deployed for any species): no note, no warning.
    expect(placement.queryByTestId('scene-preview-buddy')).not.toBeInTheDocument();

    // Clear of her: the note, without a warning.
    buddySpy.mockReturnValue({ speciesSlug: 'alley_catgirl', overlapPercent: 0, collision: false });
    await user.click(placement.getByLabelText('Use default placement'));
    await user.selectOptions(placement.getByLabelText('Sprite position'), 'center');
    expect(await placement.findByTestId('scene-preview-buddy')).toHaveTextContent('alley_catgirl');
    expect(placement.queryByTestId('scene-preview-buddy-collision')).not.toBeInTheDocument();

    // Every anchor is still offered; standing on her is flagged, not forbidden.
    buddySpy.mockReturnValue({ speciesSlug: 'alley_catgirl', overlapPercent: 63, collision: true });
    await user.selectOptions(placement.getByLabelText('Sprite position'), 'bottom-left');
    expect(await placement.findByTestId('scene-preview-buddy-collision')).toHaveTextContent('63%');
    expect(within(placement.getByLabelText('Sprite position')).getAllByRole('option')).toHaveLength(
      6,
    );
  });

  it('groups usage by the content that names the enemy, linking to dungeons', async () => {
    renderAt(DRONE);
    const usage = within(await screen.findByTestId('enemy-usage'));
    const lines = usage.getAllByTestId('enemy-usage-row').map((r) => r.textContent);
    expect(lines).toEqual([
      'Dungeon Scrapheap Gauntlet — combat pool, boss pool',
      'Combat Trial Combat Trial 2 — primary enemy',
    ]);
    expect(usage.getByRole('link', { name: 'Scrapheap Gauntlet' })).toHaveAttribute(
      'href',
      '/admin/dungeons/zones/scrapheap_gauntlet',
    );
    // A trial has no page of its own to open.
    expect(usage.queryByRole('link', { name: 'Combat Trial 2' })).not.toBeInTheDocument();
  });

  it('says when an enemy is not used anywhere', async () => {
    renderAt(HOUND);
    expect(await screen.findByTestId('enemy-usage-list')).toHaveTextContent(
      'Not used anywhere yet.',
    );
  });

  it('confirms before saving an in-use enemy as disabled, and saves nothing if the author backs out', async () => {
    const user = renderAt(DRONE);
    await user.click(await screen.findByLabelText('Enemy enabled'));
    await save(user);
    const confirm = within(await screen.findByTestId('disable-enemy-confirm'));
    expect(
      confirm.getByText(/It is used in 3 places\. Those references are kept/),
    ).toBeInTheDocument();
    expect(
      confirm.getByText('The dungeon generator stops drawing it from pools.'),
    ).toBeInTheDocument();
    expect(
      confirm.getByText('Hand-placed rooms keep fighting it until someone changes them.'),
    ).toBeInTheDocument();
    expect(confirm.getByText('Combat Trials that use it become unavailable.')).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();

    await user.click(confirm.getByRole('button', { name: 'Keep it enabled' }));
    await waitFor(() =>
      expect(screen.queryByTestId('disable-enemy-confirm')).not.toBeInTheDocument(),
    );
    expect(updateSpy).not.toHaveBeenCalled();
    // The draft still says disabled; the choice is the author's to make again.
    expect(screen.getByLabelText('Enemy enabled')).not.toBeChecked();

    await save(user);
    await user.click(
      within(await screen.findByTestId('disable-enemy-confirm')).getByRole('button', {
        name: 'Disable enemy',
      }),
    );
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(savedEnemy()).toMatchObject({ enabled: false });
    expect(updateSpy.mock.calls[0]![2]).toBe(3);
  });

  it('disables an unused enemy, and saves other edits to a used one, without asking', async () => {
    const user = renderAt(HOUND);
    await user.click(await screen.findByLabelText('Enemy enabled'));
    await save(user);
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('disable-enemy-confirm')).not.toBeInTheDocument();
    expect(savedEnemy()).toMatchObject({ enabled: false });
  });

  it('shows the stored enemy’s current problems', async () => {
    store = {
      ...store,
      scrapyard_drone: {
        ...store.scrapyard_drone!,
        enabled: false,
        issues: [
          {
            path: 'enabled',
            message: 'This enemy is disabled but still named in 3 places.',
            severity: 'warning',
          },
          {
            path: 'spriteAssetId',
            message: 'The sprite "Old Drone" is disabled, so the shipped artwork shows instead.',
            severity: 'warning',
          },
        ],
      },
    };
    renderAt(DRONE);
    const warnings = within(await screen.findByTestId('enemy-warnings'));
    expect(
      warnings.getByText('⚠ This enemy is disabled but still named in 3 places.'),
    ).toBeInTheDocument();
    expect(warnings.getByText(/⚠ The sprite "Old Drone" is disabled/)).toBeInTheDocument();
    // And beside the picture it is about.
    expect(screen.getByTestId('enemy-artwork-issues')).toHaveTextContent(
      'The sprite "Old Drone" is disabled',
    );
  });

  it('says where the enemy stands relative to the shipped copy, and what was changed', async () => {
    renderAt('/admin/enemies/alley_bruiser');
    const advanced = within(await screen.findByTestId('enemy-advanced'));
    expect(advanced.getByTestId('enemy-provenance')).toHaveTextContent('Origin: Edited in Portal');
    expect(advanced.getByTestId('enemy-provenance')).toHaveTextContent('Revision 3');
    expect(advanced.getByTestId('enemy-provenance')).toHaveTextContent('by seed');
    expect(advanced.getByTestId('enemy-matches-shipped')).toHaveTextContent(
      'Differs from the copy shipped with the game.',
    );
    // Readable, field by field — not a JSON dump.
    const changes = within(advanced.getByTestId('enemy-shipped-diff'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(changes).toEqual(['Enabled: yes → no', 'ATK: 15 → 18']);
  });

  it('shows no diff for an untouched shipped enemy or one made in the Portal', async () => {
    renderAt(DRONE);
    const advanced = within(await screen.findByTestId('enemy-advanced'));
    expect(advanced.getByTestId('enemy-provenance')).toHaveTextContent('Origin: Shipped');
    expect(advanced.getByTestId('enemy-matches-shipped')).toHaveTextContent(
      'Matches the copy shipped with the game.',
    );
    expect(advanced.queryByTestId('enemy-shipped-diff')).not.toBeInTheDocument();
  });

  it('surfaces the delete refusal with where the enemy is used, and recommends disabling', async () => {
    deleteSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'ENEMY_IN_USE',
        message: 'That enemy is still in use. Disable it instead, or remove every reference first.',
        details: { references: DRONE_REFERENCES, shipped: true },
      }),
    );
    const user = renderAt(DRONE);
    const advanced = within(await screen.findByTestId('enemy-advanced'));
    await user.click(advanced.getByRole('button', { name: 'Delete enemy…' }));
    await user.click(
      within(advanced.getByTestId('enemy-delete-confirm')).getByRole('button', {
        name: 'Delete enemy',
      }),
    );
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('scrapyard_drone', 3));

    const refused = within(await advanced.findByTestId('enemy-delete-refused'));
    expect(refused.getByText('This enemy cannot be deleted.')).toBeInTheDocument();
    expect(refused.getAllByTestId('enemy-usage-row').map((r) => r.textContent)).toEqual([
      'Dungeon Scrapheap Gauntlet — combat pool, boss pool',
      'Combat Trial Combat Trial 2 — primary enemy',
    ]);
    expect(refused.getByText(/It ships with the game/)).toBeInTheDocument();
    expect(
      refused.getByText(/Disable it instead: untick Enabled under Basics and save/),
    ).toBeInTheDocument();
    // Nothing was deleted; the editor is still on the enemy.
    expect(screen.getByRole('heading', { name: 'Enemy — Scrapyard Drone' })).toBeInTheDocument();
  });

  it('deletes an enemy nothing uses, naming its revision, and returns to the list', async () => {
    const user = renderAt(HOUND);
    const advanced = within(await screen.findByTestId('enemy-advanced'));
    await user.click(advanced.getByRole('button', { name: 'Delete enemy…' }));
    // Asked first; backing out deletes nothing.
    await user.click(advanced.getByRole('button', { name: 'Keep it' }));
    expect(deleteSpy).not.toHaveBeenCalled();

    await user.click(advanced.getByRole('button', { name: 'Delete enemy…' }));
    await user.click(advanced.getByRole('button', { name: 'Delete enemy' }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('rust_hound', 3));
    expect(await screen.findByRole('heading', { name: 'Enemies' })).toBeInTheDocument();
    expect(rowNames()).toEqual(['Scrapyard Drone', 'Alley Bruiser']);
  });

  it('is read-only without the write permission', async () => {
    renderAt(DRONE, READ_ONLY);
    expect(await screen.findByLabelText('Enemy name')).toBeDisabled();
    expect(screen.getByLabelText('ATK')).toBeDisabled();
    expect(screen.getByLabelText('Enemy enabled')).toBeDisabled();
    expect(screen.getByLabelText('Use default placement')).toBeDisabled();
    expect(screen.queryByLabelText('Add tag')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload full artwork' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete enemy…' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save enemy' })).toBeDisabled();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
    // Usage is still there to read.
    expect(screen.getAllByTestId('enemy-usage-row')).toHaveLength(2);
  });
});
