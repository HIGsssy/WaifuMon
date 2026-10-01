/**
 * The shared reads every World Encounter authoring screen leans on — the
 * reference selectors, the full encounter list (for chain relationships), the
 * vendors, and the global settings — plus name lookups built from them.
 *
 * Query keys match the ones the existing pages already use, so the list page,
 * the editor and the pickers share one cache and one invalidation.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  getAdminEncounterReference,
  getAdminEncounterSettings,
  listAdminEncounters,
  type AdminEncounter,
} from '@/api/adminEncounters';
import { VENDORS_QUERY_KEY, listAdminVendors } from '@/api/adminVendors';
import type { NameLookups } from './describe';

export const REFERENCE_KEY = ['admin', 'encounters', 'reference'] as const;
export const LIST_KEY = ['admin', 'encounters', 'list'] as const;
export const SETTINGS_KEY = ['admin', 'encounters', 'settings'] as const;

export function useReference() {
  return useQuery({
    queryKey: REFERENCE_KEY,
    queryFn: ({ signal }) => getAdminEncounterReference(signal),
  });
}

export function useEncounterList() {
  return useQuery({ queryKey: LIST_KEY, queryFn: ({ signal }) => listAdminEncounters(signal) });
}

export function useVendors() {
  return useQuery({
    queryKey: VENDORS_QUERY_KEY,
    queryFn: ({ signal }) => listAdminVendors(signal),
  });
}

export function useEncounterSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => getAdminEncounterSettings(signal),
  });
}

const NO_EXTRA: readonly Pick<AdminEncounter, 'slug' | 'name'>[] = [];

/** Name lookups for summaries, from whatever has loaded so far. */
export function useNameLookups(
  extraEncounters: readonly Pick<AdminEncounter, 'slug' | 'name'>[] = NO_EXTRA,
): NameLookups {
  const reference = useReference().data;
  const list = useEncounterList().data;
  const vendors = useVendors().data;
  return useMemo(() => {
    const items = new Map((reference?.items ?? []).map((i) => [i.slug, i.name]));
    const species = new Map((reference?.species ?? []).map((s) => [s.slug, s.name]));
    const encounters = new Map(
      [...(reference?.encounters ?? []), ...(list?.encounters ?? []), ...extraEncounters].map(
        (e) => [e.slug, e.name],
      ),
    );
    const vendorNames = new Map([
      ...(reference?.vendors ?? []).map((v) => [v.vendorKey, v.name] as const),
      ...(vendors?.vendors ?? []).map((v) => [v.vendorKey, v.name] as const),
    ]);
    return {
      item: (slug) => items.get(slug),
      species: (slug) => species.get(slug),
      encounter: (slug) => encounters.get(slug),
      vendor: (key) => vendorNames.get(key),
    };
  }, [reference, list, vendors, extraEncounters]);
}
