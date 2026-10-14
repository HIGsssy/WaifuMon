import type { DungeonAuthoringSpecies } from './engine/speciesAuthoring';
import { dungeonSpeciesPolicy } from './dungeonSpeciesPolicy';
import { dungeonSpeciesUnavailableReason } from './validation/dungeonEncounterValidation';
import { dungeonEncounterPackageIssues } from './validation/dungeonEncounterValidation';
import { loadDungeonEncounterValidationSource, type DungeonSpeciesAccessLookup } from './dungeonSpeciesPolicy';
import { sceneSpriteCatalogue, freezeSceneSprites, readSceneSpriteSnapshot, pinnedSceneSpriteCatalogue } from './sceneSprites/sceneSpriteSnapshot';
import { hasSceneSprites } from './sceneSprites/sceneSpriteDefinition';
/**
 * Dungeon authoring: drafts, publication, rollback, audit and export.
 *
 * ## Lifecycle
 *
 *   draft      one per dungeon, mutable, guarded by `draftRevision`: a save
 *              names the revision it edited and is refused (`DungeonDraftStaleError`)
 *              if someone else got there first. A draft must have a readable
 *              shape, but it may carry validation errors — it is work in
 *              progress.
 *   publish    an explicit act with its own permission. It re-validates the
 *              draft against this server with errors blocking, then writes an
 *              **immutable** revision and moves the published pointer to it.
 *              Nothing else publishes: not a save, not (later) an import.
 *   rollback   moves the pointer to an earlier revision. No content is copied.
 *
 * Players only ever meet a published revision, and a run names the one it
 * started on (`dungeonRunService`), so a publish or a rollback changes what
 * *new* runs get and never touches a run in progress.
 *
 * ## Two documents
 *
 * The gameplay definition and the editor layout are stored, saved and
 * exported side by side and hashed apart: `draftHash` covers the definition
 * only. A layout-only save bumps `draftRevision` (it is the lock) and leaves
 * the hash alone.
 *
 * ## Reward snapshots
 *
 * A definition that uses v2 `rewards` depends on things outside itself: loot
 * table bodies, which equipment a selector matches, items. Publishing pins
 * those in the revision (`rewardSnapshot`, `content/dungeonRewardSnapshot.ts`)
 * and compares `gameplayHash` (content hash + snapshot hash), so an edited
 * table or a change in eligible gear publishes as a new revision although the
 * definition has not changed, and no stored revision ever changes under a
 * catalogue edit. `contentHash` keeps meaning the definition alone. A
 * definition with no v2 rewards has neither field and behaves as it always did.
 * Rollback reuses the target's own snapshot and checks only that what it
 * names can still be paid.
 *
 * ## Audit
 *
 * Every write appends to `dungeon_content_events` in its own transaction.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  artworkAssets,
  dungeonContentEvents,
  dungeonDefinitions,
  dungeonLootTableEvents,
  dungeonLootTables,
  dungeonRevisions,
  dungeonRuns,
  items,
  species,
  progressionCurrencies,
  rewardTables,
  type DungeonContentEventAction,
  type DungeonDefinitionRow,
  type DungeonRevisionRow,
  type DungeonRevisionSource,
} from '../../db/schema';
import {
  DungeonConversionError,
  DungeonDraftStaleError,
  DungeonInvalidError,
  type DungeonIssueDetail,
  DungeonKeyTakenError,
  DungeonNotFoundError,
  DungeonRevisionNotFoundError,
  uniqueViolationConstraint,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { ArtworkStorage } from '../artworkAssets/artworkStorage';
import { resolveEnemyVisual, type ManagedEnemyArtwork } from '../artworkAssets/enemyArtworkService';
import { managedArtworkIndex, managedArtworkKey, resolveManagedArtworkIds } from '../artworkAssets/managedArtworkLookup';
import { createDungeonImportService, type DungeonImportService } from './package/dungeonImportService';
import { loadDungeonRewardContext, loadSnapshotLiveDependencies, type DungeonRewardSnapshotLiveDependencies } from './dungeonRewardContext';
import {
  DungeonRewardSnapshotSchema,
  dungeonGameplayHash,
  dungeonRewardDependencyChanges,
  hasDungeonRewardBundles,
  readDungeonRewardSnapshot,
  resolveDungeonRewardDependencies,
  type DungeonRewardDependencyChange,
  type DungeonRewardSnapshot,
} from './content/dungeonRewardSnapshot';
import { dungeonDependencies, dungeonRequiredItems, dungeonUsesEvents } from './content/dungeonDefinition';
import { equipmentSelectorKey } from '../equipment/rewardSelector';
import { buildPreviewRewardSnapshot, previewRewardContext, testRollDungeonRewards, type DungeonTestRollRequest, type DungeonTestRollResult } from './dungeonRewardPreview';
import { assertDungeonRewardDependencies } from './dungeonRewardValidation';
import { dungeonLootTableContentHash } from './dungeonLootTableService';
import {
  convertLegacyTreasure,
  type LegacyTableSource,
  type TreasureConversion,
  type TreasureConversionTable,
} from './dungeonTreasureConversion';
import { canonicalJson } from '../rewardTables/rewardTableCore';
import type { RewardSpec } from './content/dungeonDefinition';
import type { DungeonRewardBundle } from './content/dungeonRewards';
import {
  DUNGEON_ACTION_TYPES,
  DungeonDefinitionSchema,
  RESERVED_ACTION_TYPES,
  type DungeonDefinition,
} from './content/dungeonDefinition';
import { DungeonLayoutSchema, EMPTY_DUNGEON_LAYOUT, pruneDungeonLayout, type DungeonLayout } from './content/dungeonLayout';
import { validateDungeonRewards } from './validation/dungeonRewardValidation';
import { buildDungeonPackage, dungeonContentHash, type DungeonPackage } from './package/dungeonPackage';
import {
  hasErrors,
  validateDungeonDefinition,
  type DungeonIssue,
  type DungeonValidationContext,
} from './validation/dungeonValidation';

/** Keys the admin routes use as path segments; a dungeon cannot be called one. */
export const RESERVED_DUNGEON_KEYS: ReadonlySet<string> = new Set([
  'reference',
  'export',
  'validate',
  'sandbox',
  'settings',
  'currencies',
  'artwork',
  'import',
  'definitions',
]);

export interface DungeonPublishedInfo {
  revisionId: number;
  number: number;
  contentHash: string;
  /** Content hash plus the pinned reward snapshot's; null when the revision has no v2 rewards. */
  gameplayHash: string | null;
  publishedAt: Date;
  publishedBy: string | null;
}

export interface DungeonSummary {
  sceneSpritesDiffer?: boolean;
  key: string;
  name: string;
  enabled: boolean;
  position: number;
  roomCount: number;
  draftRevision: number;
  draftHash: string;
  published: DungeonPublishedInfo | null;
  /** The draft's definition differs from the published revision's. Reward dependencies are reported apart. */
  draftDiffers: boolean;
  /**
   * The gameplay hash publishing the draft now would write. Null when the
   * draft has no v2 rewards, or while a reward dependency is missing,
   * archived, unreadable or matches no equipment.
   */
  draftGameplayHash: string | null;
  /**
   * The published revision's definition is the draft's, yet its pinned
   * rewards are not what the catalogues hold now: publishing would write a
   * new revision (or is blocked by a broken dependency, see `dependencyChanges`).
   */
  dependenciesDiffer: boolean;
  /** What changed under the draft's rewards since publication, and any dependency that is broken now. */
  dependencyChanges: DungeonRewardDependencyChange[];
  /** Enabled and published: players can start runs. */
  open: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface DungeonDetail extends DungeonSummary {
  draft: DungeonDefinition;
  layout: DungeonLayout;
  issues: DungeonIssue[];
}

export interface DungeonRevisionSummary {
  revisionId: number;
  number: number;
  contentHash: string;
  gameplayHash: string | null;
  source: DungeonRevisionSource;
  draftRevision: number;
  publishedAt: Date;
  publishedBy: string | null;
  /** The revision new runs start on. */
  current: boolean;
  activeRuns: number;
}

export interface DungeonRevisionDetail extends DungeonRevisionSummary {
  sceneSpriteSnapshot?: ReturnType<typeof readSceneSpriteSnapshot>;
  content: DungeonDefinition;
  layout: DungeonLayout;
  /** The reward dependencies the revision pinned when it was published; null without v2 rewards. */
  rewardSnapshot: DungeonRewardSnapshot | null;
}

export interface DungeonContentEvent {
  id: number;
  dungeonKey: string;
  action: DungeonContentEventAction;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface DungeonReferenceData {
  actionTypes: readonly string[];
  reservedActionTypes: Readonly<Record<string, string>>;
  enemies: {
    key: string;
    name: string;
    enabled: boolean;
    attack: number;
    defense: number;
    hp: number;
    /** A transparent combat sprite is configured (managed or shipped): fights compose it over the background. */
    sprite: boolean;
    /** Full artwork is configured: what a fight shows when there is no usable sprite. */
    artwork: boolean;
  }[];
  rewardTables: { id: string; enabled: boolean }[];
  currencies: { key: string; singularName: string; pluralName: string; enabled: boolean }[];
  regions: { id: string; name: string; enabled: boolean }[];
}

export interface DungeonValidationReport {
  /** The definition with defaults applied; null when its shape could not be read. */
  definition: DungeonDefinition | null;
  contentHash: string | null;
  issues: DungeonIssue[];
  publishable: boolean;
}

export interface DungeonPublishResult {
  dungeon: DungeonDetail;
  revision: DungeonRevisionSummary;
  /** The draft was already what is published; no new revision was written. */
  unchanged: boolean;
}

/** Which legacy treasure a conversion is about. */
export interface DungeonTreasureTarget {
  roomId: string;
  actionId: string;
}

/**
 * What converting one legacy treasure would do, as the catalogues stand.
 * Nothing is written to make it. `planHash` names exactly this plan: applying
 * is refused unless the same plan comes out again inside the transaction.
 */
export interface DungeonTreasureConversionPlan extends DungeonTreasureTarget {
  dungeonKey: string;
  roomName: string;
  draftRevision: number;
  /** The treasure as it is stored now. */
  legacy: RewardSpec;
  /** The reward bundle the treasure would get; null while a blocker stands. */
  rewards: DungeonRewardBundle | null;
  /** The dungeon loot tables the bundle draws from: new ones to create, identical ones to reuse. */
  tables: TreasureConversionTable[];
  omitted: TreasureConversion['omitted'];
  blockers: TreasureConversion['blockers'];
  /** What the converted treasure would still need fixing before it can be published. */
  issues: DungeonIssue[];
  /** The converted rewards include WaifuBux, which stop being paid immediately. */
  waifubuxAtRisk: boolean;
  retention: { defeatBasisPoints: number; abandonBasisPoints: number };
  planHash: string;
}

export interface DungeonTreasureConversionResult {
  dungeon: DungeonDetail;
  createdTables: string[];
  reusedTables: string[];
  /** This plan had already been applied; nothing was written this time. */
  replayed: boolean;
}

export type DungeonRewardHealthReason =
  | 'item_missing'
  | 'item_capped'
  | 'equipment_missing'
  | 'snapshot_missing'
  | 'snapshot_unreadable'
  | 'snapshot_unsupported'
  | 'snapshot_corrupt'
  | 'revision_unreadable';
export interface DungeonRewardHealthProblem {
  type: 'item' | 'equipment' | 'snapshot';
  reason: DungeonRewardHealthReason;
  /** Item slug or equipment definition key; null for the snapshot itself. */
  key: string | null;
  name: string;
  message: string;
  hint: string;
}
/**
 * Something worth knowing that is **not** a broken reward: an item an event
 * choice needs is gone or disabled, so players will find that choice
 * unavailable. Nothing fails to be delivered, and the status does not change.
 */
export interface DungeonRewardHealthNotice {
  type: 'event_item';
  reason: 'item_missing' | 'item_disabled';
  /** The item slug. */
  key: string;
  name: string;
  message: string;
  hint: string;
}
export interface DungeonRewardHealthEntry {
  key: string;
  name: string;
  enabled: boolean;
  /** The published revision checked; null while unpublished. */
  revision: number | null;
  /**
   * `healthy`: every frozen reward can still be delivered. `broken`: at least
   * one cannot. `no_rewards`: the revision has no frozen dungeon rewards to
   * check (legacy treasure reads its tables when a run starts).
   */
  status: 'healthy' | 'broken' | 'no_rewards' | 'unpublished';
  problems: DungeonRewardHealthProblem[];
  /** Informational findings about the published revision; never part of `status`. */
  notices: DungeonRewardHealthNotice[];
  /** Errors in the draft. They block the next publish and do not affect players. */
  draftErrors: number;
  /** Runs in progress on the published revision above. */
  activeRuns: number;
  /**
   * Older revisions that runs in progress are still pinned to, newest first.
   * A revision nobody is playing is not listed: it promises nothing to anyone.
   */
  activeRevisions: DungeonRewardHealthActiveRevision[];
}
/** An earlier revision with runs still in progress, and whether it can pay what it promised them. */
export interface DungeonRewardHealthActiveRevision {
  revision: number;
  /** How many runs are in progress on it. A count only: no player is named. */
  activeRuns: number;
  status: 'healthy' | 'broken' | 'no_rewards';
  problems: DungeonRewardHealthProblem[];
  notices: DungeonRewardHealthNotice[];
}
export interface DungeonRewardHealthReport {
  dungeons: DungeonRewardHealthEntry[];
}

/** Which content an export carries. */
export type DungeonExportOrigin = 'draft' | 'published' | { revision: number };

/** A published revision as a run starts on it. */
export interface PublishedDungeon {
  row: DungeonDefinitionRow;
  revision: DungeonRevisionRow;
  definition: DungeonDefinition;
  /** The revision's pinned reward snapshot; null without v2 rewards. Not read by gameplay yet. */
  rewards: DungeonRewardSnapshot | null;
}

export interface DungeonContentService extends DungeonImportService {
  list(): Promise<DungeonSummary[]>;
  get(key: string): Promise<DungeonDetail | null>;
  reference(): Promise<DungeonReferenceData>;
  /** Live read-only catalogue for pool authoring; no player data. */
  speciesCatalogue(dungeonKey: string): Promise<DungeonAuthoringSpecies[]>;
  /** The active managed asset a dungeon artwork reference means here, as a run would resolve it; null when none. */
  resolveManagedArtwork(ref: { category: string; contentHash: string }): Promise<string | null>;
  /** Dry run against this server. Writes nothing. */
  validate(definition: unknown): Promise<DungeonValidationReport>;
  /** Ephemeral authoring snapshot; never persisted or granted. An explicit snapshot pins published rewards. */
  previewRewards(definition: unknown, options?: { tables?: Record<string, unknown>; snapshot?: DungeonRewardSnapshot | null }): Promise<DungeonValidationReport & { rewards: DungeonRewardSnapshot | null }>;
  testRoll(input: DungeonTestRollRequest): Promise<DungeonTestRollResult>;
  /**
   * Preview converting one legacy treasure to dungeon rewards. Writes nothing.
   * @throws {DungeonNotFoundError | DungeonConversionError}
   */
  planTreasureConversion(key: string, target: DungeonTreasureTarget): Promise<DungeonTreasureConversionPlan>;
  /**
   * Create the converted loot tables and replace the treasure's `reward` with
   * `rewards` in the draft, in one transaction. Nothing is published.
   * @throws {DungeonNotFoundError | DungeonDraftStaleError | DungeonConversionError | DungeonInvalidError}
   */
  convertTreasure(
    key: string,
    input: DungeonTreasureTarget & { expectedRevision: number; expectedPlanHash: string },
    actor: string | null,
  ): Promise<DungeonTreasureConversionResult>;
  /** Whether each dungeon's published rewards can still be delivered. Reads only. */
  rewardHealth(): Promise<DungeonRewardHealthReport>;
  /** @throws {DungeonInvalidError | DungeonKeyTakenError} */
  create(input: { definition: unknown; layout?: unknown }, actor: string | null): Promise<DungeonDetail>;
  /**
   * Save the draft, the layout, or both.
   * @throws {DungeonNotFoundError | DungeonInvalidError | DungeonDraftStaleError}
   */
  saveDraft(
    key: string,
    input: { definition?: unknown; layout?: unknown; expectedRevision: number },
    actor: string | null,
  ): Promise<DungeonDetail>;
  /**
   * Publish the draft as a new immutable revision.
   * @throws {DungeonNotFoundError | DungeonInvalidError | DungeonDraftStaleError}
   */
  publish(key: string, input: { expectedRevision: number }, actor: string | null): Promise<DungeonPublishResult>;
  /**
   * Point the dungeon at an earlier published revision.
   * @throws {DungeonNotFoundError | DungeonRevisionNotFoundError | DungeonInvalidError}
   */
  rollback(key: string, input: { revision: number }, actor: string | null): Promise<DungeonPublishResult>;
  /** @throws {DungeonNotFoundError} */
  setEnabled(key: string, enabled: boolean, actor: string | null): Promise<DungeonDetail>;
  revisions(key: string): Promise<DungeonRevisionSummary[] | null>;
  revision(key: string, number: number): Promise<DungeonRevisionDetail | null>;
  history(key: string, limit?: number): Promise<DungeonContentEvent[]>;
  /** @throws {DungeonNotFoundError | DungeonRevisionNotFoundError} */
  exportPackage(key: string, origin: DungeonExportOrigin, actor: string | null): Promise<DungeonPackage>;

  // ── runtime ───────────────────────────────────────────────────────────────
  /** Every dungeon players can start: enabled, published. In list order. */
  openDungeons(tx?: DbOrTx): Promise<PublishedDungeon[]>;
  /** One dungeon's published revision, or why there is none to play. */
  published(tx: DbOrTx, key: string): Promise<PublishedDungeon | 'missing' | 'unpublished' | 'disabled'>;
  /** The revision a run is pinned to. */
  revisionById(
    tx: DbOrTx,
    revisionId: number,
  ): Promise<{ revision: DungeonRevisionRow; definition: DungeonDefinition; rewards: DungeonRewardSnapshot | null } | null>;
  /** What validation needs to know about this server. */
  validationContext(tx?: DbOrTx): Promise<DungeonValidationContext>;
}

export interface DungeonContentServiceDeps {
  db: Db;
  enemies: {
    definitions(tx?: DbOrTx): Promise<CombatEnemyDefinition[]>;
    /** Definitions with their managed artwork. Optional: a caller with only `definitions` reports no artwork. */
    snapshot?(tx?: DbOrTx): Promise<{ definitions: CombatEnemyDefinition[]; artwork: Record<string, ManagedEnemyArtwork> }>;
  };
  /** Regions, from loaded content. */
  getRegions: () => readonly { id: string; name: string; enabled: boolean }[];
  /** Where shipped artwork lives; omitted, shipped paths are not checked. */
  assetsDir?: string | undefined;
  /** Written into exported packages: `staging`, `production`, `development`. */
  environment?: string | undefined;
  getItemSlugs?: (() => readonly string[]) | undefined;
  /**
   * A species' `dungeonAccess` from loaded content: which dungeons may offer a
   * restricted species, per-player limits and direct-rescue permission.
   * Absent, no species lists any dungeon, so only untagged species pass.
   */
  getSpeciesAccess?: DungeonSpeciesAccessLookup | undefined;
  artworkStorage?: Pick<ArtworkStorage, 'exists'> | undefined;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> | undefined;
}

function parseStoredDefinition(key: string, raw: unknown): DungeonDefinition {
  const parsed = DungeonDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DungeonInvalidError(
      parsed.error.issues.map((i) => ({ code: 'schema', severity: 'error' as const, path: i.path.join('.'), message: `stored dungeon "${key}": ${i.message}` })),
    );
  }
  return parsed.data;
}

/** A revision's pinned snapshot as stored. Shape only: the row is immutable and was hashed when written. */
function parseStoredRewardSnapshot(revision: DungeonRevisionRow): DungeonRewardSnapshot | null {
  if (revision.rewardSnapshot == null) return null;
  const parsed = DungeonRewardSnapshotSchema.safeParse(revision.rewardSnapshot);
  if (!parsed.success) {
    throw new DungeonInvalidError(
      parsed.error.issues.map((i) => ({
        code: 'reward_snapshot_invalid',
        severity: 'error' as const,
        path: ['rewardSnapshot', ...i.path].join('.'),
        message: `stored dungeon "${revision.dungeonKey}" revision ${revision.number}: ${i.message}`,
      })),
    );
  }
  return parsed.data;
}

/**
 * What a rollback may rely on from a revision published with v2 rewards: its
 * own snapshot. Validation reads the pinned tables, pools and items instead
 * of the live catalogue, so a table edited, archived or deleted since does
 * not matter; `snapshotLiveIssues` checks the rows a payout still needs.
 */
function snapshotRewardContext(
  snapshot: DungeonRewardSnapshot,
  liveItems?: DungeonValidationContext['items'],
): Pick<DungeonValidationContext, 'lootTables' | 'items' | 'resolveEquipmentSelector'> {
  return {
    lootTables: new Map(
      Object.entries(snapshot.tables).map(([key, t]) => [key, { name: t.name, body: t.body, archivedAt: null, tier: t.tier, revision: t.sourceRevision }]),
    ),
    // The pinned reward items, as promised. Items an event choice *requires* were never pinned — the
    // slug is their identity — so those are judged against the live catalogue the caller read.
    items: new Map([
      ...(liveItems ?? []),
      ...Object.entries(snapshot.items).map(([slug, item]) => [slug, { ...item, enabled: true, maxOwned: null }] as const),
    ]),
    resolveEquipmentSelector: (selector) => (snapshot.equipmentPools[equipmentSelectorKey(selector)] ?? []).map((c) => ({ ...c, enabled: true })),
  };
}

/** Design 9.2: every pinned item must still exist and be uncapped, every pinned equipment definition must still exist. */
function snapshotLiveProblems(
  snapshot: DungeonRewardSnapshot,
  live: DungeonRewardSnapshotLiveDependencies,
): (DungeonRewardHealthProblem & { path: string; code: string })[] {
  const problems: (DungeonRewardHealthProblem & { path: string; code: string })[] = [];
  for (const [slug, pinned] of Object.entries(snapshot.items)) {
    const item = live.items.get(slug);
    const path = `rewardSnapshot.items.${slug}`;
    if (!item) {
      problems.push({
        type: 'item', reason: 'item_missing', code: 'reward_item_missing', key: slug, name: pinned.name, path,
        message: `item "${pinned.name}" (${slug}) no longer exists, so this revision's loot cannot be paid.`,
        hint: 'Create the item again under the same key, or replace it in the draft\'s rewards and publish again.',
      });
    } else if (item.maxOwned !== null) {
      problems.push({
        type: 'item', reason: 'item_capped', code: 'reward_item_capped', key: slug, name: item.name, path,
        message: `"${item.name}" is now limited to ${item.maxOwned} per player, so it cannot be dungeon loot.`,
        hint: 'Remove the per-player limit from the item, or replace it in the draft\'s rewards and publish again.',
      });
    }
  }
  for (const [selectorKey, pool] of Object.entries(snapshot.equipmentPools)) {
    for (const candidate of pool) {
      if (live.equipmentKeys.has(candidate.key)) continue;
      problems.push({
        type: 'equipment', reason: 'equipment_missing', code: 'reward_equipment_missing', key: candidate.key, name: candidate.name,
        path: `rewardSnapshot.equipmentPools.${selectorKey}`,
        message: `gear "${candidate.name}" (${candidate.key}) no longer exists, so this revision's loot cannot be paid.`,
        hint: 'Publish the draft again so the revision freezes gear that exists.',
      });
    }
  }
  return problems;
}

function snapshotLiveIssues(
  definition: DungeonDefinition,
  snapshot: DungeonRewardSnapshot,
  live: DungeonRewardSnapshotLiveDependencies,
): DungeonIssue[] {
  const label = `dungeon "${definition.name}" (${definition.key})`;
  return snapshotLiveProblems(snapshot, live).map((p): DungeonIssueDetail => ({ code: p.code, severity: 'error', path: p.path, message: `${label}: ${p.message}` })) as DungeonIssue[];
}

function parseStoredLayout(raw: unknown): DungeonLayout {
  const parsed = DungeonLayoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...EMPTY_DUNGEON_LAYOUT };
}

export function createDungeonContentService(deps: DungeonContentServiceDeps): DungeonContentService {
  const { db } = deps;

  async function validationContext(tx: DbOrTx = db, rewardContext?: DungeonValidationContext): Promise<DungeonValidationContext> {
    const [enemies, tables, currencies, managed, sceneSprites, encounterSource] = await Promise.all([
      deps.enemies.definitions(tx),
      tx.select({ id: rewardTables.tableId, enabled: rewardTables.enabled }).from(rewardTables).where(eq(rewardTables.kind, 'expedition')),
      tx.select({ key: progressionCurrencies.currencyKey, enabled: progressionCurrencies.enabled }).from(progressionCurrencies),
      managedArtworkIndex(tx),
      sceneSpriteCatalogue(tx, deps.artworkStorage),
      // Live species policy and capture items: an encounter is judged at
      // validate, publish and rollback against the catalogue as it stands now.
      loadDungeonEncounterValidationSource(tx, deps.getSpeciesAccess),
    ]);
    const rewards = rewardContext ?? await loadDungeonRewardContext(tx);
    const assetsDir = deps.assetsDir;
    return {
      ...rewards,
      sceneSprites,
      encounterSource,
      enemies: new Map(enemies.map((e) => [e.key, { enabled: e.enabled }])),
      rewardTables: new Map(tables.map((t) => [t.id, { enabled: t.enabled }])),
      currencies: rewardContext?.currencies ?? new Map(currencies.map((c) => [c.key, { enabled: c.enabled }])),
      regions: new Map(deps.getRegions().map((r) => [r.id, { enabled: r.enabled }])),
      // The same lookup a run uses, so a reference is flagged exactly when a player would lose the picture.
      managedArtwork: new Set(managed.keys()),
      shippedArtworkExists: assetsDir
        ? (relative) => {
            const root = path.resolve(assetsDir);
            const file = path.resolve(root, relative);
            return file.startsWith(`${root}${path.sep}`) && fs.existsSync(file);
          }
        : undefined,
    };
  }

  async function audit(
    tx: DbOrTx,
    dungeonKey: string,
    action: DungeonContentEventAction,
    actor: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(dungeonContentEvents).values({ dungeonKey, action, actor, details });
  }

  async function publishedInfo(tx: DbOrTx, row: DungeonDefinitionRow): Promise<DungeonRevisionRow | null> {
    if (row.publishedRevisionId == null) return null;
    const [revision] = await tx.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, row.publishedRevisionId));
    return revision ?? null;
  }

  /**
   * The draft's reward dependencies against `rewards` (the live catalogues),
   * compared with what the published revision pinned. An unreadable draft or
   * stored snapshot reports nothing rather than failing a list.
   */
  function dependencyReport(
    row: DungeonDefinitionRow,
    published: DungeonRevisionRow | null,
    draft: DungeonDefinition | null,
    rewards: DungeonValidationContext,
  ): Pick<DungeonSummary, 'draftGameplayHash' | 'dependenciesDiffer' | 'dependencyChanges'> {
    if (!draft || !hasDungeonRewardBundles(draft)) {
      return {
        draftGameplayHash: null,
        dependenciesDiffer: published != null && published.contentHash === row.draftHash && published.gameplayHash != null,
        dependencyChanges: [],
      };
    }
    const state = resolveDungeonRewardDependencies(draft, rewards);
    const draftGameplayHash = state.snapshot ? dungeonGameplayHash(row.draftHash, state.snapshot.hash) : null;
    return {
      draftGameplayHash,
      dependenciesDiffer: published != null && published.contentHash === row.draftHash && published.gameplayHash !== draftGameplayHash,
      dependencyChanges: dungeonRewardDependencyChanges(published ? readDungeonRewardSnapshot(published.rewardSnapshot) : null, state),
    };
  }

  function sceneSpritesDiffer(definition: DungeonDefinition | null, published: DungeonRevisionRow | null, ctx: DungeonValidationContext): boolean {
    if (!definition || !published) return false;
    try { return (freezeSceneSprites(definition, ctx.sceneSprites ?? new Map())?.hash ?? null) !== (readSceneSpriteSnapshot(published.sceneSpriteSnapshot)?.hash ?? null); }
    catch { return true; }
  }

  function summaryOf(
    row: DungeonDefinitionRow,
    published: DungeonRevisionRow | null,
    rewards: DungeonValidationContext,
    parsedDraft?: DungeonDefinition,
  ): DungeonSummary {
    const draft = row.draft as { name?: unknown; rooms?: unknown };
    const definition = parsedDraft ?? DungeonDefinitionSchema.safeParse(row.draft).data ?? null;
    return {
      key: row.dungeonKey,
      name: typeof draft.name === 'string' ? draft.name : row.dungeonKey,
      enabled: row.enabled,
      position: row.position,
      roomCount: Array.isArray(draft.rooms) ? draft.rooms.length : 0,
      draftRevision: row.draftRevision,
      draftHash: row.draftHash,
      published: published && {
        revisionId: published.id,
        number: published.number,
        contentHash: published.contentHash,
        gameplayHash: published.gameplayHash,
        publishedAt: published.publishedAt,
        publishedBy: published.publishedBy,
      },
      draftDiffers: published == null || published.contentHash !== row.draftHash,
      ...dependencyReport(row, published, definition, rewards),
      ...(definition && (hasSceneSprites(definition) || published?.sceneSpriteSnapshot) ? { sceneSpritesDiffer: sceneSpritesDiffer(definition, published, rewards) } : {}),
      open: row.enabled && published != null,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async function detailOf(tx: DbOrTx, row: DungeonDefinitionRow): Promise<DungeonDetail> {
    const published = await publishedInfo(tx, row);
    const draft = parseStoredDefinition(row.dungeonKey, row.draft);
    const ctx = await validationContext(tx);
    const { issues } = validateDungeonDefinition(draft, ctx);
    return { ...summaryOf(row, published, ctx, draft), draft, layout: parseStoredLayout(row.layout), issues };
  }

  async function lockRow(tx: DbOrTx, key: string): Promise<DungeonDefinitionRow> {
    const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key)).for('update');
    if (!row) throw new DungeonNotFoundError(key);
    return row;
  }

  function requireShape(raw: unknown): DungeonDefinition {
    const { definition, issues } = validateDungeonDefinition(raw);
    if (!definition) throw new DungeonInvalidError(issues);
    return definition;
  }

  function requireLayout(raw: unknown, definition: DungeonDefinition): DungeonLayout {
    const parsed = DungeonLayoutSchema.safeParse(raw ?? EMPTY_DUNGEON_LAYOUT);
    if (!parsed.success) {
      throw new DungeonInvalidError(
        parsed.error.issues.map((i) => ({ code: 'schema', severity: 'error' as const, path: `layout.${i.path.join('.')}`, message: i.message })),
      );
    }
    return pruneDungeonLayout(parsed.data, definition.rooms.map((r) => r.id));
  }

  async function activeRunCounts(tx: DbOrTx, key: string): Promise<Map<number, number>> {
    const rows = await tx
      .select({ revisionId: dungeonRuns.revisionId, n: count() })
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.dungeonKey, key), eq(dungeonRuns.status, 'active')))
      .groupBy(dungeonRuns.revisionId);
    return new Map(rows.map((r) => [r.revisionId, Number(r.n)]));
  }

  function revisionSummary(revision: DungeonRevisionRow, currentId: number | null, active: Map<number, number>): DungeonRevisionSummary {
    return {
      revisionId: revision.id,
      number: revision.number,
      contentHash: revision.contentHash,
      gameplayHash: revision.gameplayHash,
      source: revision.source,
      draftRevision: revision.draftRevision,
      publishedAt: revision.publishedAt,
      publishedBy: revision.publishedBy,
      current: revision.id === currentId,
      activeRuns: active.get(revision.id) ?? 0,
    };
  }

  /**
   * The conversion of one legacy treasure as the catalogues stand in `tx`, and
   * the definition it would leave. With `lock`, the rows it read stay
   * share-locked until the transaction ends.
   */
  async function conversionPlan(
    tx: DbOrTx,
    row: DungeonDefinitionRow,
    target: DungeonTreasureTarget,
    lock: boolean,
  ): Promise<{ plan: DungeonTreasureConversionPlan; definition: DungeonDefinition | null }> {
    const key = row.dungeonKey;
    const draft = parseStoredDefinition(key, row.draft);
    const r = draft.rooms.findIndex((room) => room.id === target.roomId);
    const a = r < 0 ? -1 : draft.rooms[r]!.actions.findIndex((action) => action.id === target.actionId);
    const action = a < 0 ? undefined : draft.rooms[r]!.actions[a];
    if (!action || action.type !== 'reward' || !action.reward || action.rewards) {
      throw new DungeonConversionError('DUNGEON_CONVERSION_UNAVAILABLE', `dungeon "${key}": "${target.roomId}/${target.actionId}" is not a legacy treasure`);
    }
    const legacy = action.reward;
    const ids = [...new Set([legacy.rewardTable, legacy.equipmentRewardTable].filter((id): id is string => id !== null))].sort();
    let sourceQuery = tx
      .select()
      .from(rewardTables)
      .where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, ids)))
      .orderBy(asc(rewardTables.tableId))
      .$dynamic();
    let lootQuery = tx
      .select({ key: dungeonLootTables.tableKey, origin: dungeonLootTables.origin, contentHash: dungeonLootTables.contentHash, archivedAt: dungeonLootTables.archivedAt })
      .from(dungeonLootTables)
      .orderBy(asc(dungeonLootTables.tableKey))
      .$dynamic();
    if (lock) {
      sourceQuery = sourceQuery.for('share');
      lootQuery = lootQuery.for('share');
    }
    const sourceRows = ids.length ? await sourceQuery : [];
    const sources = new Map<string, LegacyTableSource | null>(ids.map((id) => [id, null]));
    for (const source of sourceRows) sources.set(source.tableId, { enabled: source.enabled, definition: source.definition, contentHash: source.contentHash });
    const lootRows = await lootQuery;
    const conversion = convertLegacyTreasure({
      reward: legacy,
      sources,
      lootTables: new Map(lootRows.map((t) => [t.key, { origin: t.origin, contentHash: t.contentHash, archived: t.archivedAt !== null }])),
      hashBody: dungeonLootTableContentHash,
    });

    let definition: DungeonDefinition | null = null;
    let issues: DungeonIssue[] = [];
    if (conversion.rewards) {
      const { reward: _legacy, ...rest } = action;
      const next = {
        ...draft,
        rooms: draft.rooms.map((room, ri) => (ri !== r ? room : { ...room, actions: room.actions.map((other, ai) => (ai !== a ? other : { ...rest, rewards: conversion.rewards! })) })),
      };
      definition = requireShape(next);
      // Checked as it will stand once the new tables exist, without creating them.
      const overrides = previewRewardContext(await validationContext(tx), Object.fromEntries(conversion.tables.map((t) => [t.key, t.body])));
      const prefix = `rooms[${r}].actions[${a}]`;
      issues = [...overrides.issues, ...validateDungeonDefinition(definition, overrides.context).issues].filter((i) => i.path.startsWith(prefix));
    }
    const bodies = conversion.tables.map((t) => t.body);
    const paysWaifubux = bodies.some((body) =>
      [...body.guaranteed, ...body.chances, ...body.pools.flatMap((pool) => pool.entries)].some(
        (entry) => 'grant' in entry && entry.grant.type === 'currency' && entry.grant.currency === 'waifubux',
      ),
    );
    const planHash = `sha256:${createHash('sha256')
      .update(canonicalJson({
        v: 1,
        dungeonKey: key,
        roomId: target.roomId,
        actionId: target.actionId,
        draftRevision: row.draftRevision,
        draftHash: row.draftHash,
        sources: ids.map((id) => ({ id, contentHash: sources.get(id)?.contentHash ?? null, enabled: sources.get(id)?.enabled ?? null })),
        tables: conversion.tables.map((t) => ({ source: t.sourceTable, action: t.action, key: t.key, contentHash: t.contentHash, draws: t.draws })),
        rewards: conversion.rewards,
        blockers: conversion.blockers.map((b) => ({ code: b.code, table: b.table })),
      }))
      .digest('hex')}`;
    return {
      definition,
      plan: {
        dungeonKey: key,
        roomId: target.roomId,
        actionId: target.actionId,
        roomName: draft.rooms[r]!.name,
        draftRevision: row.draftRevision,
        legacy,
        rewards: conversion.rewards,
        tables: conversion.tables,
        omitted: conversion.omitted,
        blockers: conversion.blockers,
        issues,
        waifubuxAtRisk: paysWaifubux,
        retention: {
          defeatBasisPoints: draft.settings.defeatCurrencyRetentionBasisPoints,
          abandonBasisPoints: draft.settings.abandonCurrencyRetentionBasisPoints ?? draft.settings.defeatCurrencyRetentionBasisPoints,
        },
        planHash,
      },
    };
  }

  /**
   * A revision's frozen rewards as stored: the trusted snapshot, the reason it
   * cannot be trusted, or nothing to check (no dungeon rewards). No I/O.
   * `superseded`: runs are still on it but it is no longer what is published,
   * so publishing again cannot help them.
   */
  function readRevisionRewards(
    revision: DungeonRevisionRow,
    superseded: boolean,
  ): { snapshot: DungeonRewardSnapshot } | { problems: DungeonRewardHealthProblem[] } | null {
    const snapshotProblem = (reason: DungeonRewardHealthReason, message: string) => ({
      problems: [{
        type: 'snapshot' as const,
        reason,
        key: null,
        name: `Revision ${revision.number}`,
        message,
        hint: superseded
          ? 'Publishing cannot repair a revision that is already being played. Its runs can still extract or abandon; new runs use the current revision.'
          : 'Publish the draft again to freeze a fresh copy of its rewards. Runs already in progress keep this revision.',
      }],
    });
    const content = DungeonDefinitionSchema.safeParse(revision.content);
    if (!content.success) return snapshotProblem('revision_unreadable', 'The published revision could not be read by this version of the game.');
    if (!hasDungeonRewardBundles(content.data)) return null;
    const raw = revision.rewardSnapshot as { format?: unknown; version?: unknown; resolverVersion?: unknown } | null;
    if (raw == null) return snapshotProblem('snapshot_missing', 'This revision was published without a frozen copy of its rewards, so its loot cannot be paid.');
    const parsed = DungeonRewardSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      const unsupported = raw.version !== 1 || raw.resolverVersion !== 1 || raw.format !== 'waifumon-dungeon-reward-snapshot';
      return unsupported
        ? snapshotProblem('snapshot_unsupported', 'The frozen rewards were written in a format this version of the game cannot resolve.')
        : snapshotProblem('snapshot_unreadable', 'The frozen copy of this revision\'s rewards is damaged and cannot be read.');
    }
    const snapshot = readDungeonRewardSnapshot(raw);
    if (!snapshot || revision.gameplayHash !== dungeonGameplayHash(revision.contentHash, snapshot.hash)) {
      return snapshotProblem('snapshot_corrupt', 'The frozen copy of this revision\'s rewards does not match its recorded hash, so it is not trusted.');
    }
    return { snapshot };
  }

  /** What a trusted snapshot names that can no longer be paid: the rollback rules, one line per item or piece of gear. */
  function liveRewardProblems(
    snapshot: DungeonRewardSnapshot,
    live: DungeonRewardSnapshotLiveDependencies,
    superseded: boolean,
  ): DungeonRewardHealthProblem[] {
    const seen = new Set<string>();
    return snapshotLiveProblems(snapshot, live)
      .filter((problem) => !seen.has(`${problem.type}:${problem.key}`) && seen.add(`${problem.type}:${problem.key}`))
      .map(({ path: _path, code: _code, ...problem }) => ({
        ...problem,
        message: problem.message.replace(/^./, (c) => c.toUpperCase()),
        // Republishing changes what new runs get, never a run already on this revision.
        hint: !superseded
          ? problem.hint
          : problem.reason === 'item_capped'
            ? 'Remove the per-player limit from the item so these runs can be paid. Publishing again does not change a run in progress.'
            : problem.reason === 'item_missing'
              ? 'Create the item again under the same key so these runs can be paid. Publishing again does not change a run in progress.'
              : 'Create the gear again under the same key so these runs can be paid. Publishing again does not change a run in progress.',
      }));
  }

  const service: DungeonContentService = {
    ...createDungeonImportService({ ...deps, loadRewardContext: loadDungeonRewardContext, reservedKeys: RESERVED_DUNGEON_KEYS, resolveManagedArtwork: resolveManagedArtworkIds }),
    validationContext,

    async list() {
      const rows = await db.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
      const publishedIds = rows.flatMap((row) => (row.publishedRevisionId == null ? [] : [row.publishedRevisionId]));
      const revisions = publishedIds.length ? await db.select().from(dungeonRevisions).where(inArray(dungeonRevisions.id, publishedIds)) : [];
      const byId = new Map(revisions.map((r) => [r.id, r]));
      // One read of the loot catalogue, items and rewardable equipment for every dungeon.
      const rewards: DungeonValidationContext = { ...await loadDungeonRewardContext(db), sceneSprites: await sceneSpriteCatalogue(db, deps.artworkStorage) };
      return rows.map((row) => summaryOf(row, row.publishedRevisionId == null ? null : (byId.get(row.publishedRevisionId) ?? null), rewards));
    },

    async get(key) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      return row ? detailOf(db, row) : null;
    },

    async resolveManagedArtwork(ref) {
      return (await managedArtworkIndex(db)).get(managedArtworkKey(ref)) ?? null;
    },

    async speciesCatalogue(dungeonKey) {
      const rows = await db.select().from(species).orderBy(asc(species.name), asc(species.slug));
      return rows.map((row) => {
        const policy = dungeonSpeciesPolicy(row, deps.getSpeciesAccess)!;
        const access = policy.access?.find((a) => a.dungeon === dungeonKey);
        const reason = dungeonSpeciesUnavailableReason(policy, dungeonKey, false);
        const directReason = dungeonSpeciesUnavailableReason(policy, dungeonKey, true);
        return {
          slug: row.slug, name: row.name, rarity: row.rarity, archetype: row.archetype, affinity: row.affinity,
          enabled: row.enabled, regionExclusive: row.tags.includes('region_exclusive'), dungeonExclusive: row.tags.includes('dungeon_exclusive'),
          dungeonAccess: policy.access ?? [], permitted: reason === null, unavailableReason: reason,
          perPlayerLimit: access?.perPlayerLimit ?? null,
          directRescue: { available: directReason === null, reason: directReason },
        };
      });
    },

    async reference() {
      const [catalogue, tables, currencies] = await Promise.all([
        deps.enemies.snapshot ? deps.enemies.snapshot(db) : deps.enemies.definitions(db).then((definitions) => ({ definitions, artwork: {} as Record<string, ManagedEnemyArtwork> })),
        db.select({ id: rewardTables.tableId, enabled: rewardTables.enabled }).from(rewardTables).where(eq(rewardTables.kind, 'expedition')).orderBy(asc(rewardTables.position), asc(rewardTables.tableId)),
        db.select().from(progressionCurrencies).orderBy(asc(progressionCurrencies.currencyKey)),
      ]);
      return {
        actionTypes: DUNGEON_ACTION_TYPES,
        reservedActionTypes: RESERVED_ACTION_TYPES,
        enemies: catalogue.definitions.map((e) => {
          const visual = resolveEnemyVisual(e, catalogue.artwork[e.key]);
          return {
            key: e.key,
            name: e.name,
            enabled: e.enabled,
            attack: e.attack,
            defense: e.defense,
            hp: e.hp,
            sprite: Boolean(visual.spriteAssetId || visual.spriteArtworkPath),
            artwork: Boolean(visual.artworkAssetId || visual.artworkPath),
          };
        }),
        rewardTables: tables,
        currencies: currencies.map((c) => ({ key: c.currencyKey, singularName: c.singularName, pluralName: c.pluralName, enabled: c.enabled })),
        regions: deps.getRegions().map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
      };
    },

    async validate(raw) {
      const { definition, issues } = validateDungeonDefinition(raw, await validationContext());
      return {
        definition,
        contentHash: definition ? dungeonContentHash(definition) : null,
        issues,
        publishable: definition != null && !hasErrors(issues),
      };
    },

    async testRoll(input) {
      return db.transaction(async (tx) => testRollDungeonRewards(input, await loadDungeonRewardContext(tx)),
        { accessMode: 'read only', isolationLevel: 'repeatable read' });
    },

    async planTreasureConversion(key, target) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
        if (!row) throw new DungeonNotFoundError(key);
        return (await conversionPlan(tx, row, target, false)).plan;
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
    },

    async convertTreasure(key, input, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        if (row.draftRevision !== input.expectedRevision) {
          // A retry of a conversion that already went through: report it, write nothing.
          const [done] = await tx
            .select({ details: dungeonContentEvents.details })
            .from(dungeonContentEvents)
            .where(and(
              eq(dungeonContentEvents.dungeonKey, key),
              eq(dungeonContentEvents.action, 'draft_saved'),
              sql`${dungeonContentEvents.details}->'conversion'->>'planHash' = ${input.expectedPlanHash}`,
            ))
            .orderBy(desc(dungeonContentEvents.id))
            .limit(1);
          const applied = done?.details.conversion as { createdTables?: string[]; reusedTables?: string[] } | undefined;
          if (applied) {
            return { dungeon: await detailOf(tx, row), createdTables: applied.createdTables ?? [], reusedTables: applied.reusedTables ?? [], replayed: true };
          }
          throw new DungeonDraftStaleError(key, input.expectedRevision, row.draftRevision, row.updatedBy, row.updatedAt);
        }
        // The source tables and the loot catalogue are share-locked from here to
        // the commit, so the plan recomputed below is the one that gets written.
        const { plan, definition } = await conversionPlan(tx, row, input, true);
        if (plan.blockers.length > 0 || !definition) {
          throw new DungeonConversionError('DUNGEON_CONVERSION_BLOCKED', plan.blockers.map((b) => b.message).join(' '), plan.blockers);
        }
        if (plan.planHash !== input.expectedPlanHash) {
          throw new DungeonConversionError('DUNGEON_CONVERSION_STALE', `dungeon "${key}": the conversion plan is now ${plan.planHash}, not ${input.expectedPlanHash}`);
        }
        const created = plan.tables.filter((t) => t.action === 'create');
        for (const table of created) {
          const [inserted] = await tx
            .insert(dungeonLootTables)
            .values({
              tableKey: table.key,
              name: table.name,
              description: table.description,
              tier: null,
              body: table.body,
              contentHash: table.contentHash,
              origin: 'converted',
              createdBy: actor,
              updatedBy: actor,
            })
            .onConflictDoNothing({ target: dungeonLootTables.tableKey })
            .returning();
          // Someone took the key since the catalogue was read. Never overwrite: plan again.
          if (!inserted) throw new DungeonConversionError('DUNGEON_CONVERSION_STALE', `dungeon "${key}": loot table "${table.key}" was created concurrently`);
          await tx.insert(dungeonLootTableEvents).values({
            tableKey: inserted.tableKey,
            revision: inserted.revision,
            origin: inserted.origin,
            action: 'converted',
            actor,
            previousContentHash: null,
            newContentHash: inserted.contentHash,
            details: { sourceTable: table.sourceTable, sourceContentHash: table.sourceContentHash, dungeonKey: key, roomId: input.roomId, actionId: input.actionId },
          });
        }
        const draftHash = dungeonContentHash(definition);
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({
            draft: definition as unknown as Record<string, unknown>,
            draftHash,
            draftRevision: row.draftRevision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        const createdTables = created.map((t) => t.key);
        const reusedTables = plan.tables.filter((t) => t.action === 'reuse').map((t) => t.key);
        await audit(tx, key, 'draft_saved', actor, {
          draftRevision: updated!.draftRevision,
          contentHash: draftHash,
          previousContentHash: row.draftHash,
          contentChanged: true,
          layoutChanged: false,
          conversion: {
            roomId: input.roomId,
            actionId: input.actionId,
            planHash: plan.planHash,
            createdTables,
            reusedTables,
            sourceTables: plan.tables.map((t) => ({ table: t.sourceTable, contentHash: t.sourceContentHash, lootTable: t.key })),
          },
        });
        deps.logger?.info({ tag: 'dungeons/treasure-converted', dungeonKey: key, roomId: input.roomId, actionId: input.actionId, createdTables, reusedTables, actor }, 'legacy treasure converted');
        return { dungeon: await detailOf(tx, updated!), createdTables, reusedTables, replayed: false };
      });
    },

    async rewardHealth() {
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
        // Every revision somebody is playing, in one grouped read: never a query per run or player.
        const active = await tx
          .select({ revisionId: dungeonRuns.revisionId, n: count() })
          .from(dungeonRuns)
          .where(eq(dungeonRuns.status, 'active'))
          .groupBy(dungeonRuns.revisionId);
        const activeRuns = new Map(active.map((r) => [r.revisionId, Number(r.n)]));
        const publishedIds = new Set(rows.flatMap((row) => (row.publishedRevisionId == null ? [] : [row.publishedRevisionId])));
        // Published revisions, plus only those older ones that still have runs in progress.
        const ids = [...new Set([...publishedIds, ...activeRuns.keys()])];
        const revisions = ids.length ? await tx.select().from(dungeonRevisions).where(inArray(dungeonRevisions.id, ids)) : [];
        const byId = new Map(revisions.map((r) => [r.id, r]));
        const read = new Map(revisions.map((r) => [r.id, readRevisionRewards(r, !publishedIds.has(r.id))]));
        // One read of the items and gear all of those snapshots name between them.
        const snapshots = [...read.values()].flatMap((r) => (r && 'snapshot' in r ? [r.snapshot] : []));
        const live = await loadSnapshotLiveDependencies(tx, {
          items: Object.assign({}, ...snapshots.map((s) => s.items)),
          equipmentPools: Object.fromEntries(snapshots.flatMap((s, i) => Object.entries(s.equipmentPools).map(([key, pool]) => [`${i}:${key}`, pool]))),
        });
        // Items the events of those revisions ask players for. Not rewards: a missing one
        // makes a choice unavailable, which is worth saying and breaks nothing.
        const required = new Map(revisions.map((r) => {
          const parsed = DungeonDefinitionSchema.safeParse(r.content);
          return [r.id, parsed.success ? dungeonRequiredItems(parsed.data) : []] as const;
        }));
        const requiredSlugs = [...new Set([...required.values()].flat())];
        const requiredRows = requiredSlugs.length
          ? await tx.select({ slug: items.slug, name: items.name, enabled: items.enabled }).from(items).where(inArray(items.slug, requiredSlugs))
          : [];
        const requiredItems = new Map(requiredRows.map((r) => [r.slug, r]));
        const noticesOf = (revision: DungeonRevisionRow): DungeonRewardHealthNotice[] =>
          (required.get(revision.id) ?? []).flatMap((slug): DungeonRewardHealthNotice[] => {
            const item = requiredItems.get(slug);
            if (item?.enabled) return [];
            const superseded = !publishedIds.has(revision.id);
            return [{
              type: 'event_item',
              reason: item ? 'item_disabled' : 'item_missing',
              key: slug,
              name: item?.name ?? slug,
              message: item
                ? `An event choice needs “${item.name}”, which is disabled.`
                : `An event choice needs the item “${slug}”, which no longer exists.`,
              hint: superseded
                ? 'Players on this revision see that choice as unavailable; their other choices still work. Restore the item to bring it back for them.'
                : 'Players see that choice as unavailable; their other choices still work. Restore the item, or change the event and publish again.',
            }];
          });
        const judge = (revision: DungeonRevisionRow) => {
          const rewards = read.get(revision.id) ?? null;
          const superseded = !publishedIds.has(revision.id);
          const problems = !rewards ? [] : 'problems' in rewards ? rewards.problems : liveRewardProblems(rewards.snapshot, live, superseded);
          return { problems, notices: noticesOf(revision), status: problems.length > 0 ? 'broken' as const : rewards ? 'healthy' as const : 'no_rewards' as const };
        };
        const ctx = await validationContext(tx);
        const dungeons: DungeonRewardHealthEntry[] = rows.map((row) => {
          const draft = row.draft as { name?: unknown };
          const revision = row.publishedRevisionId == null ? null : (byId.get(row.publishedRevisionId) ?? null);
          return {
            key: row.dungeonKey,
            name: typeof draft.name === 'string' ? draft.name : row.dungeonKey,
            enabled: row.enabled,
            revision: revision?.number ?? null,
            ...(revision ? judge(revision) : { status: 'unpublished' as const, problems: [], notices: [] }),
            draftErrors: validateDungeonDefinition(row.draft, ctx).issues.filter((i) => i.severity === 'error').length,
            activeRuns: revision ? (activeRuns.get(revision.id) ?? 0) : 0,
            activeRevisions: revisions
              .filter((r) => r.dungeonKey === row.dungeonKey && !publishedIds.has(r.id) && activeRuns.has(r.id))
              .sort((x, y) => y.number - x.number)
              .map((r) => ({ revision: r.number, activeRuns: activeRuns.get(r.id)!, ...judge(r) })),
          };
        });
        return { dungeons };
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
    },

    async previewRewards(raw, options = {}) {
      return db.transaction(async (tx) => {
        const ctx = await validationContext(tx);
        const pinned = options.snapshot === undefined ? undefined : readDungeonRewardSnapshot(options.snapshot);
        const overrides = previewRewardContext({ ...ctx, ...(pinned ? snapshotRewardContext(pinned, ctx.items) : {}) }, options.tables);
        const report = validateDungeonDefinition(raw, overrides.context);
        const issues = [...overrides.issues, ...report.issues];
        if (report.definition && hasDungeonRewardBundles(report.definition) && options.snapshot !== undefined && !pinned) {
          throw new DungeonInvalidError([{ code: 'reward_snapshot_invalid', severity: 'error', path: 'rewardSnapshot',
            message: 'This published revision has a missing, invalid or unsupported reward snapshot. Republish its repaired draft.' }]);
        }
        const rewards = report.definition && !hasErrors(issues)
          ? pinned ?? buildPreviewRewardSnapshot(report.definition, overrides.context) : null;
        return { ...report, issues, rewards,
          contentHash: report.definition ? dungeonContentHash(report.definition) : null,
          publishable: report.definition !== null && !hasErrors(issues) };
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
    },

    async create(input, actor) {
      const definition = requireShape(input.definition);
      if (RESERVED_DUNGEON_KEYS.has(definition.key)) {
        throw new DungeonInvalidError([{ code: 'schema', severity: 'error', path: 'key', message: `"${definition.key}" is reserved and cannot be a dungeon key` }]);
      }
      const layout = requireLayout(input.layout, definition);
      try {
        return await db.transaction(async (tx) => {
          const [{ next } = { next: 0 }] = await tx.select({ next: count() }).from(dungeonDefinitions);
          const [row] = await tx
            .insert(dungeonDefinitions)
            .values({
              dungeonKey: definition.key,
              draft: definition as unknown as Record<string, unknown>,
              layout: layout as unknown as Record<string, unknown>,
              draftHash: dungeonContentHash(definition),
              position: Number(next),
              updatedBy: actor,
            })
            .returning();
          await audit(tx, definition.key, 'created', actor, { draftRevision: 1, contentHash: row!.draftHash });
          return detailOf(tx, row!);
        });
      } catch (err) {
        if (uniqueViolationConstraint(err) != null) throw new DungeonKeyTakenError(definition.key);
        throw err;
      }
    },

    async saveDraft(key, input, actor) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE MODE`);
        await tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE MODE`);
        const row = await lockRow(tx, key);
        if (row.draftRevision !== input.expectedRevision) {
          throw new DungeonDraftStaleError(key, input.expectedRevision, row.draftRevision, row.updatedBy, row.updatedAt);
        }
        const definition = input.definition === undefined ? parseStoredDefinition(key, row.draft) : requireShape(input.definition);
        if (definition.key !== key) {
          throw new DungeonInvalidError([{ code: 'schema', severity: 'error', path: 'key', message: `a dungeon's key cannot change ("${key}" → "${definition.key}")` }]);
        }
        const layout = requireLayout(input.layout === undefined ? row.layout : input.layout, definition);
        const draftHash = dungeonContentHash(definition);
        const contentChanged = draftHash !== row.draftHash;
        const layoutChanged = JSON.stringify(layout) !== JSON.stringify(parseStoredLayout(row.layout));
        // Saving what is already stored is not a new revision.
        if (!contentChanged && !layoutChanged) return detailOf(tx, row);
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({
            draft: definition as unknown as Record<string, unknown>,
            layout: layout as unknown as Record<string, unknown>,
            draftHash,
            draftRevision: row.draftRevision + 1,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'draft_saved', actor, {
          draftRevision: updated!.draftRevision,
          contentHash: draftHash,
          previousContentHash: row.draftHash,
          contentChanged,
          layoutChanged,
        });
        return detailOf(tx, updated!);
      });
    },

    async publish(key, input, actor) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE dungeon_scene_sprites IN SHARE MODE`);
        const row = await lockRow(tx, key);
        if (row.draftRevision !== input.expectedRevision) {
          throw new DungeonDraftStaleError(key, input.expectedRevision, row.draftRevision, row.updatedBy, row.updatedAt);
        }
        const definition = parseStoredDefinition(key, row.draft);
        await assertDungeonRewardDependencies(tx, definition);
        const rewards = hasDungeonRewardBundles(definition)
          ? await loadDungeonRewardContext(tx, { lootTableKeys: dungeonDependencies(definition).lootTables, lock: true })
          : undefined;
        const spriteCatalogue = await sceneSpriteCatalogue(tx, deps.artworkStorage, true);
        const ctx = { ...await validationContext(tx, rewards), sceneSprites: spriteCatalogue };
        const { issues } = validateDungeonDefinition(definition, ctx);
        if (hasErrors(issues)) throw new DungeonInvalidError(issues);

        const current = await publishedInfo(tx, row);
        const active = await activeRunCounts(tx, key);
        const contentHash = dungeonContentHash(definition);
        // Built from the rows validation just read, which stay share-locked until
        // this transaction ends: the snapshot is the catalogue as validated.
        // Row locks cannot hold back an equipment definition that does not exist
        // yet. One inserted meanwhile is simply not in this snapshot, exactly as
        // if it had been added after the publish, and is reported afterwards as
        // a dependency change (design 9.2, "Locking and consistency").
        let rewardSnapshot: DungeonRewardSnapshot | null = null;
        if (rewards) {
          rewardSnapshot = resolveDungeonRewardDependencies(definition, rewards).snapshot;
          if (!rewardSnapshot) {
            throw new DungeonInvalidError([{ code: 'reward_snapshot_incomplete', severity: 'error', path: 'rewards', message: `dungeon "${definition.name}" (${key}): its reward dependencies passed validation but could not be pinned` }]);
          }
          rewardSnapshot = DungeonRewardSnapshotSchema.parse(rewardSnapshot);
        }
        const sceneSpriteSnapshot = freezeSceneSprites(definition, spriteCatalogue);
        const gameplayHash = rewardSnapshot ? dungeonGameplayHash(contentHash, rewardSnapshot.hash) : null;
        // With no snapshot on either side this is the content-hash comparison it always was.
        if (current && current.contentHash === contentHash && current.gameplayHash === gameplayHash && (readSceneSpriteSnapshot(current.sceneSpriteSnapshot)?.hash ?? null) === (sceneSpriteSnapshot?.hash ?? null)) {
          return { dungeon: await detailOf(tx, row), revision: revisionSummary(current, current.id, active), unchanged: true };
        }

        // The definition row is locked, so the next number cannot be raced.
        const [latest] = await tx
          .select({ number: dungeonRevisions.number })
          .from(dungeonRevisions)
          .where(eq(dungeonRevisions.dungeonKey, key))
          .orderBy(desc(dungeonRevisions.number))
          .limit(1);
        const [revision] = await tx
          .insert(dungeonRevisions)
          .values({
            dungeonKey: key,
            number: (latest?.number ?? 0) + 1,
            content: definition as unknown as Record<string, unknown>,
            contentHash,
            layout: row.layout,
            source: 'editor',
            draftRevision: row.draftRevision,
            publishedBy: actor,
            rewardSnapshot: rewardSnapshot as Record<string, unknown> | null,
            sceneSpriteSnapshot,
            gameplayHash,
          })
          .returning();
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({ publishedRevisionId: revision!.id })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'published', actor, {
          revision: revision!.number,
          revisionId: revision!.id,
          contentHash,
          draftRevision: row.draftRevision,
          previousRevision: current?.number ?? null,
          ...(sceneSpriteSnapshot ? { sceneSpriteSnapshotHash: sceneSpriteSnapshot.hash, sceneSpriteKeys: Object.keys(sceneSpriteSnapshot.sprites) } : {}),
          warnings: issues.filter((i) => i.severity === 'warning').length,
          ...(rewardSnapshot ? { gameplayHash, rewardSnapshotHash: rewardSnapshot.hash, definitionChanged: current?.contentHash !== contentHash } : {}),
        });
        deps.logger?.info({ tag: 'dungeons/published', dungeonKey: key, revision: revision!.number, contentHash, actor }, 'dungeon published');
        return { dungeon: await detailOf(tx, updated!), revision: revisionSummary(revision!, revision!.id, active), unchanged: false };
      });
    },

    async rollback(key, input, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        const [target] = await tx
          .select()
          .from(dungeonRevisions)
          .where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, input.revision)));
        if (!target) throw new DungeonRevisionNotFoundError(key, input.revision);
        const targetDefinition = parseStoredDefinition(key, target.content);
        await assertDungeonRewardDependencies(tx, targetDefinition);
        const active = await activeRunCounts(tx, key);
        const current = await publishedInfo(tx, row);
        if (current?.id === target.id) {
          return { dungeon: await detailOf(tx, row), revision: revisionSummary(target, target.id, active), unchanged: true };
        }
        // What an old revision names may be gone by now; a rollback must not
        // put a dungeon live that this server can no longer run.
        // A revision with v2 rewards comes back with the snapshot it was
        // published with. It is never rebuilt from today's loot catalogue.
        let snapshot: DungeonRewardSnapshot | null = null;
        if (hasDungeonRewardBundles(targetDefinition)) {
          snapshot = readDungeonRewardSnapshot(target.rewardSnapshot);
          if (!snapshot || target.gameplayHash !== dungeonGameplayHash(target.contentHash, snapshot.hash)) {
            throw new DungeonInvalidError([{
              code: 'reward_snapshot_missing',
              severity: 'error',
              path: 'rewardSnapshot',
              message: `dungeon "${targetDefinition.name}" (${key}) revision ${target.number} has no usable reward snapshot, so its loot cannot be reproduced. Publish the draft again instead of rolling back to it.`,
            }]);
          }
        }
        // T5's dependency locks (items, equipment, currencies) are kept; only the loot tables are no longer read.
        const ctx = await validationContext(tx, snapshot ? await loadDungeonRewardContext(tx, { lootTableKeys: [], lock: true }) : undefined);
        const pinnedSprites = await pinnedSceneSpriteCatalogue(tx, target.sceneSpriteSnapshot, deps.artworkStorage);
        if (hasSceneSprites(targetDefinition) && !readSceneSpriteSnapshot(target.sceneSpriteSnapshot)) throw new DungeonInvalidError([{ code: 'scene_sprite_snapshot_invalid', severity: 'error', path: 'rooms', message: 'This revision has no usable frozen scene sprites. Publish the draft again.' }]);
        ctx.sceneSprites = pinnedSprites;
        const { issues } = validateDungeonDefinition(target.content, snapshot ? { ...ctx, ...snapshotRewardContext(snapshot, ctx.items) } : ctx);
        if (snapshot) issues.push(...snapshotLiveIssues(targetDefinition, snapshot, await loadSnapshotLiveDependencies(tx, snapshot, { lock: true })));
        if (hasErrors(issues)) throw new DungeonInvalidError(issues);
        const [updated] = await tx
          .update(dungeonDefinitions)
          .set({ publishedRevisionId: target.id })
          .where(eq(dungeonDefinitions.dungeonKey, key))
          .returning();
        await audit(tx, key, 'rolled_back', actor, {
          revision: target.number,
          revisionId: target.id,
          contentHash: target.contentHash,
          previousRevision: current?.number ?? null,
          ...(target.gameplayHash ? { gameplayHash: target.gameplayHash } : {}),
        });
        deps.logger?.info({ tag: 'dungeons/rolled-back', dungeonKey: key, revision: target.number, from: current?.number ?? null, actor }, 'dungeon rolled back');
        return { dungeon: await detailOf(tx, updated!), revision: revisionSummary(target, target.id, active), unchanged: false };
      });
    },

    async setEnabled(key, enabled, actor) {
      return db.transaction(async (tx) => {
        const row = await lockRow(tx, key);
        if (row.enabled === enabled) return detailOf(tx, row);
        const [updated] = await tx.update(dungeonDefinitions).set({ enabled }).where(eq(dungeonDefinitions.dungeonKey, key)).returning();
        await audit(tx, key, enabled ? 'enabled' : 'disabled', actor, {});
        return detailOf(tx, updated!);
      });
    },

    async revisions(key) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return null;
      const rows = await db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key)).orderBy(desc(dungeonRevisions.number));
      const active = await activeRunCounts(db, key);
      return rows.map((r) => revisionSummary(r, row.publishedRevisionId, active));
    },

    async revision(key, number) {
      const [row] = await db.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return null;
      const [revision] = await db
        .select()
        .from(dungeonRevisions)
        .where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, number)));
      if (!revision) return null;
      return {
        ...revisionSummary(revision, row.publishedRevisionId, await activeRunCounts(db, key)),
        content: parseStoredDefinition(key, revision.content),
        layout: parseStoredLayout(revision.layout),
        rewardSnapshot: parseStoredRewardSnapshot(revision),
        ...(revision.sceneSpriteSnapshot ? { sceneSpriteSnapshot: readSceneSpriteSnapshot(revision.sceneSpriteSnapshot) } : {}),
      };
    },

    async history(key, limit = 100) {
      const rows = await db
        .select()
        .from(dungeonContentEvents)
        .where(eq(dungeonContentEvents.dungeonKey, key))
        .orderBy(desc(dungeonContentEvents.id))
        .limit(Math.min(Math.max(1, limit), 500));
      return rows.map((r) => ({ id: r.id, dungeonKey: r.dungeonKey, action: r.action, actor: r.actor, details: r.details, createdAt: r.createdAt }));
    },

    async exportPackage(key, origin, actor) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
        if (!row) throw new DungeonNotFoundError(key);
        const published = await publishedInfo(tx, row);
        let rewardSnapshot: DungeonRewardSnapshot | undefined;
        let lootTableMetadata: Parameters<typeof buildDungeonPackage>[0]['lootTableMetadata'];
        let definition: DungeonDefinition;
        let layout: DungeonLayout;
        let revisionNumber: number | null = published?.number ?? null;
        if (origin === 'draft') {
          definition = parseStoredDefinition(key, row.draft);
          layout = parseStoredLayout(row.layout);
          if (hasDungeonRewardBundles(definition)) {
            const context = await loadDungeonRewardContext(tx);
            const { issues } = validateDungeonRewards(definition, context);
            if (hasErrors(issues)) throw new DungeonInvalidError(issues);
            const snapshot = resolveDungeonRewardDependencies(definition, context).snapshot;
            if (!snapshot) throw new DungeonInvalidError([{ code: 'reward_snapshot_invalid', severity: 'error', path: 'rewards', message: 'Draft reward dependencies cannot be exported. Repair its loot tables, items and equipment.' }]);
            rewardSnapshot = snapshot;
            const tables = await tx.select({ key: dungeonLootTables.tableKey, description: dungeonLootTables.description, origin: dungeonLootTables.origin })
              .from(dungeonLootTables).where(inArray(dungeonLootTables.tableKey, Object.keys(snapshot.tables)));
            lootTableMetadata = new Map(tables.map((table) => [table.key, table]));
          }
        } else {
          const wanted = origin === 'published' ? published?.number : origin.revision;
          const [revision] =
            wanted == null
              ? []
              : await tx.select().from(dungeonRevisions).where(and(eq(dungeonRevisions.dungeonKey, key), eq(dungeonRevisions.number, wanted)));
          if (!revision) throw new DungeonRevisionNotFoundError(key, wanted ?? 0);
          definition = parseStoredDefinition(key, revision.content);
          layout = parseStoredLayout(revision.layout);
          revisionNumber = revision.number;
          if (hasDungeonRewardBundles(definition)) {
            const snapshot = readDungeonRewardSnapshot(revision.rewardSnapshot);
            if (!snapshot || revision.contentHash !== dungeonContentHash(definition) || revision.gameplayHash !== dungeonGameplayHash(revision.contentHash, snapshot.hash))
              throw new DungeonInvalidError([{ code: 'reward_snapshot_invalid', severity: 'error', path: 'rewardSnapshot', message: `Revision ${revision.number} has a missing, invalid or unsupported reward snapshot. Export refused.` }]);
            rewardSnapshot = snapshot;
          }
        }
        // Reward-free events still need structural verification and field-level
        // authoring errors. Published exports never consult mutable catalogues here.
        if (dungeonUsesEvents(definition)) {
          const { issues } = validateDungeonDefinition(definition);
          if (hasErrors(issues)) throw new DungeonInvalidError(issues);
        }
        if (hasSceneSprites(definition)) throw new DungeonInvalidError([{ code: 'schema', severity: 'error', path: 'rooms', message: 'Packages with Scene Sprites are temporarily unavailable until sprite dependencies can be bundled safely. Remove placements from a copy to export it.' }]);
        const encounterGate = dungeonEncounterPackageIssues(definition);
        if (encounterGate.length) throw new DungeonInvalidError(encounterGate);
        const enemies = new Map((await deps.enemies.definitions(tx)).map((e) => [e.key, e]));
        let pkg: DungeonPackage;
        try {
          pkg = buildDungeonPackage({
            definition,
            layout,
            enemies,
            rewardSnapshot,
            lootTableMetadata,
            source: {
              environment: deps.environment ?? 'development',
              origin: origin === 'draft' ? 'draft' : 'revision',
              draftRevision: origin === 'draft' ? row.draftRevision : null,
              publishedRevision: origin === 'draft' ? (published?.number ?? null) : revisionNumber,
            },
          });
        } catch (err) {
          if (!rewardSnapshot) throw err;
          throw new DungeonInvalidError([{ code: 'reward_snapshot_invalid', severity: 'error', path: 'rewardSnapshot', message: err instanceof Error ? err.message : String(err) }]);
        }
        return pkg;
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },

    async openDungeons(tx = db) {
      const rows = await tx
        .select({ row: dungeonDefinitions, revision: dungeonRevisions })
        .from(dungeonDefinitions)
        .innerJoin(dungeonRevisions, eq(dungeonRevisions.id, dungeonDefinitions.publishedRevisionId))
        .where(eq(dungeonDefinitions.enabled, true))
        .orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
      const out: PublishedDungeon[] = [];
      for (const { row, revision } of rows) {
        try {
          out.push({ row, revision, definition: parseStoredDefinition(row.dungeonKey, revision.content), rewards: parseStoredRewardSnapshot(revision) });
        } catch (err) {
          deps.logger?.error({ err, tag: 'dungeons/unreadable-revision', dungeonKey: row.dungeonKey, revision: revision.number }, 'published dungeon revision could not be read — hidden');
        }
      }
      return out;
    },

    async published(tx, key) {
      const [row] = await tx.select().from(dungeonDefinitions).where(eq(dungeonDefinitions.dungeonKey, key));
      if (!row) return 'missing';
      if (!row.enabled) return 'disabled';
      const revision = await publishedInfo(tx, row);
      if (!revision) return 'unpublished';
      return { row, revision, definition: parseStoredDefinition(key, revision.content), rewards: parseStoredRewardSnapshot(revision) };
    },

    async revisionById(tx, revisionId) {
      const [revision] = await tx.select().from(dungeonRevisions).where(eq(dungeonRevisions.id, revisionId));
      return revision
        ? { revision, definition: parseStoredDefinition(revision.dungeonKey, revision.content), rewards: parseStoredRewardSnapshot(revision) }
        : null;
    },
  };
  return service;
}

/**
 * Every stored dungeon document — each draft, and each revision that is
 * currently published or still has a run on it — for where-used lookups
 * (enemies, managed artwork). Unreadable documents are skipped.
 */
export async function readDungeonContentDocuments(
  tx: DbOrTx,
): Promise<{ dungeonKey: string; name: string; source: 'draft' | 'published'; definition: DungeonDefinition }[]> {
  const out: { dungeonKey: string; name: string; source: 'draft' | 'published'; definition: DungeonDefinition }[] = [];
  const rows = await tx.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.position), asc(dungeonDefinitions.dungeonKey));
  for (const row of rows) {
    const draft = DungeonDefinitionSchema.safeParse(row.draft);
    if (draft.success) out.push({ dungeonKey: row.dungeonKey, name: draft.data.name, source: 'draft', definition: draft.data });
  }
  const current = await tx
    .select({ revision: dungeonRevisions })
    .from(dungeonRevisions)
    .innerJoin(dungeonDefinitions, eq(dungeonDefinitions.publishedRevisionId, dungeonRevisions.id));
  // A superseded revision is still being played while a run on it is active.
  const inPlay = await tx
    .selectDistinct({ revisionId: dungeonRuns.revisionId })
    .from(dungeonRuns)
    .where(eq(dungeonRuns.status, 'active'));
  const seen = new Set(current.map((c) => c.revision.id));
  const extraIds = inPlay.map((r) => r.revisionId).filter((id) => !seen.has(id));
  const extra = extraIds.length ? await tx.select({ revision: dungeonRevisions }).from(dungeonRevisions).where(inArray(dungeonRevisions.id, extraIds)) : [];
  for (const { revision } of [...current, ...extra]) {
    const parsed = DungeonDefinitionSchema.safeParse(revision.content);
    if (parsed.success) out.push({ dungeonKey: revision.dungeonKey, name: parsed.data.name, source: 'published', definition: parsed.data });
  }
  return out;
}
