/**
 * Auto-combat over the resolver: outcomes, determinism, event order, the
 * controller seam, the round cap and serialisation.
 */
import { describe, expect, it, vi } from 'vitest';
import { basicAttackController, type CombatController } from '../../../src/modules/combat/combatController';
import { createCombatState } from '../../../src/modules/combat/combatState';
import { simulateCombat } from '../../../src/modules/combat/combatSimulator';
import type { CombatState } from '../../../src/modules/combat/combatTypes';
import { CombatActionRejectedError } from '../../../src/shared/errors';
import { seededRng } from '../../../src/shared/random';

const auto = { player: basicAttackController, enemy: basicAttackController };
const ctx = () => ({ rng: seededRng(42) });

function fight(p: { attack: number; defense: number; maxHp: number }, e: { attack: number; defense: number; maxHp: number }, maxRounds?: number): CombatState {
  return createCombatState({
    player: { id: 'buddy:7', name: 'Mira', ...p },
    enemy: { id: 'enemy:drone', name: 'Drone', ...e },
    ...(maxRounds !== undefined ? { rules: { maxRounds } } : {}),
  });
}

describe('simulateCombat', () => {
  it('simple player victory with correct final state', () => {
    // Player hits 40 per turn into 120 HP → dies on the player's 3rd attack (round 3).
    const r = simulateCombat(fight({ attack: 50, defense: 25, maxHp: 200 }, { attack: 30, defense: 25, maxHp: 120 }), auto, ctx());
    expect(r.result).toBe('player_victory');
    expect(r.reason).toBe('defeat');
    expect(r.rounds).toBe(3);
    expect(r.actions).toBe(5);
    expect(r.finalState.enemy.currentHp).toBe(0);
    expect(r.finalState.player.currentHp).toBe(200 - 2 * 24);
    expect(r.finalState.status).toBe('player_victory');
  });

  it('simple enemy victory', () => {
    const r = simulateCombat(fight({ attack: 10, defense: 0, maxHp: 50 }, { attack: 30, defense: 0, maxHp: 500 }), auto, ctx());
    expect(r.result).toBe('enemy_victory');
    expect(r.finalState.player.currentHp).toBe(0);
    // 30 per hit into 50 HP: second enemy hit, round 2.
    expect(r.rounds).toBe(2);
    expect(r.finalState.enemy.currentHp).toBe(500 - 20);
  });

  it('is deterministic for the same input', () => {
    const s = fight({ attack: 47, defense: 13, maxHp: 333 }, { attack: 41, defense: 29, maxHp: 290 });
    const a = simulateCombat(s, auto, { rng: seededRng(9) });
    const b = simulateCombat(s, auto, { rng: seededRng(9) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('emits events in order: start, then per action, then the end', () => {
    const r = simulateCombat(fight({ attack: 100, defense: 0, maxHp: 100 }, { attack: 10, defense: 0, maxHp: 150 }), auto, ctx());
    expect(r.events.map((e) => e.type)).toEqual([
      'combat_started',
      'turn_started',
      'action_started', 'damage', 'turn_started',
      'action_started', 'damage', 'turn_started',
      'action_started', 'damage', 'combatant_defeated', 'combat_ended',
    ]);
    expect(r.events.filter((e) => e.type === 'combat_ended')).toHaveLength(1);
  });

  it('asks the controller whose turn it is, with the current state', () => {
    const player = { chooseAction: vi.fn(basicAttackController.chooseAction) };
    const enemy = { chooseAction: vi.fn(basicAttackController.chooseAction) };
    const r = simulateCombat(fight({ attack: 50, defense: 25, maxHp: 200 }, { attack: 30, defense: 25, maxHp: 120 }), { player, enemy }, ctx());
    expect(player.chooseAction).toHaveBeenCalledTimes(3);
    expect(enemy.chooseAction).toHaveBeenCalledTimes(2);
    for (const [state, actor] of player.chooseAction.mock.calls) {
      expect(actor).toBe('player');
      expect(state.turn).toBe('player');
    }
    expect(enemy.chooseAction.mock.calls.every(([s, a]) => a === 'enemy' && s.turn === 'enemy')).toBe(true);
    expect(r.actions).toBe(5);
  });

  it('submits whatever the controller chooses — no hardcoded attack', () => {
    const defender: CombatController = { chooseAction: (_s, actor) => ({ type: 'defend', actor }) };
    expect(() => simulateCombat(fight({ attack: 5, defense: 0, maxHp: 50 }, { attack: 5, defense: 0, maxHp: 50 }), { player: defender, enemy: basicAttackController }, ctx()))
      .toThrow(CombatActionRejectedError);
  });

  it('hands the controller the injected RNG', () => {
    const rng = seededRng(3);
    const seen: unknown[] = [];
    const spy: CombatController = { chooseAction: (s, actor, c) => { seen.push(c.rng); return basicAttackController.chooseAction(s, actor, c); } };
    simulateCombat(fight({ attack: 200, defense: 0, maxHp: 10 }, { attack: 1, defense: 0, maxHp: 10 }), { player: spy, enemy: spy }, { rng });
    expect(seen).toEqual([rng]);
  });

  it('ends a stalemate as a draw at the round cap (30 by default)', () => {
    const r = simulateCombat(fight({ attack: 1, defense: 0, maxHp: 1000 }, { attack: 1, defense: 0, maxHp: 1000 }), auto, ctx());
    expect(r.result).toBe('draw');
    expect(r.reason).toBe('round_limit');
    expect(r.rounds).toBe(30);
    expect(r.actions).toBe(60);
    expect(r.finalState.player.currentHp).toBe(970);
    expect(r.finalState.enemy.currentHp).toBe(970);
    expect(r.events.at(-1)).toEqual({ type: 'combat_ended', round: 30, result: 'draw', reason: 'round_limit' });
  });

  it('cannot loop forever: the action backstop forces a draw', () => {
    const r = simulateCombat(fight({ attack: 1, defense: 0, maxHp: 1000 }, { attack: 1, defense: 0, maxHp: 1000 }), auto, ctx(), { maxActions: 3 });
    expect(r.result).toBe('draw');
    expect(r.actions).toBe(3);
    expect(r.finalState.status).toBe('draw');
  });

  it('result and state round-trip through JSON unchanged', () => {
    const r = simulateCombat(fight({ attack: 50, defense: 25, maxHp: 200 }, { attack: 30, defense: 25, maxHp: 120 }), auto, ctx());
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const mid = createCombatState({ player: { id: 'a', name: 'A', attack: 1, defense: 1, maxHp: 1 }, enemy: { id: 'b', name: 'B', attack: 1, defense: 1, maxHp: 1 } });
    expect(JSON.parse(JSON.stringify(mid))).toEqual(mid);
  });

  it('a JSON-restored mid-fight state resumes identically', () => {
    const s = fight({ attack: 47, defense: 13, maxHp: 333 }, { attack: 41, defense: 29, maxHp: 290 });
    const direct = simulateCombat(s, auto, ctx());
    const restored = simulateCombat(JSON.parse(JSON.stringify(s)) as CombatState, auto, ctx());
    expect(restored).toEqual(direct);
  });

  it('events carry structured values, not prose', () => {
    const r = simulateCombat(fight({ attack: 50, defense: 25, maxHp: 200 }, { attack: 30, defense: 25, maxHp: 120 }), auto, ctx());
    const allowedStrings = new Set(['player', 'enemy', 'basic_attack', 'player_victory', 'enemy_victory', 'draw', 'defeat', 'round_limit',
      'combat_started', 'turn_started', 'action_started', 'damage', 'combatant_defeated', 'combat_ended', 'buddy:7', 'enemy:drone', 'Mira', 'Drone']);
    const strings: string[] = [];
    JSON.stringify(r.events, (_k, v: unknown) => { if (typeof v === 'string') strings.push(v); return v; });
    expect(strings.filter((s) => !allowedStrings.has(s))).toEqual([]);
    for (const e of r.events) if (e.type === 'damage') expect(typeof e.amount).toBe('number');
  });
});
