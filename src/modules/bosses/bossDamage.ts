/**
 * Boss battle damage — the pure formula, with no DB, no Discord and no clock
 * beyond the two instants a caller hands it.
 *
 *   battleDamage = round(
 *     currentSp × attacksPerParticipation × performanceModifier
 *     × (1 + affinityBonus + responseBonus)
 *   )
 *
 * Every consumer routes through {@link computeBattleDamage} — the ephemeral
 * preview's estimated range, the resolution that actually pays out, and the
 * tests that pin the boundaries — so a number a player was shown and a number
 * they were paid can never come from two different expressions.
 *
 * **Why the arithmetic is written as one integer division.** The naive form
 * multiplies four floats and rounds, and `0.85`, `1.15`, `0.05` and `0.02` are
 * none of them representable in binary floating point. The errors are small
 * but they land exactly where rounding decides between two integers, which is
 * the one place a player can see them. Instead:
 *
 *   damage = round( currentSp × attacks × perfPercent × (10000 + bonusBp)
 *                   / (100 × 10000) )
 *
 * The numerator is an exact integer (SP, attacks, an integer 85–115, and the
 * bonuses expressed in basis points), so the only rounding that happens is the
 * one the specification asks for. `Math.round` is half-up, and a true half is
 * reachable here, so that choice is load-bearing rather than incidental.
 *
 * The numerator's ceiling is far below `Number.MAX_SAFE_INTEGER`: even an
 * absurd 5,000 SP copy yields 5000 × 10 × 115 × 11500 ≈ 6.6 × 10^10.
 *
 * The ten attacks are a **presentation and scaling convention**. Nothing here
 * simulates ten anything: there is one modifier, one multiply, one result.
 */

/**
 * Version of the damage formula, stored on every participation.
 *
 * Bumped when the *shape* changes — a new term, different rounding, per-hit
 * simulation replacing the single roll — never when a tuning number moves.
 * A future Stage 2 that introduces boss HP does not bump it: subtracting
 * stored damage from a pool is a consumer of this number, not a change to it.
 */
export const BOSS_DAMAGE_FORMULA_VERSION = 1;

/** Shipped attack count per committed buddy. */
export const DEFAULT_ATTACKS_PER_PARTICIPATION = 10;

/** Shipped inclusive bounds of the performance modifier, in hundredths. */
export const DEFAULT_PERFORMANCE_MIN_PERCENT = 85;
export const DEFAULT_PERFORMANCE_MAX_PERCENT = 115;

/** Basis points per whole unit — 10000 bp = ×1. */
const BASIS_POINTS = 10_000;
/** Hundredths per whole unit — the performance modifier's scale. */
const PERCENT = 100;

export interface BattleDamageInput {
  /** Snapshotted **Current** SP. Never Base SP — a level-24 copy hits for her level. */
  currentSp: number;
  attacks: number;
  /** Integer 85–115, interpreted as hundredths. */
  performancePercent: number;
  /** 0.10 or 0. */
  affinityBonus: number;
  /** 0.05, 0.02 or 0. */
  responseBonus: number;
}

/**
 * Convert a fractional bonus to basis points.
 *
 * Rounded rather than truncated so a content value authored as `0.1` — which
 * is `0.1000000000000000055…` in binary — lands on 1000 bp instead of 999.
 */
function toBasisPoints(fraction: number): number {
  return Math.round(fraction * BASIS_POINTS);
}

/**
 * The authoritative damage number.
 *
 * Percentage bonuses are **additive with one another** before application:
 * +10% affinity and +5% response is ×1.15, not ×1.10 × ×1.05.
 */
export function computeBattleDamage(input: BattleDamageInput): number {
  const { currentSp, attacks, performancePercent, affinityBonus, responseBonus } = input;
  if (!Number.isInteger(currentSp) || currentSp < 0) {
    throw new RangeError(`currentSp must be a non-negative integer, got ${currentSp}`);
  }
  if (!Number.isInteger(attacks) || attacks < 0) {
    throw new RangeError(`attacks must be a non-negative integer, got ${attacks}`);
  }
  if (!Number.isInteger(performancePercent) || performancePercent < 0) {
    throw new RangeError(
      `performancePercent must be a non-negative integer, got ${performancePercent}`,
    );
  }
  const bonusBp = BASIS_POINTS + toBasisPoints(affinityBonus) + toBasisPoints(responseBonus);
  const numerator = currentSp * attacks * performancePercent * bonusBp;
  return Math.round(numerator / (PERCENT * BASIS_POINTS));
}

/** Inclusive damage bounds across the whole performance range. */
export interface DamageRange {
  min: number;
  max: number;
}

/**
 * What the ephemeral preview shows before a player commits.
 *
 * Both endpoints go through {@link computeBattleDamage}, so the range a player
 * is quoted is exactly the closed interval their result can land in — never a
 * separately-derived approximation that the real roll could step outside.
 */
export function estimateDamageRange(
  input: Omit<BattleDamageInput, 'performancePercent'>,
  bounds: { minPercent: number; maxPercent: number } = {
    minPercent: DEFAULT_PERFORMANCE_MIN_PERCENT,
    maxPercent: DEFAULT_PERFORMANCE_MAX_PERCENT,
  },
): DamageRange {
  return {
    min: computeBattleDamage({ ...input, performancePercent: bounds.minPercent }),
    max: computeBattleDamage({ ...input, performancePercent: bounds.maxPercent }),
  };
}

// ── Rapid-response bracket ──────────────────────────────────────────────────

/**
 * One rapid-response tier: commit strictly inside `withinMinutes` of the
 * scouting start and earn `bonus`.
 *
 * The comparison is **strict**, which settles the boundary the shipped table
 * leaves ambiguous ("First 10 minutes" / "10–20 minutes"): a commitment at
 * exactly 10:00.000 falls into the *second* tier, not the first. Brackets are
 * evaluated in order, so they must be authored ascending.
 */
export interface ResponseBracket {
  withinMinutes: number;
  bonus: number;
}

/**
 * Shipped brackets, sized to the 30-minute scouting window: +5% inside the
 * first 10 minutes, +2% inside 20, nothing in the final 10.
 *
 * Kept proportional to the window rather than absolute — a third of it at the
 * top rate, a third reduced, a third flat — so the incentive to show up early
 * reads the same whatever `scoutingMinutes` is set to. Content overrides these
 * via `bossEncounters.responseBrackets`; the schema refuses a bracket that
 * reaches past the window.
 */
export const DEFAULT_RESPONSE_BRACKETS: readonly ResponseBracket[] = Object.freeze([
  Object.freeze({ withinMinutes: 10, bonus: 0.05 }),
  Object.freeze({ withinMinutes: 20, bonus: 0.02 }),
]) as readonly ResponseBracket[];

const MS_PER_MINUTE = 60_000;

/**
 * The response bonus for a commitment, from the elapsed wall time between the
 * scouting start and the confirmed commitment.
 *
 * Computed in milliseconds rather than in whole minutes so the boundary is the
 * real instant rather than a floor: 9:59.999 earns +5%, 10:00.000 earns +2%,
 * 19:59.999 earns +2%, and 20:00.000 onward earns nothing.
 *
 * A commitment timestamped *before* the scouting start (clock skew between
 * processes, a hand-written admin fixture) reads as elapsed zero rather than
 * negative — the best bracket, which is the harmless direction for a player.
 */
export function responseBonusFor(
  scoutingStartedAt: Date,
  committedAt: Date,
  brackets: readonly ResponseBracket[] = DEFAULT_RESPONSE_BRACKETS,
): number {
  const elapsedMs = Math.max(0, committedAt.getTime() - scoutingStartedAt.getTime());
  for (const bracket of brackets) {
    if (elapsedMs < bracket.withinMinutes * MS_PER_MINUTE) return bracket.bonus;
  }
  return 0;
}

/** "+10%", "+2%", "+0%" — trims trailing zeros so preview copy stays tight. */
export function formatBonusPercent(fraction: number): string {
  const pct = Math.round(fraction * 1000) / 10;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${pct >= 0 ? '+' : ''}${text}%`;
}

/** "17342" → "17,342". Damage numbers are large enough to need grouping. */
export function formatDamage(value: number): string {
  return value.toLocaleString('en-US');
}
