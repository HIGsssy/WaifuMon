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
        regions: [],
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
  await user.type(screen.getByLabelText('Pool name'), 'New Shared');
  await user.click(screen.getByRole('button', { name: 'Add WaifuMon' }));
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
  await user.click(screen.getByText('Advanced / Import–Export'));
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

it('generates an identifier from the name and offers an available collision alternative', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('link', { name: pool.definition.name });
  await user.click(screen.getByRole('button', { name: 'Create pool' }));
  expect(screen.getByLabelText('Pool name')).toHaveFocus();
  expect(screen.getByLabelText('Pool key')).not.toBeVisible();
  await user.type(screen.getByLabelText('Pool name'), 'Shared');
  expect(screen.getByTestId('pool-key-preview')).toHaveTextContent('shared_2');
  expect(screen.getByText(/Suggested available identifier: shared_2/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Add WaifuMon' }));
  await user.click(await screen.findByRole('button', { name: 'Add species Unassigned Exclusive' }));
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.createSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'shared_2', name: 'Shared' }),
    ),
  );
});

it('allows Advanced manual editing before creation and retains it across name changes', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Create pool' }));
  await user.type(screen.getByLabelText('Pool name'), 'First Name');
  await user.click(screen.getByText('Advanced identifier'));
  await user.clear(screen.getByLabelText('Pool key'));
  await user.type(screen.getByLabelText('Pool key'), 'manual_identity');
  await user.clear(screen.getByLabelText('Pool name'));
  await user.type(screen.getByLabelText('Pool name'), 'Final Name');
  expect(screen.getByTestId('pool-key-preview')).toHaveTextContent('manual_identity');
  await user.click(screen.getByRole('button', { name: 'Add WaifuMon' }));
  await user.click(await screen.findByRole('button', { name: 'Add species Unassigned Exclusive' }));
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.createSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'manual_identity', name: 'Final Name' }),
    ),
  );
});

it('validates manual identifiers and lets the author return to automatic generation', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole('button', { name: 'Create pool' }));
  await user.type(screen.getByLabelText('Pool name'), 'Shared');
  await user.click(screen.getByText('Advanced identifier'));
  fireEvent.change(screen.getByLabelText('Pool key'), { target: { value: 'Bad-Key' } });
  expect(screen.getByText(/Use lowercase letters/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  expect(api.createSharedPool).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Pool key'), { target: { value: 'shared' } });
  expect(screen.getAllByText(/This identifier is already used/).length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: 'Use automatic identifier' }));
  expect(screen.getByLabelText('Pool key')).toHaveValue('shared_2');
});

it('rechecks collisions at creation and requires review instead of silently creating under a changed key', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('link', { name: pool.definition.name });
  await user.click(screen.getByRole('button', { name: 'Create pool' }));
  await user.type(screen.getByLabelText('Pool name'), 'New Pool');
  await user.click(screen.getByRole('button', { name: 'Add WaifuMon' }));
  await user.click(await screen.findByRole('button', { name: 'Add species Unassigned Exclusive' }));
  vi.mocked(api.listSharedPools).mockResolvedValue([
    pool,
    { ...pool, definition: { ...pool.definition, key: 'new_pool' } },
  ]);
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  expect(
    await screen.findByText(
      'This identifier was just taken. Review the available identifier and save again.',
    ),
  ).toBeVisible();
  expect(api.createSharedPool).not.toHaveBeenCalled();
  expect(screen.getByTestId('pool-key-preview')).toHaveTextContent('new_pool_2');
});

it('never changes an existing identifier when renaming and shows saved/unsaved state', async () => {
  const user = userEvent.setup();
  renderPage('shared');
  await screen.findByLabelText('Pool name');
  expect(screen.getByText('All changes saved')).toBeVisible();
  expect(screen.queryByLabelText('Pool key')).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText('Pool name'));
  await user.type(screen.getByLabelText('Pool name'), 'Renamed pool');
  expect(screen.getByTestId('pool-key-preview')).toHaveTextContent('shared');
  expect(screen.getByText('Unsaved changes')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Disable pool' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.saveSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'shared', name: 'Renamed pool' }),
      3,
    ),
  );
  expect(await screen.findByText('All changes saved')).toBeVisible();
});

it('keeps JSON tools collapsed, permits read-only export and never exposes import to a reader', async () => {
  vi.spyOn(api, 'exportSharedPools').mockResolvedValue({
    format: 'waifumon-dungeon-species-pools',
    schemaVersion: 1,
    pools: [pool.definition],
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const user = userEvent.setup();
  renderPage(undefined, ['dungeons.read']);
  expect(screen.getByText('Export all JSON')).not.toBeVisible();
  await user.click(screen.getByText('Advanced / Import–Export'));
  expect(screen.getByRole('button', { name: 'Export all JSON' })).toBeVisible();
  expect(screen.queryByLabelText('Pool JSON')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Export all JSON' }));
  await waitFor(() => expect(api.exportSharedPools).toHaveBeenCalledWith());
});

it('keeps selection search open, permits removal, and preserves Nothing, once-per-run and conditions', async () => {
  const user = userEvent.setup();
  renderPage('shared');
  await screen.findByLabelText('Pool name');
  await user.click(screen.getByRole('button', { name: 'Add WaifuMon' }));
  await user.type(screen.getByLabelText('Search species'), 'Unassigned');
  await user.click(screen.getByRole('button', { name: 'Remove species Unassigned Exclusive' }));
  await user.click(screen.getByRole('button', { name: 'Add species Unassigned Exclusive' }));
  expect(screen.getByLabelText('Search species')).toHaveValue('Unassigned');
  expect(
    screen.queryByRole('button', { name: 'Add species Unassigned Exclusive' }),
  ).not.toBeInTheDocument();
  const selected = within(screen.getByRole('region', { name: 'Selected WaifuMon and weights' }));
  expect(selected.getAllByRole('listitem')).toHaveLength(1);
  await user.click(screen.getByLabelText('Entry 1 once per run'));
  fireEvent.change(screen.getByLabelText('Entry 1 weight'), { target: { value: '8' } });
  await user.click(screen.getByText('Advanced condition (optional)'));
  fireEvent.change(screen.getByLabelText('Entry 1 condition JSON'), {
    target: { value: '{"type":"room_completed","roomId":"hall"}' },
  });
  await user.click(screen.getByRole('button', { name: 'Add Nothing outcome' }));
  await user.type(screen.getByLabelText('Nothing text'), 'Quiet.');
  fireEvent.change(screen.getByLabelText('Entry 2 weight'), { target: { value: '2' } });
  await user.click(screen.getByRole('button', { name: 'Save pool' }));
  await waitFor(() =>
    expect(api.saveSharedPool).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            species: 'exclusive',
            oncePerRun: false,
            weight: 8,
            when: { type: 'room_completed', roomId: 'hall' },
          }),
          expect.objectContaining({ nothing: true, text: 'Quiet.', weight: 2 }),
        ],
      }),
      3,
    ),
  );
});
