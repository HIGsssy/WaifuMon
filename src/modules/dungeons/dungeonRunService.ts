import { sceneSpritesForRoom, type SceneSpriteRenderVisual } from './sceneSprites/sceneSpriteSnapshot';
/**
 * Playing a dungeon run: starting one, stepping it, and settling it.
 *
 * This service decides nothing about a run. Every rule — what an action does,
 * where the sequence goes, what is paid, when the run ends — is the pure
 * engine's (`engine/step.ts`). What this service adds is the world around a
 * step: the row lock, the pinned revision, the frozen dependencies, the
 * **live effects adapter** that turns the engine's effects into real grants,
 * and the append-only history.
 *
 * ## One interaction, one transaction
 *
 * `act` is the only way a run moves:
 *
 *   1. `SELECT … FOR UPDATE` on the run row, scoped by player;
 *   2. the engine steps the stored state. The input names the step it was
 *      issued for; if the run has moved on the engine refuses it as `stale`
 *      and nothing is written;
 *   3. the step's effects are applied through the live adapter;
 *   4. the new state and its history rows are written.
 *
 * All of it commits together or not at all. So a double click, a Discord
 * retry or two racing interactions can fight a wave once, pay a reward once
 * and move the cursor once: the second arrival waits on the lock, then finds
 * a step number that is no longer the one it carries.
 *
 * ## What a run is pinned to
 *
 *   revision      `dungeon_runs.revision_id`: the published revision it began
 *                 on. A later publish or rollback changes what new runs get.
 *   dependencies  `dependency_snapshot`: the enemy stats and reward tables as
 *                 they stood at the start, and which managed artwork the
 *                 revision's hashes resolved to. A balance edit never reaches
 *                 a run in progress.
 *   fighter       the Buddy and Equipment-derived stats, as before.
 *
 * ## Rewards
 *
 * A `reward` action pays an existing expedition reward table and a range of
 * progression currency. Gear, WaifuBux and items are **secured** — granted in
 * the step's transaction; currency is **unbanked** until settlement (all of
 * it on extraction or completion, the dungeon's retention share on defeat or
 * abandon). Delivery is safe against replay because it shares the step's
 * transaction and step check; gear additionally carries a grant key derived
 * from the action's claim key, and banking the existing ledger request key.
 * V2 activities use the immutable revision's loot snapshot. Essence, items,
 * seeded gear and pinned-copy affection are secured in this transaction;
 * Shards and WaifuBux stay on the run until both are settled atomically.
 * Claims remain in the run row; there is no separate delivery queue.
 *
 * ## Encounters
 *
 * A wild encounter or rescue is the one place a dungeon reaches the capture
 * system, and it does so through `captureService`'s extracted operations,
 * **inside this step's transaction** — never a transaction of their own. The
 * charm, the Microdose charge, the owned copy, XP, quests, the acquisition
 * ledger, the run row and its history commit together or not at all.
 *
 * Lock order of a capture or rescue step, fixed:
 *
 *   1. the run row (`FOR UPDATE`) — every step;
 *   2. the player's `player_currencies` row, then the `players` row (both
 *      `FOR UPDATE`) — taken here, before anything is read;
 *   3. `player_inventory`, `player_active_effects`, `player_waifus`, the
 *      acquisition ledger;
 *   4. `players` again (already held) for XP, then `player_daily_quests`;
 *   5. the run row and `dungeon_run_events`.
 *
 * Step 2 is the prefix a hunt takes (`player_currencies → players`), and a
 * hunted capture takes `players` before its encounter, charm and effect rows
 * (`captureService.lockPlayerForCapture`). So the three paths that touch one
 * player's charms, effects, copies, XP and quests all queue on that player's
 * row and never hold each other's later locks: they cannot deadlock one
 * another, whichever starts first. The currency row is taken because a
 * capture that finishes an exit room settles the run in the same step, a
 * settlement can bank WaifuBux, and a hunt holds that row before the player
 * row.
 *
 * Only a capture or rescue takes step 2. Every other step writes nothing a
 * hunt or a capture orders against, and locks nothing more than it did.
 *
 * Paths outside those three still disagree with a hunt (using an Energy
 * Drink and a Care tick take `players` before `player_currencies`). Against
 * those a step can still be chosen as a deadlock victim (`40P01`), exactly as
 * a hunt can. A victim has written nothing — Postgres rolled it back whole —
 * so it is run again, at most `STEP_DEADLOCK_ATTEMPTS` times in all. That is
 * safe because the capture roll and the new copy's Base SP are the engine's
 * place-keyed draws: a step that rolled back decides exactly what it decided
 * before. Nothing here sets or depends on a lock or deadlock timeout.
 *
 * ## Eligibility, allowance and regions
 *
 * Unchanged from the prototype: the `equipment` feature unlock, an active
 * Buddy and a complete loadout; one daily run spent in the start transaction
 * and never refunded; a dungeon is startable only from one of its regions,
 * while an active run is playable anywhere.
 */
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { managedArtworkKey, resolveManagedArtworkIds } from '../artworkAssets/managedArtworkLookup';
import {
  artworkAssets,
  dungeonRunEvents,
  dungeonRuns,
  dungeonSpeciesAcquisitions,
  items,
  playerCurrencies,
  playerInventory,
  players,
  rewardTables,
  species,
  type DungeonAcquisitionMode,
  type DungeonRunRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  CaptureItemNotEligibleError,
  DungeonCaptureItemUnavailableError,
  DungeonCaptureQuoteChangedError,
  DungeonDailyLimitError,
  DungeonEncounterSpeciesUnavailableError,
  DungeonEventItemUnavailableError,
  DungeonInvalidError,
  DungeonRewardItemUnavailableError,
  DungeonRewardGrantError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonUnavailableError,
  EquipmentRewardConfigError,
  FeatureLockedError,
  DungeonStepContendedError,
  InsufficientItemsError,
  isDeadlockError,
  ItemNotFoundError,
  ItemNotUsableError,
  PlayerNotFoundError,
  uniqueViolationConstraint,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { resolveEnemyVisual, type EnemyVisual, type ManagedEnemyArtwork } from '../artworkAssets/enemyArtworkService';
import type { ArtworkRef } from '../artworkAssets/sceneLayers';
import { DEFAULT_SPRITE_PLACEMENT, type SpritePlacement } from '../artworkAssets/scenePlacement';
import type { CombatEvent, CombatRules } from '../combat/combatTypes';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { ExpeditionRewardTable } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import type { CollectionService } from '../collection/collectionService';
import type { CaptureBuddyOverride, CaptureService } from '../capture/captureService';
import { applyPercentModifierInt } from '../buddyBonus/buddyBonusEffects';
import type { EnemyCatalogueService } from '../enemies/enemyService';
import type { CombatStatsService } from '../equipment/combatStatsService';
import type { CombatStats, CombatStatsUnavailableReason } from '../equipment/equipmentMath';
import { listRewardableDefinitions, type EquipmentRewardService } from '../equipment/equipmentRewardService';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { InventoryService } from '../inventory/inventoryService';
import { regionLabel } from '../locations/regions';
import type { ProgressionCurrencyService } from '../progressionCurrency/progressionCurrencyService';
import { equipmentSelectorsOf, resolveEquipmentPools } from '../rewardTables/rewardTableCore';
import { parseRewardTableRow } from '../rewardTables/rewardTableStore';
import {
  dungeonDependencies,
  eventOf,
  hasDungeonEncounters,
  isCombatAction,
  isEncounterAction,
  type DungeonArtworkRef,
  type DungeonDefinition,
  type EncounterAction,
} from './content/dungeonDefinition';
import type { DungeonAllowanceService, DungeonDailyAllowance } from './dungeonAllowanceService';
import type { DungeonContentService } from './dungeonContentService';
import { fighterFromCombatStats, pinnedCaptureBuddy, pinnedRewardBonuses, type DungeonFighter } from './dungeonFighter';
import {
  dungeonAcquisitionCounts,
  dungeonEncounterSpeciesSlugs,
  dungeonSpeciesPolicy,
  loadSpeciesBySlug,
  type DungeonSpeciesAccessLookup,
} from './dungeonSpeciesPolicy';
import { captureRules, encounterInstanceKey } from './engine/encounters';
import { dungeonSpeciesUnavailableReason } from './validation/dungeonEncounterValidation';
import type { BuddyBonusService } from '../buddyBonus/buddyBonusService';
import { describeEventResults, eventInstanceKey, type DungeonEventResultView } from './engine/events';
import { equipmentGrantKey, rewardClaimKey } from './engine/rewards';
import { dungeonGameplayHash, hasDungeonRewardBundles, readDungeonRewardSnapshot } from './content/dungeonRewardSnapshot';
import { applyDungeonEffects } from './engine/sandbox';
import { randomDungeonSeed } from './engine/seeds';
import { startDungeonRun, stepDungeon } from './engine/step';
import type {
  DungeonAcquiredWaifu,
  DungeonCaptureReceipt,
  DungeonEffect,
  DungeonEffectReceipt,
  DungeonEncounterFacts,
  DungeonEncounterInstance,
  DungeonEncounterUnavailableReason,
  DungeonRescueReceipt,
  DungeonEffectsPort,
  DungeonEngineContext,
  DungeonEquipmentGrant,
  DungeonEssenceGrant,
  DungeonAffectionGrant,
  DungeonInput,
  DungeonLogEntry,
  DungeonRefusal,
  DungeonRunEnd,
  DungeonRunEventType,
  DungeonRunState,
  DungeonRunStatus,
  EngineDependencies,
} from './engine/types';
import { describeDungeonRun, type DungeonRunCoreView } from './engine/view';

/** The feature that gates dungeons: no Equipment means no combat stats. */
export const DUNGEON_FEATURE = 'equipment' as const;

export const DUNGEON_DEPENDENCY_SNAPSHOT_FORMAT = 'waifumon-dungeon-run-dependencies' as const;
export const DUNGEON_DEPENDENCY_SNAPSHOT_VERSION = 1 as const;

/** Everything mutable and global a run depends on, frozen when it started. */
export interface DungeonDependencySnapshot extends EngineDependencies {
  format: typeof DUNGEON_DEPENDENCY_SNAPSHOT_FORMAT;
  version: typeof DUNGEON_DEPENDENCY_SNAPSHOT_VERSION;
  /** Managed artwork of each enemy, as *logical* references: replacing the image behind an id shows the new image. */
  enemyArtwork: Record<string, ManagedEnemyArtwork>;
  currency: {
    key: string;
    singularName: string;
    pluralName: string;
    description: string;
    icon: string | null;
    enabled: boolean;
  } | null;
  /** `<category>:<contentHash>` of each managed reference → the asset it resolved to here, or null. */
  artwork: Record<string, string | null>;
}

// ── read models ─────────────────────────────────────────────────────────────

/** How to name the progression currency. Always the configured metadata. */
export interface DungeonCurrencyView {
  key: string;
  singularName: string;
  pluralName: string;
  icon: string | null;
}

export interface DungeonCard {
  key: string;
  name: string;
  description: string;
  artwork: ArtworkRef;
  background: ArtworkRef;
  roomCount: number;
  hasBoss: boolean;
  currency: DungeonCurrencyView | null;
  /** The player's permanent balance of that currency. */
  balance: number;
  defeatRetentionBasisPoints: number;
  /** Read-only settings for the reward risk explanation. */
  abandonRetentionBasisPoints?: number;
  rewardFormat?: 'v2';
}

/** A reward a run has already handed to the player for good. */
export type DungeonSecuredReward =
  | ({ kind: 'equipment'; source: string; step: number } & DungeonEquipmentGrant)
  | { kind: 'waifubux'; source: string; step: number; amount: number }
  | { kind: 'item'; source: string; step: number; slug: string; quantity: number }
  | ({ kind: 'essence'; source: string; step: number } & DungeonEssenceGrant)
  | ({ kind: 'affection'; source: string; step: number } & DungeonAffectionGrant);

/** How a run ended and what was banked. Stored on the run once, when it ends. */
export interface DungeonSettlement extends DungeonRunEnd {
  /** Why nothing could be banked, when the dungeon's currency is missing or disabled. */
  bankingSkipped: 'no_currency' | 'currency_disabled' | null;
  /** The permanent balance after banking; null when nothing was banked. */
  balanceAfter: number | null;
  waifubuxBalanceAfter?: number | null;
}

export interface DungeonSceneEnemy {
  key: string;
  name: string;
  attack: number;
  defense: number;
  hp: number;
  visual: EnemyVisual;
}

export interface DungeonRunView {
  sceneSprites?: SceneSpriteRenderVisual[];
  id: number;
  status: DungeonRunStatus;
  /** The step the next input must name. */
  step: number;
  dungeon: { key: string; name: string; description: string; revision: number; artwork: ArtworkRef; background: ArtworkRef };
  /** The snapshotted Buddy and stats — not the player's live ones. */
  fighter: DungeonFighter;
  /** The engine's read model: room, pending action, connections, what the latest step did. */
  core: DungeonRunCoreView;
  /** The picture's subject: the enemy about to be fought, else the one just fought this step. */
  enemy: DungeonSceneEnemy | null;
  /** The offered event's own picture, resolved as the run pinned it. Absent when no event is offered or it has none. */
  eventArtwork?: ArtworkRef | null;
  /** Display names of the items the offered event's choices need, and of any the latest step spent. */
  eventItemNames?: Record<string, string>;
  /** What the latest step's event choices did, in the words their author wrote. Parallel to `core.recent`'s event entries. */
  latestEvents?: DungeonEventResultView[];
  /**
   * The WaifuMon on offer as the scene draws her: her species' dungeon sprite
   * at the activity's authored placement. Absent unless an encounter is offered.
   */
  encounterActor?: DungeonEncounterActor;
  /** What the latest step's encounters came to, named as the catalogue now names her. Parallel to `core.recent`'s encounter entries. */
  latestEncounters?: DungeonEncounterResultView[];
  /** The current room's backdrop, falling back to the dungeon's. */
  roomBackground: ArtworkRef;
  /** The engine's events for the latest wave fought this step. For formatting; never shown raw. */
  combatEvents: CombatEvent[] | null;
  currency: DungeonCurrencyView | null;
  /** Share of the unbanked currency kept on defeat or abandon. */
  defeatRetentionBasisPoints: number;
  secured: DungeonSecuredReward[];
  /** The secured rewards the latest step handed over. */
  latestSecured: DungeonSecuredReward[];
  /** Absent on historical serialized views; current reads expose both totals. */
  atRisk?: { shards: number; waifubux: number };
  /** Only newly committed claims represented in this stored step. */
  latestAtRisk?: { shards: number; waifubux: number } | null;
  /** Published display-name fallback when loaded content no longer names an item. */
  rewardItemNames?: Record<string, string>;
  abandonRetentionBasisPoints?: number;
  rewardFormat?: 'v2';
  settlement: DungeonSettlement | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface DungeonEncounterActor {
  speciesSlug: string;
  placement: SpritePlacement;
  mirror: boolean;
}

/** One encounter result of the latest step. `failure` is an attempt that missed with attempts left. */
export interface DungeonEncounterResultView {
  roomId: string;
  actionId: string;
  type: 'wild_encounter' | 'rescue';
  /** Null when a pool drew nothing. */
  species: string | null;
  name: string | null;
  rarity: string | null;
  outcome: DungeonEncounterInstance['status'] | 'failure';
  /** The author's result text; empty when they wrote none. */
  text: string;
  /** Why she could not be had, for `unavailable`. */
  unavailableReason: DungeonEncounterUnavailableReason | null;
}

export interface DungeonRegionView {
  id: string;
  name: string;
}

export interface DungeonHomeView {
  /** Where the player is standing. `dungeons` holds only what can be started here. */
  region: DungeonRegionView;
  dungeons: DungeonCard[];
  activeRun: DungeonRunView | null;
  /** Why Start is refused before it is pressed; null when the player can start. */
  blocker: CombatStatsUnavailableReason | null;
  /** Today's shared Delve allowance. Starting needs `remaining > 0`; resuming never does. */
  daily: DungeonDailyAllowance;
}

export interface DungeonDetailView {
  dungeon: DungeonCard;
  /** The live calculation a run started now would snapshot. */
  stats: CombatStats;
  blocker: CombatStatsUnavailableReason | null;
  /** The run in the way of starting a new one, if any. */
  activeRunId: number | null;
  daily: DungeonDailyAllowance;
}

/** What a live encounter step did for real, for the caller's result screen. Absent when the step did neither. */
export type DungeonEncounterReceipt = DungeonCaptureReceipt | DungeonRescueReceipt;

/**
 * - `applied` — this call moved the run;
 * - `refused` — the input is not legal for the run as it stands (`refusal`
 *   says why; `stale` is a button from an earlier step). Nothing changed.
 */
export interface DungeonActionResult {
  status: 'applied' | 'refused';
  refusal: DungeonRefusal | null;
  run: DungeonRunView;
  /** The capture attempt or rescue this step carried out, if it did one. */
  encounterReceipts?: DungeonEncounterReceipt[];
}

export interface DungeonRunEvent {
  id: number;
  step: number;
  type: DungeonRunEventType;
  roomId: string | null;
  actionId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface DungeonRunService {
  /** Whether the player may use dungeons at all. Never throws for a locked player. */
  isAvailable(playerId: number): Promise<boolean>;
  /** @throws {FeatureLockedError} */
  home(playerId: number): Promise<DungeonHomeView>;
  /** @throws {FeatureLockedError} {DungeonUnavailableError} */
  dungeon(playerId: number, dungeonKey: string): Promise<DungeonDetailView>;
  /**
   * Spend one daily run, pin the published revision, snapshot the fighter and
   * the run's dependencies, atomically: all of it happens or none does.
   *
   * @throws {FeatureLockedError} {DungeonRunActiveError} {CombatBuddyRequiredError}
   *         {CombatLoadoutIncompleteError} {DungeonDailyLimitError}
   *         {DungeonUnavailableError} {DungeonInvalidError}
   */
  start(playerId: number, dungeonKey: string, opts?: { seed?: number }): Promise<DungeonRunView>;
  /** The player's active run, or null. @throws {FeatureLockedError} */
  activeRun(playerId: number): Promise<DungeonRunView | null>;
  /** Any of the player's runs, finished or not. @throws {DungeonRunNotFoundError} */
  run(playerId: number, runId: number): Promise<DungeonRunView>;
  /** Move the run one step. `input.expectedStep` is the step the caller's screen showed. */
  act(playerId: number, runId: number, input: DungeonInput): Promise<DungeonActionResult>;
  /** The run's structured history, oldest first. */
  history(runId: number): Promise<DungeonRunEvent[]>;
  /** The player's daily Delve allowance. Does not require the feature unlock. */
  dailyAllowance(playerId: number): Promise<DungeonDailyAllowance>;
}

export interface DungeonRunServiceDeps {
  db: Db;
  content: Pick<DungeonContentService, 'openDungeons' | 'published' | 'revisionById'>;
  enemies: Pick<EnemyCatalogueService, 'snapshot'>;
  allowance: Pick<DungeonAllowanceService, 'status' | 'consume'>;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  combatStats: Pick<CombatStatsService, 'calculateCombatStats' | 'snapshotCombatStats'>;
  /** Resolves the pinned fighter's species, never a later active Buddy. */
  buddyBonus?: Pick<BuddyBonusService, 'bonusForSpeciesSlug'>;
  currencies: Pick<ProgressionCurrencyService, 'get' | 'getBalance' | 'grant'>;
  currency: Pick<CurrencyService, 'grantWaifubux' | 'grantEssence'>;
  collection: Pick<CollectionService, 'awardCopyAffection'>;
  inventory: Pick<InventoryService, 'addItem' | 'consumeItem'>;
  equipmentRewards: Pick<EquipmentRewardService, 'grantChosenEquipmentReward'>;
  /**
   * The capture system's transaction-joining operations. Optional so wirings
   * with no encounters keep working; without it a run that reaches a capture
   * or rescue fails that step and rolls back.
   */
  capture?: Pick<CaptureService, 'quoteSpecies' | 'resolveCaptureAttempt' | 'grantSpeciesCopy'> | undefined;
  /** A species' `dungeonAccess` from loaded content. Absent, no species lists any dungeon. */
  speciesAccess?: DungeonSpeciesAccessLookup | undefined;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> | undefined;
  /** A region's display name, from the region catalogue. Defaults to a title-cased id. */
  regionName?: ((regionId: string) => string) | undefined;
  /**
   * Overrides for the rules a dungeon fight is created under. Production
   * leaves this unset. Tests that assert exact HP pin the variance here.
   */
  combatRules?: Partial<CombatRules> | undefined;
}

/** Times a step is run in all when Postgres picks it as a deadlock victim. */
const STEP_DEADLOCK_ATTEMPTS = 3;

/** The ledger reason a settlement banks under. */
const BANK_REASON = {
  extracted: 'dungeon_extraction',
  completed: 'dungeon_completion',
  defeated: 'dungeon_defeat',
  abandoned: 'dungeon_abandon',
} as const;


/** A definition's artwork reference as the artwork layer resolves one. */
export function resolveDungeonArtwork(ref: DungeonArtworkRef | null, managed: Readonly<Record<string, string | null>>): ArtworkRef {
  if (!ref) return { assetId: null, artworkPath: null };
  if (ref.kind === 'shipped') return { assetId: null, artworkPath: ref.path };
  return { assetId: managed[managedArtworkKey(ref)] ?? null, artworkPath: null };
}

function stateOf(row: DungeonRunRow): DungeonRunState {
  return {
    status: row.status,
    step: row.step,
    seed: row.seed,
    cursor: row.cursor as unknown as DungeonRunState['cursor'],
    hp: row.currentHp,
    flags: row.flags,
    rooms: row.roomStates as unknown as DungeonRunState['rooms'],
    rewardClaims: row.rewardClaims as unknown as DungeonRunState['rewardClaims'],
    // The engine creates this only when a run meets an event; a run that never has keeps none.
    ...(Object.keys(row.eventStates).length > 0 ? { events: row.eventStates as unknown as NonNullable<DungeonRunState['events']> } : {}),
    // Likewise: created on the first encounter, absent on every run without one.
    ...(Object.keys(row.encounterStates).length > 0 ? { encounters: row.encounterStates as unknown as NonNullable<DungeonRunState['encounters']> } : {}),
    unbankedCurrency: row.unbankedCurrency,
    unbankedWaifubux: row.unbankedWaifubux,
    recent: row.recent as unknown as DungeonRunState['recent'],
    end: row.settlement ? (row.settlement as unknown as DungeonRunEnd) : null,
  };
}

interface LoadedRun {
  sceneSpriteSnapshot: unknown;
  row: DungeonRunRow;
  definition: DungeonDefinition;
  revisionNumber: number;
  snapshot: DungeonDependencySnapshot;
  fighter: DungeonFighter;
  /** Names of the items the offered event's choices need; empty when none is offered. */
  eventItemNames: Record<string, string>;
  ctx: DungeonEngineContext;
}

export function createDungeonRunService(deps: DungeonRunServiceDeps): DungeonRunService {
  const { db } = deps;

  async function requireUnlocked(playerId: number, tx: DbOrTx = db): Promise<void> {
    if (!(await deps.featureUnlocks.isUnlocked(playerId, DUNGEON_FEATURE, tx))) {
      throw new FeatureLockedError(DUNGEON_FEATURE);
    }
  }

  function regionView(id: string): DungeonRegionView {
    return { id, name: (deps.regionName ?? regionLabel)(id) };
  }

  /** Where the player is standing, by the player row — the same source travel writes. */
  async function currentRegion(tx: DbOrTx, playerId: number): Promise<DungeonRegionView> {
    const [row] = await tx.select({ region: players.currentRegion }).from(players).where(eq(players.id, playerId));
    if (!row) throw new PlayerNotFoundError(playerId);
    return regionView(row.region);
  }

  async function activeRow(tx: DbOrTx, playerId: number): Promise<DungeonRunRow | undefined> {
    const [row] = await tx
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.playerId, playerId), eq(dungeonRuns.status, 'active')));
    return row;
  }

  // ── artwork and cards ─────────────────────────────────────────────────────

  /** Which active managed asset each `<category>:<hash>` reference resolves to here. */
  async function resolveManagedArtwork(tx: DbOrTx, refs: readonly DungeonArtworkRef[]): Promise<Record<string, string | null>> {
    return resolveManagedArtworkIds(
      tx,
      refs.filter((r): r is Extract<DungeonArtworkRef, { kind: 'managed' }> => r.kind === 'managed'),
    );
  }

  async function card(tx: DbOrTx, playerId: number, definition: DungeonDefinition): Promise<DungeonCard> {
    const currencyKey = definition.settings.progressionCurrency;
    const meta = currencyKey ? await deps.currencies.get(currencyKey, tx) : null;
    const managed = await resolveManagedArtwork(tx, [definition.artwork, definition.background].filter((r): r is DungeonArtworkRef => r != null));
    return {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      artwork: resolveDungeonArtwork(definition.artwork, managed),
      background: resolveDungeonArtwork(definition.background, managed),
      roomCount: definition.rooms.length,
      hasBoss: definition.rooms.some((r) => r.actions.some((a) => a.type === 'boss')),
      currency: meta && { key: meta.key, singularName: meta.singularName, pluralName: meta.pluralName, icon: meta.icon },
      balance: meta ? await deps.currencies.getBalance(playerId, meta.key, tx) : 0,
      defeatRetentionBasisPoints: definition.settings.defeatCurrencyRetentionBasisPoints,
      abandonRetentionBasisPoints: definition.settings.abandonCurrencyRetentionBasisPoints ?? definition.settings.defeatCurrencyRetentionBasisPoints,
      ...(hasDungeonRewardBundles(definition) ? { rewardFormat: 'v2' as const } : {}),
    };
  }

  // ── dependency snapshot ───────────────────────────────────────────────────

  async function snapshotRewardTables(tx: DbOrTx, ids: readonly string[]): Promise<DungeonDependencySnapshot['rewardTables']> {
    const out: DungeonDependencySnapshot['rewardTables'] = {};
    if (ids.length === 0) return out;
    const rows = await tx
      .select()
      .from(rewardTables)
      .where(and(eq(rewardTables.kind, 'expedition'), inArray(rewardTables.tableId, [...ids])));
    const definitions = await listRewardableDefinitions(tx);
    for (const id of ids) {
      const row = rows.find((r) => r.tableId === id);
      if (!row) {
        throw new DungeonInvalidError([
          { code: 'reward_table_missing', path: 'rewards', message: `"${id}" is not an expedition reward table`, severity: 'error' },
        ]);
      }
      const table = parseRewardTableRow(row) as ExpeditionRewardTable;
      if (!row.enabled || !table.enabled) {
        out[id] = null;
        continue;
      }
      try {
        out[id] = { table, equipmentPools: resolveEquipmentPools(equipmentSelectorsOf([table]), definitions) };
      } catch (err) {
        if (!(err instanceof EquipmentRewardConfigError)) throw err;
        throw new DungeonInvalidError([
          {
            code: 'reward_table_missing',
            path: 'rewards',
            message: `reward table "${id}" has an Equipment reward this server cannot pay: ${err.message}`,
            severity: 'error',
          },
        ]);
      }
    }
    return out;
  }

  async function buildSnapshot(tx: DbOrTx, definition: DungeonDefinition): Promise<DungeonDependencySnapshot> {
    const needs = dungeonDependencies(definition);
    // Read here, inside the run's own transaction, and never again: what the
    // catalogue says now is what this run fights for good.
    const live = await deps.enemies.snapshot(tx);
    const byKey = new Map(live.definitions.map((e) => [e.key, e]));
    const enemies: Record<string, CombatEnemyDefinition> = {};
    const missing: string[] = [];
    for (const key of needs.enemies) {
      const enemy = byKey.get(key);
      if (enemy) enemies[key] = enemy;
      else missing.push(key);
    }
    if (missing.length > 0) {
      throw new DungeonInvalidError(
        missing.map((key) => ({ code: 'enemy_missing', path: 'rooms', message: `enemy "${key}" is not in the Enemy Catalogue`, severity: 'error' as const })),
      );
    }
    const currencyKey = definition.settings.progressionCurrency;
    const currency = currencyKey ? await deps.currencies.get(currencyKey, tx) : null;
    return {
      format: DUNGEON_DEPENDENCY_SNAPSHOT_FORMAT,
      version: DUNGEON_DEPENDENCY_SNAPSHOT_VERSION,
      enemies,
      enemyArtwork: Object.fromEntries(
        Object.entries(live.artwork)
          .filter(([key]) => key in enemies)
          .map(([key, o]) => [key, { artworkAssetId: o.artworkAssetId, spriteAssetId: o.spriteAssetId, spritePlacement: o.spritePlacement }]),
      ),
      rewardTables: await snapshotRewardTables(tx, needs.rewardTables),
      currency: currency && {
        key: currency.key,
        singularName: currency.singularName,
        pluralName: currency.pluralName,
        description: currency.description,
        icon: currency.icon,
        enabled: currency.enabled,
      },
      artwork: await resolveManagedArtwork(tx, needs.artwork),
    };
  }

  // ── loading and viewing a run ─────────────────────────────────────────────

  async function load(tx: DbOrTx, row: DungeonRunRow): Promise<LoadedRun> {
    const cursor = row.cursor as unknown as DungeonRunState['cursor'];
    const claimKey = cursor.actionId === null ? `revision:${row.revisionId}` : rewardClaimKey(String(row.id), cursor.roomId, cursor.actionId);
    let pinned: Awaited<ReturnType<DungeonRunServiceDeps['content']['revisionById']>>;
    try {
      pinned = await deps.content.revisionById(tx, row.revisionId);
    } catch (cause) {
      if (!(cause instanceof DungeonInvalidError) || !cause.issues.some((i) => i.code === 'reward_snapshot_invalid')) throw cause;
      throw rewardFailure(row, claimKey, 'reward_snapshot', cause);
    }
    if (!pinned) throw new DungeonRunNotFoundError(row.id);
    const rewards = readDungeonRewardSnapshot(pinned.rewards);
    if (hasDungeonRewardBundles(pinned.definition) &&
      (!rewards || dungeonGameplayHash(pinned.revision.contentHash, rewards.hash) !== pinned.revision.gameplayHash)) {
      throw rewardFailure(row, claimKey, 'reward_snapshot', new Error(
        !rewards ? 'Pinned revision reward snapshot is missing, invalid or resolver-incompatible'
          : 'Pinned revision reward snapshot does not match its gameplay hash',
      ));
    }
    const snapshot = row.dependencySnapshot as unknown as DungeonDependencySnapshot;
    const fighter = row.fighter as unknown as DungeonFighter;
    const facts = await eventItemFacts(tx, row.playerId, pinned.definition, stateOf(row));
    const encounterFacts = await readEncounterFacts(tx, row, pinned.definition, stateOf(row), fighter);
    return {
      row,
      definition: pinned.definition,
      revisionNumber: pinned.revision.number,
      sceneSpriteSnapshot: pinned.revision.sceneSpriteSnapshot,
      snapshot,
      fighter,
      eventItemNames: facts.names,
      ctx: {
        definition: pinned.definition,
        dependencies: { enemies: snapshot.enemies, rewardTables: snapshot.rewardTables },
        fighter,
        runKey: String(row.id),
        rewards,
        inventory: facts.inventory,
        encounterFacts,
        combatRules: deps.combatRules,
      },
    };
  }

  /** The run's pinned Buddy, as the capture service reads one. Never the live Buddy. */
  function pinnedBuddy(fighter: DungeonFighter): CaptureBuddyOverride {
    return {
      waifuId: fighter.waifuId,
      speciesSlug: fighter.speciesSlug,
      ...(fighter.captureBuddy ? { pinned: fighter.captureBuddy } : {}),
    };
  }

  /** The encounter action the run stands on while it is offered and still open, with its species. */
  function offeredEncounter(
    definition: DungeonDefinition,
    state: Pick<DungeonRunState, 'cursor' | 'encounters' | 'status'>,
  ): { action: EncounterAction; species: string } | null {
    if (state.status !== 'active' || state.cursor.actionId == null) return null;
    const action = definition.rooms.find((r) => r.id === state.cursor.roomId)?.actions.find((a) => a.id === state.cursor.actionId);
    if (!action || !isEncounterAction(action)) return null;
    const instance = state.encounters?.[encounterInstanceKey(state.cursor.roomId, action.id)];
    return instance?.status === 'offered' && instance.species !== null ? { action, species: instance.species } : null;
  }

  /**
   * The live facts the pure engine judges an encounter by, read in the caller's
   * transaction. Undefined for a definition without encounters, which costs it
   * no query.
   *
   * `species` covers every slug the pinned revision can present: current
   * `enabled`, tags and `dungeonAccess`, and how many copies this dungeon has
   * already given this player. `items` is filled only while the run stands on
   * an offered capture: each capture item the player holds, quoted by the
   * capture service against the **pinned** Buddy. That quote is the number the
   * player is shown, the number the engine rolls against, and — because the
   * attempt recomputes it from the same inputs in the same transaction — the
   * number the capture service resolves against.
   */
  async function readEncounterFacts(
    tx: DbOrTx,
    row: DungeonRunRow,
    definition: DungeonDefinition,
    state: Pick<DungeonRunState, 'cursor' | 'encounters' | 'status'>,
    fighter: DungeonFighter,
  ): Promise<DungeonEncounterFacts | undefined> {
    if (!hasDungeonEncounters(definition)) return undefined;
    const slugs = dungeonEncounterSpeciesSlugs(definition);
    const bySlug = await loadSpeciesBySlug(tx, slugs);
    const counts = await dungeonAcquisitionCounts(tx, row.playerId, row.dungeonKey);
    const speciesFacts: Record<string, DungeonEncounterFacts['species'][string]> = {};
    for (const slug of slugs) {
      const found = bySlug.get(slug);
      const policy = dungeonSpeciesPolicy(found, deps.speciesAccess);
      const count = found ? (counts.get(found.id) ?? 0) : 0;
      const reason = dungeonSpeciesUnavailableReason(policy, row.dungeonKey, false, count);
      const direct = dungeonSpeciesUnavailableReason(policy, row.dungeonKey, true, count);
      speciesFacts[slug] = {
        available: reason === null,
        ...(reason ? { reason } : {}),
        name: found?.name ?? slug,
        rarity: found?.rarity ?? '',
        directRescue: { available: direct === null, ...(direct ? { reason: direct } : {}) },
      };
    }

    const offered = offeredEncounter(definition, state);
    const target = offered && bySlug.get(offered.species);
    if (!offered || !target || !deps.capture || captureRules(offered.action) === null) return { species: speciesFacts };
    const held = await tx
      .select({ item: items, quantity: playerInventory.quantity })
      .from(playerInventory)
      .innerJoin(items, eq(playerInventory.itemId, items.id))
      .where(and(eq(playerInventory.playerId, row.playerId), eq(items.category, 'capture'), gt(playerInventory.quantity, 0)))
      .orderBy(asc(items.slug));
    const itemFacts: Record<string, NonNullable<DungeonEncounterFacts['items']>[string]> = {};
    for (const { item, quantity } of held) {
      const quote = await deps.capture.quoteSpecies(tx, row.playerId, target, item, pinnedBuddy(fighter));
      itemFacts[item.slug] = {
        owned: quantity,
        eligible: item.enabled && quote.eligible,
        // Global rules have no further say; the encounter's own narrowing is the engine's.
        permitted: true,
        guaranteed: quote.guaranteed,
        chance: quote.chance,
        consumesMicrodose: !quote.guaranteed && quote.captureBonusModifier !== 0,
      };
    }
    return { species: speciesFacts, items: itemFacts };
  }

  /**
   * What the player holds of the items the offered event's choices name — the
   * inventory facts the pure engine judges a choice by. Read inside the caller's
   * transaction and not locked: spending is a conditional decrement, so a
   * quantity that changes after this read fails the step instead of overspending.
   * Empty unless the run stands on an offered event.
   */
  async function eventItemFacts(
    tx: DbOrTx,
    playerId: number,
    definition: DungeonDefinition,
    state: Pick<DungeonRunState, 'cursor' | 'events' | 'status'>,
  ): Promise<{ inventory: Record<string, number>; names: Record<string, string> }> {
    const none = { inventory: {}, names: {} };
    if (state.status !== 'active' || state.cursor.actionId == null) return none;
    const instance = state.events?.[eventInstanceKey(state.cursor.roomId, state.cursor.actionId)];
    const event = instance?.status === 'offered' ? eventOf(definition, instance.eventId) : null;
    const slugs = [...new Set((event?.choices ?? []).flatMap((choice) => (choice.items ?? []).map((i) => i.item)))];
    if (slugs.length === 0) return none;
    const rows = await tx
      .select({ slug: items.slug, name: items.name, quantity: playerInventory.quantity })
      .from(items)
      .leftJoin(playerInventory, and(eq(playerInventory.itemId, items.id), eq(playerInventory.playerId, playerId)))
      .where(inArray(items.slug, slugs));
    return {
      inventory: Object.fromEntries(rows.map((r) => [r.slug, r.quantity ?? 0])),
      names: Object.fromEntries(rows.map((r) => [r.slug, r.name])),
    };
  }

  /** The run as the row now stands, with the inventory facts of whatever it is standing on now. */
  async function reloaded(tx: DbOrTx, run: LoadedRun, row: DungeonRunRow): Promise<LoadedRun> {
    const facts = await eventItemFacts(tx, row.playerId, run.definition, stateOf(row));
    const encounterFacts = await readEncounterFacts(tx, row, run.definition, stateOf(row), run.fighter);
    return { ...run, row, eventItemNames: facts.names, ctx: { ...run.ctx, inventory: facts.inventory, encounterFacts } };
  }

  async function currencyView(tx: DbOrTx, run: LoadedRun): Promise<DungeonCurrencyView | null> {
    // Live metadata, so a rename shows at once; the snapshot covers a currency since removed.
    const key = run.definition.settings.progressionCurrency;
    const live = key ? await deps.currencies.get(key, tx) : null;
    const meta = live ?? run.snapshot.currency;
    return meta && { key: meta.key, singularName: meta.singularName, pluralName: meta.pluralName, icon: meta.icon };
  }

  function sceneEnemy(run: LoadedRun, enemy: CombatEnemyDefinition | undefined): DungeonSceneEnemy | null {
    if (!enemy) return null;
    return {
      key: enemy.key,
      name: enemy.name,
      attack: enemy.attack,
      defense: enemy.defense,
      hp: enemy.hp,
      visual: resolveEnemyVisual(enemy, run.snapshot.enemyArtwork?.[enemy.key]),
    };
  }

  async function runView(tx: DbOrTx, run: LoadedRun, combatEvents?: CombatEvent[] | null): Promise<DungeonRunView> {
    const { row, definition, snapshot } = run;
    const state = stateOf(row);
    const core = describeDungeonRun(state, run.ctx);
    const lastWave = [...core.recent].reverse().find((r) => r.kind === 'wave');

    let events = combatEvents ?? null;
    if (events == null && lastWave?.kind === 'wave') {
      const rows = await tx
        .select({ payload: dungeonRunEvents.payload })
        .from(dungeonRunEvents)
        .where(and(eq(dungeonRunEvents.runId, row.id), eq(dungeonRunEvents.step, row.step), eq(dungeonRunEvents.type, 'combat_wave_resolved')))
        .orderBy(asc(dungeonRunEvents.id));
      events = ((rows.at(-1)?.payload as { events?: CombatEvent[] } | undefined)?.events as CombatEvent[] | undefined) ?? null;
    }

    const secured = row.securedRewards as unknown as DungeonSecuredReward[];
    // Read the committed claims, not the engine's proposed grant amounts.
    const claimed = core.recent.flatMap((r) => r.kind === 'reward' && Object.hasOwn(state.rewardClaims, r.claimKey)
      ? [state.rewardClaims[r.claimKey]!] : []);
    const latestAtRisk = claimed.length ? claimed.reduce((total, plan) => ({
      shards: total.shards + ('v' in plan ? plan.atRisk.shards : plan.currency),
      waifubux: total.waifubux + ('v' in plan ? plan.atRisk.waifubux : 0),
    }), { shards: 0, waifubux: 0 }) : null;
    // The latest step's event choices, read from the pinned revision the run plays.
    const eventEntries = core.recent.filter((r): r is Extract<typeof r, { kind: 'event' }> => r.kind === 'event');
    const latestEvents = describeEventResults(definition, core.recent);
    const spent = [...new Set(eventEntries.flatMap((entry) => entry.consumed.map((c) => c.item)))];
    const spentNames = spent.length === 0 ? {} : Object.fromEntries(
      (await tx.select({ slug: items.slug, name: items.name }).from(items).where(inArray(items.slug, spent))).map((r) => [r.slug, r.name]),
    );
    const room = definition.rooms.find((r) => r.id === core.room.id);
    const roomBackground = resolveDungeonArtwork(room?.background ?? null, snapshot.artwork ?? {});
    // The offered WaifuMon's place in the picture, and the latest step's encounter results by name.
    const offeredAction = core.action?.encounter ? room?.actions.find((a) => a.id === core.action!.id) : undefined;
    const encounterActor: DungeonEncounterActor | null = core.action?.encounter && offeredAction && isEncounterAction(offeredAction)
      ? { speciesSlug: core.action.encounter.species, placement: offeredAction.placement ?? DEFAULT_SPRITE_PLACEMENT, mirror: offeredAction.mirror ?? false }
      : null;
    const speciesFacts = run.ctx.encounterFacts?.species ?? {};
    const latestEncounters = core.recent.flatMap((entry): DungeonEncounterResultView[] => {
      if (entry.kind !== 'encounter') return [];
      const action = definition.rooms.find((r) => r.id === entry.roomId)?.actions.find((a) => a.id === entry.actionId);
      if (!action || !isEncounterAction(action)) return [];
      const fact = entry.species !== null && Object.hasOwn(speciesFacts, entry.species) ? speciesFacts[entry.species] : undefined;
      const instance = state.encounters?.[encounterInstanceKey(entry.roomId, entry.actionId)];
      return [{
        roomId: entry.roomId,
        actionId: entry.actionId,
        type: action.type,
        species: entry.species,
        name: fact?.name ?? null,
        rarity: fact?.rarity || null,
        outcome: entry.outcome,
        text: entry.text,
        unavailableReason: entry.outcome === 'unavailable' ? (instance?.unavailableReason ?? null) : null,
      }];
    });
    const dungeonBackground = resolveDungeonArtwork(definition.background, snapshot.artwork ?? {});
    return {
      id: row.id,
      status: row.status,
      step: row.step,
      dungeon: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        revision: run.revisionNumber,
        artwork: resolveDungeonArtwork(definition.artwork, snapshot.artwork ?? {}),
        background: dungeonBackground,
      },
      fighter: run.fighter,
      core,
      ...(run.sceneSpriteSnapshot ? { sceneSprites: sceneSpritesForRoom(definition, core.room.id, core.action?.event || core.action?.wave ? core.action.id : lastWave?.actionId ?? core.action?.id, run.sceneSpriteSnapshot) } : {}),
      enemy: sceneEnemy(run, core.action?.wave?.enemy ?? (lastWave?.kind === 'wave' ? snapshot.enemies[lastWave.wave.enemyKey] : undefined)),
      ...(core.action?.event ? { eventArtwork: resolveDungeonArtwork(core.action.event.artwork ?? null, snapshot.artwork ?? {}) } : {}),
      ...(core.action?.event || spent.length > 0 ? { eventItemNames: { ...spentNames, ...run.eventItemNames } } : {}),
      ...(latestEvents.length > 0 ? { latestEvents } : {}),
      ...(encounterActor ? { encounterActor } : {}),
      ...(latestEncounters.length > 0 ? { latestEncounters } : {}),
      roomBackground: roomBackground.assetId || roomBackground.artworkPath ? roomBackground : dungeonBackground,
      combatEvents: events,
      currency: await currencyView(tx, run),
      defeatRetentionBasisPoints: definition.settings.defeatCurrencyRetentionBasisPoints,
      secured,
      latestSecured: secured.filter((s) => s.step === row.step),
      atRisk: { shards: core.unbankedCurrency, waifubux: core.unbankedWaifubux },
      latestAtRisk,
      ...(run.ctx.rewards ? { rewardItemNames: Object.fromEntries(Object.entries(run.ctx.rewards.items).map(([slug, item]) => [slug, item.name])) } : {}),
      abandonRetentionBasisPoints: definition.settings.abandonCurrencyRetentionBasisPoints ?? definition.settings.defeatCurrencyRetentionBasisPoints,
      ...(run.ctx.rewards ? { rewardFormat: 'v2' as const } : {}),
      settlement: (row.settlement as unknown as DungeonSettlement | null) ?? null,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  // ── the live effects adapter ──────────────────────────────────────────────

  function rewardFailure(row: DungeonRunRow, claimKey: string, dependency: string, cause?: unknown,
    activity: unknown = row.cursor): DungeonRewardGrantError {
    deps.logger?.error(
      { tag: 'dungeons/reward-grant-failed', runId: row.id, revisionId: row.revisionId, claimKey,
        activity, dependency, err: cause },
      'dungeon reward delivery aborted; all grants and progress roll back',
    );
    return new DungeonRewardGrantError(row.id, claimKey, dependency, cause);
  }

  async function grantV2(tx: DbOrTx, run: LoadedRun, effect: Extract<DungeonEffect, { type: 'grant_rewards' }>): Promise<DungeonEffectReceipt> {
    const { plan, claimKey } = effect;
    if (!('v' in plan)) throw new Error('Expected v2 reward plan');
    const { row, fighter } = run;
    const bonus = fighter.rewardBonuses ? 'pinned' as const : 'not_pinned' as const;
    const receipt: Extract<DungeonEffectReceipt, { type: 'grant_rewards' }> = {
      type: 'grant_rewards', claimKey, waifubux: 0, items: [], equipment: [], plan,
    };
    let dependency = 'essence';
    try {
      if (plan.secured.essence > 0) {
        const bonusPercent = fighter.rewardBonuses?.essenceGainPercent ?? 0;
        const granted = applyPercentModifierInt(plan.secured.essence, bonusPercent);
        const balances = await deps.currency.grantEssence(tx, row.playerId, granted);
        receipt.essence = { baseAmount: plan.secured.essence, granted, bonusPercent, bonus, balanceAfter: balances.essence };
      }
      for (const grant of [...plan.secured.items].sort((a, b) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0)) {
        dependency = `item:${grant.item}`;
        // Hold the catalogue row until delivery commits, including cap validation.
        const [item] = await tx.select().from(items).where(eq(items.slug, grant.item)).for('share');
        if (!item) throw new DungeonRewardItemUnavailableError(row.id, claimKey, grant.item);
        if (item.maxOwned !== null) throw new Error(`Promised item ${grant.item} now has maxOwned=${item.maxOwned}`);
        await deps.inventory.addItem(tx, row.playerId, item.id, grant.quantity);
        receipt.items.push({ slug: grant.item, quantity: grant.quantity });
      }
      for (const [rewardIndex, drop] of [...plan.secured.equipment].sort((a, b) => a.dropId < b.dropId ? -1 : a.dropId > b.dropId ? 1 : 0).entries()) {
        dependency = `equipment:${drop.definitionKey}:${drop.dropId}`;
        const grant = await deps.equipmentRewards.grantChosenEquipmentReward(tx, {
          playerId: row.playerId, definitionKey: drop.definitionKey, rollSeed: drop.rollSeed,
          allowDisabled: true, promised: true, source: { type: 'dungeon', key: row.dungeonKey },
          grantKey: `dungeon:${claimKey}:${drop.dropId}`,
        });
        receipt.equipment.push({ rewardIndex, ...grant, dropId: drop.dropId, rollSeed: drop.rollSeed });
      }
      if (plan.secured.affection > 0) {
        dependency = `affection:${fighter.waifuId}`;
        const bonusPercent = fighter.rewardBonuses?.affectionGainPercent ?? 0;
        const grant = await deps.collection.awardCopyAffection(tx, {
          playerId: row.playerId, waifuId: fighter.waifuId, baseAmount: plan.secured.affection, bonusPercent,
        });
        receipt.affection = { ...grant, name: fighter.name, speciesSlug: fighter.speciesSlug, bonusPercent, bonus };
      }
      return receipt;
    } catch (cause) {
      throw rewardFailure(row, claimKey, dependency, cause, { roomId: effect.roomId, actionId: effect.actionId });
    }
  }

  /**
   * Spend what an event choice costs. The engine already judged the choice
   * against quantities read in this transaction; the decrement here is
   * conditional, so an item spent elsewhere since that read fails the step —
   * and with it everything the step did — rather than going negative.
   */
  async function consumeItems(tx: DbOrTx, run: LoadedRun, effect: Extract<DungeonEffect, { type: 'consume_items' }>): Promise<DungeonEffectReceipt> {
    const { row } = run;
    const wanted = [...effect.items].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    const rows = await tx.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, wanted.map((i) => i.item)));
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    for (const { item, quantity } of wanted) {
      const itemId = idBySlug.get(item);
      try {
        if (itemId === undefined) throw new InsufficientItemsError(0, quantity);
        await deps.inventory.consumeItem(tx, row.playerId, itemId, quantity);
      } catch (cause) {
        if (!(cause instanceof InsufficientItemsError)) throw cause;
        deps.logger?.info(
          { tag: 'dungeons/event-item-unavailable', runId: row.id, key: effect.key, slug: item, quantity },
          'dungeon event choice aborted: the item it spends is no longer held; the step rolls back',
        );
        throw new DungeonEventItemUnavailableError(row.id, item, quantity);
      }
    }
    return { type: 'consume_items', key: effect.key, items: wanted };
  }

  // ── encounters: the live capture and rescue effects ───────────────────────

  function captureDep(): NonNullable<DungeonRunServiceDeps['capture']> {
    if (!deps.capture) throw new Error('Dungeon encounters need the capture service, which this run service was built without');
    return deps.capture;
  }

  /** The engine's own draw as the capture service's generator: one fixed value, so Base SP is the place-keyed roll. */
  function fixedDraw(value: number) {
    return { next: () => value, intInclusive: (min: number, max: number) => Math.floor(value * (max - min + 1)) + min };
  }

  /**
   * The species a grant is about to create, judged against live policy one
   * last time. The engine judged her by facts read moments ago in this
   * transaction; this is the same rule on a fresh, share-locked row and a
   * fresh ledger count, so a species disabled or restricted, or a limit
   * reached, between the offer and the grant is refused here with nothing
   * spent. The throw rolls the step back; the retry resolves `unavailable`.
   */
  async function speciesForGrant(tx: DbOrTx, run: LoadedRun, slug: string, direct: boolean): Promise<SpeciesRow> {
    const { row } = run;
    const [found] = await tx.select().from(species).where(eq(species.slug, slug)).for('share');
    const counts = found ? await dungeonAcquisitionCounts(tx, row.playerId, row.dungeonKey) : new Map<number, number>();
    const reason = dungeonSpeciesUnavailableReason(
      dungeonSpeciesPolicy(found, deps.speciesAccess), row.dungeonKey, direct, found ? (counts.get(found.id) ?? 0) : 0,
    );
    if (!found || reason) {
      deps.logger?.info(
        { tag: 'dungeons/encounter-species-unavailable', runId: row.id, dungeonKey: row.dungeonKey, slug, reason: reason ?? 'missing' },
        'dungeon encounter grant refused by live species policy; the step rolls back',
      );
      throw new DungeonEncounterSpeciesUnavailableError(row.id, slug, reason ?? 'missing');
    }
    return found;
  }

  /** One ledger row per copy granted. Its unique grant key is the second lock on a double grant. */
  async function recordAcquisition(
    tx: DbOrTx, run: LoadedRun, place: { roomId: string; actionId: string; grantKey: string },
    mode: DungeonAcquisitionMode, found: SpeciesRow, waifu: PlayerWaifuRow, opts: { replay?: boolean } = {},
  ): Promise<void> {
    const insert = tx.insert(dungeonSpeciesAcquisitions).values({
      playerId: run.row.playerId, speciesId: found.id, dungeonKey: run.row.dungeonKey, runId: run.row.id,
      roomId: place.roomId, actionId: place.actionId, mode, waifuId: waifu.id, grantKey: place.grantKey,
    });
    // A replayed rescue found the copy its key already made; its ledger row is then already there too.
    await (opts.replay ? insert.onConflictDoNothing({ target: dungeonSpeciesAcquisitions.grantKey }) : insert);
  }

  function acquired(found: SpeciesRow, waifu: PlayerWaifuRow, facts: { isDuplicate: boolean; isNewDex: boolean }): DungeonAcquiredWaifu {
    return { waifuId: waifu.id, speciesSlug: found.slug, name: found.name, rarity: found.rarity, baseSp: waifu.baseSp, ...facts };
  }

  /**
   * One real capture attempt. The engine decided it — which charm, the quoted
   * chance, the place-keyed roll, and so the outcome. This spends the charm
   * and the Microdose charge and, on a success, creates the copy with her XP,
   * quests and ledger row, all through `captureService.resolveCaptureAttempt`
   * in this transaction.
   *
   * The capture service recomputes the chance from the same inputs. Should it
   * disagree with the quote the engine rolled against, the facts moved under
   * the step (a Microdose charge spent by a hunted capture, say) and the step
   * is rolled back rather than committing a result the player was not shown.
   */
  async function captureAttempt(tx: DbOrTx, run: LoadedRun, effect: Extract<DungeonEffect, { type: 'capture_attempt' }>): Promise<DungeonEffectReceipt> {
    const { row } = run;
    const capture = captureDep();
    const action = run.definition.rooms.find((r) => r.id === effect.roomId)?.actions.find((a) => a.id === effect.actionId);
    const rules = action && isEncounterAction(action) ? captureRules(action) : null;
    if (!rules) throw new Error(`Dungeon run ${row.id} capture effect "${effect.key}" names no capture encounter`);
    const found = await speciesForGrant(tx, run, effect.species, false);
    const unusable = (cause?: unknown) => {
      deps.logger?.info(
        { tag: 'dungeons/capture-item-unavailable', runId: row.id, key: effect.key, slug: effect.attempt.item },
        'dungeon capture attempt aborted: its charm can no longer be spent; the step rolls back',
      );
      return new DungeonCaptureItemUnavailableError(row.id, effect.attempt.item, cause);
    };
    const [item] = await tx.select().from(items).where(eq(items.slug, effect.attempt.item));
    if (!item) throw unusable();

    let resolved: Awaited<ReturnType<CaptureService['resolveCaptureAttempt']>>;
    try {
      resolved = await capture.resolveCaptureAttempt(tx, {
        playerId: row.playerId,
        species: found,
        item,
        finalAttempt: effect.attempt.n >= rules.maxAttempts,
        roll: effect.attempt.roll,
        rng: fixedDraw(effect.spRoll),
        buddyOverride: pinnedBuddy(run.fighter),
        provenance: { acquiredVia: effect.mode === 'rescue' ? 'dungeon_rescue' : 'dungeon_capture', grantKey: effect.grantKey },
        logContext: { dungeonRunId: row.id, dungeonKey: row.dungeonKey, attemptKey: effect.key },
      });
    } catch (cause) {
      if (cause instanceof InsufficientItemsError || cause instanceof ItemNotFoundError ||
        cause instanceof ItemNotUsableError || cause instanceof CaptureItemNotEligibleError) throw unusable(cause);
      throw cause;
    }
    const sameQuote = resolved.guaranteed === effect.guaranteed &&
      (resolved.guaranteed || Math.abs(resolved.chance - effect.attempt.chance) < 1e-9);
    if (!sameQuote || resolved.success !== effect.attempt.success) {
      deps.logger?.info(
        { tag: 'dungeons/capture-quote-changed', runId: row.id, key: effect.key, quoted: effect.attempt.chance, resolved: resolved.chance },
        'dungeon capture attempt aborted: its chance changed between the quote and the spend; the step rolls back',
      );
      throw new DungeonCaptureQuoteChangedError(row.id, effect.key);
    }
    if (resolved.newWaifu) {
      await recordAcquisition(tx, run, effect, effect.mode === 'rescue' ? 'rescue_capture' : 'capture', found, resolved.newWaifu);
    }
    return {
      type: 'capture_attempt', key: effect.key, simulated: false, grantKey: effect.grantKey,
      roomId: effect.roomId, actionId: effect.actionId, species: effect.species, mode: effect.mode,
      item: item.slug, attemptNumber: effect.attempt.n, success: resolved.success, outcome: resolved.outcome, guaranteed: resolved.guaranteed,
      chance: resolved.chance, roll: resolved.roll, xpGranted: resolved.xpGranted, levelUps: resolved.levelUps,
      microdose: resolved.effect && { sourceItemSlug: resolved.effect.sourceItemSlug, chargesRemaining: resolved.effect.chargesRemaining },
      acquired: resolved.newWaifu ? acquired(found, resolved.newWaifu, resolved) : null,
      newAppearances: resolved.newAppearances,
    };
  }

  /** One real direct rescue: the copy, her XP and her ledger row. No charm, no roll, no capture quest. */
  async function rescueGrant(tx: DbOrTx, run: LoadedRun, effect: Extract<DungeonEffect, { type: 'rescue_grant' }>): Promise<DungeonEffectReceipt> {
    const { row } = run;
    const capture = captureDep();
    const found = await speciesForGrant(tx, run, effect.species, true);
    const grant = await capture.grantSpeciesCopy(tx, {
      playerId: row.playerId,
      species: found,
      grantKey: effect.grantKey,
      acquiredVia: 'dungeon_rescue',
      rng: fixedDraw(effect.spRoll),
      buddyOverride: pinnedBuddy(run.fighter),
      logContext: { dungeonRunId: row.id, dungeonKey: row.dungeonKey },
    });
    await recordAcquisition(tx, run, effect, 'rescue_direct', found, grant.waifu, { replay: grant.replayed });
    return {
      type: 'rescue_grant', grantKey: effect.grantKey, simulated: false,
      roomId: effect.roomId, actionId: effect.actionId, species: effect.species,
      replayed: grant.replayed, xpGranted: grant.xpGranted, levelUps: grant.levelUps,
      acquired: acquired(found, grant.waifu, grant),
      newAppearances: grant.replayed ? [] : grant.newAppearances,
    };
  }

  /**
   * Carries the engine's effects out for real, inside the step's transaction.
   * The only place a dungeon touches inventory, currency, Equipment or ownership.
   */
  function liveEffectsPort(tx: DbOrTx, run: LoadedRun): DungeonEffectsPort {
    const { row } = run;
    return {
      async apply(effect: DungeonEffect): Promise<DungeonEffectReceipt> {
        if (effect.type === 'grant_rewards') {
          const { plan, claimKey } = effect;
          if ('v' in plan) return grantV2(tx, run, effect);
          if (plan.waifubux > 0) await deps.currency.grantWaifubux(tx, row.playerId, plan.waifubux);

          const granted: typeof plan.items = [];
          if (plan.items.length > 0) {
            const slugs = [...new Set(plan.items.map((i) => i.slug))];
            const rows = await tx.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, slugs));
            const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
            for (const grant of plan.items) {
              const itemId = idBySlug.get(grant.slug);
              if (itemId === undefined) {
                // Abort the step so grants, claim, cursor and history all roll
                // back. Restoring the item lets the same interaction retry.
                deps.logger?.error(
                  { tag: 'dungeons/missing-item', runId: row.id, claimKey, slug: grant.slug },
                  'dungeon reward names an item that is not in the database — delivery aborted',
                );
                throw new DungeonRewardItemUnavailableError(row.id, claimKey, grant.slug);
              }
              await deps.inventory.addItem(tx, row.playerId, itemId, grant.quantity);
              granted.push(grant);
            }
          }

          const equipment: DungeonEquipmentGrant[] = [];
          for (const [rewardIndex, drop] of plan.equipment.entries()) {
            const grant = await deps.equipmentRewards.grantChosenEquipmentReward(tx, {
              playerId: row.playerId,
              definitionKey: drop.definitionKey,
              // The run was promised this definition when it started, while the
              // player held the Equipment unlock and the definition was enabled.
              allowDisabled: true,
              promised: true,
              source: { type: 'dungeon', key: row.dungeonKey },
              grantKey: equipmentGrantKey(claimKey, rewardIndex),
            });
            equipment.push({
              rewardIndex,
              equipmentId: grant.equipmentId,
              definitionKey: grant.definitionKey,
              displayName: grant.displayName,
              slot: grant.slot,
              rarity: grant.rarity,
              rolledMultiplierBp: grant.rolledMultiplierBp,
              combatBonuses: grant.combatBonuses,
            });
          }
          return { type: 'grant_rewards', claimKey, waifubux: plan.waifubux, items: granted, equipment };
        }
        if (effect.type === 'capture_attempt') return captureAttempt(tx, run, effect);
        if (effect.type === 'rescue_grant') return rescueGrant(tx, run, effect);
        if (effect.type === 'consume_items') return consumeItems(tx, run, effect);

        const { end, currencyKey, requestKey } = effect;
        const receipt: Extract<DungeonEffectReceipt, { type: 'settle_run' }> = {
          type: 'settle_run', banked: 0, bankingSkipped: null, balanceAfter: null,
        };
        let dependency = 'settlement:shards';
        try {
          if (end.banked > 0) {
            const live = currencyKey ? await deps.currencies.get(currencyKey, tx) : null;
            if (!live || !live.enabled) {
              // Preserve the old missing/disabled progression-currency policy.
              deps.logger?.warn(
                { tag: 'dungeons/banking-skipped', runId: row.id, currencyKey, amount: end.banked },
                'dungeon settlement could not bank: the progression currency is missing or disabled',
              );
              receipt.bankingSkipped = live ? 'currency_disabled' : 'no_currency';
            } else {
              const grant = await deps.currencies.grant(tx, {
                playerId: row.playerId,
                currencyKey: live.key,
                amount: end.banked,
                reason: BANK_REASON[end.outcome],
                sourceRef: `dungeon_run:${row.id}`,
                requestKey,
                metadata: { dungeonKey: row.dungeonKey, outcome: end.outcome, earned: end.earned, retentionBasisPoints: end.retentionBasisPoints },
              });
              receipt.banked = end.banked;
              receipt.balanceAfter = grant.balance;
            }
          }
          // WaifuBux has its own wallet; missing Shards does not invalidate it.
          if (end.waifubux) {
            dependency = 'settlement:waifubux';
            const balanceAfter = end.waifubux.banked > 0
              ? (await deps.currency.grantWaifubux(tx, row.playerId, end.waifubux.banked)).waifubux : null;
            receipt.waifubux = { banked: end.waifubux.banked, balanceAfter };
          }
          return receipt;
        } catch (cause) {
          throw rewardFailure(row, requestKey, dependency, cause);
        }
      },
    };
  }

  /** What the effects of a step add to the run row and its history. */
  function settle(
    run: LoadedRun,
    step: number,
    receipts: readonly DungeonEffectReceipt[],
    end: DungeonRunEnd | null,
  ): { secured: DungeonSecuredReward[]; settlement: DungeonSettlement | null; log: DungeonLogEntry[] } {
    const secured: DungeonSecuredReward[] = [];
    const log: DungeonLogEntry[] = [];
    let settlement: DungeonSettlement | null = end ? { ...end, bankingSkipped: null, balanceAfter: null } : null;
    for (const receipt of receipts) {
      if (receipt.type === 'grant_rewards') {
        const source = receipt.claimKey;
        for (const e of receipt.equipment) secured.push({ kind: 'equipment', source, step, ...e });
        if (receipt.waifubux > 0) secured.push({ kind: 'waifubux', source, step, amount: receipt.waifubux });
        for (const i of receipt.items) secured.push({ kind: 'item', source, step, slug: i.slug, quantity: i.quantity });
        if (receipt.essence) secured.push({ kind: 'essence', source, step, ...receipt.essence });
        if (receipt.affection) secured.push({ kind: 'affection', source, step, ...receipt.affection });
        log.push({
          type: 'rewards_granted',
          roomId: null,
          actionId: null,
          payload: { claimKey: receipt.claimKey, waifubux: receipt.waifubux, items: receipt.items, equipment: receipt.equipment,
            ...(receipt.plan ? { v: 2, plan: receipt.plan, atRisk: receipt.plan.atRisk } : {}),
            ...(receipt.essence ? { essence: receipt.essence } : {}),
            ...(receipt.affection ? { affection: receipt.affection } : {}),
          },
        });
      } else if (receipt.type === 'consume_items') {
        log.push({ type: 'items_consumed', roomId: null, actionId: null, payload: { key: receipt.key, items: receipt.items } });
      } else if ((receipt.type === 'capture_attempt' || receipt.type === 'rescue_grant') && !receipt.simulated && receipt.acquired) {
        log.push({
          type: 'waifu_acquired',
          roomId: receipt.roomId,
          actionId: receipt.actionId,
          payload: {
            grantKey: receipt.grantKey,
            mode: receipt.type === 'rescue_grant' ? 'rescue_direct' : receipt.mode === 'rescue' ? 'rescue_capture' : 'capture',
            ...receipt.acquired,
            xpGranted: receipt.xpGranted,
            ...(receipt.type === 'rescue_grant' ? { replayed: receipt.replayed } : { attemptKey: receipt.key, item: receipt.item }),
          },
        });
      } else if (receipt.type === 'settle_run' && settlement) {
        settlement = {
          ...settlement,
          banked: receipt.banked,
          lost: settlement.earned - receipt.banked,
          bankingSkipped: receipt.bankingSkipped,
          balanceAfter: receipt.balanceAfter,
          ...(receipt.waifubux && settlement.waifubux ? {
            waifubux: { earned: settlement.waifubux.earned, banked: receipt.waifubux.banked,
              lost: settlement.waifubux.earned - receipt.waifubux.banked },
            waifubuxBalanceAfter: receipt.waifubux.balanceAfter,
          } : {}),
        };
        if (receipt.banked > 0) {
          log.push({
            type: 'currency_banked',
            roomId: settlement.roomId,
            actionId: null,
            payload: { currencyKey: run.definition.settings.progressionCurrency, amount: receipt.banked, balanceAfter: receipt.balanceAfter },
          });
        }
        if (receipt.waifubux && receipt.waifubux.banked > 0) {
          log.push({ type: 'currency_banked', roomId: settlement.roomId, actionId: null,
            payload: { currencyKey: 'waifubux', amount: receipt.waifubux.banked, balanceAfter: receipt.waifubux.balanceAfter } });
        }
      }
    }
    return { secured, settlement, log };
  }

  async function appendLog(tx: DbOrTx, row: Pick<DungeonRunRow, 'id' | 'playerId'>, step: number, log: readonly DungeonLogEntry[]): Promise<void> {
    if (log.length === 0) return;
    await tx.insert(dungeonRunEvents).values(
      log.map((entry) => ({
        runId: row.id,
        playerId: row.playerId,
        step,
        type: entry.type,
        roomId: entry.roomId,
        actionId: entry.actionId,
        payload: entry.payload,
      })),
    );
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /**
   * The whole of a start, in one transaction: the player lock, the one-active-
   * run check, the pinned revision, the fighter and dependency snapshots, the
   * daily attempt and the run's first events. Anything thrown rolls all of it
   * back — the attempt too.
   */
  async function startInTransaction(playerId: number, dungeonKey: string, opts: { seed?: number }): Promise<DungeonRunView> {
    return db.transaction(async (tx) => {
      await requireUnlocked(playerId, tx);
      // Serialise a player's starts, so a double click meets the checks below
      // (the active run, then the allowance) rather than the unique index.
      const [player] = await tx
        .select({ id: players.id, region: players.currentRegion })
        .from(players)
        .where(eq(players.id, playerId))
        .for('update');
      if (!player) throw new PlayerNotFoundError(playerId);
      if (await activeRow(tx, playerId)) throw new DungeonRunActiveError(playerId);

      const published = await deps.content.published(tx, dungeonKey);
      if (typeof published === 'string') throw new DungeonUnavailableError(dungeonKey, published);
      const { definition, revision } = published;
      // Read off the locked player row, so travel cannot slip between check and start.
      const region = regionView(player.region);
      if (!definition.availableRegions.includes(region.id)) {
        throw new DungeonUnavailableError(dungeonKey, 'region', region.name);
      }

      const fighter = fighterFromCombatStats(await deps.combatStats.snapshotCombatStats(tx, playerId));
      const buddyBonus = deps.buddyBonus?.bonusForSpeciesSlug(fighter.speciesSlug) ?? null;
      fighter.rewardBonuses = pinnedRewardBonuses(fighter.speciesSlug, buddyBonus);
      // Frozen beside the reward bonuses, and for the same reason: a capture
      // later in this run reads the Buddy it started with, as she was then.
      const [buddySpecies] = await tx
        .select({ affinity: species.affinity, rarity: species.rarity })
        .from(species)
        .where(eq(species.slug, fighter.speciesSlug));
      if (buddySpecies) fighter.captureBuddy = pinnedCaptureBuddy(buddySpecies, buddyBonus);
      const snapshot = await buildSnapshot(tx, definition);
      // Spent before the run is created so an exhausted allowance is refused
      // cheaply; it is only kept if everything below commits.
      const daily = await deps.allowance.consume(tx, playerId);

      const seed = opts.seed ?? randomDungeonSeed();
      const [inserted] = await tx
        .insert(dungeonRuns)
        .values({
          playerId,
          dungeonKey: definition.key,
          revisionId: revision.id,
          seed,
          // Placeholders: the row exists first so the engine can key on its id.
          cursor: { roomId: definition.entranceRoomId, actionId: null, waveIndex: 0, cameFrom: null },
          currentHp: fighter.maxHp,
          fighter: fighter as unknown as Record<string, unknown>,
          dependencySnapshot: snapshot as unknown as Record<string, unknown>,
        })
        .returning();
      const run = await load(tx, inserted!);
      const started = startDungeonRun(run.ctx, seed);
      const receipts = await applyDungeonEffects(liveEffectsPort(tx, run), started.effects);
      const extra = settle(run, 0, receipts, started.state.end);
      const row = await write(tx, run, started.state, extra);
      await appendLog(tx, row, 0, [
        {
          type: 'run_started',
          roomId: null,
          actionId: null,
          payload: {
            dungeonKey: definition.key,
            revision: revision.number,
            revisionId: revision.id,
            contentHash: revision.contentHash,
            seed,
            roomCount: definition.rooms.length,
            fighter,
            daily: { periodKey: daily.periodKey, limit: daily.limit, used: daily.used },
            // Where the run was started. For audit only: nothing reads it back.
            region: region.id,
          },
        },
        ...started.log,
        ...extra.log,
      ]);
      deps.logger?.info(
        {
          tag: 'dungeons/daily-usage-consumed',
          playerId,
          runId: row.id,
          dungeonKey: definition.key,
          revision: revision.number,
          periodKey: daily.periodKey,
          used: daily.used,
          limit: daily.limit,
          remaining: daily.remaining,
        },
        'dungeon run started: daily run consumed',
      );
      return runView(tx, await reloaded(tx, run, row), started.combat.at(-1)?.events ?? null);
    });
  }

  /** Write an engine state back to the run row. */
  async function write(
    tx: DbOrTx,
    run: LoadedRun,
    state: DungeonRunState,
    extra: { secured: DungeonSecuredReward[]; settlement: DungeonSettlement | null },
  ): Promise<DungeonRunRow> {
    const now = new Date();
    const [updated] = await tx
      .update(dungeonRuns)
      .set({
        status: state.status,
        step: state.step,
        cursor: state.cursor as unknown as Record<string, unknown>,
        currentHp: state.hp,
        flags: state.flags,
        roomStates: state.rooms as unknown as Record<string, unknown>,
        rewardClaims: state.rewardClaims as unknown as Record<string, unknown>,
        eventStates: (state.events ?? {}) as unknown as Record<string, unknown>,
        encounterStates: (state.encounters ?? {}) as unknown as Record<string, unknown>,
        unbankedCurrency: state.unbankedCurrency,
        unbankedWaifubux: state.unbankedWaifubux ?? 0,
        recent: state.recent as unknown as Record<string, unknown>[],
        securedRewards: [...(run.row.securedRewards as unknown as DungeonSecuredReward[]), ...extra.secured] as unknown as Record<string, unknown>[],
        settlement: extra.settlement as unknown as Record<string, unknown> | null,
        updatedAt: now,
        completedAt: state.status === 'active' ? null : (run.row.completedAt ?? now),
      })
      .where(eq(dungeonRuns.id, run.row.id))
      .returning();
    return updated!;
  }

  // ── service ───────────────────────────────────────────────────────────────

  return {
    async isAvailable(playerId) {
      return deps.featureUnlocks.isUnlocked(playerId, DUNGEON_FEATURE);
    },

    async home(playerId) {
      await requireUnlocked(playerId);
      const region = await currentRegion(db, playerId);
      const dungeons: DungeonCard[] = [];
      for (const { definition } of await deps.content.openDungeons(db)) {
        // Only what can be started here. A dungeon elsewhere is not listed at all.
        if (!definition.availableRegions.includes(region.id)) continue;
        dungeons.push(await card(db, playerId, definition));
      }
      const active = await activeRow(db, playerId);
      const [stats, daily] = await Promise.all([deps.combatStats.calculateCombatStats(playerId), deps.allowance.status(playerId)]);
      return {
        region,
        dungeons,
        activeRun: active ? await runView(db, await load(db, active)) : null,
        blocker: stats.unavailableReason,
        daily,
      };
    },

    async dungeon(playerId, dungeonKey) {
      await requireUnlocked(playerId);
      const published = await deps.content.published(db, dungeonKey);
      if (typeof published === 'string') throw new DungeonUnavailableError(dungeonKey, published);
      const region = await currentRegion(db, playerId);
      if (!published.definition.availableRegions.includes(region.id)) {
        throw new DungeonUnavailableError(dungeonKey, 'region', region.name);
      }
      const [dungeon, stats, active, daily] = await Promise.all([
        card(db, playerId, published.definition),
        deps.combatStats.calculateCombatStats(playerId),
        activeRow(db, playerId),
        deps.allowance.status(playerId),
      ]);
      return { dungeon, stats, blocker: stats.unavailableReason, activeRunId: active?.id ?? null, daily };
    },

    async start(playerId, dungeonKey, opts = {}) {
      try {
        return await startInTransaction(playerId, dungeonKey, opts);
      } catch (err) {
        // The loser of two concurrent starts meets the index, not the check.
        if (uniqueViolationConstraint(err) === 'dungeon_runs_one_active_uq') throw new DungeonRunActiveError(playerId);
        if (err instanceof DungeonDailyLimitError) {
          deps.logger?.info(
            { tag: 'dungeons/start-refused-daily-limit', playerId, dungeonKey, limit: err.limit, used: err.used, periodKey: err.periodKey },
            'dungeon run start refused: daily limit reached',
          );
        }
        throw err;
      }
    },

    async activeRun(playerId) {
      await requireUnlocked(playerId);
      const row = await activeRow(db, playerId);
      return row ? runView(db, await load(db, row)) : null;
    },

    async run(playerId, runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new DungeonRunNotFoundError(runId);
      const [row] = await db
        .select()
        .from(dungeonRuns)
        .where(and(eq(dungeonRuns.id, runId), eq(dungeonRuns.playerId, playerId)));
      if (!row) throw new DungeonRunNotFoundError(runId);
      return runView(db, await load(db, row));
    },

    async act(playerId, runId, input) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new DungeonRunNotFoundError(runId);
      // Abandoning is the one thing a player may always do, so it does not sit behind the unlock.
      if (input.type !== 'abandon') await requireUnlocked(playerId);
      const step = () => db.transaction(async (tx): Promise<DungeonActionResult> => {
        const [row] = await tx
          .select()
          .from(dungeonRuns)
          .where(and(eq(dungeonRuns.id, runId), eq(dungeonRuns.playerId, playerId)))
          .for('update');
        if (!row) throw new DungeonRunNotFoundError(runId);
        // A capture or rescue writes inventory, ownership and XP. The player's
        // currency and player rows are locked straight after the run, in the
        // order a hunt takes them and before any fact is read: see
        // "Encounters" at the top of this file.
        if (input.type === 'capture' || input.type === 'rescue') {
          await tx.select({ playerId: playerCurrencies.playerId }).from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId)).for('update');
          await tx.select({ id: players.id }).from(players).where(eq(players.id, playerId)).for('update');
        }
        const run = await load(tx, row);
        const result = stepDungeon(stateOf(row), input, run.ctx);
        if (result.status === 'refused') {
          return { status: 'refused', refusal: result.refusal, run: await runView(tx, run) };
        }
        const receipts = await applyDungeonEffects(liveEffectsPort(tx, run), result.effects);
        const extra = settle(run, result.state.step, receipts, result.state.end);
        const written = await write(tx, run, result.state, extra);
        await appendLog(tx, written, result.state.step, [...result.log, ...extra.log]);
        if (extra.settlement) {
          deps.logger?.info(
            {
              tag: 'dungeons/run-settled',
              runId: row.id,
              playerId,
              dungeonKey: row.dungeonKey,
              revision: run.revisionNumber,
              outcome: extra.settlement.outcome,
              cause: extra.settlement.cause,
              finalHp: extra.settlement.finalHp,
              earned: extra.settlement.earned,
              banked: extra.settlement.banked,
              lost: extra.settlement.lost,
              steps: result.state.step,
            },
            `dungeon run ${extra.settlement.outcome}`,
          );
        }
        const encounterReceipts = receipts.filter((r): r is DungeonEncounterReceipt =>
          (r.type === 'capture_attempt' || r.type === 'rescue_grant') && !r.simulated);
        return {
          status: 'applied',
          refusal: null,
          run: await runView(tx, await reloaded(tx, run, written), result.combat.at(-1)?.events ?? null),
          ...(encounterReceipts.length > 0 ? { encounterReceipts } : {}),
        };
      });
      // A deadlock victim wrote nothing: Postgres rolled its transaction back
      // whole. The step is a pure function of the stored run and place-keyed
      // draws, so running it again decides exactly what it decided before.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await step();
        } catch (err) {
          if (!isDeadlockError(err)) throw err;
          deps.logger?.warn(
            { tag: 'dungeons/step-deadlock', runId, playerId, inputType: input.type, attempt },
            'dungeon step was a deadlock victim and rolled back whole',
          );
          if (attempt >= STEP_DEADLOCK_ATTEMPTS) throw new DungeonStepContendedError(runId, err);
        }
      }
    },

    async history(runId) {
      const rows = await db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, runId)).orderBy(asc(dungeonRunEvents.id));
      return rows.map((r) => ({
        id: r.id,
        step: r.step,
        type: r.type,
        roomId: r.roomId,
        actionId: r.actionId,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    },

    async dailyAllowance(playerId) {
      return deps.allowance.status(playerId);
    },
  };
}

/** Whether a room holds a fight, for cards and previews. */
export function roomHasCombat(room: DungeonDefinition['rooms'][number]): boolean {
  return room.actions.some(isCombatAction);
}
