import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { fixture, install, renderAt } from './dungeonFixtures';
const hash = `sha256:${'a'.repeat(64)}`;
const pkg = { format: 'waifumon-dungeon-package', schemaVersion: 3, dungeon: fixture().draft };
const planOf = (status: 'available' | 'missing' | 'disabled'): api.DungeonImportPlan => ({
  validPackage: true,
  packageId: 'source-package',
  packageHash: hash,
  sourceEnvironment: 'staging',
  dungeonKey: 'tunnels',
  contentHash: hash,
  planHash: hash,
  target: { status: 'new', expectedRevision: null, currentContentHash: null, changedFields: [] },
  enemies: [],
  lootTables: [],
  equipmentChanges: [],
  rewardSource: { origin: 'revision', snapshotHash: null, resolverVersion: null },
  eventDependencies: {
    eventCount: 3,
    poolCount: 2,
    requiredItems: [{ key: 'vault_key', name: 'Vault Key', status }],
  },
  issues:
    status === 'available'
      ? []
      : [
          {
            code: `event_item_${status}`,
            severity: 'error',
            path: 'dependencies.requiredItems.vault_key',
            message: `Required Vault Key is ${status}.`,
          },
        ],
  publishable: status === 'available',
});
beforeEach(() => {
  install();
  vi.spyOn(api, 'planDungeonImport').mockResolvedValue(planOf('available'));
  vi.spyOn(api, 'applyDungeonImport').mockResolvedValue({
    importId: 1,
    dungeonKey: 'tunnels',
    result: 'created',
    draftRevision: 1,
    createdEnemies: [],
    createdLootTables: [],
    reusedLootTables: [],
    sourceSchemaVersion: 3,
    rewardSnapshotHash: null,
    issues: [],
    publishable: true,
    replayed: false,
  });
});
async function open() {
  const user = userEvent.setup();
  renderAt('/admin/dungeons');
  await user.click(screen.getByRole('button', { name: 'Import Dungeon' }));
  await user.upload(
    screen.getByLabelText('Dungeon package file'),
    new File([JSON.stringify(pkg)], 'events.json', { type: 'application/json' }),
  );
  await screen.findByText('Source environment: staging');
  return user;
}
const apply = () => screen.getByRole('button', { name: 'Apply import as draft' });
describe('v3 event import review', () => {
  it('shows named required items and event counts for reward-free v3 imports, with explicit draft approval', async () => {
    const user = await open();
    expect(screen.getByText('Vault Key: Available here')).toBeInTheDocument();
    expect(
      screen.getByText(/This import creates a disabled, unpublished draft/),
    ).toBeInTheDocument();
    expect(screen.getByText('No reusable loot tables in this package.')).toBeInTheDocument();
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeEnabled();
    await user.click(apply());
    await screen.findByText(/Import successful/);
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        package: pkg,
        decisions: {
          dungeon: 'create',
          enemies: {},
          lootTables: {},
          allowMissingDependencies: false,
        },
      }),
    );
    expect(api.publishDungeon).not.toHaveBeenCalled();
  });
  it.each(['missing', 'disabled'] as const)(
    'shows %s required items and requires explicit incomplete acceptance',
    async (status) => {
      vi.mocked(api.planDungeonImport).mockResolvedValue(planOf(status));
      const user = await open();
      expect(
        screen.getByText(
          status === 'missing'
            ? 'Vault Key: Missing here — repair before publication'
            : 'Vault Key: Disabled here — enable before publication',
        ),
      ).toBeInTheDocument();
      await user.click(screen.getByLabelText('Approve create dungeon draft'));
      expect(apply()).toBeDisabled();
      await user.click(screen.getByLabelText(/Accept permitted missing dependencies/));
      expect(apply()).toBeEnabled();
      expect(
        screen.getByText(/Publication blocker accepted for incomplete draft/),
      ).toBeInTheDocument();
      await user.click(apply());
      await screen.findByText(/Import successful/);
      expect(api.applyDungeonImport).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: expect.objectContaining({ allowMissingDependencies: true }),
        }),
      );
    },
  );
  it('discloses disabling and clearing current publication for a v3 replacement even without loot', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue({
      ...planOf('available'),
      target: {
        status: 'different',
        expectedRevision: 3,
        currentContentHash: hash,
        changedFields: ['publication', 'enabled'],
      },
    });
    await open();
    expect(
      screen.getByText(/This import also disables the dungeon and clears its current publication/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Approve replace dungeon draft')).toBeInTheDocument();
  });
  it('never allows incomplete acceptance to bypass invalid event package validation', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue({
      ...planOf('missing'),
      validPackage: false,
      planHash: null,
      target: null,
      issues: [
        {
          code: 'event_missing',
          severity: 'error',
          path: 'dungeon.events',
          message: 'Invalid event reference.',
        },
      ],
    });
    await open();
    expect(apply()).toBeDisabled();
    expect(screen.getByText(/Invalid package — import blocked/)).toBeInTheDocument();
    expect(api.applyDungeonImport).not.toHaveBeenCalled();
  });
});
