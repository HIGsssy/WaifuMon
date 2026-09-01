/**
 * Buddy Bonus — the pure decision layer.
 *
 * Everything here is content-shaped on purpose: each case builds a bonus the
 * way a species JSON file would author one, so a test failing here means the
 * *rule* changed, not that a particular Waifumon did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPercentModifier,
  applyPercentModifierInt,
  BUDDY_BONUS_EFFECTS,
  BUDDY_BONUS_EFFECT_IDS,
  BUDDY_BONUS_TARGET_TYPES,
  buddyBonusPercent,
  buddyBonusView,
  encounterRarityWeightPercent,
  encounterSpeciesWeightPercent,
  encounterWeightScope,
  effectRequiresTarget,
  matchesBuddyBonusTarget,
  rollBuddyBonusProc,
  type BuddyBonus,
  type BuddyBonusSubject,
} from '../../src/modules/buddyBonus/buddyBonusEffects';

const subject = (over: Partial<BuddyBonusSubject> = {}): BuddyBonusSubject => ({
  race: 'demon',
  affinity: 'dominant',
  rarity: 'SR',
  owned: false,
  ...over,
});

const bonus = (over: Partial<BuddyBonus>): BuddyBonus => ({
  name: 'Test Bonus',
  flavorText: 'Display only.',
  effectId: 'capture_chance',
  value: 10,
  ...over,
});

describe('capture targeting', () => {
  it('applies to every species when no target is authored', () => {
    const b = bonus({ effectId: 'capture_chance', value: 7 });
    expect(buddyBonusPercent(b, 'capture_chance', subject())).toBe(7);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ race: 'angel', rarity: 'LR' }))).toBe(7);
  });

  it('matches on race', () => {
    const b = bonus({ value: 15, target: { type: 'race', value: 'android' } });
    expect(buddyBonusPercent(b, 'capture_chance', subject({ race: 'android' }))).toBe(15);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ race: 'demon' }))).toBe(0);
  });

  it('matches on affinity', () => {
    const b = bonus({ value: 12, target: { type: 'affinity', value: 'primal' } });
    expect(buddyBonusPercent(b, 'capture_chance', subject({ affinity: 'primal' }))).toBe(12);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ affinity: 'dominant' }))).toBe(0);
  });

  it('matches rarity_min inclusively and upward', () => {
    const b = bonus({ value: 7, target: { type: 'rarity_min', value: 'SSR' } });
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'SR' }))).toBe(0);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'SSR' }))).toBe(7);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'EX' }))).toBe(7);
  });

  it('matches rarity_max inclusively and downward', () => {
    const b = bonus({ value: 5, target: { type: 'rarity_max', value: 'SR' } });
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'N' }))).toBe(5);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'SR' }))).toBe(5);
    expect(buddyBonusPercent(b, 'capture_chance', subject({ rarity: 'SSR' }))).toBe(0);
  });

  it('matches ownership in both directions', () => {
    const owned = bonus({ value: 5, target: { type: 'ownership', value: 'owned' } });
    const unowned = bonus({ value: 5, target: { type: 'ownership', value: 'unowned' } });
    expect(buddyBonusPercent(owned, 'capture_chance', subject({ owned: true }))).toBe(5);
    expect(buddyBonusPercent(owned, 'capture_chance', subject({ owned: false }))).toBe(0);
    expect(buddyBonusPercent(unowned, 'capture_chance', subject({ owned: false }))).toBe(5);
    expect(buddyBonusPercent(unowned, 'capture_chance', subject({ owned: true }))).toBe(0);
  });

  it('contributes nothing to a different effect, or with no buddy at all', () => {
    const b = bonus({ effectId: 'capture_chance', value: 10 });
    expect(buddyBonusPercent(b, 'essence_gain')).toBe(0);
    expect(buddyBonusPercent(null, 'capture_chance', subject())).toBe(0);
    expect(buddyBonusPercent(undefined, 'capture_chance', subject())).toBe(0);
  });

  it('does not apply a targeted bonus when there is no subject to test', () => {
    const b = bonus({ value: 10, target: { type: 'race', value: 'demon' } });
    expect(buddyBonusPercent(b, 'capture_chance')).toBe(0);
  });

  it('treats an absent target as "matches everything"', () => {
    expect(matchesBuddyBonusTarget(undefined, subject())).toBe(true);
    expect(matchesBuddyBonusTarget(null, subject())).toBe(true);
  });
});

describe('percent modifiers', () => {
  it('is relative, not percentage points: 100 at +10% is 110', () => {
    expect(applyPercentModifier(100, 10)).toBe(110);
    expect(applyPercentModifier(100, 0)).toBe(100);
    expect(applyPercentModifier(0.2, 50)).toBeCloseTo(0.3, 10);
  });

  it('doubles at +100%', () => {
    expect(applyPercentModifierInt(3, 100)).toBe(6);
    expect(applyPercentModifier(2.5, 100)).toBe(5);
  });

  it('rounds integer awards rather than flooring them away', () => {
    expect(applyPercentModifierInt(1, 50)).toBe(2);
    expect(applyPercentModifierInt(10, 7)).toBe(11);
    expect(applyPercentModifierInt(10, 0)).toBe(10);
    expect(applyPercentModifierInt(0, 100)).toBe(0);
  });
});

describe('proc chances', () => {
  it('procs below the configured percentage and not at or above it', () => {
    expect(rollBuddyBonusProc(25, 0.24)).toBe(true);
    expect(rollBuddyBonusProc(25, 0.25)).toBe(false);
    expect(rollBuddyBonusProc(25, 0.99)).toBe(false);
  });

  it('never procs at 0 and always procs at 100', () => {
    expect(rollBuddyBonusProc(0, 0)).toBe(false);
    expect(rollBuddyBonusProc(100, 0.999999)).toBe(true);
  });
});

describe('encounter weighting', () => {
  it('routes rarity-shaped targets to the rarity table and species-shaped ones to the bucket', () => {
    expect(encounterWeightScope({ type: 'rarity_min', value: 'SSR' })).toBe('rarity');
    expect(encounterWeightScope({ type: 'rarity', value: 'SR' })).toBe('rarity');
    expect(encounterWeightScope({ type: 'race', value: 'demon' })).toBe('species');
    expect(encounterWeightScope({ type: 'ownership', value: 'owned' })).toBe('species');
  });

  it('scales a matching rarity bucket relatively and leaves the rest alone', () => {
    const b = bonus({ effectId: 'encounter_weight', value: 10, target: { type: 'rarity', value: 'SR' } });
    expect(applyPercentModifier(100, encounterRarityWeightPercent(b, 'SR'))).toBe(110);
    expect(applyPercentModifier(100, encounterRarityWeightPercent(b, 'N'))).toBe(100);
    // A rarity-shaped bonus must not *also* move species weights, or it would
    // apply twice within one draw.
    expect(encounterSpeciesWeightPercent(b, subject({ rarity: 'SR' }))).toBe(0);
  });

  it('scales matching candidates within a bucket and leaves the rest alone', () => {
    const b = bonus({ effectId: 'encounter_weight', value: 20, target: { type: 'race', value: 'human' } });
    expect(applyPercentModifier(100, encounterSpeciesWeightPercent(b, subject({ race: 'human' })))).toBe(120);
    expect(applyPercentModifier(100, encounterSpeciesWeightPercent(b, subject({ race: 'demon' })))).toBe(100);
    expect(encounterRarityWeightPercent(b, 'SR')).toBe(0);
  });

  it('weights owned and unowned candidates apart', () => {
    const b = bonus({
      effectId: 'encounter_weight',
      value: 10,
      target: { type: 'ownership', value: 'unowned' },
    });
    expect(encounterSpeciesWeightPercent(b, subject({ owned: false }))).toBe(10);
    expect(encounterSpeciesWeightPercent(b, subject({ owned: true }))).toBe(0);
  });

  it('ignores a bonus that is not an encounter_weight bonus at all', () => {
    const b = bonus({ effectId: 'capture_chance', value: 50 });
    expect(encounterRarityWeightPercent(b, 'SR')).toBe(0);
    expect(encounterSpeciesWeightPercent(b, subject())).toBe(0);
  });
});

describe('the effect registry', () => {
  it('requires a target exactly where content says it does', () => {
    expect(effectRequiresTarget('encounter_weight')).toBe(true);
    expect(effectRequiresTarget('capture_chance')).toBe(false);
    expect(effectRequiresTarget('care_energy_gain')).toBe(false);
  });

  it('matches content/bonus.json, which is the human-readable copy of it', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'content', 'bonus.json'), 'utf8'),
    ) as {
      buddyBonusEffects: Record<string, unknown>;
      targetValues: Record<string, string[]>;
    };
    expect(Object.keys(raw.buddyBonusEffects).sort()).toEqual([...BUDDY_BONUS_EFFECT_IDS].sort());
    for (const id of BUDDY_BONUS_EFFECT_IDS) {
      expect(raw.buddyBonusEffects[id]).toEqual(BUDDY_BONUS_EFFECTS[id]);
    }
    // Every documented target type is one the code knows how to evaluate.
    for (const type of Object.keys(raw.targetValues)) {
      expect(BUDDY_BONUS_TARGET_TYPES).toContain(
        type === 'rarity' ? 'rarity' : (type as (typeof BUDDY_BONUS_TARGET_TYPES)[number]),
      );
    }
  });
});

describe('display', () => {
  it('carries content copy through untouched and labels the target', () => {
    const view = buddyBonusView(
      bonus({
        name: 'After Bell',
        flavorText: 'After Bell: +5% capture chance against SR and below Waifumon.',
        value: 5,
        target: { type: 'rarity_max', value: 'SR' },
      }),
    );
    expect(view).toEqual({
      name: 'After Bell',
      flavorText: 'After Bell: +5% capture chance against SR and below Waifumon.',
      effectId: 'capture_chance',
      value: 5,
      target: { type: 'rarity_max', value: 'SR' },
      targetLabel: 'SR and below',
    });
  });

  it('has no target label when the bonus applies to everything', () => {
    expect(buddyBonusView(bonus({ target: undefined })).targetLabel).toBeNull();
  });
});
