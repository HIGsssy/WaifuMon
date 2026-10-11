/**
 * The dungeon workspace: an outline and room palette on the left, the map in
 * the middle, and the inspector for whatever is selected on the right.
 *
 * Rooms are created from gameplay templates and extended with "Add next
 * room", which places and connects the new room. The canvas is presentation
 * only: every edit goes through the definition and layout handed to `onChange`.
 */
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
import '@xyflow/react/dist/style.css';
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import type {
  DungeonDefinition,
  DungeonIssue,
  DungeonLayout,
  DungeonReferenceData,
} from '@/api/adminDungeons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ConnectionInspector } from './ConnectionInspector';
import { RoomInspector } from './RoomInspector';
import {
  connectMapRooms,
  deleteMapEntity,
  deletionBlockers,
  positionOf,
  type MapSelection,
} from './dungeonMapModel';
import {
  ROOM_TEMPLATES,
  addTemplateRoom,
  connectionProblem,
  roomPresentation,
  type RoomTemplateId,
} from './dungeonRoomTemplates';
import {
  describePath,
  friendlyIssue,
  pathState,
  roomLabel,
  roomNameOf,
  roomSummary,
  type FriendlyIssue,
} from './dungeonText';

type RoomNode = Node<
  {
    name: string;
    type: string;
    icon: LucideIcon;
    start: boolean;
    exit: boolean;
    summary: string;
    blocking: number;
    review: number;
    /** Absent on exits and in a read-only editor. */
    onAddNext?: (() => void) | undefined;
  },
  'dungeonRoom'
>;
function RoomCard({ data, selected }: NodeProps<RoomNode>) {
  const Icon = data.icon;
  return (
    <div
      className={`relative w-52 rounded-xl border-2 bg-surface p-3 text-ink shadow ${selected ? 'ring-2 ring-accent ring-offset-2' : ''} ${data.blocking ? 'border-danger' : 'border-border'}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !border-2 !border-surface !bg-ink-subtle"
        aria-label="Arrives here"
      />
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Icon className="size-3.5" />
        {data.type}
        {data.start && (
          <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide text-accent-ink uppercase">
            Start
          </span>
        )}
      </p>
      <strong className="block truncate">{data.name}</strong>
      <p className="line-clamp-2 text-xs text-ink-muted">{data.summary}</p>
      {data.blocking > 0 && <p className="mt-1 text-xs text-danger">{data.blocking} to fix</p>}
      {data.blocking === 0 && data.review > 0 && (
        <p className="mt-1 text-xs text-ink-muted">{data.review} to review</p>
      )}
      <Handle
        type="source"
        position={Position.Right}
        // Nothing leads on from an exit; the handle stays only so a stored path can still be drawn.
        isConnectable={!data.exit}
        isConnectableStart={!data.exit}
        className={`!size-3 !border-2 !border-surface !bg-accent ${data.exit ? '!opacity-0' : ''}`}
        aria-label="Drag to another room to connect"
      />
      {data.onAddNext && (
        <button
          type="button"
          aria-label={`Add next room after ${data.name}`}
          title="Add next room"
          className="nodrag nopan absolute top-1/2 -right-11 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent bg-surface text-accent shadow hover:bg-accent hover:text-accent-ink"
          onClick={(e) => {
            e.stopPropagation();
            data.onAddNext?.();
          }}
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
}
const nodeTypes = { dungeonRoom: RoomCard };

export interface DungeonGraphViewProps {
  definition: DungeonDefinition;
  layout: DungeonLayout;
  /** The server's issues plus the editor's own "not finished yet" items. */
  issues: DungeonIssue[];
  disabled: boolean;
  reference?: DungeonReferenceData | undefined;
  onChange: (definition: DungeonDefinition, layout: DungeonLayout) => void;
  /** Shown in the inspector while nothing on the map is selected. */
  settings?: ReactNode;
  /** Bumped by the page to bring the checklist into view. */
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
const LEVELS = [
  ['finish', 'Finish before saving'],
  ['fix', 'Fix before publishing'],
  ['review', 'Worth a look'],
] as const;

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
  const [deleting, setDeleting] = useState<NonNullable<MapSelection> | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  /** The template chooser: `from` is the room the new one follows, if any. */
  const [adding, setAdding] = useState<{ from: string | null } | null>(null);
  const [created, setCreated] = useState(0);
  const [focusAction, setFocusAction] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const flow = useRef<ReactFlowInstance<RoomNode, Edge> | null>(null);
  const inspector = useRef<HTMLElement>(null);
  useEffect(() => {
    if (problemsRequest) setOutlineOpen(true);
  }, [problemsRequest]);
  useEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0;
  }, [selection?.kind, selection?.id]);
  const friendly = useMemo<FriendlyIssue[]>(
    () => issues.map((issue) => friendlyIssue(issue, definition, reference)),
    [issues, definition, reference],
  );
  const issuesAt = (kind: 'room' | 'connection', id: string) =>
    friendly.filter((f) => f.target?.kind === kind && f.target.id === id);

  const initialNodes = useMemo<RoomNode[]>(
    () =>
      definition.rooms.map((room, index) => {
        const here = friendly.filter((f) => f.target?.kind === 'room' && f.target.id === room.id);
        const presentation = roomPresentation(room);
        return {
          id: room.id,
          type: 'dungeonRoom',
          position: positionOf(layout, room.id, index),
          selected: selection?.kind === 'room' && selection.id === room.id,
          data: {
            name: roomLabel(room),
            type: presentation.label,
            icon: presentation.icon,
            start: room.id === definition.entranceRoomId,
            exit: room.kind === 'exit',
            summary: roomSummary(room, definition, reference),
            blocking: here.filter((f) => f.level !== 'review').length,
            review: here.filter((f) => f.level === 'review').length,
            onAddNext:
              !disabled && room.kind !== 'exit' ? () => setAdding({ from: room.id }) : undefined,
          },
        };
      }),
    [definition, layout, selection, friendly, reference, disabled],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      definition.connections
        .filter(
          (c) =>
            definition.rooms.some((r) => r.id === c.from) &&
            definition.rooms.some((r) => r.id === c.to),
        )
        .map((c) => {
          const state = pathState(c);
          const broken = friendly.some(
            (f) => f.level !== 'review' && f.target?.kind === 'connection' && f.target.id === c.id,
          );
          const text = [state === 'open' ? '' : state === 'locked' ? 'Locked' : 'Hidden', c.label]
            .filter(Boolean)
            .join(': ');
          const stroke = broken ? '#ef4444' : state === 'open' ? '#8b8794' : '#d97706';
          return {
            id: c.id,
            source: c.from,
            target: c.to,
            ...(text ? { label: text } : {}),
            selected: selection?.kind === 'connection' && selection.id === c.id,
            markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 },
            style: {
              stroke,
              strokeWidth: 2,
              ...(state === 'hidden' ? { strokeDasharray: '6 5' } : {}),
            },
          };
        }),
    [definition, friendly, selection],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  // Rebuilt cards keep the size React Flow measured for them; without it every
  // edit would briefly un-measure the map and drop its edges.
  useEffect(
    () =>
      setNodes((previous) =>
        initialNodes.map((node) => {
          const measured = previous.find((p) => p.id === node.id)?.measured;
          return measured ? { ...node, measured } : node;
        }),
      ),
    [initialNodes, setNodes],
  );
  // A room that was just created is shown as soon as its card has a size.
  const pendingShow = useRef<string[] | null>(null);
  useEffect(() => {
    const ids = pendingShow.current;
    if (!ids || !ids.every((id) => nodes.find((n) => n.id === id)?.measured?.width)) return;
    pendingShow.current = null;
    void flow.current?.fitView({
      nodes: ids.map((id) => ({ id })),
      duration: 250,
      maxZoom: 1,
      padding: 0.4,
    });
  }, [nodes]);
  useEffect(() => setEdges(initialEdges), [initialEdges, setEdges]);
  const room =
    selection?.kind === 'room' ? definition.rooms.find((r) => r.id === selection.id) : undefined;
  const connection =
    selection?.kind === 'connection'
      ? definition.connections.find((c) => c.id === selection.id)
      : undefined;
  const blockers = deleting ? deletionBlockers(definition, deleting) : [];
  const show = (ids: string[]) => {
    if (ids.length)
      void flow.current?.fitView({
        nodes: ids.map((id) => ({ id })),
        duration: 250,
        maxZoom: 1,
        padding: 0.4,
      });
  };
  /** Select from outside the canvas, and bring what was selected into view on it. */
  const locate = (next: NonNullable<MapSelection>, actionId: string | null = null) => {
    setSelection(next);
    setFocusAction(actionId);
    const target = definition.connections.find((c) => c.id === next.id);
    show(next.kind === 'room' ? [next.id] : target ? [target.from, target.to] : []);
  };
  const connect = ({ source, target }: Connection) => {
    if (disabled || !source || !target) return;
    // A refused connection says why instead of doing nothing or drawing it anyway.
    const problem = connectionProblem(definition, source, target);
    setNotice(problem ?? '');
    if (!problem) onChange(connectMapRooms(definition, source, target), layout);
  };
  /** Create a room from a template, after `from` when given, and select it for editing. */
  const addRoom = (template: RoomTemplateId, from: string | null) => {
    const added = addTemplateRoom(definition, layout, template, from);
    onChange(added.definition, added.layout);
    setSelection({ kind: 'room', id: added.id });
    setFocusAction(null);
    setCreated((n) => n + 1);
    setAdding(null);
    setNotice('');
    pendingShow.current = from ? [from, added.id] : [added.id];
  };
  const paletteFrom = room && !disabled && room.kind !== 'exit' ? room.id : null;
  const levels = LEVELS.map(([level, title]) => ({
    title,
    items: friendly.filter((f) => f.level === level),
  })).filter((group) => group.items.length);
  const deletingPath = definition.connections.find((c) => c.id === deleting?.id);
  const deletingName =
    deleting?.kind === 'room'
      ? roomNameOf(definition, deleting.id)
      : deletingPath
        ? `the path ${roomNameOf(definition, deletingPath.from)} → ${roomNameOf(definition, deletingPath.to)}`
        : 'this path';

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
          {!disabled && (
            <section aria-label="Room palette" className="space-y-2 border-b border-border p-3">
              <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                Add room
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {ROOM_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Add ${t.label} room`}
                    title={t.hint}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-surface-raised"
                    onClick={() => addRoom(t.id, paletteFrom)}
                  >
                    <t.icon className="size-3.5 shrink-0" />
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-muted">
                {paletteFrom
                  ? `Added after ${roomNameOf(definition, paletteFrom)} and connected to it.`
                  : 'Added on its own. Select a room first to add the next room after it.'}
              </p>
            </section>
          )}
          <OutlineSection title="Rooms" count={definition.rooms.length}>
            <ul>
              {definition.rooms.map((r) => {
                const selected = selection?.kind === 'room' && selection.id === r.id;
                const blocking = issuesAt('room', r.id).filter((f) => f.level !== 'review').length;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-label={`Select room ${roomLabel(r)}`}
                      aria-pressed={selected}
                      className={outlineRow(selected)}
                      onClick={() => locate({ kind: 'room', id: r.id })}
                    >
                      <span className="min-w-0 flex-1 truncate">{roomLabel(r)}</span>
                      {r.id === definition.entranceRoomId && (
                        <span className="text-[0.65rem] tracking-wide text-ink-subtle uppercase">
                          Start
                        </span>
                      )}
                      {blocking > 0 && <span className="text-xs text-danger">{blocking}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </OutlineSection>
          <OutlineSection title="Paths" count={definition.connections.length}>
            {definition.connections.length === 0 && (
              <p className="px-2 text-xs text-ink-muted">No paths yet.</p>
            )}
            <ul>
              {definition.connections.map((c) => {
                const selected = selection?.kind === 'connection' && selection.id === c.id;
                const route = `${roomNameOf(definition, c.from)} → ${roomNameOf(definition, c.to)}`;
                const state = pathState(c);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-label={`Select path ${route}${c.label ? ` (${c.label})` : ''}`}
                      aria-pressed={selected}
                      className={outlineRow(selected)}
                      onClick={() => locate({ kind: 'connection', id: c.id })}
                    >
                      <span className="min-w-0 flex-1 truncate">{route}</span>
                      {state !== 'open' && (
                        <span className="text-[0.65rem] tracking-wide text-ink-subtle uppercase">
                          {state}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </OutlineSection>
          <OutlineSection title="To do" count={friendly.length} request={problemsRequest}>
            {friendly.length === 0 && (
              <p className="px-2 text-xs text-ink-muted">Nothing left to do.</p>
            )}
            {levels.map((group) => (
              <div key={group.title} className="mb-2 px-2">
                <h4 className="text-[0.7rem] font-semibold text-ink-muted">{group.title}</h4>
                <ul className="space-y-2 text-xs">
                  {group.items.map((f, index) => (
                    <li
                      key={index}
                      // The server's own wording stays one hover away for support.
                      title={`${f.issue.code} · ${f.issue.path || 'dungeon'} · ${f.issue.message}`}
                      className="break-words"
                    >
                      <span className={f.level === 'review' ? 'text-ink' : 'text-danger'}>
                        {f.title}
                      </span>{' '}
                      <span className="text-ink-muted">{f.help}</span>
                      {f.target && (
                        <Button
                          variant="link"
                          size="sm"
                          className="block h-auto px-0 sm:h-auto"
                          aria-label={`Show me: ${f.title}`}
                          onClick={() => locate(f.target!, f.actionId)}
                        >
                          Show me
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
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
          {notice ? (
            <p role="status" className="truncate text-xs text-danger">
              {notice}
            </p>
          ) : (
            <p className="truncate text-xs text-ink-muted">
              Press + on a room to add the next one. Drag from a room’s right dot onto another room
              to connect them.
            </p>
          )}
        </div>
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
              onNodeClick={(_, node) => {
                setSelection({ kind: 'room', id: node.id });
                setFocusAction(null);
              }}
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
              fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
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
        {!room && !connection && (settings ?? <p>Select a room or path on the map to edit it.</p>)}
        {room && (
          <RoomInspector
            key={room.id}
            room={room}
            definition={definition}
            reference={reference}
            issues={issuesAt('room', room.id)}
            disabled={disabled}
            focusName={created}
            focusActionId={focusAction}
            onChange={(next) => !disabled && onChange(next, layout)}
            onSelect={(next) => next && locate(next)}
            onAddNext={() => setAdding({ from: room.id })}
            onDelete={() => setDeleting({ kind: 'room', id: room.id })}
          />
        )}
        {connection && (
          <ConnectionInspector
            key={connection.id}
            connection={connection}
            definition={definition}
            issues={issuesAt('connection', connection.id)}
            disabled={disabled}
            onChange={(next) => !disabled && onChange(next, layout)}
            onDelete={() => setDeleting({ kind: 'connection', id: connection.id })}
          />
        )}
      </aside>
      <Dialog open={adding !== null} onOpenChange={(open) => !open && setAdding(null)}>
        <DialogContent
          // Focus goes to the new room's name rather than back to the "+" button.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DialogTitle>
            {adding?.from
              ? `What comes after ${roomNameOf(definition, adding.from)}?`
              : 'What kind of room?'}
          </DialogTitle>
          <DialogDescription>
            The new room is placed next to it and connected automatically. You can add more
            activities to any room later.
          </DialogDescription>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {ROOM_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-label={`${t.label} room`}
                className="flex items-start gap-2 rounded-lg border border-border p-3 text-left hover:border-accent hover:bg-surface-raised"
                onClick={() => addRoom(t.id, adding?.from ?? null)}
              >
                <t.icon className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block text-xs text-ink-muted">{t.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogTitle>
            {deleting?.kind === 'room' ? `Delete ${deletingName}?` : `Remove ${deletingName}?`}
          </DialogTitle>
          <DialogDescription>
            {deleting?.kind === 'room'
              ? `The room, everything that happens in it and its paths are removed.${deleting.id === definition.entranceRoomId ? ' It is the start room, so choose another start room afterwards.' : ''}`
              : 'Players will no longer be able to go this way.'}
          </DialogDescription>
          {blockers.length > 0 && (
            <div role="alert" className="mt-3 text-sm">
              This is still used elsewhere. Change these first:
              <ul className="list-disc pl-5">
                {[...new Set(blockers.map((path) => describePath(path, definition)))].map(
                  (text) => (
                    <li key={text}>{text}</li>
                  ),
                )}
              </ul>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button
              variant="danger"
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
              {deleting?.kind === 'room' ? 'Delete room' : 'Remove path'}
            </Button>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
