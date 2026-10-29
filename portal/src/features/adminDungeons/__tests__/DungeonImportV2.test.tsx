import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { fixture, install, renderAt } from './dungeonFixtures';
const hash = `sha256:${'a'.repeat(64)}`;
const rewrittenHash = `sha256:${'b'.repeat(64)}`;
const body = (amount: number) => ({
  guaranteed: [
    {
      id: 'coins',
      grant: {
        type: 'currency' as const,
        currency: 'waifubux' as const,
        amount: { min: amount, max: amount },
      },
    },
  ],
  chances: [],
  pools: [],
});
const pkg = { format: 'waifumon-dungeon-package', schemaVersion: 2, dungeon: fixture().draft };
const table = (
  decision: api.DungeonLootImportDecision | null = null,
): api.DungeonLootImportTablePlan => ({
  key: 'coin_hoard',
  name: 'Coin hoard',
  status: 'different',
  currentRevision: 2,
  currentHash: 'destination',
  incomingHash: 'source',
  currentName: 'Local coins',
  archived: false,
  incomingBody: body(7),
  currentBody: body(99),
  decision,
  targetKey: decision?.action === 'copy' ? decision.key : 'coin_hoard',
  suggestedCopyKey: 'coin_hoard_imported',
});
function planOf(
  decision: api.DungeonLootImportDecision | null = null,
  patch: Partial<api.DungeonImportPlan> = {},
): api.DungeonImportPlan {
  return {
    validPackage: true,
    packageId: 'source-package',
    packageHash: hash,
    sourceEnvironment: 'staging',
    dungeonKey: 'tunnels',
    contentHash: hash,
    planHash: decision ? rewrittenHash : hash,
    target: { status: 'new', expectedRevision: null, currentContentHash: null, changedFields: [], enabled: null, publishedRevision: null },
    enemies: [],
    lootTables: [table(decision)],
    equipmentChanges: [],
    resultingContentHash: decision?.action === 'copy' ? rewrittenHash : hash,
    issues: decision
      ? decision.action === 'use_existing'
        ? [
            {
              code: 'loot_table_rewards_differ',
              severity: 'warning',
              path: 'lootTables.coin_hoard',
              message: 'Destination rewards differ.',
            },
          ]
        : []
      : [
          {
            code: 'loot_table_decision_required',
            severity: 'error',
            path: 'lootTables.coin_hoard',
            message: 'Choose copy or destination rewards.',
          },
        ],
    publishable: decision !== null,
    ...patch,
  };
}
const receipt: api.DungeonImportResult = {
  importId: 1,
  dungeonKey: 'tunnels',
  result: 'created',
  draftRevision: 1,
  createdEnemies: [],
  createdLootTables: ['coin_hoard_imported'],
  reusedLootTables: [],
  contentHash: rewrittenHash,
  issues: [],
  publishable: true,
  replayed: false,
};
beforeEach(() => {
  install();
  vi.spyOn(api, 'planDungeonImport').mockImplementation(async (_pkg, _signal, choices) =>
    planOf(choices?.coin_hoard ?? null),
  );
  vi.spyOn(api, 'applyDungeonImport').mockResolvedValue(receipt);
});
async function open() {
  const user = userEvent.setup();
  renderAt('/admin/dungeons');
  await user.click(screen.getByRole('button', { name: 'Import Dungeon' }));
  await user.upload(
    screen.getByLabelText('Dungeon package file'),
    new File([JSON.stringify(pkg)], 'v2.json', { type: 'application/json' }),
  );
  await screen.findByText('Source environment: staging');
  return user;
}
const apply = () => screen.getByRole('button', { name: 'Apply import as draft' });
async function chooseCopy(user: ReturnType<typeof userEvent.setup>, key = 'coin_hoard_imported') {
  await user.selectOptions(screen.getByLabelText('Decision for loot table Coin hoard'), 'copy');
  const input = screen.getByLabelText('New key for Coin hoard');
  if (key !== 'coin_hoard_imported') {
    await user.clear(input);
    await user.type(input, key);
  }
  await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
  await waitFor(() => expect(screen.queryByText(/Loot choices need/)).not.toBeInTheDocument());
}
describe('v2 dungeon import review', () => {
  it('shows both reward lists and requires reviewed copy choices before submitting their exact key', async () => {
    const user = await open();
    expect(screen.getByText('Guaranteed: 7 WaifuBux')).toBeInTheDocument();
    expect(screen.getByText('Guaranteed: 99 WaifuBux')).toBeInTheDocument();
    expect(apply()).toBeDisabled();
    await chooseCopy(user, 'my_coin_copy');
    expect(api.planDungeonImport).toHaveBeenLastCalledWith(pkg, undefined, {
      coin_hoard: { action: 'copy', key: 'my_coin_copy' },
    });
    expect(screen.getByText(/Copying loot tables changes/)).toBeInTheDocument();
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(apply());
    await screen.findByText(/Import successful/);
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPlanHash: rewrittenHash,
        decisions: {
          dungeon: 'create',
          enemies: {},
          lootTables: { coin_hoard: { action: 'copy', key: 'my_coin_copy' } },
          allowMissingDependencies: false,
        },
      }),
    );
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });
  it('shows server defaults for a portable key that matches an object prototype property', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf(
        { action: 'create' },
        {
          lootTables: [{ ...table({ action: 'create' }), key: 'constructor', status: 'missing' }],
          issues: [],
        },
      ),
    );
    const user = await open();
    expect(screen.getByLabelText('Decision for loot table Coin hoard')).toHaveValue('create');
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeEnabled();
  });
  it('use-existing explains reward changes and requires warning acknowledgement after preview', async () => {
    const user = await open();
    await user.selectOptions(
      screen.getByLabelText('Decision for loot table Coin hoard'),
      'use_existing',
    );
    expect(
      screen.getByText(/Using destination rewards can give different amounts/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
    await screen.findByText(/Warning: Destination rewards differ/);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText(/Acknowledge all reported warnings/));
    await user.click(apply());
    await screen.findByText(/Import successful/);
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.objectContaining({
          lootTables: { coin_hoard: { action: 'use_existing' } },
        }),
      }),
    );
  });
  it('editing an already-reviewed copy key invalidates approval and requires another preview', async () => {
    const user = await open();
    await chooseCopy(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeEnabled();
    await user.type(screen.getByLabelText('New key for Coin hoard'), '_changed');
    expect(apply()).toBeDisabled();
    expect(screen.getByLabelText('Approve create dungeon draft')).not.toBeChecked();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
    await waitFor(() => expect(api.planDungeonImport).toHaveBeenCalledTimes(3));
    expect(apply()).toBeDisabled();
  });
  it('preserves copy choices after stale rejection, re-previews them, and requires fresh approval', async () => {
    vi.mocked(api.applyDungeonImport).mockRejectedValueOnce(
      new PortalApiError({
        status: 409,
        code: 'DUNGEON_IMPORT_STALE',
        message: 'Loot table changed.',
      }),
    );
    const user = await open();
    await chooseCopy(user, 'preserved_copy');
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(apply());
    await screen.findByText('Import conflict — review again');
    expect(screen.queryByRole('button', { name: 'Apply import as draft' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review a new plan' }));
    await waitFor(() => expect(api.planDungeonImport).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText('New key for Coin hoard')).toHaveValue('preserved_copy');
    expect(apply()).toBeDisabled();
    expect(api.planDungeonImport).toHaveBeenLastCalledWith(pkg, undefined, {
      coin_hoard: { action: 'copy', key: 'preserved_copy' },
    });
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(apply());
    await screen.findByText(/Import successful/);
  });
  it('shows missing items and named equipment differences while permitting only an accepted incomplete draft', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(
      planOf(
        { action: 'create' },
        {
          lootTables: [{ ...table({ action: 'create' }), status: 'missing' }],
          publishable: false,
          issues: [
            {
              code: 'reward_item_capped',
              severity: 'error',
              path: 'rewards.item',
              message: 'Fragile prize is capped.',
            },
            {
              code: 'reward_equipment_empty',
              severity: 'error',
              path: 'rewards.gear',
              message: 'No eligible gear.',
            },
          ],
          equipmentChanges: [
            {
              selectorKey: 'selector',
              description: 'R Attack gear',
              sourceCandidates: [{ key: 'sword', name: 'Source sword' }],
              targetCandidates: [],
              added: [],
              removed: [{ key: 'sword', name: 'Source sword' }],
            },
          ],
        },
      ),
    );
    const user = await open();
    expect(screen.getByText('Source pieces: Source sword')).toBeInTheDocument();
    expect(screen.getByText('Destination pieces: None')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText(/Accept permitted missing dependencies/));
    expect(apply()).toBeEnabled();
    await user.click(apply());
    await screen.findByText(/Import successful/);
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.objectContaining({ allowMissingDependencies: true }),
      }),
    );
  });
  it('keeps invalid copy decisions editable after a failed preview', async () => {
    const user = await open();
    await user.selectOptions(screen.getByLabelText('Decision for loot table Coin hoard'), 'copy');
    vi.mocked(api.planDungeonImport).mockRejectedValueOnce(
      new PortalApiError({
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Copy key is invalid.',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
    await screen.findByText(/Copy key is invalid/);
    expect(screen.getByLabelText('New key for Coin hoard')).toBeEnabled();
    expect(apply()).toBeDisabled();
    await user.type(screen.getByLabelText('New key for Coin hoard'), '_valid');
    await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
    await waitFor(() => expect(screen.queryByText(/Loot choices need/)).not.toBeInTheDocument());
  });
  it('blocks an old plan after failed stale re-preview even if choices have not changed', async () => {
    vi.mocked(api.applyDungeonImport).mockRejectedValueOnce(
      new PortalApiError({ status: 409, code: 'DUNGEON_IMPORT_STALE', message: 'Table changed.' }),
    );
    const user = await open();
    await chooseCopy(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(apply());
    await screen.findByText('Import conflict — review again');
    vi.mocked(api.planDungeonImport).mockRejectedValueOnce(new Error('Preview network lost'));
    await user.click(screen.getByRole('button', { name: 'Review a new plan' }));
    await screen.findByText(/Preview network lost/);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Preview loot choices' }));
    await waitFor(() => expect(screen.queryByText(/Loot choices need/)).not.toBeInTheDocument());
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeEnabled();
  });
  it('uncertain retries freeze the same copy key, plan and request identifier', async () => {
    vi.mocked(api.applyDungeonImport)
      .mockRejectedValueOnce(new Error('Network lost'))
      .mockResolvedValueOnce({ ...receipt, replayed: true });
    const user = await open();
    await chooseCopy(user);
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(apply());
    await screen.findByText('Import outcome uncertain');
    expect(screen.getByLabelText('New key for Coin hoard')).toBeDisabled();
    const first = vi.mocked(api.applyDungeonImport).mock.calls[0]![0];
    await user.click(screen.getByRole('button', { name: 'Retry same import' }));
    await screen.findByText(/Original receipt confirmed/);
    expect(vi.mocked(api.applyDungeonImport).mock.calls[1]![0]).toEqual(first);
  });
});
