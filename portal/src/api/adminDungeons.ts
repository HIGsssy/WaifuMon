/**
 * Portal admin API client for dungeon zones, the progression currency and the
 * generation preview.
 *
 * Maps 1:1 to `src/api/routes/v1/admin/dungeons.ts`. A zone travels as the
 * document `content/dungeons/zones.json` holds, with every default spelled
 * out. Every write names the `revision` it edited; a save that lost a race
 * comes back as a 409 `DUNGEON_ZONE_STALE` rather than overwriting.
 */
import type { ArtworkDirectory, ArtworkSearchResults } from './adminArtwork';
import type { SpritePlacement } from './adminArtworkAssets';
import type { EnemyRef } from './adminEnemies';
import { apiClient, getData, postData, putData } from './client';

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

/**
 * How a zone's runs are laid out: `procedural` generates a fresh graph per run
 * from the generator's rules; `authored` walks the rooms an admin built.
 * Absent on a zone saved before the choice existed, which is procedural.
 */
export type DungeonLayoutMode = 'procedural' | 'authored';
export const layoutModeOf = (zone: { layoutMode?: DungeonLayoutMode }): DungeonLayoutMode =>
  zone.layoutMode ?? 'procedural';

/** Ways on from one authored room. */
export const DUNGEON_MAX_ROOM_EXITS = 3;
export const DUNGEON_MAX_ROOMS = 40;

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

/**
 * Rest placement. `minNodes` is counted on the main path, `maxNodes` over the
 * whole run (null: no limit). With `beforeBoss` the node before the final boss
 * is always a rest that no branch can bypass — and it counts toward both.
 */
export interface DungeonRestRules {
  minNodes: number;
  maxNodes: number | null;
  minDepth: number;
  maxDepth: number | null;
  beforeBoss: boolean;
}

export const NO_REST_RULES: DungeonRestRules = {
  minNodes: 0,
  maxNodes: null,
  minDepth: 1,
  maxDepth: null,
  beforeBoss: false,
};

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
  /** A fixed opening: every run's first room is this type. Null or absent leaves it to the weights. */
  firstNodeType?: DungeonWeightedNodeType | null;
  /** Where and how often rests appear. Absent on a zone saved before rest rules existed. */
  rest?: DungeonRestRules;
  depthRanges: Partial<Record<DungeonNodeType, DepthRange>>;
  required: Array<{ types: DungeonNodeType[]; min: number }>;
  limits: Array<{ types: DungeonNodeType[]; max: number }>;
  noConsecutive: DungeonNodeType[];
  maxConsecutiveSameEnemy: number | null;
}

/** One background a zone's nodes may be drawn against: a managed asset or a shipped path. */
export interface DungeonBackgroundDoc extends DepthRange {
  id: string;
  enabled: boolean;
  weight: number;
  /** A managed (uploaded) asset id — exactly one of this and `artworkPath` is set. */
  assetId: string | null;
  artworkPath: string | null;
}

/** What one authored room pays, in place of the zone's default rewards. */
export interface DungeonRoomRewardDoc {
  rewardTable: string | null;
  equipmentRewardTable: string | null;
  currency: AmountRange;
}

/** A room's own picture of its enemy. Each field alone: null uses the enemy's default. */
export interface DungeonRoomSceneDoc {
  spriteAssetId: string | null;
  artworkAssetId: string | null;
  spritePlacement: SpritePlacement | null;
}

/**
 * One room of a room-by-room dungeon. Everything optional inherits: no
 * `reward` pays the dungeon's default, no `healBasisPoints` heals the
 * dungeon's default, no background uses the dungeon's, no `scene` uses the
 * enemy's own artwork.
 */
export interface DungeonRoomDoc {
  /** Stable within the dungeon; other rooms point at it. */
  id: string;
  name: string;
  type: DungeonNodeType;
  /** Ids of the rooms this one leads to. Empty on the final room. */
  next: string[];
  enemyKey: string | null;
  eventKey: string | null;
  reward: DungeonRoomRewardDoc | null;
  healBasisPoints: number | null;
  extraction: boolean;
  backgroundAssetId: string | null;
  backgroundArtworkPath: string | null;
  scene: DungeonRoomSceneDoc | null;
  notes: string;
}

export interface DungeonAuthoredLayoutDoc {
  startRoomId: string | null;
  rooms: DungeonRoomDoc[];
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
  /** Uploaded overrides of the two paths above. Absent on a zone saved before managed artwork existed. */
  artworkAssetId?: string | null;
  backgroundAssetId?: string | null;
  /** Backgrounds a run's nodes draw from, by weight within a depth range. */
  backgrounds?: DungeonBackgroundDoc[];
  tags: string[];
  /** Region ids the zone can be started in. Absent on a zone saved before regions existed. */
  availableRegions?: string[];
  layoutMode?: DungeonLayoutMode;
  /** The hand-built rooms. Kept, unused, on a procedural zone. */
  authored?: DungeonAuthoredLayoutDoc;
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
  layoutMode?: DungeonLayoutMode;
  /** Rooms a run walks, shortest to longest. */
  minNodes: number;
  maxNodes: number;
  /** Rooms in a room-by-room layout; null for a procedural zone. */
  roomCount?: number | null;
  /** The zone cover, for a thumbnail. */
  artworkAssetId?: string | null;
  artworkPath?: string | null;
  poolCount: number;
  poolEntryCount: number;
  rewardBandCount: number;
  availableRegions: string[];
  revision: number;
  origin: DungeonZoneOrigin;
  /** Null when this build ships no zone with this key. */
  matchesShipped: boolean | null;
  updatedAt: string;
  updatedBy: string | null;
  /**
   * `all_enabled_regions`: the zone predates region availability and was
   * opened in every enabled region to keep it available — review its regions.
   */
  regionBackfill?: 'shipped' | 'all_enabled_regions' | null;
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
  /**
   * Every enemy as a picker shows it — stats, tags and the artwork in effect.
   * The same rows the Enemy Catalogue serves, readable with `dungeons.read`.
   */
  enemies: EnemyRef[];
  events: DungeonContentRef[];
  rewardTables: Array<{ id: string; enabled: boolean }>;
  currencies: Array<{ key: string; singularName: string; pluralName: string; enabled: boolean }>;
  /** The region catalogue, in its authored order. `enabled: false` is not released. */
  regions: DungeonRegionRef[];
}

export interface DungeonRegionRef {
  id: string;
  name: string;
  enabled: boolean;
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
  /** Set on nodes that came from an authored room. */
  roomId?: string;
  name?: string;
  reward?: DungeonRoomRewardDoc;
  restHealBasisPoints?: number;
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
  /** How the graph was made. A room-by-room graph is the same for every seed. */
  layoutMode?: DungeonLayoutMode;
  seed: number;
  graph: DungeonGraph;
  names: { enemies: Record<string, string>; events: Record<string, string> };
  /** What this graph did with the zone's structural rules, read off the graph by the server. */
  structure: DungeonPreviewStructure;
}

export interface DungeonPreviewStructure {
  availableRegions: Array<{ id: string; name: string | null }>;
  artworkPath: string | null;
  backgroundArtworkPath: string | null;
  artworkAssetId?: string | null;
  backgroundAssetId?: string | null;
  /** The background each node drew for this seed — what a real run would snapshot. */
  scenes?: {
    version: number;
    nodes: Record<
      string,
      { background: { entryId: string; assetId: string | null; artworkPath: string | null } | null }
    >;
  };
  restNodes: Array<{ id: string; depth: number; extraction: boolean }>;
  extractionNodes: Array<{ id: string; depth: number; type: DungeonNodeType }>;
  bossNodeId: string | null;
  restBeforeBoss: { required: boolean; satisfied: boolean };
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
  /** Valid runs by rest count / extraction-point count: `{ "1": 34, "2": 66 }`. */
  restCountDistribution: Record<string, number>;
  extractionCountDistribution: Record<string, number>;
  /** Share of valid runs whose node before the final one is a rest no route can skip. */
  restBeforeBossRate: number;
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

/**
 * `confirmLayoutChange` must be passed for a save that changes the zone's
 * layout mode — the server refuses such a save without it.
 */
export function updateDungeonZone(
  key: string,
  zone: DungeonZoneDoc,
  expectedRevision: number,
  options: { confirmLayoutChange?: boolean } = {},
): Promise<DungeonZoneDetail> {
  return putData(zoneUrl(key), {
    zone,
    expectedRevision,
    ...(options.confirmLayoutChange ? { confirmLayoutChange: true } : {}),
  });
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

/** Where zone artwork conventionally lives, relative to the assets root. */
export const zoneArtworkConvention = (key: string) => `dungeons/zones/${key || '<zone-key>'}.webp`;
export const zoneBackgroundConvention = (key: string) =>
  `dungeons/backgrounds/${key || '<zone-key>'}.webp`;

/** Bytes of one authored artwork path, for the editor preview. 404 when no file is there. */
export async function dungeonArtworkBlob(path: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/artwork`, {
    params: { path },
    responseType: 'blob',
  });
  return response.data;
}

/** One folder of dungeon artwork for the picker (`dungeons/` only, server-chosen). */
export function browseDungeonArtwork(
  path: string | undefined,
  signal?: AbortSignal,
): Promise<ArtworkDirectory> {
  return getData<ArtworkDirectory>(`${base}/artwork/browse`, {
    params: path ? { path } : {},
    ...(signal ? { signal } : {}),
  });
}

export function searchDungeonArtwork(
  query: string,
  signal?: AbortSignal,
): Promise<ArtworkSearchResults> {
  return getData<ArtworkSearchResults>(`${base}/artwork/search`, {
    params: { q: query },
    ...(signal ? { signal } : {}),
  });
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
