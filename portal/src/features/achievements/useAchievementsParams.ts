/**
 * URL-backed category filter for `/achievements`.
 *
 * The selected category lives in the query string (`?category=hunting`) so the
 * view is shareable and back/forward honest. `all` is the default and is kept
 * out of the URL rather than written explicitly.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import type { AchievementCategory } from '@/api/types';

export type CategoryFilter = AchievementCategory | 'all';

const CATEGORIES: readonly AchievementCategory[] = [
  'hunting',
  'collection',
  'rarity',
  'buddy',
  'progression',
  'travel',
  'bosses',
  'special',
];

function isCategory(value: string | null): value is AchievementCategory {
  return value !== null && (CATEGORIES as readonly string[]).includes(value);
}

export interface AchievementsParams {
  category: CategoryFilter;
  setCategory: (category: CategoryFilter) => void;
}

export function useAchievementsParams(): AchievementsParams {
  const [params, setParams] = useSearchParams();

  const category: CategoryFilter = useMemo(() => {
    const raw = params.get('category');
    return isCategory(raw) ? raw : 'all';
  }, [params]);

  const setCategory = useCallback(
    (next: CategoryFilter) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          if (next === 'all') copy.delete('category');
          else copy.set('category', next);
          return copy;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { category, setCategory };
}
