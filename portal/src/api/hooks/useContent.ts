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
import { getContentSpecies, getContentSpeciesEntry } from '../content';
import { queryKeys } from '../queryKeys';
import type { ContentSpecies } from '../types';

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
