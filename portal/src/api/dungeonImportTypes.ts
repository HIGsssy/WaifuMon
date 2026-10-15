/** Import wire DTOs. Independent of backend/runtime clients; checked by backend contract tests. */
import type { DungeonLootTableBody } from './dungeonLootTypes.js';

export type DungeonLootImportDecision =
  | { action: 'create' }
  | { action: 'use_existing' }
  | { action: 'leave_missing' }
  | { action: 'copy'; key: string };
export type DungeonLootImportDecisions = Record<string, DungeonLootImportDecision>;
export interface DungeonLootImportTablePlan {
  key: string;
  name: string;
  status: 'missing' | 'identical' | 'different';
  currentRevision: number | null;
  currentHash: string | null;
  incomingHash: string;
  currentName: string | null;
  archived: boolean;
  incomingBody: DungeonLootTableBody;
  currentBody: DungeonLootTableBody | null;
  decision: DungeonLootImportDecision | null;
  targetKey: string;
  suggestedCopyKey: string;
}
export interface DungeonImportEquipmentChange {
  selectorKey: string;
  description: string;
  sourceCandidates: Array<{ key: string; name: string }>;
  targetCandidates: Array<{ key: string; name: string }>;
  added: Array<{ key: string; name: string }>;
  removed: Array<{ key: string; name: string }>;
}
export interface DungeonImportPlan {
  validPackage: boolean;
  packageId: string | null;
  packageHash: string | null;
  sourceEnvironment: string | null;
  dungeonKey: string | null;
  contentHash: string | null;
  planHash: string | null;
  target: {
    status: 'new' | 'different' | 'identical';
    expectedRevision: number | null;
    currentContentHash: string | null;
    changedFields: string[];
  } | null;
  enemies: Array<{
    key: string;
    status: 'identical' | 'different' | 'existing_unverified' | 'missing_bundled' | 'missing';
    currentRevision: number | null;
    currentHash: string | null;
    incomingHash: string | null;
    changedFields: string[];
  }>;
  issues: Array<{ code: string; severity: 'error' | 'warning'; path: string; message: string }>;
  publishable: boolean;
  lootTables?: DungeonLootImportTablePlan[] | undefined;
  equipmentChanges?: DungeonImportEquipmentChange[] | undefined;
  resultingContentHash?: string | undefined;
  eventDependencies?:
    | {
        eventCount: number;
        poolCount: number;
        requiredItems: Array<{
          key: string;
          name: string;
          status: 'available' | 'missing' | 'disabled';
        }>;
      }
    | undefined;
  encounterDependencies?:
    | {
        encounterCount: number;
        poolCount: number;
        requiredSpecies: Array<{
          slug: string;
          name: string;
          status:
            | 'available'
            | 'missing'
            | 'disabled'
            | 'restricted'
            | 'direct_rescue_not_permitted'
            | 'direct_limit_missing';
          modes: Array<'capture' | 'direct'>;
          sourceRarity: string;
          targetRarity: string | null;
          changes: string[];
          perPlayerLimit: number | 'unlimited' | null;
          directRescue: boolean;
        }>;
        captureItems: Array<{
          key: string;
          name: string;
          status: 'available' | 'missing' | 'disabled' | 'not_capture' | 'incompatible';
          rarities: string[] | null;
          guaranteed: boolean | null;
        }>;
      }
    | undefined;
  rewardSource?:
    | { origin: 'draft' | 'revision'; snapshotHash: string | null; resolverVersion: number | null }
    | undefined;
}
export interface DungeonImportDecisions {
  dungeon: 'create' | 'replace' | 'unchanged';
  enemies: Record<string, 'create' | 'use_existing' | 'leave_missing'>;
  allowMissingDependencies: boolean;
  lootTables?: DungeonLootImportDecisions | undefined;
}
export interface DungeonImportApplyInput {
  package: unknown;
  requestId: string;
  expectedPlanHash: string;
  expectedRevision: number | null;
  decisions: DungeonImportDecisions;
}
export interface DungeonImportResult {
  importId: number;
  dungeonKey: string;
  result: 'created' | 'replaced' | 'unchanged';
  draftRevision: number;
  createdEnemies: string[];
  issues: Array<{ code: string; severity: 'error' | 'warning'; path: string; message: string }>;
  publishable: boolean;
  replayed: boolean;
  contentHash?: string | undefined;
  createdLootTables?: string[] | undefined;
  reusedLootTables?: string[] | undefined;
  tableKeyChanges?: Record<string, string> | undefined;
  sourceSchemaVersion?: 2 | 3 | 4 | undefined;
  rewardSnapshotHash?: string | null | undefined;
}
