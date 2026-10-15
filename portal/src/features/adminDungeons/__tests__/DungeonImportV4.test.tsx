import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { fixture, install, renderAt } from './dungeonFixtures';
const hash = `sha256:${'a'.repeat(64)}`;
const pkg = { format: 'waifumon-dungeon-package', schemaVersion: 4, dungeon: fixture().draft };
const planOf = (restricted = false): api.DungeonImportPlan => ({
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
  encounterDependencies: {
    encounterCount: 2,
    poolCount: 1,
    requiredSpecies: [
      {
        slug: 'dungeon_waifu',
        name: 'Dungeon Waifu',
        status: restricted ? 'restricted' : 'available',
        modes: ['capture', 'direct'],
        sourceRarity: 'R',
        targetRarity: 'N',
        changes: ['Rarity: R → N'],
        perPlayerLimit: 2,
        directRescue: true,
      },
    ],
    captureItems: [
      {
        key: 'basic_charm',
        name: 'Basic Charm',
        status: restricted ? 'missing' : 'available',
        rarities: ['N'],
        guaranteed: false,
      },
    ],
  },
  eventDependencies: {
    eventCount: 1,
    poolCount: 0,
    requiredItems: [{ key: 'vault_key', name: 'Vault Key', status: 'available' }],
  },
  issues: [
    {
      code: 'package_species_rarity_changed',
      severity: 'warning',
      path: 'dependencies.requiredSpecies',
      message: 'Rarity differs here.',
    },
    ...(restricted
      ? [
          {
            code: 'species_not_permitted',
            severity: 'error' as const,
            path: 'dependencies.requiredSpecies',
            message: 'Species requires destination authorization.',
          },
          {
            code: 'capture_item_missing',
            severity: 'error' as const,
            path: 'dependencies.captureItems',
            message: 'Capture item requires repair.',
          },
        ]
      : []),
  ],
  publishable: !restricted,
});
beforeEach(() => {
  install();
  vi.spyOn(api, 'planDungeonImport').mockResolvedValue(planOf());
  vi.spyOn(api, 'applyDungeonImport').mockResolvedValue({
    importId: 1,
    dungeonKey: 'tunnels',
    result: 'created',
    draftRevision: 1,
    createdEnemies: [],
    createdLootTables: [],
    reusedLootTables: [],
    sourceSchemaVersion: 4,
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
    new File([JSON.stringify(pkg)], 'encounters.json', { type: 'application/json' }),
  );
  await screen.findByText('Source environment: staging');
  return user;
}
const apply = () => screen.getByRole('button', { name: 'Apply import as draft' });
describe('v4 encounter import review', () => {
  it('shows species, drift, finite direct limits and separate capture/Event items', async () => {
    const user = await open();
    expect(screen.getByText(/Dungeon Waifu \(dungeon_waifu\): Available here/)).toBeInTheDocument();
    expect(screen.getByText('Rarity: R → N')).toBeInTheDocument();
    expect(screen.getByText(/Direct rescue: authorized; per-player limit: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Basic Charm \(basic_charm\): Available here/)).toBeInTheDocument();
    expect(screen.getByText('Vault Key: Available here')).toBeInTheDocument();
    expect(
      screen.getByText(/Species, capture items and central access policies are never imported/),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    expect(apply()).toBeDisabled();
    await user.click(screen.getByLabelText(/Acknowledge all reported warnings/));
    expect(apply()).toBeEnabled();
    await user.click(apply());
    await screen.findByText(/Import successful/);
    expect(api.publishDungeon).not.toHaveBeenCalled();
    expect(api.applyDungeonImport).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.objectContaining({ allowMissingDependencies: false }),
      }),
    );
  });
  it('requires explicit repair acceptance for restricted species and missing charms', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue(planOf(true));
    const user = await open();
    expect(screen.getByText(/restricted — repair before publication/)).toBeInTheDocument();
    expect(screen.getByText(/Basic Charm \(basic_charm\): missing/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Approve create dungeon draft'));
    await user.click(screen.getByLabelText(/Acknowledge all reported warnings/));
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
  it('never bypasses integrity failure with incomplete acceptance', async () => {
    vi.mocked(api.planDungeonImport).mockResolvedValue({
      ...planOf(true),
      validPackage: false,
      planHash: null,
      target: null,
      issues: [
        {
          code: 'package_integrity_mismatch',
          severity: 'error',
          path: 'integrityHash',
          message: 'Package integrity failed.',
        },
      ],
    });
    await open();
    expect(apply()).toBeDisabled();
    expect(screen.getByText(/Invalid package — import blocked/)).toBeInTheDocument();
    expect(api.applyDungeonImport).not.toHaveBeenCalled();
  });
});
