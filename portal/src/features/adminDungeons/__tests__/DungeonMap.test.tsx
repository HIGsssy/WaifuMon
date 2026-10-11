import { useState } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonDefinition, DungeonLayout, DungeonReferenceData } from '@/api/adminDungeons';
import * as api from '@/api/adminDungeons';
import { stubObjectUrls } from '@/features/adminArtwork/__tests__/artworkFixtures';
import { DungeonGraphView } from '../DungeonGraphView';
import { fixture, install, renderAt, renderWith, issue, reference } from './dungeonFixtures';

vi.mock('@xyflow/react', async () => (await import('./flowMock')).mockFlow());
beforeEach(() => {
  install();
  stubObjectUrls();
});
function Harness({
  disabled = false,
  initial = fixture().draft,
}: {
  disabled?: boolean;
  initial?: DungeonDefinition;
}) {
  const [d, setD] = useState(initial);
  const [layout, setLayout] = useState<DungeonLayout>(fixture().layout);
  return (
    <>
      <DungeonGraphView
        definition={d}
        layout={layout}
        issues={[]}
        disabled={disabled}
        reference={reference as DungeonReferenceData}
        onChange={(next: DungeonDefinition, l: DungeonLayout) => {
          setD(next);
          setLayout(l);
        }}
      />
      <output data-testid="definition">{JSON.stringify(d)}</output>
      <output data-testid="layout">{JSON.stringify(layout)}</output>
    </>
  );
}
const definition = () =>
  JSON.parse(screen.getByTestId('definition').textContent!) as DungeonDefinition;
const layout = () => JSON.parse(screen.getByTestId('layout').textContent!) as DungeonLayout;
const chooser = () => within(screen.getByRole('dialog'));

describe('room templates and Add next room', () => {
  it('creates each template as a valid room without ever moving the start room', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    for (const label of ['Combat', 'Boss', 'Treasure', 'Rest', 'Exit', 'Empty']) {
      await user.click(screen.getByRole('button', { name: 'Canvas room Entrance' }));
      await user.click(screen.getByRole('button', { name: `Add ${label} room` }));
    }
    const d = definition();
    expect(d.entranceRoomId).toBe('entrance');
    expect(d.rooms.slice(1).map((r) => [r.name, r.kind, r.actions.map((a) => a.type)])).toEqual([
      ['Combat', 'room', ['combat']],
      ['Boss', 'room', ['boss']],
      ['Treasure', 'room', ['reward']],
      ['Rest', 'room', ['rest']],
      ['Exit', 'exit', []],
      ['New room', 'room', []],
    ]);
    // Nothing is picked for the author, and nothing custom is configured.
    expect(d.rooms[1]!.actions[0]).toMatchObject({ waves: [{ enemy: { key: '' } }], outcomes: {} });
    expect(d.rooms[4]!.actions[0]).toMatchObject({ healBasisPoints: 3000 });
    expect(screen.queryByLabelText('New room type')).not.toBeInTheDocument();
  });
  it('adds the next room beside its source, connects it forward and opens it for editing', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add next room after Entrance' }));
    expect(chooser().getByText('What comes after Entrance?')).toBeInTheDocument();
    await user.click(chooser().getByRole('button', { name: 'Combat room' }));
    const [entrance, combat] = definition().rooms;
    expect(definition().connections).toEqual([
      expect.objectContaining({ from: entrance!.id, to: combat!.id, kind: 'path' }),
    ]);
    expect(definition().connections[0]).not.toHaveProperty('requires');
    expect(layout().rooms![combat!.id]).toEqual({ x: 324, y: 8 });
    expect(screen.getByLabelText('Room name')).toHaveValue('Combat');
    expect(screen.getByLabelText('Wave 1 enemy')).toHaveValue('');
    // A second room after the same source is a branch, placed clear of the first.
    await user.click(screen.getByRole('button', { name: 'Add next room after Entrance' }));
    await user.click(chooser().getByRole('button', { name: 'Treasure room' }));
    const treasure = definition().rooms[2]!;
    expect(layout().rooms![treasure.id]).toEqual({ x: 324, y: 178 });
    expect(definition().connections.map((c) => [c.from, c.to])).toEqual([
      ['entrance', combat!.id],
      ['entrance', treasure.id],
    ]);
    // Names are made unique so the outline stays readable.
    await user.click(screen.getByRole('button', { name: 'Add next room after Treasure' }));
    await user.click(chooser().getByRole('button', { name: 'Treasure room' }));
    expect(definition().rooms[3]!.name).toBe('Treasure 2');
  });
  it('offers no way to extend an exit and refuses impossible or repeated paths with a reason', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add next room after Entrance' }));
    await user.click(chooser().getByRole('button', { name: 'Exit room' }));
    expect(screen.queryByRole('button', { name: 'Add next room after Exit' })).toBeNull();
    expect(screen.getByText(/This is an exit\. The run is completed here/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Drag Exit to Entrance' }));
    expect(screen.getByText(/Exit is an exit: the run ends there/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Drag Entrance to Exit' }));
    expect(screen.getByText('Entrance already leads to Exit.')).toBeInTheDocument();
    expect(definition().connections).toHaveLength(1);
  });
  it('connects existing rooms by dragging or from Ways out', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    // With nothing selected a palette room stands alone; after that it follows the selection.
    await user.click(screen.getByRole('button', { name: 'Add Rest room' }));
    expect(definition().connections).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Add Exit room' }));
    const [, rest, exit] = definition().rooms;
    expect(definition().connections.map((c) => [c.from, c.to])).toEqual([[rest!.id, exit!.id]]);
    await user.click(screen.getByRole('button', { name: 'Drag Entrance to Rest' }));
    await user.click(screen.getByRole('button', { name: 'Canvas room Entrance' }));
    const ways = within(screen.getByRole('region', { name: 'Ways out' }));
    expect(
      within(ways.getByLabelText('Connect to existing room'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Connect to an existing room…', 'Exit']);
    await user.selectOptions(ways.getByLabelText('Connect to existing room'), 'Exit');
    await user.click(ways.getByRole('button', { name: 'Connect' }));
    expect(definition().connections.map((c) => [c.from, c.to])).toEqual([
      [rest!.id, exit!.id],
      ['entrance', rest!.id],
      ['entrance', exit!.id],
    ]);
    expect(ways.getByRole('button', { name: 'Open path to Exit' })).toHaveTextContent('Open path');
  });
});

describe('paths', () => {
  it('describes a path as open, locked or hidden over the existing fields', async () => {
    const user = userEvent.setup();
    renderWith(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add next room after Entrance' }));
    await user.click(chooser().getByRole('button', { name: 'Exit room' }));
    await user.click(screen.getByRole('button', { name: 'Select path Entrance → Exit' }));
    const path = () => definition().connections[0]!;
    expect(screen.getByLabelText('Open path')).toBeChecked();
    expect(screen.queryByText(/This path opens when/)).toBeNull();
    await user.click(screen.getByLabelText('Locked path'));
    expect(path()).toMatchObject({
      kind: 'path',
      requires: { type: 'room_completed', roomId: 'entrance' },
    });
    await user.type(screen.getByLabelText('Locked text'), 'Rusted shut');
    await user.click(screen.getByLabelText('Hidden path'));
    expect(path()).toMatchObject({ kind: 'secret', lockedText: 'Rusted shut' });
    expect(path().requires).toEqual({ type: 'room_completed', roomId: 'entrance' });
    expect(screen.getByTestId('flow-edges')).toHaveTextContent('"label":"Hidden"');
    await user.click(screen.getByLabelText('Open path'));
    expect(path().kind).toBe('path');
    expect(path()).not.toHaveProperty('requires');
    // Shortcut stays available, out of the way, and is preserved as stored.
    expect(screen.queryByLabelText('Mark as shortcut')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(screen.getByLabelText('Mark as shortcut'));
    await user.type(screen.getByLabelText('Path button text'), 'Vent');
    expect(path()).toMatchObject({ kind: 'shortcut', label: 'Vent' });
    await user.click(screen.getByRole('button', { name: 'Remove path' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove the path Entrance → Exit?');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove path' }),
    );
    expect(definition().connections).toEqual([]);
  });
  it('explains in names why a room that is still referenced cannot be deleted', async () => {
    const user = userEvent.setup();
    const draft = fixture().draft;
    renderWith(
      <Harness
        initial={{
          ...draft,
          rooms: [
            ...draft.rooms,
            { id: 'r_vault', name: 'Vault', kind: 'exit', actions: [] },
            {
              id: 'r_hall',
              name: 'Hall',
              actions: [
                {
                  id: 'a_gate',
                  type: 'gate',
                  outcomes: {},
                  requires: { type: 'room_completed', roomId: 'r_vault' },
                },
              ],
            },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Canvas room Vault' }));
    await user.click(screen.getByRole('button', { name: 'Delete room' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert')).toHaveTextContent('Hall: Checkpoint (activity 1)');
    expect(dialog.getByRole('alert')).not.toHaveTextContent(/r_vault|a_gate|rooms\[/);
    expect(dialog.getByRole('button', { name: 'Delete room' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Canvas room Hall' }));
    await user.click(screen.getByRole('button', { name: 'Delete room' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete room' }),
    );
    expect(definition().rooms.map((r) => r.name)).toEqual(['Entrance', 'Vault']);
  });
  it('is read-only without write access', async () => {
    const user = userEvent.setup();
    renderWith(<Harness disabled />);
    expect(screen.queryByRole('button', { name: 'Add Combat room' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add next room/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Canvas room Entrance' }));
    expect(screen.getByLabelText('Room name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete room' })).toBeNull();
  });
});

describe('saving the map', () => {
  it('saves layout only on explicit Save and reopens at the persisted position', async () => {
    const w = install();
    const user = userEvent.setup();
    const view = renderAt();
    await screen.findByText('Dungeon map');
    await user.click(screen.getByRole('button', { name: 'Drag room' }));
    await user.click(screen.getByRole('button', { name: 'Pan canvas' }));
    expect(api.saveDungeonDraft).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved dungeon changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    expect(api.saveDungeonDraft).toHaveBeenCalledWith('tunnels', {
      definition: fixture().draft,
      expectedRevision: 4,
      layout: {
        ...fixture().layout,
        rooms: { entrance: { x: 300, y: 120 } },
        viewport: { x: 10, y: 20, zoom: 2 },
      },
    });
    view.unmount();
    renderAt();
    await screen.findByText('Dungeon map');
    expect(screen.getByTestId('flow-nodes')).toHaveTextContent('"x":300');
    expect(w.stored.layout.rooms?.entrance).toEqual({ x: 300, y: 120 });
  });
  it('preserves moved nodes after a 409 and warns before leaving', async () => {
    const { PortalApiError } = await import('@/api/client');
    vi.mocked(api.saveDungeonDraft).mockRejectedValue(
      new PortalApiError({ status: 409, code: 'DUNGEON_DRAFT_STALE', message: 'Stale draft' }),
    );
    const user = userEvent.setup();
    renderAt();
    await screen.findByText('Dungeon map');
    await user.click(screen.getByRole('button', { name: 'Drag room' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText(/A newer draft exists/);
    expect(screen.getByTestId('flow-nodes')).toHaveTextContent('"x":300');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByText('Back to dungeons'));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByText('Dungeon map')).toBeInTheDocument();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it('holds Save until every wave has an enemy, then saves a draft the server accepts', async () => {
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Add next room after Entrance' }));
    await user.click(chooser().getByRole('button', { name: 'Combat room' }));
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Checklist: 1 to finish/ })).toBeInTheDocument();
    expect(screen.getByText('Choose an enemy for every wave to save.')).toBeInTheDocument();
    const outline = within(screen.getByRole('navigation', { name: 'Dungeon outline' }));
    expect(outline.getByText('Combat needs an enemy for wave 1.')).toBeInTheDocument();
    // The half-built fight is never sent anywhere.
    expect(api.validateDungeon).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('Wave 1 enemy'), 'slime');
    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved. Publication is unchanged.');
    const saved = vi.mocked(api.saveDungeonDraft).mock.calls[0]![1].definition!;
    expect(saved.rooms[1]!.actions[0]!.waves).toEqual([{ enemy: { key: 'slime' } }]);
  });
  it('turns server validation into a named, locatable checklist', async () => {
    vi.mocked(api.validateDungeon).mockResolvedValue({
      definition: fixture().draft,
      contentHash: 'hash',
      publishable: false,
      issues: [
        { code: 'no_ending', severity: 'error', path: 'rooms', message: 'no exit room' },
        {
          code: 'room_no_route_to_exit',
          severity: 'error',
          path: 'rooms[0]',
          message: 'room "entrance" has no route to an exit or extraction point',
        },
        {
          ...issue,
          path: 'rooms[0].actions[0].waves[0]',
          message: 'enemy "ghost" is not in the Enemy Catalogue',
        },
      ],
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Add Empty room' }));
    const outline = within(screen.getByRole('navigation', { name: 'Dungeon outline' }));
    expect(await outline.findByText('The dungeon has no ending.')).toBeInTheDocument();
    expect(outline.getByText('Entrance has no way out.')).toBeInTheDocument();
    expect(
      outline.getByText('Connect this room to another room or to an exit.'),
    ).toBeInTheDocument();
    expect(outline.getByText('Fix before publishing')).toBeInTheDocument();
    expect(outline.queryByText(/rooms\[|room_no_route|"entrance"/)).toBeNull();
    expect(screen.getByRole('button', { name: /^Checklist: 3 to fix/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show dungeon settings' }));
    await user.click(outline.getByRole('button', { name: 'Show me: Entrance has no way out.' }));
    expect(screen.getByLabelText('Room name')).toHaveValue('Entrance');
  });
});
