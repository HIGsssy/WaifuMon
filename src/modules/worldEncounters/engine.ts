/**
 * Selection engine — pool → filter → weighted draw.
 *
 * Discord-independent: this module never touches an interaction, an embed, or
 * a message. It answers "given player + source + region (+ route), which
 * definition fires and what is the resolution scaffolding?" and lets the
 * calling layer render the result.
 *
 * The rarity/weight interaction is deliberately simple: each active
 * definition contributes `rarityMultiplier[rarity] * weight` to the pool.
 * Rarity multipliers live here, not in content, so tuning them is a code
 * decision (they carry the whole feature's economy — an admin retitle should
 * not accidentally quadruple mythic frequency).
 */
import { rollWeighted, type Rng, type WeightedEntry } from '../../shared/random';
import type { LoadedEncounter } from './types';
import type {
  EncounterWithChildren,
  WorldEncounterRepository,
} from './worldEncounterRepository';
import { hydrateEncounter } from './hydrate';

/**
 * Weight multipliers by rarity. Common encounters are the bread and butter;
 * mythic is the "once in a while, unforgettable" slot. The absolute values
 * matter only relative to each other and to per-encounter `weight`.
 */
const RARITY_MULTIPLIERS: Record<string, number> = {
  common: 100,
  uncommon: 40,
  rare: 10,
  mythic: 2,
};

export interface SelectContext {
  playerId: number;
  playerLevel: number;
  source: 'hunt' | 'travel';
  regionId: string;
  /** Travel-only: where the trip started. Ignored for hunt. */
  fromRegion?: string | null;
  /** Travel-only: intended destination. Ignored for hunt. */
  toRegion?: string | null;
  /** Encounter ids the player is currently on cooldown for. */
  cooldownIds: Set<number>;
  /**
   * Optional pre-loaded pool — the engine's tests pass this directly to
   * exercise selection without needing a live DB. When omitted the engine
   * queries the repository.
   */
  candidates?: EncounterWithChildren[];
}

/** Region + route filter applied on a single candidate. */
export function matchesRegion(row: EncounterWithChildren, regionId: string): boolean {
  if (row.regions.length === 0) return true; // empty = global
  return row.regions.some((r) => r.regionId === regionId);
}

export function matchesRoute(
  row: EncounterWithChildren,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (row.routes.length === 0) return true; // no route restriction = every edge
  if (from == null || to == null) return false; // route-restricted, but no route offered
  return row.routes.some((r) => r.fromRegion === from && r.toRegion === to);
}

/** Effective selection weight for one row, after rarity multiplier. */
export function effectiveWeight(row: EncounterWithChildren): number {
  const mult = RARITY_MULTIPLIERS[row.encounter.rarity] ?? 1;
  return mult * row.encounter.weight;
}

/**
 * Why a selection produced nothing. Reported, never acted on — the filters
 * below decide the outcome and this only names it, so an operator watching a
 * staging server can tell "the dice said no" apart from "every candidate is
 * on cooldown", which look identical from the outside.
 *
 * Ordered from the widest gate to the narrowest, and reported as the *first*
 * stage that emptied the pool.
 */
export type SelectionReason =
  | 'selected'
  /** The source/lifecycle query itself came back empty. */
  | 'no_eligible_definitions'
  /** Candidates existed, but the player is on cooldown for all of them. */
  | 'all_on_cooldown'
  /** Survived cooldown, but none is scoped to this region. */
  | 'no_region_match'
  /** Survived region, but none covers this travel edge. */
  | 'no_route_match'
  /** Survived every filter, but every survivor had a non-positive weight. */
  | 'no_positive_weight';

/**
 * A selection, plus the stage-by-stage counts behind it.
 *
 * The counts are the observable half of the roll: `forceTrigger` and a chance
 * of 1 both stop at the dice, so when an operator turns them on and still sees
 * no encounter, the answer is always somewhere in these numbers.
 */
export interface SelectionOutcome {
  encounter: LoadedEncounter | null;
  reason: SelectionReason;
  /** Rows the source/lifecycle query returned, before any filtering. */
  candidateCountBeforeCooldown: number;
  /** Survivors of the cooldown filter. */
  candidateCountAfterCooldown: number;
  /** Survivors of region scoping. */
  candidateCountAfterRegion: number;
  /** Survivors of route scoping — the pool the weighted draw ran on. */
  candidateCountAfterRoute: number;
}

/**
 * Filter the pool, apply the weighted draw, and report both the result and
 * the counts at each stage.
 *
 * The filters run in the order they are reported so the counts mean what they
 * say: each number is the size of the pool entering the next gate.
 */
export async function selectEncounterDetailed(
  repo: WorldEncounterRepository,
  rng: Rng,
  ctx: SelectContext,
): Promise<SelectionOutcome> {
  const candidates =
    ctx.candidates ??
    (await repo.listSelectable({
      source: ctx.source,
      regionId: ctx.regionId,
      fromRegion: ctx.fromRegion ?? null,
      toRegion: ctx.toRegion ?? null,
    }));

  const afterCooldown = candidates.filter((row) => !ctx.cooldownIds.has(row.encounter.id));
  const afterRegion = afterCooldown.filter((row) => matchesRegion(row, ctx.regionId));
  const afterRoute =
    ctx.source === 'travel'
      ? afterRegion.filter((row) => matchesRoute(row, ctx.fromRegion, ctx.toRegion))
      : afterRegion;

  // Player-level gates live on individual choices, not the encounter itself —
  // so an encounter with only high-level choices still surfaces to a low-level
  // player and the choices filter themselves.
  const pool: WeightedEntry<EncounterWithChildren>[] = [];
  for (const row of afterRoute) {
    const weight = effectiveWeight(row);
    if (weight <= 0) continue;
    pool.push({ weight, value: row });
  }

  const counts = {
    candidateCountBeforeCooldown: candidates.length,
    candidateCountAfterCooldown: afterCooldown.length,
    candidateCountAfterRegion: afterRegion.length,
    candidateCountAfterRoute: afterRoute.length,
  };

  if (pool.length === 0) {
    // The first gate that emptied the pool is the one worth naming.
    const reason: SelectionReason =
      candidates.length === 0
        ? 'no_eligible_definitions'
        : afterCooldown.length === 0
          ? 'all_on_cooldown'
          : afterRegion.length === 0
            ? 'no_region_match'
            : afterRoute.length === 0
              ? 'no_route_match'
              : 'no_positive_weight';
    return { encounter: null, reason, ...counts };
  }

  const chosen = rollWeighted(pool, rng);
  return { encounter: hydrateEncounter(chosen), reason: 'selected', ...counts };
}

/**
 * Filter the pool, apply the weighted draw, and hand back a loaded encounter
 * ready for the resolution phase. Returns null when the pool is empty
 * post-filter — the caller falls back to the standard hunt/travel behaviour.
 *
 * The counts-free form, for callers that only want the answer.
 */
export async function selectEncounter(
  repo: WorldEncounterRepository,
  rng: Rng,
  ctx: SelectContext,
): Promise<LoadedEncounter | null> {
  return (await selectEncounterDetailed(repo, rng, ctx)).encounter;
}
