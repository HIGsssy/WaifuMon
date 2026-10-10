import { describe, expect, it } from 'vitest';
import {
  actionId,
  actionIssues,
  createAction,
  duplicateAction,
  moveEntry,
  routingProblems,
  ACTION_TYPES,
} from '../dungeonActionModel';
import type { DungeonAction, DungeonRoom } from '@/api/adminDungeons';

describe('action identities and references', () => {
  it('creates every supported action with a unique schema-safe ID', () => {
    const actions: DungeonAction[] = [];
    for (const type of ACTION_TYPES) actions.push(createAction(type, actions));
    expect(new Set(actions.map((a) => a.id)).size).toBe(7);
    actions.forEach((a) => {
      expect(a.id).toMatch(/^a_[a-f0-9]{32}$/);
      expect(a.optional).toBe(false);
    });
    const existing = 'a_0123456789abcdef0123456789abcdef';
    let calls = 0;
    expect(
      actionId([{ id: existing, type: 'rest' }], () =>
        calls++ ? 'abcdef01-2345-6789-abcd-ef0123456789' : '01234567-89ab-cdef-0123-456789abcdef',
      ),
    ).not.toBe(existing);
  });
  it('deep-copies action configuration without rewriting target references', () => {
    const combat = createAction('combat', []);
    combat.next = { type: 'action', actionId: 'reward' };
    const actions = duplicateAction([combat, { id: 'reward', type: 'reward' }], combat.id);
    expect(actions[1]!.id).not.toBe(combat.id);
    expect(actions[1]!.next).toEqual(combat.next);
    actions[1]!.waves![0]!.enemy = { key: 'different' };
    expect(actions[0]!.waves![0]!.enemy).toEqual({ key: '' });
  });
  it('reorders by ID and detects backward and deleted targets without changing routes', () => {
    const actions: DungeonAction[] = [
      { id: 'rest', type: 'rest', outcomes: { done: { type: 'action', actionId: 'reward' } } },
      { id: 'reward', type: 'reward' },
    ];
    const room: DungeonRoom = { id: 'room', actions };
    expect(routingProblems(room)).toEqual([]);
    const moved = moveEntry(actions, 1, -1);
    expect(moved.map((a) => a.id)).toEqual(['reward', 'rest']);
    expect(routingProblems({ ...room, actions: moved })[0]?.message).toMatch(/later/);
    expect(routingProblems({ ...room, actions: [actions[0]!] })[0]?.message).toMatch(/missing/);
    expect(actions[0]!.outcomes!.done).toEqual({ type: 'action', actionId: 'reward' });
    expect(moveEntry(actions, 0, -1)).toBe(actions);
  });
  it('maps issues to the exact action rather than index prefixes', () => {
    const issue = {
      code: 'schema',
      severity: 'error' as const,
      path: 'rooms[0].actions[1].waves[0]',
      message: 'Missing enemy',
    };
    expect(actionIssues([issue, { ...issue, path: 'rooms[0].actions[10].waves' }], 0, 1)).toEqual([
      issue,
    ]);
    expect(actionIssues([issue], 1, 1)).toEqual([]);
  });
});
