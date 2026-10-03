/**
 * Portal admin API client for dungeon zones, the progression currency and the
 * generation preview.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/dungeons.ts`. A zone travels as the
 * document `content/dungeons/zones.json` holds, with every default spelled
 * out. Every write names the `revision` it edited; a save that lost a race
 * comes back as a 409 `DUNGEON_ZONE_STALE` rather than overwriting.
 */
import { getData, postData, putData } from './client';

export type DungeonNodeType =
  'combat' | 'elite' | 'event' | 'reward' | 'rest' | 'miniboss' | 'boss' | 'exit';
export const DUNGEON_NODE_TYPES: readonly DungeonNodeType[] = [
  'combat',
  'elite',
  'event',
  'reward',
  'rest',
  'miniboss',
  'boss',
  'exit',
];
/** Types placed by weight. A boss is placed structurally, as the final node. */
export type DungeonWeightedNodeType = Exclude<DungeonNodeType, 'boss'>;
export const DUNGEON_WEIGHTED_NODE_TYPES: readonly DungeonWeightedNodeType[] = [
  'combat',
  'elite',
  'event',
  'reward',
  'rest',
  'miniboss',
  'exit',
];

export type DungeonEnemyPoolKey = 'combat' | 'elite' | 'miniboss' | 'boss';
export type DungeonPoolKey = DungeonEnemyPoolKey | 'event';
export const DUNGEON_POOL_KEYS: readonly DungeonPoolKey[] = [
  'combat',
  'elite',
  'miniboss',
  'boss',
  'event',
];

export type DungeonZoneOrigin = 'shipped' | 'edited' | 'custom';

export interface DungeonZoneIssue {
  /** `pools.combat[2].enemyKey`, `generation.minNodes`, `generation`… */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface DepthRange {
  minDepth: number;
  /** Null is open-ended. */
  maxDepth: number | null;
}

export interface DungeonPoolEntryDoc extends DepthRange {
  id: string;
  enabled: boolean;
  weight: number;
  tags: string[];
  enemyKey?: string;
  eventKey?: string;
}

export interface AmountRange {
  min: number;
  max: number;
}

export interface DungeonRewardBandDoc extends DepthRange {
  id: string;
  enabled: boolean;
  /** Empty means every node type. */
  nodeTypes: DungeonNodeType[];
  rewardTable: string | null;
  equipmentRewardTable: string | null;
  currency: AmountRange;
}

export interface DungeonBonusDoc {
  currency: AmountRange;
  rewardTable: string | null;
}

/** `required` must be placeable in every run; an optional one is skipped when the run has no room. */
export interface DungeonExtractionWindow {
  minDepth: number;
  maxDepth: number | null;
  required: boolean;
}

export interface DungeonGenerationDoc {
  minNodes: number;
  maxNodes: number;
  branching: {
    minBranches: number;
    maxBranches: number;
    chanceBasisPoints: number;
    maxLength: number;
  };
  extraction: {
    minDepth: number;
    nodeTypes: DungeonNodeType[];
    minPoints: number;
    /** Depth windows that each hold a guaranteed main-path extraction point. */
    windows?: DungeonExtractionWindow[];
  };
  nodeWeights: Record<DungeonWeightedNodeType, number>;
  boss: { required: boolean };
  depthRanges: Partial<Record<DungeonNodeType, DepthRange>>;
  required: Array<{ types: DungeonNodeType[]; min: number }>;
  limits: Array<{ types: DungeonNodeType[]; max: number }>;
  noConsecutive: DungeonNodeType[];
  maxConsecutiveSameEnemy: number | null;
}

export interface DungeonZoneDoc {
  /** Stable. Cannot be changed after the zone is created. */
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  order: number;
  artworkPath: string | null;
  backgroundArtworkPath: string | null;
  tags: string[];
  generation: DungeonGenerationDoc;
  /** What a node type does when resolved. `healBasisPoints`: 3000 = 30% of max HP. */
  nodeSettings: { rest: { healBasisPoints: number } };
  pools: Record<DungeonEnemyPoolKey | 'event', DungeonPoolEntryDoc[]>;
  rewards: {
    currencyKey: string;
    /** 2500 = 25%. */
    defeatCurrencyRetentionBasisPoints: number;
    bands: DungeonRewardBandDoc[];
    completion: DungeonBonusDoc;
    extraction: DungeonBonusDoc;
  };
}

export interface DungeonZoneSummary {
  key: string;
  name: string;
  enabled: boolean;
  order: number;
  tags: string[];
  minNodes: number;
  maxNodes: number;
  poolCount: number;
  poolEntryCount: number;
  rewardBandCount: number;
  revision: number;
  origin: DungeonZoneOrigin;
  /** Null when this build ships no zone with this key. */
  matchesShipped: boolean | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface DungeonZoneDetail extends DungeonZoneSummary {
  zone: DungeonZoneDoc;
  /** Problems with the stored zone on this server now (e.g. an enemy since disabled). */
  issues: DungeonZoneIssue[];
}

export interface DungeonContentRef {
  key: string;
  name: string;
  enabled: boolean;
  tags: string[];
}

export interface DungeonReferenceData {
  nodeTypes: DungeonNodeType[];
  enemies: DungeonContentRef[];
  events: DungeonContentRef[];
  rewardTables: Array<{ id: string; enabled: boolean }>;
  currencies: Array<{ key: string; singularName: string; pluralName: string; enabled: boolean }>;
}

export interface ProgressionCurrency {
  /** Stable. Never editable. */
  key: string;
  singularName: string;
  pluralName: string;
  description: string;
  icon: string | null;
  enabled: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ProgressionCurrencyMetadata {
  singularName: string;
  pluralName: string;
  description: string;
  icon: string | null;
  enabled: boolean;
}

export interface DungeonGraphNode {
  id: string;
  depth: number;
  lane: number;
  type: DungeonNodeType;
  /** Edge ids. */
  outgoing: string[];
  content: { kind: 'enemy' | 'event'; key: string } | null;
  source: { pool: string; entryId: string } | null;
  rewardBandId: string | null;
  extraction: boolean;
  terminal: boolean;
  boss: boolean;
}

export interface DungeonGraph {
  format: string;
  generatorVersion: number;
  zoneKey: string;
  seed: number;
  depthCount: number;
  startNodeId: string;
  terminalNodeId: string;
  attempts: number;
  nodes: DungeonGraphNode[];
  edges: Array<{ id: string; from: string; to: string }>;
}

export interface DungeonPreview {
  zoneKey: string;
  seed: number;
  graph: DungeonGraph;
  names: { enemies: Record<string, string>; events: Record<string, string> };
}

export interface DungeonContentAppearance {
  key: string;
  nodes: number;
  runs: number;
  runRate: number;
}

export interface DungeonSimulationReport {
  zoneKey: string;
  firstSeed: number;
  runs: number;
  valid: number;
  invalid: number;
  invalidRate: number;
  failures: Record<string, number>;
  averageAttempts: number;
  averageNodeCount: number;
  minNodeCount: number;
  maxNodeCount: number;
  averageDepth: number;
  nodeTypeCounts: Record<DungeonNodeType, number>;
  nodeTypeShare: Record<DungeonNodeType, number>;
  nodeTypeRunRate: Record<DungeonNodeType, number>;
  branchRate: number;
  averageBranches: number;
  bossRate: number;
  restRate: number;
  extractionRate: number;
  averageExtractionPoints: number;
  enemies: DungeonContentAppearance[];
  events: DungeonContentAppearance[];
}

export interface DungeonZoneExport {
  file: string;
  document: { format: string; version: number; zones: DungeonZoneDoc[] };
}

/** A saved zone by key, or an unsaved draft. */
export type DungeonZoneTarget = { key: string } | { zone: DungeonZoneDoc };

export const DUNGEONS_QUERY_KEY = ['admin', 'dungeons'] as const;
export const MAX_DUNGEON_SEED = 4_294_967_295;

const base = '/v1/admin/dungeons';
const zoneUrl = (key: string) => `${base}/zones/${encodeURIComponent(key)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listDungeonZones(signal?: AbortSignal): Promise<{ zones: DungeonZoneSummary[] }> {
  return getData(`${base}/zones`, opts(signal));
}

export function getDungeonZone(key: string, signal?: AbortSignal): Promise<DungeonZoneDetail> {
  return getData(zoneUrl(key), opts(signal));
}

export function getDungeonReference(signal?: AbortSignal): Promise<DungeonReferenceData> {
  return getData(`${base}/reference`, opts(signal));
}

export function validateDungeonZone(
  zone: DungeonZoneDoc,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<{ issues: DungeonZoneIssue[] }> {
  return postData(`${base}/validate`, key ? { zone, key } : { zone }, opts(signal));
}

export function createDungeonZone(zone: DungeonZoneDoc): Promise<DungeonZoneDetail> {
  return postData(`${base}/zones`, { zone });
}

export function updateDungeonZone(
  key: string,
  zone: DungeonZoneDoc,
  expectedRevision: number,
): Promise<DungeonZoneDetail> {
  return putData(zoneUrl(key), { zone, expectedRevision });
}

export function setDungeonZoneEnabled(
  key: string,
  enabled: boolean,
  expectedRevision: number,
): Promise<DungeonZoneDetail> {
  return putData(`${zoneUrl(key)}/enabled`, { enabled, expectedRevision });
}

export function exportDungeonZones(): Promise<DungeonZoneExport> {
  return getData(`${base}/export`);
}

export function previewDungeon(
  target: DungeonZoneTarget,
  seed?: number,
  signal?: AbortSignal,
): Promise<DungeonPreview> {
  return postData(
    `${base}/preview`,
    seed === undefined ? target : { ...target, seed },
    opts(signal),
  );
}

export function simulateDungeon(
  target: DungeonZoneTarget,
  runs: number,
  firstSeed = 1,
): Promise<DungeonSimulationReport> {
  return postData(`${base}/simulate`, { ...target, runs, firstSeed });
}

/** Delve-wide settings, with the bounds the server enforces. */
export interface DungeonSettings {
  /** Runs a player may start per game day, across all zones. 0 closes Delve to new runs. */
  dailyRunLimit: number;
  dailyRunLimitMin: number;
  dailyRunLimitMax: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function getDungeonSettings(signal?: AbortSignal): Promise<DungeonSettings> {
  return getData(`${base}/settings`, opts(signal));
}

export function updateDungeonSettings(patch: { dailyRunLimit: number }): Promise<DungeonSettings> {
  return putData(`${base}/settings`, patch);
}

export function listProgressionCurrencies(
  signal?: AbortSignal,
): Promise<{ currencies: ProgressionCurrency[] }> {
  return getData(`${base}/currencies`, opts(signal));
}

export function updateProgressionCurrency(
  key: string,
  metadata: ProgressionCurrencyMetadata,
  expectedRevision: number,
): Promise<ProgressionCurrency> {
  return putData(`${base}/currencies/${encodeURIComponent(key)}`, {
    ...metadata,
    expectedRevision,
  });
}
