import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type ReactFlowInstance,
} from '@xyflow/react';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
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
  /** Shown in the inspector while nothing on the map is selected. */
  settings?: ReactNode;
  /** Bumped by the page to bring the problem list into view. */
  problemsRequest?: number;
}
function OutlineSection({
  title,
  count,
  children,
  request,
}: {
  title: string;
  count: number;
  children: ReactNode;
  /** Re-opens the section and moves focus to it whenever it changes. */
  request?: number | undefined;
}) {
  const [open, setOpen] = useState(true);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!request) return;
    setOpen(true);
    // The outline itself may still be collapsed in this commit.
    const timer = window.setTimeout(() => toggle.current?.focus());
    return () => window.clearTimeout(timer);
  }, [request]);
  return (
    <section className="border-b border-border last:border-b-0">
      <h3>
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {title}
          <span className="ml-auto font-normal">{count}</span>
        </button>
      </h3>
      {open && <div className="px-2 pb-2">{children}</div>}
    </section>
  );
}
const outlineRow = (selected: boolean) =>
  `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-raised hover:text-ink'}`;
export function DungeonGraphView({
  definition,
  layout,
  issues,
  disabled,
  reference,
  onChange,
  settings,
  problemsRequest,
}: DungeonGraphViewProps) {
  const [selection, setSelection] = useState<MapSelection>(null);
  const [roomType, setRoomType] = useState<'room' | 'entrance' | 'exit'>('room');
  const [deleting, setDeleting] = useState<NonNullable<MapSelection> | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const flow = useRef<ReactFlowInstance<RoomNode, Edge> | null>(null);
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => {
    if (problemsRequest) setOutlineOpen(true);
  }, [problemsRequest]);
  useEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0;
  }, [selection?.kind, selection?.id]);
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
  const roomName = (id: string) => definition.rooms.find((r) => r.id === id)?.name || id;
  /** Select from outside the canvas, and bring what was selected into view on it. */
  const locate = (next: NonNullable<MapSelection>) => {
    setSelection(next);
    const target = definition.connections.find((c) => c.id === next.id);
    const ids = next.kind === 'room' ? [next.id] : target ? [target.from, target.to] : [];
    if (ids.length)
      void flow.current?.fitView({
        nodes: ids.map((id) => ({ id })),
        duration: 250,
        maxZoom: 1,
        padding: 0.4,
      });
  };
  const connect = ({ source, target }: Connection) => {
    if (!disabled && source && target)
      onChange(connectMapRooms(definition, source, target), layout);
  };
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface lg:flex-row">
      <nav
        aria-label="Dungeon outline"
        hidden={!outlineOpen}
        className={`max-h-80 shrink-0 flex-col border-b border-border lg:max-h-none lg:w-48 lg:border-r lg:border-b-0 ${outlineOpen ? 'flex' : 'hidden'}`}
      >
        <div className="flex items-center justify-between border-b border-border py-1 pr-1 pl-3">
          <h2 className="text-sm font-semibold">Outline</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Hide outline"
            onClick={() => setOutlineOpen(false)}
          >
            <PanelLeftClose />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Room palette: the Phase 1B.5C room templates replace this control. */}
          {!disabled && (
            <section aria-label="Room palette" className="space-y-2 border-b border-border p-3">
              <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Add room
              </h3>
              <label className="block text-sm">
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
                size="sm"
                onClick={() => {
                  const added = addMapRoom(definition, layout, roomType);
                  onChange(added.definition, added.layout);
                  setSelection({ kind: 'room', id: added.id });
                }}
              >
                Add room
              </Button>
            </section>
          )}
          <OutlineSection title="Rooms" count={definition.rooms.length}>
            <ul>
              {definition.rooms.map((r) => {
                const selected = selection?.kind === 'room' && selection.id === r.id;
                const problems = mapped.filter(
                  (m) => m.selection?.kind === 'room' && m.selection.id === r.id,
                ).length;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-label={`Select room ${r.name || r.id}`}
                      aria-pressed={selected}
                      className={outlineRow(selected)}
                      onClick={() => locate({ kind: 'room', id: r.id })}
                    >
                      <span className="min-w-0 flex-1 truncate">{r.name || r.id}</span>
                      {r.id === definition.entranceRoomId && (
                        <span className="text-[0.65rem] tracking-wide text-ink-subtle uppercase">
                          Start
                        </span>
                      )}
                      {problems > 0 && <span className="text-xs text-danger">{problems}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </OutlineSection>
          <OutlineSection title="Connections" count={definition.connections.length}>
            {definition.connections.length === 0 && (
              <p className="px-2 text-xs text-ink-muted">No connections yet.</p>
            )}
            <ul>
              {definition.connections.map((c) => {
                const selected = selection?.kind === 'connection' && selection.id === c.id;
                const route = `${roomName(c.from)} → ${roomName(c.to)}`;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-label={`Select connection ${c.label ? `${c.label} (${route})` : route}`}
                      aria-pressed={selected}
                      className={outlineRow(selected)}
                      onClick={() => locate({ kind: 'connection', id: c.id })}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {c.label ? `${c.label}: ${route}` : route}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </OutlineSection>
          <OutlineSection title="Problems" count={issues.length} request={problemsRequest}>
            {issues.length === 0 && (
              <p className="px-2 text-xs text-ink-muted">No validation issues.</p>
            )}
            <ul className="space-y-2 px-2 text-xs">
              {mapped.map((m, index) => (
                <li
                  key={index}
                  className={`break-words ${m.issue.severity === 'error' ? 'text-danger' : 'text-ink-muted'}`}
                >
                  {m.issue.severity}: {m.issue.path || 'definition'} — {m.issue.message}
                  {m.selection && (
                    <Button
                      variant="link"
                      size="sm"
                      className="block h-auto px-0 sm:h-auto"
                      onClick={() => locate(m.selection!)}
                    >
                      Locate issue {index + 1}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </OutlineSection>
        </div>
      </nav>
      {!outlineOpen && (
        <div className="shrink-0 border-b border-border p-1 lg:border-r lg:border-b-0">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Show outline"
            onClick={() => setOutlineOpen(true)}
          >
            <PanelLeftOpen />
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-3 border-b border-border px-3 py-2">
          <h2 className="shrink-0 text-sm font-semibold">Dungeon map</h2>
          <p className="truncate text-xs text-ink-muted">
            Drag rooms to position them. Drag from a bottom handle to a top handle to connect rooms.
            Select a room or connection to inspect it.
          </p>
        </div>
        {definition.rooms.length === 0 && (
          <p role="status" className="border-b border-border px-3 py-2 text-sm">
            No rooms yet. Add an entrance room, then connect it to regular rooms and an exit.
          </p>
        )}
        <div
          className="relative h-[70dvh] min-h-96 bg-surface-sunken lg:h-auto lg:min-h-0 lg:flex-1"
          aria-label="Dungeon map canvas"
        >
          <div className="absolute inset-0">
            <ReactFlow<RoomNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              onInit={(instance) => {
                flow.current = instance;
              }}
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
        </div>
      </div>
      <aside
        ref={inspector}
        aria-label="Map inspector"
        className="shrink-0 space-y-3 border-t border-border p-4 lg:w-80 lg:overflow-y-auto lg:overscroll-contain lg:border-t-0 lg:border-l xl:w-[22rem] min-[90rem]:w-[25rem]"
      >
        {(room || connection) && settings && (
          <Button variant="ghost" size="sm" onClick={() => setSelection(null)}>
            Show dungeon settings
          </Button>
        )}
        {!room &&
          !connection &&
          (settings ?? <p>Select a room or connection to edit its map properties.</p>)}
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
      </aside>
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
    </div>
  );
}
