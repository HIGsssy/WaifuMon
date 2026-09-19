/**
 * Admin Waifumon Gallery filters — pure functions over the catalog, plus the
 * URL vocabulary that makes a filtered gallery bookmarkable.
 *
 * Filtering is client-side over the single catalog response, and the detail
 * page runs the exact same function over the same URL parameters to compute
 * previous/next species — so paging through a filtered gallery follows the
 * order the admin was looking at.
 *
 * Unrecognised URL values degrade to "All" rather than throwing or matching
 * nothing: a stale bookmark shows more, never an empty page for no reason.
 *
 * Zone comes from `lib/zone.ts` and nowhere else. Species with no recognised
 * zone tag — most future content — are reachable through All and through the
 * explicit No Zone option.
 */
import type { GallerySpeciesSummary } from '@/api/adminGallery';
import type { ContentRating, Rarity } from '@/api/types';
import { RARITY_ORDER } from '@/lib/rarity';
import { isZoneTag, zoneFor } from '@/lib/zone';

/** The Zone filter value for "no recognised zone tag". */
export const NO_ZONE = 'none';

export const RUNTIME_OPTIONS = ['loaded', 'future'] as const;
export type RuntimeFilter = (typeof RUNTIME_OPTIONS)[number];

export const ENABLED_OPTIONS = ['enabled', 'disabled'] as const;
export type EnabledFilter = (typeof ENABLED_OPTIONS)[number];

export const HEALTH_OPTIONS = ['issues', 'clean'] as const;
export type HealthFilter = (typeof HEALTH_OPTIONS)[number];

export const RATING_OPTIONS: readonly ContentRating[] = ['suggestive', 'mature', 'explicit'];

export interface GalleryFilters {
  search: string;
  rarity: Rarity | null;
  race: string | null;
  affinity: string | null;
  /** A canonical zone tag, {@link NO_ZONE}, or null for All Zones. */
  zone: string | null;
  runtime: RuntimeFilter | null;
  enabled: EnabledFilter | null;
  health: HealthFilter | null;
  rating: ContentRating | null;
}

/** URL parameter per filter. Short, stable, bookmark-friendly. */
export const FILTER_PARAM: Readonly<Record<keyof GalleryFilters, string>> = {
  search: 'q',
  rarity: 'rarity',
  race: 'type',
  affinity: 'affinity',
  zone: 'zone',
  runtime: 'runtime',
  enabled: 'enabled',
  health: 'health',
  rating: 'rating',
};

function readOne<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Filters from the URL. `races` and `affinities` are the values the catalog
 * actually contains — the same data-derived vocabulary the Encyclopedia uses.
 */
export function readGalleryFilters(
  params: URLSearchParams,
  vocab: { races: readonly string[]; affinities: readonly string[] },
): GalleryFilters {
  const zone = params.get(FILTER_PARAM.zone);
  return {
    search: params.get(FILTER_PARAM.search) ?? '',
    rarity: readOne(params.get(FILTER_PARAM.rarity), RARITY_ORDER),
    race: readOne(params.get(FILTER_PARAM.race), vocab.races),
    affinity: readOne(params.get(FILTER_PARAM.affinity), vocab.affinities),
    zone: zone === NO_ZONE || isZoneTag(zone) ? zone : null,
    runtime: readOne(params.get(FILTER_PARAM.runtime), RUNTIME_OPTIONS),
    enabled: readOne(params.get(FILTER_PARAM.enabled), ENABLED_OPTIONS),
    health: readOne(params.get(FILTER_PARAM.health), HEALTH_OPTIONS),
    rating: readOne(params.get(FILTER_PARAM.rating), RATING_OPTIONS),
  };
}

/**
 * Whether a species is enabled, as a player would experience it:
 *
 *   - loaded → the runtime's own answer (so a species the loader disabled for
 *     missing artwork counts as disabled, even though authored enabled);
 *   - not loaded → what the content file says, since there is no runtime copy.
 *
 * Deliberately separate from `runtime.loaded`: "Future" and "Disabled" are
 * different facts, and a future species can be authored enabled.
 */
export function isEnabled(species: GallerySpeciesSummary): boolean {
  return species.runtime.loaded ? species.runtime.enabled === true : species.authoredEnabled;
}

export function filterGallerySpecies(
  list: readonly GallerySpeciesSummary[],
  filters: GalleryFilters,
): GallerySpeciesSummary[] {
  const needle = filters.search.trim().toLowerCase();
  return list.filter((s) => {
    if (needle && !s.name.toLowerCase().includes(needle) && !s.slug.includes(needle)) {
      return false;
    }
    if (filters.rarity && s.rarity !== filters.rarity) return false;
    if (filters.race && s.race !== filters.race) return false;
    if (filters.affinity && s.affinity !== filters.affinity) return false;
    if (filters.zone) {
      const tag = zoneFor(s)?.tag ?? NO_ZONE;
      if (tag !== filters.zone) return false;
    }
    if (filters.runtime === 'loaded' && !s.runtime.loaded) return false;
    if (filters.runtime === 'future' && s.runtime.loaded) return false;
    if (filters.enabled === 'enabled' && !isEnabled(s)) return false;
    if (filters.enabled === 'disabled' && isEnabled(s)) return false;
    if (filters.health === 'issues' && s.issues.length === 0) return false;
    if (filters.health === 'clean' && s.issues.length > 0) return false;
    if (filters.rating && s.contentRating !== filters.rating) return false;
    return true;
  });
}

/** Sorted distinct values of a field, for the Type and Affinity options. */
export function distinctValues(
  list: readonly GallerySpeciesSummary[],
  key: 'race' | 'affinity',
): string[] {
  return [...new Set(list.map((s) => s[key]))].sort((a, b) => a.localeCompare(b));
}

/**
 * The neighbours of `slug` in the filtered order, falling back to the whole
 * catalog when the current species is not in the filtered list (a deep link,
 * or a filter that excludes her).
 */
export function neighboursOf(
  list: readonly GallerySpeciesSummary[],
  filtered: readonly GallerySpeciesSummary[],
  slug: string,
): {
  previous: GallerySpeciesSummary | null;
  next: GallerySpeciesSummary | null;
  position: number;
  total: number;
} {
  const order = filtered.some((s) => s.slug === slug) ? filtered : list;
  const index = order.findIndex((s) => s.slug === slug);
  if (index < 0) return { previous: null, next: null, position: 0, total: order.length };
  return {
    previous: order[index - 1] ?? null,
    next: order[index + 1] ?? null,
    position: index + 1,
    total: order.length,
  };
}
