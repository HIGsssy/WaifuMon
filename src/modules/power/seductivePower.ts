/**
 * Seductive Power (SP) — the pure domain module.
 *
 * No DB, no Discord, no content loader: every consumer (capture, the API, the
 * inspect embed, the trainer profile, and whatever consumes SP later) calls
 * these functions rather than re-deriving the arithmetic, which is what keeps
 * a displayed number and an authoritative one from ever disagreeing.
 *
 * Four concepts, only two of which exist today:
 *
 *   - **Species rarity** decides the permitted Level 1 range. Tuning, so it
 *     lives in `content/tables.json` and arrives here as a parameter.
 *   - **Base SP** is the integer rolled once, at capture, for one owned copy.
 *     Persisted on `player_waifus.base_sp` and never recomputed — not on read,
 *     not on restart, not on level-up, not on a content reload.
 *   - **Current SP** is derived from Base SP and the copy's current level by
 *     {@link currentSeductivePower}. Deliberately *not* persisted: it is a pure
 *     function of two stored values, so storing it would only create a third
 *     value that can drift from them.
 *   - **Effective SP** — reserved for equipment, items, affection, affinity and
 *     encounter modifiers. Not implemented. When it arrives it is a function
 *     *of* Current SP and changes nothing about the persisted model.
 */
import type { Rarity } from '../../db/schema';

/**
 * Version of the Current SP formula.
 *
 * Bumped when the *shape* of the calculation changes (the scalar becoming
 * non-linear, rounding changing, a new term entering the base derivation) —
 * not when a tuning number moves. Carried on the API resource so a client can
 * tell a re-tune from a re-model, and so a future migration that re-derives
 * historical values has something to key on.
 */
export const SP_FORMULA_VERSION = 1;

/**
 * Per-level growth of Current SP, as a fraction of Base SP.
 *
 * Additive against Level 1, not compounding: a Level 50 copy is worth
 * `1 + 0.025 × 49 = 2.225×` her Base SP, so the whole ladder is a straight
 * line from her roll. Lives here rather than in content because it is the
 * formula, and changing it is a formula-version bump rather than a re-tune.
 *
 * Exported as the documented *rate*. The implementation does not multiply by
 * it — see {@link SP_LEVEL_SCALAR_DENOMINATOR}.
 */
export const SP_LEVEL_SCALAR = 0.025;

/**
 * `1 / SP_LEVEL_SCALAR`, and the reason {@link currentSeductivePower} is
 * written as a division rather than the literal formula.
 *
 * `0.025` is not representable in binary floating point, and the error is not
 * academic: `100 * (1 + 0.025 * 1)` evaluates to `102.49999999999999`, which
 * rounds to **102** when the true value 102.5 must round to 103. Computing
 * `base * (40 + (level - 1)) / 40` keeps the numerator an exact integer and
 * lands on the true half, so exact halves round up the way the specification's
 * boundary table requires rather than the way the float happens to fall.
 *
 * Every value in that table is identical under both forms — this only fixes
 * the intermediate levels where the naive form silently floored a half.
 */
export const SP_LEVEL_SCALAR_DENOMINATOR = 40;

/** Inclusive Level 1 Base SP bounds for one rarity. */
export interface SeductivePowerRange {
  min: number;
  max: number;
}

export type SeductivePowerRanges = Readonly<Record<Rarity, SeductivePowerRange>>;

/**
 * The shipped Level 1 ranges.
 *
 * This is the **single authoritative table**. `content/tables.json` carries the
 * same numbers so an operator can re-tune without a deploy, and its schema
 * defaults to exactly this object — so a `tables.json` that omits the block
 * still gets the shipped ladder rather than nothing.
 *
 * EX has no species in the current roster and is still a first-class entry:
 * the first EX Waifumon to ship must roll like everyone else, not crash.
 */
export const DEFAULT_SP_RANGES_BY_RARITY: SeductivePowerRanges = Object.freeze({
  N: Object.freeze({ min: 90, max: 100 }),
  R: Object.freeze({ min: 105, max: 115 }),
  SR: Object.freeze({ min: 120, max: 130 }),
  SSR: Object.freeze({ min: 135, max: 145 }),
  UR: Object.freeze({ min: 150, max: 160 }),
  LR: Object.freeze({ min: 165, max: 175 }),
  EX: Object.freeze({ min: 180, max: 190 }),
}) as SeductivePowerRanges;

/**
 * Salt for the historical backfill's deterministic roll.
 *
 * Versioned and frozen: re-running the backfill must reproduce the values it
 * produced the first time, so this string may never change. A future
 * re-derivation would introduce `v2` alongside it rather than editing it.
 */
export const SP_BACKFILL_SALT = 'waifumon.sp.backfill.v1';

/** Thrown when SP is asked for against a rarity the ladder does not define. */
export class UnknownRarityError extends Error {
  readonly rarity: string;

  constructor(rarity: string) {
    super(`No Seductive Power range configured for rarity "${rarity}"`);
    this.name = 'UnknownRarityError';
    this.rarity = rarity;
  }
}

/** Thrown for a level outside `[1, maxLevel]`, or a non-integer one. */
export class InvalidLevelError extends Error {
  readonly level: number;

  constructor(level: number) {
    super(`Seductive Power requires an integer level >= 1, got ${level}`);
    this.name = 'InvalidLevelError';
    this.level = level;
  }
}

/**
 * The range for one rarity. Throws rather than substituting a neighbour: a
 * missing entry means content and code disagree about what rarities exist, and
 * silently rolling an N-tier value for an unknown rarity would bake that
 * disagreement into permanent data.
 */
export function rangeForRarity(
  rarity: string,
  ranges: SeductivePowerRanges = DEFAULT_SP_RANGES_BY_RARITY,
): SeductivePowerRange {
  const range = (ranges as Record<string, SeductivePowerRange | undefined>)[rarity];
  if (!range) throw new UnknownRarityError(rarity);
  return range;
}

/** True when `value` is a legal Base SP for `rarity`. */
export function isValidBaseSeductivePower(
  value: number,
  rarity: string,
  ranges: SeductivePowerRanges = DEFAULT_SP_RANGES_BY_RARITY,
): boolean {
  if (!Number.isInteger(value)) return false;
  const range = rangeForRarity(rarity, ranges);
  return value >= range.min && value <= range.max;
}

/**
 * Roll one Base SP: a uniform integer over the rarity's **inclusive** range.
 *
 * Uses the repository's `Rng.intInclusive`, which is the same injectable
 * source the hunt, capture and gift rolls already use — so a test drives SP
 * exactly the way it drives every other roll, and nothing here depends on
 * uncontrolled randomness.
 */
export function rollBaseSeductivePower(
  rarity: string,
  rng: { intInclusive(min: number, max: number): number },
  ranges: SeductivePowerRanges = DEFAULT_SP_RANGES_BY_RARITY,
): number {
  const { min, max } = rangeForRarity(rarity, ranges);
  return rng.intInclusive(min, max);
}

/**
 * Current SP = round(Base SP × (1 + 0.025 × (Level − 1))).
 *
 * Evaluated as `round(base × (40 + level − 1) / 40)`, which is the same
 * quantity computed without the binary-float error in `0.025` — see
 * {@link SP_LEVEL_SCALAR_DENOMINATOR}.
 *
 * `Math.round` is half-**up**, and that is load-bearing rather than incidental:
 * Base 100 at Level 50 is exactly 222.5 and Base 180 at Level 50 is exactly
 * 400.5, both of which must land on 223 and 401. Every consumer routes through
 * this one function so a renderer cannot floor what an API rounded.
 *
 * Level 1 returns Base SP exactly — `1 + 0.025 × 0` is exactly 1, so this is a
 * true identity and not a rounding coincidence.
 *
 * @throws {InvalidLevelError} for a non-integer level, a level below 1, or one
 * above `maxLevel` when the caller supplies the ceiling. Callers that hold the
 * content config should pass it; the domain has no opinion about where the cap
 * sits, only that a level outside it is a bug rather than something to clamp.
 */
export function currentSeductivePower(
  baseSp: number,
  level: number,
  maxLevel?: number,
): number {
  if (!Number.isInteger(baseSp) || baseSp < 1) {
    throw new RangeError(`Base Seductive Power must be a positive integer, got ${baseSp}`);
  }
  if (!Number.isInteger(level) || level < 1) throw new InvalidLevelError(level);
  if (maxLevel !== undefined && level > maxLevel) throw new InvalidLevelError(level);
  return Math.round(
    (baseSp * (SP_LEVEL_SCALAR_DENOMINATOR + (level - 1))) / SP_LEVEL_SCALAR_DENOMINATOR,
  );
}

/**
 * Both SP values for one owned copy, as every presentation surface wants them.
 *
 * `current` is the player-facing number; `base` rides along for detailed views
 * and API consumers. Bundled so a caller cannot render one and forget the
 * other, and so adding `effective` later is a field here rather than a new
 * shape at four call sites.
 */
export interface SeductivePowerView {
  base: number;
  current: number;
  formulaVersion: number;
}

export function seductivePowerView(
  baseSp: number,
  level: number,
  maxLevel?: number,
): SeductivePowerView {
  return {
    base: baseSp,
    current: currentSeductivePower(baseSp, level, maxLevel),
    formulaVersion: SP_FORMULA_VERSION,
  };
}

/** The canonical player-facing line. One wording, every surface. */
export function formatSeductivePower(currentSp: number): string {
  return `Seductive Power: ${currentSp} SP`;
}
