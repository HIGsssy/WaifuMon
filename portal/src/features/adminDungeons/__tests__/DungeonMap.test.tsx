import { useState } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DungeonDefinition, DungeonLayout } from '@/api/adminDungeons';
import * as api from '@/api/adminDungeons';
import { DungeonGraphView } from '../DungeonGraphView';
import { fixture, install, renderAt, issue } from './dungeonFixtures';
// jsdom cannot lay out handles: exercise the exact canvas callbacks while
// keeping inspector, transformations, saving and conflict handling real.
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    Handle: () => null,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ReactFlow: ({
      nodes,
      edges,
      onConnect,
      onNodeDragStop,
      onMoveEnd,
    }: {
      nodes: Array<{ id: string; position: { x: number; y: number } }>;
      edges: Array<{ id: string }>;
      onConnect: (c: { source: string; target: string }) => void;
      onNodeDragStop: (e: null, n: { id: string; position: { x: number; y: number } }) => void;
      onMoveEnd: (e: MouseEvent, v: { x: number; y: number; zoom: number }) => void;
    }) => (
      <div data-testid="flow">
        <output data-testid="flow-nodes">{JSON.stringify(nodes)}</output>
        <output data-testid="flow-edges">{JSON.stringify(edges)}</output>
        <button
          onClick={() => nodes[1] && onConnect({ source: nodes[0]!.id, target: nodes[1].id })}
        >
          Drag connection
        </button>
        <button
          onClick={() => onNodeDragStop(null, { id: nodes[0]!.id, position: { x: 300, y: 120 } })}
        >
          Drag room
        </button>
        <button onClick={() => onMoveEnd(new MouseEvent('move'), { x: 10, y: 20, zoom: 2 })}>
          Pan canvas
        </button>
      </div>
    ),
  };
});
beforeEach(() => install());
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [d, setD] = useState(fixture().draft);
  const [layout, setLayout] = useState<DungeonLayout>(fixture().layout);
  return (
    <>
      <DungeonGraphView
        definition={d}
        layout={layout}
        issues={[issue]}
        disabled={disabled}
        onChange={(next: DungeonDefinition, l: DungeonLayout) => {
          setD(next);
          setLayout(l);
        }}
      />
      <output data-testid="definition">{JSON.stringify(d)}</output>
    </>
  );
}
const definition = () =>
  JSON.parse(screen.getByTestId('definition').textContent!) as DungeonDefinition;
describe('map interaction and persistence', () => {
  it('adds, selects, renames, designates entrance, and confirms deletion', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    const id = definition().rooms[1]!.id;
    await user.clear(screen.getByLabelText('Room name'));
    await user.type(screen.getByLabelText('Room name'), 'Vault');
    expect(definition().rooms[1]!.id).toBe(id);
    await user.click(screen.getByLabelText('Entrance room'));
    expect(definition().entranceRoomId).toBe(id);
    await user.selectOptions(screen.getByLabelText('Room kind'), 'exit');
    await user.click(screen.getByLabelText('Extraction point'));
    expect(definition().rooms[1]).toMatchObject({ kind: 'exit', extraction: true });
    await user.click(screen.getByRole('button', { name: 'Delete room' }));
    expect(definition().rooms).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(definition().rooms).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Delete room' }));
    await user.click(screen.getByRole('button', { name: 'Confirm deletion' }));
    expect(definition().rooms).toHaveLength(1);
  });
  it('creates a connection by dragging, edits it and removes it explicitly', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    await user.click(screen.getByRole('button', { name: 'Drag connection' }));
    const id = definition().connections[0]!.id;
    await user.click(screen.getByRole('button', { name: new RegExp(`Select connection ${id}`) }));
    await user.type(screen.getByLabelText('Connection label'), 'Shortcut');
    await user.selectOptions(screen.getByLabelText('Connection kind'), 'shortcut');
    expect(definition().connections[0]).toMatchObject({ id, label: 'Shortcut', kind: 'shortcut' });
    await user.click(screen.getByRole('button', { name: 'Remove connection' }));
    await user.click(screen.getByRole('button', { name: 'Confirm deletion' }));
    expect(definition().connections).toEqual([]);
  });
  it('locates server issues in the room inspector and preserves read-only viewing', async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    expect(screen.queryByRole('button', { name: 'Add room' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Locate issue 1' }));
    expect(screen.getByLabelText('Room name')).toBeDisabled();
    expect(screen.getByTestId('flow-nodes')).toHaveTextContent('enemy_missing');
  });
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
  it('validates map changes on the server and shows current issues', async () => {
    vi.mocked(api.validateDungeon).mockResolvedValue({
      definition: fixture().draft,
      contentHash: 'hash',
      publishable: false,
      issues: [{ code: 'no_ending', severity: 'error', path: 'rooms', message: 'Missing exit' }],
    });
    const user = userEvent.setup();
    renderAt();
    await screen.findByText('Dungeon map');
    await user.click(screen.getByRole('button', { name: 'Add room' }));
    await waitFor(() => expect(api.validateDungeon).toHaveBeenCalled());
    expect((await screen.findAllByText(/error: rooms — Missing exit/))[0]).toBeInTheDocument();
  });
});
