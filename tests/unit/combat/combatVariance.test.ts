/**
 * Damage variance: the roll's bounds, the exact rounding order, the minimum
 * hit, and reproducibility — the same state, actions and seed give the same
 * fight; a different seed gives a different one.
 */
import { describe, expect, it } from 'vitest';
import { basicAttackController } from '../../../src/modules/combat/combatController';
import { resolveCombatAction } from '../../../src/modules/combat/combatEngine';
import {
  DAMAGE_BASIS_POINTS,
  DEFAULT_DAMAGE_VARIANCE,
  MIN_DAMAGE,
  NO_DAMAGE_VARIANCE,
  applyDamageVariance,
  basicAttackDamage,
  isValidDamageVariance,
  rollBasicAttackDamage,
} from '../../../src/modules/combat/combatMath';
import { simulateCombat } from '../../../src/modules/combat/combatSimulator';
import { createCombatState } from '../../../src/modules/combat/combatState';
import type { CombatEvent, CombatRules, CombatState } from '../../../src/modules/combat/combatTypes';
import { seededRng, type Rng } from '../../../src/shared/random';

const auto = { player: basicAttackController, enemy: basicAttackController };

/** An `Rng` that answers every draw with a fixed point in the range, and counts draws. */
function fixedRng(at: 'min' | 'max' | number): Rng & { draws: number } {
  const rng = {
    draws: 0,
    next: () => {
      rng.draws += 1;
      return 0;
    },
    intInclusive: (min: number, max: number) => {
      rng.draws += 1;
      return at === 'min' ? min : at === 'max' ? max : at;
    },
  };
  return rng;
}

function fight(rules?: Partial<CombatRules>): CombatState {
  return createCombatState({
    player: { id: 'buddy:1', name: 'Mira', attack: 130, defense: 111, maxHp: 444 },
    enemy: { id: 'enemy:bruiser', name: 'Bruiser', attack: 100, defense: 55, maxHp: 520 },
    ...(rules ? { rules } : {}),
  });
}

const damage = (events: CombatEvent[]) => events.filter((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage');

describe('the damage variance range', () => {
  it('ships as 90%–110%, in basis points', () => {
    expect(DAMAGE_BASIS_POINTS).toBe(10_000);
    expect(DEFAULT_DAMAGE_VARIANCE).toEqual({ minBasisPoints: 9_000, maxBasisPoints: 11_000 });
    expect(NO_DAMAGE_VARIANCE).toEqual({ minBasisPoints: 10_000, maxBasisPoints: 10_000 });
  });

  it('accepts only integer basis points with 1 <= min <= max <= 30000', () => {
    expect(isValidDamageVariance(DEFAULT_DAMAGE_VARIANCE)).toBe(true);
    expect(isValidDamageVariance({ minBasisPoints: 10_000, maxBasisPoints: 10_000 })).toBe(true);
    for (const bad of [
      null,
      {},
      { minBasisPoints: 11_000, maxBasisPoints: 9_000 },
      { minBasisPoints: 0, maxBasisPoints: 10_000 },
      { minBasisPoints: 9_000.5, maxBasisPoints: 11_000 },
      { minBasisPoints: 9_000, maxBasisPoints: 30_001 },
      { minBasisPoints: '9000', maxBasisPoints: 11_000 },
    ]) {
      expect(isValidDamageVariance(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('rollBasicAttackDamage', () => {
  it('rolls the minimum and the maximum of the range, both inclusive', () => {
    // 100 ATK into 0 DEF: base 100.
    expect(rollBasicAttackDamage(100, 0, DEFAULT_DAMAGE_VARIANCE, fixedRng('min'))).toEqual({ base: 100, varianceBasisPoints: 9_000, amount: 90 });
    expect(rollBasicAttackDamage(100, 0, DEFAULT_DAMAGE_VARIANCE, fixedRng('max'))).toEqual({ base: 100, varianceBasisPoints: 11_000, amount: 110 });
  });

  it('never leaves the range, and reaches both ends of it, over many real draws', () => {
    const rng = seededRng(2026);
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) {
      const roll = rollBasicAttackDamage(200, 100, DEFAULT_DAMAGE_VARIANCE, rng);
      expect(roll.base).toBe(100);
      expect(roll.varianceBasisPoints).toBeGreaterThanOrEqual(9_000);
      expect(roll.varianceBasisPoints).toBeLessThanOrEqual(11_000);
      expect(Number.isInteger(roll.varianceBasisPoints)).toBe(true);
      seen.add(roll.amount);
    }
    expect(Math.min(...seen)).toBe(90);
    expect(Math.max(...seen)).toBe(110);
    // Every integer in between is reachable: no gaps from the rounding.
    expect(seen.size).toBe(21);
  });

  it('draws exactly once per hit', () => {
    const rng = fixedRng('min');
    rollBasicAttackDamage(50, 25, DEFAULT_DAMAGE_VARIANCE, rng);
    expect(rng.draws).toBe(1);
  });

  it('rounds the base first, then the varied product half-up, then applies the minimum', () => {
    // 10 ATK into 50 DEF: raw 6.67 → base 7 (rounded BEFORE the roll).
    expect(basicAttackDamage(10, 50)).toBe(7);
    // 7 × 0.90 = 6.3 → 6;  7 × 1.10 = 7.7 → 8;  7 × 0.93 = 6.51 → 7;  7 × 0.9286 = 6.5002 → 7
    expect(applyDamageVariance(7, 9_000)).toBe(6);
    expect(applyDamageVariance(7, 11_000)).toBe(8);
    expect(applyDamageVariance(7, 9_300)).toBe(7);
    // An exact half rounds up: 5 × 0.90 = 4.5 → 5;  15 × 1.10 = 16.5 → 17;  25 × 0.90 = 22.5 → 23.
    expect(applyDamageVariance(5, 9_000)).toBe(5);
    expect(applyDamageVariance(15, 11_000)).toBe(17);
    expect(applyDamageVariance(25, 9_000)).toBe(23);
    // Just under a half rounds down: 5 × 0.8999 = 4.4995 → 4.
    expect(applyDamageVariance(5, 8_999)).toBe(4);
    // Had the roll been applied to the raw 6.67 instead, ×1.10 would give 7.33 → 7, not 8.
    expect(rollBasicAttackDamage(10, 50, DEFAULT_DAMAGE_VARIANCE, fixedRng('max')).amount).toBe(8);
    // ×1.00 is the base, exactly.
    for (const base of [1, 7, 40, 333]) expect(applyDamageVariance(base, 10_000)).toBe(base);
  });

  it('never deals less than the minimum, however low the roll', () => {
    expect(MIN_DAMAGE).toBe(1);
    // Base 1 × 0.90 = 0.9 → rounds to 1; a hypothetical 40% roll → 0.4 → 0 → clamped to 1.
    expect(applyDamageVariance(1, 9_000)).toBe(1);
    expect(applyDamageVariance(1, 4_000)).toBe(1);
    expect(rollBasicAttackDamage(1, 1_000_000, DEFAULT_DAMAGE_VARIANCE, fixedRng('min')).amount).toBe(1);
    expect(rollBasicAttackDamage(0, 0, { minBasisPoints: 1, maxBasisPoints: 1 }, fixedRng('min')).amount).toBe(1);
  });
});

describe('a fight with variance', () => {
  it('reports the base, the roll and the result on every damage event', () => {
    const { events } = resolveCombatAction(fight(), { type: 'basic_attack', actor: 'player' }, { rng: fixedRng('max') });
    // 130 ATK into 55 DEF: 83.87 → 84; × 1.10 = 92.4 → 92.
    expect(damage(events)[0]).toMatchObject({ baseAmount: 84, varianceBasisPoints: 11_000, amount: 92, targetHpBefore: 520, targetHpAfter: 428 });
  });

  it('draws nothing for a refused action', () => {
    const rng = fixedRng('min');
    expect(() => resolveCombatAction(fight(), { type: 'basic_attack', actor: 'enemy' }, { rng })).toThrow();
    expect(() => resolveCombatAction(fight(), { type: 'defend', actor: 'player' }, { rng })).toThrow();
    expect(rng.draws).toBe(0);
  });

  it('is identical for the same starting state, actions and seed', () => {
    for (const seed of [0, 1, 42, 0xffff_ffff]) {
      const a = simulateCombat(fight(), auto, { rng: seededRng(seed) });
      const b = simulateCombat(fight(), auto, { rng: seededRng(seed) });
      expect(b).toEqual(a);
    }
  });

  it('is identical when resumed from a serialised state with the stream where it was left', () => {
    const rng = seededRng(77);
    let state = fight();
    const stepped: CombatEvent[] = [];
    while (state.status === 'active') {
      // Park the state as JSON between every action, as an interactive fight would.
      const step = resolveCombatAction(JSON.parse(JSON.stringify(state)) as CombatState, { type: 'basic_attack', actor: state.turn }, { rng });
      state = step.state;
      stepped.push(...step.events);
    }
    const whole = simulateCombat(fight(), auto, { rng: seededRng(77) });
    expect(state).toEqual(whole.finalState);
    expect(damage(stepped)).toEqual(damage(whole.events));
  });

  it('varies across seeds', () => {
    const finals = new Set<string>();
    const rolls = new Set<number>();
    for (let seed = 1; seed <= 50; seed++) {
      const r = simulateCombat(fight(), auto, { rng: seededRng(seed) });
      finals.add(`${r.result}:${r.finalState.player.currentHp}:${r.finalState.enemy.currentHp}`);
      for (const hit of damage(r.events)) rolls.add(hit.varianceBasisPoints);
    }
    expect(finals.size).toBeGreaterThan(10);
    expect(rolls.size).toBeGreaterThan(100);
  });

  it('softens a threshold: a matchup that base damage always loses is sometimes won', () => {
    // Tuned to the edge: with no variance the player falls one hit short.
    const edge = (rules?: Partial<CombatRules>) =>
      createCombatState({
        player: { id: 'buddy:1', name: 'Mira', attack: 100, defense: 0, maxHp: 100 },
        enemy: { id: 'enemy:x', name: 'X', attack: 34, defense: 0, maxHp: 301 },
        ...(rules ? { rules } : {}),
      });
    expect(simulateCombat(edge({ damageVariance: NO_DAMAGE_VARIANCE }), auto, { rng: seededRng(1) }).result).toBe('enemy_victory');
    const results = Array.from({ length: 400 }, (_, seed) => simulateCombat(edge(), auto, { rng: seededRng(seed) }).result);
    const wins = results.filter((r) => r === 'player_victory').length;
    expect(wins).toBeGreaterThan(0);
    expect(wins).toBeLessThan(400);
  });

  it('with the variance pinned to 100% is the deterministic fight, whatever the seed', () => {
    const flat = { damageVariance: NO_DAMAGE_VARIANCE };
    const a = simulateCombat(fight(flat), auto, { rng: seededRng(1) });
    const b = simulateCombat(fight(flat), auto, { rng: seededRng(999) });
    expect(b).toEqual(a);
    for (const hit of damage(a.events)) expect(hit.amount).toBe(hit.baseAmount);
  });
});
