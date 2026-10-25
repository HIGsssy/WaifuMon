import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PortalApiError } from '@/api/client';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { fixture, install, renderAt } from './dungeonFixtures';
vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
const normal: api.DungeonSpeciesRef = {
  slug: 'android',
  name: 'Test Android',
  rarity: 'SR',
  race: 'android',
  affinity: 'switch',
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: false,
  permitted: true,
  unavailableReason: null,
  dungeonPolicyAllowed: true,
  dungeonAccess: [{ dungeon: 'tunnels', perPlayerLimit: 2, directRescue: true }],
  perPlayerLimit: 2,
  directRescue: { available: true, reason: null },
};
const catalogue: api.DungeonSpeciesRef[] = [
  normal,
  {
    ...normal,
    slug: 'restricted',
    name: 'Restricted Angel',
    race: 'angel',
    rarity: 'UR',
    regionExclusive: true,
    permitted: false,
    unavailableReason: 'not_permitted',
    dungeonPolicyAllowed: false,
    perPlayerLimit: null,
    dungeonAccess: [],
    directRescue: { available: false, reason: 'direct_not_permitted' },
  },
  {
    ...normal,
    slug: 'disabled',
    name: 'Disabled Demon',
    race: 'demon',
    enabled: false,
    permitted: false,
    unavailableReason: 'disabled',
    dungeonPolicyAllowed: false,
    dungeonExclusive: true,
  },
  {
    // A catalogue dungeon-exclusive with no dungeon named in her content.
    ...normal,
    slug: 'valkyrie',
    name: 'Forgotten Valkyrie',
    race: 'angel',
    dungeonExclusive: true,
    permitted: false,
    unavailableReason: 'not_permitted',
    dungeonPolicyAllowed: true,
    dungeonAccess: [],
    perPlayerLimit: null,
    directRescue: { available: false, reason: 'not_permitted' },
  },
];
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  stubObjectUrls();
  vi.spyOn(api, 'getDungeonSpecies').mockResolvedValue({ species: catalogue });
  vi.spyOn(api, 'dungeonSpeciesArtworkBlob').mockResolvedValue(
    new Blob(['image'], { type: 'image/png' }),
  );
});
const panel = () => within(screen.getByTestId('dungeon-species-pools'));
const sheet = () => within(screen.getByTestId('species-pool-editor'));
const ready = async () => {
  const user = userEvent.setup();
  renderAt();
  await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
  return user;
};
async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.click(panel().getByRole('button', { name: '+ New WaifuMon pool' }));
  await screen.findByTestId('species-pool-editor');
}
function seed() {
  const stored = fixture();
  stored.draft.flags = [{ key: 'open', scope: 'run', description: 'Vault opened' }];
  stored.draft.speciesPools = [
    {
      id: 'pool',
      name: 'Wild',
      entries: [
        { id: 'android', species: 'android', weight: 3 },
        { id: 'none', nothing: true, weight: 1 },
      ],
    },
  ];
  world.stored = stored;
}
describe('WaifuMon pool authoring', () => {
  it('creates, renames, adds entries, edits rules/weights/Nothing, saves and reloads stable identities', async () => {
    const user = await ready();
    await create(user);
    await user.click(screen.getByRole('button', { name: 'Close WaifuMon pool' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool New WaifuMon pool' }));
    const name = sheet().getByLabelText('WaifuMon pool name');
    await user.clear(name);
    await user.type(name, 'Wild androids');
    await user.click(sheet().getByRole('button', { name: '+ Add species' }));
    await user.click(await sheet().findByRole('button', { name: 'Add species Test Android' }));
    fireEvent.change(sheet().getByLabelText('Entry 1 weight'), { target: { value: '7' } });
    await user.click(sheet().getByLabelText('Entry 1: once per run'));
    await user.selectOptions(
      sheet().getByLabelText('Entry 1 is in the draw type'),
      'room_completed',
    );
    await user.click(sheet().getByRole('button', { name: '+ Add Nothing' }));
    await user.type(sheet().getByLabelText('Entry 2 nothing text'), 'Quiet.');
    await user.click(screen.getByRole('button', { name: 'Close WaifuMon pool' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!;
    expect(saved.speciesPools![0]).toMatchObject({
      name: 'Wild androids',
      entries: [
        {
          species: 'android',
          weight: 7,
          oncePerRun: false,
          when: { type: 'room_completed', roomId: 'entrance' },
        },
        { nothing: true, text: 'Quiet.' },
      ],
    });
    expect(saved.speciesPools![0]!.id).toMatch(/^sp_[a-f0-9]{32}$/);
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool Wild androids' }));
    expect(sheet().getByLabelText('Entry 1 weight')).toHaveValue(7);
    expect(world.stored.draft.speciesPools).toEqual(saved.speciesPools);
    expect(saved).not.toHaveProperty('eventPools');
  });
  it('searches and filters metadata, shows policy and blocks restricted, disabled and duplicate additions', async () => {
    const user = await ready();
    await create(user);
    await user.click(sheet().getByRole('button', { name: '+ Add species' }));
    await sheet().findByRole('button', { name: 'Add species Test Android' });
    expect(sheet().getByRole('button', { name: 'Add species Restricted Angel' })).toBeDisabled();
    expect(sheet().getByRole('button', { name: 'Add species Disabled Demon' })).toBeDisabled();
    expect(sheet().getByTestId('species-option-restricted')).toHaveTextContent('Region-exclusive');
    expect(sheet().getByTestId('species-option-disabled')).toHaveTextContent('Dungeon-exclusive');
    expect(sheet().getByTestId('species-option-android')).toHaveTextContent(
      'Maximum acquisitions per player from this dungeon: 2 — across all runs.',
    );
    await user.type(sheet().getByLabelText('Search species'), 'Angel');
    expect(
      sheet().queryByRole('button', { name: 'Add species Test Android' }),
    ).not.toBeInTheDocument();
    await user.clear(sheet().getByLabelText('Search species'));
    await user.selectOptions(sheet().getByLabelText('Filter species by race'), 'android');
    await user.selectOptions(sheet().getByLabelText('Filter species by rarity'), 'SR');
    await user.selectOptions(sheet().getByLabelText('Filter species by affinity'), 'switch');
    await user.selectOptions(sheet().getByLabelText('Filter species by availability'), 'permitted');
    expect(
      sheet().queryByRole('button', { name: 'Add species Restricted Angel' }),
    ).not.toBeInTheDocument();
    await user.click(sheet().getByRole('button', { name: 'Add species Test Android' }));
    await user.click(sheet().getByRole('button', { name: '+ Add species' }));
    expect(sheet().getByRole('button', { name: 'Add species Test Android' })).toBeDisabled();
  });
  it('adds a dungeon-exclusive species with no content access and configures her Species access', async () => {
    const user = await ready();
    await create(user);
    await user.click(sheet().getByRole('button', { name: '+ Add species' }));
    const add = await sheet().findByRole('button', { name: 'Add species Forgotten Valkyrie' });
    expect(add).toBeEnabled();
    expect(add).toHaveTextContent('Add to pool and set access');
    expect(sheet().getByTestId('species-option-valkyrie')).toHaveTextContent(
      'Needs Species access in this dungeon before it can be offered',
    );
    await user.click(add);
    expect(sheet().getByTestId('species-pool-entry')).toHaveTextContent('Needs Species access in this dungeon');
    await user.click(sheet().getByRole('button', { name: 'Entry 1: Species access' }));
    const access = within(await screen.findByTestId('species-access-editor'));
    await user.click(access.getByRole('button', { name: 'Add Species access for Forgotten Valkyrie' }));
    expect(access.getByTestId('species-access-row')).toHaveTextContent('Permitted by this dungeon’s Species access');
    expect(access.getByLabelText('Forgotten Valkyrie: maximum acquisitions per player')).toHaveValue(1);
    fireEvent.change(access.getByLabelText('Forgotten Valkyrie: maximum acquisitions per player'), { target: { value: '3' } });
    // Unlimited capture turns Direct Rescue off and keeps it off.
    await user.click(access.getByLabelText('Forgotten Valkyrie: allow Direct Rescue'));
    await user.click(access.getByLabelText('Forgotten Valkyrie: unlimited captures'));
    expect(access.getByLabelText('Forgotten Valkyrie: allow Direct Rescue')).toBeDisabled();
    expect(access.getByLabelText('Forgotten Valkyrie: allow Direct Rescue')).not.toBeChecked();
    await user.click(access.getByLabelText('Forgotten Valkyrie: limited acquisitions'));
    fireEvent.change(access.getByLabelText('Forgotten Valkyrie: maximum acquisitions per player'), { target: { value: '2' } });
    await user.click(access.getByLabelText('Forgotten Valkyrie: allow Direct Rescue'));
    expect(access.getByTestId('species-access-row')).toHaveTextContent('Direct Rescue: allowed, with a finite limit');
    await user.click(screen.getByRole('button', { name: 'Close Species access' }));
    expect(panel().getByTestId('species-access-summary')).toHaveTextContent('1 species with this dungeon’s own terms');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!;
    expect(saved.speciesPolicies).toEqual([{ species: 'valkyrie', perPlayerLimit: 2, directRescue: true }]);
    expect(saved.speciesPools![0]!.entries).toEqual([expect.objectContaining({ species: 'valkyrie', weight: 1, oncePerRun: true })]);
  });
  it('removing Species access drops the entry and leaves pools untouched', async () => {
    seed();
    world.stored.draft.speciesPolicies = [{ species: 'android', perPlayerLimit: 1 }];
    const user = await ready();
    await user.click(panel().getByRole('button', { name: 'Edit Species access' }));
    const access = within(await screen.findByTestId('species-access-editor'));
    await user.click(access.getByRole('button', { name: 'Remove Species access for Test Android' }));
    expect(access.getByRole('button', { name: 'Add Species access for Test Android' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close Species access' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!;
    expect(saved).not.toHaveProperty('speciesPolicies');
    expect(saved.speciesPools).toEqual(world.stored.draft.speciesPools);
  });
  it('duplicates independently, lists references and refuses deletion while used', async () => {
    seed();
    world.stored.draft.rooms[0]!.actions.push({
      id: 'wild',
      type: 'wild_encounter',
      source: { kind: 'pool', poolId: 'pool' },
    });
    const user = await ready();
    expect(panel().getByText(/Entrance — Wild Encounter/)).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Delete WaifuMon pool Wild' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Entrance — Wild Encounter');
    expect(screen.queryByRole('button', { name: 'Delete WaifuMon pool' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'OK' }));
    await user.click(panel().getByRole('button', { name: 'Duplicate WaifuMon pool Wild' }));
    expect(panel().getAllByTestId('species-pool-row')).toHaveLength(2);
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool Wild (copy)' }));
    fireEvent.change(sheet().getByLabelText('Entry 1 weight'), { target: { value: '12' } });
    await user.click(screen.getByRole('button', { name: 'Close WaifuMon pool' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
    expect(world.stored.draft.speciesPools!.map((p) => p.entries[0]!.weight)).toEqual([3, 12]);
    await user.click(panel().getByRole('button', { name: 'Delete WaifuMon pool Wild (copy)' }));
    await user.click(screen.getByRole('button', { name: 'Delete WaifuMon pool' }));
    expect(panel().getAllByTestId('species-pool-row')).toHaveLength(1);
  });
  it('renders server probabilities verbatim and sends all simulation controls without saving them', async () => {
    seed();
    const odds: api.DungeonSpeciesPoolOdds = {
      totalWeight: 4,
      nothingProbability: 0.4567,
      unavailableProbability: 0.12,
      rarityDistribution: { SR: 0.5433 },
      obtainableRarityDistribution: { SR: 0.4233 },
      entries: [
        {
          id: 'android',
          species: 'android',
          weight: 3,
          eligible: false,
          reason: 'already_seen',
          probability: 0.5433,
          rarity: 'SR',
          unavailableReason: 'player_limit',
        },
        {
          id: 'none',
          species: null,
          weight: 1,
          eligible: true,
          reason: null,
          probability: 0.4567,
          rarity: null,
          unavailableReason: null,
        },
      ],
    };
    vi.mocked(api.validateDungeon).mockImplementation(async (definition) => ({
      definition,
      issues: [],
      publishable: true,
      contentHash: 'hash',
      speciesPools: [{ poolId: 'pool', base: odds, scenario: odds }],
    }));
    const user = await ready();
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool Wild' }));
    const got = await sheet().findByRole('region', { name: 'In this simulated run' });
    expect(got).toHaveTextContent('54.33%');
    expect(got).toHaveTextContent('45.67%');
    expect(got).toHaveTextContent('Excluded: already encountered');
    expect(got).toHaveTextContent('SR 42.33%');
    await user.click(sheet().getByLabelText('Assume flag Vault opened'));
    await user.click(sheet().getByLabelText('Assume completed room Entrance'));
    await user.click(sheet().getByLabelText('Assume encountered Test Android'));
    fireEvent.change(sheet().getByLabelText('Assumed acquisitions for Test Android'), {
      target: { value: '2' },
    });
    await waitFor(() =>
      expect(vi.mocked(api.validateDungeon).mock.calls.at(-1)?.[3]).toEqual({
        flags: ['open'],
        completedRooms: ['entrance'],
        seenSpecies: ['android'],
        acquisitions: { android: 2 },
      }),
    );
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });
  it('keeps invalid weight edits unsaved and checklist Show me focuses the entry', async () => {
    seed();
    const user = await ready();
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool Wild' }));
    fireEvent.change(sheet().getByLabelText('Entry 1 weight'), { target: { value: '' } });
    expect(sheet().getByRole('alert')).toHaveTextContent('Finish this field before saving');
    await user.click(screen.getByRole('button', { name: 'Close WaifuMon pool' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    const issue = screen.getByText(/WaifuMon pool “Wild”, entry 1: Weight must/);
    await user.click(within(issue.closest('li')!).getByRole('button', { name: /^Show me:/ }));
    await waitFor(() => expect(sheet().getByLabelText('Entry 1 weight')).toHaveFocus());
    fireEvent.change(sheet().getByLabelText('Entry 1 weight'), { target: { value: '4' } });
    await user.click(screen.getByRole('button', { name: 'Close WaifuMon pool' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  });
  it('shows unavailable imported entries and duplicate validation; read permission has no editing controls', async () => {
    seed();
    world.stored.draft.speciesPools![0]!.entries.push({
      id: 'missing',
      species: 'unknown',
      weight: 1,
    });
    world.stored.draft.speciesPools![0]!.entries.push({
      id: 'duplicate',
      species: 'android',
      weight: 1,
    });
    renderAt('/admin/dungeons/definitions/tunnels', ['dungeons.read']);
    await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
    await userEvent.setup().click(panel().getByRole('button', { name: 'View WaifuMon pool Wild' }));
    expect(await sheet().findByText(/Unavailable species: unknown/)).toBeInTheDocument();
    expect(sheet().getAllByText(/appears more than once/)).toHaveLength(2);
    expect(sheet().getByLabelText('WaifuMon pool name')).toBeDisabled();
    expect(sheet().getByLabelText('Entry 1 weight')).toBeDisabled();
    expect(sheet().queryByRole('button', { name: '+ Add species' })).not.toBeInTheDocument();
    expect(panel().queryByRole('button', { name: '+ New WaifuMon pool' })).not.toBeInTheDocument();
  });
  it('publication access failures link to Species access for repair', async () => {
    seed();
    world.stored.draft.rooms[0]!.actions.push({
      id: 'wild',
      type: 'wild_encounter',
      source: { kind: 'pool', poolId: 'pool' },
    });
    const user = await ready();
    vi.mocked(api.publishDungeon).mockRejectedValue(
      new PortalApiError({
        status: 400,
        code: 'DUNGEON_INVALID',
        message: 'Species policy changed',
        details: {
          issues: [
            {
              code: 'species_not_permitted',
              severity: 'error',
              path: 'rooms[0].actions[0].source',
              message: 'Species \"android\" is unavailable: not_permitted.',
            },
          ],
        },
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Publish draft' }));
    await user.click(await screen.findByRole('button', { name: 'Publish now' }));
    expect(await screen.findByText('Species policy changed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show me: WaifuMon pool .*unavailable/ }));
    expect(await screen.findByTestId('species-access-editor')).toBeInTheDocument();
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
  });
  it('does not show older preview responses while a new scenario is pending', async () => {
    seed();
    const odds: api.DungeonSpeciesPoolOdds = {
      totalWeight: 4,
      nothingProbability: 0.25,
      unavailableProbability: 0,
      rarityDistribution: { SR: 0.75 },
      obtainableRarityDistribution: { SR: 0.75 },
      entries: [],
    };
    vi.mocked(api.validateDungeon).mockImplementation(
      async (definition, _signal, _event, scenario) => {
        if (scenario?.seenSpecies.length) return new Promise(() => {});
        return {
          definition,
          contentHash: 'hash',
          issues: [],
          publishable: true,
          speciesPools: [{ poolId: 'pool', base: odds, scenario: odds }],
        };
      },
    );
    const user = await ready();
    await user.click(panel().getByRole('button', { name: 'Edit WaifuMon pool Wild' }));
    await sheet().findByRole('region', { name: 'In this simulated run' });
    await user.click(sheet().getByLabelText('Assume encountered Test Android'));
    expect(
      sheet().queryByRole('region', { name: 'In this simulated run' }),
    ).not.toBeInTheDocument();
    expect(sheet().getByText('Waiting for server probabilities…')).toBeInTheDocument();
  });
});
