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
}

/**
 * chance = clamp(base_capture_rate × charm_modifier + buddy_affinity, min, max)
 *
 * `base_capture_rate` uses the species override when set, otherwise the rarity
 * default. Guaranteed items (Mythic Contract) bypass the formula entirely.
 * Player / event modifiers remain reserved for later milestones.
 */
export function computeCaptureChance(input: CaptureChanceInput): number {
  if (input.guaranteed) return 1;
  const base = input.baseCaptureRate ?? input.config.baseRatesByRarity[input.rarity];
  const modifier = input.captureModifier ?? 1;
  const raw = base * modifier + (input.buddyAffinityModifier ?? 0);
  return clamp(raw, input.config.minChance, input.config.maxChance);
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
