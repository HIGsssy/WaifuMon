/**
 * Expedition match quality — pure. No database, no clock, no Discord.
 *
 * Answers the question a player is actually asking when they look at the
 * candidate list: *how well does she fit what this mission asks for?* That is
 * a different question from "how likely is this to succeed", and the two are
 * kept apart on purpose:
 *
 *   - **Match quality** (this file) is the player-facing contract. It reads the
 *     mission's three stated requirements — preferred affinity, preferred
 *     race, recommended level — and grades the copy against them. It never
 *     looks at `baseSuccessChance`, so an easy mission cannot inflate it.
 *   - **Success chance** (`expeditionMath.ts`) stays hidden and authoritative.
 *     It is what resolution rolls against, and nothing here changes it.
 *
 * The previous presentation mapped the success chance onto
 * `EXCELLENT … POOR`. Because the thresholds were absolute and missions have
 * very different base chances, a level-ready copy with the wrong temperament
 * and the wrong race read EXCELLENT on an easy mission — the player saw "this
 * is an excellent pick" when it met one requirement out of three.
 *
 * Every constant comes from `tables.expeditions.match`.
 */
import type {
  BuddyAffinityConfig,
  ExpeditionDefinition,
  ExpeditionsConfig,
  MatchQuality,
} from '../content/schemas';
import { MATCH_QUALITIES } from '../content/schemas';
import { resolveAffinityFit, type SuitabilityCandidate } from './expeditionMath';

/**
 * How one requirement went.
 *
 *   - `met` — she has what the mission asked for.
 *   - `near` — level only: short of the recommendation, within tolerance.
 *   - `missed` — the mission asked, she does not have it.
 *   - `against` — worse than missing: a preferred affinity beats hers on the
 *     wheel, or she is badly under-levelled. Mirrors the hidden penalties.
 *   - `none` — the mission states no preference on this axis. Not counted.
 */
export type MatchVerdict = 'met' | 'near' | 'missed' | 'against' | 'none';

export interface MatchAssessment {
  quality: MatchQuality;
  /** Mean requirement score in [0, 1]. Internal — only `quality` is shown. */
  score: number;
  affinity: MatchVerdict;
  race: MatchVerdict;
  /** Always stated: every mission has a recommended level. */
  level: MatchVerdict;
}

export interface MatchInput {
  definition: Pick<
    ExpeditionDefinition,
    'recommendedLevel' | 'preferredAffinities' | 'preferredRaces'
  >;
  waifu: SuitabilityCandidate;
  config: ExpeditionsConfig;
  affinityConfig: BuddyAffinityConfig;
}

export function evaluateMatch(input: MatchInput): MatchAssessment {
  const { definition, waifu, config, affinityConfig } = input;
  const m = config.match;

  // Same wheel read as the hidden chance, so "against" here is exactly the
  // case that costs her `affinityWeak` there.
  let affinity: MatchVerdict = 'none';
  if (definition.preferredAffinities.length > 0) {
    const fit = resolveAffinityFit(waifu.affinity, definition.preferredAffinities, affinityConfig);
    affinity = fit === 'strong' ? 'met' : fit === 'weak' ? 'against' : 'missed';
  }

  let race: MatchVerdict = 'none';
  if (definition.preferredRaces.length > 0) {
    race = definition.preferredRaces.includes(waifu.race) ? 'met' : 'missed';
  }

  const shortBy = definition.recommendedLevel - waifu.level;
  const level: MatchVerdict =
    shortBy <= 0 ? 'met' : shortBy <= m.levelNearTolerance ? 'near' : 'against';

  const value = (v: MatchVerdict): number =>
    v === 'met' ? 1 : v === 'near' ? m.nearScore : v === 'against' ? m.againstScore : 0;

  const stated = [affinity, race, level].filter((v) => v !== 'none');
  const raw = stated.reduce((sum, v) => sum + value(v), 0) / stated.length;
  const score = Math.min(1, Math.max(0, raw));

  return { quality: qualityFor(stated, score, config), score, affinity, race, level };
}

/**
 * PERFECT is a rule, not a threshold: every stated requirement met. That is
 * what guarantees two-out-of-three can never wear the top label, whatever the
 * thresholds are retuned to.
 */
function qualityFor(
  stated: readonly MatchVerdict[],
  score: number,
  config: ExpeditionsConfig,
): MatchQuality {
  const t = config.match.thresholds;
  if (stated.every((v) => v === 'met')) return 'PERFECT_MATCH';
  if (score >= t.strong) return 'STRONG_MATCH';
  if (score >= t.partial) return 'PARTIAL_MATCH';
  if (score >= t.weak) return 'WEAK_MATCH';
  return 'POOR_MATCH';
}

/** 0 is best. `MATCH_QUALITIES` is declared best-to-worst. */
export function matchRank(quality: MatchQuality): number {
  return MATCH_QUALITIES.indexOf(quality);
}

/**
 * Read the label persisted on a row.
 *
 * Rows deployed before match quality existed carry a legacy success band
 * (`EXCELLENT`, `GOOD`, …). Those are *not* translated: a success band says
 * nothing trustworthy about fit, and inventing a match label for it would be
 * showing the player something the game never computed. They read as `null`
 * and the screens simply omit the line.
 */
export function parseStoredMatch(value: string | null | undefined): MatchQuality | null {
  return (MATCH_QUALITIES as readonly string[]).includes(value ?? '')
    ? (value as MatchQuality)
    : null;
}

/** What the candidate sort needs. */
export interface RankableCandidate {
  waifuId: number;
  level: number;
  unavailableReasons: readonly string[];
  match: Pick<MatchAssessment, 'quality'>;
  successChance: number;
}

/**
 * Candidate order, best first. Total and deterministic:
 *
 *   1. available before unavailable — the select menu only offers the former,
 *      and its 25-entry cap must be spent on copies that can actually go;
 *   2. match quality, best first — what the player reads, so the list never
 *      shows a WEAK above a STRONG;
 *   3. hidden success chance, highest first — within one label, the copy most
 *      likely to come home (affinity is worth more than race, over-levelling
 *      helps up to its cap) goes first;
 *   4. level, highest first;
 *   5. `waifuId`, ascending — the oldest copy wins a dead heat, so the order
 *      never depends on what the database happened to return.
 */
export function compareCandidates(a: RankableCandidate, b: RankableCandidate): number {
  return (
    Number(a.unavailableReasons.length > 0) - Number(b.unavailableReasons.length > 0) ||
    matchRank(a.match.quality) - matchRank(b.match.quality) ||
    b.successChance - a.successChance ||
    b.level - a.level ||
    a.waifuId - b.waifuId
  );
}

