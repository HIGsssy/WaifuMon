/**
 * Dungeon authoring: the zone list (enable/disable, the progression currency),
 * the zone editor — rules, pools, depth bands, server issues shown where they
 * belong, saving with the loaded revision, the stale-save refusal — and the
 * generation preview.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as api from '@/api/adminDungeons';
import type {
  DungeonPreview,
  DungeonReferenceData,
  DungeonZoneDetail,
  DungeonZoneDoc,
  DungeonZoneIssue,
  DungeonZoneSummary,
  ProgressionCurrency,
} from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { DungeonPreviewPage } from '../DungeonPreviewPage';
import { DungeonZoneEditorPage } from '../DungeonZoneEditorPage';
import { DungeonsListPage } from '../DungeonsListPage';

const REFERENCE: DungeonReferenceData = {
  nodeTypes: [...api.DUNGEON_NODE_TYPES],
  enemies: [
    { key: 'scrapyard_drone', name: 'Scrapyard Drone', enabled: true, tags: [] },
    { key: 'alley_bruiser', name: 'Alley Bruiser', enabled: true, tags: [] },
    { key: 'scrapheap_colossus', name: 'Scrapheap Colossus', enabled: true, tags: ['boss'] },
  ],
  events: [{ key: 'abandoned_cache', name: 'Abandoned Cache', enabled: true, tags: [] }],
  rewardTables: [
    { id: 'valley-success-v1', enabled: true },
    { id: 'valley-bonus-v1', enabled: false },
  ],
  currencies: [
    {
      key: 'ascension_currency',
      singularName: 'Ascension Token',
      pluralName: 'Ascension Tokens',
      enabled: true,
    },
  ],
};

const ZONE: DungeonZoneDoc = {
  key: 'scrapheap_gauntlet',
  name: 'Scrapheap Gauntlet',
  description: 'First zone.',
  enabled: true,
  order: 10,
  artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
  backgroundArtworkPath: null,
  tags: ['initial_tuning'],
  generation: {
    minNodes: 6,
    maxNodes: 9,
    branching: { minBranches: 0, maxBranches: 1, chanceBasisPoints: 3000, maxLength: 1 },
    extraction: { minDepth: 4, nodeTypes: ['rest', 'exit'], minPoints: 1 },
    nodeWeights: { combat: 60, elite: 10, event: 12, reward: 10, rest: 8, miniboss: 0, exit: 0 },
    boss: { required: true },
    depthRanges: { elite: { minDepth: 3, maxDepth: null } },
    required: [{ types: ['rest'], min: 1 }],
    limits: [{ types: ['elite'], max: 1 }],
    noConsecutive: ['rest'],
    maxConsecutiveSameEnemy: 2,
  },
  pools: {
    combat: [
      {
        id: 'drone',
        enemyKey: 'scrapyard_drone',
        enabled: true,
        weight: 50,
        minDepth: 1,
        maxDepth: 4,
        tags: ['robotic'],
      },
      {
        id: 'bruiser',
        enemyKey: 'alley_bruiser',
        enabled: true,
        weight: 35,
        minDepth: 2,
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
    event: [
      {
        id: 'cache',
        eventKey: 'abandoned_cache',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ],
  },
  rewards: {
    currencyKey: 'ascension_currency',
    defeatCurrencyRetentionBasisPoints: 2500,
    bands: [
      {
        id: 'early',
        enabled: true,
        minDepth: 1,
        maxDepth: 3,
        nodeTypes: [],
        rewardTable: null,
        equipmentRewardTable: null,
        currency: { min: 1, max: 2 },
      },
    ],
    completion: { currency: { min: 5, max: 5 }, rewardTable: null },
    extraction: { currency: { min: 0, max: 0 }, rewardTable: null },
  },
};

const SUMMARY: DungeonZoneSummary = {
  key: 'scrapheap_gauntlet',
  name: 'Scrapheap Gauntlet',
  enabled: true,
  order: 10,
  tags: ['initial_tuning'],
  minNodes: 6,
  maxNodes: 9,
  poolCount: 3,
  poolEntryCount: 4,
  rewardBandCount: 1,
  revision: 3,
  origin: 'shipped',
  matchesShipped: true,
  updatedAt: '2026-10-01T12:00:00.000Z',
  updatedBy: 'seed',
};
const DETAIL: DungeonZoneDetail = { ...SUMMARY, zone: ZONE, issues: [] };

const CURRENCY: ProgressionCurrency = {
  key: 'ascension_currency',
  singularName: 'Ascension Token',
  pluralName: 'Ascension Tokens',
  description: 'Earned in dungeons.',
  icon: null,
  enabled: true,
  revision: 1,
  updatedAt: '2026-10-01T12:00:00.000Z',
  updatedBy: 'seed',
};

const previewFor = (seed: number): DungeonPreview => ({
  zoneKey: 'scrapheap_gauntlet',
  seed,
  names: {
    enemies: { scrapyard_drone: 'Scrapyard Drone', scrapheap_colossus: 'Scrapheap Colossus' },
    events: {},
  },
  graph: {
    format: 'waifumon-dungeon-graph',
    generatorVersion: 1,
    zoneKey: 'scrapheap_gauntlet',
    seed,
    depthCount: 4,
    startNodeId: 'n1',
    terminalNodeId: 'n5',
    attempts: 1,
    nodes: [
      {
        id: 'n1',
        depth: 1,
        lane: 0,
        type: 'combat',
        outgoing: ['e1', 'e2'],
        content: { kind: 'enemy', key: 'scrapyard_drone' },
        source: { pool: 'combat', entryId: 'drone' },
        rewardBandId: 'early',
        extraction: false,
        terminal: false,
        boss: false,
      },
      {
        id: 'n2',
        depth: 2,
        lane: 0,
        type: 'reward',
        outgoing: ['e3'],
        content: null,
        source: null,
        rewardBandId: 'early',
        extraction: false,
        terminal: false,
        boss: false,
      },
      {
        id: 'n3',
        depth: 2,
        lane: 1,
        type: 'combat',
        outgoing: ['e4'],
        content: { kind: 'enemy', key: 'scrapyard_drone' },
        source: { pool: 'combat', entryId: 'drone' },
        rewardBandId: 'early',
        extraction: false,
        terminal: false,
        boss: false,
      },
      {
        id: 'n4',
        depth: 3,
        lane: 0,
        type: 'rest',
        outgoing: ['e5'],
        content: null,
        source: null,
        rewardBandId: 'early',
        extraction: true,
        terminal: false,
        boss: false,
      },
      {
        id: 'n5',
        depth: 4,
        lane: 0,
        type: 'boss',
        outgoing: [],
        content: { kind: 'enemy', key: 'scrapheap_colossus' },
        source: { pool: 'boss', entryId: 'colossus' },
        rewardBandId: null,
        extraction: false,
        terminal: true,
        boss: true,
      },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n1', to: 'n3' },
      { id: 'e3', from: 'n2', to: 'n4' },
      { id: 'e4', from: 'n3', to: 'n4' },
      { id: 'e5', from: 'n4', to: 'n5' },
    ],
  },
});

let issues: DungeonZoneIssue[];
let currency: ProgressionCurrency;
let updateSpy: MockInstance<typeof api.updateDungeonZone>;
let createSpy: MockInstance<typeof api.createDungeonZone>;
let enabledSpy: MockInstance<typeof api.setDungeonZoneEnabled>;
let currencySpy: MockInstance<typeof api.updateProgressionCurrency>;
let previewSpy: MockInstance<typeof api.previewDungeon>;
let validateSpy: MockInstance<typeof api.validateDungeonZone>;

beforeEach(() => {
  issues = [];
  currency = CURRENCY;
  vi.spyOn(api, 'getDungeonReference').mockResolvedValue(REFERENCE);
  vi.spyOn(api, 'listDungeonZones').mockResolvedValue({
    zones: [
      SUMMARY,
      {
        ...SUMMARY,
        key: 'rust_warrens',
        name: 'Rust Warrens',
        enabled: false,
        origin: 'custom',
        revision: 1,
      },
    ],
  });
  vi.spyOn(api, 'getDungeonZone').mockResolvedValue(DETAIL);
  vi.spyOn(api, 'listProgressionCurrencies').mockImplementation(async () => ({
    currencies: [currency],
  }));
  validateSpy = vi.spyOn(api, 'validateDungeonZone').mockImplementation(async () => ({ issues }));
  updateSpy = vi.spyOn(api, 'updateDungeonZone').mockImplementation(async (_key, zone, rev) => ({
    ...DETAIL,
    zone,
    name: zone.name,
    revision: rev + 1,
  }));
  createSpy = vi.spyOn(api, 'createDungeonZone').mockImplementation(async (zone) => ({
    ...DETAIL,
    key: zone.key,
    name: zone.name,
    zone,
    revision: 1,
    origin: 'custom',
  }));
  enabledSpy = vi
    .spyOn(api, 'setDungeonZoneEnabled')
    .mockImplementation(async (_key, enabled, rev) => ({
      ...DETAIL,
      enabled,
      revision: rev + 1,
    }));
  currencySpy = vi
    .spyOn(api, 'updateProgressionCurrency')
    .mockImplementation(async (_key, metadata, rev) => {
      currency = { ...currency, ...metadata, revision: rev + 1 };
      return currency;
    });
  previewSpy = vi
    .spyOn(api, 'previewDungeon')
    .mockImplementation(async (_target, seed) => previewFor(seed ?? 777));
});
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string, permissions = ['dungeons.read', 'dungeons.write']) {
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
      <Route path="/admin/dungeons/preview" element={<DungeonPreviewPage />} />
      <Route path="/admin/dungeons/new" element={<DungeonZoneEditorPage />} />
      <Route path="/admin/dungeons/zones/:key" element={<DungeonZoneEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

const EDITOR = '/admin/dungeons/zones/scrapheap_gauntlet';
const savedZone = () => updateSpy.mock.calls[0]![1];
const type = async (user: ReturnType<typeof userEvent.setup>, label: string, value: string) => {
  const field = await screen.findByLabelText(label);
  await user.clear(field);
  if (value !== '') await user.type(field, value);
};
const readyToSave = () =>
  waitFor(() =>
    expect(screen.getByTestId('validation-status')).toHaveTextContent('Ready to save.'),
  );

describe('zone list', () => {
  it('shows each zone with its name, state, node range, pools, revision and last update', async () => {
    renderAt('/admin/dungeons');
    const rows = await screen.findAllByTestId('dungeon-zone-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByRole('link', { name: 'Scrapheap Gauntlet' })).toHaveAttribute('href', EDITOR);
    expect(first.getByText('Enabled')).toBeInTheDocument();
    expect(first.getByText('Shipped')).toBeInTheDocument();
    expect(first.getByText(/6–9 nodes · 3 pools \(4 entries\) · 1 depth band/)).toBeInTheDocument();
    expect(first.getByText(/Revision 3 · updated .* by seed/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Disabled')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Portal only')).toBeInTheDocument();
  });

  it('disables a zone with the revision it listed, and offers no delete', async () => {
    const user = renderAt('/admin/dungeons');
    await user.click(await screen.findByRole('button', { name: 'Disable Scrapheap Gauntlet' }));
    await waitFor(() => expect(enabledSpy).toHaveBeenCalledWith('scrapheap_gauntlet', false, 3));
    expect(screen.getByRole('button', { name: 'Enable Rust Warrens' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('is read-only without write permission', async () => {
    renderAt('/admin/dungeons', ['dungeons.read']);
    await screen.findAllByTestId('dungeon-zone-row');
    expect(screen.queryByRole('button', { name: /Disable|Enable/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New zone' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'View' })).toHaveLength(2);
    expect(await screen.findByLabelText('Singular name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save currency' })).not.toBeInTheDocument();
  });
});

describe('progression currency', () => {
  it('shows the key as fixed text and saves renamed display metadata with the loaded revision', async () => {
    const user = renderAt('/admin/dungeons');
    const card = within(await screen.findByTestId('currency-card'));
    expect(card.getByTestId('currency-key')).toHaveTextContent('ascension_currency');
    expect(card.queryByLabelText(/key/i)).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Save currency' })).toBeDisabled();

    await type(user, 'Singular name', 'Star Shard');
    await type(user, 'Plural name', 'Star Shards');
    await type(user, 'Icon or emoji', '✨');
    expect(card.getByTestId('currency-sample')).toHaveTextContent(
      '✨ 1 Star Shard · ✨ 12 Star Shards',
    );
    await user.click(card.getByRole('button', { name: 'Save currency' }));

    await waitFor(() => expect(currencySpy).toHaveBeenCalledTimes(1));
    expect(currencySpy).toHaveBeenCalledWith(
      'ascension_currency',
      {
        singularName: 'Star Shard',
        pluralName: 'Star Shards',
        description: 'Earned in dungeons.',
        icon: '✨',
        enabled: true,
      },
      1,
    );
    expect(await screen.findByDisplayValue('Star Shards')).toBeInTheDocument();
  });

  it('will not save an empty name, and says so when someone else saved first', async () => {
    const user = renderAt('/admin/dungeons');
    await type(user, 'Plural name', '');
    expect(screen.getByRole('button', { name: 'Save currency' })).toBeDisabled();

    currencySpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'PROGRESSION_CURRENCY_STALE',
        message: 'stale',
        details: { currentRevision: 2 },
      }),
    );
    await type(user, 'Plural name', 'Embers');
    await user.click(screen.getByRole('button', { name: 'Save currency' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this currency',
    );
  });
});

describe('zone editor', () => {
  it('loads the zone, shows the key as fixed text and percentages for basis points', async () => {
    renderAt(EDITOR);
    expect(await screen.findByTestId('zone-key')).toHaveTextContent('scrapheap_gauntlet');
    expect(screen.queryByLabelText('Zone key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Zone name')).toHaveValue('Scrapheap Gauntlet');
    expect(screen.getByLabelText('Min nodes')).toHaveValue(6);
    expect(screen.getByLabelText('Branch chance (%)')).toHaveValue(30);
    expect(screen.getByLabelText('Kept on defeat (%)')).toHaveValue(25);
    expect(screen.getByLabelText('Elite min depth')).toHaveValue(3);
    expect(screen.getByLabelText('Combat pool 1 enemy')).toHaveValue('scrapyard_drone');
    expect(screen.getByLabelText('Extraction offered at: Rest')).toBeChecked();
    expect(screen.getByLabelText('Extraction offered at: Combat')).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByTestId('validation-status')).toHaveTextContent('No unsaved changes.'),
    );
    expect(screen.getByRole('button', { name: 'Save zone' })).toBeDisabled();
  });

  it('saves edits to the fields, rules and retention with the loaded revision', async () => {
    const user = renderAt(EDITOR);
    await type(user, 'Zone name', 'Scrapheap Gauntlet II');
    await type(user, 'Max nodes', '12');
    await type(user, 'Branch chance (%)', '45');
    await type(user, 'Extraction from depth', '5');
    await type(user, 'Combat weight', '80');
    await type(user, 'Kept on defeat (%)', '40');
    await type(user, 'Background artwork path', 'dungeons/backgrounds/scrapheap_gauntlet.webp');
    await user.click(screen.getByLabelText('Zone enabled'));
    await user.click(screen.getByLabelText('Reward never twice in a row'));
    await user.click(screen.getByLabelText('Extraction offered at: Reward'));
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy.mock.calls[0]![0]).toBe('scrapheap_gauntlet');
    expect(updateSpy.mock.calls[0]![2]).toBe(3);
    const zone = savedZone();
    expect(zone).toMatchObject({
      key: 'scrapheap_gauntlet',
      name: 'Scrapheap Gauntlet II',
      enabled: false,
      backgroundArtworkPath: 'dungeons/backgrounds/scrapheap_gauntlet.webp',
    });
    expect(zone.generation.maxNodes).toBe(12);
    expect(zone.generation.branching.chanceBasisPoints).toBe(4500);
    expect(zone.generation.extraction).toEqual({
      minDepth: 5,
      nodeTypes: ['reward', 'rest', 'exit'],
      minPoints: 1,
    });
    expect(zone.generation.nodeWeights.combat).toBe(80);
    expect(zone.generation.noConsecutive).toEqual(['reward', 'rest']);
    expect(zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(4000);
    // Untouched parts of the document survive the round trip.
    expect(zone.pools).toEqual(ZONE.pools);
    expect(zone.generation.required).toEqual(ZONE.generation.required);
  });

  it('edits depth ranges and hard constraints', async () => {
    const user = renderAt(EDITOR);
    await type(user, 'Elite min depth', '1');
    await type(user, 'Rest min depth', '2');
    await type(user, 'Rest max depth', '6');
    await type(user, 'Same enemy in a row, at most', '');
    await user.click(screen.getByRole('button', { name: 'Add guarantee' }));
    await user.click(screen.getByLabelText('Guarantee 2 of: Rest'));
    await user.click(screen.getByLabelText('Guarantee 2 of: Reward'));
    await user.click(screen.getByLabelText('Guarantee 2 of: Event'));
    await user.click(screen.getByRole('button', { name: 'Remove limit 1' }));
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const gen = savedZone().generation;
    // A range of "anywhere" is removed rather than stored as 1..∞.
    expect(gen.depthRanges).toEqual({ rest: { minDepth: 2, maxDepth: 6 } });
    expect(gen.maxConsecutiveSameEnemy).toBeNull();
    expect(gen.required).toEqual([
      { types: ['rest'], min: 1 },
      { types: ['event', 'reward'], min: 1 },
    ]);
    expect(gen.limits).toEqual([]);
  });

  it('edits pools from pickers: add, change the enemy, depths, weight, disable, remove', async () => {
    const user = renderAt(EDITOR);
    const combat = within(await screen.findByTestId('pool-combat'));
    await user.click(combat.getByRole('button', { name: 'Add enemy' }));
    await user.selectOptions(combat.getByLabelText('Combat pool 3 enemy'), 'alley_bruiser');
    await type(user, 'Combat pool 3 weight', '5');
    await type(user, 'Combat pool 3 min depth', '4');
    await type(user, 'Combat pool 3 max depth', '8');
    await type(user, 'Combat pool 1 max depth', '');
    await user.click(combat.getByLabelText('Combat pool 2 enabled'));
    const elite = within(screen.getByTestId('pool-elite'));
    await user.click(elite.getByRole('button', { name: 'Add enemy' }));
    const events = within(screen.getByTestId('pool-event'));
    await user.click(events.getByRole('button', { name: 'Remove Event pool 1' }));
    // Events are offered from the event list, not the enemy list.
    await user.click(events.getByRole('button', { name: 'Add event' }));
    expect(within(events.getByLabelText('Event pool 1 event')).getAllByRole('option')).toHaveLength(
      1,
    );
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const pools = savedZone().pools;
    expect(pools.combat).toHaveLength(3);
    expect(pools.combat[0]).toMatchObject({ id: 'drone', maxDepth: null });
    expect(pools.combat[1]).toMatchObject({ id: 'bruiser', enabled: false });
    expect(pools.combat[2]).toMatchObject({
      enemyKey: 'alley_bruiser',
      weight: 5,
      minDepth: 4,
      maxDepth: 8,
      enabled: true,
    });
    expect(new Set(pools.combat.map((e) => e.id)).size).toBe(3);
    expect(pools.elite).toEqual([
      {
        id: 'scrapyard_drone',
        enemyKey: 'scrapyard_drone',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ]);
    expect(pools.event).toEqual([
      {
        id: 'abandoned_cache',
        eventKey: 'abandoned_cache',
        enabled: true,
        weight: 10,
        minDepth: 1,
        maxDepth: null,
        tags: [],
      },
    ]);
  });

  it('edits depth bands and bonuses, choosing reward tables from the server list', async () => {
    const user = renderAt(EDITOR);
    await user.selectOptions(
      await screen.findByLabelText('Band 1 reward table'),
      'valley-success-v1',
    );
    await type(user, 'Band 1 currency max', '4');
    await user.click(screen.getByRole('button', { name: 'Add depth band' }));
    await type(user, 'Band 2 id', 'boss');
    await type(user, 'Band 2 currency min', '10');
    await type(user, 'Band 2 currency max', '15');
    await user.click(screen.getByLabelText('Band 2 applies to (none ticked = every type): Boss'));
    await user.selectOptions(
      screen.getByLabelText('Band 2 Equipment reward table'),
      'valley-bonus-v1',
    );
    await type(user, 'Completion bonus currency min', '8');
    await type(user, 'Completion bonus currency max', '8');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    const rewards = savedZone().rewards;
    expect(rewards.bands[0]).toMatchObject({
      id: 'early',
      rewardTable: 'valley-success-v1',
      currency: { min: 1, max: 4 },
    });
    expect(rewards.bands[1]).toEqual({
      id: 'boss',
      enabled: true,
      minDepth: 1,
      maxDepth: null,
      nodeTypes: ['boss'],
      rewardTable: null,
      equipmentRewardTable: 'valley-bonus-v1',
      currency: { min: 10, max: 15 },
    });
    expect(rewards.completion.currency).toEqual({ min: 8, max: 8 });
    expect(
      screen.getAllByRole('option', { name: 'valley-bonus-v1 (disabled)' }).length,
    ).toBeGreaterThan(0);
  });

  it('shows server issues where they belong and refuses to save while any is an error', async () => {
    issues = [
      {
        path: 'generation.minNodes',
        message: 'minNodes 12 is above maxNodes 9',
        severity: 'error',
      },
      {
        path: 'pools.combat[1].enemyKey',
        message: '"ghost" is not a known enemy',
        severity: 'error',
      },
      {
        path: 'pools.boss',
        message: 'a boss is required, but the boss pool is empty',
        severity: 'error',
      },
      {
        path: 'rewards.bands[0].rewardTable',
        message: 'reward table "x" is disabled, so it pays nothing',
        severity: 'warning',
      },
      {
        path: 'generation',
        message: '12 of 200 trial runs could not be generated',
        severity: 'error',
      },
    ];
    const user = renderAt(EDITOR);
    await type(user, 'Zone name', 'Changed');
    await waitFor(() =>
      expect(screen.getByTestId('validation-status')).toHaveTextContent(
        '4 problems to fix before saving.',
      ),
    );
    expect(
      within(screen.getByTestId('zone-shape')).getByText('minNodes 12 is above maxNodes 9'),
    ).toBeInTheDocument();
    const entries = within(screen.getByTestId('pool-combat')).getAllByTestId('pool-entry');
    expect(within(entries[1]!).getByText('"ghost" is not a known enemy')).toBeInTheDocument();
    expect(within(entries[0]!).queryByTestId('zone-issues')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('pool-boss')).getByText(/a boss is required/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('reward-band')).getByText(/⚠ reward table "x" is disabled/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('zone-save')).getByText(/trial runs could not be generated/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save zone' })).toBeDisabled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('saves through warnings', async () => {
    issues = [
      { path: 'rewards.currencyKey', message: 'currency is disabled', severity: 'warning' },
    ];
    const user = renderAt(EDITOR);
    await type(user, 'Zone name', 'Changed');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
  });

  it('refuses a stale save, keeps it refused, and reloads the latest version on request', async () => {
    updateSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'DUNGEON_ZONE_STALE',
        message: 'stale',
        details: { currentRevision: 4, updatedBy: '222' },
      }),
    );
    const user = renderAt(EDITOR);
    await type(user, 'Zone name', 'My edit');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));

    const banner = await screen.findByTestId('stale-banner');
    expect(banner).toHaveTextContent('revision 4');
    expect(banner).toHaveTextContent('saved by 222');
    expect(screen.getByRole('button', { name: 'Save zone' })).toBeDisabled();

    vi.mocked(api.getDungeonZone).mockResolvedValue({
      ...DETAIL,
      revision: 4,
      zone: { ...ZONE, name: 'Their edit' },
    });
    await user.click(within(banner).getByRole('button', { name: 'Reload latest version' }));
    await waitFor(() => expect(screen.getByLabelText('Zone name')).toHaveValue('Their edit'));
    expect(screen.queryByTestId('stale-banner')).not.toBeInTheDocument();

    // The next save names the revision that was reloaded.
    await type(user, 'Zone name', 'Merged by hand');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Save zone' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(2));
    expect(updateSpy.mock.calls[1]![2]).toBe(4);
  });

  it('creates a zone under a key that is typed once, and only checks a usable key', async () => {
    const user = renderAt('/admin/dungeons/new');
    expect(await screen.findByTestId('validation-status')).toHaveTextContent(
      'Give the zone a lower_snake_case key',
    );
    expect(screen.getByRole('button', { name: 'Create zone' })).toBeDisabled();
    await type(user, 'Zone key', 'Rust Warrens');
    expect(validateSpy).not.toHaveBeenCalled();

    await type(user, 'Zone key', 'rust_warrens');
    await type(user, 'Zone name', 'Rust Warrens');
    await readyToSave();
    await user.click(screen.getByRole('button', { name: 'Create zone' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0]![0]).toMatchObject({
      key: 'rust_warrens',
      name: 'Rust Warrens',
      enabled: false,
    });
    // Once created, the editor moves to the saved zone, where the key is fixed text.
    await waitFor(() =>
      expect(api.getDungeonZone).toHaveBeenCalledWith('rust_warrens', expect.anything()),
    );
    expect(await screen.findByTestId('zone-key')).toBeInTheDocument();
    expect(screen.queryByLabelText('Zone key')).not.toBeInTheDocument();
  });

  it('previews the unsaved draft without saving it', async () => {
    const user = renderAt(EDITOR);
    await type(user, 'Max nodes', '10');
    await user.click(screen.getByRole('button', { name: 'Preview this draft' }));
    expect(await screen.findByTestId('dungeon-graph')).toBeInTheDocument();
    const target = previewSpy.mock.calls[0]![0] as { zone: DungeonZoneDoc };
    expect(target.zone.generation.maxNodes).toBe(10);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('is read-only without write permission', async () => {
    renderAt(EDITOR, ['dungeons.read']);
    expect(await screen.findByLabelText('Zone name')).toBeDisabled();
    expect(screen.getByLabelText('Combat weight')).toBeDisabled();
    expect(screen.getByLabelText('Combat pool 1 enemy')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save zone' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add enemy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add depth band' })).not.toBeInTheDocument();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
  });
});

describe('generation preview', () => {
  it('generates with a random seed, shows the seed used, and reproduces it', async () => {
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet');
    await user.click(await screen.findByRole('button', { name: 'Generate with a random seed' }));
    await screen.findByTestId('dungeon-graph');
    expect(previewSpy).toHaveBeenLastCalledWith({ key: 'scrapheap_gauntlet' }, undefined);
    // The seed the server drew is now in the field, so the same run can be generated again.
    expect(screen.getByLabelText('Seed')).toHaveValue('777');
    await user.click(screen.getByRole('button', { name: 'Generate this seed' }));
    await waitFor(() =>
      expect(previewSpy).toHaveBeenLastCalledWith({ key: 'scrapheap_gauntlet' }, 777),
    );
  });

  it('generates an explicit seed', async () => {
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet');
    await type(user, 'Seed', '2026');
    await user.click(screen.getByRole('button', { name: 'Generate this seed' }));
    await waitFor(() =>
      expect(previewSpy).toHaveBeenCalledWith({ key: 'scrapheap_gauntlet' }, 2026),
    );
    expect(await screen.findByTestId('dungeon-graph-summary')).toHaveTextContent(
      'Seed 2026 · 5 nodes · depth 4 · 1 branch · 1 extraction point',
    );
  });

  it('shows nodes by depth with type, content, the branch, the boss and extraction', async () => {
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet&seed=5');
    await user.click(await screen.findByRole('button', { name: 'Generate this seed' }));
    const rows = await screen.findAllByTestId('dungeon-depth-row');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Depth 1')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Scrapyard Drone')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/→ n2, n3/)).toBeInTheDocument();
    // Depth 2 is the fork: two nodes, labelled as the two sides.
    expect(within(rows[1]!).getAllByTestId('dungeon-node')).toHaveLength(2);
    expect(within(rows[1]!).getByText('Branch A')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Branch B')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Extraction')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Scrapheap Colossus')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('End of the run')).toBeInTheDocument();
    expect(within(rows[3]!).getByTestId('dungeon-node')).toHaveAttribute('data-node-type', 'boss');
  });

  it('refuses a seed that is not a valid seed', async () => {
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet');
    await type(user, 'Seed', '-4');
    expect(screen.getByText(/A seed is a whole number from 0 to 4294967295/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate this seed' })).toBeDisabled();
  });

  it('shows why the generator gave up', async () => {
    previewSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 422,
        code: 'DUNGEON_GENERATION_FAILED',
        message: 'failed',
        details: { seed: 9, attempts: 64, failures: { 'no eligible boss at final depth 7': 64 } },
      }),
    );
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet&seed=9');
    await user.click(await screen.findByRole('button', { name: 'Generate this seed' }));
    const failure = await screen.findByTestId('generation-failure');
    expect(failure).toHaveTextContent('could not generate a run for seed 9');
    expect(failure).toHaveTextContent('×64 — no eligible boss at final depth 7');
    expect(screen.queryByTestId('dungeon-graph')).not.toBeInTheDocument();
  });

  it('simulates many runs and reports the distribution', async () => {
    const zero = Object.fromEntries(api.DUNGEON_NODE_TYPES.map((t) => [t, 0])) as Record<
      api.DungeonNodeType,
      number
    >;
    const simulateSpy = vi.spyOn(api, 'simulateDungeon').mockResolvedValue({
      zoneKey: 'scrapheap_gauntlet',
      firstSeed: 1,
      runs: 1000,
      valid: 998,
      invalid: 2,
      invalidRate: 0.002,
      failures: { 'no legal node type at depth 3': 2 },
      averageAttempts: 1.03,
      averageNodeCount: 7.51,
      minNodeCount: 6,
      maxNodeCount: 9,
      averageDepth: 7.24,
      nodeTypeCounts: zero,
      nodeTypeShare: { ...zero, combat: 0.416, boss: 0.133 },
      nodeTypeRunRate: { ...zero, combat: 0.99, boss: 1 },
      branchRate: 0.269,
      averageBranches: 0.269,
      bossRate: 1,
      restRate: 1,
      extractionRate: 1,
      averageExtractionPoints: 1.05,
      enemies: [{ key: 'scrapyard_drone', nodes: 2865, runs: 892, runRate: 0.892 }],
      events: [],
    });
    const user = renderAt('/admin/dungeons/preview?zone=scrapheap_gauntlet');
    await user.click(await screen.findByRole('button', { name: 'Simulate 1,000 runs' }));
    const report = within(await screen.findByTestId('simulation-report'));
    expect(simulateSpy).toHaveBeenCalledWith({ key: 'scrapheap_gauntlet' }, 1000);
    expect(report.getByText('2 (0.2%)')).toBeInTheDocument();
    expect(report.getByText('7.51 (6–9)')).toBeInTheDocument();
    expect(report.getByText('26.9%')).toBeInTheDocument();
    expect(report.getByTestId('simulation-failures')).toHaveTextContent(
      '×2 — no legal node type at depth 3',
    );
    expect(
      within(report.getByTestId('simulation-node-types')).getByText('41.6%'),
    ).toBeInTheDocument();
    expect(report.getByText('scrapyard_drone')).toBeInTheDocument();
    expect(report.getByText('89.2%')).toBeInTheDocument();
  });
});
