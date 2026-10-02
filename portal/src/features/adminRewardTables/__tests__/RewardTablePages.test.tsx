/**
 * Reward table authoring: the list (origin, references, export, import), and
 * the editor — group cards, item and gear rows, the shared Equipment selector
 * with its live preview, server issues shown on the row they name, saving
 * with the loaded revision, and the stale-save refusal.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

import * as api from '@/api/adminRewardTables';
import type { RewardTableDetail, RewardTableIssue, RewardTableSummary } from '@/api/adminRewardTables';
import { PortalApiError } from '@/api/client';
import { SessionContext } from '@/auth/SessionContext';
import type { SessionState } from '@/auth/types';

import { RewardTableEditorPage } from '../RewardTableEditorPage';
import { RewardTablesListPage } from '../RewardTablesListPage';

const REFERENCE: api.RewardTableReferenceData = {
  items: [
    { slug: 'basic_charm', name: 'Basic Charm', category: 'capture' },
    { slug: 'silk_charm', name: 'Silk Charm', category: 'capture' },
  ],
  equipmentDefinitions: [
    { key: 'combat_knife', name: 'Combat Knife', slot: 'attack', rarity: 'R', enabled: true },
    { key: 'semi_auto_sidearm', name: 'Semi-Auto Sidearm', slot: 'attack', rarity: 'R', enabled: true },
    { key: 'kevlar_carrier', name: 'Kevlar Carrier', slot: 'defense', rarity: 'R', enabled: true },
  ],
};

const SUMMARY: RewardTableSummary = {
  kind: 'boss',
  id: 'standard-scouting-v1',
  enabled: true,
  version: null,
  revision: 3,
  origin: 'edited',
  matchesShipped: false,
  groupCount: 2,
  itemRowCount: 2,
  equipmentRowCount: 1,
  references: [{ role: 'boss', key: 'b1', name: 'Mistress Vex', enabled: true }],
  updatedAt: '2026-10-01T12:00:00.000Z',
  updatedBy: '111',
};

const DETAIL: RewardTableDetail = {
  ...SUMMARY,
  issues: [],
  table: {
    id: 'standard-scouting-v1',
    enabled: true,
    buddyXp: 70,
    groups: [
      {
        id: 'standard-item',
        enabled: true,
        rolls: 1,
        chanceBasisPoints: 10_000,
        entries: [
          { itemId: 'basic_charm', enabled: true, weight: 3, quantity: 2 },
          { itemId: 'silk_charm', enabled: true, weight: 1, quantity: 1 },
        ],
      },
      {
        id: 'rare-gear',
        enabled: true,
        rolls: 1,
        chanceBasisPoints: 800,
        entries: [],
        equipment: [{ slot: 'attack', rarity: 'R', enabled: true, weight: 1 }],
      },
    ],
  },
};

let issues: RewardTableIssue[];
let updateSpy: MockInstance<typeof api.updateRewardTable>;
let previewSpy: MockInstance<typeof api.previewEquipmentSelectors>;
let getSpy: MockInstance<typeof api.getRewardTable>;

beforeEach(() => {
  issues = [];
  vi.spyOn(api, 'getRewardTableReference').mockResolvedValue(REFERENCE);
  vi.spyOn(api, 'listRewardTables').mockImplementation(async (kind) => ({
    tables:
      kind === 'expedition'
        ? [{ ...SUMMARY, kind: 'expedition', id: 'scavenge-v1', origin: 'shipped', matchesShipped: true, references: [] }]
        : [SUMMARY],
  }));
  getSpy = vi.spyOn(api, 'getRewardTable').mockResolvedValue(DETAIL);
  vi.spyOn(api, 'validateRewardTable').mockImplementation(async () => ({ issues }));
  previewSpy = vi.spyOn(api, 'previewEquipmentSelectors').mockImplementation(async (selectors) => ({
    previews: selectors.map((s) => {
      const sel = s as { slot?: string; rarity?: string };
      const eligible = REFERENCE.equipmentDefinitions
        .filter((d) => (!sel.slot || d.slot === sel.slot) && (!sel.rarity || d.rarity === sel.rarity))
        .map(({ key, name, slot, rarity }) => ({ key, name, slot, rarity }));
      return { eligible, issues: [] };
    }),
  }));
  updateSpy = vi.spyOn(api, 'updateRewardTable').mockImplementation(async (_k, _id, table, rev) => ({
    ...DETAIL,
    table,
    revision: rev + 1,
  }));
});
afterEach(() => vi.restoreAllMocks());

function renderAt(path: string, permissions = ['rewards.read', 'rewards.write']) {
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
      <Route path="/admin/reward-tables" element={<RewardTablesListPage />} />
      <Route path="/admin/reward-tables/:kind/new" element={<RewardTableEditorPage />} />
      <Route path="/admin/reward-tables/:kind/:id" element={<RewardTableEditorPage />} />
    </Routes>,
    { wrapper: Wrapper },
  );
  return user;
}

const EDITOR = '/admin/reward-tables/boss/standard-scouting-v1';

describe('reward table list', () => {
  it('shows each table with its origin, counts and what pays from it', async () => {
    renderAt('/admin/reward-tables');
    const [row] = await screen.findAllByTestId('reward-table-row');
    expect(row).toHaveTextContent('standard-scouting-v1');
    expect(row).toHaveTextContent('Edited — differs from Git');
    expect(row).toHaveTextContent('2 groups · 2 item rows · 1 gear row');
    expect(row).toHaveTextContent('Paid by Mistress Vex');
  });

  it('switches to expedition tables', async () => {
    const user = renderAt('/admin/reward-tables');
    await screen.findAllByTestId('reward-table-row');
    await user.click(screen.getByRole('tab', { name: 'Expedition' }));
    expect(await screen.findByText('scavenge-v1')).toBeInTheDocument();
    expect(api.listRewardTables).toHaveBeenCalledWith('expedition', expect.anything());
  });

  it('plans an uploaded file and applies it with the revisions the plan saw', async () => {
    vi.spyOn(api, 'planRewardTableImport').mockResolvedValue({
      kind: 'boss',
      entries: [
        { id: 'standard-scouting-v1', action: 'update', currentRevision: 3, issues: [] },
        { id: 'new-one', action: 'create', currentRevision: null, issues: [] },
      ],
      issues: [],
      canApply: true,
    });
    const applySpy = vi
      .spyOn(api, 'applyRewardTableImport')
      .mockResolvedValue({ created: ['new-one'], updated: ['standard-scouting-v1'], unchanged: [] });
    const user = renderAt('/admin/reward-tables');
    const tables = [{ id: 'standard-scouting-v1' }, { id: 'new-one' }];
    const file = new File([JSON.stringify(tables)], 'bossRewards.json', { type: 'application/json' });
    // jsdom's File has no `.text()` in some versions; provide it deterministically.
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(tables) });
    await user.upload(screen.getByLabelText('Import file'), file);
    const plan = await screen.findByTestId('import-plan');
    expect(plan).toHaveTextContent('Changed standard-scouting-v1');
    expect(plan).toHaveTextContent('New new-one');
    await user.click(within(plan).getByRole('button', { name: 'Apply 2 changes' }));
    await waitFor(() =>
      expect(applySpy).toHaveBeenCalledWith('boss', tables, { 'standard-scouting-v1': 3, 'new-one': null }),
    );
    expect(await screen.findByTestId('import-applied')).toHaveTextContent('1 created, 1 updated');
  });
});

describe('reward table editor', () => {
  it('renders groups, chance as a percentage, each row’s share and the group summary', async () => {
    renderAt(EDITOR);
    const groups = await screen.findAllByTestId('reward-group');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]!).getAllByTestId('row-share').map((s) => s.textContent)).toEqual(['75%', '25%']);
    expect(within(groups[1]!).getByLabelText('Chance percent')).toHaveValue(8);
    await waitFor(() =>
      expect(within(groups[1]!).getByTestId('group-summary')).toHaveTextContent(
        'Chance 8% · Rolls 1 · 0 item rows · 1 gear row · 2 candidates',
      ),
    );
    // Saved group ids key deterministic draws: shown, not editable.
    expect(within(groups[0]!).queryByLabelText('Group id')).toBeNull();
  });

  it('edits gear with the shared selector and previews what it can pay — no multiplier or affix controls', async () => {
    const user = renderAt(EDITOR);
    const [, gearGroup] = await screen.findAllByTestId('reward-group');
    const row = within(gearGroup!).getByTestId('equipment-reward-row');
    await waitFor(() =>
      expect(within(row).getByTestId('equipment-preview')).toHaveTextContent(
        'R Attack · 2 eligible: Combat Knife, Semi-Auto Sidearm',
      ),
    );
    await user.selectOptions(within(row).getByLabelText('Equipment slot'), 'defense');
    await waitFor(() =>
      expect(within(row).getByTestId('equipment-preview')).toHaveTextContent('1 eligible: Kevlar Carrier'),
    );
    expect(previewSpy).toHaveBeenLastCalledWith([{ slot: 'defense', rarity: 'R' }], expect.anything());
    for (const label of [/multiplier/i, /affix/i, /pool/i, /basis/i]) {
      expect(within(row).queryByLabelText(label)).toBeNull();
    }
  });

  it('adds an equipment row and a group', async () => {
    const user = renderAt(EDITOR);
    const [first] = await screen.findAllByTestId('reward-group');
    await user.click(within(first!).getByRole('button', { name: 'Add equipment row' }));
    expect(within(first!).getAllByTestId('equipment-reward-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add group' }));
    const groups = screen.getAllByTestId('reward-group');
    expect(groups).toHaveLength(3);
    // A group added this session can still be named.
    expect(within(groups[2]!).getByLabelText('Group id')).toHaveValue('group-3');
  });

  it('shows server issues on the row they name and blocks saving', async () => {
    issues = [
      {
        path: 'groups[1].equipment[0].definitionKeys[0]',
        message: '"combat_knife" is disabled and cannot be acquired',
        severity: 'error',
      },
    ];
    const user = renderAt(EDITOR);
    const [, gearGroup] = await screen.findAllByTestId('reward-group');
    await user.clear(screen.getByLabelText('Buddy XP'));
    await user.type(screen.getByLabelText('Buddy XP'), '80');
    const row = within(gearGroup!).getByTestId('equipment-reward-row');
    expect(await within(row).findByTestId('row-issues')).toHaveTextContent('is disabled and cannot be acquired');
    await waitFor(() => expect(screen.getByTestId('validation-status')).toHaveTextContent('1 problem to fix'));
    expect(screen.getByRole('button', { name: 'Save table' })).toBeDisabled();
  });

  it('saves with the revision it loaded, sending the table document', async () => {
    const user = renderAt(EDITOR);
    await screen.findAllByTestId('reward-group');
    await user.clear(screen.getByLabelText('Buddy XP'));
    await user.type(screen.getByLabelText('Buddy XP'), '90');
    const save = screen.getByRole('button', { name: 'Save table' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    const [kind, id, table, revision] = updateSpy.mock.calls[0]!;
    expect([kind, id, revision]).toEqual(['boss', 'standard-scouting-v1', 3]);
    expect(table).toEqual({ ...DETAIL.table, buddyXp: 90 });
    await waitFor(() => expect(screen.getByTestId('table-sidebar')).toHaveTextContent('Revision 4'));
  });

  it('refuses a stale save, says so, and reloads the latest version on request', async () => {
    updateSpy.mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'REWARD_TABLE_STALE',
        message: 'This reward table was changed by someone else since you opened it.',
        details: { expectedRevision: 3, currentRevision: 4, updatedBy: '222' },
      }),
    );
    const user = renderAt(EDITOR);
    await screen.findAllByTestId('reward-group');
    await user.clear(screen.getByLabelText('Buddy XP'));
    await user.type(screen.getByLabelText('Buddy XP'), '90');
    const save = screen.getByRole('button', { name: 'Save table' });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const banner = await screen.findByTestId('stale-banner');
    expect(banner).toHaveTextContent('revision 4 (saved by 222)');
    expect(save).toBeDisabled();

    getSpy.mockResolvedValue({ ...DETAIL, revision: 4, table: { ...DETAIL.table, buddyXp: 55 } });
    await user.click(within(banner).getByRole('button', { name: 'Reload latest version' }));
    await waitFor(() => expect(screen.queryByTestId('stale-banner')).toBeNull());
    expect(screen.getByLabelText('Buddy XP')).toHaveValue(55);
  });

  it('offers reset for an edited shipped table but never delete for a referenced one', async () => {
    renderAt(EDITOR);
    const sidebar = await screen.findByTestId('table-sidebar');
    expect(within(sidebar).getByRole('button', { name: 'Reset to shipped version' })).toBeEnabled();
    expect(within(sidebar).getByRole('button', { name: 'Delete table' })).toBeDisabled();
    expect(sidebar).toHaveTextContent('Content pays from this table — disable it instead.');
    expect(within(sidebar).getByTestId('table-references')).toHaveTextContent('Mistress Vex · Boss');
  });

  it('is read-only without rewards.write', async () => {
    renderAt(EDITOR, ['rewards.read']);
    await screen.findAllByTestId('reward-group');
    expect(screen.getByLabelText('Buddy XP')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save table' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add group' })).toBeNull();
    expect(screen.getByText('You do not have write permission.')).toBeInTheDocument();
  });
});
