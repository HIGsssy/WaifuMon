/**
 * Combat modifiers in the generic engine: Crit, Crit Damage, Double Attack,
 * Armor Penetration and Lifesteal — the exact arithmetic and rounding, the
 * draw order, the safety caps, and that a seed reproduces all of it.
 *
 * Fights here run with no damage variance unless a test is about variance, so
 * every number below can be worked out by hand.
 */
import { describe, expect, it } from 'vitest';
import { basicAttackController } from '../../../src/modules/combat/combatController';
import { resolveCombatAction } from '../../../src/modules/combat/combatEngine';
import {
  BASE_CRIT_DAMAGE_BP,
  COMBAT_MODIFIER_CAPS,
  MAX_TOTAL_CRIT_DAMAGE_BP,
  NO_DAMAGE_VARIANCE,
  ZERO_COMBAT_MODIFIERS,
  applyCritMultiplier,
  basicAttackDamage,
  clampCombatModifiers,
  critMultiplierBp,
  effectiveDefense,
  isValidCombatModifiers,
  lifestealAmount,
} from '../../../src/modules/combat/combatMath';
import { simulateCombat } from '../../../src/modules/combat/combatSimulator';
import { createCombatState, modifiersOf } from '../../../src/modules/combat/combatState';
import type { CombatEvent, CombatModifiers, CombatState } from '../../../src/modules/combat/combatTypes';
import { CombatStateInvalidError } from '../../../src/shared/errors';
import { seededRng, type Rng } from '../../../src/shared/random';

const auto = { player: basicAttackController, enemy: basicAttackController };
const mods = (over: Partial<CombatModifiers> = {}): CombatModifiers => ({ ...ZERO_COMBAT_MODIFIERS, ...over });

/**
 * An RNG for exact tests. A draw over a single value (the variance draw of a
 * no-variance fight) answers that value; every other draw — the 1…10000
 * chance rolls — is answered from `rolls`, in order. Running out is an error:
 * a test states every chance draw it expects, so an unexpected one fails.
 */
function chanceRng(...rolls: number[]): Rng & { chanceDraws: number; draws: number } {
  const rng = {
    chanceDraws: 0,
    draws: 0,
    next: () => 0,
    intInclusive(min: number, max: number) {
      rng.draws += 1;
      if (min === max) return min;
      if (rng.chanceDraws >= rolls.length) throw new Error(`unexpected chance draw #${rng.chanceDraws + 1} over [${min}, ${max}]`);
      return rolls[rng.chanceDraws++]!;
    },
  };
  return rng;
}

/** Always succeeds a chance roll (1) / always fails one (10000). */
const ALWAYS = 1;
const NEVER = 10_000;

function fight(
  over: {
    player?: Partial<Parameters<typeof createCombatState>[0]['player']>;
    enemy?: Partial<Parameters<typeof createCombatState>[0]['enemy']>;
  } = {},
): CombatState {
  return createCombatState({
    // ATK 100 into DEF 25 → round(100 × 100 / 125) = 80: the spec's "normal final damage = 80".
    player: { id: 'buddy:1', name: 'Mira', attack: 100, defense: 25, maxHp: 500, ...over.player },
    enemy: { id: 'enemy:drone', name: 'Drone', attack: 30, defense: 25, maxHp: 1_000, ...over.enemy },
    rules: { damageVariance: NO_DAMAGE_VARIANCE },
  });
}

const playerAttack = (state: CombatState, rng: Rng) => resolveCombatAction(state, { type: 'basic_attack', actor: 'player' }, { rng });
const damages = (events: readonly CombatEvent[]) =>
  events.filter((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage');
const ofType = <T extends CombatEvent['type']>(events: readonly CombatEvent[], type: T) =>
  events.filter((e): e is Extract<CombatEvent, { type: T }> => e.type === type);

describe('modifier defaults, validation and caps', () => {
  it('a combatant has no modifiers unless given some', () => {
    const s = fight();
    expect(s.player.modifiers).toEqual({ critChanceBp: 0, critDamageBonusBp: 0, doubleAttackChanceBp: 0, armorPenetrationBp: 0, lifestealBp: 0 });
    expect(s.enemy.modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
  });

  it('a state persisted before modifiers existed fights as all-zero', () => {
    const legacy = JSON.parse(JSON.stringify(fight())) as CombatState;
    delete (legacy.player as Partial<CombatState['player']>).modifiers;
    delete (legacy.enemy as Partial<CombatState['enemy']>).modifiers;
    expect(modifiersOf(legacy.player)).toEqual(ZERO_COMBAT_MODIFIERS);
    const rng = chanceRng();
    const { events } = playerAttack(legacy, rng);
    expect(damages(events)[0]).toMatchObject({ amount: 80, critical: false, bonusAttack: false });
    expect(rng.draws).toBe(1);
  });

  it('the caps are the documented safety ceilings', () => {
    expect(COMBAT_MODIFIER_CAPS).toEqual({
      critChanceBp: 5_000,
      critDamageBonusBp: 10_000,
      doubleAttackChanceBp: 3_500,
      armorPenetrationBp: 5_000,
      lifestealBp: 2_000,
    });
    expect(BASE_CRIT_DAMAGE_BP).toBe(15_000);
    expect(MAX_TOTAL_CRIT_DAMAGE_BP).toBe(25_000);
    expect(critMultiplierBp({ critDamageBonusBp: COMBAT_MODIFIER_CAPS.critDamageBonusBp })).toBe(25_000);
  });

  it('clampCombatModifiers caps each key, floors at zero, and fills missing keys', () => {
    expect(clampCombatModifiers({ critChanceBp: 9_000, critDamageBonusBp: 12_500, doubleAttackChanceBp: 4_000, armorPenetrationBp: 6_000, lifestealBp: 2_500 })).toEqual(
      COMBAT_MODIFIER_CAPS,
    );
    expect(clampCombatModifiers({ critChanceBp: 975 })).toEqual(mods({ critChanceBp: 975 }));
    expect(clampCombatModifiers({ lifestealBp: -5 })).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(clampCombatModifiers(undefined)).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(() => clampCombatModifiers({ critChanceBp: 12.5 })).toThrow(RangeError);
  });

  it('the engine refuses modifiers outside the caps rather than clamping them', () => {
    expect(isValidCombatModifiers(mods({ critChanceBp: 5_000 }))).toBe(true);
    expect(isValidCombatModifiers(mods({ critChanceBp: 5_001 }))).toBe(false);
    expect(isValidCombatModifiers(mods({ lifestealBp: -1 }))).toBe(false);
    expect(isValidCombatModifiers({ critChanceBp: 100 })).toBe(false);
    expect(() => fight({ player: { modifiers: mods({ critChanceBp: 5_001 }) } })).toThrow(CombatStateInvalidError);
    expect(() => fight({ player: { modifiers: mods({ lifestealBp: 1.5 }) } })).toThrow(CombatStateInvalidError);
  });

  it('modifiers survive a JSON round-trip of the state', () => {
    const s = fight({ player: { modifiers: mods({ critChanceBp: 975, lifestealBp: 275 }) } });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('Crit', () => {
  it('zero chance never crits and draws nothing for it', () => {
    const rng = chanceRng();
    const { events } = playerAttack(fight(), rng);
    expect(damages(events)).toHaveLength(1);
    expect(damages(events)[0]).toMatchObject({ amount: 80, critical: false, critMultiplierBp: 10_000 });
    expect(ofType(events, 'critical_hit')).toEqual([]);
    expect(rng.draws).toBe(1); // the variance draw only
    expect(rng.chanceDraws).toBe(0);
  });

  it('a Crit deals the base 150%: 80 → 120', () => {
    const { state, events } = playerAttack(fight({ player: { modifiers: mods({ critChanceBp: 1_000 }) } }), chanceRng(ALWAYS));
    expect(damages(events)[0]).toMatchObject({ variedAmount: 80, amount: 120, critical: true, critMultiplierBp: 15_000, bonusAttack: false });
    expect(ofType(events, 'critical_hit')).toEqual([
      { type: 'critical_hit', round: 1, actor: 'player', target: 'enemy', critMultiplierBp: 15_000, amount: 120 },
    ]);
    expect(state.enemy.currentHp).toBe(1_000 - 120);
  });

  it('the roll succeeds at or below the chance and fails above it', () => {
    const attacker = fight({ player: { modifiers: mods({ critChanceBp: 1_000 }) } });
    expect(damages(playerAttack(attacker, chanceRng(1_000)).events)[0]!.critical).toBe(true);
    expect(damages(playerAttack(attacker, chanceRng(1_001)).events)[0]!.critical).toBe(false);
  });

  it('Crit Damage bonus adds to the base multiplier: +10% and +7.5% → 167.5%', () => {
    // 15000 + 1000 + 750 = 16750; 80 × 1.675 = 134.
    const { events } = playerAttack(
      fight({ player: { modifiers: mods({ critChanceBp: 5_000, critDamageBonusBp: 1_750 }) } }),
      chanceRng(ALWAYS),
    );
    expect(damages(events)[0]).toMatchObject({ amount: 134, critMultiplierBp: 16_750 });
  });

  it('Crit Damage bonus does nothing to a hit that does not crit', () => {
    const { events } = playerAttack(
      fight({ player: { modifiers: mods({ critChanceBp: 1_000, critDamageBonusBp: 5_000 }) } }),
      chanceRng(NEVER),
    );
    expect(damages(events)[0]).toMatchObject({ amount: 80, critical: false, critMultiplierBp: 10_000 });
  });

  it('rounds the Crit half-up, after variance, and never below 1', () => {
    expect(applyCritMultiplier(80, 15_000)).toBe(120);
    expect(applyCritMultiplier(81, 15_000)).toBe(122); // 121.5 → 122
    expect(applyCritMultiplier(33, 16_750)).toBe(55); // 55.275 → 55
    expect(applyCritMultiplier(1, 15_000)).toBe(2); // 1.5 → 2
    // ATK 97 into DEF 25 → round(77.6) = 78; ×1.5 = 117.
    const { events } = playerAttack(fight({ player: { attack: 97, modifiers: mods({ critChanceBp: 100 }) } }), chanceRng(ALWAYS));
    expect(damages(events)[0]).toMatchObject({ baseAmount: 78, variedAmount: 78, amount: 117 });
  });

  it('at the cap a Crit deals 250%, and no more', () => {
    const { events } = playerAttack(
      fight({ player: { modifiers: mods({ critChanceBp: 5_000, critDamageBonusBp: COMBAT_MODIFIER_CAPS.critDamageBonusBp }) } }),
      chanceRng(ALWAYS),
    );
    expect(damages(events)[0]).toMatchObject({ amount: 200, critMultiplierBp: 25_000 });
  });

  it('the Crit multiplier applies to the damage after variance', () => {
    const state = createCombatState({
      player: { id: 'buddy:1', name: 'Mira', attack: 100, defense: 25, maxHp: 500, modifiers: mods({ critChanceBp: 5_000 }) },
      enemy: { id: 'enemy:drone', name: 'Drone', attack: 30, defense: 25, maxHp: 1_000 },
    });
    // Variance draw 11000 (×1.10) → 88; Crit draw 1 → 88 × 1.5 = 132.
    const picks = [11_000, 1];
    const rng: Rng = { next: () => 0, intInclusive: () => picks.shift()! };
    const { events } = playerAttack(state, rng);
    expect(damages(events)[0]).toMatchObject({ baseAmount: 80, varianceBasisPoints: 11_000, variedAmount: 88, amount: 132, critical: true });
  });
});

describe('Double Attack', () => {
  const doubler = (over: Partial<CombatModifiers> = {}) => fight({ player: { modifiers: mods({ doubleAttackChanceBp: 2_000, ...over }) } });

  it('zero chance never triggers and draws nothing for it', () => {
    const rng = chanceRng();
    const { events } = playerAttack(fight(), rng);
    expect(ofType(events, 'bonus_attack_triggered')).toEqual([]);
    expect(damages(events)).toHaveLength(1);
    expect(rng.draws).toBe(1);
  });

  it('a trigger adds exactly one bonus basic attack', () => {
    const { state, events } = playerAttack(doubler(), chanceRng(ALWAYS));
    expect(events.map((e) => e.type)).toEqual(['action_started', 'damage', 'bonus_attack_triggered', 'damage', 'turn_started']);
    expect(damages(events).map((e) => [e.amount, e.bonusAttack])).toEqual([
      [80, false],
      [80, true],
    ]);
    expect(ofType(events, 'bonus_attack_triggered')[0]).toEqual({ type: 'bonus_attack_triggered', round: 1, actor: 'player', doubleAttackChanceBp: 2_000 });
    expect(state.enemy.currentHp).toBe(1_000 - 160);
    expect(state.turn).toBe('enemy');
  });

  it('a failed roll is one normal attack', () => {
    const { events } = playerAttack(doubler(), chanceRng(NEVER));
    expect(damages(events)).toHaveLength(1);
    expect(ofType(events, 'bonus_attack_triggered')).toEqual([]);
  });

  it('never chains: the bonus attack does not roll Double Attack again', () => {
    // One chance draw is scripted. A second Double Attack roll would be an
    // unexpected draw and throw — even though it would also "succeed".
    const rng = chanceRng(ALWAYS);
    const { events } = playerAttack(doubler({ doubleAttackChanceBp: COMBAT_MODIFIER_CAPS.doubleAttackChanceBp }), rng);
    expect(damages(events)).toHaveLength(2);
    expect(rng.chanceDraws).toBe(1);
    expect(ofType(events, 'bonus_attack_triggered')).toHaveLength(1);
  });

  it('the bonus attack rolls its own Crit', () => {
    // Draws: normal Crit (fail), Double Attack (trigger), bonus Crit (crit).
    const rng = chanceRng(NEVER, ALWAYS, ALWAYS);
    const { events } = playerAttack(doubler({ critChanceBp: 1_000 }), rng);
    expect(damages(events).map((e) => [e.amount, e.critical, e.bonusAttack])).toEqual([
      [80, false, false],
      [120, true, true],
    ]);
    expect(rng.chanceDraws).toBe(3);
  });

  it('the bonus attack lifesteals', () => {
    const state = fight({ player: { currentHp: 100, modifiers: mods({ doubleAttackChanceBp: 2_000, lifestealBp: 1_000 }) } });
    const { state: after, events } = playerAttack(state, chanceRng(ALWAYS));
    // 80 damage × 10% = 8 per strike.
    expect(ofType(events, 'lifesteal_heal').map((e) => [e.amount, e.bonusAttack])).toEqual([
      [8, false],
      [8, true],
    ]);
    expect(after.player.currentHp).toBe(116);
  });

  it('the bonus attack uses Armor Penetration and normal ATK', () => {
    const { events } = playerAttack(doubler({ armorPenetrationBp: 5_000 }), chanceRng(ALWAYS));
    // DEF 25 → 12; round(100 × 100 / 112) = 89, both strikes.
    expect(damages(events).map((e) => [e.effectiveDefense, e.amount])).toEqual([
      [12, 89],
      [12, 89],
    ]);
  });

  it('does not roll when the normal attack already defeated the target', () => {
    const rng = chanceRng();
    const { state, events } = playerAttack(fight({ player: { modifiers: mods({ doubleAttackChanceBp: 3_500 }) }, enemy: { maxHp: 50 } }), rng);
    expect(state.status).toBe('player_victory');
    expect(damages(events)).toHaveLength(1);
    expect(rng.chanceDraws).toBe(0);
  });

  it('a bonus attack can land the defeating blow', () => {
    const { state, events } = playerAttack(fight({ player: { modifiers: mods({ doubleAttackChanceBp: 2_000 }) }, enemy: { maxHp: 150 } }), chanceRng(ALWAYS));
    expect(state.status).toBe('player_victory');
    expect(events.map((e) => e.type)).toEqual(['action_started', 'damage', 'bonus_attack_triggered', 'damage', 'combatant_defeated', 'combat_ended']);
    expect(damages(events)[1]).toMatchObject({ targetHpBefore: 70, targetHpAfter: 0, bonusAttack: true });
  });
});

describe('Armor Penetration', () => {
  it('zero leaves DEF alone', () => {
    expect(effectiveDefense(100, 0)).toBe(100);
    const { events } = playerAttack(fight(), chanceRng());
    expect(damages(events)[0]).toMatchObject({ targetDefense: 25, effectiveDefense: 25, armorPenetrationBp: 0 });
  });

  it('reduces the DEF the formula uses, floored, without touching the target', () => {
    expect(effectiveDefense(100, 750)).toBe(92); // 92.5 → 92
    expect(effectiveDefense(100, 1_200)).toBe(88);
    expect(effectiveDefense(33, 1_000)).toBe(29); // 29.7 → 29
    const before = fight({ player: { modifiers: mods({ armorPenetrationBp: 2_000 }) }, enemy: { defense: 100 } });
    const { state, events } = playerAttack(before, chanceRng());
    // DEF 100 → 80; round(100 × 100 / 180) = 56 (vs 50 without).
    expect(damages(events)[0]).toMatchObject({ targetDefense: 100, effectiveDefense: 80, armorPenetrationBp: 2_000, baseAmount: 56, amount: 56 });
    expect(state.enemy.defense).toBe(100);
    expect(before.enemy.defense).toBe(100);
  });

  it('at the cap half the DEF is ignored', () => {
    expect(effectiveDefense(200, COMBAT_MODIFIER_CAPS.armorPenetrationBp)).toBe(100);
  });

  it('effective DEF is never negative', () => {
    for (const def of [0, 1, 7, 100, 9_999]) {
      for (const pen of [0, 1, 4_999, 5_000, 10_000, 20_000]) {
        expect(effectiveDefense(def, pen)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(effectiveDefense(0, 5_000)).toBe(0);
  });

  it('is worth more against high DEF', () => {
    const gain = (def: number) => basicAttackDamage(200, effectiveDefense(def, 1_200)) - basicAttackDamage(200, def);
    const share = (def: number) => gain(def) / basicAttackDamage(200, def);
    expect(share(20)).toBeLessThan(share(100));
    expect(share(100)).toBeLessThan(share(300));
    expect(gain(0)).toBe(0);
  });

  it('combines with Crit: penetration first, then the multiplier', () => {
    const { events } = playerAttack(
      fight({ player: { modifiers: mods({ armorPenetrationBp: 2_000, critChanceBp: 1_000 }) }, enemy: { defense: 100 } }),
      chanceRng(ALWAYS),
    );
    // 56 after penetration → 56 × 1.5 = 84.
    expect(damages(events)[0]).toMatchObject({ effectiveDefense: 80, variedAmount: 56, amount: 84, critical: true });
  });

  it('the enemy never penetrates the player (it has no modifiers)', () => {
    const afterPlayer = playerAttack(fight({ player: { modifiers: mods({ armorPenetrationBp: 5_000 }) } }), chanceRng()).state;
    const { events } = resolveCombatAction(afterPlayer, { type: 'basic_attack', actor: 'enemy' }, { rng: chanceRng() });
    expect(damages(events)[0]).toMatchObject({ targetDefense: 25, effectiveDefense: 25, armorPenetrationBp: 0 });
  });
});

describe('Lifesteal', () => {
  const hurt = (lifestealBp: number, over: Partial<Parameters<typeof createCombatState>[0]['player']> = {}) =>
    fight({ player: { currentHp: 100, modifiers: mods({ lifestealBp }), ...over } });

  it('heals from the damage dealt, rounded half-up', () => {
    expect(lifestealAmount(80, 500)).toBe(4);
    expect(lifestealAmount(30, 500)).toBe(2); // 1.5 → 2
    expect(lifestealAmount(49, 100)).toBe(0); // 0.49 → 0
    expect(lifestealAmount(50, 100)).toBe(1); // 0.5 → 1
    expect(lifestealAmount(0, 2_000)).toBe(0);
    expect(lifestealAmount(80, 0)).toBe(0);
    const { state, events } = playerAttack(hurt(500), chanceRng());
    expect(ofType(events, 'lifesteal_heal')).toEqual([
      { type: 'lifesteal_heal', round: 1, actor: 'player', amount: 4, rawAmount: 4, damageDealt: 80, lifestealBp: 500, hpBefore: 100, hpAfter: 104, bonusAttack: false },
    ]);
    expect(state.player.currentHp).toBe(104);
  });

  it('uses the HP actually removed, not the nominal damage', () => {
    // The target has 30 HP; the hit would deal 80. 5% of 30 = 1.5 → 2, not 4.
    const { state, events } = playerAttack(fight({ player: { currentHp: 100, modifiers: mods({ lifestealBp: 500 }) }, enemy: { maxHp: 30 } }), chanceRng());
    expect(damages(events)[0]).toMatchObject({ amount: 80, targetHpBefore: 30, targetHpAfter: 0 });
    expect(ofType(events, 'lifesteal_heal')[0]).toMatchObject({ damageDealt: 30, amount: 2 });
    expect(state.player.currentHp).toBe(102);
    expect(state.status).toBe('player_victory');
  });

  it('a Crit heals more because it deals more', () => {
    const { events } = playerAttack(hurt(1_000, { modifiers: mods({ lifestealBp: 1_000, critChanceBp: 1_000 }) }), chanceRng(ALWAYS));
    expect(ofType(events, 'lifesteal_heal')[0]).toMatchObject({ damageDealt: 120, amount: 12 });
  });

  it('never overheals: the heal is clamped at max HP', () => {
    const { state, events } = playerAttack(hurt(2_000, { currentHp: 495 }), chanceRng());
    expect(ofType(events, 'lifesteal_heal')[0]).toMatchObject({ rawAmount: 16, amount: 5, hpBefore: 495, hpAfter: 500 });
    expect(state.player.currentHp).toBe(500);
  });

  it('at full HP nothing is healed and no heal event is emitted', () => {
    const { state, events } = playerAttack(fight({ player: { modifiers: mods({ lifestealBp: 2_000 }) } }), chanceRng());
    expect(ofType(events, 'lifesteal_heal')).toEqual([]);
    expect(state.player.currentHp).toBe(500);
  });

  it('zero lifesteal heals nothing', () => {
    const { state, events } = playerAttack(hurt(0), chanceRng());
    expect(ofType(events, 'lifesteal_heal')).toEqual([]);
    expect(state.player.currentHp).toBe(100);
  });

  it('does not mutate the input state', () => {
    const before = hurt(1_000);
    playerAttack(before, chanceRng());
    expect(before.player.currentHp).toBe(100);
  });
});

describe('determinism and observed frequencies', () => {
  const build = (modifiers: CombatModifiers) =>
    createCombatState({
      player: { id: 'buddy:1', name: 'Mira', attack: 120, defense: 80, maxHp: 900, modifiers },
      enemy: { id: 'enemy:drone', name: 'Drone', attack: 110, defense: 70, maxHp: 900 },
    });
  const everything = mods({ critChanceBp: 1_500, critDamageBonusBp: 2_000, doubleAttackChanceBp: 1_000, armorPenetrationBp: 1_200, lifestealBp: 500 });

  it('the same state, actions and seed give the same fight, modifiers and all', () => {
    const a = simulateCombat(build(everything), auto, { rng: seededRng(4242) });
    const b = simulateCombat(build(everything), auto, { rng: seededRng(4242) });
    expect(b).toEqual(a);
    expect(a.events.some((e) => e.type === 'critical_hit')).toBe(true);
    // A different seed is a different fight.
    const c = simulateCombat(build(everything), auto, { rng: seededRng(4243) });
    expect(c.events).not.toEqual(a.events);
  });

  it('a combatant without modifiers draws exactly once per action, as before', () => {
    let draws = 0;
    const base = seededRng(7);
    const counting: Rng = {
      next: () => base.next(),
      intInclusive: (min, max) => {
        draws += 1;
        return base.intInclusive(min, max);
      },
    };
    const result = simulateCombat(build(mods()), auto, { rng: counting });
    expect(draws).toBe(result.actions);
  });

  /** Player strikes over many seeded fights against a target that never dies. */
  function sample(modifiers: CombatModifiers, fights = 400) {
    let normal = 0;
    let bonus = 0;
    let crits = 0;
    let bonusCrits = 0;
    let bonusHeals = 0;
    let chained = 0;
    for (let seed = 1; seed <= fights; seed += 1) {
      const state = createCombatState({
        player: { id: 'buddy:1', name: 'Mira', attack: 100, defense: 500, maxHp: 100_000, currentHp: 50_000, modifiers },
        enemy: { id: 'enemy:wall', name: 'Wall', attack: 1, defense: 0, maxHp: 1_000_000 },
      });
      const { events } = simulateCombat(state, auto, { rng: seededRng(seed) });
      let previousWasBonus = false;
      for (const e of events) {
        if (e.type === 'damage' && e.actor === 'player') {
          if (e.bonusAttack) {
            bonus += 1;
            if (previousWasBonus) chained += 1;
            if (e.critical) bonusCrits += 1;
          } else normal += 1;
          if (e.critical) crits += 1;
          previousWasBonus = e.bonusAttack;
        } else if (e.type === 'lifesteal_heal' && e.actor === 'player' && e.bonusAttack) bonusHeals += 1;
      }
    }
    return { normal, bonus, strikes: normal + bonus, crits, bonusCrits, bonusHeals, chained };
  }

  it.each([500, 1_000, 2_500, 5_000])('observed Crit rate tracks a configured %i bp', (critChanceBp) => {
    const s = sample(mods({ critChanceBp }));
    expect(s.strikes).toBe(12_000); // 400 fights × 30 rounds
    // 12,000 trials: 4 standard deviations is under 1.9 percentage points.
    expect(s.crits / s.strikes).toBeCloseTo(critChanceBp / 10_000, 1);
    expect(Math.abs(s.crits / s.strikes - critChanceBp / 10_000)).toBeLessThan(0.02);
  });

  it.each([400, 1_800, 3_500])('observed Double Attack rate tracks a configured %i bp', (doubleAttackChanceBp) => {
    const s = sample(mods({ doubleAttackChanceBp }));
    expect(s.normal).toBe(12_000);
    expect(Math.abs(s.bonus / s.normal - doubleAttackChanceBp / 10_000)).toBeLessThan(0.02);
    // Extra attacks per 30-round fight ≈ 30 × chance.
    expect(s.bonus / 400).toBeCloseTo((30 * doubleAttackChanceBp) / 10_000, 0);
  });

  it('over a large sample bonus attacks crit, lifesteal, and never chain', () => {
    const s = sample(mods({ doubleAttackChanceBp: 3_500, critChanceBp: 2_500, lifestealBp: 2_000 }));
    expect(s.bonus).toBeGreaterThan(3_500);
    expect(s.bonusCrits).toBeGreaterThan(0);
    expect(Math.abs(s.bonusCrits / s.bonus - 0.25)).toBeLessThan(0.03);
    expect(s.bonusHeals).toBeGreaterThan(0);
    expect(s.chained).toBe(0);
  });
});
