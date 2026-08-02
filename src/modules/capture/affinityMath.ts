/**
 * Buddy Affinity math (Milestone 5D). Pure — no DB, no Discord, no clock.
 *
 * An active buddy whose affinity beats the encounter's affinity contributes a
 * flat, rarity-scaled bonus to the capture chance. The bonus is keyed on the
 * *buddy's* rarity (investing a rare copy as your buddy is the point), never
 * the encounter's.
 *
 * The wheel ships as:
 *   dominant → submissive → caregiver → primal → dominant
 * `switch` is neutral on both sides: it beats nothing and loses to nothing, so
 * any pairing involving it resolves to `neutral` with a 0 modifier. Unknown /
 * missing affinities normalize to `switch`, which keeps old content and any
 * future style additions from silently changing capture odds.
 */
import { AFFINITIES, DEFAULT_AFFINITY, type Affinity, type Rarity } from '../../db/schema';
import type { BuddyAffinityConfig } from '../content/schemas';
import { clamp } from './captureMath';

export type AffinityMatchup = 'strong' | 'neutral' | 'weak';

export interface BuddyAffinityResolution {
  buddyAffinity: Affinity;
  encounterAffinity: Affinity;
  matchup: AffinityMatchup;
  /** Additive delta applied to the capture chance (0 when there's no buddy). */
  modifier: number;
}

const AFFINITY_SET = new Set<string>(AFFINITIES);

export function isAffinity(value: unknown): value is Affinity {
  return typeof value === 'string' && AFFINITY_SET.has(value);
}

/** Anything unrecognized (old rows, hand-edited content) reads as neutral. */
export function normalizeAffinity(value: unknown): Affinity {
  return isAffinity(value) ? value : DEFAULT_AFFINITY;
}

/** "dominant" → "Dominant" — used in both the affinity read and card fields. */
export function affinityLabel(value: unknown): string {
  const a = normalizeAffinity(value);
  return a.charAt(0).toUpperCase() + a.slice(1);
}

function isNeutralStyle(affinity: Affinity, config: BuddyAffinityConfig): boolean {
  return config.neutralStyles.includes(affinity);
}

/**
 * Resolves the wheel. Neutral styles short-circuit *before* the wheel lookup,
 * so a mis-configured wheel edge involving `switch` still can't create a
 * strength or a weakness.
 */
export function getAffinityMatchup(
  buddyAffinity: unknown,
  encounterAffinity: unknown,
  config: BuddyAffinityConfig,
): AffinityMatchup {
  const buddy = normalizeAffinity(buddyAffinity);
  const encounter = normalizeAffinity(encounterAffinity);
  if (isNeutralStyle(buddy, config) || isNeutralStyle(encounter, config)) return 'neutral';
  if (config.wheel[buddy] === encounter) return 'strong';
  if (config.wheel[encounter] === buddy) return 'weak';
  return 'neutral';
}

/**
 * Bonus/penalty for a resolved matchup, scaled by the **buddy's** rarity.
 * Weak matchups read from `weakPenaltyByRarity`, which ships as all-zero — so
 * an unfavorable matchup costs nothing today but stays tunable.
 */
export function getBuddyAffinityModifier(
  buddyRarity: Rarity,
  matchup: AffinityMatchup,
  config: BuddyAffinityConfig,
): number {
  if (matchup === 'strong') {
    return config.strongBonusByRarity[buddyRarity] ?? 0;
  }
  if (matchup === 'weak') {
    const penalty = config.weakPenaltyByRarity[buddyRarity] ?? 0;
    // Guard the -0 that `-penalty` would produce when the penalty is 0.
    return penalty === 0 ? 0 : -penalty;
  }
  return 0;
}

/** One-shot matchup + modifier for a buddy of a given rarity and affinity. */
export function resolveBuddyAffinity(
  input: {
    buddyAffinity: unknown;
    buddyRarity: Rarity;
    encounterAffinity: unknown;
  },
  config: BuddyAffinityConfig,
): BuddyAffinityResolution {
  const buddyAffinity = normalizeAffinity(input.buddyAffinity);
  const encounterAffinity = normalizeAffinity(input.encounterAffinity);
  const matchup = getAffinityMatchup(buddyAffinity, encounterAffinity, config);
  return {
    buddyAffinity,
    encounterAffinity,
    matchup,
    modifier: getBuddyAffinityModifier(input.buddyRarity, matchup, config),
  };
}

/**
 * `clamp(chanceBeforeClamp + modifier, min, max)` — the buddy bonus is flat
 * and additive, applied *after* the charm multiplier, and the existing clamp
 * still has the final say.
 */
export function applyBuddyAffinityToCaptureChance(
  chanceBeforeClamp: number,
  modifier: number,
  bounds: { minChance: number; maxChance: number },
): number {
  return clamp(chanceBeforeClamp + modifier, bounds.minChance, bounds.maxChance);
}

/** "+4%", "+1.5%", "+0%" — trims trailing zeros so copy stays tight. */
export function formatAffinityBonus(modifier: number): string {
  const pct = modifier * 100;
  const rounded = Math.round(pct * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${rounded >= 0 ? '+' : ''}${text}%`;
}

/**
 * Player-facing one-liner for the encounter reveal and capture result.
 * Switch is called out explicitly on whichever side caused the neutrality so
 * players learn the rule instead of just seeing "+0%".
 */
export function formatAffinityRead(resolution: BuddyAffinityResolution): string {
  const { buddyAffinity, encounterAffinity, matchup, modifier } = resolution;
  const buddy = affinityLabel(buddyAffinity);
  const encounter = affinityLabel(encounterAffinity);

  if (matchup === 'strong') {
    return `Affinity Read: ${buddy} beats ${encounter}. Buddy bonus: ${formatAffinityBonus(modifier)}.`;
  }
  if (matchup === 'weak') {
    return 'Affinity Read: This matchup is unfavorable. No buddy bonus.';
  }
  if (buddyAffinity === DEFAULT_AFFINITY) {
    return `Affinity Read: Your buddy is ${affinityLabel(DEFAULT_AFFINITY)}, so this matchup stays neutral.`;
  }
  if (encounterAffinity === DEFAULT_AFFINITY) {
    return `Affinity Read: This Waifumon is ${affinityLabel(DEFAULT_AFFINITY)}, making the matchup neutral.`;
  }
  return `Affinity Read: No clear advantage. Buddy bonus: ${formatAffinityBonus(modifier)}.`;
}
