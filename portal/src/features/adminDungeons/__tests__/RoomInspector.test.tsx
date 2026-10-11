import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonDefinition } from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { DungeonGraphView } from '../DungeonGraphView';
import { RoomInspector } from '../RoomInspector';
import { fixture, install, reference, renderWith } from './dungeonFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
beforeEach(() => {
  install();
  stubObjectUrls();
});

/** A dungeon authored with every advanced capability the schema has. */
export function advancedDungeon(): DungeonDefinition {
  return {
    ...fixture().draft,
    flags: [
      { key: 'f_lever', scope: 'run', description: 'Lever pulled' },
      { key: 'p_seen', scope: 'player', description: 'Seen before' },
    ],
    rooms: [
      {
        id: 'entrance',
        name: 'Gatehouse',
        description: 'Cold air.',
        extraction: true,
        background: { kind: 'shipped', path: 'dungeons/rooms/gate.webp' },
        actions: [
          {
            id: 'a_gate',
            type: 'gate',
            label: '',
            optional: false,
            outcomes: { blocked: { type: 'room_complete' } },
            requires: {
              type: 'all',
              conditions: [
                { type: 'flag', flag: 'f_lever', scope: 'run', equals: true },
                { type: 'not', condition: { type: 'room_completed', roomId: 'r_vault' } },
              ],
            },
            blockedText: 'Sealed',
          },
          {
            id: 'a_fight',
            type: 'combat',
            label: 'Ambush',
            optional: true,
            when: { type: 'flag', flag: 'f_lever', scope: 'run', equals: false },
            next: { type: 'action', actionId: 'a_flag' },
            outcomes: { defeat: { type: 'retreat' }, declined: { type: 'room_complete' } },
            waves: [
              {
                enemy: {
                  pool: [
                    { key: 'slime', weight: 3 },
                    { key: 'golem', weight: 1 },
                  ],
                },
              },
              { enemy: { key: 'retired' } },
            ],
            advance: 'auto',
          },
          { id: 'a_flag', type: 'set_flag', flag: 'f_lever', scope: 'run', value: true },
          { id: 'a_leave', type: 'leave', connectionId: 'c_secret', outcomes: {} },
        ],
      },
      { id: 'r_vault', name: 'Vault', kind: 'exit', actions: [] },
    ],
    connections: [
      {
        id: 'c_secret',
        from: 'entrance',
        to: 'r_vault',
        kind: 'secret',
        label: 'Loose panel',
        requires: { type: 'flag', flag: 'f_lever', scope: 'run', equals: true },
        lockedText: '',
      },
      { id: 'c_short', from: 'entrance', to: 'r_vault', kind: 'shortcut', label: 'Vent' },
    ],
  };
}

function Harness({
  initial,
  roomId = 'entrance',
}: {
  initial: DungeonDefinition;
  roomId?: string;
}) {
  const [d, setD] = useState(initial);
  return (
    <>
      <RoomInspector
        room={d.rooms.find((r) => r.id === roomId)!}
        definition={d}
        reference={reference}
        issues={[]}
        disabled={false}
        onChange={setD}
        onSelect={() => {}}
        onAddNext={() => {}}
        onDelete={() => {}}
      />
      <output data-testid="definition">{JSON.stringify(d)}</output>
    </>
  );
}
const definition = () =>
  JSON.parse(screen.getByTestId('definition').textContent!) as DungeonDefinition;
const actions = () => definition().rooms[0]!.actions;

describe('what happens here', () => {
  it('builds a two-wave fight with nothing but enemies and Add wave', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={fixture().draft} />);
    expect(screen.getByText(/Nothing yet\. Players walk straight through/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add Fight' }));
    // The new activity opens on its one essential question.
    const enemy = screen.getByLabelText('Wave 1 enemy');
    expect(enemy).toHaveValue('');
    expect(
      within(enemy).getByRole('option', { name: 'Slime — HP 10 · ATK 1 · DEF 1' }),
    ).toBeEnabled();
    expect(within(enemy).getByRole('option', { name: /Old Sentry .*switched off/ })).toBeDisabled();
    expect(within(enemy).queryByRole('option', { name: /slime \(|\(slime\)/ })).toBeNull();
    await user.selectOptions(enemy, 'slime');
    await user.click(screen.getByRole('button', { name: 'Add wave' }));
    expect(screen.getByLabelText('Wave 2 enemy')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Wave 2 enemy'), 'golem');
    expect(
      screen.getByRole('button', { name: /^Activity 1: Fight\. Slime, then Rust Golem/ }),
    ).toBeVisible();
    expect(screen.getByText(/HP carries over from one wave to the next/)).toBeInTheDocument();
    // Routing, rules and button text were never shown, and nothing custom was stored.
    expect(screen.queryByText('What happens afterward?')).toBeNull();
    expect(screen.queryByLabelText('Button text')).toBeNull();
    expect(actions()).toEqual([
      expect.objectContaining({
        type: 'combat',
        label: '',
        optional: false,
        outcomes: {},
        advance: 'confirm',
        waves: [{ enemy: { key: 'slime' } }, { enemy: { key: 'golem' } }],
      }),
    ]);
    expect(actions()[0]).not.toHaveProperty('when');
    expect(actions()[0]).not.toHaveProperty('next');
  });
  it('adds, reorders, duplicates and removes activities while keeping their identities', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={fixture().draft} />);
    await user.click(screen.getByRole('button', { name: 'Add Rest' }));
    await user.clear(screen.getByLabelText('Restore HP percent'));
    await user.type(screen.getByLabelText('Restore HP percent'), '45');
    await user.click(screen.getByRole('button', { name: 'Add Treasure' }));
    await user.selectOptions(screen.getByLabelText('Reward table'), 'loot');
    const [rest, treasure] = actions().map((a) => a.id);
    expect(
      screen.getByRole('button', { name: /^Activity 1: Rest\. Restore 45% HP/ }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /^Activity 2: Treasure\. loot/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move activity 2 up' }));
    expect(actions().map((a) => a.id)).toEqual([treasure, rest]);
    await user.click(screen.getByRole('button', { name: 'Duplicate activity 1' }));
    expect(actions().map((a) => a.type)).toEqual(['reward', 'reward', 'rest']);
    expect(new Set(actions().map((a) => a.id)).size).toBe(3);
    await user.click(screen.getByRole('button', { name: 'Remove activity 2' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Keep it' }));
    expect(actions()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Remove activity 2' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove activity' }),
    );
    expect(actions().map((a) => a.id)).toEqual([treasure, rest]);
  });
  it('keeps the uncommon activities one step away and creates them valid', async () => {
    const user = userEvent.setup();
    renderWith(<Harness initial={fixture().draft} />);
    expect(screen.queryByRole('button', { name: 'Add Remember something' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'Add Remember something' }));
    // The thing to remember is created with the activity, in one edit.
    expect(definition().flags).toEqual([
      expect.objectContaining({ scope: 'run', description: 'Something new' }),
    ]);
    expect(actions()[0]).toMatchObject({ type: 'set_flag', flag: definition().flags[0]!.key });
    await user.clear(screen.getByLabelText('Name of what is remembered'));
    await user.type(screen.getByLabelText('Name of what is remembered'), 'Lever pulled');
    expect(screen.getByRole('button', { name: /Remember “Lever pulled”/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'Add Checkpoint' }));
    expect(actions()[1]).toMatchObject({
      type: 'gate',
      requires: { type: 'flag', flag: definition().flags[0]!.key, scope: 'run', equals: true },
    });
    expect(screen.getByLabelText('Players can continue only if flag')).toHaveDisplayValue(
      'Lever pulled',
    );
  });
});

describe('previously authored advanced content', () => {
  it('is shown, flagged and left exactly as stored when rooms and activities are opened', async () => {
    const user = userEvent.setup();
    const initial = advancedDungeon();
    renderWith(<Harness initial={initial} />);
    const fight = screen.getByRole('button', {
      name: /^Activity 2: Fight\. one of Slime \/ Rust Golem, then Old Sentry/,
    });
    for (const chip of [
      'Can be skipped',
      'Conditional',
      'Custom flow',
      'Custom button text',
      'Automatic waves',
      'Random enemies',
    ])
      expect(within(fight).getByText(chip)).toBeInTheDocument();
    expect(screen.getByText('Players can leave here')).toBeInTheDocument();
    for (const index of [1, 2, 3, 4]) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^Activity ${index}:`) }));
      if (index === 2) {
        // A customised activity shows its advanced settings without being asked.
        expect(screen.getByLabelText('Button text')).toHaveValue('Ambush');
        expect(screen.getByLabelText('Player can skip this')).toBeChecked();
        expect(screen.getByLabelText('Fight remaining waves automatically')).toBeChecked();
        expect(screen.getByLabelText('After losing')).toHaveValue('retreat');
        expect(screen.getByLabelText('If the player skips it')).toHaveValue('room_complete');
        expect(screen.getByLabelText('After succeeding (general rule)')).toHaveValue(
          'action:a_flag',
        );
        expect(screen.getByLabelText('Only happens if flag')).toHaveDisplayValue('Lever pulled');
        expect(screen.getByLabelText('Only happens if equals')).toHaveDisplayValue(
          'has not happened',
        );
        expect(screen.getByLabelText('Wave 1 group chance 1')).toHaveValue(3);
        expect(
          screen.getByText('Old Sentry is switched off in the Enemy Catalogue.'),
        ).toBeInTheDocument();
      }
    }
    await user.click(screen.getByRole('button', { name: 'Advanced rules' }));
    expect(screen.getByLabelText('Players can leave here')).toBeChecked();
    expect(screen.getByText('Room ID: entrance')).toBeInTheDocument();
    // Looking changed nothing.
    expect(definition()).toEqual(initial);
    // An ordinary edit touches only what was edited.
    await user.clear(screen.getByLabelText('Room name'));
    await user.type(screen.getByLabelText('Room name'), 'Gate');
    await user.click(screen.getByRole('button', { name: /^Activity 2:/ }));
    await user.selectOptions(screen.getByLabelText('Wave 2 enemy'), 'slime');
    const expected = advancedDungeon();
    expected.rooms[0]!.name = 'Gate';
    expected.rooms[0]!.actions[1]!.waves![1] = { enemy: { key: 'slime' } };
    expect(definition()).toEqual(expected);
  });
  it('shows hidden and shortcut paths as stored and edits them without disturbing the rest', async () => {
    const user = userEvent.setup();
    function Map() {
      const [d, setD] = useState(advancedDungeon());
      return (
        <>
          <DungeonGraphView
            definition={d}
            layout={{ rooms: {}, notes: [] }}
            issues={[]}
            disabled={false}
            reference={reference}
            onChange={setD}
          />
          <output data-testid="definition">{JSON.stringify(d)}</output>
        </>
      );
    }
    renderWith(<Map />);
    await user.click(screen.getByRole('button', { name: 'Canvas room Gatehouse' }));
    const ways = within(screen.getByRole('region', { name: 'Ways out' }));
    const paths = ways.getAllByRole('button', { name: 'Open path to Vault' });
    expect(paths[0]).toHaveTextContent('Hidden path');
    expect(paths[1]).toHaveTextContent('ShortcutOpen path');
    await user.click(paths[0]!);
    expect(screen.getByLabelText('Hidden path')).toBeChecked();
    expect(screen.getByLabelText('This path opens when flag')).toHaveDisplayValue('Lever pulled');
    expect(screen.getByLabelText('Path button text')).toHaveValue('Loose panel');
    await user.click(screen.getByRole('button', { name: 'Select path Gatehouse → Vault (Vent)' }));
    // A shortcut opens its advanced section by itself so the mark is visible.
    expect(screen.getByLabelText('Mark as shortcut')).toBeChecked();
    expect(screen.getByText('Path ID: c_short')).toBeInTheDocument();
    expect(definition()).toEqual(advancedDungeon());
    await user.type(screen.getByLabelText('Path button text'), 's');
    const expected = advancedDungeon();
    expected.connections[1]!.label = 'Vents';
    expect(definition()).toEqual(expected);
  });
});
