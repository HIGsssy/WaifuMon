/**
 * Boss-encounter affinity advantage — the one place the Stage 1 matchup lives.
 *
 * Deliberately **not** `capture/affinityMath.ts`. That module answers a
 * different question (does my buddy's style beat this encounter's, and by how
 * much does that move a capture *probability*), against a wheel that excludes
 * `switch` as the neutral style. Boss encounters use a full five-way cycle in
 * which `switch` is a first-class participant — it beats Dominant and loses to
 * Primal — so sharing the capture wheel would either break capture odds or
 * silently give `switch` buddies no boss advantage at all.
 *
 * The wheel is expressed **boss affinity → the buddy affinity that beats it**,
 * which is the direction the specification's table reads and the direction
 * every caller wants: an announcement says "Switch has the advantage" from the
 * boss's affinity alone, before any buddy exists.
 *
 *   Dominant   is beaten by Switch
 *   Submissive is beaten by Dominant
 *   Caregiver  is beaten by Submissive
 *   Primal     is beaten by Caregiver
 *   Switch     is beaten by Primal
 *
 * Stage 1 has an advantage and no disadvantage: a superior buddy adds
 * `advantageBonus`, and every other pairing — inferior or neutral — adds
 * exactly zero. There is no penalty term to configure, on purpose; adding one
 * later is a version bump, not a hidden retune.
 */
import { AFFINITIES, DEFAULT_AFFINITY, type Affinity } from '../../db/schema';
import { normalizeAffinity } from '../capture/affinityMath';

/**
 * Version of the boss affinity *table*, carried on every stored participation.
 *
 * Bumped when the wheel's shape or the advantage rule changes — not when the
 * bonus magnitude is retuned, which content already records per participation
 * as a stored `affinityBonus`. A historical result therefore stays readable:
 * the stored bonus says what was applied, and this says which rulebook applied
 * it.
 */
export const BOSS_AFFINITY_VERSION = 1;

/**
 * The shipped cycle, boss affinity → superior buddy affinity.
 *
 * This is the authoritative table. `content/tables.json` carries the same
 * mapping so an operator can retune without a deploy, and the schema defaults
 * to exactly this object, so content that omits the block cannot disagree with
 * code.
 */
export const DEFAULT_BOSS_AFFINITY_WHEEL: Readonly<Record<Affinity, Affinity>> = Object.freeze({
  dominant: 'switch',
  submissive: 'dominant',
  caregiver: 'submissive',
  primal: 'caregiver',
  switch: 'primal',
}) as Readonly<Record<Affinity, Affinity>>;

/** Shipped advantage magnitude: +10% battle damage. */
export const DEFAULT_AFFINITY_ADVANTAGE_BONUS = 0.1;

/** Stage 1 knows only these two outcomes — there is no penalty tier. */
export type BossAffinityMatchup = 'advantage' | 'neutral';

export interface BossAffinityWheelConfig {
  /** Boss affinity → the buddy affinity that beats it. */
  wheel: Readonly<Record<string, Affinity>>;
  /** Additive damage bonus a superior buddy receives (0.10 = +10%). */
  advantageBonus: number;
}

export const DEFAULT_BOSS_AFFINITY_CONFIG: BossAffinityWheelConfig = Object.freeze({
  wheel: DEFAULT_BOSS_AFFINITY_WHEEL,
  advantageBonus: DEFAULT_AFFINITY_ADVANTAGE_BONUS,
});

/** The buddy affinity that beats `bossAffinity`. */
export function superiorAffinityAgainst(
  bossAffinity: unknown,
  config: BossAffinityWheelConfig = DEFAULT_BOSS_AFFINITY_CONFIG,
): Affinity {
  const boss = normalizeAffinity(bossAffinity);
  // An unmapped boss affinity can only come from a hand-edited wheel. Reading
  // it as "the neutral style has the advantage" would quietly hand every
  // `switch` buddy a bonus, so it falls back to the boss's own affinity —
  // which beats nothing, since a style never beats itself.
  return config.wheel[boss] ?? boss;
}

/** Whether this buddy affinity is the superior one against this boss. */
export function bossAffinityMatchup(
  buddyAffinity: unknown,
  bossAffinity: unknown,
  config: BossAffinityWheelConfig = DEFAULT_BOSS_AFFINITY_CONFIG,
): BossAffinityMatchup {
  const buddy = normalizeAffinity(buddyAffinity);
  const boss = normalizeAffinity(bossAffinity);
  if (buddy === boss) return 'neutral';
  return superiorAffinityAgainst(boss, config) === buddy ? 'advantage' : 'neutral';
}

/** The additive damage bonus for one pairing — `advantageBonus` or exactly 0. */
export function bossAffinityBonus(
  buddyAffinity: unknown,
  bossAffinity: unknown,
  config: BossAffinityWheelConfig = DEFAULT_BOSS_AFFINITY_CONFIG,
): number {
  return bossAffinityMatchup(buddyAffinity, bossAffinity, config) === 'advantage'
    ? config.advantageBonus
    : 0;
}

/** "dominant" → "Dominant". Re-exported so boss callers need one import. */
export { affinityLabel } from '../capture/affinityMath';

/**
 * The announcement line: which affinity gets the edge against this boss.
 * Rendered before anyone has committed, so it names the affinity rather than
 * a matchup.
 */
export function advantageLabelFor(
  bossAffinity: unknown,
  config: BossAffinityWheelConfig = DEFAULT_BOSS_AFFINITY_CONFIG,
): Affinity {
  return superiorAffinityAgainst(bossAffinity, config);
}

/** Every affinity, for exhaustive iteration in validators and tests. */
export const ALL_AFFINITIES: readonly Affinity[] = AFFINITIES;
export { DEFAULT_AFFINITY };
