import { describe, expect, it } from 'vitest';
import type { DungeonDefinition, DungeonIssue, DungeonLayout } from '@/api/adminDungeons';
import { starterDungeon } from '../dungeonModel';
import {
  ROOM_TEMPLATES,
  addTemplateRoom,
  connectionProblem,
  roomPresentation,
} from '../dungeonRoomTemplates';
import {
  activitySummary,
  conditionText,
  friendlyIssue,
  incompleteIssues,
  roomSummary,
} from '../dungeonText';
import { reference } from './dungeonFixtures';

const base = () => starterDungeon('tunnels', 'Tunnels', []);
function build() {
  let state: { definition: DungeonDefinition; layout: DungeonLayout; id: string } = {
    definition: base(),
    layout: { rooms: { entrance: { x: 0, y: 0 } } },
    id: 'entrance',
  };
  const ids: Record<string, string> = {};
  for (const template of ['combat', 'rest', 'boss', 'exit'] as const) {
    const next = addTemplateRoom(state.definition, state.layout, template, state.id);
    ids[template] = next.id;
    state = next;
  }
  return { ...state, ids };
}

describe('room templates', () => {
  it('offers gameplay templates only', () => {
    expect(ROOM_TEMPLATES.map((t) => t.label)).toEqual([
      'Combat',
      'Boss',
      'Treasure',
      'Rest',
      'Exit',
      'Empty',
    ]);
  });
  it('chains rooms left to right with one open path each and leaves the start room alone', () => {
    const { definition, layout, ids } = build();
    expect(definition.entranceRoomId).toBe('entrance');
    expect(definition.connections.map((c) => [c.from, c.to, c.kind])).toEqual([
      ['entrance', ids.combat, 'path'],
      [ids.combat, ids.rest, 'path'],
      [ids.rest, ids.boss, 'path'],
      [ids.boss, ids.exit, 'path'],
    ]);
    expect(Object.values(layout.rooms ?? {}).map((p) => p.x)).toEqual([0, 320, 640, 960, 1280]);
    expect(definition.rooms.map((r) => roomPresentation(r).label)).toEqual([
      'Empty',
      'Combat',
      'Rest',
      'Boss',
      'Exit',
    ]);
    for (const room of definition.rooms) {
      expect(room.id).toMatch(/^(entrance|r_[a-f0-9]{32})$/);
      for (const action of room.actions) expect(action.type).not.toBe('leave');
    }
  });
  it('reads a room’s kind from its content, so mixed and imported rooms are labelled too', () => {
    const room = (types: string[], kind: 'room' | 'exit' = 'room') =>
      roomPresentation({ id: 'r', kind, actions: types.map((type, i) => ({ id: `a${i}`, type })) })
        .label;
    expect(room(['reward'])).toBe('Treasure');
    expect(room(['rest', 'combat'])).toBe('Combat');
    expect(room(['combat', 'boss'])).toBe('Boss');
    expect(room(['rest', 'reward'])).toBe('Custom');
    expect(room(['combat'], 'exit')).toBe('Exit');
  });
  it('does not connect out of an exit, into itself, or twice', () => {
    const { definition, ids } = build();
    expect(connectionProblem(definition, ids.exit!, 'entrance')).toMatch(/is an exit/);
    expect(connectionProblem(definition, 'entrance', 'entrance')).toMatch(/back into itself/);
    expect(connectionProblem(definition, 'entrance', ids.combat!)).toMatch(/already leads to/);
    expect(connectionProblem(definition, ids.combat!, 'entrance')).toBeNull();
    // Following an exit creates the room but no path the validator would refuse.
    const after = addTemplateRoom(definition, {}, 'rest', ids.exit);
    expect(after.definition.connections).toHaveLength(4);
  });
});

describe('plain-language reading', () => {
  const definition: DungeonDefinition = {
    ...base(),
    flags: [{ key: 'f_lever', scope: 'run', description: 'Lever pulled' }],
    rooms: [
      {
        id: 'entrance',
        name: 'Main Hall',
        actions: [
          {
            id: 'a_fight',
            type: 'combat',
            waves: [{ enemy: { key: 'slime' } }, { enemy: { key: '' } }],
          },
          { id: 'a_rest', type: 'rest', healBasisPoints: 2500 },
        ],
      },
      { id: 'r_9f', name: '', kind: 'exit', actions: [] },
    ],
    connections: [{ id: 'c_1', from: 'r_9f', to: 'entrance' }],
  };
  it('summarises activities and rules as sentences', () => {
    const [fight, rest] = definition.rooms[0]!.actions;
    expect(activitySummary(fight!, definition, reference)).toBe('Slime, then no enemy chosen');
    expect(activitySummary(rest!, definition, reference)).toBe('Restore 25% HP');
    expect(roomSummary(definition.rooms[0]!, definition, reference)).toBe(
      'Slime, then no enemy chosen · Restore 25% HP',
    );
    expect(
      conditionText(
        {
          type: 'any',
          conditions: [
            { type: 'flag', flag: 'f_lever', equals: false },
            { type: 'not', condition: { type: 'room_completed', roomId: 'entrance' } },
          ],
        },
        definition,
      ),
    ).toBe('“Lever pulled” has not happened or not (Main Hall is completed)');
  });
  it('finds fights that cannot be saved yet', () => {
    expect(incompleteIssues(definition).map((i) => i.path)).toEqual([
      'rooms[0].actions[0].waves[1].enemy',
    ]);
    expect(incompleteIssues(base())).toEqual([]);
  });
  it('turns validator issues into titled, located advice while keeping their severity', () => {
    const read = (issue: Partial<DungeonIssue>) =>
      friendlyIssue(
        { code: 'schema', severity: 'error', path: '', message: '', ...issue },
        definition,
        reference,
      );
    const noWayOut = read({
      code: 'room_no_route_to_exit',
      path: 'rooms[0]',
      message: 'room "entrance" has no route to an exit or extraction point',
    });
    expect(noWayOut).toMatchObject({
      level: 'fix',
      title: 'Main Hall has no way out.',
      help: 'Connect this room to another room or to an exit.',
      target: { kind: 'room', id: 'entrance' },
      actionId: null,
    });
    expect(
      read({ code: 'room_empty', severity: 'warning', path: 'rooms[1].actions' }),
    ).toMatchObject({
      level: 'review',
      title: 'Unnamed room has no activities.',
    });
    // The unchosen enemy is the same item whether the editor or the server reports it.
    for (const code of ['editor_incomplete', 'schema'])
      expect(
        read({ code, path: 'rooms[0].actions[0].waves[1].enemy', message: 'Invalid input' }),
      ).toMatchObject({
        level: 'finish',
        title: 'Main Hall needs an enemy for wave 2.',
        actionId: 'a_fight',
      });
    expect(
      read({ code: 'exit_has_connections', path: 'connections[0].from', message: 'x' }),
    ).toMatchObject({
      title: 'A path leads out of Unnamed room, which is an exit.',
      target: { kind: 'connection', id: 'c_1' },
    });
    // An unmapped code still reads in names rather than identifiers.
    const fallback = read({
      code: 'transition_backward',
      path: 'rooms[0].actions[1].outcomes.done',
      message:
        'action "a_rest" routes backward to "a_fight"; routing inside a room only goes forward',
    });
    expect(fallback.title).toBe(
      'Main Hall: Rest (activity 2) routes backward to fight (activity 1); routing inside a room only goes forward.',
    );
    expect(fallback.level).toBe('fix');
  });
});
