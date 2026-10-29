import * as sharedApi from '@/api/adminDungeonSpeciesPools';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { EncounterActivity } from '../EncounterActivity';
import { ActivityCard } from '../ActivityCard';
import { DungeonSandboxDialog } from '../DungeonSandboxDialog';
import { EventEditorContext } from '../eventEditorContext';
import { createAction } from '../dungeonActionModel';
import { friendlyIssue } from '../dungeonText';
import { publicationState, publishExplanation } from '../dungeonPublicationModel';
import { fixture, install, renderAt, renderWith } from './dungeonFixtures';
vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
const normal: api.DungeonSpeciesRef = {
  slug: 'android',
  name: 'Test Android',
  rarity: 'SR',
  race: 'android',
  affinity: 'switch',
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: true,
  permitted: true,
  unavailableReason: null,
  dungeonPolicyAllowed: true,
  dungeonAccess: [{ dungeon: 'tunnels', perPlayerLimit: 2, directRescue: true }],
  perPlayerLimit: 2,
  directRescue: { available: true, reason: null },
};
let world: ReturnType<typeof install>;
beforeEach(() => {
  world = install();
  vi.spyOn(sharedApi, 'listSharedPools').mockResolvedValue([]);
  stubObjectUrls();
  vi.spyOn(api, 'getDungeonSpecies').mockResolvedValue({
    species: [
      normal,
      {
        ...normal,
        slug: 'elf',
        name: 'Test Elf',
        directRescue: { available: false, reason: 'direct_not_permitted' },
      },
      {
        ...normal,
        slug: 'restricted',
        name: 'Restricted Angel',
        permitted: false,
        unavailableReason: 'not_permitted',
        dungeonPolicyAllowed: false,
        regionExclusive: true,
      },
    ],
  });
  vi.spyOn(api, 'dungeonSpeciesArtworkBlob').mockResolvedValue(new Blob(['art']));
});
function seeded(type: 'wild_encounter' | 'rescue' = 'wild_encounter') {
  const d = fixture().draft;
  d.flags = [{ key: 'open', scope: 'run', description: 'Vault opened' }];
  d.speciesPools = [
    {
      id: 'pool',
      name: 'Wild',
      entries: [
        { id: 'one', species: 'android', weight: 3 },
        { id: 'two', species: 'elf', weight: 1 },
        { id: 'none', nothing: true, weight: 1 },
      ],
    },
  ];
  d.rooms[0]!.actions = [
    {
      ...createAction(type, []),
      source: { kind: 'species', species: 'android' },
      intro: 'She appears.',
    },
    { id: 'later', type: 'rest', healBasisPoints: 1000 },
  ];
  return d;
}
const opened = vi.fn(),
  played = vi.fn();
function Harness({
  type = 'wild_encounter',
  card = false,
}: {
  type?: 'wild_encounter' | 'rescue';
  card?: boolean;
}) {
  const [d, setD] = useState(seeded(type));
  const room = d.rooms[0]!,
    action = room.actions[0]!;
  const onChange = (a: api.DungeonAction) =>
    setD({ ...d, rooms: [{ ...room, actions: [a, room.actions[1]!] }] });
  return (
    <EventEditorContext.Provider value={{ open: opened, play: played }}>
      {card ? (
        <ActivityCard
          action={action}
          room={room}
          index={0}
          definition={d}
          open
          disabled={false}
          issues={[]}
          onChange={onChange}
          onDefinitionChange={setD}
          onToggle={() => {}}
          onMove={() => {}}
          onDuplicate={() => {}}
          onRemove={() => {}}
        />
      ) : (
        <EncounterActivity
          action={action}
          room={room}
          definition={d}
          disabled={false}
          onChange={onChange}
          onDefinitionChange={setD}
        />
      )}
      <output data-testid="draft-output">{JSON.stringify(d)}</output>
    </EventEditorContext.Provider>
  );
}
const draft = () => JSON.parse(screen.getByTestId('draft-output').textContent!).rooms[0].actions[0];
describe('encounter authoring', () => {
  it.each(['wild_encounter', 'rescue'] as const)(
    'creates %s through room controls and saves',
    async (type) => {
      const user = userEvent.setup();
      renderAt();
      await screen.findByRole('heading', { level: 1, name: 'Tunnels' });
      await user.click(screen.getByRole('button', { name: 'Select room Entrance' }));
      const inspector = within(screen.getByRole('complementary', { name: 'Map inspector' }));
      await user.click(
        inspector.getByRole('button', {
          name: type === 'rescue' ? 'Add Rescue' : 'Add Wild Encounter',
        }),
      );
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
      await user.click(inspector.getByRole('button', { name: 'Choose WaifuMon' }));
      await user.click(await screen.findByRole('button', { name: 'Select species Test Android' }));
      await user.type(inspector.getByLabelText('Encounter introduction'), 'At the door.');
      await user.click(screen.getByRole('button', { name: 'Save draft' }));
      await waitFor(() => expect(api.saveDungeonDraft).toHaveBeenCalled());
      expect(world.stored.draft.rooms[0]!.actions.find((a) => a.type === type)).toMatchObject({
        source: { kind: 'species', species: 'android' },
        intro: 'At the door.',
        capture: { maxAttempts: 3, allowGuaranteedItems: true },
      });
    },
  );
  it('switches sources, opens the pool editor and previews each pool species', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.selectOptions(screen.getByLabelText('Encounter source'), 'pool');
    await user.selectOptions(screen.getByLabelText('WaifuMon pool'), 'pool');
    expect(draft().source).toEqual({ kind: 'pool', poolId: 'pool' });
    await user.click(screen.getByRole('button', { name: 'Edit selected pool' }));
    expect(opened).toHaveBeenCalledWith({ kind: 'speciesPool', id: 'pool' });
    await user.selectOptions(screen.getByLabelText('Preview pool species'), 'elf');
    await waitFor(() =>
      expect(api.previewDungeonScene).toHaveBeenLastCalledWith(
        expect.objectContaining({
          encounter: expect.objectContaining({ species: 'elf' }),
          roomSprites: [],
          activitySprites: [],
        }),
        expect.anything(),
      ),
    );
    await user.selectOptions(screen.getByLabelText('Encounter source'), 'species');
    expect(draft().source).toEqual({ kind: 'species', species: '' });
  });
  it('keeps restricted species visible and configures attempts, subset and guaranteed items', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Choose WaifuMon' }));
    expect(
      await screen.findByRole('button', { name: 'Select species Restricted Angel' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Close species picker' }));
    fireEvent.change(screen.getByLabelText('Capture attempt limit'), { target: { value: '1' } });
    await user.selectOptions(screen.getByLabelText('Permitted capture charms'), 'subset');
    await user.click(await screen.findByLabelText('Permit charm Basic Charm'));
    await user.click(screen.getByLabelText('Allow guaranteed capture items'));
    expect(draft().capture).toEqual({
      maxAttempts: 1,
      allowedItems: ['basic_charm'],
      allowGuaranteedItems: false,
    });
    expect(screen.getByText(/including failures/)).toBeInTheDocument();
  });
  it('direct rescue hides capture rules and permits saving unauthorized repair drafts', async () => {
    const user = userEvent.setup();
    renderWith(<Harness type="rescue" />);
    await user.selectOptions(screen.getByLabelText('Rescue mode'), 'direct');
    expect(screen.queryByLabelText('Capture attempt limit')).not.toBeInTheDocument();
    expect(draft()).not.toHaveProperty('capture');
    expect(screen.getByText(/Direct grant: no charm/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose WaifuMon' }));
    await user.click(await screen.findByRole('button', { name: 'Select species Test Elf' }));
    expect(screen.getByText(/Direct Rescue: direct rescue is not authorized/)).toBeInTheDocument();
    expect(draft().source.species).toBe('elf');
    await user.selectOptions(screen.getByLabelText('Rescue mode'), 'capture');
    expect(screen.getByLabelText('Capture attempt limit')).toBeInTheDocument();
  });
  it('edits results, declared run flags, existing conditions and forward outcome routing', async () => {
    const user = userEvent.setup();
    renderWith(<Harness card />);
    await user.click(screen.getByText('Captured result'));
    await user.type(screen.getByLabelText('captured outcome text'), 'We made it.');
    await user.click(screen.getByRole('button', { name: 'Add captured result flag' }));
    await user.selectOptions(screen.getByLabelText('captured result flag 1'), 'open');
    await user.click(screen.getByRole('button', { name: 'Advanced options' }));
    await user.selectOptions(screen.getByLabelText('After capture'), 'action:later');
    expect(draft()).toMatchObject({
      outcomes: { captured: { type: 'action', actionId: 'later' } },
      results: { captured: { text: 'We made it.', flags: [{ flag: 'open', value: true }] } },
    });
    expect(screen.getByLabelText('After capture')).not.toHaveTextContent('Send the player back');
    expect(screen.queryByLabelText('Player can skip this')).not.toBeInTheDocument();
  });
  it('edits placement and mirroring and requests an actor scene', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.selectOptions(screen.getByLabelText('Sprite position'), 'center');
    fireEvent.change(screen.getByLabelText('Offset X (px)'), { target: { value: '40' } });
    await user.click(screen.getByLabelText('Mirror encountered WaifuMon'));
    expect(draft()).toMatchObject({ mirror: true, placement: { anchor: 'center', offsetX: 40 } });
    await waitFor(() =>
      expect(api.previewDungeonScene).toHaveBeenLastCalledWith(
        expect.objectContaining({
          encounter: expect.objectContaining({
            species: 'android',
            mirror: true,
            placement: expect.objectContaining({ offsetX: 40 }),
          }),
        }),
        expect.anything(),
      ),
    );
    expect(vi.mocked(api.previewDungeonScene).mock.lastCall![0]).not.toHaveProperty('enemyKey');
  });
  it('previews result states through the server and opens the sandbox without changing the draft', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    const before = draft();
    await user.selectOptions(screen.getByLabelText('Preview encounter state'), 'escaped');
    await waitFor(() =>
      expect(api.previewDungeonEncounter).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: 'escaped' }),
        expect.anything(),
      ),
    );
    expect(await screen.findByText('Production preview')).toBeInTheDocument();
    expect(draft()).toEqual(before);
    await user.click(screen.getByRole('button', { name: 'Test encounter in dungeon sandbox' }));
    expect(played).toHaveBeenCalled();
  });
  it('maps missing-reference/policy/flag issues to the activity and explains species publication drift', () => {
    const d = seeded('rescue');
    d.rooms[0]!.actions[0]!.source = { kind: 'pool', poolId: 'gone' };
    for (const code of [
      'species_pool_missing',
      'rescue_direct_not_permitted',
      'encounter_flag_undeclared',
    ])
      expect(
        friendlyIssue(
          {
            code,
            path: 'rooms[0].actions[0].source',
            message: 'Repair this encounter',
            severity: 'error',
          },
          d,
        ),
      ).toMatchObject({
        target: { kind: 'room', id: d.rooms[0]!.id },
        actionId: d.rooms[0]!.actions[0]!.id,
        level: 'fix',
      });
    const state = publicationState({ ...fixture(), draftDiffers: false, speciesDiffer: true });
    expect(state.kind).toBe('species');
    expect(publishExplanation(state)).toContain('live policy');
  });
  it('routes Species access problems to the Species access sheet', () => {
    const d = seeded();
    d.rooms[0]!.actions[0]!.source = { kind: 'species', species: 'restricted' };
    d.speciesPolicies = [{ species: 'android', perPlayerLimit: 1 }];
    expect(
      friendlyIssue({ code: 'species_not_permitted', path: 'rooms[0].actions[0].source', message: 'Species "restricted" is unavailable: not_permitted.', severity: 'error' }, d),
    ).toMatchObject({ actionId: d.rooms[0]!.actions[0]!.id, eventTarget: { kind: 'speciesAccess', id: 'restricted' } });
    expect(
      friendlyIssue({ code: 'species_policy_unused', path: 'speciesPolicies[0]', message: 'Unused.', severity: 'warning' }, d),
    ).toMatchObject({ level: 'review', eventTarget: { kind: 'speciesAccess', id: 'android' } });
  });
  it('sends sandbox charm selection and capture inputs and reports simulated grants', async () => {
    const d = seeded();
    const view: api.DungeonSandboxView = {
      status: 'active',
      step: 0,
      hp: 400,
      maxHp: 400,
      room: { id: 'entrance', name: 'Entrance', description: '', kind: 'room' },
      phase: 'action',
      action: {
        id: 'encounter',
        type: 'wild_encounter',
        label: '',
        optional: false,
        wave: null,
        encounter: {
          species: 'android',
          name: 'Test Android',
          rarity: 'SR',
          intro: 'She appears.',
          mode: 'capture',
          available: true,
          unavailableReason: null,
          selectedItem: null,
          attemptsLeft: 3,
          items: [{ item: 'basic_charm', owned: 2, chance: 0.22, guaranteed: false }],
        },
      },
      connections: [],
      canExtract: false,
      stuck: false,
      flags: {},
      recent: [],
      end: null,
    };
    vi.spyOn(api, 'playDungeonSandbox').mockImplementation(async ({ inputs }) => ({
      view: {
        ...view,
        action: {
          ...view.action!,
          encounter: {
            ...view.action!.encounter!,
            selectedItem: inputs.length ? 'basic_charm' : null,
          },
        },
      },
      effects: [],
      simulatedGrants:
        inputs.length > 1
          ? [{ species: 'android', copies: 1, xp: 50, item: 'basic_charm', success: true }]
          : [],
      eventResults: [],
      steps: inputs.length,
      stoppedBy: null,
      refusal: null,
    }));
    const user = userEvent.setup();
    renderWith(<DungeonSandboxDialog definition={d} onClose={() => {}} />);
    await screen.findByRole('region', { name: 'Sandbox encounter' });
    await user.selectOptions(screen.getByLabelText('Sandbox capture charm'), 'basic_charm');
    await user.click(screen.getByRole('button', { name: 'Simulate capture attempt' }));
    expect(await screen.findByTestId('sandbox-simulated-grant')).toHaveTextContent(
      'No database changes',
    );
    expect(api.playDungeonSandbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputs: [{ type: 'select_item', item: 'basic_charm' }, { type: 'capture' }],
      }),
    );
  });
});

describe('publication and preview context', () => {
  it('shows current drift, historical active runs, missing evidence and live restrictions separately', async () => {
    const { SpeciesDependencyStatus } = await import('../SpeciesDependencyStatus');
    vi.mocked(api.getDungeonSpeciesStatus).mockResolvedValue({
      revisions: [
        {
          revision: 2,
          revisionId: 2,
          current: true,
          activeRuns: 0,
          evidence: 'recorded',
          differs: true,
          dependencies: [
            {
              slug: 'android',
              changes: ['Rarity changed: SR → UR'],
              liveRestriction: 'disabled',
              directRestriction: null,
            },
          ],
        },
        {
          revision: 1,
          revisionId: 1,
          current: false,
          activeRuns: 3,
          evidence: 'unknown',
          differs: null,
          dependencies: [
            { slug: 'elf', changes: [], liveRestriction: null, directRestriction: null },
          ],
        },
      ],
    });
    renderWith(<SpeciesDependencyStatus dungeonKey="tunnels" revision={2} />);
    const status = await screen.findByTestId('species-dependency-status');
    expect(status).toHaveTextContent('Published dependency warning');
    expect(status).toHaveTextContent('historical revision · 3 active runs');
    expect(status).toHaveTextContent('comparison unavailable');
    expect(status).toHaveTextContent('Live acquisition restriction: Species is disabled');
  });
  it('never paints an older production preview as the current state', async () => {
    let resolveOld!: (preview: api.DungeonDiscordEncounterPreview) => void;
    const old = new Promise<api.DungeonDiscordEncounterPreview>((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(api.previewDungeonEncounter)
      .mockImplementationOnce(() => old)
      .mockResolvedValue({
        simulated: true,
        context: 'Current simulated context',
        embeds: [{ title: 'Current leave preview' }],
        components: [],
      });
    const user = userEvent.setup();
    renderWith(<Harness />);
    await waitFor(() => expect(api.previewDungeonEncounter).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Preview encounter state'), 'left');
    await screen.findByText('Current leave preview');
    resolveOld({
      simulated: true,
      context: 'Old context',
      embeds: [{ title: 'Stale offered preview' }],
      components: [],
    });
    await waitFor(() =>
      expect(screen.queryByText('Stale offered preview')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Current leave preview')).toBeInTheDocument();
  });
});
