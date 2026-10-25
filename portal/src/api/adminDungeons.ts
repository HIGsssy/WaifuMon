import type { DungeonSpeciesPoolAnalysis, DungeonSpeciesScenario, DungeonSpeciesRef } from './dungeonSpeciesTypes';
export type { DungeonSpeciesPoolAnalysis, DungeonSpeciesPoolOdds, DungeonSpeciesScenario, DungeonSpeciesRef } from './dungeonSpeciesTypes';
import type { SceneSpriteInstance } from './adminDungeonSceneSprites';
import type { SpritePlacement } from './adminArtworkAssets';
/** Phase 1A dungeon authoring API. All calls use the shared authenticated client. */
import type {
  DungeonImportPlan,
  DungeonImportApplyInput,
  DungeonImportResult,
  DungeonLootImportDecisions,
} from './dungeonImportTypes';
export type {
  DungeonLootImportDecision,
  DungeonLootImportDecisions,
  DungeonLootImportTablePlan,
  DungeonImportEquipmentChange,
  DungeonImportPlan,
  DungeonImportDecisions,
  DungeonImportApplyInput,
  DungeonImportResult,
} from './dungeonImportTypes';
import type { ArtworkDirectory, ArtworkSearchResults } from './adminArtwork';
import type { DungeonRewardGrant } from './adminDungeonLootTables';
import { apiClient, getData, postData, putData } from './client';
import type { DungeonLootTableBody } from './dungeonLootTypes';
import type {
  DungeonEventChoiceView,
  DungeonEventPoolAnalysis,
  DungeonEventPreview,
  DungeonEventScenario,
} from './dungeonEventTypes';
export type {
  DungeonEventChoicePreview,
  DungeonEventChoiceView,
  DungeonEventPoolAnalysis,
  DungeonEventPoolOdds,
  DungeonEventPreview,
  DungeonEventScenario,
} from './dungeonEventTypes';

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
/** New-format activity rewards: what a fight or treasure pays once, on success. */
export interface DungeonRewardBundle {
  guaranteed: Array<{ id: string; grant: DungeonRewardGrant }>;
  /** Each rolls on its own; 1–9999 basis points. */
  chances: Array<{ id: string; chanceBasisPoints: number; grant: DungeonRewardGrant }>;
  /** Dungeon loot tables by key, each rolled `draws` times (1–10). */
  tables: Array<{ id: string; table: string; draws: number }>;
}
/**
 * Dungeon Events (Phase 3). The editor changes only the member an author
 * edits and spreads the rest, so an event or pool is carried through a save
 * with every other member exactly as it was loaded, including any this mirror
 * does not name.
 */
export type DungeonEventEffect =
  | { type: 'set_flag'; flag: string; value: boolean }
  | { type: 'heal' | 'damage'; basisPoints: number };
export interface DungeonEventOutcome {
  text?: string;
  tone?: 'good' | 'neutral' | 'bad';
  effects?: DungeonEventEffect[];
  rewards?: DungeonRewardBundle;
  then?:
    | { type: 'next' | 'room_complete' | 'retreat' }
    | { type: 'end_run'; outcome: 'completed' | 'defeated' };
}
export interface DungeonEventChoice {
  id: string;
  label: string;
  description?: string;
  requires?: DungeonCondition;
  items?: Array<{ item: string; quantity?: number; consume?: boolean }>;
  unavailableText?: string;
  hideWhenUnavailable?: boolean;
  /** One result, or a skill check with a success and a failure. */
  outcome?: DungeonEventOutcome;
  check?: { type: 'sp'; baseChanceBasisPoints: number; maxSpModifierBasisPoints?: number };
  success?: DungeonEventOutcome;
  failure?: DungeonEventOutcome;
}
export interface DungeonEvent {
  id: string;
  title: string;
  text: string;
  artwork?: DungeonArtworkRef | null;
  choices: DungeonEventChoice[];
}
export type DungeonEventPoolEntry = { id: string; weight: number; when?: DungeonCondition } & (
  { eventId: string; oncePerRun?: boolean } | { nothing: true; text?: string }
);
export interface DungeonEventPool {
  id: string;
  name: string;
  entries: DungeonEventPoolEntry[];
}
export type DungeonSpeciesPoolEntry = { id: string; weight: number; when?: DungeonCondition } & (
  { species: string; oncePerRun?: boolean } | { nothing: true; text?: string }
);
export interface DungeonSpeciesPool { id: string; name: string; entries: DungeonSpeciesPoolEntry[] }
/** This dungeon's own terms for one species. `perPlayerLimit` is per player, from this dungeon, across runs. */
export interface DungeonSpeciesPolicyEntry { species: string; perPlayerLimit: number | 'unlimited'; directRescue?: boolean }
export type DungeonEventSource =
  { kind: 'event'; eventId: string } | { kind: 'pool'; poolId: string };

export interface DungeonAction {
  sceneSprites?: SceneSpriteInstance[];
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
  /** Legacy treasure reward. A treasure carries this or `rewards`, never both. */
  reward?: DungeonReward;
  rewards?: DungeonRewardBundle;
  /** An `event` activity: which event, or which pool, it presents. */
  source?: DungeonEventSource | { kind: 'species'; species: string };
  intro?: string;
  mode?: 'capture' | 'direct';
  capture?: { maxAttempts: number; allowedItems?: string[]; allowGuaranteedItems: boolean };
  placement?: SpritePlacement;
  mirror?: boolean;
  results?: Record<string, { text?: string; flags?: Array<{ flag: string; value: boolean }> }>;
  [field: string]: unknown;
}
export interface DungeonRoom {
  sceneSprites?: SceneSpriteInstance[];
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
  settings: {
    progressionCurrency: string | null;
    defeatCurrencyRetentionBasisPoints: number;
    /** Absent: abandoning keeps what defeat keeps. */
    abandonCurrencyRetentionBasisPoints?: number;
  };
  flags: Array<{ key: string; scope: 'run' | 'player'; description?: string }>;
  /** The dungeon's events and random pools. Absent in a dungeon that has none. */
  events?: DungeonEvent[];
  eventPools?: DungeonEventPool[];
  /** Dungeon-local pools, using the backend species/Nothing union. */
  speciesPools?: DungeonSpeciesPool[];
  /** Species access: one entry per species this dungeon admits or limits. Absent when none. */
  speciesPolicies?: DungeonSpeciesPolicyEntry[];
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
export type DungeonRewardDependencyChange =
  | {
      kind: 'table';
      tableKey: string;
      name: string;
      status: 'changed' | 'missing' | 'archived' | 'invalid';
      publishedHash: string | null;
      currentHash: string | null;
    }
  | {
      kind: 'equipment';
      selectorKey: string;
      description: string;
      status: 'changed' | 'empty';
      added: string[];
      removed: string[];
    };
export interface DungeonPublishedInfo {
  revisionId: number;
  number: number;
  contentHash: string;
  /** Null when the revision has no new-format rewards. */
  gameplayHash?: string | null;
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
  sceneSpritesDiffer?: boolean;
  speciesDiffer?: boolean;
  /** Reward dependency reporting (T6): the draft's loot against what the published revision pinned. */
  draftGameplayHash?: string | null;
  dependenciesDiffer?: boolean;
  dependencyChanges?: DungeonRewardDependencyChange[];
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
  sceneSpriteSnapshot?: Record<string, unknown> | null;
  content: DungeonDefinition;
  layout: DungeonLayout;
  rewardSnapshot?: Record<string, unknown> | null;
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
  /** Odds of every event pool, worked out by the server's own draw rules. Absent from an older server. */
  eventPools?: DungeonEventPoolAnalysis[];
  speciesPools?: DungeonSpeciesPoolAnalysis[];
  /** Every event's choices as a player in the scenario would meet them. */
  eventPreviews?: DungeonEventPreview[];
}
export interface DungeonRegionRef {
  id: string;
  name: string;
  enabled: boolean;
}
export interface DungeonReferenceData {
  lootTables: Array<{
    key: string;
    name: string;
    tier: 'common' | 'rare' | 'boss' | 'legendary' | null;
    archived: boolean;
    contentHash: string;
  }>;
  items: Array<{
    slug: string;
    name: string;
    category: string;
    enabled: boolean;
    maxOwned: number | null;
  }>;
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
export function planDungeonImport(
  pkg: unknown,
  signal?: AbortSignal,
  lootTables?: DungeonLootImportDecisions,
): Promise<DungeonImportPlan> {
  return postData(
    `${base}/import/plan`,
    { package: pkg, ...(lootTables ? { lootTables } : {}) },
    opts(signal),
  );
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
// ── Legacy treasure conversion and published reward health (T15B) ──

export interface DungeonTreasureTarget {
  roomId: string;
  actionId: string;
}
export interface DungeonLegacyReward {
  rewardTable: string | null;
  equipmentRewardTable: string | null;
  currency: { min: number; max: number };
}
export interface DungeonConversionTable {
  /** The expedition reward table it was made from. */
  sourceTable: string;
  sourceContentHash: string;
  /** How many times the treasure rolls it. */
  draws: number;
  /** `reuse`: an identical converted table already exists and is used as it is. */
  action: 'create' | 'reuse';
  key: string;
  name: string;
  description: string;
  body: DungeonLootTableBody;
  contentHash: string;
}
export interface DungeonConversionBlocker {
  code: string;
  table: string | null;
  message: string;
}
export interface DungeonTreasureConversionPlan extends DungeonTreasureTarget {
  dungeonKey: string;
  roomName: string;
  draftRevision: number;
  legacy: DungeonLegacyReward;
  /** Null while a blocker stands. */
  rewards: DungeonRewardBundle | null;
  tables: DungeonConversionTable[];
  omitted: Array<{
    table: string | null;
    reason: 'never_paid' | 'disabled' | 'cannot_drop';
    text: string;
  }>;
  blockers: DungeonConversionBlocker[];
  /** What the converted treasure would still need before it can be published. */
  issues: DungeonIssue[];
  waifubuxAtRisk: boolean;
  retention: { defeatBasisPoints: number; abandonBasisPoints: number };
  /** Names exactly this plan; applying anything else is refused. */
  planHash: string;
}
export interface DungeonTreasureConversionResult {
  dungeon: DungeonDetail;
  createdTables: string[];
  reusedTables: string[];
  /** The plan had already been applied; nothing was written this time. */
  replayed: boolean;
}
export function planTreasureConversion(
  key: string,
  target: DungeonTreasureTarget,
  signal?: AbortSignal,
): Promise<DungeonTreasureConversionPlan> {
  return postData(`${definitionUrl(key)}/treasure-conversion/plan`, target, opts(signal));
}
export function convertTreasure(
  key: string,
  input: DungeonTreasureTarget & { expectedRevision: number; expectedPlanHash: string },
): Promise<DungeonTreasureConversionResult> {
  return postData(`${definitionUrl(key)}/treasure-conversion/apply`, input);
}

export interface DungeonRewardHealthProblem {
  type: 'item' | 'equipment' | 'snapshot';
  reason: string;
  /** Item or gear key; null for the frozen copy itself. Not a label. */
  key: string | null;
  name: string;
  message: string;
  hint: string;
}
/** Worth knowing, not a broken reward: an event choice needs an item that is gone or disabled. */
export interface DungeonRewardHealthNotice {
  type: 'event_item';
  reason: string;
  key: string;
  name: string;
  message: string;
  hint: string;
}
export interface DungeonRewardHealthEntry {
  key: string;
  name: string;
  enabled: boolean;
  revision: number | null;
  status: 'healthy' | 'broken' | 'no_rewards' | 'unpublished';
  problems: DungeonRewardHealthProblem[];
  /** Informational; never changes `status`. Absent from an older server. */
  notices?: DungeonRewardHealthNotice[];
  /** Errors in the draft: they block the next publish and do not affect players. */
  draftErrors: number;
  /** Runs in progress on the published revision. */
  activeRuns: number;
  /** Older revisions that runs in progress are still on, newest first. Counts only. */
  activeRevisions: DungeonRewardHealthActiveRevision[];
}
export interface DungeonRewardHealthActiveRevision {
  revision: number;
  activeRuns: number;
  status: 'healthy' | 'broken' | 'no_rewards';
  problems: DungeonRewardHealthProblem[];
  notices?: DungeonRewardHealthNotice[];
}
export function getDungeonRewardHealth(
  signal?: AbortSignal,
): Promise<{ dungeons: DungeonRewardHealthEntry[] }> {
  return getData(`${base}/reward-health`, opts(signal));
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
  eventScenario?: DungeonEventScenario,
  speciesScenario?: DungeonSpeciesScenario,
): Promise<DungeonValidation> {
  return postData(
    `${base}/validate`,
    { definition, ...(eventScenario ? { eventScenario } : {}), ...(speciesScenario ? { speciesScenario } : {}) },
    opts(signal),
  );
}

// ── Sandbox: a run played by the real engine that changes nothing ──

export type DungeonSandboxInput =
  | { type: 'advance' | 'decline' | 'extract' | 'abandon' | 'capture' | 'rescue' | 'leave_encounter' | 'dismiss_encounter' }
  | { type: 'select_item'; item: string }
  | { type: 'move'; connectionId: string }
  | { type: 'choose'; choiceId: string };
export interface DungeonSandboxEventView {
  eventId: string;
  title: string;
  text: string;
  artwork: DungeonArtworkRef | null;
  /** Choices a player would see; hidden unavailable ones are already left out. */
  choices: DungeonEventChoiceView[];
}
export interface DungeonSandboxView {
  status: string;
  step: number;
  hp: number;
  maxHp: number;
  room: { id: string; name: string; description: string; kind: 'room' | 'exit' };
  phase: 'action' | 'connections' | 'ended';
  action: {
    id: string;
    type: string;
    label: string;
    optional: boolean;
    wave: { index: number; count: number; enemy: { name?: string } } | null;
    event?: DungeonSandboxEventView | null;
    encounter?: DungeonSandboxEncounter | null;
  } | null;
  connections: Array<{
    id: string;
    label: string;
    toRoomName: string;
    toRoomCompleted: boolean;
    open: boolean;
    lockedText: string;
  }>;
  canExtract: boolean;
  stuck: boolean;
  flags: Record<string, boolean>;
  recent: Array<{ kind: string; [field: string]: unknown }>;
  end: { outcome: string; cause: string } | null;
}
export type DungeonSandboxEffect =
  | { type: 'capture_attempt'; species: string; attempt: { n: number; item: string; chance: number; roll: number; success: boolean }; consumesMicrodose: boolean }
  | { type: 'rescue_grant'; species: string }
  | { type: 'consume_items'; items: Array<{ item: string; quantity: number }> }
  | { type: 'grant_rewards'; plan: Record<string, unknown> }
  | { type: 'settle_run' };
export interface DungeonSandboxResult {
  view: DungeonSandboxView;
  /** Everything the run would have done to the world. None of it was carried out. */
  effects: DungeonSandboxEffect[];
  eventResults: Array<{
    roomId: string;
    actionId: string;
    eventTitle: string;
    choiceLabel: string;
    text: string;
    tone: 'good' | 'neutral' | 'bad';
  }>;
  steps: number;
  stoppedBy: 'ended' | 'stuck' | 'max_steps' | 'refused' | null;
  refusal: string | null;
  encounterDiagnostics?: Array<{ species: string; name: string; available: boolean; reason: string | null; directReason: string | null; acquisitions: number; items: Array<{ item: string; chance: number; owned: number; breakdown: Record<string, unknown> }> }>;
  simulatedGrants?: Array<{ species: string; copies: number; xp: number; item: string | null; success: boolean }>;
}
export interface DungeonSandboxEncounter {
  species: string; name: string; rarity: string | null; intro: string; mode: 'capture' | 'direct';
  available: boolean; unavailableReason: string | null; selectedItem: string | null; attemptsLeft: number;
  items: Array<{ item: string; owned: number; guaranteed: boolean; chance: number }>;
}
export interface DungeonEncounterScenario {
  acquisitions?: Record<string, number>;
  disabledSpecies?: string[];
  ownedSpecies?: string[];
  captureOutcome?: 'normal' | 'success' | 'failure';
  flags?: string[];
  completedRooms?: string[];
}
/**
 * Plays an unsaved definition from its start through `inputs`. The same
 * request always plays out the same way; nothing is granted, spent or stored.
 */
export function playDungeonSandbox(
  input: {
    definition: DungeonDefinition;
    seed: number;
    inputs: DungeonSandboxInput[];
    inventory: Record<string, number>;
    currentSp: number;
    encounterScenario?: DungeonEncounterScenario;
  },
  signal?: AbortSignal,
): Promise<DungeonSandboxResult> {
  const { currentSp, ...body } = input;
  return postData(
    `${base}/sandbox`,
    { ...body, fighter: { ...SANDBOX_FIGHTER, currentSp } },
    opts(signal),
  );
}
/** The stand-in Buddy a sandbox run fights with; the server's own default stats. */
const SANDBOX_FIGHTER = { attack: 60, defense: 30, maxHp: 400 };
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
  input: { enemyKey?: string; encounter?: { species: string; placement?: SpritePlacement; mirror?: boolean; stage?: string }; backgrounds: Array<DungeonArtworkRef | null>; roomSprites?: SceneSpriteInstance[]; activitySprites?: SceneSpriteInstance[] },
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

/** Policy stays on the server; metadata only, no player data or writes. */
export function getDungeonSpecies(dungeonKey: string, signal?: AbortSignal): Promise<{ species: DungeonSpeciesRef[] }> {
  return getData(`${base}/species`, { params: { dungeonKey }, ...opts(signal) });
}
export function getDungeonCaptureItems(signal?: AbortSignal): Promise<{ items: Array<{ slug: string; name: string; enabled: boolean; guaranteed: boolean; rarities: string[] | null }> }> {
  return getData(`${base}/capture-items`, opts(signal));
}
export interface DungeonDiscordEncounterPreview {
  simulated: boolean; context: string;
  embeds: Array<{ title?: string; description?: string; fields?: Array<{ name: string; value: string }> }>;
  components: Array<{ components: Array<{ label?: string; placeholder?: string; disabled?: boolean; options?: Array<{ label: string; description?: string }> }> }>;
}
export function previewDungeonEncounter(input: { definition: DungeonDefinition; roomId: string; actionId: string; species?: string; stage: string }, signal?: AbortSignal): Promise<DungeonDiscordEncounterPreview> {
  return postData(`${base}/encounter-preview`, input, opts(signal));
}
export interface DungeonSpeciesRevisionStatus {
  revision: number; revisionId: number; current: boolean; activeRuns: number;
  evidence: 'recorded' | 'unknown'; differs: boolean | null;
  dependencies: Array<{ slug: string; changes: string[]; liveRestriction: string | null; directRestriction: string | null }>;
}
export function getDungeonSpeciesStatus(key: string, signal?: AbortSignal): Promise<{ revisions: DungeonSpeciesRevisionStatus[] }> {
  return getData(`${definitionUrl(key)}/species-status`, opts(signal));
}
export async function dungeonSpeciesArtworkBlob(slug: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(`${base}/species/artwork`, { params: { slug, width: 256 }, responseType: 'blob' });
  return response.data;
}
