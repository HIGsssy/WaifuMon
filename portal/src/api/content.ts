/**
 * `/api/v1/content/*` — the authored content snapshot.
 *
 * These endpoints issue no database queries on the API side and only change
 * when an operator runs the admin panel's "Save + Reload", which is why the
 * Portal caches them with `staleTime: Infinity` (plan §13).
 *
 * Content is addressed by **slug** and carries no internal ids. When the Portal
 * holds an id (an owned waifu's `speciesId`, an inventory `itemId`), the
 * id-bearing row is already embedded in that gameplay resource — there is never
 * a reason to resolve one against the other.
 */
import { getData } from './client';
import type {
  ContentItem,
  ContentSpecies,
  ItemCategory,
  QuestCatalog,
  Rarity,
  TuningTables,
} from './types';

export interface SpeciesQuery {
  rarity?: Rarity | undefined;
  archetype?: string | undefined;
  /** Omit to receive both enabled and disabled species. */
  enabled?: boolean | undefined;
}

export function getContentSpecies(
  query: SpeciesQuery = {},
  signal?: AbortSignal,
): Promise<ContentSpecies[]> {
  return getData<ContentSpecies[]>('/v1/content/species', {
    params: {
      ...(query.rarity ? { rarity: query.rarity } : {}),
      ...(query.archetype ? { archetype: query.archetype } : {}),
      ...(query.enabled === undefined ? {} : { enabled: String(query.enabled) }),
    },
    ...(signal ? { signal } : {}),
  });
}

export function getContentSpeciesEntry(
  slug: string,
  signal?: AbortSignal,
): Promise<ContentSpecies> {
  return getData<ContentSpecies>(`/v1/content/species/${slug}`, signal ? { signal } : {});
}

export interface ItemsQuery {
  category?: ItemCategory | undefined;
  enabled?: boolean | undefined;
}

export function getContentItems(
  query: ItemsQuery = {},
  signal?: AbortSignal,
): Promise<ContentItem[]> {
  return getData<ContentItem[]>('/v1/content/items', {
    params: {
      ...(query.category ? { category: query.category } : {}),
      ...(query.enabled === undefined ? {} : { enabled: String(query.enabled) }),
    },
    ...(signal ? { signal } : {}),
  });
}

export function getContentItemEntry(slug: string, signal?: AbortSignal): Promise<ContentItem> {
  return getData<ContentItem>(`/v1/content/items/${slug}`, signal ? { signal } : {});
}

/**
 * The whole `tables.json` blob. Typed as opaque on purpose — the API documents
 * its nested shape as explicitly *not* part of the frozen v1 contract.
 */
export function getContentTables(signal?: AbortSignal): Promise<TuningTables> {
  return getData<TuningTables>('/v1/content/tables', signal ? { signal } : {});
}

/** One top-level key of `tables.json` — `energy`, `hunt`, `capture`, … */
export function getContentTable(key: string, signal?: AbortSignal): Promise<unknown> {
  return getData<unknown>(`/v1/content/tables/${key}`, signal ? { signal } : {});
}

export function getContentQuests(signal?: AbortSignal): Promise<QuestCatalog> {
  return getData<QuestCatalog>('/v1/content/quests', signal ? { signal } : {});
}
