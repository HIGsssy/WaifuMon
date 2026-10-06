/**
 * The combat engine — **the authoritative primitive is one action**.
 *
 *   resolveCombatAction(state, action, context) → { state, events }
 *
 * Auto-combat (`combatSimulator.ts`), a future Discord button and a future
 * dungeon client all submit the same `CombatAction` here. Nothing in the engine
 * knows who chose the action or assumes "attack, then counterattack".
 *
 * ## Round convention
 *
 *   - Round 1 opens with the **player's** turn.
 *   - The enemy's turn that follows is still the same round.
 *   - The round number increments when control returns to the player.
 *   - When round `rules.maxRounds` completes (the enemy has acted) and both
 *     sides still stand, the fight ends as a `draw` (`reason: 'round_limit'`)
 *     in that round. So a fight lasts at most `maxRounds` rounds and
 *     `2 × maxRounds` actions.
 *
 * ## Purity
 *
 * Inputs are never mutated; every call returns a new state. A refused action
 * throws `CombatActionRejectedError` (with a stable `reason`) and leaves the
 * caller's state exactly as it was. Randomness is drawn from `context.rng`
 * only (`combatMath.ts`). A refused action draws nothing.
 *
 * ## A basic attack
 *
 * One or two **strikes**. Each strike, in order: Armor Penetration → base
 * damage → variance draw → Crit draw → damage → Lifesteal. Then, only after
 * the *normal* strike and only if the target still stands, the attacker's
 * Double Attack chance is drawn; a success adds exactly one bonus strike,
 * which uses the same ATK and modifiers, rolls its own variance and Crit,
 * lifesteals — and never rolls Double Attack itself. No chains.
 *
 * Draw order per basic attack, so a seed reproduces a fight:
 *
 *   1. variance                      — always
 *   2. Crit                          — only if critChanceBp > 0
 *   3. Double Attack                 — only if doubleAttackChanceBp > 0 and the target survived
 *   4. bonus strike variance, Crit   — only if (3) triggered
 *
 * A combatant with no modifiers therefore draws exactly once, as before.
 */
import { CombatActionRejectedError } from '../../shared/errors';
import { hpAfterDamage, lifestealAmount, rollChance, rollStrike } from './combatMath';
import { assertValidCombatState, combatantSnapshot, modifiersOf, opponentOf } from './combatState';
import {
  isCombatActor,
  type CombatAction,
  type CombatActor,
  type CombatContext,
  type CombatEndReason,
  type CombatEvent,
  type CombatResultKind,
  type CombatState,
  type CombatStep,
} from './combatTypes';

/**
 * The opening events for a fight: `combat_started` then the first
 * `turn_started`. Does not change the state; it exists so every surface opens
 * a fight with the same events.
 */
export function startCombat(state: CombatState): CombatStep {
  assertValidCombatState(state);
  if (state.status !== 'active') {
    throw new CombatActionRejectedError('combat_finished', `combat already ended: ${state.status}`);
  }
  return {
    state,
    events: [
      {
        type: 'combat_started',
        round: state.round,
        player: combatantSnapshot(state.player),
        enemy: combatantSnapshot(state.enemy),
      },
      { type: 'turn_started', round: state.round, actor: state.turn },
    ],
  };
}

/**
 * Resolve one submitted action. Validates the state and the action, applies
 * it, and either ends the fight or hands the turn to the other side.
 */
export function resolveCombatAction(
  state: CombatState,
  action: CombatAction,
  context: CombatContext,
): CombatStep {
  assertValidCombatState(state);
  if (state.status !== 'active') {
    throw new CombatActionRejectedError('combat_finished', `combat already ended: ${state.status}`);
  }
  const actor: unknown = (action as { actor?: unknown } | null)?.actor;
  if (!isCombatActor(actor)) {
    throw new CombatActionRejectedError('unknown_actor', `unknown combat actor: ${String(actor)}`);
  }
  if (actor !== state.turn) {
    throw new CombatActionRejectedError(
      'not_actor_turn',
      `it is the ${state.turn}'s turn, not the ${actor}'s`,
    );
  }
  switch (action.type) {
    case 'basic_attack':
      return resolveBasicAttack(state, actor, context);
    default:
      throw new CombatActionRejectedError(
        'unsupported_action',
        `combat action "${String((action as { type?: unknown }).type)}" is not supported`,
      );
  }
}

/**
 * One strike from `actor`: damage into the target, then Lifesteal back into
 * the attacker. Appends its events and returns the state after it.
 */
function resolveStrike(
  state: CombatState,
  actor: CombatActor,
  context: CombatContext,
  events: CombatEvent[],
  bonusAttack: boolean,
): CombatState {
  const target = opponentOf(actor);
  const attacker = state[actor];
  const defender = state[target];
  const modifiers = modifiersOf(attacker);
  const strike = rollStrike(attacker.attack, defender.defense, modifiers, state.rules.damageVariance, context.rng);
  const targetHpAfter = hpAfterDamage(defender.currentHp, strike.amount);

  events.push({
    type: 'damage',
    round: state.round,
    actor,
    target,
    amount: strike.amount,
    baseAmount: strike.base,
    varianceBasisPoints: strike.varianceBasisPoints,
    targetHpBefore: defender.currentHp,
    targetHpAfter,
    targetDefense: strike.targetDefense,
    effectiveDefense: strike.effectiveDefense,
    armorPenetrationBp: strike.armorPenetrationBp,
    variedAmount: strike.variedAmount,
    critical: strike.critical,
    critMultiplierBp: strike.critMultiplierBp,
    bonusAttack,
  });
  if (strike.critical) {
    events.push({
      type: 'critical_hit',
      round: state.round,
      actor,
      target,
      critMultiplierBp: strike.critMultiplierBp,
      amount: strike.amount,
    });
  }

  // Lifesteal reads the HP actually removed, not the nominal damage.
  const damageDealt = defender.currentHp - targetHpAfter;
  const rawHeal = lifestealAmount(damageDealt, modifiers.lifestealBp);
  const heal = Math.min(rawHeal, attacker.maxHp - attacker.currentHp);
  if (heal > 0) {
    events.push({
      type: 'lifesteal_heal',
      round: state.round,
      actor,
      amount: heal,
      rawAmount: rawHeal,
      damageDealt,
      lifestealBp: modifiers.lifestealBp,
      hpBefore: attacker.currentHp,
      hpAfter: attacker.currentHp + heal,
      bonusAttack,
    });
  }

  return {
    ...state,
    [actor]: heal > 0 ? { ...attacker, currentHp: attacker.currentHp + heal } : attacker,
    [target]: { ...defender, currentHp: targetHpAfter },
  };
}

function resolveBasicAttack(state: CombatState, actor: CombatActor, context: CombatContext): CombatStep {
  const target = opponentOf(actor);
  const events: CombatEvent[] = [{ type: 'action_started', round: state.round, actor, action: 'basic_attack' }];

  let next = resolveStrike(state, actor, context, events, false);
  // Only the normal strike may roll Double Attack, and only at a standing target.
  const doubleAttackChanceBp = modifiersOf(state[actor]).doubleAttackChanceBp;
  if (next[target].currentHp > 0 && rollChance(doubleAttackChanceBp, context.rng)) {
    events.push({ type: 'bonus_attack_triggered', round: state.round, actor, doubleAttackChanceBp });
    next = resolveStrike(next, actor, context, events, true);
  }

  if (next[target].currentHp === 0) {
    events.push({ type: 'combatant_defeated', round: state.round, actor: target });
    return finish(next, actor === 'player' ? 'player_victory' : 'enemy_victory', 'defeat', events);
  }
  return advanceTurn(next, events);
}

/** Hand the turn to the other side, applying the round convention and the round cap. */
function advanceTurn(state: CombatState, events: CombatEvent[]): CombatStep {
  const next = opponentOf(state.turn);
  if (next !== 'player') {
    events.push({ type: 'turn_started', round: state.round, actor: next });
    return { state: { ...state, turn: next }, events };
  }
  if (state.round >= state.rules.maxRounds) {
    return finish(state, 'draw', 'round_limit', events);
  }
  const round = state.round + 1;
  events.push({ type: 'turn_started', round, actor: next });
  return { state: { ...state, round, turn: next }, events };
}

function finish(
  state: CombatState,
  result: CombatResultKind,
  reason: CombatEndReason,
  events: CombatEvent[],
): CombatStep {
  events.push({ type: 'combat_ended', round: state.round, result, reason });
  return { state: { ...state, status: result }, events };
}

/**
 * End an active fight as a `round_limit` draw where it stands. The simulator's
 * last-resort backstop; the resolver's own round cap normally ends a fight
 * first.
 */
export function endCombatAsDraw(state: CombatState): CombatStep {
  assertValidCombatState(state);
  if (state.status !== 'active') {
    throw new CombatActionRejectedError('combat_finished', `combat already ended: ${state.status}`);
  }
  return finish(state, 'draw', 'round_limit', []);
}
