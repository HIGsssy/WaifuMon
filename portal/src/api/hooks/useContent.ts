/**
 * Content queries (plan §13).
 *
 * Content is effectively static — it changes only when an operator runs the
 * admin panel's "Save + Reload" — so these use `CONTENT_POLICY`: never stale,
 * never refetched on focus, retained for hours. After the first fetch, species
 * lookups anywhere in the Portal are free.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { CONTENT_POLICY } from '../cachePolicy';
import {
  getContentItems,
  getContentQuests,
  getContentSpecies,
  getContentSpeciesEntry,
  getContentTable,
  getContentTables,
} from '../content';
import { queryKeys } from '../queryKeys';
import type { ContentItem, ContentSpecies, QuestCatalog, TuningTables } from '../types';

export function useContentSpecies(): UseQueryResult<ContentSpecies[]> {
  return useQuery({
    queryKey: queryKeys.contentSpecies(),
    queryFn: ({ signal }) => getContentSpecies({}, signal),
    ...CONTENT_POLICY,
  });
}

export function useContentSpeciesEntry(slug: string | undefined): UseQueryResult<ContentSpecies> {
  return useQuery({
    queryKey: queryKeys.contentSpeciesEntry(slug ?? ''),
    queryFn: ({ signal }) => getContentSpeciesEntry(slug as string, signal),
    enabled: Boolean(slug),
    ...CONTENT_POLICY,
  });
}

export function useContentItems(): UseQueryResult<ContentItem[]> {
  return useQuery({
    queryKey: queryKeys.contentItems(),
    queryFn: ({ signal }) => getContentItems({}, signal),
    ...CONTENT_POLICY,
  });
}

export function useContentTables(): UseQueryResult<TuningTables> {
  return useQuery({
    queryKey: queryKeys.contentTables(),
    queryFn: ({ signal }) => getContentTables(signal),
    ...CONTENT_POLICY,
  });
}

/**
 * One top-level key of `tables.json`.
 *
 * The payload is typed `unknown` all the way through — the API documents the
 * blob as opaque balance tuning that is explicitly not part of the frozen v1
 * contract, so the Guide reads it defensively rather than against a shape that
 * would break on the next balance patch (plan §8.9).
 */
export function useContentTable(key: string): UseQueryResult<unknown> {
  return useQuery({
    queryKey: queryKeys.contentTable(key),
    queryFn: ({ signal }) => getContentTable(key, signal),
    ...CONTENT_POLICY,
  });
}

export function useContentQuests(): UseQueryResult<QuestCatalog> {
  return useQuery({
    queryKey: queryKeys.contentQuests(),
    queryFn: ({ signal }) => getContentQuests(signal),
    ...CONTENT_POLICY,
  });
}
