/**
 * The shipped base Equipment catalogue: the authored Attack and Defense
 * definitions with their first-pass multiplier ranges, and the starters the
 * onboarding depends on. Values are pinned exactly as signed off — the ranges
 * overlap across rarities on purpose and must not be "normalised".
 */
import { describe, expect, it } from 'vitest';
import {
  affixPoolOf,
  buildAffixCatalogue,
  isEquipmentAffixPool,
} from '../../src/modules/equipment/affixCatalogue';
import { parseEquipmentDefinition } from '../../src/modules/equipment/definitionSchema';
import {
  equipmentDisplayName,
  isMultiplierInRange,
  multiplierRangeIssues,
} from '../../src/modules/equipment/equipmentRoll';
import { loadEquipmentSeedCatalogue } from '../../src/modules/equipment/seed';
import { eligibleRewardDefinitions } from '../../src/modules/equipment/rewardSelector';
import { STARTER_EQUIPMENT, STARTER_ROLLS } from '../../src/modules/onboarding/vocabulary';
import { CONTENT_DIR, loadShippedContent } from '../helpers/fixtures';

const catalogue = loadEquipmentSeedCatalogue(CONTENT_DIR);
const affixes = loadShippedContent().equipmentAffixes ?? [];

type Row = [key: string, name: string, description: string, rarity: string, min: number, max: number];

const ATTACK: Row[] = [
  ['rusty_pipe', 'Rusty Pipe', 'Still hits. Still embarrassing.', 'N', 4000, 6000],
  ['starter_pistol', 'Starter Pistol', 'Loud, inaccurate, weirdly comforting.', 'N', 4500, 6500],
  ['weighted_wand', 'Weighted Wand', 'Marketed as “massage.” Used as “persuasion.”', 'N', 4500, 6500],
  ['throwing_knives', 'Throwing Knives (Set of 3)', 'You’ll lose at least one.', 'N', 5000, 7000],
  ['stun_baton', 'Stun Baton', 'Non-lethal. Mostly.', 'N', 5000, 7000],
  ['suction_cup_morningstar', 'Suction-Cup Morningstar', 'Attaches to shields and bad decisions.', 'N', 5500, 7500],
  ['combat_knife', 'Combat Knife', 'Balanced, mean, no wasted motion.', 'R', 6500, 8500],
  ['semi_auto_sidearm', 'Semi-Auto Sidearm', 'Clean clicks, cleaner results.', 'R', 7000, 9000],
  ['throbbing_mace', 'Throbbing Mace', 'Enchanted. Vibrates on crit. Everyone hears it.', 'R', 7500, 9500],
  ['railcarbine', 'Railcarbine', 'Magnetic acceleration, zero subtlety, maximum “back up.”', 'SR', 9500, 12000],
];

const DEFENSE: Row[] = [
  ['scrap_plate', 'Scrap Plate', 'Bolted together hope.', 'N', 3000, 5000],
  ['riot_shield_cracked', 'Riot Shield (Cracked)', 'Still better than nothing.', 'N', 3500, 5500],
  ['padded_jacket', 'Padded Jacket', 'Fashion first, protection second.', 'N', 3500, 5500],
  ['body_pillow_barrier', 'Body Pillow Barrier', 'Surprisingly effective. Emotionally devastating.', 'N', 4000, 6000],
  ['ballistic_vest_expired', 'Ballistic Vest (Expired)', 'The tag says “do not use after…”', 'N', 4000, 6000],
  ['energy_buckler', 'Energy Buckler', 'Small hard-light disc. Flickers when low.', 'N', 4500, 6500],
  ['kevlar_carrier', 'Kevlar Carrier', 'Proper plates, proper weight.', 'R', 5500, 7500],
  ['tower_shield', 'Tower Shield', 'Heavy, honest, takes the hit for you.', 'R', 6000, 8000],
  ['latex_aegis', 'Latex Aegis', 'Stretches. Seals. Judges you.', 'R', 6500, 8500],
  ['phase_cloak', 'Phase Cloak', 'Not invisible. Just “harder to commit to hitting.”', 'SR', 8500, 11000],
];

// Health keeps its own ×0.20 (2000bp) step convention; the ranges overlap
// across rarities on purpose (strong N meets weak R, strong R meets weak SR).
const HEALTH: Row[] = [
  ['dented_lunchbox', 'Dented Lunchbox', 'Keeps something alive.', 'N', 18000, 26000],
  ['do_not_pet_patch', '"Do Not Pet" Patch', 'Iron-on warning. Nobody listens. Especially not you.', 'N', 19000, 27000],
  ['exs_hoodie_string', "Ex's Hoodie String", 'Tied around your wrist. Still smells of bad decisions.', 'N', 20000, 28000],
  ['emotional_support_rock', 'Emotional Support Rock', 'Smooth. Heavy. Judgemental. Fits in a pocket.', 'N', 21000, 29000],
  ['lucky_charm_cord', 'Lucky Charm Cord', 'A frayed string of mismatched beads. You swear it helps. It might.', 'N', 22000, 30000],
  ['screaming_keychain', 'Screaming Keychain', 'Tiny plastic figure that yells when you press it. You press it a lot.', 'N', 23000, 31000],
  ['bloodied_bandana', 'Bloodied Bandana', 'Tied around your arm or neck. Looks cooler than it performs.', 'R', 28000, 34000],
  ['pocket_saint', 'Pocket Saint', 'Tiny cracked figurine. Offers comfort and questionable advice.', 'R', 30000, 36000],
  ['emergency_condom_tin', 'Emergency Condom Tin', 'Still sealed. Used more as a good-luck charm than anything else.', 'R', 32000, 38000],
  ['glitch_earring', 'Glitch Earring', 'Flickers when danger is close. Or when the Wi-Fi is bad.', 'SR', 38000, 46000],
];

const AUTHORED = [
  ...ATTACK.map((row) => ['attack', ...row, 500] as const),
  ...DEFENSE.map((row) => ['defense', ...row, 500] as const),
  ...HEALTH.map((row) => ['health', ...row, 2000] as const),
];

describe('base Attack/Defense/Health catalogue', () => {
  it('ships all 30 definitions, with unique keys', () => {
    const keys = catalogue.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(catalogue.filter((d) => d.slot === 'attack').map((d) => d.key)).toEqual(ATTACK.map((r) => r[0]));
    expect(catalogue.filter((d) => d.slot === 'defense').map((d) => d.key)).toEqual(DEFENSE.map((r) => r[0]));
    expect(catalogue.filter((d) => d.slot === 'health').map((d) => d.key)).toEqual(HEALTH.map((r) => r[0]));
  });

  it('Health ships a full N/R/SR progression (6/3/1)', () => {
    const byRarity = (rarity: string) => catalogue.filter((d) => d.slot === 'health' && d.rarity === rarity);
    expect(byRarity('N')).toHaveLength(6);
    expect(byRarity('R')).toHaveLength(3);
    expect(byRarity('SR')).toHaveLength(1);
  });

  // Rewards and Workshop fabrication both draw from `eligibleRewardDefinitions`,
  // so a non-empty shipped pool per rarity is exactly what makes every Health
  // tier obtainable and fabricable — no slot-specific wiring.
  it.each([
    ['N', ['dented_lunchbox', 'do_not_pet_patch', 'emotional_support_rock', 'exs_hoodie_string', 'lucky_charm_cord', 'screaming_keychain']],
    ['R', ['bloodied_bandana', 'emergency_condom_tin', 'pocket_saint']],
    ['SR', ['glitch_earring']],
  ] as const)('the shared %s Health pool is obtainable', (rarity, expected) => {
    const pool = eligibleRewardDefinitions({ slot: 'health', rarity }, catalogue);
    expect(pool.map((d) => d.key)).toEqual(expected);
  });

  it.each(AUTHORED)('%s %s is exactly as authored', (slot, key, name, description, rarity, min, max, step) => {
    const def = catalogue.find((d) => d.key === key)!;
    expect(def).toBeDefined();
    expect(def).toMatchObject({
      name,
      description,
      slot,
      rarity,
      multiplierMinBp: min,
      multiplierMaxBp: max,
      multiplierStepBp: step,
      enabled: true,
      artworkPath: null,
    });
    expect(multiplierRangeIssues(def.slot, def)).toEqual([]);
    expect((max - min) % step).toBe(0);
    expect(() => parseEquipmentDefinition(def)).not.toThrow();
  });

  it('every definition derives a populated affix pool from slot + rarity', () => {
    const shipped = buildAffixCatalogue(affixes);
    for (const def of catalogue) {
      const pool = affixPoolOf(def);
      expect(isEquipmentAffixPool(pool), def.key).toBe(true);
      expect(shipped.rollable(pool).length, pool).toBeGreaterThan(0);
    }
  });

  it('higher rarities keep higher ceilings within each slot', () => {
    for (const slot of ['attack', 'defense', 'health'] as const) {
      const ceiling = (rarity: string) =>
        Math.max(...catalogue.filter((d) => d.slot === slot && d.rarity === rarity).map((d) => d.multiplierMaxBp));
      expect(ceiling('R'), slot).toBeGreaterThan(ceiling('N'));
      expect(ceiling('SR'), slot).toBeGreaterThan(ceiling('R'));
    }
  });

  it('only the onboarding starters are tagged as starters', () => {
    const starters = catalogue.filter((d) => d.tags.includes('starter')).map((d) => d.key);
    expect(starters.sort()).toEqual(Object.values(STARTER_EQUIPMENT).sort());
  });
});

describe('starters stay compatible', () => {
  it('Rusty Pipe and Scrap Plate still contain the onboarding fixed rolls', () => {
    expect(STARTER_EQUIPMENT).toMatchObject({ attack: 'rusty_pipe', defense: 'scrap_plate', health: 'dented_lunchbox' });
    for (const slot of ['attack', 'defense', 'health'] as const) {
      const def = catalogue.find((d) => d.key === STARTER_EQUIPMENT[slot])!;
      expect(isMultiplierInRange(def, STARTER_ROLLS[slot].rolledMultiplierBp), def.key).toBe(true);
      expect(STARTER_ROLLS[slot].affixKey).toBeNull();
    }
  });

  it('Dented Lunchbox is unchanged', () => {
    expect(catalogue.find((d) => d.key === 'dented_lunchbox')).toMatchObject({
      name: 'Dented Lunchbox',
      slot: 'health',
      rarity: 'N',
      multiplierMinBp: 18000,
      multiplierMaxBp: 26000,
      multiplierStepBp: 2000,
      tags: ['starter', 'onboarding'],
    });
    expect(STARTER_ROLLS.health.rolledMultiplierBp).toBe(20000);
    expect(catalogue.filter((d) => d.slot === 'health' && d.key === 'dented_lunchbox')).toHaveLength(1);
  });
});

describe('generated names fit Discord', () => {
  it('the longest name + suffix of each pool fits a select label without truncation', () => {
    const shipped = buildAffixCatalogue(affixes);
    for (const def of catalogue) {
      const suffixes = shipped.rollable(affixPoolOf(def));
      const longest = suffixes.reduce((a, b) => (b.suffix.length > a.suffix.length ? b : a));
      const name = equipmentDisplayName(def.name, longest.key, shipped);
      // Gear Bag select label: `${displayName} ×${count}`, limit 100.
      expect(`${name} ×999`.length, name).toBeLessThanOrEqual(100);
    }
  });
});
