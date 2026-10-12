/**
 * Dungeon Loot wire DTOs. The Portal builds independently of the backend.
 * Backend-side dungeonLootPortalContract tests check these against its schemas.
 * Validation stays on the server; this module contains types only.
 */
export interface EquipmentRewardSelector {
  slot?: 'attack' | 'defense' | 'health' | undefined;
  rarity?: 'N' | 'R' | 'SR' | undefined;
  definitionKeys?: string[] | undefined;
}
export interface DungeonQuantityRange {
  min: number;
  max: number;
}
export type DungeonRewardGrant =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence'; amount: DungeonQuantityRange }
  | { type: 'item'; item: string; quantity: DungeonQuantityRange }
  | { type: 'equipment'; selector: EquipmentRewardSelector }
  | { type: 'affection'; amount: DungeonQuantityRange };
export interface DungeonLootTableBody {
  guaranteed: Array<{ id: string; grant: DungeonRewardGrant }>;
  chances: Array<{ id: string; chanceBasisPoints: number; grant: DungeonRewardGrant }>;
  pools: Array<{
    id: string;
    name: string;
    draws: number;
    entries: Array<
      | { id: string; weight: number; grant: DungeonRewardGrant }
      | { id: string; weight: number; nothing: true }
    >;
  }>;
}
export interface DungeonLootIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}
export type DungeonLootEquipmentPools = Record<
  string,
  Array<{ key: string; name: string; slot: string; rarity: string; enabled: boolean }>
>;
export interface DungeonLootTable {
  issues: DungeonLootIssue[];
  equipmentPools: DungeonLootEquipmentPools;
  key: string;
  name: string;
  description: string;
  tier: 'common' | 'rare' | 'boss' | 'legendary' | null;
  body: DungeonLootTableBody;
  contentHash: string;
  revision: number;
  archivedAt: string | null;
  origin: 'portal' | 'import' | 'converted' | 'seed';
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}
export interface DungeonLootTableUsage {
  drafts: Array<{
    kind: 'draft';
    dungeonKey: string;
    name: string;
    enabled: boolean;
    draftRevision: number;
  }>;
  published: Array<{
    kind: 'published';
    dungeonKey: string;
    name: string;
    enabled: boolean;
    revisionId: number;
    revision: number;
    current: boolean;
    snapshotStatus: 'embedded' | 'not_embedded';
  }>;
}
export interface DungeonLootTableEvent {
  id: number;
  tableKey: string;
  action:
    | 'created'
    | 'updated'
    | 'archived'
    | 'restored'
    | 'deleted'
    | 'duplicated'
    | 'imported'
    | 'converted';
  actor: string | null;
  revision: number;
  origin: DungeonLootTable['origin'];
  previousContentHash: string | null;
  newContentHash: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface DungeonLootTableValidation {
  valid: boolean;
  body: DungeonLootTableBody | null;
  contentHash: string | null;
  issues: DungeonLootIssue[];
  equipmentPools: DungeonLootEquipmentPools;
}
