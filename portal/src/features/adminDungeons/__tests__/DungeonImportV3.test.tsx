import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
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
  target: { status: 'new', expectedRevision: null, currentContentHash: null, changedFields: [], enabled: null, publishedRevision: null },
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
      screen.getByText(/Creates a new draft that is disabled and unpublished/),
    ).toBeInTheDocument();
    expect(screen.getByText(/This import changes only the draft/)).toBeInTheDocument();
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
  it('states that a replacement keeps the live revision and enabled state of a published dungeon', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue({
      ...planOf('available'),
      target: {
        status: 'different',
        expectedRevision: 3,
        currentContentHash: hash,
        changedFields: ['rooms'],
        enabled: true,
        publishedRevision: 2,
      },
    });
    await open();
    expect(screen.getByText('Current state: Enabled · Published revision 2')).toBeInTheDocument();
    const notes = within(screen.getByRole('list', { name: 'Publication after import' }));
    expect(notes.getByText(/Revision 2 is published and stays live/)).toBeInTheDocument();
    expect(
      notes.getByText(/New runs keep starting on revision 2 until you publish the imported draft/),
    ).toBeInTheDocument();
    expect(notes.getByText(/separate action that revalidates it here/)).toBeInTheDocument();
    expect(screen.queryByText(/disables the dungeon|clears its current publication/)).toBeNull();
    expect(screen.getByLabelText('Approve replace dungeon draft')).toBeInTheDocument();
  });
  it('keeps a disabled, unpublished target that way and flags an incomplete draft as unpublishable', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue({
      ...planOf('missing'),
      target: {
        status: 'different',
        expectedRevision: 3,
        currentContentHash: hash,
        changedFields: ['rooms'],
        enabled: false,
        publishedRevision: null,
      },
    });
    await open();
    expect(screen.getByText('Current state: Disabled · Unpublished')).toBeInTheDocument();
    const notes = within(screen.getByRole('list', { name: 'Publication after import' }));
    expect(notes.getByText(/not published and stays unpublished/)).toBeInTheDocument();
    expect(notes.getByText(/stays disabled\. Import does not enable it/)).toBeInTheDocument();
    expect(notes.getByText(/cannot be published until its reported problems are repaired/)).toBeInTheDocument();
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
