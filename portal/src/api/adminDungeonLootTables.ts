/** Dungeon catalogue client. Backend types are erased; no server runtime enters the bundle. */
import { deleteData, getData, postData, putData } from './client';
import type {
  DungeonLootTable,
  DungeonLootTableUsage,
  DungeonLootTableEvent,
  DungeonLootTableValidation,
} from '../../../src/api/schemas/dungeonLootTables';
import type { DungeonLootTableBody } from '../../../src/modules/dungeons/content/dungeonRewards';

export type {
  DungeonLootTable,
  DungeonLootTableUsage,
  DungeonLootTableEvent,
  DungeonLootTableValidation,
  DungeonLootTableBody,
};
export type DungeonLootTableCreateInput = {
  key: string;
  name: string;
  description?: string;
  tier?: DungeonLootTable['tier'];
  body: DungeonLootTableBody;
  origin?: DungeonLootTable['origin'];
};
export type DungeonLootTableUpdateInput = {
  expectedRevision: number;
  name?: string;
  description?: string;
  tier?: DungeonLootTable['tier'];
  body?: DungeonLootTableBody;
};
export interface DungeonLootTableFilter {
  includeArchived?: boolean;
  tier?: DungeonLootTable['tier'];
  search?: string;
}
/** ApiError.details for DUNGEON_LOOT_TABLE_STALE (409). Keep unsaved edits when handling it. */
export interface DungeonLootTableConflict {
  key: string;
  expectedRevision: number;
  currentRevision: number;
  updatedBy: string | null;
  updatedAt: string;
}
export const DUNGEON_LOOT_TABLES_QUERY_KEY = ['admin', 'dungeons', 'loot-tables'] as const;
const base = '/v1/admin/dungeons/loot-tables';
const url = (key: string) => `${base}/${encodeURIComponent(key)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
export function listDungeonLootTables(
  filter: DungeonLootTableFilter = {},
  signal?: AbortSignal,
): Promise<{ tables: DungeonLootTable[] }> {
  return getData(base, {
    params: { ...filter, ...(filter.tier === null ? { tier: 'null' } : {}) },
    ...opts(signal),
  });
}
export function getDungeonLootTable(key: string, signal?: AbortSignal): Promise<DungeonLootTable> {
  return getData(url(key), opts(signal));
}
export function createDungeonLootTable(
  input: DungeonLootTableCreateInput,
): Promise<DungeonLootTable> {
  return postData(base, input);
}
export function updateDungeonLootTable(
  key: string,
  input: DungeonLootTableUpdateInput,
): Promise<DungeonLootTable> {
  return putData(url(key), input);
}
export function archiveDungeonLootTable(
  key: string,
  expectedRevision: number,
): Promise<DungeonLootTable> {
  return postData(`${url(key)}/archive`, { expectedRevision });
}
export function restoreDungeonLootTable(
  key: string,
  expectedRevision: number,
): Promise<DungeonLootTable> {
  return postData(`${url(key)}/restore`, { expectedRevision });
}
export function deleteDungeonLootTable(
  key: string,
  expectedRevision: number,
): Promise<{ deleted: boolean }> {
  return deleteData(url(key), { data: { expectedRevision } });
}
export function duplicateDungeonLootTable(
  key: string,
  input: { key: string; name?: string },
): Promise<DungeonLootTable> {
  return postData(`${url(key)}/duplicate`, input);
}
export function getDungeonLootTableUsage(
  key: string,
  signal?: AbortSignal,
): Promise<DungeonLootTableUsage> {
  return getData(`${url(key)}/where-used`, opts(signal));
}
export function getDungeonLootTableHistory(
  key: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<{ events: DungeonLootTableEvent[] }> {
  return getData(`${url(key)}/history`, { params: { limit }, ...opts(signal) });
}
export function validateDungeonLootTable(
  body: unknown,
  signal?: AbortSignal,
): Promise<DungeonLootTableValidation> {
  return postData(`${base}/validate`, { body }, opts(signal));
}
