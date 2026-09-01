/**
 * Buddy Bonus — the effect registry and every piece of decision logic that
 * needs no database.
 *
 * A Buddy Bonus is authored **entirely in species JSON** (`species.buddyBonus`)
 * and is granted by whichever owned copy the player currently has equipped as
 * their Buddy. Nothing in this module — or anywhere else in the codebase —
 * knows a species slug, a species name, or an individual bonus: a new species
 * file that names an `effectId` listed here works the moment it loads, with no
 * code change. Only a genuinely new *kind* of effect needs new code, and that
 * is the one thing this registry is for.
 *
 * `name` and `flavorText` are display-only and are never read by gameplay.
 * Behavior comes from `effectId`, `value` and the optional `target`, and from
 * nothing else.
 *
 * The registry mirrors `content/bonus.json`, which is the human-readable
 * statement of the same table; `tests/unit/buddyBonusEffects.test.ts` asserts
 * the two cannot drift.
 */
import { AFFINITIES, RARITIES, type Affinity, type Rarity } from '../../db/schema';
import { RACE_CODES, type RaceCode } from '../cards/race';

/** Every effect the gameplay layer knows how to apply. */
export const BUDDY_BONUS_EFFECT_IDS = [
  'capture_chance',
  'encounter_weight',
  'energy_save_chance',
  'care_energy_gain',
  'player_xp_gain',
  'buddy_xp_gain',
  'essence_gain',
  'hunt_item_find_chance',
  'affection_gain',
  'boss_reward_gain',
] as const;

export type BuddyBonusEffectId = (typeof BUDDY_BONUS_EFFECT_IDS)[number];

/** Every way a bonus can narrow which Waifumon it applies against. */
export const BUDDY_BONUS_TARGET_TYPES = [
  'race',
  'affinity',
  'rarity',
  'rarity_min',
  'rarity_max',
  'ownership',
] as const;

export type BuddyBonusTargetType = (typeof BUDDY_BONUS_TARGET_TYPES)[number];

export const BUDDY_BONUS_OWNERSHIP_VALUES = ['owned', 'unowned'] as const;
export type BuddyBonusOwnership = (typeof BUDDY_BONUS_OWNERSHIP_VALUES)[number];

/**
 * How one effect behaves, and what it may be pointed at.
 *
 *   - `operation` — `percent_modifier` scales an existing quantity;
 *     `proc_chance` is a percentage probability rolled once.
 *   - `appliesTo` — documentation only: the gameplay system that reads it.
 *   - `allowedTargetTypes` — empty means the effect must carry **no** target.
 *   - `targetOptional` — only meaningful when targets are allowed at all.
 *     Absent is read as "required".
 */
export interface BuddyBonusEffectRule {
  operation: 'percent_modifier' | 'proc_chance';
  appliesTo: string;
  allowedTargetTypes: readonly BuddyBonusTargetType[];
  targetOptional?: boolean;
}

export const BUDDY_BONUS_EFFECTS: Readonly<Record<BuddyBonusEffectId, BuddyBonusEffectRule>> = {
  capture_chance: {
    operation: 'percent_modifier',
    appliesTo: 'capture',
    allowedTargetTypes: ['race', 'affinity', 'rarity_min', 'rarity_max', 'ownership'],
    targetOptional: true,
  },
  encounter_weight: {
    operation: 'percent_modifier',
    appliesTo: 'encounter_selection',
    allowedTargetTypes: ['race', 'affinity', 'rarity', 'rarity_min', 'rarity_max', 'ownership'],
    targetOptional: false,
  },
  energy_save_chance: {
    operation: 'proc_chance',
    appliesTo: 'hunt_energy_cost',
    allowedTargetTypes: [],
  },
  care_energy_gain: {
    operation: 'percent_modifier',
    appliesTo: 'care_energy_gain',
    allowedTargetTypes: [],
  },
  player_xp_gain: {
    operation: 'percent_modifier',
    appliesTo: 'player_xp_gain',
    allowedTargetTypes: [],
  },
  buddy_xp_gain: {
    operation: 'percent_modifier',
    appliesTo: 'buddy_xp_gain',
    allowedTargetTypes: [],
  },
  essence_gain: {
    operation: 'percent_modifier',
    appliesTo: 'essence_gain',
    allowedTargetTypes: [],
  },
  hunt_item_find_chance: {
    operation: 'percent_modifier',
    appliesTo: 'hunt_item_find_chance',
    allowedTargetTypes: [],
  },
  affection_gain: {
    operation: 'percent_modifier',
    appliesTo: 'affection_gain',
    allowedTargetTypes: [],
  },
  /**
   * The one effect not read from the live Buddy slot: a Boss Encounter
   * resolves it from the copy the player *committed* to that encounter, which
   * the participation row already snapshots.
   */
  boss_reward_gain: {
    operation: 'percent_modifier',
    appliesTo: 'boss_encounter_rewards',
    allowedTargetTypes: [],
  },
};

/** The closed value set each target type draws from. */
export const BUDDY_BONUS_TARGET_VALUES: Readonly<
  Record<BuddyBonusTargetType, readonly string[]>
> = {
  race: RACE_CODES,
  affinity: AFFINITIES,
  rarity: RARITIES,
  rarity_min: RARITIES,
  rarity_max: RARITIES,
  ownership: BUDDY_BONUS_OWNERSHIP_VALUES,
};

export interface BuddyBonusTarget {
  type: BuddyBonusTargetType;
  value: string;
}

export interface BuddyBonus {
  /** Display only. Never read by gameplay. */
  name: string;
  /** Display only. Never read by gameplay. */
  flavorText: string;
  effectId: BuddyBonusEffectId;
  /** Percentage. `100` doubles a `percent_modifier`; a `proc_chance` of 25 is a 1-in-4 roll. */
  value: number;
  // `| undefined` explicitly, because the project runs with
  // `exactOptionalPropertyTypes` and content parsing produces that shape.
  target?: BuddyBonusTarget | undefined;
}

export function isBuddyBonusEffectId(value: unknown): value is BuddyBonusEffectId {
  return typeof value === 'string' && value in BUDDY_BONUS_EFFECTS;
}

/** True when this effect is allowed to carry a target at all. */
export function effectAllowsTarget(effectId: BuddyBonusEffectId): boolean {
  return BUDDY_BONUS_EFFECTS[effectId].allowedTargetTypes.length > 0;
}

/** True when this effect is invalid *without* a target. */
export function effectRequiresTarget(effectId: BuddyBonusEffectId): boolean {
  const rule = BUDDY_BONUS_EFFECTS[effectId];
  return rule.allowedTargetTypes.length > 0 && rule.targetOptional !== true;
}

/** Total ordering on the rarity ladder — the same ordering capture math uses. */
const RARITY_ORDER = new Map<string, number>(RARITIES.map((r, i) => [r, i]));

function rarityRank(rarity: string): number {
  return RARITY_ORDER.get(rarity) ?? -1;
}

/**
 * The Waifumon a targeted bonus is being tested against.
 *
 * `owned` means "the player already has at least one active copy of this
 * species" and is only consulted by an `ownership` target, so callers that
 * cannot cheaply answer it may pass `false` for any other target type.
 */
export interface BuddyBonusSubject {
  race: RaceCode;
  affinity: Affinity | string;
  rarity: Rarity | string;
  owned: boolean;
}

/**
 * Does this bonus's target describe the given Waifumon?
 *
 * An absent target matches everything — that is what "no target = all species"
 * means for `capture_chance`. An unknown target type matches nothing, which
 * only a bonus that bypassed schema validation could reach.
 */
export function matchesBuddyBonusTarget(
  target: BuddyBonusTarget | undefined | null,
  subject: BuddyBonusSubject,
): boolean {
  if (!target) return true;
  switch (target.type) {
    case 'race':
      return subject.race === target.value;
    case 'affinity':
      return subject.affinity === target.value;
    case 'rarity':
      return subject.rarity === target.value;
    case 'rarity_min':
      return rarityRank(subject.rarity) >= rarityRank(target.value);
    case 'rarity_max':
      return rarityRank(subject.rarity) <= rarityRank(target.value);
    case 'ownership':
      return target.value === 'owned' ? subject.owned : !subject.owned;
    default:
      return false;
  }
}

/**
 * The percentage this bonus contributes to `effectId`, or 0 when it is a
 * different effect or its target does not match.
 *
 * `subject` may be omitted for the untargeted effects; a targeted bonus with
 * no subject to test contributes nothing rather than applying universally.
 */
export function buddyBonusPercent(
  bonus: BuddyBonus | null | undefined,
  effectId: BuddyBonusEffectId,
  subject?: BuddyBonusSubject,
): number {
  if (!bonus || bonus.effectId !== effectId) return 0;
  if (!bonus.target) return bonus.value;
  if (!subject) return 0;
  return matchesBuddyBonusTarget(bonus.target, subject) ? bonus.value : 0;
}

/**
 * `base` scaled by a **relative** percentage: `+10%` on 100 is 110, not 100.1.
 * The single arithmetic every `percent_modifier` effect goes through, so
 * "percent" can never come to mean two different things in two systems.
 */
export function applyPercentModifier(base: number, percent: number): number {
  if (!percent) return base;
  // `base + base × percent / 100` rather than `base × (1 + percent / 100)`:
  // the two are algebraically identical but the second loses exactness on
  // ordinary cases (100 at +10% lands on 110.00000000000001), and encounter
  // weights are compared and summed.
  return base + (base * percent) / 100;
}

/**
 * {@link applyPercentModifier} for quantities that must stay whole — energy,
 * XP, affection, Essence, item stacks.
 *
 * Rounds rather than floors on purpose: flooring would make every bonus whose
 * percentage cannot lift a small award to the next integer (a `+50%` on a
 * single item, a `+7%` on 2 XP) silently do nothing at all, which reads to a
 * player as a broken bonus rather than a small one.
 */
export function applyPercentModifierInt(base: number, percent: number): number {
  if (!percent) return base;
  return Math.max(0, Math.round(applyPercentModifier(base, percent)));
}

/** A `proc_chance` roll: `percent` out of 100, using the caller's RNG. */
export function rollBuddyBonusProc(percent: number, roll: number): boolean {
  if (percent <= 0) return false;
  return roll < Math.min(100, percent) / 100;
}

/**
 * Which selection step an `encounter_weight` target belongs to.
 *
 * The hunt draws a rarity first and then a species inside that bucket, so a
 * rarity-shaped target has to move the *rarity* table — inside one bucket every
 * candidate shares a rarity, and scaling them all equally would change nothing.
 * Everything else discriminates between species and belongs to the second step.
 * Split here, in one pure function, so the two call sites cannot double-apply.
 */
export function encounterWeightScope(
  target: BuddyBonusTarget | undefined | null,
): 'rarity' | 'species' | 'none' {
  if (!target) return 'none';
  switch (target.type) {
    case 'rarity':
    case 'rarity_min':
    case 'rarity_max':
      return 'rarity';
    case 'race':
    case 'affinity':
    case 'ownership':
      return 'species';
    default:
      return 'none';
  }
}

/**
 * The percent an `encounter_weight` bonus applies to one **rarity bucket**.
 * Zero for species-shaped targets — those are applied per candidate instead.
 */
export function encounterRarityWeightPercent(
  bonus: BuddyBonus | null | undefined,
  rarity: Rarity | string,
): number {
  if (!bonus || bonus.effectId !== 'encounter_weight') return 0;
  if (encounterWeightScope(bonus.target) !== 'rarity') return 0;
  return matchesBuddyBonusTarget(bonus.target, {
    race: 'human',
    affinity: 'switch',
    rarity,
    owned: false,
  })
    ? bonus.value
    : 0;
}

/**
 * The percent an `encounter_weight` bonus applies to one **candidate species**.
 * Zero for rarity-shaped targets — those already moved the rarity table.
 */
export function encounterSpeciesWeightPercent(
  bonus: BuddyBonus | null | undefined,
  subject: BuddyBonusSubject,
): number {
  if (!bonus || bonus.effectId !== 'encounter_weight') return 0;
  if (encounterWeightScope(bonus.target) !== 'species') return 0;
  return matchesBuddyBonusTarget(bonus.target, subject) ? bonus.value : 0;
}

/** Human-readable target phrase for UI surfaces, e.g. `SSR and above`. */
export function buddyBonusTargetLabel(target: BuddyBonusTarget | undefined | null): string | null {
  if (!target) return null;
  switch (target.type) {
    case 'race':
      return `${target.value} Waifumon`;
    case 'affinity':
      return `${target.value} Waifumon`;
    case 'rarity':
      return `${target.value} Waifumon`;
    case 'rarity_min':
      return `${target.value} and above`;
    case 'rarity_max':
      return `${target.value} and below`;
    case 'ownership':
      return target.value === 'owned' ? 'already-owned Waifumon' : 'not-yet-owned Waifumon';
    default:
      return null;
  }
}

/**
 * Everything a UI surface needs to print a bonus, and nothing it needs to
 * decide anything. Display strings come straight from content.
 */
export interface BuddyBonusView {
  name: string;
  flavorText: string;
  effectId: BuddyBonusEffectId;
  value: number;
  target: BuddyBonusTarget | null;
  targetLabel: string | null;
}

export function buddyBonusView(bonus: BuddyBonus): BuddyBonusView {
  return {
    name: bonus.name,
    flavorText: bonus.flavorText,
    effectId: bonus.effectId,
    value: bonus.value,
    target: bonus.target ?? null,
    targetLabel: buddyBonusTargetLabel(bonus.target),
  };
}
