import { describe, it, expect } from 'vitest';
import { fixture } from './dungeonFixtures';
import {
  addMapRoom,
  connectMapRooms,
  newMapId,
  deleteMapEntity,
  deletionBlockers,
  issueSelection,
  positionOf,
} from '../dungeonMapModel';
describe('dungeon map transformations', () => {
  it('generates schema-safe stable IDs and avoids collisions', () => {
    const existing = 'r_0123456789abcdef0123456789abcdef';
    let n = 0;
    const id = newMapId('r', [existing], () =>
      n++ === 0 ? '01234567-89ab-cdef-0123-456789abcdef' : 'abcdef01-2345-6789-abcd-ef0123456789',
    );
    expect(id).not.toBe(existing);
    expect(id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(id.length).toBeLessThanOrEqual(40);
  });
  it('adds regular, exit and entrance rooms without changing old action identities', () => {
    const d = fixture().draft;
    const a = addMapRoom(d, fixture().layout, 'room');
    const b = addMapRoom(a.definition, a.layout, 'exit');
    const c = addMapRoom(b.definition, b.layout, 'entrance');
    expect(new Set(c.definition.rooms.map((r) => r.id)).size).toBe(4);
    expect(c.definition.entranceRoomId).toBe(c.id);
    expect(b.definition.rooms.at(-1)?.kind).toBe('exit');
    expect(c.definition.rooms[0]).toEqual(d.rooms[0]);
    expect(c.layout.rooms?.entrance).toEqual({ x: 4, y: 8 });
  });
  it('allows branching, duplicate paths and cyclic connections', () => {
    const a = addMapRoom(fixture().draft, {}, 'room');
    const b = addMapRoom(a.definition, a.layout, 'room');
    let d = connectMapRooms(b.definition, 'entrance', a.id);
    d = connectMapRooms(d, a.id, 'entrance');
    d = connectMapRooms(d, 'entrance', b.id);
    d = connectMapRooms(d, 'entrance', a.id);
    expect(d.connections).toHaveLength(4);
    expect(new Set(d.connections.map((c) => c.id)).size).toBe(4);
    expect(connectMapRooms(d, 'missing', a.id)).toBe(d);
  });
  it('deletes incident connections and position, preserves notes/viewport and makes entrance deletion explicit', () => {
    const a = addMapRoom(fixture().draft, fixture().layout, 'room');
    const d = connectMapRooms(a.definition, 'entrance', a.id);
    const layout = {
      ...a.layout,
      viewport: { x: 10, y: 20, zoom: 1.5 },
      notes: [{ id: 'note', x: 0, y: 0, text: 'Keep' }],
    };
    const removed = deleteMapEntity(d, layout, { kind: 'room', id: 'entrance' });
    expect(removed.definition.rooms).toHaveLength(1);
    expect(removed.definition.connections).toEqual([]);
    expect(removed.layout.rooms?.entrance).toBeUndefined();
    expect(removed.layout.notes).toEqual(layout.notes);
    expect(removed.layout.viewport).toEqual(layout.viewport);
    expect(removed.definition.entranceRoomId).toBe('entrance');
  });
  it('blocks removal of rooms or connections referenced in authored actions/conditions', () => {
    const a = addMapRoom(fixture().draft, {}, 'room');
    const d = connectMapRooms(a.definition, 'entrance', a.id);
    d.rooms[0]!.actions = [
      { id: 'leave', type: 'leave', connectionId: d.connections[0]!.id },
      { id: 'gate', type: 'gate', requires: { type: 'room_completed', roomId: a.id } },
    ];
    expect(deletionBlockers(d, { kind: 'room', id: a.id })).toHaveLength(2);
    expect(deletionBlockers(d, { kind: 'connection', id: d.connections[0]!.id })).toHaveLength(1);
    expect(deleteMapEntity(d, {}, { kind: 'room', id: a.id }).definition).toBe(d);
  });
  it('preserves conditions when removing an unreferenced connection', () => {
    const a = addMapRoom(fixture().draft, {}, 'room');
    const d = connectMapRooms(a.definition, 'entrance', a.id);
    d.connections.push({
      id: 'return',
      from: a.id,
      to: 'entrance',
      requires: { type: 'flag', flag: 'key' },
    });
    const next = deleteMapEntity(d, {}, { kind: 'connection', id: d.connections[0]!.id });
    expect(next.definition.connections).toEqual([d.connections[1]]);
  });
  it('uses saved positions and maps nested validation paths to stable IDs', () => {
    const a = addMapRoom(fixture().draft, {}, 'room');
    const d = connectMapRooms(a.definition, 'entrance', a.id);
    expect(positionOf(fixture().layout, 'entrance', 0)).toEqual({ x: 4, y: 8 });
    expect(
      issueSelection(
        {
          code: 'enemy_missing',
          severity: 'error',
          path: 'rooms[1].actions[0].waves[0]',
          message: 'Missing',
        },
        d,
      ),
    ).toEqual({ kind: 'room', id: a.id });
    expect(
      issueSelection(
        {
          code: 'connection_unknown_room',
          severity: 'error',
          path: 'connections[0].to',
          message: 'Missing',
        },
        d,
      ),
    ).toEqual({ kind: 'connection', id: d.connections[0]!.id });
    expect(
      issueSelection(
        { code: 'no_ending', severity: 'error', path: 'rooms', message: 'No exit' },
        d,
      ),
    ).toBeNull();
  });
});
