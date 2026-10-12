/** Dungeon catalogue client. Backend types are erased; no server runtime enters the bundle. */
import { deleteData, getData, postData, putData } from './client';
import type {
  DungeonLootTable,
  DungeonLootTableUsage,
  DungeonLootTableEvent,
  DungeonLootTableValidation,
} from '../../../src/api/schemas/dungeonLootTables';
import type {
  DungeonLootTableBody,
  DungeonRewardGrant,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import type { DungeonIssue, DungeonRewardBundle } from './adminDungeons';

/** The existing equipment selector: an optional slot, an optional rarity, optional specific pieces. */
export type EquipmentRewardSelector = Extract<
  DungeonRewardGrant,
  { type: 'equipment' }
>['selector'];

// ── Test Roll (T12). Hand-authored to mirror `dungeonRewardPreview` and `lootResolver`. ──

export type DungeonAnalysedReward =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence' }
  | { type: 'item'; item: string }
  | { type: 'equipment'; definitionKey: string }
  | { type: 'affection' };
export type DungeonResolvedRewardGrant =
  | { type: 'currency'; currency: 'shards' | 'waifubux' | 'essence'; amount: number }
  | { type: 'item'; item: string; quantity: number }
  | { type: 'equipment'; definitionKey: string; rollSeed: number }
  | { type: 'affection'; amount: number };
/** Where one resolved slot came from. Draws and picks are zero-based ordinals. */
export interface DungeonRewardSource {
  dropId: string;
  source: 'guaranteed' | 'chance' | 'table';
  mode: 'guaranteed' | 'chance' | 'pool';
  tableKey?: string;
  tableReferenceId?: string;
  tableDraw?: number;
  poolId?: string;
  poolName?: string;
  poolPick?: number;
}
export interface DungeonResolvedRewardLine extends DungeonRewardSource {
  entryId: string;
  hit: boolean;
  missReason?: 'chance_missed' | 'nothing';
  grant?: DungeonResolvedRewardGrant;
  rolls: {
    chance?: { value: number; chanceBasisPoints: number };
    pool?: { value: number; weight: number; totalWeight: number };
    quantity?: { min: number; max: number; value: number };
    equipment?: { selectorKey: string; candidateCount: number; index: number };
  };
}
export interface DungeonRewardPlanV2 {
  v: 2;
  resolverVersion: number;
  snapshotHash: string;
  atRisk: { shards: number; waifubux: number };
  /** Essence and affection are base amounts, before any Buddy bonus. */
  secured: {
    essence: number;
    affection: number;
    items: Array<{ item: string; quantity: number }>;
    equipment: Array<{ dropId: string; definitionKey: string; rollSeed: number }>;
  };
  lines: DungeonResolvedRewardLine[];
}
/** Exact figures. Probabilities are unrounded fractions in [0, 1]. */
export interface DungeonRewardAnalysis {
  resolverVersion: number;
  snapshotHash: string;
  rewards: Array<{
    reward: DungeonAnalysedReward;
    riskClass: 'at_risk' | 'secured';
    expectedQuantity: number;
    chanceAtLeastOnce: number;
    contributions: Array<DungeonRewardSource & { probability: number; expectedQuantity: number }>;
  }>;
  expectedEquipmentPieces: number;
  chanceAnyEquipment: number;
  equipmentCandidateCount: number;
  noRewardChance: number;
  /** One per resolved slot; a group's choices are alternatives within its pick. */
  sources: Array<
    DungeonRewardSource & {
      rewards: Array<{
        reward: DungeonAnalysedReward;
        probability: number;
        expectedQuantity: number;
      }>;
      noRewardChance: number;
    }
  >;
}
export interface DungeonRewardSimulation {
  kind: 'observed';
  runs: number;
  averages: Array<{
    reward: DungeonAnalysedReward;
    riskClass: 'at_risk' | 'secured';
    averageQuantity: number;
  }>;
  nothingRate: number;
  nothingResults: number;
}
export interface DungeonTestRollResult {
  seed: number;
  /** Null, with `issues`, when the rewards cannot be rolled. */
  roll: DungeonRewardPlanV2 | null;
  analysis: DungeonRewardAnalysis | null;
  issues: DungeonIssue[];
  simulation?: DungeonRewardSimulation;
  items: Record<string, { name: string; category: string }>;
  /** Equipment definitions each selector may choose between; never rolled instances. */
  equipmentPools: Record<
    string,
    Array<{ key: string; name: string; slot: string; rarity: string }>
  >;
}
export type {
  DungeonLootTable,
  DungeonLootTableUsage,
  DungeonLootTableEvent,
  DungeonLootTableValidation,
  DungeonLootTableBody,
  DungeonRewardGrant,
};
/** A Test Roll of one table body. Unsaved content is sent as it stands; nothing is written. */
export interface DungeonTableTestRollInput {
  tableBody: DungeonLootTableBody;
  /** How many times the table is rolled, 1–10. */
  draws: number;
  seed?: number;
  /** 0–10,000 extra observed rolls. */
  simulate?: number;
}
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
export function testRollDungeonLootTable(
  input: DungeonTableTestRollInput,
  signal?: AbortSignal,
): Promise<DungeonTestRollResult> {
  const { tableBody, draws, ...rest } = input;
  return postData(`${base}/test-roll`, { target: { tableBody, draws }, ...rest }, opts(signal));
}
/** A Test Roll of one activity's whole reward bundle, unsaved edits included. Nothing is written. */
export interface DungeonBundleTestRollInput {
  bundle: DungeonRewardBundle;
  seed?: number;
  simulate?: number;
  /** The containing dungeon's currency; null tests a dungeon that has none set. */
  progressionCurrency: string | null;
}
export function testRollDungeonRewards(
  input: DungeonBundleTestRollInput,
  signal?: AbortSignal,
): Promise<DungeonTestRollResult> {
  const { bundle, ...rest } = input;
  return postData(`${base}/test-roll`, { target: { bundle }, ...rest }, opts(signal));
}
