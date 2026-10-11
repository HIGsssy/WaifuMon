/** Phase 1A dungeon authoring API. All calls use the shared authenticated client. */
import type { ArtworkDirectory, ArtworkSearchResults } from './adminArtwork';
import { apiClient, getData, postData, putData } from './client';

export type DungeonArtworkRef =
  | { kind: 'shipped'; path: string }
  | { kind: 'managed'; category: string; contentHash: string; name?: string };
export type DungeonCondition =
  | { type: 'flag'; flag: string; scope?: 'run' | 'player'; equals?: boolean }
  | { type: 'room_completed'; roomId: string }
  | { type: 'all' | 'any'; conditions: DungeonCondition[] }
  | { type: 'not'; condition: DungeonCondition };
export type ActionDestination =
  | { type: 'next' | 'room_complete' | 'retreat' }
  | { type: 'action'; actionId: string }
  | { type: 'leave'; connectionId: string }
  | { type: 'end_run'; outcome: 'completed' | 'defeated' };
export type CombatWave = {
  enemy: { key: string } | { pool: Array<{ key: string; weight: number }> };
};
export interface DungeonReward {
  rewardTable: string | null;
  equipmentRewardTable: string | null;
  currency: { min: number; max: number };
}
export interface DungeonAction {
  id: string;
  type: string;
  label?: string;
  optional?: boolean;
  when?: DungeonCondition;
  next?: ActionDestination;
  outcomes?: Record<string, ActionDestination>;
  waves?: CombatWave[];
  advance?: 'auto' | 'confirm';
  healBasisPoints?: number;
  requires?: DungeonCondition;
  blockedText?: string;
  flag?: string;
  scope?: 'run' | 'player';
  value?: boolean;
  connectionId?: string;
  reward?: DungeonReward;
  [field: string]: unknown;
}
export interface DungeonRoom {
  id: string;
  name?: string;
  description?: string;
  kind?: 'room' | 'exit';
  extraction?: boolean;
  background?: DungeonArtworkRef | null;
  actions: DungeonAction[];
}
export interface DungeonConnection {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: 'path' | 'shortcut' | 'secret';
  requires?: unknown;
  lockedText?: string;
}
export interface DungeonDefinition {
  key: string;
  name: string;
  description: string;
  availableRegions: string[];
  entranceRoomId: string;
  artwork: DungeonArtworkRef | null;
  background: DungeonArtworkRef | null;
  settings: { progressionCurrency: string | null; defeatCurrencyRetentionBasisPoints: number };
  flags: Array<{ key: string; scope: 'run' | 'player'; description?: string }>;
  rooms: DungeonRoom[];
  connections: DungeonConnection[];
}
export interface DungeonLayout {
  rooms?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  notes?: Array<{ id: string; x: number; y: number; text: string }>;
}
export interface DungeonIssue {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}
export interface DungeonPublishedInfo {
  revisionId: number;
  number: number;
  contentHash: string;
  publishedAt: string;
  publishedBy: string | null;
}
export interface DungeonSummary {
  key: string;
  name: string;
  enabled: boolean;
  position: number;
  roomCount: number;
  draftRevision: number;
  draftHash: string;
  published: DungeonPublishedInfo | null;
  draftDiffers: boolean;
  open: boolean;
  updatedAt: string;
  updatedBy: string | null;
}
export interface DungeonDetail extends DungeonSummary {
  draft: DungeonDefinition;
  layout: DungeonLayout;
  issues: DungeonIssue[];
}
export interface DungeonRevision extends DungeonPublishedInfo {
  source: string;
  draftRevision: number;
  current: boolean;
  activeRuns: number;
}
export interface DungeonRevisionDetail extends DungeonRevision {
  content: DungeonDefinition;
  layout: DungeonLayout;
}
export interface DungeonPublishResult {
  dungeon: DungeonDetail;
  revision: DungeonRevision;
  unchanged: boolean;
}
export interface DungeonContentEvent {
  id: number;
  dungeonKey: string;
  action: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface DungeonValidation {
  definition: DungeonDefinition | null;
  contentHash: string | null;
  issues: DungeonIssue[];
  publishable: boolean;
}
export interface DungeonRegionRef {
  id: string;
  name: string;
  enabled: boolean;
}
export interface DungeonReferenceData {
  actionTypes: string[];
  reservedActionTypes: Record<string, string>;
  enemies: Array<{
    key: string;
    name: string;
    enabled: boolean;
    attack: number;
    defense: number;
    hp: number;
    /** A transparent combat sprite is configured: fights compose it over the background. */
    sprite?: boolean;
    /** Full artwork is configured: what a fight shows when there is no usable sprite. */
    artwork?: boolean;
  }>;
  rewardTables: Array<{ id: string; enabled: boolean }>;
  currencies: Array<{ key: string; singularName: string; pluralName: string; enabled: boolean }>;
  regions: DungeonRegionRef[];
}
export interface DungeonPackage {
  format: 'waifumon-dungeon-package';
  schemaVersion: number;
  dungeon: DungeonDefinition;
  [field: string]: unknown;
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
  issues: DungeonIssue[];
  publishable: boolean;
}
export interface DungeonImportDecisions {
  dungeon: 'create' | 'replace' | 'unchanged';
  enemies: Record<string, 'create' | 'use_existing' | 'leave_missing'>;
  allowMissingDependencies: boolean;
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
  issues: DungeonIssue[];
  publishable: boolean;
  replayed: boolean;
}
export interface DungeonImportHistory {
  imports: Array<{
    id: number;
    packageId: string;
    packageHash: string;
    sourceEnvironment: string;
    dungeonKey: string;
    actor: string | null;
    importedAt: string;
    decisions: Record<string, unknown>;
    result: Record<string, unknown>;
  }>;
}
export const DUNGEONS_QUERY_KEY = ['admin', 'dungeons'] as const;
const base = '/v1/admin/dungeons';
const definitionUrl = (key: string) => `${base}/definitions/${encodeURIComponent(key)}`;
const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
export function planDungeonImport(pkg: unknown, signal?: AbortSignal): Promise<DungeonImportPlan> {
  return postData(`${base}/import/plan`, { package: pkg }, opts(signal));
}
export function applyDungeonImport(input: DungeonImportApplyInput): Promise<DungeonImportResult> {
  return postData(`${base}/import/apply`, input);
}
export function getDungeonImportHistory(
  key: string,
  signal?: AbortSignal,
): Promise<DungeonImportHistory> {
  return getData(`${definitionUrl(key)}/import-history`, opts(signal));
}
export function listDungeons(signal?: AbortSignal): Promise<{ dungeons: DungeonSummary[] }> {
  return getData(`${base}/definitions`, opts(signal));
}
export function getDungeon(key: string, signal?: AbortSignal): Promise<DungeonDetail> {
  return getData(definitionUrl(key), opts(signal));
}
export function getDungeonReference(signal?: AbortSignal): Promise<DungeonReferenceData> {
  return getData(`${base}/reference`, opts(signal));
}
export function createDungeon(
  definition: DungeonDefinition,
  layout?: DungeonLayout,
): Promise<DungeonDetail> {
  return postData(`${base}/definitions`, {
    definition,
    ...(layout === undefined ? {} : { layout }),
  });
}
export function saveDungeonDraft(
  key: string,
  input: { definition?: DungeonDefinition; layout?: DungeonLayout; expectedRevision: number },
): Promise<DungeonDetail> {
  return putData(`${definitionUrl(key)}/draft`, input);
}
export function validateDungeon(
  definition: DungeonDefinition,
  signal?: AbortSignal,
): Promise<DungeonValidation> {
  return postData(`${base}/validate`, { definition }, opts(signal));
}
export function setDungeonEnabled(key: string, enabled: boolean): Promise<DungeonDetail> {
  return putData(`${definitionUrl(key)}/enabled`, { enabled });
}
export function listDungeonRevisions(
  key: string,
  signal?: AbortSignal,
): Promise<{ revisions: DungeonRevision[] }> {
  return getData(`${definitionUrl(key)}/revisions`, opts(signal));
}
export function getDungeonRevision(
  key: string,
  number: number,
  signal?: AbortSignal,
): Promise<DungeonRevisionDetail> {
  return getData(`${definitionUrl(key)}/revisions/${number}`, opts(signal));
}
export function publishDungeon(
  key: string,
  expectedRevision: number,
): Promise<DungeonPublishResult> {
  return postData(`${definitionUrl(key)}/publish`, { expectedRevision });
}
export function rollbackDungeon(key: string, revision: number): Promise<DungeonPublishResult> {
  return postData(`${definitionUrl(key)}/rollback`, { revision });
}
export function getDungeonHistory(
  key: string,
  signal?: AbortSignal,
): Promise<{ events: DungeonContentEvent[] }> {
  return getData(`${definitionUrl(key)}/history`, opts(signal));
}
export function exportDungeonPackage(
  key: string,
  origin: 'draft' | 'published' | { revision: number } = 'draft',
): Promise<DungeonPackage> {
  return getData(`${definitionUrl(key)}/export`, {
    params: typeof origin === 'string' ? { origin } : origin,
  });
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

/**
 * Bytes of the uploaded image a dungeon reference resolves to on this server,
 * found the way a run finds it. 404 when players would not get it either.
 */
export async function managedDungeonArtworkBlob(
  category: string,
  contentHash: string,
): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/artwork/managed`, {
    params: { category, contentHash },
    responseType: 'blob',
  });
  return response.data;
}

/** One preview source string per reference, so a preview reloads exactly when the reference changes. */
export const dungeonArtworkSource = (ref: DungeonArtworkRef | null | undefined): string | null =>
  !ref
    ? null
    : ref.kind === 'shipped'
      ? `shipped:${ref.path}`
      : `managed:${ref.category}:${ref.contentHash}`;
export interface DungeonScenePreview {
  image: Blob;
  /** `sprite`: the enemy's combat sprite on a background. `full-art`: no usable sprite, so its full artwork. */
  mode: 'sprite' | 'full-art';
  /** Which of the offered backgrounds was used (its index), or the plain stage when none could be. */
  background: number | 'plain' | null;
}
/**
 * The picture a fight against one enemy shows, composed by the same renderer
 * a run uses. `backgrounds` are in fallback order (room, dungeon background,
 * dungeon artwork). Rejects with a 404 when the enemy has nothing to show.
 */
export async function previewDungeonScene(
  input: { enemyKey: string; backgrounds: Array<DungeonArtworkRef | null> },
  signal?: AbortSignal,
): Promise<DungeonScenePreview> {
  const response = await apiClient.post<Blob>(`${base}/scene-preview`, input, {
    responseType: 'blob',
    ...(signal ? { signal } : {}),
  });
  const used = String(response.headers['x-dungeon-scene-background'] ?? '');
  return {
    image: response.data,
    mode: response.headers['x-dungeon-scene'] === 'full-art' ? 'full-art' : 'sprite',
    background: used === 'plain' ? 'plain' : used === '' ? null : Number(used),
  };
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
