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
 * Filter the pool, apply the weighted draw, and hand back a loaded encounter
 * ready for the resolution phase. Returns null when the pool is empty
 * post-filter — the caller falls back to the standard hunt/travel behaviour.
 */
export async function selectEncounter(
  repo: WorldEncounterRepository,
  rng: Rng,
  ctx: SelectContext,
): Promise<LoadedEncounter | null> {
  const candidates =
    ctx.candidates ??
    (await repo.listSelectable({
      source: ctx.source,
      regionId: ctx.regionId,
      fromRegion: ctx.fromRegion ?? null,
      toRegion: ctx.toRegion ?? null,
    }));

  const pool: WeightedEntry<EncounterWithChildren>[] = [];
  for (const row of candidates) {
    if (ctx.cooldownIds.has(row.encounter.id)) continue;
    if (!matchesRegion(row, ctx.regionId)) continue;
    if (ctx.source === 'travel' && !matchesRoute(row, ctx.fromRegion, ctx.toRegion)) continue;
    // Player-level gate lives on individual choices, not the encounter itself
    // — so an encounter with only high-level choices still surfaces to a
    // low-level player and the choices filter themselves.
    const weight = effectiveWeight(row);
    if (weight <= 0) continue;
    pool.push({ weight, value: row });
  }

  if (pool.length === 0) return null;

  const chosen = rollWeighted(pool, rng);
  return hydrateEncounter(chosen);
}
