/**
 * Expedition suitability — pure. No database, no clock, no Discord.
 *
 * Answers one question: given a mission and the WaifuMon a player is thinking
 * of sending, how likely is this to go well? The answer is two exact numbers,
 * `successChance` and `exceptionalChance`, persisted on the expedition row at
 * deployment, used to resolve it, and **never shown to anybody**. A player who
 * can read the percentage optimises against the formula instead of thinking
 * about their roster.
 *
 * What the player *is* shown lives in `expeditionMatch.ts`, and is a separate
 * model on purpose: match quality describes how well she fits the mission's
 * stated requirements, not a relabelled success chance. This file used to map
 * the chance onto `EXCELLENT … POOR`, which on an easy mission called almost
 * any ready copy EXCELLENT.
 *
 * Every constant is injected from `tables.expeditions`. Nothing in this file
 * is a number, which is what makes the design's "provisional, to be validated
 * in playtesting" values a content edit rather than a deploy.
 */
import { getAffinityMatchup } from '../capture/affinityMath';
import type { RaceCode } from '../cards/race';
import type {
  BuddyAffinityConfig,
  ExpeditionDefinition,
  ExpeditionsConfig,
} from '../content/schemas';
import type { Affinity } from '../../db/schema';

/** One named term in the suitability sum. */
export interface SuitabilityFactor {
  /** Stable identifier — tests assert on this, never on the label. */
  id:
    | 'base'
    | 'affinity_strong'
    | 'affinity_weak'
    | 'race_match'
    | 'level_at_or_above'
    | 'level_below'
    | 'level_above'
    | 'clamped';
  /** Player-facing wording, for a future "Affinity Read"-style flavour line. */
  label: string;
  /** Additive delta in probability points. */
  delta: number;
}

/** The deployable copy, reduced to the three things suitability depends on. */
export interface SuitabilityCandidate {
  level: number;
  affinity: Affinity;
  /** Resolved through the injected resolver — race is content, not a column. */
  race: RaceCode;
}

export interface SuitabilityInput {
  definition: Pick<
    ExpeditionDefinition,
    'baseSuccessChance' | 'recommendedLevel' | 'preferredAffinities' | 'preferredRaces'
  >;
  waifu: SuitabilityCandidate;
  config: ExpeditionsConfig;
  /** The affinity wheel, from `tables.buddyAffinity`. Reused, never re-invented. */
  affinityConfig: BuddyAffinityConfig;
}

export interface SuitabilityResult {
  /** Clamped to [minChance, maxChance]. Internal and persisted; never rendered. */
  successChance: number;
  /** Clamped to [0, exceptional.maxChance]. Also internal. */
  exceptionalChance: number;
  /**
   * Every term that contributed, in the order applied.
   *
   * Exists so tests can assert *why* a chance is what it is rather than only
   * that it is, and so a future flavour line ("she knows this terrain") has
   * something to read. Not rendered as numbers in V1.
   */
  factors: SuitabilityFactor[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * How the deployed copy's affinity relates to what the mission wants.
 *
 * Reuses the existing wheel rather than inventing a second comparison, but the
 * direction needs care. `getAffinityMatchup(a, b)` answers "does `a` beat `b`",
 * so:
 *
 *   - the copy's own affinity appearing in `preferredAffinities` is a
 *     **strong** match — the mission asked for her, directly;
 *   - a preferred affinity that *beats* the copy's on the wheel is a **weak**
 *     match — the mission wants a temperament hers gives way to;
 *   - everything else, including `switch` on either side, is neutral.
 *
 * Strong wins outright when both could apply, because being exactly what was
 * asked for is not undone by also being beaten by a second preference.
 */
export function resolveAffinityFit(
  waifuAffinity: Affinity,
  preferredAffinities: readonly Affinity[],
  affinityConfig: BuddyAffinityConfig,
): 'strong' | 'weak' | 'neutral' {
  if (preferredAffinities.length === 0) return 'neutral';
  if (preferredAffinities.includes(waifuAffinity)) return 'strong';
  for (const preferred of preferredAffinities) {
    if (getAffinityMatchup(preferred, waifuAffinity, affinityConfig) === 'strong') {
      return 'weak';
    }
  }
  return 'neutral';
}

/**
 * The whole computation.
 *
 * Additive in probability points rather than multiplicative, so a content
 * author reads "+20pp for the right temperament" and can add it up in their
 * head. The clamp at the end is what stops a perfectly-matched level-80 copy
 * reaching certainty: `maxChance` ships at 0.95, so no expedition is ever a
 * sure thing and no expedition is ever hopeless.
 */
export function evaluateSuitability(input: SuitabilityInput): SuitabilityResult {
  const { definition, waifu, config, affinityConfig } = input;
  const s = config.suitability;
  const factors: SuitabilityFactor[] = [];

  let chance = definition.baseSuccessChance;
  factors.push({ id: 'base', label: 'Base mission difficulty', delta: chance });

  const affinityFit = resolveAffinityFit(
    waifu.affinity,
    definition.preferredAffinities,
    affinityConfig,
  );
  if (affinityFit === 'strong') {
    chance += s.affinityStrong;
    factors.push({
      id: 'affinity_strong',
      label: 'Her temperament is exactly what this needs',
      delta: s.affinityStrong,
    });
  } else if (affinityFit === 'weak') {
    chance += s.affinityWeak;
    factors.push({
      id: 'affinity_weak',
      label: 'Her temperament gives way to what this needs',
      delta: s.affinityWeak,
    });
  }

  if (definition.preferredRaces.length > 0 && definition.preferredRaces.includes(waifu.race)) {
    chance += s.raceMatch;
    factors.push({ id: 'race_match', label: 'She belongs out there', delta: s.raceMatch });
  }

  // Level is two separate terms rather than one signed curve: being *ready*
  // for a mission is a threshold (a flat bonus at or above the recommendation),
  // while being over- or under-levelled scales. Folding them together would
  // make the flat readiness bonus impossible to express.
  const levelDelta = waifu.level - definition.recommendedLevel;
  if (levelDelta >= 0) {
    chance += s.levelAtOrAbove;
    factors.push({
      id: 'level_at_or_above',
      label: 'She is ready for this',
      delta: s.levelAtOrAbove,
    });
    if (levelDelta > 0) {
      // Bounded: an over-levelled copy helps, but a level-80 on a level-5
      // errand should not buy certainty. `levelAboveCap` is what stops
      // over-levelling from replacing every other consideration.
      const raw = levelDelta * s.levelAbovePerLevel;
      const bonus = Math.min(raw, s.levelAboveCap);
      if (bonus !== 0) {
        chance += bonus;
        factors.push({ id: 'level_above', label: 'Comfortably over-qualified', delta: bonus });
      }
    }
  } else {
    // Unbounded on purpose, because the clamp below already floors it: a copy
    // far under the recommendation lands on `minChance` and stays there, which
    // reads as "she can try" rather than as "this is impossible".
    const penalty = -levelDelta * s.levelBelowPerLevel;
    chance += penalty;
    factors.push({
      id: 'level_below',
      label: `${-levelDelta} level${levelDelta === -1 ? '' : 's'} under-prepared`,
      delta: penalty,
    });
  }

  const unclamped = chance;
  const successChance = clamp(chance, s.minChance, s.maxChance);
  if (successChance !== unclamped) {
    factors.push({
      id: 'clamped',
      label: 'Bounded by the mission floor/ceiling',
      delta: successChance - unclamped,
    });
  }

  /**
   * Exceptional chance rides on the *margin* the deployment earned, not on the
   * absolute chance. A mission with a generous base does not hand out
   * Exceptional results for free; a player who matched temperament, race and
   * level to a hard mission is the one who gets them.
   *
   * Measured against the definition's own `baseSuccessChance` so the margin is
   * "what this deployment added", and floored at zero so a badly-matched copy
   * cannot produce a negative chance that would then need its own clamp.
   */
  const margin = Math.max(0, successChance - definition.baseSuccessChance);
  const exceptionalChance = clamp(
    config.exceptional.baseChance + margin * config.exceptional.perSuitabilityPoint,
    0,
    config.exceptional.maxChance,
  );

  return { successChance, exceptionalChance, factors };
}
