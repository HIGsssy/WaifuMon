/**
 * URL-backed filter state for `/collection` (plan §7, §10).
 *
 * Filters live in the query string — `?rarity=SR&type=kitsune&page=2` — so back
 * and forward are honest and a filtered view is a shareable link. There is no
 * global store; `useSearchParams` *is* the state.
 *
 * Two rules the setters enforce so the URL never lies:
 *   - a default value is removed from the URL rather than written as `all`
 *   - changing any filter resets to page 1, because page 4 of an unfiltered
 *     collection is rarely page 4 of a filtered one
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import type { Race, Rarity } from '@/api/types';
import { RARITY_ORDER } from '@/lib/rarity';
import type { SortKey } from '@/content/species';

export type Ownership = 'all' | 'favorites' | 'buddy';

export interface CollectionParams {
  page: number;
  rarity: Rarity | null;
  search: string;
  race: Race | null;
  affinity: string | null;
  ownership: Ownership;
  sort: SortKey;
}

const SORT_KEYS: readonly SortKey[] = ['rarity', 'name', 'level', 'caught'];
const OWNERSHIPS: readonly Ownership[] = ['all', 'favorites', 'buddy'];
const RACES: readonly Race[] = [
  'angel',
  'demon',
  'demi-human',
  'human',
  'spirit',
  'valkyrie',
  'android',
];

/** Anything unrecognised falls back to the default rather than throwing. */
function readEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export interface CollectionParamsApi {
  params: CollectionParams;
  setPage: (page: number) => void;
  /** Any filter change; resets to page 1. */
  setFilter: (patch: Partial<Omit<CollectionParams, 'page'>>) => void;
  clearFilters: () => void;
  /** True when anything other than the defaults is applied. */
  hasFilters: boolean;
}

export function useCollectionParams(): CollectionParamsApi {
  const [searchParams, setSearchParams] = useSearchParams();

  const params = useMemo<CollectionParams>(() => {
    const rawPage = Number(searchParams.get('page') ?? '1');
    const rarity = searchParams.get('rarity');
    return {
      page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
      rarity:
        rarity !== null && (RARITY_ORDER as readonly string[]).includes(rarity)
          ? (rarity as Rarity)
          : null,
      search: searchParams.get('search') ?? '',
      race: readNullableEnum(searchParams.get('type'), RACES),
      affinity: searchParams.get('affinity'),
      ownership: readEnum(searchParams.get('ownership'), OWNERSHIPS, 'all'),
      sort: readEnum(searchParams.get('sort'), SORT_KEYS, 'rarity'),
    };
  }, [searchParams]);

  /** Writes a value, or removes the key when it is empty or the default. */
  const write = useCallback(
    (next: URLSearchParams, key: string, value: string | null, fallback: string) => {
      if (value === null || value === '' || value === fallback) next.delete(key);
      else next.set(key, value);
    },
    [],
  );

  const setPage = useCallback(
    (page: number) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          write(next, 'page', page > 1 ? String(page) : null, '1');
          return next;
        },
        // Paging is a new history entry — back should return to the previous page.
        { preventScrollReset: false },
      );
    },
    [setSearchParams, write],
  );

  const setFilter = useCallback(
    (patch: Partial<Omit<CollectionParams, 'page'>>) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if ('rarity' in patch) write(next, 'rarity', patch.rarity ?? null, '');
        if ('search' in patch) write(next, 'search', patch.search ?? null, '');
        if ('race' in patch) write(next, 'type', patch.race ?? null, '');
        if ('affinity' in patch) write(next, 'affinity', patch.affinity ?? null, '');
        if ('ownership' in patch) write(next, 'ownership', patch.ownership ?? null, 'all');
        if ('sort' in patch) write(next, 'sort', patch.sort ?? null, 'rarity');
        // A filtered page 2 is meaningless against a different result set.
        next.delete('page');
        return next;
      });
    },
    [setSearchParams, write],
  );

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const hasFilters =
    params.rarity !== null ||
    params.search !== '' ||
    params.race !== null ||
    params.affinity !== null ||
    params.ownership !== 'all';

  return { params, setPage, setFilter, clearFilters, hasFilters };
}

function readNullableEnum<T extends string>(raw: string | null, allowed: readonly T[]): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}
