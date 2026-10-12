import { createContext } from 'react';
import type { DungeonTreasureTarget } from '@/api/adminDungeons';

/**
 * Lets a legacy treasure offer its conversion, provided by a page that holds
 * the saved draft. Null where there is no such page: the treasure then shows
 * its old settings and nothing else.
 */
export interface TreasureConversionHost {
  /** Why converting is unavailable right now, in words; null when it can start. */
  unavailable: string | null;
  open: (target: DungeonTreasureTarget) => void;
}
export const TreasureConversionContext = createContext<TreasureConversionHost | null>(null);
