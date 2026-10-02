/**
 * Auto-combat — convenience infrastructure over the resolver.
 *
 *   controller for state.turn chooses → resolveCombatAction → repeat
 *
 * The simulator owns no combat rules. Damage, turn order, victory and the
 * round cap all live in `combatEngine.ts`; this loop only asks controllers and
 * collects events. Its own action budget is a backstop against a bug, never
 * the rule that normally ends a fight.
 */
import type { CombatController } from './combatController';
import { endCombatAsDraw, resolveCombatAction, startCombat } from './combatEngine';
import type {
  CombatContext,
  CombatEndReason,
  CombatEvent,
  CombatResult,
  CombatResultKind,
  CombatState,
} from './combatTypes';

export interface CombatControllers {
  player: CombatController;
  enemy: CombatController;
}

export interface SimulateCombatOptions {
  /**
   * Hard backstop on resolved actions. Defaults to `2 × rules.maxRounds`,
   * which the resolver's round cap reaches first.
   */
  maxActions?: number;
}

export function simulateCombat(
  initial: CombatState,
  controllers: CombatControllers,
  context: CombatContext,
  opts: SimulateCombatOptions = {},
): CombatResult {
  const opening = startCombat(initial);
  let state = opening.state;
  const events: CombatEvent[] = [...opening.events];
  const maxActions = opts.maxActions ?? initial.rules.maxRounds * 2;
  let actions = 0;

  while (state.status === 'active') {
    if (actions >= maxActions) {
      const capped = endCombatAsDraw(state);
      state = capped.state;
      events.push(...capped.events);
      break;
    }
    const actor = state.turn;
    const action = controllers[actor].chooseAction(state, actor, context);
    const step = resolveCombatAction(state, action, context);
    state = step.state;
    events.push(...step.events);
    actions += 1;
  }

  const ended = events[events.length - 1];
  const reason: CombatEndReason = ended?.type === 'combat_ended' ? ended.reason : 'round_limit';
  return {
    result: state.status as CombatResultKind,
    reason,
    finalState: state,
    events,
    rounds: state.round,
    actions,
  };
}
