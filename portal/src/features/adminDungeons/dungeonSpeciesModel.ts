/** Spread-only edits preserve identities, encounter references and unrelated content. */
import type {
  DungeonDefinition,
  DungeonSpeciesPolicyEntry,
  DungeonSpeciesPool,
  DungeonSpeciesPoolEntry,
  DungeonSpeciesRef,
  DungeonIssue,
} from '@/api/adminDungeons';
import type { DungeonSpeciesUnavailableReason } from '@/api/dungeonSpeciesTypes';
export const SPECIES_POOL_LIMITS = { pools: 30, entries: 50, weight: 1_000_000 };
const poolsOf = (d: DungeonDefinition) => d.speciesPools ?? [];
function id(prefix: 'sp' | 'se', taken: string[]) {
  for (;;) {
    const next = `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
    if (!taken.includes(next)) return next;
  }
}
function name(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`,
      next = base.slice(0, 80 - suffix.length) + suffix;
    if (!taken.includes(next)) return next;
  }
}
function withPools(d: DungeonDefinition, pools: DungeonSpeciesPool[]): DungeonDefinition {
  if (pools.length) return { ...d, speciesPools: pools };
  const { speciesPools: _none, ...rest } = d;
  return rest;
}
export function newSpeciesEntry(
  pool: DungeonSpeciesPool,
  species: string | null,
): DungeonSpeciesPoolEntry {
  const entryId = id(
    'se',
    pool.entries.map((e) => e.id),
  );
  return species === null
    ? { id: entryId, weight: 1, nothing: true }
    : { id: entryId, weight: 1, species, oncePerRun: true };
}
export function createSpeciesPool(d: DungeonDefinition) {
  if (poolsOf(d).length >= SPECIES_POOL_LIMITS.pools) return { id: null, definition: d };
  const pool: DungeonSpeciesPool = {
    id: id(
      'sp',
      poolsOf(d).map((p) => p.id),
    ),
    name: name(
      'New WaifuMon pool',
      poolsOf(d).map((p) => p.name),
    ),
    entries: [],
  };
  return { id: pool.id, definition: withPools(d, [...poolsOf(d), pool]) };
}
export function updateSpeciesPool(
  d: DungeonDefinition,
  poolId: string,
  change: (p: DungeonSpeciesPool) => DungeonSpeciesPool,
) {
  return withPools(
    d,
    poolsOf(d).map((p) => (p.id === poolId ? { ...change(p), id: p.id } : p)),
  );
}
export function speciesPoolUsage(d: DungeonDefinition, poolId: string) {
  return d.rooms.flatMap((r) =>
    r.actions.flatMap((a, n) =>
      (a.type === 'wild_encounter' || a.type === 'rescue') &&
      a.source?.kind === 'pool' &&
      a.source.poolId === poolId
        ? [
            {
              roomId: r.id,
              actionId: a.id,
              name: `${r.name || 'Unnamed room'} — ${a.label || (a.type === 'rescue' ? 'Rescue' : 'Wild Encounter')} (activity ${n + 1})`,
            },
          ]
        : [],
    ),
  );
}
export function deleteSpeciesPool(d: DungeonDefinition, poolId: string) {
  return speciesPoolUsage(d, poolId).length
    ? d
    : withPools(
        d,
        poolsOf(d).filter((p) => p.id !== poolId),
      );
}
export function duplicateSpeciesPool(d: DungeonDefinition, poolId: string) {
  const pools = poolsOf(d),
    index = pools.findIndex((p) => p.id === poolId);
  if (index < 0 || pools.length >= SPECIES_POOL_LIMITS.pools) return { id: null, definition: d };
  const copy = {
    ...structuredClone(pools[index]!),
    id: id(
      'sp',
      pools.map((p) => p.id),
    ),
    name: name(
      pools[index]!.name.slice(0, 73) + ' (copy)',
      pools.map((p) => p.name),
    ),
  };
  return {
    id: copy.id,
    definition: withPools(d, [...pools.slice(0, index + 1), copy, ...pools.slice(index + 1)]),
  };
}
export function incompleteSpeciesIssues(d: DungeonDefinition, code: string): DungeonIssue[] {
  const issues: DungeonIssue[] = [];
  const add = (path: string, message: string) =>
    issues.push({ code, severity: 'error', path, message });
  poolsOf(d).forEach((p, n) => {
    const path = `speciesPools[${n}]`;
    if (!p.name.trim()) add(`${path}.name`, 'Give this WaifuMon pool a name.');
    if (!p.entries.length)
      add(`${path}.entries`, 'Add at least one species entry to finish this pool.');
    p.entries.forEach((e, i) => {
      if ('species' in e && !e.species)
        add(`${path}.entries[${i}].species`, 'Choose a species or remove this entry.');
      if (!Number.isInteger(e.weight) || e.weight < 1 || e.weight > SPECIES_POOL_LIMITS.weight)
        add(`${path}.entries[${i}].weight`, 'Weight must be a whole number from 1 to 1,000,000.');
    });
  });
  return issues;
}

// ── Species access: the dungeon's own terms, one entry per species ──────────

export const DEFAULT_SPECIES_LIMIT = 1;
const policiesOf = (d: DungeonDefinition) => d.speciesPolicies ?? [];
export function speciesPolicyOf(d: DungeonDefinition, slug: string) {
  return policiesOf(d).find((p) => p.species === slug);
}
export function setSpeciesPolicy(d: DungeonDefinition, entry: DungeonSpeciesPolicyEntry): DungeonDefinition {
  const list = policiesOf(d);
  const next: DungeonSpeciesPolicyEntry = { species: entry.species, perPlayerLimit: entry.perPlayerLimit };
  if (entry.directRescue) next.directRescue = true;
  return {
    ...d,
    speciesPolicies: list.some((p) => p.species === entry.species)
      ? list.map((p) => (p.species === entry.species ? next : p))
      : [...list, next],
  };
}
export function removeSpeciesPolicy(d: DungeonDefinition, slug: string): DungeonDefinition {
  const rest = policiesOf(d).filter((p) => p.species !== slug);
  if (rest.length) return { ...d, speciesPolicies: rest };
  const { speciesPolicies: _none, ...without } = d;
  return without;
}
/** Every species a pool entry or a specific-species encounter names, in first-seen order. */
export function dungeonSpeciesSlugs(d: DungeonDefinition): string[] {
  const slugs = new Set<string>();
  for (const p of poolsOf(d)) for (const e of p.entries) if ('species' in e && e.species) slugs.add(e.species);
  for (const r of d.rooms)
    for (const a of r.actions)
      if ((a.type === 'wild_encounter' || a.type === 'rescue') && a.source?.kind === 'species' && a.source.species)
        slugs.add(a.source.species);
  return [...slugs];
}
/** Species a Direct Rescue can grant, directly or through its pool. */
export function directRescueSlugs(d: DungeonDefinition): Set<string> {
  const slugs = new Set<string>();
  for (const r of d.rooms)
    for (const a of r.actions) {
      if (a.type !== 'rescue' || a.mode !== 'direct' || !a.source) continue;
      if (a.source.kind === 'species') slugs.add(a.source.species);
      else if (a.source.kind === 'pool') {
        const poolId = a.source.poolId;
        poolsOf(d).find((p) => p.id === poolId)?.entries.forEach((e) => 'species' in e && slugs.add(e.species));
      }
    }
  return slugs;
}
export interface SpeciesAccessView {
  permitted: boolean;
  reason: DungeonSpeciesUnavailableReason | null;
  /** Combined terms; null when neither species content nor this dungeon sets any. */
  limit: number | 'unlimited' | null;
  directRescue: { available: boolean; reason: DungeonSpeciesUnavailableReason | null };
  source: 'content' | 'dungeon' | 'both' | null;
}
/**
 * Display only: how this dungeon would judge her with the draft's entry. With
 * no entry it is the server's own content-only verdict, unchanged. With one it
 * mirrors the backend rule: the entry admits a species the dungeon may admit,
 * and the stricter of content and dungeon terms applies. Validation is
 * authoritative; this only lets the editor show unsaved Species access.
 */
export function speciesAccessView(
  ref: DungeonSpeciesRef,
  dungeonKey: string,
  entry: DungeonSpeciesPolicyEntry | undefined,
): SpeciesAccessView {
  const content = ref.dungeonAccess.find((a) => a.dungeon === dungeonKey);
  if (!entry)
    return {
      permitted: ref.permitted,
      reason: ref.unavailableReason,
      limit: ref.perPlayerLimit,
      directRescue: ref.directRescue,
      source: content ? 'content' : null,
    };
  const reason: DungeonSpeciesUnavailableReason | null =
    ref.permitted || (ref.unavailableReason === 'not_permitted' && ref.dungeonPolicyAllowed)
      ? null
      : ref.unavailableReason;
  const limits = [content ? (content.perPlayerLimit ?? 'unlimited') : entry.perPlayerLimit, entry.perPlayerLimit];
  const finite = limits.filter((l): l is number => typeof l === 'number');
  const limit = finite.length ? Math.min(...finite) : 'unlimited';
  const direct = content ? !!content.directRescue && !!entry.directRescue : !!entry.directRescue;
  const directReason: DungeonSpeciesUnavailableReason | null =
    reason ?? (!direct ? 'direct_not_permitted' : typeof limit !== 'number' ? 'direct_limit_missing' : null);
  return {
    permitted: reason === null,
    reason,
    limit,
    directRescue: { available: directReason === null, reason: directReason },
    source: content ? 'both' : 'dungeon',
  };
}
/** Whether the picker may offer her: allowed now, or admissible by adding this dungeon's own entry. */
export function speciesSelectable(ref: DungeonSpeciesRef, dungeonKey: string, entry: DungeonSpeciesPolicyEntry | undefined) {
  return speciesAccessView(ref, dungeonKey, entry).permitted || ref.dungeonPolicyAllowed;
}
export function describeLimit(limit: number | 'unlimited' | null): string {
  return limit === null || limit === 'unlimited'
    ? 'Unlimited captures'
    : `At most ${limit} per player from this dungeon`;
}
