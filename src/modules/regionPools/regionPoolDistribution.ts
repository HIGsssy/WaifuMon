/**
 * `describeRegionDistribution` — the exact encounter odds of one region pool,
 * computed rather than sampled (RP1 §10).
 *
 * It restates the runtime's selection rules as probabilities, step for step,
 * and borrows the runtime's own arithmetic wherever that is exported (Buddy
 * target matching, the relative percent modifier, the level shift):
 *
 *   - `hunt` — `huntService.hunt`: the result table (with any
 *     `hunt_item_find_chance` Buddy) decides whether there is an encounter;
 *     then `pickEncounterSpecies` with the Buddy: rarity first, tiers region →
 *     default region → global table, up to six rerolls of a dead rarity, then
 *     the exhausted fallbacks.
 *   - `scripted_spawn` — `huntService.pickSpeciesForSpawn`: the same draw
 *     with no Buddy and no result table.
 *   - `filtered_selector` — `speciesSelection.pickFilteredCandidate`: scope,
 *     filter, then the level-adjusted rarity table *conditioned on* the rarities
 *     present, with no fallback tier at all.
 *
 * Where the runtime would throw (a weight a Buddy bonus drove negative, or a
 * table with no positive weight), the probability of reaching that throw is
 * reported as `errorProbability` and an `unsafe_*` issue — never smoothed
 * into an invented distribution. The species chosen by the reroll-exhausted
 * path (`LIMIT 1` with no `ORDER BY`) depends on heap order, so that mass is
 * reported against the path, not a species.
 *
 * Pure. If the hunt's rules change, this file and its parity tests change
 * with them.
 */
import type { BuddyBonus } from '../buddyBonus/buddyBonusEffects';
import {
  applyPercentModifier,
  buddyBonusPercent,
  encounterRarityWeightPercent,
  encounterSpeciesWeightPercent,
} from '../buddyBonus/buddyBonusEffects';
import type { ProgressionConfig, TablesContent } from '../content/schemas';
import { matchesSpeciesFilter, type SpeciesFilter } from '../encounters/speciesSelection';
import { DUNGEON_EXCLUSIVE_TAG, REGION_EXCLUSIVE_TAG } from '../locations/regions';
import { rareEncounterShift } from '../progression/progressionMath';
import type { RaceCode } from '../cards/race';

/** The hunt's `MAX_RARITY_REROLLS`: draws of a rarity before giving up on rarity. */
export const HUNT_RARITY_ATTEMPTS = 6;

export const DISTRIBUTION_MODES = ['hunt', 'scripted_spawn', 'filtered_selector'] as const;
export type DistributionMode = (typeof DISTRIBUTION_MODES)[number];

export interface DistributionSpecies {
  slug: string;
  name: string;
  rarity: string;
  enabled: boolean;
  tags: readonly string[];
  race: string;
  affinity: string;
  perSpeciesWeight: number;
}

export interface DistributionPoolMember {
  species: string;
  weight: number;
}

export interface DistributionInput {
  mode: DistributionMode;
  level: number;
  regionId: string;
  defaultRegionId: string;
  /** The pool being analysed (a draft or a published revision). */
  pool: readonly DistributionPoolMember[];
  /** The default region's pool as hunts read it. Ignored when analysing the default region itself. */
  defaultPool: readonly DistributionPoolMember[];
  /** Every species row, enabled or not. */
  species: ReadonlyMap<string, DistributionSpecies>;
  tables: {
    hunt: Pick<TablesContent['hunt'], 'rarityTable' | 'resultTable'>;
    progression: Pick<ProgressionConfig, 'rareEncounterShift'>;
  };
  /** `hunt` only: the equipped Buddy's authored bonus. */
  buddyBonus?: BuddyBonus | null;
  /** `hunt` only: the species the player is assumed to own (ownership-targeted bonuses). */
  ownedSpecies?: ReadonlySet<string>;
  /** `filtered_selector` only. */
  filter?: SpeciesFilter;
}

export type ResolvingTier = 'region' | 'default_region' | 'global' | 'dead' | 'filtered';

export type ExhaustedFallback =
  | 'default_pool_arbitrary'
  | 'open_species_arbitrary'
  | 'emergency_region_exclusive'
  | 'nothing';

export interface RarityOdds {
  rarity: string;
  baseWeight: number;
  /** After rarity-scoped Buddy and the level shift. */
  effectiveWeight: number;
  /** One rarity draw lands here. */
  rollProbability: number;
  /** An encounter (after rerolls) resolves at this rarity. */
  probability: number;
  tier: ResolvingTier;
  candidates: number;
  /** The runtime would throw when this rarity is drawn. */
  unsafe: boolean;
}

export interface SpeciesOdds {
  slug: string;
  name: string;
  rarity: string;
  tier: ResolvingTier;
  /** True when the analysed pool lists her; false when she comes from a fallback tier. */
  inPool: boolean;
  /** Weight as the runtime reads it (`max(1, …)`). */
  weight: number;
  /** After any species-scoped Buddy bonus. */
  effectiveWeight: number;
  shareOfRarity: number;
  /** Per encounter (hunt), per spawn (scripted / filtered). */
  perEncounter: number;
  /** Per Hunt action, including non-encounter results. Hunt mode only. */
  perHunt: number | null;
}

export type ExclusionReason =
  | 'unknown_species'
  | 'disabled'
  | 'dungeon_exclusive'
  | 'rarity_not_hunted'
  | 'rarity_never_rolled'
  | 'filtered_out';

export interface DistributionIssue {
  code:
    | 'unsafe_rarity_table'
    | 'unsafe_species_weights'
    | 'unsafe_result_table'
    | 'rarity_falls_back'
    | 'rarity_dead'
    | 'rerolls_exhausted'
    | 'no_matching_species'
    | 'buddy_ignored';
  severity: 'error' | 'warning' | 'info';
  message: string;
  rarity?: string;
}

export interface DistributionResult {
  mode: DistributionMode;
  level: number;
  /** Share of Hunt actions that are encounters. Hunt mode only. */
  encounterShare: number | null;
  rarities: RarityOdds[];
  species: SpeciesOdds[];
  excluded: Array<{ slug: string; reason: ExclusionReason }>;
  /** Hunt / scripted: probability the six attempts all land on dead rarities. */
  exhausted: { probability: number; fallback: ExhaustedFallback } | null;
  /** Probability the runtime throws instead of producing a result. */
  errorProbability: number;
  issues: DistributionIssue[];
}

interface Weighted {
  slug: string;
  weight: number;
}

const hasTag = (s: DistributionSpecies, tag: string) => s.tags.includes(tag);
/** `species.enabled and not dungeon_exclusive` — the pool-tier predicate. */
const poolEligible = (s: DistributionSpecies) => s.enabled && !hasTag(s, DUNGEON_EXCLUSIVE_TAG);
/** The global tier adds `not region_exclusive`. */
const openEligible = (s: DistributionSpecies) => poolEligible(s) && !hasTag(s, REGION_EXCLUSIVE_TAG);

/** Would `rollWeighted` accept these weights? (no negatives, no non-finite, positive total) */
function rollable(weights: readonly number[]): boolean {
  let total = 0;
  for (const w of weights) {
    if (w < 0 || !Number.isFinite(w)) return false;
    total += w;
  }
  return total > 0;
}

/** `huntService.rarityEntriesFor`: rarity-scoped Buddy first, then the level shift. */
export function huntRarityWeights(
  tables: DistributionInput['tables'],
  level: number,
  bonus: BuddyBonus | null,
): Array<{ rarity: string; baseWeight: number; weight: number }> {
  const entries = tables.hunt.rarityTable.map((r) => ({
    rarity: r.rarity as string,
    baseWeight: r.weight,
    weight: applyPercentModifier(r.weight, encounterRarityWeightPercent(bonus, r.rarity)),
  }));
  const shift = rareEncounterShift(level, tables.progression as ProgressionConfig);
  if (!shift) return entries;
  return entries.map((e) => {
    if (e.rarity === shift.fromRarity) return { ...e, weight: Math.max(0, e.weight - shift.weightUnits) };
    if (e.rarity === shift.toRarity) return { ...e, weight: e.weight + shift.weightUnits };
    return e;
  });
}

export function describeRegionDistribution(input: DistributionInput): DistributionResult {
  return input.mode === 'filtered_selector' ? describeFiltered(input) : describeHunt(input);
}

function poolMembersExcluded(
  input: DistributionInput,
  rolled: ReadonlyMap<string, number>,
): DistributionResult['excluded'] {
  const excluded: DistributionResult['excluded'] = [];
  for (const member of input.pool) {
    const s = input.species.get(member.species);
    if (!s) excluded.push({ slug: member.species, reason: 'unknown_species' });
    else if (hasTag(s, DUNGEON_EXCLUSIVE_TAG)) excluded.push({ slug: s.slug, reason: 'dungeon_exclusive' });
    else if (!s.enabled) excluded.push({ slug: s.slug, reason: 'disabled' });
    else if (!rolled.has(s.rarity)) excluded.push({ slug: s.slug, reason: 'rarity_not_hunted' });
    else if (rolled.get(s.rarity) === 0) excluded.push({ slug: s.slug, reason: 'rarity_never_rolled' });
  }
  return excluded;
}

function describeHunt(input: DistributionInput): DistributionResult {
  const hunting = input.mode === 'hunt';
  const bonus = hunting ? (input.buddyBonus ?? null) : null;
  const owned = input.ownedSpecies ?? new Set<string>();
  const issues: DistributionIssue[] = [];
  if (!hunting && input.buddyBonus) {
    issues.push({
      code: 'buddy_ignored',
      severity: 'info',
      message: 'Scripted spawns never apply a Buddy Bonus; the Buddy scenario was ignored.',
    });
  }

  const isDefault = input.regionId === input.defaultRegionId;
  const defaultPool = isDefault ? input.pool : input.defaultPool;
  const pooled = new Set(input.pool.map((m) => m.species));

  // Per-hunt encounter share: the result table, with an item-find Buddy.
  let encounterShare: number | null = null;
  let resultError = 0;
  if (hunting) {
    const itemFind = buddyBonusPercent(bonus, 'hunt_item_find_chance');
    const result = input.tables.hunt.resultTable.map((r) => ({
      kind: r.kind,
      weight:
        r.kind === 'item_find' || r.kind === 'rare_item_find' ? applyPercentModifier(r.weight, itemFind) : r.weight,
    }));
    if (!rollable(result.map((r) => r.weight))) {
      issues.push({
        code: 'unsafe_result_table',
        severity: 'error',
        message: 'The Buddy bonus leaves the hunt result table unrollable; every hunt would fail.',
      });
      resultError = 1;
      encounterShare = 0;
    } else {
      const total = result.reduce((s, r) => s + r.weight, 0);
      encounterShare = result.filter((r) => r.kind === 'encounter').reduce((s, r) => s + r.weight, 0) / total;
    }
  }

  const rarityWeights = huntRarityWeights(input.tables, input.level, bonus);
  const rolled = new Map(rarityWeights.map((r) => [r.rarity, r.weight]));
  const excluded = poolMembersExcluded(input, rolled);

  if (!rollable(rarityWeights.map((r) => r.weight))) {
    issues.push({
      code: 'unsafe_rarity_table',
      severity: 'error',
      message: 'The rarity table has a negative weight or no positive weight; every encounter draw would fail.',
    });
    return {
      mode: input.mode,
      level: input.level,
      encounterShare,
      rarities: rarityWeights.map((r) => ({
        rarity: r.rarity,
        baseWeight: r.baseWeight,
        effectiveWeight: r.weight,
        rollProbability: 0,
        probability: 0,
        tier: 'dead',
        candidates: 0,
        unsafe: true,
      })),
      species: [],
      excluded,
      exhausted: null,
      // Every encounter draw throws; in hunt mode, only hunts that reach an encounter do.
      errorProbability: hunting ? (resultError === 1 ? 1 : (encounterShare ?? 0)) : 1,
      issues,
    };
  }
  const rarityTotal = rarityWeights.reduce((s, r) => s + r.weight, 0);

  const bucketFrom = (members: readonly DistributionPoolMember[], rarity: string): Weighted[] =>
    members.flatMap((m) => {
      const s = input.species.get(m.species);
      return s && s.rarity === rarity && poolEligible(s) ? [{ slug: s.slug, weight: Math.max(1, m.weight) }] : [];
    });
  const globalBucket = (rarity: string): Weighted[] =>
    [...input.species.values()]
      .filter((s) => s.rarity === rarity && openEligible(s))
      .map((s) => ({ slug: s.slug, weight: Math.max(1, s.perSpeciesWeight) }));

  interface Resolved {
    rarity: string;
    baseWeight: number;
    weight: number;
    p: number;
    tier: ResolvingTier;
    bucket: Array<Weighted & { effective: number }>;
    unsafe: boolean;
  }
  const resolved: Resolved[] = rarityWeights.map((r) => {
    let tier: ResolvingTier = 'region';
    let bucket = bucketFrom(input.pool, r.rarity);
    if (bucket.length === 0 && !isDefault) {
      tier = 'default_region';
      bucket = bucketFrom(defaultPool, r.rarity);
    }
    if (bucket.length === 0) {
      tier = 'global';
      bucket = globalBucket(r.rarity);
    }
    if (bucket.length === 0) tier = 'dead';
    // Species-scoped `encounter_weight` (race / affinity / ownership), relative.
    const effective = bucket.map((b) => {
      const s = input.species.get(b.slug)!;
      const pct =
        bonus && bonus.effectId === 'encounter_weight'
          ? encounterSpeciesWeightPercent(bonus, {
              race: s.race as RaceCode,
              affinity: s.affinity,
              rarity: s.rarity,
              owned: owned.has(s.slug),
            })
          : 0;
      return { ...b, effective: applyPercentModifier(b.weight, pct) };
    });
    const unsafe = tier !== 'dead' && !rollable(effective.map((b) => b.effective));
    return {
      rarity: r.rarity,
      baseWeight: r.baseWeight,
      weight: r.weight,
      p: r.weight / rarityTotal,
      tier,
      bucket: effective,
      unsafe,
    };
  });

  // Dead rarities are rerolled with the same table: attempt i reaches a live
  // rarity with probability d^i · p_k; six dead draws exhaust the rerolls.
  const dead = resolved.filter((r) => r.tier === 'dead').reduce((s, r) => s + r.p, 0);
  let reach = 0;
  for (let i = 0; i < HUNT_RARITY_ATTEMPTS; i++) reach += dead ** i;
  const exhaustedP = dead ** HUNT_RARITY_ATTEMPTS;

  const perEncounterScale = hunting ? (encounterShare ?? 0) : null;
  const species: SpeciesOdds[] = [];
  let errorMass = 0;
  for (const r of resolved) {
    const probability = r.tier === 'dead' ? 0 : r.p * reach;
    if (r.tier === 'dead') {
      if (r.p > 0) {
        issues.push({
          code: 'rarity_dead',
          severity: 'warning',
          rarity: r.rarity,
          message: `No species anywhere can be drawn at ${r.rarity}; those draws are rerolled.`,
        });
      }
      continue;
    }
    if (r.unsafe) {
      errorMass += probability;
      issues.push({
        code: 'unsafe_species_weights',
        severity: 'error',
        rarity: r.rarity,
        message: `The Buddy bonus leaves the ${r.rarity} weights unrollable; a hunt reaching ${r.rarity} would fail.`,
      });
      continue;
    }
    if (r.tier !== 'region' && r.p > 0) {
      issues.push({
        code: 'rarity_falls_back',
        severity: 'warning',
        rarity: r.rarity,
        message:
          r.tier === 'default_region'
            ? `No eligible ${r.rarity} species in this pool: ${r.rarity} draws come from the default region's pool.`
            : `No eligible ${r.rarity} species in this pool${isDefault ? '' : " or the default region's"}: ` +
              `${r.rarity} draws come from every non-exclusive ${r.rarity} species.`,
      });
    }
    const total = r.bucket.reduce((s, b) => s + b.effective, 0);
    for (const b of r.bucket) {
      const s = input.species.get(b.slug)!;
      const share = b.effective / total;
      const perEncounter = probability * share;
      species.push({
        slug: s.slug,
        name: s.name,
        rarity: s.rarity,
        tier: r.tier,
        inPool: r.tier === 'region' || pooled.has(s.slug),
        weight: b.weight,
        effectiveWeight: b.effective,
        shareOfRarity: share,
        perEncounter,
        perHunt: perEncounterScale === null ? null : perEncounter * perEncounterScale,
      });
    }
  }

  let fallback: ExhaustedFallback = 'nothing';
  if (defaultPool.some((m) => {
    const s = input.species.get(m.species);
    return s !== undefined && poolEligible(s);
  })) fallback = 'default_pool_arbitrary';
  else if ([...input.species.values()].some(openEligible)) fallback = 'open_species_arbitrary';
  else if ([...input.species.values()].some(poolEligible)) fallback = 'emergency_region_exclusive';
  if (exhaustedP > 0) {
    issues.push({
      code: 'rerolls_exhausted',
      severity: 'warning',
      message:
        `${(exhaustedP * 100).toPrecision(3)}% of encounter draws exhaust all ${HUNT_RARITY_ATTEMPTS} rarity ` +
        `attempts and take ${fallback === 'nothing' ? 'no species at all' : 'one arbitrary species'} (${fallback}).`,
    });
  }

  const share = hunting ? (encounterShare ?? 0) : 1;
  return {
    mode: input.mode,
    level: input.level,
    encounterShare,
    rarities: resolved.map((r) => ({
      rarity: r.rarity,
      baseWeight: r.baseWeight,
      effectiveWeight: r.weight,
      rollProbability: r.p,
      probability: r.tier === 'dead' ? 0 : r.p * reach,
      tier: r.tier,
      candidates: r.bucket.length,
      unsafe: r.unsafe,
    })),
    species: species.sort((a, b) => b.perEncounter - a.perEncounter || a.slug.localeCompare(b.slug)),
    excluded,
    exhausted: { probability: exhaustedP, fallback },
    errorProbability: resultError + errorMass * share,
    issues,
  };
}

function describeFiltered(input: DistributionInput): DistributionResult {
  const issues: DistributionIssue[] = [];
  const filter: SpeciesFilter = input.filter ?? { poolScope: 'region' };
  if (input.buddyBonus) {
    issues.push({
      code: 'buddy_ignored',
      severity: 'info',
      message: 'Filtered selectors never apply a Buddy Bonus; the Buddy scenario was ignored.',
    });
  }
  // The hunt's level-adjusted table with no Buddy — `spawnRarityWeights`.
  const tableWeights = huntRarityWeights(input.tables, input.level, null);
  const rarityWeights = new Map(tableWeights.map((r) => [r.rarity, r.weight]));

  // Scope: the region pool at pool weight, or (global) every open species plus
  // the region pool, all at `per_species_weight`. No default-region tier.
  const scoped: Array<{ s: DistributionSpecies; weight: number; inPool: boolean }> = [];
  const pooled = new Set<string>();
  for (const m of input.pool) {
    const s = input.species.get(m.species);
    if (s && poolEligible(s)) {
      pooled.add(s.slug);
      if (filter.poolScope === 'region') scoped.push({ s, weight: m.weight, inPool: true });
    }
  }
  if (filter.poolScope === 'global') {
    for (const s of input.species.values()) {
      if (openEligible(s) || pooled.has(s.slug)) scoped.push({ s, weight: s.perSpeciesWeight, inPool: pooled.has(s.slug) });
    }
  }
  const candidates = scoped.filter(({ s }) =>
    matchesSpeciesFilter({ rarity: s.rarity, affinity: s.affinity, race: s.race }, filter),
  );
  const excluded = poolMembersExcluded(input, new Map([...rarityWeights.keys()].map((k) => [k, 1])))
    .filter((e) => e.reason !== 'rarity_not_hunted' && e.reason !== 'rarity_never_rolled');
  for (const m of input.pool) {
    if (pooled.has(m.species) && !candidates.some((c) => c.s.slug === m.species)) {
      excluded.push({ slug: m.species, reason: 'filtered_out' });
    }
  }
  if (candidates.length === 0) {
    issues.push({
      code: 'no_matching_species',
      severity: 'warning',
      message: 'No species matches this selector here; resolving it produces no sighting.',
    });
    return {
      mode: input.mode,
      level: input.level,
      encounterShare: null,
      rarities: [],
      species: [],
      excluded,
      exhausted: null,
      errorProbability: 0,
      issues,
    };
  }

  // `pickFilteredCandidate`: buckets of present rarities at `max(1, weight)`;
  // the table conditioned on those rarities, or uniform when none has weight.
  const buckets = new Map<string, Array<{ s: DistributionSpecies; weight: number; inPool: boolean }>>();
  for (const c of candidates) {
    const bucket = buckets.get(c.s.rarity) ?? [];
    bucket.push({ ...c, weight: Math.max(1, c.weight) });
    buckets.set(c.s.rarity, bucket);
  }
  const present = [...buckets.keys()].map((rarity) => ({ rarity, weight: Math.max(0, rarityWeights.get(rarity) ?? 0) }));
  const total = present.reduce((s, r) => s + r.weight, 0);
  const rarities: RarityOdds[] = present.map((r) => {
    const p = total > 0 ? r.weight / total : 1 / present.length;
    return {
      rarity: r.rarity,
      baseWeight: tableWeights.find((t) => t.rarity === r.rarity)?.baseWeight ?? 0,
      effectiveWeight: r.weight,
      rollProbability: p,
      probability: p,
      tier: 'filtered',
      candidates: buckets.get(r.rarity)!.length,
      unsafe: false,
    };
  });
  const species: SpeciesOdds[] = [];
  for (const r of rarities) {
    const bucket = buckets.get(r.rarity)!;
    const bucketTotal = bucket.reduce((s, b) => s + b.weight, 0);
    for (const b of bucket) {
      const share = b.weight / bucketTotal;
      species.push({
        slug: b.s.slug,
        name: b.s.name,
        rarity: b.s.rarity,
        tier: 'filtered',
        inPool: b.inPool,
        weight: b.weight,
        effectiveWeight: b.weight,
        shareOfRarity: share,
        perEncounter: r.probability * share,
        perHunt: null,
      });
    }
  }
  return {
    mode: input.mode,
    level: input.level,
    encounterShare: null,
    rarities,
    species: species.sort((a, b) => b.perEncounter - a.perEncounter || a.slug.localeCompare(b.slug)),
    excluded,
    exhausted: null,
    errorProbability: 0,
    issues,
  };
}

/** Per-species and per-rarity change between two analyses of the same mode. */
export interface DistributionDiff {
  species: Array<{ slug: string; before: number; after: number; delta: number }>;
  rarities: Array<{ rarity: string; tierBefore: ResolvingTier | null; tierAfter: ResolvingTier | null }>;
}

export function diffDistributions(before: DistributionResult, after: DistributionResult): DistributionDiff {
  const b = new Map(before.species.map((s) => [s.slug, s.perEncounter]));
  const a = new Map(after.species.map((s) => [s.slug, s.perEncounter]));
  const slugs = [...new Set([...b.keys(), ...a.keys()])].sort();
  const species = slugs
    .map((slug) => {
      const x = b.get(slug) ?? 0;
      const y = a.get(slug) ?? 0;
      return { slug, before: x, after: y, delta: y - x };
    })
    .filter((d) => Math.abs(d.delta) > 1e-15);
  const tb = new Map(before.rarities.map((r) => [r.rarity, r.tier]));
  const ta = new Map(after.rarities.map((r) => [r.rarity, r.tier]));
  const rarities = [...new Set([...tb.keys(), ...ta.keys()])]
    .map((rarity) => ({ rarity, tierBefore: tb.get(rarity) ?? null, tierAfter: ta.get(rarity) ?? null }))
    .filter((r) => r.tierBefore !== r.tierAfter);
  return { species, rarities };
}
