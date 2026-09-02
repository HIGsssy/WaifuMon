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
  /**
   * Diagnostic-only: whether {@link buddyBonusPercent} comes from a *targeted*
   * (conditional) Buddy Bonus rather than an untargeted (global) one. It does
   * **not** change the math — a bonus contributes the same relative percentage
   * however it is scoped — only how {@link describeCaptureChance} attributes it
   * between `buddyGlobalModifier` and `buddyConditionalModifier`. Defaults to
   * false; both attributions are 0 when no bonus applies.
   */
  buddyBonusIsConditional?: boolean;
}

/**
 * Every term that went into a single capture-chance calculation, so a
 * production incident can be reconstructed field by field. Modifiers that did
 * not apply are logged with their mathematical identity — `1` for the
 * multiplicative `itemModifier`, `0` for the additive/percentage terms, and
 * `null` for `speciesCaptureModifier` (a species base-rate override *replaces*
 * the rarity default rather than scaling it, so it has no neutral number).
 */
export interface CaptureChanceBreakdown {
  guaranteed: boolean;
  rarity: Rarity;
  /** Resolved base probability actually used: species override or rarity default. */
  baseCaptureChance: number;
  /** The species-level base-rate override when set, else null (replaces, not scales). */
  speciesCaptureModifier: number | null;
  /** Committed item's charm multiplier. 1 with no direct item or no multiplier. */
  itemModifier: number;
  /** Player-side additive buff from an active consumable (Microdose). 0 when none. */
  playerCaptureModifier: number;
  /** Flat buddy-affinity matchup bonus, in probability points. 0 when none. */
  affinityModifier: number;
  /** Committed item's own flat additive bonus (restraints). 0 for charms/guaranteed. */
  itemCaptureBonus: number;
  /** Untargeted Buddy Bonus, as a relative percent (`10` = +10%). 0 when none. */
  buddyGlobalModifier: number;
  /** Targeted (conditional) Buddy Bonus, as a relative percent. 0 when none. */
  buddyConditionalModifier: number;
  /** Reserved for future flat additive terms (events, regions). 0 today. */
  otherModifiers: number;
  /** Assembled chance before the min/max clamp. */
  chanceBeforeClamp: number;
  /** Final clamped probability the roll is compared against. */
  finalChance: number;
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
 *
 * Returns the full {@link CaptureChanceBreakdown}; {@link computeCaptureChance}
 * is the thin wrapper that keeps only `finalChance`. Both share this one body,
 * so the number a player is shown and the number the server rolls against can
 * never drift apart from the number a log explains.
 */
export function describeCaptureChance(input: CaptureChanceInput): CaptureChanceBreakdown {
  const { rarity } = input;
  const baseCaptureChance = input.baseCaptureRate ?? input.config.baseRatesByRarity[rarity];
  const speciesCaptureModifier = input.baseCaptureRate ?? null;
  const itemModifier = input.captureModifier ?? 1;
  const playerCaptureModifier = input.captureBonusModifier ?? 0;
  const affinityModifier = input.buddyAffinityModifier ?? 0;
  const itemCaptureBonus = input.itemCaptureBonus ?? 0;
  const otherModifiers = 0;
  const buddyPercent = input.buddyBonusPercent ?? 0;
  const conditional = input.buddyBonusIsConditional ?? false;
  const buddyGlobalModifier = conditional ? 0 : buddyPercent;
  const buddyConditionalModifier = conditional ? buddyPercent : 0;

  const base: Omit<CaptureChanceBreakdown, 'chanceBeforeClamp' | 'finalChance'> = {
    guaranteed: input.guaranteed,
    rarity,
    baseCaptureChance,
    speciesCaptureModifier,
    itemModifier,
    playerCaptureModifier,
    affinityModifier,
    itemCaptureBonus,
    buddyGlobalModifier,
    buddyConditionalModifier,
    otherModifiers,
  };

  // Guaranteed items (Mythic Contract) bypass the formula: chance is exactly 1,
  // never clamped, and none of the modifiers above can raise or lower it.
  if (input.guaranteed) {
    return { ...base, chanceBeforeClamp: 1, finalChance: 1 };
  }

  const raw =
    baseCaptureChance * itemModifier +
    affinityModifier +
    playerCaptureModifier +
    itemCaptureBonus +
    otherModifiers;
  const chanceBeforeClamp = applyPercentModifier(raw, buddyPercent);
  const finalChance = clamp(chanceBeforeClamp, input.config.minChance, input.config.maxChance);
  return { ...base, chanceBeforeClamp, finalChance };
}

/** The final clamped capture probability. See {@link describeCaptureChance}. */
export function computeCaptureChance(input: CaptureChanceInput): number {
  return describeCaptureChance(input).finalChance;
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
