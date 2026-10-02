/**
 * The one-action resolver: turn enforcement, the round convention, victory on
 * either side, refusals, and the round cap.
 */
import { describe, expect, it } from 'vitest';
import { resolveCombatAction, startCombat } from '../../../src/modules/combat/combatEngine';
import { createCombatState, DEFAULT_MAX_ROUNDS } from '../../../src/modules/combat/combatState';
import type { CombatAction, CombatState } from '../../../src/modules/combat/combatTypes';
import {
  CombatActionRejectedError,
  CombatStateInvalidError,
} from '../../../src/shared/errors';
import { seededRng } from '../../../src/shared/random';

const ctx = { rng: seededRng(1) };
const attack = (actor: 'player' | 'enemy'): CombatAction => ({ type: 'basic_attack', actor });

function fight(over: { player?: Partial<Parameters<typeof createCombatState>[0]['player']>; enemy?: Partial<Parameters<typeof createCombatState>[0]['enemy']>; maxRounds?: number } = {}): CombatState {
  return createCombatState({
    player: { id: 'buddy:1', name: 'Mira', attack: 50, defense: 25, maxHp: 200, ...over.player },
    enemy: { id: 'enemy:drone', name: 'Drone', attack: 30, defense: 25, maxHp: 120, ...over.enemy },
    ...(over.maxRounds !== undefined ? { rules: { maxRounds: over.maxRounds } } : {}),
  });
}

function rejection(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof CombatActionRejectedError) return err.reason;
    throw err;
  }
  return undefined;
}

describe('createCombatState', () => {
  it('opens at round 1 on the player turn with empty statuses and cooldowns', () => {
    const s = fight();
    expect(s).toMatchObject({ round: 1, turn: 'player', status: 'active', rules: { maxRounds: DEFAULT_MAX_ROUNDS } });
    expect(s.player).toMatchObject({ currentHp: 200, maxHp: 200, statuses: [], cooldowns: {} });
    expect(DEFAULT_MAX_ROUNDS).toBe(30);
  });

  it('rejects malformed stats', () => {
    expect(() => fight({ player: { attack: -1 } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ player: { defense: 1.5 } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ enemy: { maxHp: 0 } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ enemy: { currentHp: 121 } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ enemy: { currentHp: 0 } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ player: { attack: Number.NaN } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ player: { id: '' } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ maxRounds: 0 })).toThrow(CombatStateInvalidError);
  });
});

describe('resolveCombatAction', () => {
  it('player basic attack damages the enemy and passes the turn within round 1', () => {
    const before = fight();
    const { state, events } = resolveCombatAction(before, attack('player'), ctx);
    expect(state.enemy.currentHp).toBe(120 - 40);
    expect(state).toMatchObject({ round: 1, turn: 'enemy', status: 'active' });
    expect(events).toEqual([
      { type: 'action_started', round: 1, actor: 'player', action: 'basic_attack' },
      { type: 'damage', round: 1, actor: 'player', target: 'enemy', amount: 40, targetHpBefore: 120, targetHpAfter: 80 },
      { type: 'turn_started', round: 1, actor: 'enemy' },
    ]);
    // Input untouched.
    expect(before.enemy.currentHp).toBe(120);
    expect(before.turn).toBe('player');
  });

  it('enemy basic attack damages the player and starts the next round', () => {
    const afterPlayer = resolveCombatAction(fight(), attack('player'), ctx).state;
    const { state, events } = resolveCombatAction(afterPlayer, attack('enemy'), ctx);
    expect(state.player.currentHp).toBe(200 - 24);
    expect(state).toMatchObject({ round: 2, turn: 'player', status: 'active' });
    expect(events.at(-1)).toEqual({ type: 'turn_started', round: 2, actor: 'player' });
    expect(events[1]).toMatchObject({ type: 'damage', round: 1, target: 'player', amount: 24 });
  });

  it('enforces turn order', () => {
    expect(rejection(() => resolveCombatAction(fight(), attack('enemy'), ctx))).toBe('not_actor_turn');
    const afterPlayer = resolveCombatAction(fight(), attack('player'), ctx).state;
    expect(rejection(() => resolveCombatAction(afterPlayer, attack('player'), ctx))).toBe('not_actor_turn');
  });

  it('player victory when the enemy reaches 0 HP (clamped)', () => {
    const { state, events } = resolveCombatAction(fight({ enemy: { currentHp: 10 } }), attack('player'), ctx);
    expect(state.status).toBe('player_victory');
    expect(state.enemy.currentHp).toBe(0);
    expect(state.round).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['action_started', 'damage', 'combatant_defeated', 'combat_ended']);
    expect(events[1]).toMatchObject({ amount: 40, targetHpBefore: 10, targetHpAfter: 0 });
    expect(events.at(-1)).toEqual({ type: 'combat_ended', round: 1, result: 'player_victory', reason: 'defeat' });
  });

  it('enemy victory when the player reaches 0 HP', () => {
    const s = resolveCombatAction(fight({ player: { currentHp: 5 } }), attack('player'), ctx).state;
    const { state, events } = resolveCombatAction(s, attack('enemy'), ctx);
    expect(state.status).toBe('enemy_victory');
    expect(state.player.currentHp).toBe(0);
    expect(events).toContainEqual({ type: 'combatant_defeated', round: 1, actor: 'player' });
  });

  it('refuses any action after the fight ended', () => {
    const won = resolveCombatAction(fight({ enemy: { currentHp: 1 } }), attack('player'), ctx).state;
    expect(rejection(() => resolveCombatAction(won, attack('enemy'), ctx))).toBe('combat_finished');
    expect(rejection(() => resolveCombatAction(won, attack('player'), ctx))).toBe('combat_finished');
    expect(rejection(() => startCombat(won))).toBe('combat_finished');
  });

  it('refuses V1-unsupported and unknown actions', () => {
    expect(rejection(() => resolveCombatAction(fight(), { type: 'defend', actor: 'player' }, ctx))).toBe('unsupported_action');
    expect(rejection(() => resolveCombatAction(fight(), { type: 'special', actor: 'player', abilityKey: 'zap' }, ctx))).toBe('unsupported_action');
    expect(rejection(() => resolveCombatAction(fight(), { type: 'flee', actor: 'player' } as unknown as CombatAction, ctx))).toBe('unsupported_action');
    expect(rejection(() => resolveCombatAction(fight(), { type: 'basic_attack', actor: 'boss' } as unknown as CombatAction, ctx))).toBe('unknown_actor');
  });

  it('refuses a corrupted state', () => {
    const s = fight();
    expect(() => resolveCombatAction({ ...s, player: { ...s.player, currentHp: 999 } }, attack('player'), ctx)).toThrow(CombatStateInvalidError);
    expect(() => resolveCombatAction({ ...s, turn: 'nobody' as never }, attack('player'), ctx)).toThrow(CombatStateInvalidError);
    expect(() => resolveCombatAction({ ...s, status: 'paused' as never }, attack('player'), ctx)).toThrow(CombatStateInvalidError);
  });

  it('draws when the last allowed round completes with both standing', () => {
    let state = fight({ maxRounds: 2, player: { attack: 1 }, enemy: { attack: 1 } });
    state = resolveCombatAction(state, attack('player'), ctx).state;
    state = resolveCombatAction(state, attack('enemy'), ctx).state;
    expect(state).toMatchObject({ round: 2, turn: 'player', status: 'active' });
    state = resolveCombatAction(state, attack('player'), ctx).state;
    const last = resolveCombatAction(state, attack('enemy'), ctx);
    expect(last.state).toMatchObject({ round: 2, status: 'draw' });
    expect(last.events.at(-1)).toEqual({ type: 'combat_ended', round: 2, result: 'draw', reason: 'round_limit' });
  });

  it('does not draw when the final blow lands in the last round', () => {
    let state = fight({ maxRounds: 1, player: { currentHp: 1 } });
    state = resolveCombatAction(state, attack('player'), ctx).state;
    expect(resolveCombatAction(state, attack('enemy'), ctx).state.status).toBe('enemy_victory');
  });
});

describe('startCombat', () => {
  it('emits combat_started with snapshots, then the first turn', () => {
    const s = fight();
    expect(startCombat(s).events).toEqual([
      {
        type: 'combat_started',
        round: 1,
        player: { id: 'buddy:1', name: 'Mira', currentHp: 200, maxHp: 200 },
        enemy: { id: 'enemy:drone', name: 'Drone', currentHp: 120, maxHp: 120 },
      },
      { type: 'turn_started', round: 1, actor: 'player' },
    ]);
    expect(startCombat(s).state).toBe(s);
  });
});
