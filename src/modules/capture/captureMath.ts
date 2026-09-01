/**
 * Pure capture-chance math. No DB, no Discord — testable in isolation.
 */
import type { Rarity } from '../../db/schema';
import { applyPercentModifier } from '../buddyBonus/buddyBonusEffects';

export interface CaptureConfig {
  baseRatesByRarity: Record<Rarity, number>;
  minChance: number;
  maxChance: number;
  announceMinRarity: Rarity;
  hereMentionMinRarity: Rarity;
}

export interface CaptureChanceInput {
  guaranteed: boolean;
  baseCaptureRate: number | null;
  rarity: Rarity;
  captureModifier: number | null;
  config: CaptureConfig;
  /**
   * Milestone 5D buddy-affinity delta. Flat and additive, applied *after* the
   * charm multiplier and before the clamp. Defaults to 0 (no buddy, neutral
   * matchup, or a weak matchup under the current all-zero penalty tuning).
   */
  buddyAffinityModifier?: number;
  /**
   * Flat bonus from an active consumable buff (Microdose). Like the affinity
   * term it is additive and applied *after* the charm multiplier, so a charm
   * never multiplies the buff. Defaults to 0 (no active effect).
   */
  captureBonusModifier?: number;
  /**
   * Flat bonus contributed by the *committed capture item itself* (Fluffy
   * Cuffs, Shibari Rope). Additive in probability points and applied after the
   * charm multiplier, exactly like the other two additive terms — an item is
   * either multiplicative (a charm) or additive (a restraint), never both.
   * Defaults to 0.
   */
  itemCaptureBonus?: number;
  /**
   * Active Buddy Bonus contribution, as a **relative percentage** (`10` = +10%
   * of the chance, not +10 points). Unlike the three additive terms it scales
   * the whole assembled chance, which is what "increase capture chance by X%"
   * means, and it lands before the clamp so the clamp stays the single source
   * of truth for the achievable range. 0 with no Buddy, a Buddy whose bonus is
   * a different effect, or a targeted bonus that does not match this species.
   */
  buddyBonusPercent?: number;
}

/**
 * chance = clamp(
 *   (base_capture_rate × charm_modifier
 *      + buddy_affinity + capture_bonus + item_capture_bonus)
 *     × (1 + buddy_bonus_percent / 100),
 *   min, max)
 *
 * `base_capture_rate` uses the species override when set, otherwise the rarity
 * default. Guaranteed items (Mythic Contract) bypass the formula entirely.
 * Both additive terms land after the multiply and before the clamp, so the
 * clamp bounds remain the single source of truth for the achievable range.
 */
export function computeCaptureChance(input: CaptureChanceInput): number {
  if (input.guaranteed) return 1;
  const base = input.baseCaptureRate ?? input.config.baseRatesByRarity[input.rarity];
  const modifier = input.captureModifier ?? 1;
  const raw =
    base * modifier +
    (input.buddyAffinityModifier ?? 0) +
    (input.captureBonusModifier ?? 0) +
    (input.itemCaptureBonus ?? 0);
  const withBuddyBonus = applyPercentModifier(raw, input.buddyBonusPercent ?? 0);
  return clamp(withBuddyBonus, input.config.minChance, input.config.maxChance);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Total ordering on the rarity ladder (higher rank = rarer). */
export const RARITY_RANK: Record<Rarity, number> = {
  N: 0,
  R: 1,
  SR: 2,
  SSR: 3,
  UR: 4,
  LR: 5,
  EX: 6,
};

export function rarityAtLeast(candidate: Rarity, threshold: Rarity): boolean {
  return RARITY_RANK[candidate] >= RARITY_RANK[threshold];
}
