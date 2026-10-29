import { useState } from 'react';
import { DungeonSpeciesPoolsPanel } from '@/features/adminDungeons/DungeonSpeciesPoolsPanel';
import { starterDungeon } from '@/features/adminDungeons/dungeonModel';
import { beforeEach, expect, it, vi } from 'vitest';
import { Navigate, Route, Routes } from 'react-router';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeonSpeciesPools';
import * as dungeon from '@/api/adminDungeons';
import { PortalApiError } from '@/api/client';
import { renderWith } from '@/features/adminDungeons/__tests__/dungeonFixtures';
import { SharedPoolsPage } from '../SharedPoolsPage';
import { SharedPoolPicker } from '../SharedPoolPicker';
const pool: api.SharedPool = {
  revision: 3,
  definition: {
    key: 'shared',
    name: 'Shared Test Pool',
    description: 'Across dungeons',
    enabled: true,
    entries: [{ id: 'e', species: 'exclusive', weight: 3, oncePerRun: true }],
  },
};
beforeEach(() => {
  vi.spyOn(api, 'listSharedPools').mockResolvedValue([structuredClone(pool)]);
  vi.spyOn(api, 'getSharedPool').mockResolvedValue(structuredClone(pool));
  vi.spyOn(api, 'sharedPoolReferences').mockResolvedValue([
    { dungeonKey: 'tunnels', name: 'Tunnels', source: 'published', poolId: 'p' },
  ]);
  vi.spyOn(api, 'createSharedPool').mockImplementation(async (definition) => ({
    definition,
    revision: 1,
  }));
  vi.spyOn(api, 'saveSharedPool').mockImplementation(async (definition, expectedRevision) => ({
    definition,
    revision: expectedRevision + 1,
  }));
  vi.spyOn(api, 'importSharedPools').mockResolvedValue([]);
  vi.spyOn(api, 'duplicateSharedPool').mockResolvedValue({
    ...pool,
    definition: { ...pool.definition, key: 'copy', enabled: false },
  });
  vi.spyOn(dungeon, 'getDungeonSpecies').mockResolvedValue({
    species: [
      {
        slug: 'exclusive',
        name: 'Unassigned Exclusive',
        race: 'angel',
        affinity: 'switch',
        rarity: 'N',
        enabled: true,
        regionExclusive: false,
        dungeonExclusive: true,
        dungeonAccess: [],
        dungeonPolicyAllowed: true,
        permitted: false,
        unavailableReason: 'not_permitted',
        perPlayerLimit: null,
        directRescue: { available: false, reason: 'not_permitted' },
      },
    ],
  });
  vi.spyOn(dungeon, 'dungeonSpeciesArtworkBlob').mockResolvedValue(new Blob());
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
function renderPage(key?: string, permissions = ['dungeons.read', 'dungeons.write']) {
  return renderWith(
    <Routes>
      <Route
        path="/"
        element={
          key ? <Navigate to={`/admin/dungeons/waifumon-pools/${key}`} /> : <SharedPoolsPage />
        }
      />
      <Route path="/admin/dungeons/waifumon-pools" element={<SharedPoolsPage />} />
      <Route path="/admin/dungeons/waifumon-pools/:key" element={<SharedPoolsPage />} />
    </Routes>,
    permissions,
  );
}
it('lists and searches shared pools, with read-only permission hiding authoring controls', async () => {
  const user = userEvent.setup();
  renderPage(undefined, ['dungeons.read']);
  expect(await screen.findByRole('link', { name: pool.definition.name })).toHaveAttribute(
    'href',
    '/admin/dungeons/waifumon-pools/shared',
  );
  expect(screen.queryByRole('button', { name: 'Create pool' })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Search pools'), 'none');
  expect(screen.queryByRole('link', { name: pool.definition.name })).not.toBeInTheDocument();
});
it('creates a disabled pool using the existing species picker, including unassigned dungeon exclusives', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Create pool' }));
  await user.type(screen.getByLabelText('Pool key'), 'new_shared');
  await user.type(screen.getByLabelText('Pool name'), 'New Shared');
  await user.click(screen.getByRole('button', { name: 'Add species' }));
  await user.click(await screen.findByRole('button', { name: 'Add species Unassigned Exclusive' }));
  fireEvent.change(screen.getByLabelText('Entry 1 weight'), { target: { value: '7' } });
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.createSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'new_shared',
        enabled: false,
        entries: [expect.objectContaining({ species: 'exclusive', weight: 7 })],
      }),
    ),
  );
});
it('edits with the loaded revision, shows usage and surfaces stale errors without retrying', async () => {
  vi.mocked(api.saveSharedPool).mockRejectedValue(
    new PortalApiError({
      status: 409,
      code: 'DUNGEON_DRAFT_STALE',
      message: 'This pool changed. Reload before saving.',
    }),
  );
  const user = userEvent.setup();
  renderPage('shared');
  expect(await screen.findByLabelText('Pool name')).toHaveValue(pool.definition.name);
  expect(await screen.findByRole('link', { name: 'Tunnels' })).toHaveAttribute(
    'href',
    '/admin/dungeons/definitions/tunnels',
  );
  fireEvent.change(screen.getByLabelText('Entry 1 weight'), { target: { value: '8' } });
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.saveSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [expect.objectContaining({ weight: 8 })] }),
      3,
    ),
  );
  expect(await screen.findByText('This pool changed. Reload before saving.')).toBeVisible();
  expect(api.saveSharedPool).toHaveBeenCalledTimes(1);
});
it('reviews imported keys against destination revisions before applying JSON', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('link', { name: pool.definition.name });
  const pkg: api.SharedPoolPackage = {
    format: 'waifumon-dungeon-species-pools',
    schemaVersion: 1,
    pools: [pool.definition, { ...pool.definition, key: 'new_import' }],
  };
  fireEvent.change(screen.getByLabelText('Pool JSON'), { target: { value: JSON.stringify(pkg) } });
  await user.click(screen.getByRole('button', { name: 'Review import' }));
  const apply = await screen.findByRole('button', { name: 'Apply reviewed import' });
  expect(api.importSharedPools).not.toHaveBeenCalled();
  await user.click(apply);
  await waitFor(() =>
    expect(api.importSharedPools).toHaveBeenCalledWith(pkg, { shared: 3, new_import: null }),
  );
});
it('searches shared-pool choices and prevents selecting disabled dependencies', async () => {
  vi.mocked(api.listSharedPools).mockResolvedValue([
    pool,
    {
      ...pool,
      definition: { ...pool.definition, key: 'off', name: 'Disabled pool', enabled: false },
    },
  ]);
  const onSelect = vi.fn(),
    user = userEvent.setup();
  renderWith(<SharedPoolPicker disabled={false} onSelect={onSelect} />);
  expect(
    await screen.findByRole('button', { name: 'Use shared pool Disabled pool' }),
  ).toBeDisabled();
  await user.type(screen.getByLabelText('Search shared pools'), 'shared');
  expect(
    screen.queryByRole('button', { name: 'Use shared pool Disabled pool' }),
  ).not.toBeInTheDocument();
  await user.click(
    within(screen.getByRole('region', { name: 'Shared WaifuMon pool picker' })).getByRole(
      'button',
      { name: 'Use shared pool Shared Test Pool' },
    ),
  );
  expect(onSelect).toHaveBeenCalledWith('shared', pool.definition.name);
});

it('adds a shared reference to a dungeon without embedding or converting existing pools', async () => {
  const changed = vi.fn();
  function Panel() {
    const [definition, setDefinition] = useState({
      ...starterDungeon('tunnels', 'Tunnels', ['waifu-valley']),
      speciesPools: [
        {
          id: 'local',
          name: 'Existing',
          entries: [{ id: 'e', weight: 2, species: 'exclusive', oncePerRun: true }],
        },
      ],
    });
    return (
      <DungeonSpeciesPoolsPanel
        definition={definition}
        disabled={false}
        onChange={(d) => {
          changed(d);
          setDefinition(d as typeof definition);
        }}
      />
    );
  }
  const user = userEvent.setup();
  renderWith(<Panel />);
  await user.click(screen.getByRole('button', { name: 'Reference shared pool' }));
  await user.click(await screen.findByRole('button', { name: 'Use shared pool Shared Test Pool' }));
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({
      speciesPools: [
        expect.objectContaining({ id: 'local', entries: [expect.objectContaining({ weight: 2 })] }),
        expect.objectContaining({ sharedPoolKey: 'shared', entries: [] }),
      ],
    }),
  );
  expect(screen.getByText('Shared · shared')).toBeInTheDocument();
});
