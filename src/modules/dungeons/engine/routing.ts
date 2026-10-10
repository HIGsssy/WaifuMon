/**
 * Where a room's sequence goes after an action reports an outcome.
 *
 * ## Precedence
 *
 *   1. `action.outcomes[outcome]` — routing written for exactly this outcome;
 *   2. `action.next` — but only for the action's **success** outcome
 *      (`victory`, `done`, `passed`, `claimed`). A failure or a decline never
 *      follows `next`: "after this fight go to the vault" must not also send a
 *      player who lost, or who walked past, to the vault;
 *   3. a declined optional action carries on to the following action;
 *   4. the action type's default for that outcome:
 *        - a lost fight ends the run as `defeated`;
 *        - a gate that does not open is a `retreat`;
 *        - a `leave` walks its connection, or completes the room without one;
 *        - everything else is `next`: the following action in the list, and
 *          the room completes after the last.
 *
 * Routing only ever goes forward in the list (the validator refuses anything
 * else, and `forwardIndex` refuses it again at run time), so a sequence always
 * terminates.
 */
import {
  DECLINED_OUTCOME,
  type ActionDestination,
  type DungeonAction,
  type DungeonActionType,
  type DungeonRoom,
} from '../content/dungeonDefinition';

/** The outcome `action.next` applies to. `leave` has none: it is itself a destination. */
export const SUCCESS_OUTCOME: Readonly<Record<DungeonActionType, string | null>> = {
  combat: 'victory',
  boss: 'victory',
  rest: 'done',
  gate: 'passed',
  set_flag: 'done',
  leave: null,
  reward: 'claimed',
};

/** Outcomes recorded as `failed` rather than `completed`. */
export const FAILURE_OUTCOMES: Readonly<Record<DungeonActionType, readonly string[]>> = {
  combat: ['defeat'],
  boss: ['defeat'],
  rest: [],
  gate: ['blocked'],
  set_flag: [],
  leave: [],
  reward: [],
};

const NEXT: ActionDestination = { type: 'next' };

export function defaultDestination(action: DungeonAction, outcome: string): ActionDestination {
  if ((action.type === 'combat' || action.type === 'boss') && outcome === 'defeat') {
    return { type: 'end_run', outcome: 'defeated' };
  }
  if (action.type === 'gate' && outcome === 'blocked') return { type: 'retreat' };
  if (action.type === 'leave') {
    return action.connectionId ? { type: 'leave', connectionId: action.connectionId } : { type: 'room_complete' };
  }
  return NEXT;
}

export function destinationFor(action: DungeonAction, outcome: string): ActionDestination {
  const routed = action.outcomes[outcome];
  if (routed) return routed;
  // Declining is "carry on as if it were not there", whatever the action is.
  if (outcome === DECLINED_OUTCOME) return NEXT;
  if (outcome === SUCCESS_OUTCOME[action.type] && action.next) return action.next;
  return defaultDestination(action, outcome);
}

/** Every destination an action can take, with the outcome that takes it. For validation. */
export function destinationsOf(action: DungeonAction): { outcome: string; via: 'outcomes' | 'next' | 'default'; destination: ActionDestination }[] {
  const out: { outcome: string; via: 'outcomes' | 'next' | 'default'; destination: ActionDestination }[] = [];
  for (const [outcome, destination] of Object.entries(action.outcomes)) out.push({ outcome, via: 'outcomes', destination });
  if (action.next) out.push({ outcome: SUCCESS_OUTCOME[action.type] ?? 'done', via: 'next', destination: action.next });
  if (action.type === 'leave') out.push({ outcome: 'done', via: 'default', destination: defaultDestination(action, 'done') });
  return out;
}

/**
 * The list position of a jump target, which must be after `fromIndex`.
 *
 * @throws {RangeError} for a missing or non-forward target — content that
 *         should never have been published.
 */
export function forwardIndex(room: DungeonRoom, fromIndex: number, actionId: string): number {
  const index = room.actions.findIndex((a) => a.id === actionId);
  if (index < 0) throw new RangeError(`room "${room.id}" has no action "${actionId}"`);
  if (index <= fromIndex) throw new RangeError(`room "${room.id}" routes backward to action "${actionId}"`);
  return index;
}
