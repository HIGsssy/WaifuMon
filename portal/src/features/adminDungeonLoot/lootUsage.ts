/**
 * Which dungeons use a loot table, read per dungeon rather than per draft and
 * revision, and what that means for saving and deleting it.
 */
import type { QueryClient } from '@tanstack/react-query';
import {
  DUNGEON_LOOT_TABLES_QUERY_KEY,
  type DungeonLootTableUsage,
} from '@/api/adminDungeonLootTables';
import { DUNGEONS_QUERY_KEY } from '@/api/adminDungeons';

export interface DungeonUse {
  dungeonKey: string;
  name: string;
  /** The dungeon's draft uses the table. */
  draft: boolean;
  /** The revision players get now, when it uses the table. */
  liveRevision: number | null;
  /** Older published revisions that used it. */
  olderRevisions: number;
  /** A published revision still reads the catalogue row, so the table cannot be deleted. */
  needsTable: boolean;
}
/** One line per dungeon, however many of its drafts and revisions name the table. */
export function dungeonUses(usage: DungeonLootTableUsage | undefined): DungeonUse[] {
  const uses = new Map<string, DungeonUse>();
  const of = (ref: { dungeonKey: string; name: string }) => {
    let use = uses.get(ref.dungeonKey);
    if (!use) {
      use = {
        dungeonKey: ref.dungeonKey,
        name: ref.name,
        draft: false,
        liveRevision: null,
        olderRevisions: 0,
        needsTable: false,
      };
      uses.set(ref.dungeonKey, use);
    }
    return use;
  };
  for (const ref of usage?.drafts ?? []) of(ref).draft = true;
  for (const ref of usage?.published ?? []) {
    const use = of(ref);
    if (ref.current) use.liveRevision = ref.revision;
    else use.olderRevisions++;
    if (ref.snapshotStatus === 'not_embedded') use.needsTable = true;
  }
  return [...uses.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const dungeonCount = (n: number) => `${n} ${n === 1 ? 'dungeon' : 'dungeons'}`;
/** What saving means for dungeons already published with this table. */
export function republishNote(uses: DungeonUse[]): string | null {
  const live = uses.filter((u) => u.liveRevision !== null).length;
  if (live === 0) return null;
  return `${dungeonCount(live)} ${live === 1 ? 'uses' : 'use'} this table. ${live === 1 ? 'It keeps' : 'They keep'} paying the old version until ${live === 1 ? 'it is' : 'each is'} published again.`;
}
/** The dungeons that stop a delete: drafts, and revisions published before loot was copied into them. */
export const deleteBlockers = (uses: DungeonUse[]) => uses.filter((u) => u.draft || u.needsTable);

export function invalidateLootTables(client: QueryClient) {
  void client.invalidateQueries({ queryKey: DUNGEON_LOOT_TABLES_QUERY_KEY });
  // The dungeon editor lists loot tables in its reference data.
  void client.invalidateQueries({ queryKey: [...DUNGEONS_QUERY_KEY, 'reference'] });
}
