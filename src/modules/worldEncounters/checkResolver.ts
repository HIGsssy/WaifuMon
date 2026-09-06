/**
 * Check resolver — the one place SP-based encounter checks are computed.
 *
 * Centralised so every surface (Discord runtime, admin preview, tests) reads
 * the same formula. The buddy's species SP is never mutated: this reads
 * `currentSp` off the passed-in profile and returns a resolution the caller
 * either applies effects for or discards (preview / simulation).
 *
 * Two formulas live here, told apart by a single field on the check:
 *
 *   - **New model** (`baseChance` present): the author sets an explicit success
 *     floor and buddy SP moves it a *bounded* amount (`±maxSpModifier`), so a
 *     very high-SP buddy helps without turning every encounter automatic.
 *   - **Legacy model** (`difficulty` present, no `baseChance`): the original
 *     50 %-centred formula, preserved bit-for-bit so shipped content is
 *     untouched. New authoring uses the new model; nothing migrates silently.
 *
 * Future equipment will extend this by pushing extra terms into the breakdown
 * (attack, defense, evasion). Today's implementation deliberately touches
 * only fields already present in the domain — nothing here reads a table that
 * does not yet exist.
 */
import type { Rng } from '../../shared/random';
import type { BuddyProfile, CheckResolution, CheckSpec, EncounterCheckContext } from './types';

/* ─────────────────────── Legacy model constants ─────────────────────── */

/** Legacy base success chance before any modifiers. Deliberately dead-centre. */
const LEGACY_BASE_CHANCE = 0.5;

/** Legacy divisor turning (currentSp - difficulty) into a probability shift. */
const SP_DIVISOR = 200;

/** Legacy divisor turning buddy level (above 1) into a small linear boost. */
const LEVEL_DIVISOR = 100;

/** Legacy SP-term clamp. */
const LEGACY_SP_CLAMP = 0.4;

/** Legacy level-term ceiling. */
const LEGACY_LEVEL_CLAMP = 0.2;

/** Legacy penalty for facing an SP check with no buddy. */
const LEGACY_NO_BUDDY_SP_TERM = -0.3;

/* ─────────────────────── New model constants ─────────────────────── */

/**
 * Default cap on the SP contribution when a new-model check omits
 * `maxSpModifier`. ±0.15 (±15 points) — chosen from the SP audit so a typical
 * buddy moves the chance a meaningful-but-not-decisive amount.
 */
export const DEFAULT_MAX_SP_MODIFIER = 0.15;

/**
 * SP that maps to a **zero** SP modifier — the "average buddy" reference.
 *
 * Derived from the live SP model rather than guessed. Current SP =
 * `round(baseSp × (1 + 0.025 × (level − 1)))`, base rolls run 90 (N L1) to 190
 * (EX L1), and the cap is level 50 (×2.225). A solid mid-game buddy — an R at
 * L40, an SR at L25, an SSR at L20, or a maxed N — sits right around 200 SP, so
 * that is the point at which buddy strength neither helps nor hurts.
 */
export const SP_NEUTRAL_REFERENCE = 200;

/**
 * SP distance from {@link SP_NEUTRAL_REFERENCE} at which the modifier reaches
 * its full ±cap. 150 points, so the band runs 50 → 350: everything at or below
 * 50 SP bottoms out (below any real buddy, so the weakest real buddy ~90 lands
 * near the floor without pinning it), and a genuinely strong end-game buddy
 * (~350: SSR/UR/LR/EX at high level) tops out. Linear in between.
 */
export const SP_REFERENCE_SPREAD = 150;

/* ─────────────────────── Shared constants ─────────────────────── */

/** Additive advantage when buddy affinity matches choice's affinityAdvantage. */
const AFFINITY_ADVANTAGE = 0.15;

/** Additive advantage when any of buddy's race tags match choice's raceAdvantage. */
const RACE_ADVANTAGE = 0.1;

/** Hard clamps — the engine must never claim certainty in either direction. */
const MIN_CHANCE = 0.05;
const MAX_CHANCE = 0.95;

/** Clamp helper. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * The bounded SP contribution for the **new model**, in probability points.
 *
 * A pure function of the buddy's current SP and the check's cap, so the Portal
 * preview, the simulator and the Discord runtime all agree by construction.
 * With no buddy the check pays the full negative cap — an SP check with nothing
 * to measure is the weakest possible showing, not a neutral one.
 *
 *   modifier = maxSpModifier × clamp((currentSp − 200) / 150, −1, +1)
 */
export function spModifierNew(buddy: BuddyProfile | null, maxSpModifier: number): number {
  if (!buddy) return -maxSpModifier;
  const normalized = clamp(
    (buddy.currentSp - SP_NEUTRAL_REFERENCE) / SP_REFERENCE_SPREAD,
    -1,
    1,
  );
  return maxSpModifier * normalized;
}

/**
 * Resolve a check *without* rolling — used by the admin preview and by
 * simulate endpoints. `roll` is null in the result.
 */
export function computeChance(check: CheckSpec, ctx: EncounterCheckContext): CheckResolution {
  if (check.type === 'none') {
    return {
      chance: 1,
      roll: 0,
      success: true,
      breakdown: {
        base: 1,
        spTerm: 0,
        levelTerm: 0,
        affinityMod: 0,
        raceMod: 0,
        buddyBonusMod: 0,
        baseBias: 0,
      },
    };
  }

  const buddy = ctx.buddy;
  const affinityMod =
    buddy && check.affinityAdvantage && buddy.affinity === check.affinityAdvantage
      ? AFFINITY_ADVANTAGE
      : 0;
  const raceMod =
    buddy &&
    check.raceAdvantage &&
    check.raceAdvantage.some((tag) => buddy.raceTags.includes(tag))
      ? RACE_ADVANTAGE
      : 0;
  const buddyBonusMod = ctx.buddyBonusPercent / 100;

  // NEW MODEL — presence of `baseChance` selects it. Author sets the floor;
  // buddy SP moves it a bounded amount; level is *not* a separate term because
  // it is already folded into `currentSp`, so counting it again would
  // double-reward high-level buddies.
  if (check.baseChance !== undefined) {
    const base = check.baseChance;
    const maxSp = check.maxSpModifier ?? DEFAULT_MAX_SP_MODIFIER;
    const spTerm = spModifierNew(buddy, maxSp);
    const raw = base + spTerm + affinityMod + raceMod + buddyBonusMod;
    const chance = clamp(raw, MIN_CHANCE, MAX_CHANCE);
    return {
      chance,
      roll: 0,
      success: true, // overwritten by rollCheck; irrelevant here
      breakdown: { base, spTerm, levelTerm: 0, affinityMod, raceMod, buddyBonusMod, baseBias: 0 },
    };
  }

  // LEGACY MODEL — unchanged. Existing content resolves bit-for-bit as before.
  const difficulty = check.difficulty ?? 0;
  const spTerm = buddy
    ? clamp((buddy.currentSp - difficulty) / SP_DIVISOR, -LEGACY_SP_CLAMP, LEGACY_SP_CLAMP)
    : LEGACY_NO_BUDDY_SP_TERM;
  const levelTerm = buddy
    ? Math.min(LEGACY_LEVEL_CLAMP, Math.max(0, (buddy.level - 1) / LEVEL_DIVISOR))
    : 0;
  const baseBias = check.baseBias ?? 0;

  const raw =
    LEGACY_BASE_CHANCE + spTerm + levelTerm + affinityMod + raceMod + buddyBonusMod + baseBias;
  const chance = clamp(raw, MIN_CHANCE, MAX_CHANCE);

  return {
    chance,
    roll: 0,
    success: true, // overwritten by rollCheck; irrelevant here
    breakdown: {
      base: LEGACY_BASE_CHANCE,
      spTerm,
      levelTerm,
      affinityMod,
      raceMod,
      buddyBonusMod,
      baseBias,
    },
  };
}

/**
 * Roll a check and return the full resolution. Uses the injected RNG so tests
 * drive it deterministically.
 */
export function rollCheck(
  check: CheckSpec,
  ctx: EncounterCheckContext,
  rng: Rng,
): CheckResolution {
  const computed = computeChance(check, ctx);
  if (check.type === 'none') return computed;
  const roll = rng.next();
  return { ...computed, roll, success: roll < computed.chance };
}
