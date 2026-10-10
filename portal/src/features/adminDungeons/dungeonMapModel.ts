/** Map edits preserve authored actions/conditions; React Flow never becomes stored content. */
import type { DungeonDefinition, DungeonIssue, DungeonLayout } from '@/api/adminDungeons';
export type MapSelection = { kind: 'room' | 'connection'; id: string } | null;
export function newMapId(
  prefix: 'r' | 'c',
  ids: readonly string[],
  uuid = () => crypto.randomUUID(),
): string {
  const used = new Set(ids);
  for (;;) {
    const id = `${prefix}_${uuid().replaceAll('-', '')}`;
    if (!used.has(id)) return id;
  }
}
export function positionOf(layout: DungeonLayout, roomId: string, index: number) {
  return layout.rooms?.[roomId] ?? { x: (index % 4) * 260, y: Math.floor(index / 4) * 180 };
}
export function addMapRoom(
  definition: DungeonDefinition,
  layout: DungeonLayout,
  type: 'room' | 'entrance' | 'exit',
) {
  const id = newMapId(
    'r',
    definition.rooms.map((r) => r.id),
  );
  return {
    id,
    definition: {
      ...definition,
      entranceRoomId: type === 'entrance' ? id : definition.entranceRoomId,
      rooms: [
        ...definition.rooms,
        {
          id,
          name: type === 'entrance' ? 'Entrance' : type === 'exit' ? 'Exit' : 'New room',
          description: '',
          kind: type === 'exit' ? ('exit' as const) : ('room' as const),
          extraction: false,
          background: null,
          actions: [],
        },
      ],
    },
    layout: {
      ...layout,
      rooms: { ...layout.rooms, [id]: positionOf(layout, id, definition.rooms.length) },
    },
  };
}
export function connectMapRooms(definition: DungeonDefinition, from: string, to: string) {
  if (!definition.rooms.some((r) => r.id === from) || !definition.rooms.some((r) => r.id === to))
    return definition;
  const id = newMapId(
    'c',
    definition.connections.map((c) => c.id),
  );
  return {
    ...definition,
    connections: [
      ...definition.connections,
      { id, from, to, label: '', kind: 'path' as const, lockedText: '' },
    ],
  };
}
/** Identify references whose authored meaning cannot be repaired by a map-only editor. */
export function deletionBlockers(
  definition: DungeonDefinition,
  target: NonNullable<MapSelection>,
): string[] {
  const connections = new Set(
    target.kind === 'connection'
      ? [target.id]
      : definition.connections
          .filter((c) => c.from === target.id || c.to === target.id)
          .map((c) => c.id),
  );
  const paths: string[] = [];
  function visit(value: unknown, path: string) {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (target.kind === 'room' && record.type === 'room_completed' && record.roomId === target.id)
      paths.push(path);
    if (typeof record.connectionId === 'string' && connections.has(record.connectionId))
      paths.push(path);
    for (const [key, child] of Object.entries(record)) visit(child, `${path}.${key}`);
  }
  definition.rooms.forEach((r, i) => {
    if (target.kind !== 'room' || r.id !== target.id) visit(r.actions, `rooms[${i}].actions`);
  });
  definition.connections.forEach((c, i) => {
    if (!connections.has(c.id)) visit(c.requires, `connections[${i}].requires`);
  });
  return paths;
}
export function deleteMapEntity(
  definition: DungeonDefinition,
  layout: DungeonLayout,
  target: NonNullable<MapSelection>,
) {
  if (deletionBlockers(definition, target).length) return { definition, layout };
  if (target.kind === 'connection')
    return {
      definition: {
        ...definition,
        connections: definition.connections.filter((c) => c.id !== target.id),
      },
      layout,
    };
  const rooms = { ...layout.rooms };
  delete rooms[target.id];
  return {
    definition: {
      ...definition,
      rooms: definition.rooms.filter((r) => r.id !== target.id),
      connections: definition.connections.filter((c) => c.from !== target.id && c.to !== target.id),
    },
    layout: { ...layout, rooms },
  };
}
export function issueSelection(issue: DungeonIssue, definition: DungeonDefinition): MapSelection {
  const room = /^rooms\[(\d+)\]/.exec(issue.path);
  if (room) {
    const id = definition.rooms[Number(room[1])]?.id;
    return id ? { kind: 'room', id } : null;
  }
  const connection = /^connections\[(\d+)\]/.exec(issue.path);
  if (connection) {
    const id = definition.connections[Number(connection[1])]?.id;
    return id ? { kind: 'connection', id } : null;
  }
  if (
    issue.path === 'entranceRoomId' &&
    definition.rooms.some((r) => r.id === definition.entranceRoomId)
  )
    return { kind: 'room', id: definition.entranceRoomId };
  return null;
}
