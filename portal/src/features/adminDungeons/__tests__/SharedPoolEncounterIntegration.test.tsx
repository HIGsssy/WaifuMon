import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import * as sharedApi from '@/api/adminDungeonSpeciesPools';
import { EncounterActivity } from '../EncounterActivity';
import { EventEditorContext } from '../eventEditorContext';
import { incompleteSpeciesIssues, selectSharedEncounterPool } from '../dungeonSpeciesModel';
import { fixture, install, renderAt, renderWith } from './dungeonFixtures';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());

const shared: sharedApi.SharedPool = {
  revision: 4,
  definition: {
    key: 'shared_angels',
    name: 'Shared Angels',
    description: 'Reusable',
    enabled: true,
    entries: [
      { id: 'one', species: 'angel', weight: 5, oncePerRun: true },
      { id: 'none', nothing: true, weight: 1 },
    ],
  },
};
const exclusive: api.DungeonSpeciesRef = {
  slug: 'angel',
  name: 'Exclusive Angel',
  rarity: 'N',
  race: 'angel',
  affinity: 'switch',
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: true,
  dungeonAccess: [],
  permitted: false,
  unavailableReason: 'not_permitted',
  dungeonPolicyAllowed: true,
  perPlayerLimit: null,
  directRescue: { available: false, reason: 'not_permitted' },
};
let world: ReturnType<typeof install>;
const opened = vi.fn();
function definition(): api.DungeonDefinition {
  const d = fixture().draft;
  d.speciesPools = [
    { id: 'local', name: 'Local Angels', entries: [{ id: 'one', species: 'angel', weight: 9 }] },
  ];
  d.speciesPolicies = [{ species: 'elsewhere', perPlayerLimit: 2 }];
  d.rooms[0]!.actions = ['first', 'second'].map((id) => ({
    id,
    type: 'wild_encounter',
    source: { kind: 'pool', poolId: '' },
    intro: 'Hello.',
    capture: { maxAttempts: 3, allowGuaranteedItems: true },
  }));
  return d;
}
beforeEach(() => {
  world = install();
  stubObjectUrls();
  opened.mockClear();
  vi.spyOn(sharedApi, 'listSharedPools').mockResolvedValue([structuredClone(shared)]);
  vi.spyOn(api, 'getDungeonSpecies').mockResolvedValue({ species: [exclusive] });
  vi.spyOn(api, 'dungeonSpeciesArtworkBlob').mockResolvedValue(new Blob());
});
function Harness({
  initial = definition(),
  disabled = false,
}: {
  initial?: api.DungeonDefinition;
  disabled?: boolean;
}) {
  const [d, setD] = useState(initial);
  return (
    <EventEditorContext.Provider value={{ open: opened, play: () => {} }}>
      {d.rooms[0]!.actions.map((action) => (
        <div key={action.id} data-testid={action.id}>
          <EncounterActivity
            action={action}
            room={d.rooms[0]!}
            definition={d}
            disabled={disabled}
            onDefinitionChange={setD}
            onChange={(next) =>
              setD((current) => ({
                ...current,
                rooms: current.rooms.map((room, n) =>
                  n
                    ? room
                    : { ...room, actions: room.actions.map((a) => (a.id === next.id ? next : a)) },
                ),
              }))
            }
          />
        </div>
      ))}
      <output data-testid="definition">{JSON.stringify(d)}</output>
    </EventEditorContext.Provider>
  );
}
const current = (): api.DungeonDefinition =>
  JSON.parse(screen.getByTestId('definition').textContent!);
const encounter = (id = 'first') => within(screen.getByTestId(id));
async function chooseShared(user: ReturnType<typeof userEvent.setup>, id = 'first') {
  await screen.findAllByRole('option', { name: /Shared Angels · Shared · Enabled · 1 species/ });
  await user.selectOptions(encounter(id).getByLabelText('WaifuMon pool'), 'shared:shared_angels');
}

it('selects a shared pool directly, atomically attaches its reference and preserves local pools and policy', async () => {
  const initial = definition(),
    user = userEvent.setup();
  renderWith(<Harness initial={initial} />);
  await chooseShared(user);
  const next = current(),
    reference = next.speciesPools![1]!;
  expect(reference).toMatchObject({
    name: 'Shared Angels',
    sharedPoolKey: 'shared_angels',
    entries: [],
  });
  expect(reference.id).toMatch(/^sp_[a-f0-9]{32}$/);
  expect(next.rooms[0]!.actions[0]!).toEqual({
    ...initial.rooms[0]!.actions[0],
    source: { kind: 'pool', poolId: reference.id },
  });
  expect(next.speciesPools![0]).toEqual(initial.speciesPools![0]);
  expect(next.speciesPolicies).toEqual(initial.speciesPolicies);
  expect(initial.speciesPools).toHaveLength(1);
});

it('reuses an attached reference and shares it across multiple encounters', async () => {
  const initial = definition();
  initial.speciesPools!.push({
    id: 'stable_reference',
    name: 'Old label',
    sharedPoolKey: 'shared_angels',
    entries: [],
  });
  const user = userEvent.setup();
  renderWith(<Harness initial={initial} />);
  await chooseShared(user);
  await chooseShared(user, 'second');
  await chooseShared(user);
  expect(current().speciesPools).toEqual(initial.speciesPools);
  expect(current().rooms[0]!.actions.map((a) => a.source)).toEqual([
    { kind: 'pool', poolId: 'stable_reference' },
    { kind: 'pool', poolId: 'stable_reference' },
  ]);
});

it('searches local/shared choices and selects existing dungeon-local pools', async () => {
  const user = userEvent.setup();
  renderWith(<Harness />);
  await screen.findAllByRole('option', { name: /Shared Angels · Shared/ });
  await user.type(encounter().getByLabelText('Search WaifuMon pools'), 'Local');
  expect(
    encounter().getByRole('option', { name: /Local Angels · Dungeon-local · 1 species/ }),
  ).toBeEnabled();
  expect(encounter().queryByRole('option', { name: /Shared Angels/ })).not.toBeInTheDocument();
  await user.selectOptions(encounter().getByLabelText('WaifuMon pool'), 'local');
  expect(current().rooms[0]!.actions[0]!.source).toEqual({ kind: 'pool', poolId: 'local' });
  expect(current().speciesPools).toHaveLength(1);
});

it.each(['disabled', 'missing'] as const)(
  'warns about an existing %s shared pool, preserving its ID and refusing new selection',
  async (status) => {
    vi.mocked(sharedApi.listSharedPools).mockResolvedValue(
      status === 'missing'
        ? []
        : [{ ...shared, definition: { ...shared.definition, enabled: false } }],
    );
    const initial = definition();
    initial.speciesPools!.push({
      id: 'stable',
      name: 'Shared Angels',
      sharedPoolKey: 'shared_angels',
      entries: [],
    });
    initial.rooms[0]!.actions[0]!.source = { kind: 'pool', poolId: 'stable' };
    const user = userEvent.setup();
    renderWith(<Harness initial={initial} />);
    expect(await encounter().findByRole('alert')).toHaveTextContent(
      status === 'missing' ? 'is missing' : 'is disabled',
    );
    expect(encounter().getByLabelText('WaifuMon pool')).toHaveValue('shared:shared_angels');
    if (status === 'disabled') {
      expect(
        encounter('second').getByRole('option', { name: /Shared Angels · Shared · Disabled/ }),
      ).toBeDisabled();
      await user.selectOptions(
        encounter('second').getByLabelText('WaifuMon pool'),
        'shared:shared_angels',
      );
    }
    expect(current()).toEqual(initial);
  },
);

it('keeps an unavailable catalogue distinct from a missing pool and permits local selection', async () => {
  vi.mocked(sharedApi.listSharedPools).mockRejectedValue(new Error('offline'));
  const user = userEvent.setup();
  renderWith(<Harness />);
  expect(await encounter().findByText(/Shared pools could not be loaded/)).toBeVisible();
  expect(encounter().queryByText(/is missing/)).not.toBeInTheDocument();
  await user.selectOptions(encounter().getByLabelText('WaifuMon pool'), 'local');
  expect(current().rooms[0]!.actions[0]!.source).toEqual({ kind: 'pool', poolId: 'local' });
});

it('shows existing Species access feedback without adding or loosening policies', async () => {
  const user = userEvent.setup();
  renderWith(<Harness />);
  await chooseShared(user);
  expect(encounter().getByRole('note')).toHaveTextContent(
    'Review Species access for: Exclusive Angel',
  );
  await user.click(encounter().getByRole('button', { name: 'Species access…' }));
  expect(opened).toHaveBeenCalledWith({ kind: 'speciesAccess', id: '' });
  expect(current().speciesPolicies).toEqual(definition().speciesPolicies);
});

it('preserves current legacy duplicate reference identities and reuses references at the pool limit', () => {
  const d = definition();
  d.speciesPools = Array.from({ length: 30 }, (_, i) => ({
    id: `ref_${i}`,
    name: 'Reference',
    sharedPoolKey: i < 2 ? 'shared_angels' : `other_${i}`,
    entries: [],
  }));
  d.rooms[0]!.actions[0]!.source = { kind: 'pool', poolId: 'ref_1' };
  const next = selectSharedEncounterPool(d, d.rooms[0]!.id, 'first', shared.definition);
  expect(next.rooms[0]!.actions[0]!.source).toEqual({ kind: 'pool', poolId: 'ref_1' });
  expect(next.speciesPools).toEqual(d.speciesPools);
  expect(
    selectSharedEncounterPool(d, d.rooms[0]!.id, 'first', { ...shared.definition, key: 'new' }),
  ).toBe(d);
});

it('uses the real editor draft save/reopen path with stable IDs and existing backend validation feedback', async () => {
  const stored = fixture();
  stored.draft.speciesPools = definition().speciesPools!;
  stored.draft.speciesPolicies = definition().speciesPolicies!;
  world.stored = stored;
  const user = userEvent.setup(),
    view = renderAt();
  await screen.findByRole('heading', { name: 'Tunnels', level: 1 });
  await user.click(screen.getByRole('button', { name: 'Select room Entrance' }));
  await user.click(screen.getByRole('button', { name: 'Add Wild Encounter' }));
  await user.selectOptions(screen.getByLabelText('Encounter source'), 'pool');
  await screen.findByRole('option', { name: /Shared Angels · Shared · Enabled/ });
  await user.selectOptions(screen.getByLabelText('WaifuMon pool'), 'shared:shared_angels');
  await user.type(screen.getByLabelText('Encounter introduction'), 'At the door.');
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
  const saved = structuredClone(world.stored.draft),
    reference = saved.speciesPools!.find((p) => p.sharedPoolKey === 'shared_angels')!;
  expect(saved.rooms[0]!.actions[0]!.source).toEqual({ kind: 'pool', poolId: reference.id });
  expect(saved.speciesPolicies).toEqual(stored.draft.speciesPolicies);
  // The existing API validation issue remains visible after reloading a saved draft.
  const issue: api.DungeonIssue = {
    code: 'species_not_permitted',
    severity: 'error',
    path: 'rooms[0].actions[0].source',
    message: 'Exclusive Angel needs Species access.',
  };
  world.stored = { ...world.stored, issues: [issue] };
  view.unmount();
  renderAt();
  await screen.findByRole('heading', { name: 'Tunnels', level: 1 });
  await user.click(screen.getByRole('button', { name: 'Select room Entrance' }));
  const activity = screen.getByRole('button', { name: /Activity 1: Wild Encounter/ });
  if (activity.getAttribute('aria-expanded') !== 'true') await user.click(activity);
  expect(await screen.findByLabelText('WaifuMon pool')).toHaveValue('shared:shared_angels');
  expect(
    world.stored.draft.speciesPools!.find((p) => p.sharedPoolKey === 'shared_angels')!.id,
  ).toBe(reference.id);
  expect(screen.getAllByText(/Exclusive Angel needs Species access/).length).toBeGreaterThan(0);
});

it('accepts empty shared reference entries in save preflight while rejecting local emptiness, invalid keys and shared fallbacks', () => {
  const d = definition();
  d.speciesPools = [{ id: 'ref', name: 'Shared', sharedPoolKey: 'shared_angels', entries: [] }];
  expect(incompleteSpeciesIssues(d, 'editor_incomplete')).toEqual([]);
  d.speciesPools[0]!.sharedPoolKey = 'Bad-Key';
  expect(incompleteSpeciesIssues(d, 'editor_incomplete')).toEqual([expect.objectContaining({ path: 'speciesPools[0].sharedPoolKey' })]);
  d.speciesPools[0]!.sharedPoolKey = 'shared_angels';
  d.speciesPools[0]!.entries = [{ id: 'fallback', species: 'angel', weight: 1 }];
  expect(incompleteSpeciesIssues(d, 'editor_incomplete')).toEqual([expect.objectContaining({ path: 'speciesPools[0].entries' })]);
  delete d.speciesPools[0]!.sharedPoolKey;
  d.speciesPools[0]!.entries = [];
  expect(incompleteSpeciesIssues(d, 'editor_incomplete')).toEqual([expect.objectContaining({ path: 'speciesPools[0].entries' })]);
});
