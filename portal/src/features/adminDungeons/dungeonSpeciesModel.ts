/** Spread-only edits preserve identities, encounter references and unrelated content. */
import type {
  DungeonDefinition,
  DungeonSpeciesPool,
  DungeonSpeciesPoolEntry,
  DungeonIssue,
} from '@/api/adminDungeons';
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
