/**
 * Species selection for scripted wild spawns — "which Waifumon appears".
 *
 * A scripted spawn can name its species three ways:
 *
 *   1. **specific** — one slug, looked up directly by the spawner;
 *   2. **legacy random** — no selector at all, which hands the pick to the
 *      hunt's own region/rarity draw *with its fallbacks* (Waifu Valley, then
 *      the global table). Unchanged by this module;
 *   3. **random with a selector** — this module. An authored pool scope plus
 *      optional rarity / race / affinity filters, resolved **strictly**.
 *
 * ## Filter semantics
 *
 * Values inside one dimension are OR; dimensions are AND. An omitted
 * dimension does not constrain. So `rarities: ['UR','LR'], races: ['demon']`
 * means "(UR or LR) and demon".
 *
 * ## Strictness
 *
 * The one guarantee a selector makes is the species set. Nothing here rolls an
 * unrestricted rarity first, widens the pool, drops a filter, or falls back to
 * another region: a selector that matches nobody returns `no_matching_species`
 * and the caller spawns nothing. `rarities: ['LR']` can therefore only ever
 * produce an LR species.
 *
 * ## Weighting
 *
 * A filtered pick is the hunt's draw **conditioned on the filter**, reusing the
 * weights that already exist rather than adding a new system:
 *
 *   - rarity: the hunt's level-adjusted rarity table (no Buddy Bonus),
 *     restricted to the rarities that actually have a candidate, renormalised.
 *     `['UR','LR']` therefore keeps the table's UR:LR ratio. If every eligible
 *     rarity has zero table weight (e.g. a rarity the table never rolls), the
 *     eligible rarities are weighted equally — a matching candidate is never
 *     refused on weighting grounds;
 *   - species within that rarity: the region pool's region-local weight for
 *     `region` scope, `species.per_species_weight` for `global` scope — the
 *     same weights the hunt uses at those tiers.
 *
 * For a single-rarity selector (the LR Trail case) this reduces to a
 * pool-weighted pick among that rarity's candidates.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import {
  AFFINITIES,
  RARITIES,
  regionEncounterPools,
  species,
  type Rarity,
  type SpeciesRow,
} from '../../db/schema';
import { RACE_CODES, resolveRace, type RaceCode } from '../cards/race';
import { isRegion, REGION_EXCLUSIVE_TAG_JSON, type Region } from '../locations/regions';
import { defaultRng, rollWeighted, type Rng, type WeightedEntry } from '../../shared/random';

/* ─────────────────────── Schema ─────────────────────── */

export const SPECIES_POOL_SCOPES = ['region', 'global'] as const;
export type SpeciesPoolScope = (typeof SPECIES_POOL_SCOPES)[number];

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'slug must be lowercase snake_case');

/**
 * One filter dimension. Empty lists are refused rather than read as "no
 * constraint": an author who wrote `rarities: []` meant something, and the two
 * plausible readings (match nothing / match everything) disagree. Omit the
 * field to leave the dimension open.
 */
function filterValues<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .array(z.enum(values))
    .min(1, 'omit the filter instead of passing an empty list')
    .refine((list) => new Set(list).size === list.length, 'filter values must not repeat');
}

/** `{ mode: 'specific', speciesSlug }` — exactly one species. */
export const SpecificSpeciesSelectionSchema = z
  .object({ mode: z.literal('specific'), speciesSlug: slug })
  .strict();

/**
 * `{ mode: 'random', poolScope, rarities?, races?, affinities? }`.
 *
 * `poolScope` defaults to `region`, the scope an author almost always means.
 * Strict, so a misspelled filter (`rarity` for `rarities`) is an error rather
 * than a silently unfiltered sighting.
 */
export const RandomSpeciesSelectionSchema = z
  .object({
    mode: z.literal('random'),
    poolScope: z.enum(SPECIES_POOL_SCOPES).default('region'),
    rarities: filterValues(RARITIES).optional(),
    races: filterValues(RACE_CODES).optional(),
    affinities: filterValues(AFFINITIES).optional(),
  })
  .strict();

export const SpeciesSelectionSchema = z.discriminatedUnion('mode', [
  SpecificSpeciesSelectionSchema,
  RandomSpeciesSelectionSchema,
]);

export type SpecificSpeciesSelection = z.infer<typeof SpecificSpeciesSelectionSchema>;
export type RandomSpeciesSelection = z.infer<typeof RandomSpeciesSelectionSchema>;
export type SpeciesSelection = z.infer<typeof SpeciesSelectionSchema>;

/** The part of a random selector the picker reads. */
export type SpeciesFilter = Pick<
  RandomSpeciesSelection,
  'poolScope' | 'rarities' | 'races' | 'affinities'
>;

/* ─────────────────────── Pure core ─────────────────────── */

/** The facts a filter is evaluated against. */
export interface SpeciesFilterSubject {
  rarity: string;
  affinity: string;
  race: string;
}

/** OR within a dimension, AND across dimensions, omitted = unconstrained. */
export function matchesSpeciesFilter(subject: SpeciesFilterSubject, filter: SpeciesFilter): boolean {
  if (filter.rarities && !(filter.rarities as readonly string[]).includes(subject.rarity)) {
    return false;
  }
  if (filter.races && !(filter.races as readonly string[]).includes(subject.race)) return false;
  if (filter.affinities && !(filter.affinities as readonly string[]).includes(subject.affinity)) {
    return false;
  }
  return true;
}

/** One already-filtered candidate. */
export interface SpeciesCandidate<T> {
  value: T;
  rarity: string;
  /** Within-rarity weight (pool weight or per-species weight). */
  weight: number;
}

/**
 * Pick one of `candidates`: rarity first (by `rarityWeights`, restricted to
 * the rarities present), then a species within it. Returns null only for an
 * empty candidate list — never picks anything outside it.
 */
export function pickFilteredCandidate<T>(
  candidates: readonly SpeciesCandidate<T>[],
  rarityWeights: ReadonlyMap<string, number>,
  rng: Rng,
): T | null {
  if (candidates.length === 0) return null;

  const buckets = new Map<string, Array<WeightedEntry<T>>>();
  for (const c of candidates) {
    const bucket = buckets.get(c.rarity) ?? [];
    bucket.push({ weight: Math.max(1, c.weight), value: c.value });
    buckets.set(c.rarity, bucket);
  }

  const rarityEntries = [...buckets.keys()].map((rarity) => ({
    weight: Math.max(0, rarityWeights.get(rarity) ?? 0),
    value: rarity,
  }));
  const total = rarityEntries.reduce((sum, e) => sum + e.weight, 0);
  const rarity = rollWeighted(
    total > 0 ? rarityEntries : rarityEntries.map((e) => ({ weight: 1, value: e.value })),
    rng,
  );
  return rollWeighted(buckets.get(rarity)!, rng);
}

/* ─────────────────────── Database picker ─────────────────────── */

export type FilteredSpeciesPick =
  | {
      status: 'selected';
      species: SpeciesRow;
      /** Candidates left after scope + filters. */
      candidateCount: number;
      /** Those candidates themselves — what an authoring preview lists. */
      candidates: SpeciesRow[];
      /** Candidates in scope before filters. */
      poolSize: number;
    }
  | {
      status: 'no_matching_species';
      candidateCount: 0;
      poolSize: number;
      /** The region the scope resolved against; null when none was usable. */
      regionId: Region | null;
    };

export interface FilteredSpeciesPickContext {
  /** The region the spawn happens in. Region scope with no valid region matches nothing. */
  regionId: string | null;
  playerLevel: number;
}

export type FilteredSpeciesPicker = (
  tx: DbOrTx,
  filter: SpeciesFilter,
  ctx: FilteredSpeciesPickContext,
) => Promise<FilteredSpeciesPick>;

export interface FilteredSpeciesPickerDeps {
  /** Race lives in content, not in the `species` table. */
  resolveRace: (row: SpeciesRow) => RaceCode;
  /**
   * The hunt's level-adjusted rarity table (no Buddy Bonus). Absent, every
   * eligible rarity weighs the same.
   */
  rarityWeightsFor?: ((playerLevel: number) => readonly WeightedEntry<Rarity>[]) | undefined;
  rng?: Rng | undefined;
}

/**
 * Builds the picker the spawner calls for a `selection`.
 *
 * Scope:
 *   - `region`: enabled species in that region's `region_encounter_pools`,
 *     at the pool's region-local weight. Nothing else — no Waifu Valley, no
 *     global table.
 *   - `global`: every enabled species not tagged `region_exclusive`, plus the
 *     current region's pool (so a region-exclusive local is still reachable
 *     where she lives). Global is therefore always a superset of region.
 */
export function createFilteredSpeciesPicker(deps: FilteredSpeciesPickerDeps): FilteredSpeciesPicker {
  const rng = deps.rng ?? defaultRng();

  async function regionPool(tx: DbOrTx, regionId: Region): Promise<SpeciesCandidate<SpeciesRow>[]> {
    const rows = await tx
      .select({ species, weight: regionEncounterPools.weight })
      .from(regionEncounterPools)
      .innerJoin(species, eq(regionEncounterPools.speciesId, species.id))
      .where(and(eq(regionEncounterPools.regionId, regionId), eq(species.enabled, true)));
    return rows.map((r) => ({ value: r.species, rarity: r.species.rarity, weight: r.weight }));
  }

  async function globalPool(
    tx: DbOrTx,
    regionId: Region | null,
  ): Promise<SpeciesCandidate<SpeciesRow>[]> {
    const open = await tx
      .select()
      .from(species)
      .where(
        and(
          eq(species.enabled, true),
          sql`not (${species.tags} @> ${REGION_EXCLUSIVE_TAG_JSON}::jsonb)`,
        ),
      );
    const byId = new Map<number, SpeciesRow>(open.map((s) => [s.id, s]));
    if (regionId) {
      for (const pooled of await regionPool(tx, regionId)) byId.set(pooled.value.id, pooled.value);
    }
    return [...byId.values()].map((s) => ({
      value: s,
      rarity: s.rarity,
      weight: s.perSpeciesWeight,
    }));
  }

  return async function pickFilteredSpecies(tx, filter, ctx) {
    const regionId = isRegion(ctx.regionId) ? ctx.regionId : null;
    let pool: SpeciesCandidate<SpeciesRow>[];
    if (filter.poolScope === 'global') pool = await globalPool(tx, regionId);
    else pool = regionId ? await regionPool(tx, regionId) : [];

    const candidates = pool.filter((c) =>
      matchesSpeciesFilter(
        { rarity: c.value.rarity, affinity: c.value.affinity, race: deps.resolveRace(c.value) },
        filter,
      ),
    );
    const rarityWeights = new Map<string, number>(
      (deps.rarityWeightsFor?.(ctx.playerLevel) ?? []).map((e) => [e.value, e.weight]),
    );
    const picked = pickFilteredCandidate(candidates, rarityWeights, rng);
    if (!picked) {
      return { status: 'no_matching_species', candidateCount: 0, poolSize: pool.length, regionId };
    }
    return {
      status: 'selected',
      species: picked,
      candidateCount: candidates.length,
      candidates: candidates.map((c) => c.value),
      poolSize: pool.length,
    };
  };
}

/**
 * The picker bound to a database handle, for callers that are not already in
 * a transaction — Portal selector previews and the admin simulator. Reads
 * only: nothing here writes, spends or spawns.
 */
export interface SpeciesSelectorService {
  /** Exactly the runtime's filtered pick, candidates included. */
  pick(filter: SpeciesFilter, ctx: FilteredSpeciesPickContext): Promise<FilteredSpeciesPick>;
  /** An enabled species by slug — what a `specific` selector resolves to. */
  findEnabledSpecies(slug: string): Promise<SpeciesRow | null>;
}

export function createSpeciesSelectorService(
  db: DbOrTx,
  picker: FilteredSpeciesPicker,
): SpeciesSelectorService {
  return {
    pick: (filter, ctx) => picker(db, filter, ctx),
    async findEnabledSpecies(slug) {
      const [row] = await db
        .select()
        .from(species)
        .where(and(eq(species.slug, slug), eq(species.enabled, true)));
      return row ?? null;
    },
  };
}

/**
 * Race resolver backed by a content snapshot: authored `race`, then the
 * archetype bridge, then the default — the order the card renderer and Buddy
 * Bonus targeting already use. Un-memoised for the same reason
 * `buddyBonusService` is: a reload swaps the snapshot underneath it.
 */
export function raceResolverFromContent(
  getContent: () => { species: ReadonlyArray<{ slug: string; race?: RaceCode | undefined }> },
): (row: SpeciesRow) => RaceCode {
  return (row) =>
    resolveRace({
      slug: row.slug,
      race: getContent().species.find((s) => s.slug === row.slug)?.race ?? null,
      archetype: row.archetype,
    });
}
