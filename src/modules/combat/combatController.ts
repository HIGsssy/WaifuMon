/**
 * Controllers decide *what* a side does; the engine decides *what happens*.
 *
 * The simulator asks the controller for the side whose turn it is and submits
 * the returned action to `resolveCombatAction`. Swapping the player's
 * auto-controller for an interactive one (a Discord button, a dungeon client)
 * changes nothing in the engine or the math.
 *
 * Synchronous on purpose: an interactive fight does not run inside the
 * simulator loop. It persists the state, waits for input, and submits that
 * input to the resolver directly.
 */
import type { CombatAction, CombatActor, CombatContext, CombatState } from './combatTypes';

export interface CombatController {
  /**
   * The action `actor` takes now. Called only when it is `actor`'s turn.
   * Random choices draw from `context.rng`, never `Math.random()`.
   */
  chooseAction(state: CombatState, actor: CombatActor, context: CombatContext): CombatAction;
}

/** V1 auto-controller for either side: always a basic attack. */
export const basicAttackController: CombatController = {
  chooseAction(_state, actor) {
    return { type: 'basic_attack', actor };
  },
};
