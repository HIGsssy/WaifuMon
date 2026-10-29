import { getData, postData, putData } from './client';
import type { DungeonSpeciesPoolEntry } from './adminDungeons';
export interface SharedPoolDefinition {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  entries: DungeonSpeciesPoolEntry[];
}
export interface SharedPool {
  definition: SharedPoolDefinition;
  revision: number;
}
export interface SharedPoolPackage {
  format: 'waifumon-dungeon-species-pools';
  schemaVersion: 1;
  pools: SharedPoolDefinition[];
}
export interface SharedPoolReference {
  dungeonKey: string;
  name: string;
  source: 'draft' | 'published';
  poolId: string;
}
const root = '/v1/admin/dungeons/waifumon-pools';
export const SHARED_POOL_QUERY = ['admin-dungeon-species-pools'] as const;
export const listSharedPools = (signal?: AbortSignal) =>
  getData<SharedPool[]>(root, signal ? { signal } : {});
export const getSharedPool = (key: string, signal?: AbortSignal) =>
  getData<SharedPool>(`${root}/${encodeURIComponent(key)}`, signal ? { signal } : {});
export const createSharedPool = (definition: SharedPoolDefinition) =>
  postData<SharedPool>(root, definition);
export const saveSharedPool = (definition: SharedPoolDefinition, expectedRevision: number) =>
  putData<SharedPool>(`${root}/${encodeURIComponent(definition.key)}`, {
    definition,
    expectedRevision,
  });
export const duplicateSharedPool = (source: string, key: string, expectedRevision: number) =>
  postData<SharedPool>(`${root}/${encodeURIComponent(source)}/duplicate`, {
    key,
    expectedRevision,
  });
export const enableSharedPool = (key: string, enabled: boolean, expectedRevision: number) =>
  postData<SharedPool>(`${root}/${encodeURIComponent(key)}/enabled`, { enabled, expectedRevision });
export const sharedPoolReferences = (key: string, signal?: AbortSignal) =>
  getData<SharedPoolReference[]>(
    `${root}/${encodeURIComponent(key)}/references`,
    signal ? { signal } : {},
  );
export const exportSharedPools = (key?: string) =>
  getData<SharedPoolPackage>(`${root}/export`, { params: key ? { key } : {} });
export const importSharedPools = (
  pkg: SharedPoolPackage,
  expectedRevisions: Record<string, number | null>,
) => postData<SharedPool[]>(`${root}/import`, { package: pkg, expectedRevisions });
