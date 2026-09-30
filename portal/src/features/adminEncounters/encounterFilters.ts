/**
 * The encounter list's filters — pure, plus a small per-tab persistence
 * helper so returning from the editor lands on the same filtered view.
 */
import type { AdminEncounter } from '@/api/adminEncounters';
import { formatDurationShort } from './duration';
import type { EncounterGraph, RoleKind } from './encounterGraph';

export interface EncounterFilterState {
  q: string;
  role: 'all' | RoleKind;
  status: '' | 'active' | 'draft' | 'disabled';
  /** `hunt`/`travel`: can appear there (either or both). `both`: both. */
  source: 'all' | 'hunt' | 'travel' | 'both';
  rarity: string;
  /** Region id; encounters with no region restriction (global) always match. */
  region: string;
  type: string;
  artwork: 'any' | 'has' | 'missing';
  vendor: 'any' | 'opens' | 'none';
}

export const DEFAULT_FILTERS: EncounterFilterState = {
  q: '',
  role: 'all',
  status: '',
  source: 'all',
  rarity: '',
  region: '',
  type: '',
  artwork: 'any',
  vendor: 'any',
};

export function opensVendor(e: Pick<AdminEncounter, 'choices'>): boolean {
  return e.choices.some((c) =>
    [...c.successEffects, ...c.failureEffects].some((effect) => effect.type === 'open_vendor'),
  );
}

/** Does `role` (the list's Role filter) describe this encounter? */
export function matchesRole(
  role: EncounterFilterState['role'],
  info: ReturnType<EncounterGraph['roleOf']>,
): boolean {
  switch (role) {
    case 'all':
      return true;
    case 'standalone':
      return info.spawns && info.parents.length === 0 && info.children.length === 0;
    case 'root':
      return info.children.length > 0 && info.parents.length === 0;
    case 'child':
      return info.parents.length > 0;
    case 'chain-only':
      return !info.spawns;
  }
}

/**
 * Search matches the encounter's own name and slug, and the names and slugs of
 * every encounter it links to or is linked from — so searching "strange door"
 * also finds the door's follow-ups.
 */
function matchesSearch(e: AdminEncounter, q: string, graph: EncounterGraph): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const role = graph.roleOf(e.slug);
  const related = [...role.parents, ...role.children].flatMap((slug) => [
    slug,
    graph.encounters.get(slug)?.name ?? '',
  ]);
  return [e.name, e.slug, ...related].some((text) => text.toLowerCase().includes(needle));
}

export function filterEncounters(
  encounters: readonly AdminEncounter[],
  f: EncounterFilterState,
  graph: EncounterGraph,
): AdminEncounter[] {
  return encounters.filter((e) => {
    if (!matchesSearch(e, f.q, graph)) return false;
    if (!matchesRole(f.role, graph.roleOf(e.slug))) return false;
    if (f.status && e.lifecycle !== f.status) return false;
    if (f.source === 'hunt' && !e.huntEligible) return false;
    if (f.source === 'travel' && !e.travelEligible) return false;
    if (f.source === 'both' && !(e.huntEligible && e.travelEligible)) return false;
    if (f.rarity && e.rarity !== f.rarity) return false;
    if (f.region && e.regions.length > 0 && !e.regions.includes(f.region)) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.artwork === 'has' && !e.artworkPath) return false;
    if (f.artwork === 'missing' && e.artworkPath) return false;
    if (f.vendor === 'opens' && !opensVendor(e)) return false;
    if (f.vendor === 'none' && opensVendor(e)) return false;
    return true;
  });
}

export function activeFilterCount(f: EncounterFilterState): number {
  return (Object.keys(DEFAULT_FILTERS) as Array<keyof EncounterFilterState>).filter(
    (k) => k !== 'q' && f[k] !== DEFAULT_FILTERS[k],
  ).length;
}

const STORAGE_KEY = 'wm.admin.encounterFilters';

/**
 * The filters last used in this tab. Session storage can be missing or throw
 * (private windows, blocked site data); either way the list simply starts
 * unfiltered.
 */
export function loadFilters(): EncounterFilterState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<EncounterFilterState>;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(f: EncounterFilterState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    // Persistence is a convenience; the list works without it.
  }
}

/* ─────────────────────── Row summaries ─────────────────────── */

function sourceBadge(e: AdminEncounter): string {
  if (e.huntEligible && e.travelEligible) return 'HUNT + TRAVEL';
  if (e.huntEligible) return 'HUNT';
  if (e.travelEligible) return 'TRAVEL';
  return 'CHAIN ONLY';
}

export function namesOf(graph: EncounterGraph, slugs: string[]): string {
  const names = slugs.map((s) => graph.encounters.get(s)?.name ?? s);
  return names.length <= 2
    ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
}

/** The row's summary line, e.g. `TRAVEL · CHAIN ROOT · 3 CHOICES · 15M REPEAT`. */
export function summaryBadges(e: AdminEncounter, graph: EncounterGraph): string[] {
  const role = graph.roleOf(e.slug);
  const parts = [sourceBadge(e)];
  if (role.parents.length > 0) parts.push(`CHILD OF: ${namesOf(graph, role.parents)}`);
  else if (role.children.length > 0) parts.push('CHAIN ROOT');
  if (role.parents.length > 0 && role.children.length > 0)
    parts.push(`LEADS TO ${role.children.length}`);
  parts.push(`${e.choices.length} CHOICE${e.choices.length === 1 ? '' : 'S'}`);
  if (e.cooldownSeconds > 0) parts.push(`${formatDurationShort(e.cooldownSeconds)} REPEAT`);
  if (opensVendor(e)) parts.push('OPENS VENDOR');
  return parts;
}
