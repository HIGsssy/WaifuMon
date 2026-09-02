/**
 * Pure capture-chance math. No DB, no Discord — testable in isolation.
 */
import type { Rarity } from '../../db/schema';

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
}

export interface CaptureChanceBreakdown {
  guaranteed: boolean;
  rarity: Rarity;
  /** Rarity-table probability before species overrides. */
  rarityBaseCaptureRate: number;
  /** Species-authored override, or null when the rarity table is used. */
  speciesBaseCaptureRate: number | null;
  /** The base probability actually fed into the formula. */
  baseCaptureChance: number;
  /** There is no player-wide capture modifier today; logged as neutral. */
  playerCaptureModifier: 1;
  /** There is no global buddy capture modifier today; logged as neutral. */
  buddyGlobalModifier: 0;
  /** There is no conditional buddy capture modifier today; logged as neutral. */
  buddyConditionalModifier: 0;
  /** Current affinity system's flat additive probability-point modifier. */
  affinityModifier: number;
  /** Multiplicative direct item modifier (`captureModifier`; charms use this). */
  itemModifier: number;
  /** Additive direct item bonus (`captureBonus`; restraint items use this). */
  itemCaptureBonus: number;
  /** Additive active-effect bonus, currently Microdose. */
  captureBonusModifier: number;
  otherModifiers: {
    captureBonusModifier: number;
  };
  chanceBeforeClamp: number;
  finalChance: number;
}

/**
 * chance = clamp(
 *   base_capture_rate × charm_modifier
 *     + buddy_affinity + capture_bonus + item_capture_bonus,
 *   min, max)
 *
 * `base_capture_rate` uses the species override when set, otherwise the rarity
 * default. Guaranteed items (Mythic Contract) bypass the formula entirely.
 * Both additive terms land after the multiply and before the clamp, so the
 * clamp bounds remain the single source of truth for the achievable range.
 */
export function computeCaptureChance(input: CaptureChanceInput): number {
  return computeCaptureChanceBreakdown(input).finalChance;
}

export function computeCaptureChanceBreakdown(input: CaptureChanceInput): CaptureChanceBreakdown {
  const rarityBaseCaptureRate = input.config.baseRatesByRarity[input.rarity];
  const baseCaptureChance = input.baseCaptureRate ?? rarityBaseCaptureRate;
  const itemModifier = input.captureModifier ?? 1;
  const affinityModifier = input.buddyAffinityModifier ?? 0;
  const captureBonusModifier = input.captureBonusModifier ?? 0;
  const itemCaptureBonus = input.itemCaptureBonus ?? 0;
  const chanceBeforeClamp = input.guaranteed
    ? 1
    : baseCaptureChance * itemModifier + affinityModifier + captureBonusModifier + itemCaptureBonus;
  const finalChance = input.guaranteed
    ? 1
    : clamp(chanceBeforeClamp, input.config.minChance, input.config.maxChance);
  return {
    guaranteed: input.guaranteed,
    rarity: input.rarity,
    rarityBaseCaptureRate,
    speciesBaseCaptureRate: input.baseCaptureRate,
    baseCaptureChance,
    playerCaptureModifier: 1,
    buddyGlobalModifier: 0,
    buddyConditionalModifier: 0,
    affinityModifier,
    itemModifier,
    itemCaptureBonus,
    captureBonusModifier,
    otherModifiers: {
      captureBonusModifier,
    },
    chanceBeforeClamp,
    finalChance,
  };
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
