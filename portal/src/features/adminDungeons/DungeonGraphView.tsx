import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeProps,
  type Connection,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  DungeonDefinition,
  DungeonIssue,
  DungeonLayout,
  DungeonReferenceData,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DungeonIssues } from './zoneFormParts';
import { RoomSequenceEditor, RunFlagsEditor } from './RoomSequenceEditor';
import { DungeonConditionEditor } from './DungeonConditionEditor';
import {
  addMapRoom,
  connectMapRooms,
  deleteMapEntity,
  deletionBlockers,
  issueSelection,
  positionOf,
  type MapSelection,
} from './dungeonMapModel';

type RoomNode = Node<
  {
    label: string;
    entrance: boolean;
    kind: string;
    extraction: boolean;
    issues: DungeonIssue[];
    summary: string;
  },
  'dungeonRoom'
>;
function RoomCard({ data, selected }: NodeProps<RoomNode>) {
  return (
    <div
      className={`w-48 rounded-lg border-2 bg-surface p-3 text-ink shadow ${selected ? 'ring-2 ring-accent ring-offset-2' : ''} ${data.issues.some((i) => i.severity === 'error') ? 'border-danger' : data.issues.length ? 'border-amber-500' : 'border-border'}`}
    >
      <Handle type="target" position={Position.Top} aria-label="Incoming connection" />
      <strong>{data.label}</strong>
      <p className="text-xs text-ink-muted">
        {data.entrance ? 'Entrance · ' : ''}
        {data.kind}
        {data.extraction ? ' · Extraction' : ''}
      </p>
      {data.issues.length > 0 && <p className="text-xs">{data.issues.length} validation issues</p>}
      {data.summary && <p className="text-xs text-ink-muted">{data.summary}</p>}
      <Handle type="source" position={Position.Bottom} aria-label="Outgoing connection" />
    </div>
  );
}
const nodeTypes = { dungeonRoom: RoomCard };
export interface DungeonGraphViewProps {
  definition: DungeonDefinition;
  layout: DungeonLayout;
  issues: DungeonIssue[];
  disabled: boolean;
  reference?: DungeonReferenceData | undefined;
  onChange: (definition: DungeonDefinition, layout: DungeonLayout) => void;
}
export function DungeonGraphView({
  definition,
  layout,
  issues,
  disabled,
  reference,
  onChange,
}: DungeonGraphViewProps) {
  const [selection, setSelection] = useState<MapSelection>(null);
  const [roomType, setRoomType] = useState<'room' | 'entrance' | 'exit'>('room');
  const [deleting, setDeleting] = useState<NonNullable<MapSelection> | null>(null);
  const mapped = useMemo(
    () => issues.map((issue) => ({ issue, selection: issueSelection(issue, definition) })),
    [issues, definition],
  );
  const initialNodes = useMemo<RoomNode[]>(
    () =>
      definition.rooms.map((room, index) => ({
        id: room.id,
        type: 'dungeonRoom',
        position: positionOf(layout, room.id, index),
        selected: selection?.kind === 'room' && selection.id === room.id,
        data: {
          label: room.name || room.id,
          entrance: room.id === definition.entranceRoomId,
          kind: room.kind || 'room',
          extraction: room.extraction ?? false,
          summary: Object.entries(
            room.actions.reduce<Record<string, number>>((counts, action) => {
              counts[action.type] = (counts[action.type] ?? 0) + 1;
              return counts;
            }, {}),
          )
            .map(([type, count]) => `${count} ${type}`)
            .join(' · '),
          issues: mapped
            .filter((m) => m.selection?.kind === 'room' && m.selection.id === room.id)
            .map((m) => m.issue),
        },
      })),
    [definition, layout, selection, mapped],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      definition.connections
        .filter(
          (c) =>
            definition.rooms.some((r) => r.id === c.from) &&
            definition.rooms.some((r) => r.id === c.to),
        )
        .map((c) => ({
          id: c.id,
          source: c.from,
          target: c.to,
          label: c.label || c.kind || 'path',
          selected: selection?.kind === 'connection' && selection.id === c.id,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: {
            stroke: mapped.some(
              (m) => m.selection?.kind === 'connection' && m.selection.id === c.id,
            )
              ? '#ef4444'
              : undefined,
            strokeDasharray: c.kind === 'shortcut' ? '6 4' : undefined,
          },
        })),
    [definition, mapped, selection],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => setEdges(initialEdges), [initialEdges, setEdges]);
  const room =
    selection?.kind === 'room' ? definition.rooms.find((r) => r.id === selection.id) : undefined;
  const connection =
    selection?.kind === 'connection'
      ? definition.connections.find((c) => c.id === selection.id)
      : undefined;
  const blockers = deleting ? deletionBlockers(definition, deleting) : [];
  const updateRoom = (patch: Partial<NonNullable<typeof room>>, entrance = false) => {
    if (!room || disabled) return;
    onChange(
      {
        ...definition,
        entranceRoomId: entrance ? room.id : definition.entranceRoomId,
        rooms: definition.rooms.map((r) => (r.id === room.id ? { ...r, ...patch } : r)),
      },
      layout,
    );
  };
  const updateConnection = (patch: Partial<NonNullable<typeof connection>>) => {
    if (!connection || disabled) return;
    onChange(
      {
        ...definition,
        connections: definition.connections.map((c) =>
          c.id === connection.id ? { ...c, ...patch } : c,
        ),
      },
      layout,
    );
  };
  const connect = ({ source, target }: Connection) => {
    if (!disabled && source && target)
      onChange(connectMapRooms(definition, source, target), layout);
  };
  return (
    <Card className="space-y-3 p-4">
      <h2>Dungeon map</h2>
      <p className="text-sm text-ink-muted">
        Drag rooms to position them. Drag from a bottom handle to a top handle to connect rooms.
        Select a room or connection to inspect it.
      </p>
      {!disabled && (
        <div className="flex gap-2">
          <label>
            New room type{' '}
            <select
              aria-label="New room type"
              value={roomType}
              onChange={(e) => setRoomType(e.target.value as typeof roomType)}
            >
              <option value="room">Regular</option>
              <option value="entrance">Entrance</option>
              <option value="exit">Exit</option>
            </select>
          </label>
          <Button
            onClick={() => {
              const added = addMapRoom(definition, layout, roomType);
              onChange(added.definition, added.layout);
              setSelection({ kind: 'room', id: added.id });
            }}
          >
            Add room
          </Button>
        </div>
      )}
      {definition.rooms.length === 0 && (
        <p role="status">
          No rooms yet. Add an entrance room, then connect it to regular rooms and an exit.
        </p>
      )}
      <div
        className="h-[520px] rounded border border-border bg-surface-sunken"
        aria-label="Dungeon map canvas"
      >
        <ReactFlow<RoomNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onNodeClick={(_, node) => setSelection({ kind: 'room', id: node.id })}
          onEdgeClick={(_, edge) => setSelection({ kind: 'connection', id: edge.id })}
          onPaneClick={() => setSelection(null)}
          onNodeDragStop={(_, node) => {
            if (!disabled)
              onChange(definition, {
                ...layout,
                rooms: { ...layout.rooms, [node.id]: node.position },
              });
          }}
          onMoveEnd={(event, viewport) => {
            if (event && !disabled) onChange(definition, { ...layout, viewport });
          }}
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          edgesReconnectable={false}
          deleteKeyCode={null}
          defaultViewport={layout.viewport ?? { x: 0, y: 0, zoom: 1 }}
          fitView={!layout.viewport}
          minZoom={0.05}
          maxZoom={4}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
        <div>
          <h3>Map elements</h3>
          <p className="text-xs text-ink-muted">
            These controls also select rooms and connections without using the canvas.
          </p>
          <ul>
            {definition.rooms.map((r) => (
              <li key={r.id}>
                <Button
                  variant="ghost"
                  aria-pressed={selection?.kind === 'room' && selection.id === r.id}
                  onClick={() => setSelection({ kind: 'room', id: r.id })}
                >
                  Select room {r.name || r.id}
                </Button>
              </li>
            ))}
          </ul>
          <ul>
            {definition.connections.map((c) => (
              <li key={c.id}>
                <Button
                  variant="ghost"
                  aria-pressed={selection?.kind === 'connection' && selection.id === c.id}
                  onClick={() => setSelection({ kind: 'connection', id: c.id })}
                >
                  Select connection {c.label || c.id} ({c.from} → {c.to})
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-3" aria-label="Map inspector">
          {!room && !connection && <p>Select a room or connection to edit its map properties.</p>}
          {room && (
            <fieldset disabled={disabled} className="space-y-3">
              <legend>Room inspector: {room.id}</legend>
              <label className="block">
                Room name
                <Input
                  aria-label="Room name"
                  maxLength={80}
                  value={room.name ?? ''}
                  onChange={(e) => updateRoom({ name: e.target.value })}
                />
              </label>
              <label>
                Room kind{' '}
                <select
                  aria-label="Room kind"
                  value={room.kind ?? 'room'}
                  onChange={(e) => updateRoom({ kind: e.target.value as 'room' | 'exit' })}
                >
                  <option value="room">Regular</option>
                  <option value="exit">Exit</option>
                </select>
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  aria-label="Entrance room"
                  checked={definition.entranceRoomId === room.id}
                  disabled={disabled || definition.entranceRoomId === room.id}
                  onChange={() => updateRoom({}, true)}
                />{' '}
                Entrance room
              </label>
              <label className="block">
                <input
                  type="checkbox"
                  aria-label="Extraction point"
                  checked={room.extraction ?? false}
                  onChange={(e) => updateRoom({ extraction: e.target.checked })}
                />{' '}
                Extraction point
              </label>
              <label className="block">
                Room description
                <textarea
                  aria-label="Room description"
                  className="w-full border p-2"
                  maxLength={600}
                  value={room.description ?? ''}
                  onChange={(e) => updateRoom({ description: e.target.value })}
                />
              </label>
              <Button variant="outline" onClick={() => setDeleting({ kind: 'room', id: room.id })}>
                Delete room
              </Button>
            </fieldset>
          )}
          {room && (
            <>
              <RunFlagsEditor
                definition={definition}
                disabled={disabled}
                onChange={(next) => !disabled && onChange(next, layout)}
              />
              <RoomSequenceEditor
                key={room.id}
                room={room}
                definition={definition}
                reference={reference}
                issues={issues}
                disabled={disabled}
                onChange={(next) => !disabled && onChange(next, layout)}
              />
            </>
          )}
          {connection && (
            <fieldset disabled={disabled} className="space-y-3">
              <legend>Connection inspector: {connection.id}</legend>
              {(['from', 'to'] as const).map((field) => (
                <label key={field} className="block">
                  {field === 'from' ? 'Source room' : 'Destination room'}{' '}
                  <select
                    aria-label={field === 'from' ? 'Source room' : 'Destination room'}
                    value={connection[field]}
                    onChange={(e) => updateConnection({ [field]: e.target.value })}
                  >
                    {!definition.rooms.some((r) => r.id === connection[field]) && (
                      <option value={connection[field]}>Missing: {connection[field]}</option>
                    )}
                    {definition.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name || r.id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="block">
                Connection label
                <Input
                  aria-label="Connection label"
                  maxLength={80}
                  value={connection.label ?? ''}
                  onChange={(e) => updateConnection({ label: e.target.value })}
                />
              </label>
              <label>
                Connection kind{' '}
                <select
                  aria-label="Connection kind"
                  value={connection.kind ?? 'path'}
                  onChange={(e) =>
                    updateConnection({ kind: e.target.value as 'path' | 'shortcut' | 'secret' })
                  }
                >
                  <option value="path">Path</option>
                  <option value="shortcut">Shortcut</option>
                  <option value="secret">Secret</option>
                </select>
              </label>
              <label className="block">
                Locked text
                <Input
                  aria-label="Locked text"
                  maxLength={200}
                  value={connection.lockedText ?? ''}
                  onChange={(e) => updateConnection({ lockedText: e.target.value })}
                />
              </label>
              <DungeonConditionEditor
                label="Connection requires"
                value={
                  connection.requires as import('@/api/adminDungeons').DungeonCondition | undefined
                }
                definition={definition}
                onChange={(requires) => {
                  if (disabled) return;
                  const next = { ...connection };
                  if (requires) next.requires = requires;
                  else delete next.requires;
                  onChange(
                    {
                      ...definition,
                      connections: definition.connections.map((c) => (c.id === next.id ? next : c)),
                    },
                    layout,
                  );
                }}
              />
              <Button
                variant="outline"
                onClick={() => setDeleting({ kind: 'connection', id: connection.id })}
              >
                Remove connection
              </Button>
            </fieldset>
          )}
          <DungeonIssues
            issues={mapped
              .filter(
                (m) =>
                  selection &&
                  m.selection?.kind === selection.kind &&
                  m.selection?.id === selection.id,
              )
              .map((m) => m.issue)}
          />
        </div>
      </div>
      {issues.length > 0 && (
        <div>
          <h3>Map validation</h3>
          <p className="text-xs text-ink-muted">
            Validation comes from the server. Global issues are listed even when they cannot be
            highlighted on the canvas.
          </p>
          <ul>
            {mapped.map((m, index) => (
              <li key={index}>
                {m.selection && (
                  <Button variant="ghost" onClick={() => setSelection(m.selection)}>
                    Locate issue {index + 1}
                  </Button>
                )}{' '}
                {m.issue.severity}: {m.issue.path || 'definition'} — {m.issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <Card className="space-y-3 p-6">
            <DialogTitle>
              Delete {deleting?.kind} {deleting?.id}?
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === 'room'
                ? 'The room, its actions, and attached connections will be removed. Deleting the entrance requires choosing another entrance before publication.'
                : 'This connection will be removed.'}
            </DialogDescription>
            {blockers.length > 0 && (
              <div role="alert">
                Deletion blocked by authored references. Repair these references before deleting:
                <ul>
                  {blockers.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              disabled={disabled || blockers.length > 0}
              onClick={() => {
                if (deleting && !disabled) {
                  const next = deleteMapEntity(definition, layout, deleting);
                  onChange(next.definition, next.layout);
                  setSelection(null);
                  setDeleting(null);
                }
              }}
            >
              Confirm deletion
            </Button>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel deletion
            </Button>
          </Card>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
