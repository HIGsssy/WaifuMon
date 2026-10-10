/**
 * Evaluating a `when` or `requires`. Pure, total, and the only reader of flags.
 */
import type { DungeonCondition } from '../content/dungeonDefinition';
import type { DungeonRunState } from './types';

export interface ConditionFacts {
  flags: Readonly<Record<string, boolean>>;
  playerFlags: Readonly<Record<string, boolean>>;
  rooms: DungeonRunState['rooms'];
}

export function conditionFacts(state: DungeonRunState, playerFlags?: Readonly<Record<string, boolean>>): ConditionFacts {
  return { flags: state.flags, playerFlags: playerFlags ?? {}, rooms: state.rooms };
}

/** An unset flag is false. An undefined condition holds. */
export function evaluateCondition(condition: DungeonCondition | undefined, facts: ConditionFacts): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case 'flag': {
      const value = (condition.scope === 'player' ? facts.playerFlags : facts.flags)[condition.flag] === true;
      return value === condition.equals;
    }
    case 'room_completed':
      return facts.rooms[condition.roomId]?.completed === true;
    case 'all':
      return condition.conditions.every((c) => evaluateCondition(c, facts));
    case 'any':
      return condition.conditions.some((c) => evaluateCondition(c, facts));
    case 'not':
      return !evaluateCondition(condition.condition, facts);
  }
}

/** Every flag and room a condition reads, for validation. */
export function conditionReferences(condition: DungeonCondition | undefined): {
  flags: { flag: string; scope: 'run' | 'player' }[];
  rooms: string[];
} {
  const flags: { flag: string; scope: 'run' | 'player' }[] = [];
  const rooms: string[] = [];
  const walk = (c: DungeonCondition | undefined): void => {
    if (!c) return;
    if (c.type === 'flag') flags.push({ flag: c.flag, scope: c.scope });
    else if (c.type === 'room_completed') rooms.push(c.roomId);
    else if (c.type === 'not') walk(c.condition);
    else c.conditions.forEach(walk);
  };
  walk(condition);
  return { flags, rooms };
}

export function conditionDepth(condition: DungeonCondition | undefined): number {
  if (!condition) return 0;
  if (condition.type === 'not') return 1 + conditionDepth(condition.condition);
  if (condition.type === 'all' || condition.type === 'any') return 1 + Math.max(0, ...condition.conditions.map(conditionDepth));
  return 1;
}
