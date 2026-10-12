import { createContext } from 'react';

/**
 * Opens a loot table beside whatever the author is doing, provided by a page
 * that can host the side sheet. Null where there is no host: callers then
 * offer the table's own page in a new tab, which also leaves their work alone.
 */
export const LootTableSheetContext = createContext<((tableKey: string) => void) | null>(null);
