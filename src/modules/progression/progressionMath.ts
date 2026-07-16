/**
 * Pure progression math — no DB, no Discord. Called from the transactional
 * `ProgressionService.grantXp` and directly from render code.
 */
import type { Rarity } from '../../db/schema';
import type { ProgressionConfig } from '../content/schemas';

export interface LevelProgress {
  level: number;
  /** Total lifetime XP for the player. */
  totalXp: number;
  /** XP earned inside the current level (0-indexed against xpToNext). */
  xpIntoLevel: number;
  /** XP needed to reach the next level (0 if at max). */
  xpToNext: number;
  atMaxLevel: boolean;
}

/** XP required to go from `level` to `level + 1` (0 at max). */
export function xpToNext(level: number, config: ProgressionConfig): number {
  if (level >= config.maxLevel) return 0;
  return config.levelCurve.base + config.levelCurve.growth * (level - 1);
}

/**
 * Cumulative XP needed to reach `level`. Level 1 == 0.
 * Iterative sum (linear-ish curve keeps this trivial up to maxLevel = 50).
 */
export function cumulativeXpForLevel(level: number, config: ProgressionConfig): number {
  let total = 0;
  const bound = Math.min(level, config.maxLevel);
  for (let l = 1; l < bound; l++) total += xpToNext(l, config);
  return total;
}

/** Derive current level from total XP (capped at maxLevel). */
export function levelFromTotalXp(totalXp: number, config: ProgressionConfig): number {
  let level = 1;
  let consumed = 0;
  while (level < config.maxLevel) {
    const need = xpToNext(level, config);
    if (consumed + need > totalXp) break;
    consumed += need;
    level++;
  }
  return level;
}

export function levelProgress(totalXp: number, config: ProgressionConfig): LevelProgress {
  const level = levelFromTotalXp(totalXp, config);
  const cumul = cumulativeXpForLevel(level, config);
  const need = xpToNext(level, config);
  return {
    level,
    totalXp,
    xpIntoLevel: totalXp - cumul,
    xpToNext: need,
    atMaxLevel: level >= config.maxLevel,
  };
}

/** Sum of `baseMax` + every earned bonus, clamped by the cap. */
export function maxEnergyForLevel(
  level: number,
  baseMax: number,
  config: ProgressionConfig,
): number {
  let total = baseMax;
  for (const bonus of config.maxEnergy.levelBonuses) {
    if (level >= bonus.atLevel) total += bonus.delta;
  }
  return Math.min(config.maxEnergy.cap, total);
}

/** Rare-encounter shift for level 40+: returns a table adjustment or null. */
export function rareEncounterShift(
  level: number,
  config: ProgressionConfig,
): { fromRarity: Rarity; toRarity: Rarity; weightUnits: number } | null {
  const shift = config.rareEncounterShift;
  if (level < shift.atLevel || shift.weightUnits <= 0) return null;
  return {
    fromRarity: shift.fromRarity,
    toRarity: shift.toRarity,
    weightUnits: shift.weightUnits,
  };
}

/** Highest-level prestige title unlocked at `level`, or null. */
export function prestigeTitleForLevel(
  level: number,
  config: ProgressionConfig,
): string | null {
  const eligible = config.prestigeTitles.filter((t) => level >= t.atLevel);
  if (eligible.length === 0) return null;
  const best = eligible.reduce((max, t) => (t.atLevel > max.atLevel ? t : max));
  return best.label;
}

/** Extra daily items (item slug → total quantity) unlocked at `level`. */
export function dailyBonusItemsForLevel(
  level: number,
  config: ProgressionConfig,
): Array<{ slug: string; quantity: number }> {
  return config.dailyBonusItems
    .filter((b) => level >= b.atLevel)
    .map((b) => ({ slug: b.slug, quantity: b.quantity }));
}

/** Daily rare-item roll chance at `level` (0 if not unlocked). */
export function dailyRareItemChanceForLevel(
  level: number,
  config: ProgressionConfig,
): number {
  return level >= config.dailyRareItemChance.atLevel ? config.dailyRareItemChance.chance : 0;
}

/** Short reward strings for a single level threshold (for level-up toasts). */
export function describeLevelRewards(
  newLevel: number,
  config: ProgressionConfig,
): string[] {
  const messages: string[] = [];
  for (const bonus of config.maxEnergy.levelBonuses) {
    if (bonus.atLevel === newLevel && bonus.delta !== 0) {
      messages.push(`Max Hunt Energy +${bonus.delta}`);
    }
  }
  for (const bonus of config.dailyBonusItems) {
    if (bonus.atLevel === newLevel) {
      messages.push(`Daily now includes +${bonus.quantity} ${bonus.slug}`);
    }
  }
  if (config.dailyRareItemChance.atLevel === newLevel) {
    messages.push('Daily now has a rare-item chance');
  }
  if (config.rareEncounterShift.atLevel === newLevel) {
    messages.push('Rare encounter chance up~');
  }
  for (const title of config.prestigeTitles) {
    if (title.atLevel === newLevel) messages.push(`Title unlocked: ${title.label}`);
  }
  return messages;
}
