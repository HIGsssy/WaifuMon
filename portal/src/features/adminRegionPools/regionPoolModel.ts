/**
 * Region Pools — pure helpers for the editor.
 *
 * Bookkeeping only: grouping entries by rarity, telling local edits from the
 * saved draft, placing server issues beside the row they name, and words for
 * codes. **No probability is computed here.** Every share and chance on these
 * pages is a number the server's analysis returned; a row whose weight has
 * been edited locally shows "save to recalculate" rather than an estimate.
 */
import {
  NOT_HUNTABLE_RARITY,
  REGION_POOL_ENTRY_MAX_WEIGHT,
  REGION_POOL_RARITIES,
  type DistributionResult,
  type RegionPoolDiff,
  type RegionPoolEntry,
  type RegionPoolEntryView,
  type RegionPoolIssue,
  type RegionPoolRevisionSource,
  type RegionPoolSpecies,
  type ResolvingTier,
} from '@/api/adminRegionPools';

/** One editable row. `weight` is the input's text, so a half-typed value survives. */
export interface PoolRow {
  species: string;
  weight: string;
}

/** Hunted rarities, then EX. A species of any other rarity is shown under her own heading at the end. */
export const SECTION_ORDER: readonly string[] = [...REGION_POOL_RARITIES, NOT_HUNTABLE_RARITY];

export const rowsOf = (entries: readonly RegionPoolEntry[]): PoolRow[] =>
  entries.map((e) => ({ species: e.species, weight: String(e.weight) }));

/** A weight as the server accepts it, or null. */
export function parseWeight(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= REGION_POOL_ENTRY_MAX_WEIGHT ? n : null;
}

/**
 * Rows as the API takes them. An unparseable weight is sent as typed (a number
 * where possible) so the server's own `weight_invalid` names it — the Portal
 * never "fixes" a value on the author's behalf.
 */
export const entriesOf = (rows: readonly PoolRow[]): RegionPoolEntry[] =>
  rows.map((r) => ({ species: r.species, weight: parseWeight(r.weight) ?? Number(r.weight) }));

export const sameEntries = (a: readonly RegionPoolEntry[], b: readonly RegionPoolEntry[]) =>
  a.length === b.length &&
  a.every((e, i) => e.species === b[i]!.species && e.weight === b[i]!.weight);

export interface LocalChanges {
  added: string[];
  removed: string[];
  reweighted: string[];
}

/** What the author changed on this page since the saved draft. */
export function localChanges(
  saved: readonly RegionPoolEntry[],
  rows: readonly PoolRow[],
): LocalChanges {
  const before = new Map(saved.map((e) => [e.species, e.weight]));
  const now = new Map(rows.map((r) => [r.species, r.weight]));
  return {
    added: rows.filter((r) => !before.has(r.species)).map((r) => r.species),
    removed: saved.filter((e) => !now.has(e.species)).map((e) => e.species),
    reweighted: rows
      .filter((r) => before.has(r.species) && parseWeight(r.weight) !== before.get(r.species))
      .map((r) => r.species),
  };
}

export const hasLocalChanges = (c: LocalChanges) =>
  c.added.length + c.removed.length + c.reweighted.length > 0;

/** What a row's species is, from the saved views first, then the picker catalogue. */
export interface SpeciesFacts {
  slug: string;
  name: string | null;
  rarity: string | null;
  enabled: boolean;
  inContent: boolean;
  regionExclusive: boolean;
  dungeonExclusive: boolean;
  race: string | null;
  affinity: string | null;
  publishedIn: string[];
}

export function factsIndex(
  views: readonly RegionPoolEntryView[],
  catalogue: readonly RegionPoolSpecies[],
): Map<string, SpeciesFacts> {
  const index = new Map<string, SpeciesFacts>();
  for (const s of catalogue) {
    index.set(s.slug, {
      slug: s.slug,
      name: s.name,
      rarity: s.rarity,
      enabled: s.enabled,
      inContent: s.inContent,
      regionExclusive: s.regionExclusive,
      dungeonExclusive: s.dungeonExclusive,
      race: s.race,
      affinity: s.affinity,
      publishedIn: s.publishedIn,
    });
  }
  for (const v of views) {
    if (index.has(v.species)) continue;
    index.set(v.species, {
      slug: v.species,
      name: v.name,
      rarity: v.rarity,
      enabled: v.enabled,
      inContent: v.inContent,
      regionExclusive: v.regionExclusive,
      dungeonExclusive: v.dungeonExclusive,
      race: v.race,
      affinity: v.affinity,
      publishedIn: [],
    });
  }
  return index;
}

/** The section a species belongs to: her rarity, or "unknown" when nothing names her. */
export const sectionOf = (facts: SpeciesFacts | undefined) => facts?.rarity ?? 'unknown';

/** Rows grouped by section, in display order. Empty hunted sections are kept: an empty tier is news. */
export function groupRows(
  rows: readonly PoolRow[],
  facts: ReadonlyMap<string, SpeciesFacts>,
): Array<{ rarity: string; rows: Array<PoolRow & { index: number }> }> {
  const groups = new Map<string, Array<PoolRow & { index: number }>>(
    SECTION_ORDER.map((r) => [r, []]),
  );
  rows.forEach((row, index) => {
    const key = sectionOf(facts.get(row.species));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ ...row, index });
  });
  return [...groups.entries()].map(([rarity, list]) => ({ rarity, rows: list }));
}

/** Issues that name this species. */
export const issuesForSpecies = (issues: readonly RegionPoolIssue[], slug: string) =>
  issues.filter((i) => i.species === slug);
/** Issues that name this rarity (empty tiers). */
export const issuesForRarity = (issues: readonly RegionPoolIssue[], rarity: string) =>
  issues.filter((i) => i.rarity === rarity && i.species === undefined);
/** Issues about the pool as a whole. */
export const poolIssues = (issues: readonly RegionPoolIssue[]) =>
  issues.filter((i) => i.species === undefined && i.rarity === undefined);

/** The server's odds for one species in the analysed pool. */
export function oddsFor(result: DistributionResult | undefined, slug: string) {
  return result?.species.find((s) => s.slug === slug && s.inPool);
}

export function rarityOdds(result: DistributionResult | undefined, rarity: string) {
  return result?.rarities.find((r) => r.rarity === rarity);
}

/** Percent with enough digits that a 0.037% chance does not read as 0%. */
export function formatPercent(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p === 0) return '0%';
  const pct = p * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  return `${pct.toPrecision(2)}%`;
}

/** A percentage-point change, signed. */
export function formatDelta(delta: number): string {
  if (delta === 0) return '±0';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${formatPercent(Math.abs(delta)).replace('%', '')} pts`;
}

export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const SOURCE_LABELS: Record<RegionPoolRevisionSource, string> = {
  bootstrap: 'Shipped content (first start)',
  editor: 'Published from the editor',
  rollback: 'Rollback',
  import: 'Import',
};

export const TIER_LABELS: Record<ResolvingTier, string> = {
  region: 'This region',
  default_region: 'Fallback: default region',
  global: 'Fallback: any open species',
  dead: 'Dead — rerolled',
  filtered: 'Filtered pool',
};

export const EXCLUSION_LABELS: Record<string, string> = {
  unknown_species: 'Unknown species',
  disabled: 'Disabled',
  dungeon_exclusive: 'Dungeon-exclusive',
  rarity_not_hunted: 'Rarity never hunted (EX)',
  rarity_never_rolled: 'Rarity has zero weight in this scenario',
  filtered_out: 'Does not match the selector',
};

export const FALLBACK_LABELS: Record<string, string> = {
  default_pool_arbitrary: 'an arbitrary species from the default region',
  open_species_arbitrary: 'an arbitrary open species',
  emergency_region_exclusive: 'an arbitrary region-exclusive species (emergency)',
  nothing: 'nothing',
};

export const EVENT_LABELS: Record<string, string> = {
  bootstrapped: 'Created from shipped content',
  draft_saved: 'Draft saved',
  draft_discarded: 'Draft reset to published',
  draft_reset_to_shipped: 'Draft replaced with shipped pool',
  published: 'Published',
  rolled_back: 'Rolled back',
  projection_rebuilt: 'Live hunting pool rebuilt',
  drift_detected: 'Drift detected',
};

/** Membership changes between two entry lists, for history rows. */
export function entryDiff(
  before: readonly RegionPoolEntry[],
  after: readonly RegionPoolEntry[],
): RegionPoolDiff {
  const was = new Map(before.map((e) => [e.species, e.weight]));
  const now = new Map(after.map((e) => [e.species, e.weight]));
  return {
    added: after.filter((e) => !was.has(e.species)),
    removed: before.filter((e) => !now.has(e.species)),
    reweighted: after
      .filter((e) => was.has(e.species) && was.get(e.species) !== e.weight)
      .map((e) => ({ species: e.species, from: was.get(e.species)!, to: e.weight })),
  };
}

export const diffIsEmpty = (d: RegionPoolDiff) =>
  d.added.length + d.removed.length + d.reweighted.length === 0;

/** Per-rarity species counts of an entry list, for a before/after coverage table. */
export function rarityCoverage(
  entries: readonly RegionPoolEntry[],
  facts: ReadonlyMap<string, SpeciesFacts>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const r = sectionOf(facts.get(e.species));
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}
