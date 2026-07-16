/**
 * Pure progression math — level curve, energy, prestige, shifts.
 */
import { describe, expect, it } from 'vitest';
import {
  cumulativeXpForLevel,
  dailyBonusItemsForLevel,
  dailyRareItemChanceForLevel,
  describeLevelRewards,
  levelFromTotalXp,
  levelProgress,
  maxEnergyForLevel,
  prestigeTitleForLevel,
  rareEncounterShift,
  xpToNext,
} from '../../src/modules/progression/progressionMath';
import type { ProgressionConfig } from '../../src/modules/content/schemas';

const config: ProgressionConfig = {
  levelCurve: { base: 100, growth: 50 },
  maxLevel: 50,
  maxEnergy: {
    cap: 40,
    levelBonuses: [
      { atLevel: 7, delta: 5 },
      { atLevel: 20, delta: 5 },
    ],
  },
  xp: {
    hunt: 5,
    captureFailed: 2,
    captureSuccessByRarity: { N: 10, R: 15, SR: 25, SSR: 50, UR: 100, LR: 200, EX: 100 },
    newDexEntry: 25,
    dailyClaim: 20,
  },
  rareEncounterShift: {
    atLevel: 40,
    fromRarity: 'N',
    toRarity: 'R',
    weightUnits: 1,
  },
  dailyBonusItems: [{ atLevel: 12, slug: 'silk_charm', quantity: 1 }],
  dailyRareItemChance: {
    atLevel: 30,
    chance: 0.15,
    slug: 'velvet_charm',
    quantity: 1,
  },
  prestigeTitles: [{ atLevel: 50, label: 'Prestige Hunter' }],
};

describe('level curve', () => {
  it('xpToNext(level) = base + growth × (level − 1)', () => {
    expect(xpToNext(1, config)).toBe(100);
    expect(xpToNext(2, config)).toBe(150);
    expect(xpToNext(7, config)).toBe(400);
    expect(xpToNext(50, config)).toBe(0); // maxed
  });

  it('cumulativeXpForLevel matches summed xpToNext values', () => {
    expect(cumulativeXpForLevel(1, config)).toBe(0);
    expect(cumulativeXpForLevel(2, config)).toBe(100);
    expect(cumulativeXpForLevel(3, config)).toBe(250);
    expect(cumulativeXpForLevel(4, config)).toBe(450);
  });

  it('levelFromTotalXp is monotonic and matches the curve', () => {
    expect(levelFromTotalXp(0, config)).toBe(1);
    expect(levelFromTotalXp(99, config)).toBe(1);
    expect(levelFromTotalXp(100, config)).toBe(2);
    expect(levelFromTotalXp(249, config)).toBe(2);
    expect(levelFromTotalXp(250, config)).toBe(3);
    // Level 7 threshold = 100+150+200+250+300+350 = 1350
    expect(levelFromTotalXp(1349, config)).toBe(6);
    expect(levelFromTotalXp(1350, config)).toBe(7);
    // Never exceeds maxLevel.
    expect(levelFromTotalXp(999_999_999, config)).toBe(50);
  });

  it('levelProgress reports xpIntoLevel + xpToNext coherently', () => {
    const p = levelProgress(275, config);
    expect(p.level).toBe(3);
    expect(p.xpIntoLevel).toBe(25); // 275 − 250
    expect(p.xpToNext).toBe(200); // level 3 → 4
    expect(p.atMaxLevel).toBe(false);
  });
});

describe('max energy scaling', () => {
  it('level 1 = base', () => {
    expect(maxEnergyForLevel(1, 25, config)).toBe(25);
  });
  it('level 7 adds +5', () => {
    expect(maxEnergyForLevel(7, 25, config)).toBe(30);
    expect(maxEnergyForLevel(19, 25, config)).toBe(30);
  });
  it('level 20 adds another +5', () => {
    expect(maxEnergyForLevel(20, 25, config)).toBe(35);
    expect(maxEnergyForLevel(50, 25, config)).toBe(35);
  });
  it('cap clamps runaway config', () => {
    const runaway: ProgressionConfig = {
      ...config,
      maxEnergy: { cap: 40, levelBonuses: [{ atLevel: 1, delta: 100 }] },
    };
    expect(maxEnergyForLevel(1, 25, runaway)).toBe(40);
  });
});

describe('rare encounter shift', () => {
  it('returns null below the threshold', () => {
    expect(rareEncounterShift(39, config)).toBeNull();
  });
  it('activates at level 40 exactly', () => {
    const shift = rareEncounterShift(40, config);
    expect(shift?.fromRarity).toBe('N');
    expect(shift?.toRarity).toBe('R');
    expect(shift?.weightUnits).toBe(1);
  });
  it('remains active at higher levels', () => {
    expect(rareEncounterShift(50, config)).not.toBeNull();
  });
});

describe('prestige, daily bonuses, rare item chance', () => {
  it('prestige title unlocks at level 50', () => {
    expect(prestigeTitleForLevel(49, config)).toBeNull();
    expect(prestigeTitleForLevel(50, config)).toBe('Prestige Hunter');
  });
  it('daily bonus items unlock at level 12', () => {
    expect(dailyBonusItemsForLevel(11, config)).toEqual([]);
    expect(dailyBonusItemsForLevel(12, config)).toEqual([
      { slug: 'silk_charm', quantity: 1 },
    ]);
  });
  it('daily rare item chance activates at level 30', () => {
    expect(dailyRareItemChanceForLevel(29, config)).toBe(0);
    expect(dailyRareItemChanceForLevel(30, config)).toBe(0.15);
  });
});

describe('describeLevelRewards', () => {
  it('mentions +5 max energy at 7 and 20', () => {
    expect(describeLevelRewards(7, config)).toContain('Max Hunt Energy +5');
    expect(describeLevelRewards(20, config)).toContain('Max Hunt Energy +5');
  });
  it('mentions the level-12 daily bonus', () => {
    expect(describeLevelRewards(12, config).join(' ')).toMatch(/silk_charm/);
  });
  it('mentions the level-30 rare-item chance', () => {
    expect(describeLevelRewards(30, config).join(' ')).toMatch(/rare-item/i);
  });
  it('mentions the level-40 rare shift', () => {
    expect(describeLevelRewards(40, config).join(' ')).toMatch(/Rare/i);
  });
  it('mentions the level-50 prestige title', () => {
    expect(describeLevelRewards(50, config).join(' ')).toMatch(/Prestige Hunter/);
  });
});
