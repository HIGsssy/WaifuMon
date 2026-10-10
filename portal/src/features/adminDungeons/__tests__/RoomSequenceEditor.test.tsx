import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonDefinition, DungeonReferenceData } from '@/api/adminDungeons';
import * as api from '@/api/adminDungeons';
import { RoomSequenceEditor, RunFlagsEditor } from '../RoomSequenceEditor';
import { fixture, install, renderAt } from './dungeonFixtures';
const reference: DungeonReferenceData = {
  actionTypes: ['combat', 'boss', 'rest', 'gate', 'set_flag', 'leave', 'reward'],
  reservedActionTypes: {},
  regions: [],
  currencies: [],
  enemies: [
    { key: 'slime', name: 'Slime', enabled: true, attack: 1, defense: 1, hp: 10 },
    { key: 'dragon', name: 'Dragon', enabled: true, attack: 2, defense: 2, hp: 20 },
  ],
  rewardTables: [
    { id: 'loot', enabled: true },
    { id: 'gear', enabled: true },
  ],
};
beforeEach(() => {
  install();
  vi.mocked(api.getDungeonReference).mockResolvedValue(reference);
});
function Harness({
  initial = fixture().draft,
  disabled = false,
}: {
  initial?: DungeonDefinition;
  disabled?: boolean;
}) {
  const [definition, setDefinition] = useState(initial);
  return (
    <>
      <RunFlagsEditor definition={definition} disabled={disabled} onChange={setDefinition} />
      <RoomSequenceEditor
        room={definition.rooms[0]!}
        definition={definition}
        disabled={disabled}
        onChange={setDefinition}
        reference={reference}
        issues={[]}
      />
      <output data-testid="draft">{JSON.stringify(definition)}</output>
    </>
  );
}
const draft = () => JSON.parse(screen.getByTestId('draft').textContent!) as DungeonDefinition;
const actions = () => draft().rooms[0]!.actions;
async function add(user: ReturnType<typeof userEvent.setup>, type: string) {
  await user.selectOptions(screen.getByLabelText('New action type'), type);
  await user.click(screen.getByRole('button', { name: 'Add action' }));
}
describe('room sequence editing', () => {
  it('adds, duplicates, reorders and removes with confirmation, preserving identities', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await add(user, 'rest');
    const first = actions()[0]!.id;
    await user.type(screen.getByLabelText('Action label'), 'Recover');
    await user.click(screen.getByRole('button', { name: 'Duplicate action 1' }));
    const copy = actions()[1]!.id;
    expect(copy).not.toBe(first);
    expect(actions()[1]!.label).toBe('Recover');
    await user.click(screen.getByRole('button', { name: 'Move action 2 up' }));
    expect(actions().map((a) => a.id)).toEqual([copy, first]);
    await user.click(screen.getByRole('button', { name: 'Remove action 1' }));
    expect(actions()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel action removal' }));
    expect(actions()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove action 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm action removal' }));
    expect(actions().map((a) => a.id)).toEqual([first]);
  });
  it('edits waves, advancement, weighted pools, combat type and defeat routing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await add(user, 'combat');
    await user.selectOptions(screen.getByLabelText('Combat action type'), 'boss');
    await user.selectOptions(screen.getByLabelText('Wave advancement'), 'auto');
    await user.click(screen.getByRole('button', { name: 'Add combat wave' }));
    await user.selectOptions(screen.getByLabelText('Wave 2 enemy'), 'dragon');
    await user.click(screen.getByRole('button', { name: 'Move wave 2 up' }));
    expect(actions()[0]!.waves![0]!.enemy).toEqual({ key: 'dragon' });
    await user.selectOptions(screen.getByLabelText('Wave 1 enemy selection'), 'pool');
    await user.click(screen.getByRole('button', { name: 'Add wave 1 pool enemy' }));
    await user.clear(screen.getByLabelText('Wave 1 pool weight 2'));
    await user.type(screen.getByLabelText('Wave 1 pool weight 2'), '3');
    await user.selectOptions(screen.getByLabelText('defeat route'), 'retreat');
    expect(actions()[0]).toMatchObject({
      type: 'boss',
      advance: 'auto',
      waves: [
        {
          enemy: {
            pool: [
              { key: 'dragon', weight: 1 },
              { key: 'slime', weight: 3 },
            ],
          },
        },
        { enemy: { key: 'slime' } },
      ],
      outcomes: { defeat: { type: 'retreat' } },
    });
    await user.click(screen.getByRole('button', { name: 'Remove wave 2' }));
    expect(actions()[0]!.waves).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove wave 1 pool enemy 2' }));
    expect(actions()[0]!.waves![0]!.enemy).toEqual({ pool: [{ key: 'dragon', weight: 1 }] });
  });
  it('keeps invalid routing targets after reorder/deletion and offers explicit repair and early completion', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await add(user, 'rest');
    await add(user, 'reward');
    const target = actions()[1]!.id;
    await user.click(screen.getByRole('button', { name: 'Select action 1: rest' }));
    await user.selectOptions(screen.getByLabelText('done route'), `action:${target}`);
    await user.click(screen.getByRole('button', { name: 'Move action 2 up' }));
    expect(actions()[1]!.outcomes!.done).toEqual({ type: 'action', actionId: target });
    expect(screen.getByText(/Target action must be later/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove action 1' }));
    await user.click(screen.getByRole('button', { name: 'Confirm action removal' }));
    expect(actions()[0]!.outcomes!.done).toEqual({ type: 'action', actionId: target });
    expect(screen.getByText(/Target action was removed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Repair done route' }));
    await user.selectOptions(screen.getByLabelText('done route'), 'room_complete');
    expect(actions()[0]!.outcomes!.done).toEqual({ type: 'room_complete' });
    expect(screen.queryByText(/Target action was removed/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Success default route'), 'end_run:completed');
    expect(actions()[0]!.next).toEqual({ type: 'end_run', outcome: 'completed' });
  });
  it('configures current rewards, restoration and connection-based leave without changing unrelated fields', async () => {
    const user = userEvent.setup();
    const initial = fixture().draft;
    initial.connections = [{ id: 'path', from: 'entrance', to: 'entrance', label: 'Return' }];
    render(<Harness initial={initial} />);
    await add(user, 'reward');
    await user.selectOptions(screen.getByLabelText('Reward table'), 'loot');
    await user.selectOptions(screen.getByLabelText('Equipment reward table'), 'gear');
    await user.type(screen.getByLabelText('Progression currency min'), '5');
    await user.type(screen.getByLabelText('Progression currency max'), '9');
    await user.selectOptions(screen.getByLabelText('claimed route'), 'leave:path');
    expect(actions()[0]).toMatchObject({
      reward: { rewardTable: 'loot', equipmentRewardTable: 'gear', currency: { min: 5, max: 9 } },
      outcomes: { claimed: { type: 'leave', connectionId: 'path' } },
    });
    await add(user, 'rest');
    await user.clear(screen.getByLabelText('Restore HP percent'));
    await user.type(screen.getByLabelText('Restore HP percent'), '42.5');
    expect(actions()[1]!.healBasisPoints).toBe(4250);
    await add(user, 'leave');
    await user.selectOptions(screen.getByLabelText('Leave transition'), 'path');
    expect(actions()[2]!.connectionId).toBe('path');
    expect(draft().connections).toEqual(initial.connections);
  });
  it('declares run flags and authors flag, room, all, any and not conditions without JSON', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add run flag' }));
    const flag = draft().flags[0]!;
    await user.clear(screen.getByLabelText(`Flag description ${flag.key}`));
    await user.type(screen.getByLabelText(`Flag description ${flag.key}`), 'Found key');
    await add(user, 'set_flag');
    await user.selectOptions(screen.getByLabelText('Set run flag'), flag.key);
    await user.selectOptions(screen.getByLabelText('Flag value'), 'false');
    expect(actions()[0]).toMatchObject({ flag: flag.key, scope: 'run', value: false });
    await add(user, 'gate');
    await user.selectOptions(screen.getByLabelText('Gate requires type'), 'all');
    await user.selectOptions(screen.getByLabelText('Gate requires 1 type'), 'not');
    await user.selectOptions(
      screen.getByLabelText('Gate requires 1 negated type'),
      'room_completed',
    );
    await user.click(screen.getByRole('button', { name: 'Add Gate requires condition' }));
    await user.selectOptions(screen.getByLabelText('Gate requires 2 type'), 'any');
    expect(actions()[1]!.requires).toEqual({
      type: 'all',
      conditions: [
        { type: 'not', condition: { type: 'room_completed', roomId: 'entrance' } },
        { type: 'any', conditions: [{ type: 'flag', flag: flag.key, scope: 'run', equals: true }] },
      ],
    });
    await user.type(screen.getByLabelText('Blocked text'), 'Find the key');
    await user.selectOptions(screen.getByLabelText('blocked route'), 'room_complete');
    await user.selectOptions(screen.getByLabelText('Run action when type'), 'flag');
    await user.selectOptions(screen.getByLabelText('Run action when equals'), 'false');
    expect(actions()[1]!.when).toEqual({
      type: 'flag',
      flag: flag.key,
      scope: 'run',
      equals: false,
    });
  });
  it('saves edited sequences with layout and expected revision, preserving local edits on conflicts', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await add(user, 'combat');
    await add(user, 'reward');
    await user.selectOptions(screen.getByLabelText('Reward table'), 'loot');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(api.saveDungeonDraft).toHaveBeenCalledWith(
      'tunnels',
      expect.objectContaining({
        expectedRevision: 4,
        layout: fixture().layout,
        definition: expect.objectContaining({
          rooms: [
            expect.objectContaining({
              actions: [
                expect.objectContaining({ type: 'combat' }),
                expect.objectContaining({ type: 'reward' }),
              ],
            }),
          ],
        }),
      }),
    );
    const { PortalApiError } = await import('@/api/client');
    vi.mocked(api.saveDungeonDraft).mockRejectedValue(
      new PortalApiError({ status: 409, code: 'DUNGEON_DRAFT_STALE', message: 'Stale' }),
    );
    await user.type(screen.getByLabelText('Action label'), 'Local treasure');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText(/A newer draft exists/);
    expect(screen.getByLabelText('Action label')).toHaveValue('Local treasure');
    expect(screen.getByRole('button', { name: 'Add action' })).toBeDisabled();
  });
  it('maps current server validation to its action row', async () => {
    vi.mocked(api.validateDungeon).mockResolvedValue({
      definition: null,
      contentHash: null,
      publishable: false,
      issues: [
        {
          severity: 'error',
          path: 'rooms[0].actions[0].waves[0].enemy',
          code: 'enemy_missing',
          message: 'Missing enemy',
        },
      ],
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Select room Entrance' }));
    await add(user, 'combat');
    const row = screen.getByRole('button', { name: 'Select action 1: combat' }).closest('li')!;
    await waitFor(() => expect(within(row).getByText(/Missing enemy/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Publish draft' })).toBeDisabled();
  });
  it('keeps read-only controls disabled while allowing inspection of undeclared flags', async () => {
    const user = userEvent.setup();
    const initial = fixture().draft;
    initial.rooms[0]!.actions = [{ id: 'flag', type: 'set_flag', flag: 'missing', scope: 'run' }];
    render(<Harness initial={initial} disabled />);
    expect(screen.getByRole('button', { name: 'Add action' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove action 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add run flag' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Select action 1: set_flag' }));
    expect(screen.getByLabelText('Set run flag')).toBeDisabled();
    expect(screen.getByText(/Declare a run flag or choose/)).toBeInTheDocument();
    expect(actions()[0]!.flag).toBe('missing');
  });
  it('preserves unsupported player flag conditions until an explicit run-scope repair', async () => {
    const user = userEvent.setup();
    const initial = fixture().draft;
    initial.flags = [{ key: 'key', scope: 'run', description: 'Run key' }];
    initial.rooms[0]!.actions = [
      {
        id: 'gate',
        type: 'gate',
        requires: { type: 'flag', flag: 'legacy', scope: 'player', equals: true },
      },
    ];
    render(<Harness initial={initial} />);
    await user.click(screen.getByRole('button', { name: 'Select action 1: gate' }));
    expect(actions()[0]!.requires).toMatchObject({ scope: 'player', flag: 'legacy' });
    await user.click(screen.getByRole('button', { name: 'Use run flag condition' }));
    expect(actions()[0]!.requires).toMatchObject({ scope: 'run', flag: 'legacy' });
    await user.selectOptions(screen.getByLabelText('Gate requires flag'), 'key');
    expect(actions()[0]!.requires).toMatchObject({ scope: 'run', flag: 'key' });
  });
});
