/**
 * Playing a dungeon run: starting one, walking its graph, resolving nodes,
 * extracting, and settling it when it ends.
 *
 * Presenter-neutral. Every method returns a read model (`DungeonHomeView`,
 * `DungeonRunView`) of numbers and keys — no embeds, no prose — so Discord
 * drives it today and the Portal can later. The rules themselves (what a node
 * does, what it pays, what is banked) are the pure functions in
 * `dungeonRunState.ts`; this service applies them to a locked run row.
 *
 * ## Eligibility (V1)
 *
 * The permanent `equipment` feature unlock, an active Buddy, and a complete
 * loadout (Attack, Defense and Health all equipped) — the same gate as Combat
 * Trials. There is no level gate of its own.
 *
 * ## Daily allowance
 *
 * Starting a run spends one of the player's daily Delve runs
 * (`dungeonAllowanceService`) — shared by every zone, separate from Energy —
 * in the transaction that creates the run. So a start that is refused or
 * fails spends nothing, and a start that succeeds spends exactly one. Nothing
 * else touches the allowance: resuming, moving, resolving, extracting,
 * completing, dying and abandoning neither spend nor refund. A run that is
 * still active when the day rolls over simply carries on; it was paid for on
 * the day it started.
 *
 * ## Region availability
 *
 * A zone names the regions it can be started in (`availableRegions`). The home
 * lists only the enabled zones available where the player is standing
 * (`players.current_region`), and `start` checks the same thing again inside
 * its transaction against the locked player row — the listing is never
 * trusted. That is the only place region matters: an active run is playable,
 * resumable and finishable wherever the player travels, and a later edit to
 * the zone's regions does not reach it.
 *
 * ## Snapshot semantics
 *
 * `start` snapshots the active Buddy and her Equipment-derived ATK / DEF /
 * max HP into `dungeon_runs.fighter`, inside the transaction that generates
 * the run. From then on the run reads only that snapshot and the content
 * snapshot taken beside it: changing gear, changing the active Buddy, or an
 * Admin edit to the zone, an enemy or a reward table never reaches it.
 * Equipment management stays fully usable while a run is active.
 *
 * ## Node lifecycle
 *
 *   available  an outgoing node of the completed current node (read off the graph)
 *   entered    the player is on it; it has not been resolved    (`enterNode`)
 *   completed  resolved exactly once; its resolution is stored  (`resolveNode`)
 *
 * Entering is permanent: the other side of a fork is gone. V1 combat is
 * automatic, so resolving and completing are one step.
 *
 * ## Rewards
 *
 *   - Equipment, WaifuBux and items are **secured**: granted to the player in
 *     the transaction that resolves the node, and kept whatever happens next.
 *   - Progression currency is **unbanked**: it accumulates on the run and
 *     reaches the permanent balance only at settlement — all of it on
 *     extraction or completion, the zone's retention share on defeat or
 *     abandon.
 *
 * ## Idempotency and concurrency
 *
 * Every mutation is one transaction that first takes `FOR UPDATE` on the run
 * row, so two actions on one run are serialised and exactly one legal
 * transition wins. The natural keys do the rest:
 *
 *   - a node is resolved only while it is `entered`; a second click finds it
 *     `completed` and reads the stored resolution back (`replayed`);
 *   - a gear drop's grant key is `dungeon:<run>:<node>:<index>`, so the
 *     Equipment service returns the same instance for the same drop;
 *   - settlement happens only while the run is `active`, and the banking grant
 *     carries the request key `dungeon_run:<run>:settlement`.
 *
 * An action that lost a race or names something illegal changes nothing and
 * comes back `refused` with the run as it now stands.
 *
 * ## Procedural and authored zones
 *
 * There is one play service. A run's graph is built once, at start — generated
 * for a procedural zone, compiled from its rooms for an authored one
 * (`authoredLayout.buildDungeonGraph`) — and everything here reads that stored
 * graph. Nothing below asks which mode a run came from.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  dungeonRunEvents,
  dungeonRuns,
  dungeonZones,
  items,
  players,
  type DungeonRunEventRow,
  type DungeonRunEventType,
  type DungeonRunRow,
  type DungeonRunStatus,
} from '../../db/schema';
import {
  ContentValidationError,
  DungeonDailyLimitError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonRunUnplayableError,
  DungeonZoneUnavailableError,
  FeatureLockedError,
  PlayerNotFoundError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { resolveEnemyVisual, roomEnemyArtwork, type EnemyVisual } from '../artworkAssets/enemyArtworkService';
import type { CombatEvent, CombatRules } from '../combat/combatTypes';
import { regionLabel } from '../locations/regions';
import type { CurrencyService } from '../currency/currencyService';
import type { CombatStatsService } from '../equipment/combatStatsService';
import type { CombatStats, CombatStatsUnavailableReason } from '../equipment/equipmentMath';
import type { EquipmentRewardService } from '../equipment/equipmentRewardService';
import type { FeatureUnlockService } from '../features/featureUnlockService';
import type { InventoryService } from '../inventory/inventoryService';
import type { ProgressionCurrencyService } from '../progressionCurrency/progressionCurrencyService';
import type { DungeonAllowanceService, DungeonDailyAllowance } from './dungeonAllowanceService';
import type { DungeonGraphNode } from './dungeonGenerator';
import { toDungeonRun, type DungeonRun, type DungeonRunService } from './dungeonRunService';
import type { DungeonSceneBackground } from './dungeonScenes';
import {
  NO_REWARDS,
  availableNodes,
  dungeonCombatSeed,
  dungeonEquipmentGrantKey,
  enemyOf,
  eventEffect,
  eventOf,
  fighterFromCombatStats,
  fightEnemy,
  hpAfterEvent,
  hpAfterRest,
  nodeOf,
  restHealBasisPoints,
  rollNodeRewards,
  rollRunBonus,
  securedRewardsOf,
  settleCurrency,
  type DungeonFighter,
  type DungeonNodeResolution,
  type DungeonNodeStates,
  type DungeonNodeStatus,
  type DungeonRewardPlan,
  type DungeonRewards,
  type DungeonRunOutcome,
  type DungeonSecuredReward,
  type DungeonSettlement,
} from './dungeonRunState';
import { parseDungeonZoneRow, readDungeonZoneRow } from './dungeonZoneStore';
import { zoneEndsOnBoss, zoneRunLength } from './authoredLayout';
import {
  BASIS_POINTS,
  isEnemyNodeType,
  type DungeonNodeType,
  type DungeonZoneDefinition,
} from './zoneDefinition';

/** The feature that gates dungeons: no Equipment means no combat stats. */
export const DUNGEON_FEATURE = 'equipment' as const;

// ── read models ─────────────────────────────────────────────────────────────

/** How to name the progression currency. Always the configured metadata. */
export interface DungeonCurrencyView {
  key: string;
  singularName: string;
  pluralName: string;
  icon: string | null;
}

export interface DungeonZoneCard {
  key: string;
  name: string;
  description: string;
  artworkPath: string | null;
  backgroundArtworkPath: string | null;
  /** Managed overrides of the two paths; each wins while its asset is active. */
  artworkAssetId: string | null;
  backgroundAssetId: string | null;
  /** The shallowest and deepest final depth a run of this zone can have. */
  minDepth: number;
  maxDepth: number;
  hasBoss: boolean;
  currency: DungeonCurrencyView | null;
  /** The player's permanent balance of that currency. */
  balance: number;
  defeatRetentionBasisPoints: number;
}

export interface DungeonNodeView {
  id: string;
  depth: number;
  type: DungeonNodeType;
  boss: boolean;
  terminal: boolean;
  /** Whether the player may extract here once the node is completed. */
  extraction: boolean;
  enemy: {
    key: string;
    name: string;
    attack: number;
    defense: number;
    hp: number;
    artworkPath: string | null;
    /** Full art, sprite and sprite placement: the run's snapshot of managed art over the shipped values. */
    visual: EnemyVisual;
  } | null;
  event: { key: string; name: string; description: string; artworkPath: string | null } | null;
  /** The background this node drew when the run was generated; null to use the zone's. */
  background: DungeonSceneBackground | null;
  /** For a rest node: the share of max HP it restores. */
  restHealBasisPoints: number | null;
  /** What the author named the room; null on a generated node, or an unnamed room. */
  label: string | null;
}

export interface DungeonRunView {
  id: number;
  status: DungeonRunStatus;
  zone: {
    key: string;
    name: string;
    description: string;
    artworkPath: string | null;
    backgroundArtworkPath: string | null;
    artworkAssetId: string | null;
    backgroundAssetId: string | null;
  };
  /** The snapshotted Buddy and stats — not the player's live ones. */
  fighter: DungeonFighter;
  currentHp: number;
  depth: number;
  depthCount: number;
  node: DungeonNodeView;
  nodeStatus: DungeonNodeStatus;
  /** The current node's resolution, once completed. */
  resolution: DungeonNodeResolution | null;
  /** The engine's events for the current node's fight. For formatting; never shown raw. */
  combatEvents: CombatEvent[] | null;
  /** Legal next nodes. Empty until the current node is completed, and once the run is over. */
  next: DungeonNodeView[];
  canExtract: boolean;
  unbankedCurrency: number;
  currency: DungeonCurrencyView | null;
  /** Share of the unbanked currency kept on defeat or abandon. */
  defeatRetentionBasisPoints: number;
  secured: DungeonSecuredReward[];
  nodesCompleted: number;
  settlement: DungeonSettlement | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface DungeonRegionView {
  id: string;
  name: string;
}

export interface DungeonHomeView {
  /** Where the player is standing. `zones` holds only what can be started here. */
  region: DungeonRegionView;
  zones: DungeonZoneCard[];
  activeRun: DungeonRunView | null;
  /** An active run that has no fighter snapshot: it can only be abandoned. */
  unplayableRunId: number | null;
  /** Why Start is refused before it is pressed; null when the player can start. */
  blocker: CombatStatsUnavailableReason | null;
  /** Today's shared Delve allowance. Starting needs `remaining > 0`; resuming never does. */
  daily: DungeonDailyAllowance;
}

export interface DungeonZoneDetailView {
  zone: DungeonZoneCard;
  /** The live calculation a run started now would snapshot. */
  stats: CombatStats;
  blocker: CombatStatsUnavailableReason | null;
  /** The run in the way of starting a new one, if any. */
  activeRunId: number | null;
  /** Today's shared Delve allowance. */
  daily: DungeonDailyAllowance;
}

/**
 * - `applied`  — this call made the transition;
 * - `replayed` — the transition had already happened; nothing new did;
 * - `refused`  — the action is not legal for the run as it stands.
 */
export type DungeonActionStatus = 'applied' | 'replayed' | 'refused';
export type DungeonRefusal = 'run_over' | 'not_current' | 'not_available' | 'not_extractable';

export interface DungeonActionResult {
  status: DungeonActionStatus;
  refusal: DungeonRefusal | null;
  run: DungeonRunView;
}

export interface DungeonRunEvent {
  id: number;
  type: DungeonRunEventType;
  nodeId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface DungeonPlayService {
  /** Whether the player may use dungeons at all. Never throws for a locked player. */
  isAvailable(playerId: number): Promise<boolean>;
  /** @throws {FeatureLockedError} */
  home(playerId: number): Promise<DungeonHomeView>;
  /** @throws {FeatureLockedError} {DungeonZoneUnavailableError} */
  zone(playerId: number, zoneKey: string): Promise<DungeonZoneDetailView>;
  /**
   * Spend one daily run, generate a run and snapshot the fighter, atomically:
   * all three happen or none does.
   *
   * @throws {FeatureLockedError} {DungeonRunActiveError} {CombatBuddyRequiredError}
   *         {CombatLoadoutIncompleteError} {DungeonDailyLimitError}
   *         {DungeonZoneUnavailableError} {DungeonZoneInvalidError}
   *         {DungeonGenerationError}
   */
  start(playerId: number, zoneKey: string, opts?: { seed?: number }): Promise<DungeonRunView>;
  /** The player's active run, or null. @throws {FeatureLockedError} */
  activeRun(playerId: number): Promise<DungeonRunView | null>;
  /** Any of the player's runs, finished or not. @throws {DungeonRunNotFoundError} */
  run(playerId: number, runId: number): Promise<DungeonRunView>;
  /** Move onto an available node. Permanent. */
  enterNode(playerId: number, runId: number, nodeId: string): Promise<DungeonActionResult>;
  /** Resolve the node the player is on: fight, rest, event, reward or exit. */
  resolveNode(playerId: number, runId: number, nodeId: string): Promise<DungeonActionResult>;
  /** Leave from a completed extraction node, banking everything. */
  extract(playerId: number, runId: number, nodeId: string): Promise<DungeonActionResult>;
  /** Give the run up: settled like a defeat. Works on any active run of the player's. */
  abandon(playerId: number, runId: number): Promise<DungeonActionResult | null>;
  /** The run's structured history, oldest first. */
  history(runId: number): Promise<DungeonRunEvent[]>;
  /** The player's daily Delve allowance. Does not require the feature unlock. */
  dailyAllowance(playerId: number): Promise<DungeonDailyAllowance>;
}

export interface DungeonPlayServiceDeps {
  db: Db;
  runs: Pick<DungeonRunService, 'startRun'>;
  allowance: Pick<DungeonAllowanceService, 'status' | 'consume'>;
  featureUnlocks: Pick<FeatureUnlockService, 'isUnlocked'>;
  combatStats: Pick<CombatStatsService, 'calculateCombatStats' | 'snapshotCombatStats'>;
  currencies: Pick<ProgressionCurrencyService, 'get' | 'getBalance' | 'grant'>;
  currency: Pick<CurrencyService, 'grantWaifubux'>;
  inventory: Pick<InventoryService, 'addItem'>;
  equipmentRewards: Pick<EquipmentRewardService, 'grantChosenEquipmentReward'>;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** A region's display name, from the region catalogue. Defaults to a title-cased id. */
  regionName?: ((regionId: string) => string) | undefined;
  /**
   * Overrides for the rules a dungeon fight is created under. Production
   * leaves this unset — fights use the engine's defaults, damage variance
   * included. Tests that assert exact HP pin the variance here.
   */
  combatRules?: Partial<CombatRules> | undefined;
}

/** The ledger reason a settlement banks under. */
const BANK_REASON: Readonly<Record<DungeonRunOutcome, string>> = {
  extracted: 'dungeon_extraction',
  completed: 'dungeon_completion',
  defeated: 'dungeon_defeat',
  abandoned: 'dungeon_abandon',
};
const OUTCOME_EVENT: Readonly<Record<DungeonRunOutcome, DungeonRunEventType>> = {
  extracted: 'extraction',
  completed: 'completion',
  defeated: 'defeat',
  abandoned: 'abandon',
};

interface PendingEvent {
  type: DungeonRunEventType;
  nodeId: string | null;
  payload: Record<string, unknown>;
}

/** The mutable working copy of a locked run, written back in one UPDATE. */
interface Working {
  run: DungeonRun;
  fighter: DungeonFighter;
  status: DungeonRunStatus;
  currentNodeId: string;
  currentHp: number;
  unbanked: number;
  secured: DungeonSecuredReward[];
  states: DungeonNodeStates;
  settlement: DungeonSettlement | null;
  events: PendingEvent[];
}

export function createDungeonPlayService(deps: DungeonPlayServiceDeps): DungeonPlayService {
  const { db } = deps;

  async function requireUnlocked(playerId: number, tx: DbOrTx = db): Promise<void> {
    if (!(await deps.featureUnlocks.isUnlocked(playerId, DUNGEON_FEATURE, tx))) {
      throw new FeatureLockedError(DUNGEON_FEATURE);
    }
  }

  // ── views ─────────────────────────────────────────────────────────────────

  async function currencyView(tx: DbOrTx, run: DungeonRun): Promise<DungeonCurrencyView | null> {
    // Live metadata, so a rename shows at once; the snapshot covers a currency since removed.
    const live = await deps.currencies.get(run.snapshot.zone.rewards.currencyKey, tx);
    const meta = live ?? run.snapshot.currency;
    return meta && { key: meta.key, singularName: meta.singularName, pluralName: meta.pluralName, icon: meta.icon };
  }

  function nodeView(run: DungeonRun, node: DungeonGraphNode): DungeonNodeView {
    const enemy = enemyOf(run.snapshot, node);
    const event = eventOf(run.snapshot, node);
    return {
      id: node.id,
      depth: node.depth,
      type: node.type,
      boss: node.boss,
      terminal: node.terminal,
      extraction: node.extraction,
      enemy: enemy && {
        key: enemy.key,
        name: enemy.name,
        attack: enemy.attack,
        defense: enemy.defense,
        hp: enemy.hp,
        artworkPath: enemy.artworkPath,
        visual: resolveEnemyVisual(
          enemy,
          roomEnemyArtwork(run.snapshot.enemyArtwork?.[enemy.key], run.snapshot.scenes?.nodes[node.id]?.enemy),
        ),
      },
      event: event && {
        key: event.key,
        name: event.name,
        description: event.description,
        artworkPath: event.artworkPath,
      },
      background: run.snapshot.scenes?.nodes[node.id]?.background ?? null,
      restHealBasisPoints: node.type === 'rest' ? restHealBasisPoints(run.snapshot, node) : null,
      label: node.name ?? null,
    };
  }

  async function runView(tx: DbOrTx, run: DungeonRun, combatEvents?: CombatEvent[] | null): Promise<DungeonRunView> {
    if (!run.fighter || run.currentHp == null) throw new DungeonRunUnplayableError(run.id);
    const node = nodeOf(run.graph, run.currentNodeId);
    if (!node) throw new ContentValidationError(`dungeon run ${run.id} is on node "${run.currentNodeId}", which its graph lacks`);
    const state = run.nodeStates[node.id];
    const resolution = state?.resolution ?? null;

    let events = combatEvents ?? null;
    if (events == null && resolution?.kind === 'combat') {
      const [row] = await tx
        .select({ payload: dungeonRunEvents.payload })
        .from(dungeonRunEvents)
        .where(
          and(
            eq(dungeonRunEvents.runId, run.id),
            eq(dungeonRunEvents.nodeId, node.id),
            eq(dungeonRunEvents.type, 'combat_resolved'),
          ),
        );
      events = ((row?.payload as { events?: CombatEvent[] } | undefined)?.events as CombatEvent[] | undefined) ?? null;
    }

    const active = run.status === 'active';
    const zone = run.snapshot.zone;
    return {
      id: run.id,
      status: run.status,
      zone: {
        key: zone.key,
        name: zone.name,
        description: zone.description,
        artworkPath: zone.artworkPath,
        backgroundArtworkPath: zone.backgroundArtworkPath,
        // A zone snapshotted before managed artwork existed has neither.
        artworkAssetId: zone.artworkAssetId ?? null,
        backgroundAssetId: zone.backgroundAssetId ?? null,
      },
      fighter: run.fighter,
      currentHp: run.currentHp,
      depth: node.depth,
      depthCount: run.graph.depthCount,
      node: nodeView(run, node),
      nodeStatus: state?.status ?? 'entered',
      resolution,
      combatEvents: events,
      next: active ? availableNodes(run.graph, run.nodeStates, node.id).map((n) => nodeView(run, n)) : [],
      canExtract: active && node.extraction && state?.status === 'completed',
      unbankedCurrency: run.unbankedCurrency,
      currency: await currencyView(tx, run),
      defeatRetentionBasisPoints: zone.rewards.defeatCurrencyRetentionBasisPoints,
      secured: run.securedRewards,
      nodesCompleted: Object.values(run.nodeStates).filter((s) => s.status === 'completed').length,
      settlement: run.settlement,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  async function zoneCard(tx: DbOrTx, playerId: number, zone: DungeonZoneDefinition): Promise<DungeonZoneCard> {
    const meta = await deps.currencies.get(zone.rewards.currencyKey, tx);
    const depths = zoneRunLength(zone);
    return {
      key: zone.key,
      name: zone.name,
      description: zone.description,
      artworkPath: zone.artworkPath,
      backgroundArtworkPath: zone.backgroundArtworkPath,
      artworkAssetId: zone.artworkAssetId,
      backgroundAssetId: zone.backgroundAssetId,
      minDepth: depths.min,
      maxDepth: depths.max,
      hasBoss: zoneEndsOnBoss(zone),
      currency: meta && { key: meta.key, singularName: meta.singularName, pluralName: meta.pluralName, icon: meta.icon },
      balance: meta ? await deps.currencies.getBalance(playerId, meta.key, tx) : 0,
      defeatRetentionBasisPoints: zone.rewards.defeatCurrencyRetentionBasisPoints,
    };
  }

  /** Where the player is standing, by the player row — the same source travel writes. */
  async function currentRegion(tx: DbOrTx, playerId: number): Promise<DungeonRegionView> {
    const [row] = await tx.select({ region: players.currentRegion }).from(players).where(eq(players.id, playerId));
    if (!row) throw new PlayerNotFoundError(playerId);
    return regionView(row.region);
  }

  function regionView(id: string): DungeonRegionView {
    return { id, name: (deps.regionName ?? regionLabel)(id) };
  }

  async function activeRow(tx: DbOrTx, playerId: number): Promise<DungeonRunRow | undefined> {
    const [row] = await tx
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.playerId, playerId), eq(dungeonRuns.status, 'active')));
    return row;
  }

  // ── the locked run ────────────────────────────────────────────────────────

  async function lockRun(tx: DbOrTx, playerId: number, runId: number): Promise<DungeonRun> {
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new DungeonRunNotFoundError(runId);
    const [row] = await tx
      .select()
      .from(dungeonRuns)
      .where(and(eq(dungeonRuns.id, runId), eq(dungeonRuns.playerId, playerId)))
      .for('update');
    if (!row) throw new DungeonRunNotFoundError(runId);
    return toDungeonRun(row);
  }

  function working(run: DungeonRun): Working {
    if (!run.fighter || run.currentHp == null || run.currentNodeId == null) throw new DungeonRunUnplayableError(run.id);
    return {
      run,
      fighter: run.fighter,
      status: run.status,
      currentNodeId: run.currentNodeId,
      currentHp: run.currentHp,
      unbanked: run.unbankedCurrency,
      secured: [...run.securedRewards],
      states: { ...run.nodeStates },
      settlement: run.settlement,
      events: [],
    };
  }

  /** Write the working copy back and append its events. Returns the stored run. */
  async function commit(tx: DbOrTx, w: Working): Promise<DungeonRun> {
    const now = new Date();
    const [updated] = await tx
      .update(dungeonRuns)
      .set({
        status: w.status,
        currentNodeId: w.currentNodeId,
        currentHp: w.currentHp,
        unbankedCurrency: w.unbanked,
        securedRewards: w.secured as unknown as Record<string, unknown>[],
        nodeStates: w.states as unknown as Record<string, unknown>,
        settlement: w.settlement as unknown as Record<string, unknown> | null,
        updatedAt: now,
        completedAt: w.status === 'active' ? null : (w.run.completedAt ?? now),
      })
      .where(eq(dungeonRuns.id, w.run.id))
      .returning();
    if (w.events.length > 0) {
      await tx
        .insert(dungeonRunEvents)
        .values(w.events.map((e) => ({ runId: w.run.id, playerId: w.run.playerId, ...e })));
    }
    return toDungeonRun(updated!);
  }

  async function result(
    tx: DbOrTx,
    run: DungeonRun,
    status: DungeonActionStatus,
    refusal: DungeonRefusal | null = null,
    combatEvents?: CombatEvent[],
  ): Promise<DungeonActionResult> {
    return { status, refusal, run: await runView(tx, run, combatEvents) };
  }

  // ── rewards and settlement ────────────────────────────────────────────────

  /**
   * Hand a reward plan over. Gear, WaifuBux and items are granted now —
   * secured — and listed on the run; the plan's currency is only reported
   * back, for the caller to add to the unbanked total.
   */
  async function grantRewards(tx: DbOrTx, w: Working, source: string, plan: DungeonRewardPlan): Promise<DungeonRewards> {
    const { run } = w;
    if (plan.waifubux > 0) await deps.currency.grantWaifubux(tx, run.playerId, plan.waifubux);

    const granted: DungeonRewards['items'] = [];
    if (plan.items.length > 0) {
      const slugs = [...new Set(plan.items.map((i) => i.slug))];
      const rows = await tx.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, slugs));
      const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
      for (const grant of plan.items) {
        const itemId = idBySlug.get(grant.slug);
        if (itemId === undefined) {
          // The seeder disables items, never deletes them; a missing row must
          // not cost the player the rest of the node.
          deps.logger?.error(
            { tag: 'dungeons/missing-item', runId: run.id, source, slug: grant.slug },
            'dungeon reward names an item that is not in the database — skipped',
          );
          continue;
        }
        await deps.inventory.addItem(tx, run.playerId, itemId, grant.quantity);
        granted.push(grant);
      }
    }

    const equipment: DungeonRewards['equipment'] = [];
    for (const [rewardIndex, drop] of plan.equipment.entries()) {
      const grant = await deps.equipmentRewards.grantChosenEquipmentReward(tx, {
        playerId: run.playerId,
        definitionKey: drop.definitionKey,
        // The run was promised this definition when it started, while the
        // player held the Equipment unlock and the definition was enabled.
        allowDisabled: true,
        promised: true,
        source: { type: 'dungeon', key: run.zoneKey },
        grantKey: dungeonEquipmentGrantKey(run.id, source, rewardIndex),
      });
      equipment.push({
        rewardIndex,
        equipmentId: grant.equipmentId,
        definitionKey: grant.definitionKey,
        displayName: grant.displayName,
        slot: grant.slot,
        rarity: grant.rarity,
        rolledMultiplierBp: grant.rolledMultiplierBp,
      });
    }

    const rewards: DungeonRewards = { currency: plan.currency, waifubux: plan.waifubux, items: granted, equipment };
    w.secured.push(...securedRewardsOf(source, rewards));
    return rewards;
  }

  /** End the run: pay any bonus, bank what the outcome keeps, record it. */
  async function settle(
    tx: DbOrTx,
    w: Working,
    outcome: DungeonRunOutcome,
    cause: DungeonSettlement['cause'],
  ): Promise<void> {
    const { run } = w;
    const zone = run.snapshot.zone;
    const node = nodeOf(run.graph, w.currentNodeId);

    const bonusPlan =
      outcome === 'completed'
        ? rollRunBonus(run.snapshot, run.graph, 'completion')
        : outcome === 'extracted'
          ? rollRunBonus(run.snapshot, run.graph, 'extraction')
          : null;
    const bonusRewards = bonusPlan ? await grantRewards(tx, w, outcome === 'completed' ? 'completion' : 'extraction', bonusPlan) : NO_REWARDS;

    const kept = outcome === 'extracted' || outcome === 'completed';
    const retentionBasisPoints = kept ? BASIS_POINTS : zone.rewards.defeatCurrencyRetentionBasisPoints;
    const earned = w.unbanked;
    const total = earned + bonusRewards.currency;
    let { banked, lost } = settleCurrency(total, retentionBasisPoints);

    let bankingSkipped: DungeonSettlement['bankingSkipped'] = null;
    let balanceAfter: number | null = null;
    if (banked > 0) {
      const live = await deps.currencies.get(zone.rewards.currencyKey, tx);
      if (!live || !live.enabled) {
        // The currency was removed or switched off under the run. The run
        // still ends; what could not be banked is recorded, not invented.
        bankingSkipped = live ? 'currency_disabled' : 'no_currency';
        deps.logger?.warn(
          { tag: 'dungeons/banking-skipped', runId: run.id, currencyKey: zone.rewards.currencyKey, amount: banked },
          'dungeon settlement could not bank: the progression currency is missing or disabled',
        );
        lost = total;
        banked = 0;
      } else {
        const grant = await deps.currencies.grant(tx, {
          playerId: run.playerId,
          currencyKey: live.key,
          amount: banked,
          reason: BANK_REASON[outcome],
          sourceRef: `dungeon_run:${run.id}`,
          requestKey: `dungeon_run:${run.id}:settlement`,
          metadata: { zoneKey: run.zoneKey, outcome, earned, bonusCurrency: bonusRewards.currency, retentionBasisPoints },
        });
        balanceAfter = grant.balance;
        w.events.push({
          type: 'currency_banked',
          nodeId: node?.id ?? null,
          payload: { currencyKey: live.key, amount: banked, balanceAfter, ledgerId: grant.ledgerId },
        });
      }
    }

    w.settlement = {
      outcome,
      cause,
      nodeId: node?.id ?? null,
      depth: node?.depth ?? 0,
      finalHp: w.currentHp,
      earned,
      bonusCurrency: bonusRewards.currency,
      retentionBasisPoints,
      banked,
      lost,
      bankingSkipped,
      balanceAfter,
      bonusRewards,
    };
    w.status = outcome;
    // Nothing is unbanked once the run is settled; `settlement.earned` keeps the figure.
    w.unbanked = 0;
    w.events.push({ type: OUTCOME_EVENT[outcome], nodeId: node?.id ?? null, payload: { ...w.settlement } });
    deps.logger?.info(
      {
        tag: 'dungeons/run-settled',
        runId: run.id,
        playerId: run.playerId,
        zoneKey: run.zoneKey,
        outcome,
        cause,
        depth: w.settlement.depth,
        depthCount: run.graph.depthCount,
        finalHp: w.currentHp,
        maxHp: w.fighter.maxHp,
        earned,
        banked,
        lost,
        securedEquipment: w.secured.filter((r) => r.kind === 'equipment').length,
      },
      `dungeon run ${outcome}`,
    );
  }

  function complete(w: Working, node: DungeonGraphNode, resolution: DungeonNodeResolution): void {
    const state = w.states[node.id]!;
    w.states[node.id] = { ...state, status: 'completed', completedAt: new Date().toISOString(), resolution };
  }

  /** Resolve the entered node. Returns the fight's events when there was one. */
  async function resolve(tx: DbOrTx, w: Working, node: DungeonGraphNode): Promise<CombatEvent[] | undefined> {
    const { run } = w;
    const { snapshot, graph } = run;
    let combatEvents: CombatEvent[] | undefined;
    let ended: { outcome: DungeonRunOutcome; cause: DungeonSettlement['cause'] } | null = null;

    if (isEnemyNodeType(node.type)) {
      const enemy = enemyOf(snapshot, node);
      if (!enemy) throw new ContentValidationError(`dungeon run ${run.id}: node ${node.id} names an enemy its snapshot lacks`);
      const fight = fightEnemy(w.fighter, w.currentHp, enemy, dungeonCombatSeed(graph.seed, node.id), deps.combatRules);
      deps.logger?.debug(
        {
          tag: 'dungeons/combat-resolved',
          runId: run.id,
          nodeId: node.id,
          enemyKey: enemy.key,
          combatSeed: fight.combatSeed,
          result: fight.result,
          rounds: fight.rounds,
          hpBefore: fight.hpBefore,
          hpAfter: fight.hpAfter,
        },
        'dungeon fight resolved',
      );
      combatEvents = fight.events;
      w.currentHp = fight.hpAfter;
      const won = fight.result === 'player_victory';
      const rewards = won ? await grantRewards(tx, w, node.id, rollNodeRewards(snapshot, graph, node)) : NO_REWARDS;
      w.unbanked += rewards.currency;
      const { events: _events, actions, combatSeed, ...summary } = fight;
      complete(w, node, { kind: 'combat', enemyKey: enemy.key, enemyName: enemy.name, ...summary, rewards });
      w.events.push({
        type: 'combat_resolved',
        nodeId: node.id,
        payload: {
          nodeType: node.type,
          enemy: { key: enemy.key, name: enemy.name, attack: enemy.attack, defense: enemy.defense, hp: enemy.hp },
          fighter: { attack: w.fighter.attack, defense: w.fighter.defense, maxHp: w.fighter.maxHp },
          ...summary,
          actions,
          combatSeed,
          rewards,
          unbankedAfter: w.unbanked,
          events: fight.events,
        },
      });
      // Anything short of a win ends the run: at 0 HP, or stuck at the round limit.
      if (!won) ended = { outcome: 'defeated', cause: fight.result === 'enemy_victory' ? 'hp_zero' : 'stalemate' };
      else if (node.terminal) ended = { outcome: 'completed', cause: 'boss_defeated' };
    } else if (node.type === 'rest') {
      const healBasisPoints = restHealBasisPoints(snapshot, node);
      const hpBefore = w.currentHp;
      w.currentHp = hpAfterRest(w.fighter, hpBefore, healBasisPoints);
      const resolution = { kind: 'rest' as const, healBasisPoints, hpBefore, hpAfter: w.currentHp };
      complete(w, node, resolution);
      w.events.push({ type: 'rest_resolved', nodeId: node.id, payload: { ...resolution, maxHp: w.fighter.maxHp } });
    } else if (node.type === 'event') {
      const event = eventOf(snapshot, node);
      const { hpChangeBasisPoints } = eventEffect(event);
      const hpBefore = w.currentHp;
      w.currentHp = hpAfterEvent(w.fighter, hpBefore, hpChangeBasisPoints);
      const rewards = await grantRewards(tx, w, node.id, rollNodeRewards(snapshot, graph, node));
      w.unbanked += rewards.currency;
      const resolution = {
        kind: 'event' as const,
        eventKey: node.content?.key ?? '',
        hpChangeBasisPoints,
        hpBefore,
        hpAfter: w.currentHp,
        rewards,
      };
      complete(w, node, resolution);
      w.events.push({ type: 'event_resolved', nodeId: node.id, payload: { ...resolution, unbankedAfter: w.unbanked } });
    } else if (node.type === 'reward') {
      const rewards = await grantRewards(tx, w, node.id, rollNodeRewards(snapshot, graph, node));
      w.unbanked += rewards.currency;
      complete(w, node, { kind: 'reward', rewards });
      w.events.push({
        type: 'reward_resolved',
        nodeId: node.id,
        payload: { bandId: node.rewardBandId, rewards, unbankedAfter: w.unbanked },
      });
    } else {
      complete(w, node, { kind: 'exit' });
      w.events.push({ type: 'exit_resolved', nodeId: node.id, payload: { terminal: node.terminal } });
    }

    // The final node is completion, never an extraction — whatever its type.
    if (!ended && node.terminal) ended = { outcome: 'completed', cause: 'exit_reached' };
    if (ended) await settle(tx, w, ended.outcome, ended.cause);
    return combatEvents;
  }

  /**
   * The whole of a start, in one transaction: the player lock, the one-active-
   * run check, the fighter snapshot, the daily attempt, the generated run and
   * its first events. Anything thrown rolls all of it back — the attempt too.
   */
  async function startInTransaction(playerId: number, zoneKey: string, opts: { seed?: number }): Promise<DungeonRunView> {
    return db.transaction(async (tx) => {
      await requireUnlocked(playerId, tx);
      // Serialise a player's starts, so a double-click meets the checks below
      // (the active run, then the allowance) rather than the unique index.
      const [player] = await tx
        .select({ id: players.id, region: players.currentRegion })
        .from(players)
        .where(eq(players.id, playerId))
        .for('update');
      if (!player) throw new PlayerNotFoundError(playerId);
      if (await activeRow(tx, playerId)) throw new DungeonRunActiveError(playerId);

      // The zone must be open and startable from where the player stands — read
      // off the locked player row, so travel cannot slip between check and start.
      const zoneRow = await readDungeonZoneRow(tx, zoneKey);
      if (!zoneRow) throw new DungeonZoneUnavailableError(zoneKey, 'missing');
      if (!zoneRow.enabled) throw new DungeonZoneUnavailableError(zoneKey, 'disabled');
      const region = regionView(player.region);
      if (!parseDungeonZoneRow(zoneRow).availableRegions.includes(region.id)) {
        throw new DungeonZoneUnavailableError(zoneKey, 'region', region.name);
      }

      const fighter = fighterFromCombatStats(await deps.combatStats.snapshotCombatStats(tx, playerId));
      // Spent before the run is generated so an exhausted allowance is refused
      // cheaply; it is only kept if everything below commits.
      const daily = await deps.allowance.consume(tx, playerId);
      const run = await deps.runs.startRun(
        { playerId, zoneKey, fighter, ...(opts.seed !== undefined ? { seed: opts.seed } : {}) },
        tx,
      );
      const start = nodeOf(run.graph, run.graph.startNodeId)!;
      await tx.insert(dungeonRunEvents).values([
        {
          runId: run.id,
          playerId,
          type: 'run_started' as const,
          nodeId: null,
          payload: {
            zoneKey: run.zoneKey,
            zoneRevision: run.zoneRevision,
            seed: run.seed,
            generatorVersion: run.generatorVersion,
            nodeCount: run.graph.nodes.length,
            depthCount: run.graph.depthCount,
            fighter,
            daily: { periodKey: daily.periodKey, limit: daily.limit, used: daily.used },
            // Where the run was started. For audit only: nothing reads it back.
            region: region.id,
          },
        },
        {
          runId: run.id,
          playerId,
          type: 'node_entered' as const,
          nodeId: start.id,
          payload: { from: null, depth: start.depth, nodeType: start.type, hp: fighter.maxHp },
        },
      ]);
      deps.logger?.info(
        {
          tag: 'dungeons/daily-usage-consumed',
          playerId,
          runId: run.id,
          zoneKey: run.zoneKey,
          periodKey: daily.periodKey,
          used: daily.used,
          limit: daily.limit,
          remaining: daily.remaining,
        },
        'dungeon run started: daily run consumed',
      );
      return runView(tx, run);
    });
  }

  // ── service ───────────────────────────────────────────────────────────────

  return {
    async isAvailable(playerId) {
      return deps.featureUnlocks.isUnlocked(playerId, DUNGEON_FEATURE);
    },

    async home(playerId) {
      await requireUnlocked(playerId);
      const region = await currentRegion(db, playerId);
      const rows = await db
        .select()
        .from(dungeonZones)
        .where(eq(dungeonZones.enabled, true))
        .orderBy(asc(dungeonZones.position), asc(dungeonZones.zoneKey));
      const zones: DungeonZoneCard[] = [];
      for (const row of rows) {
        try {
          const zone = parseDungeonZoneRow(row);
          // Only what can be started here. A zone elsewhere is not listed at all.
          if (!zone.availableRegions.includes(region.id)) continue;
          zones.push(await zoneCard(db, playerId, zone));
        } catch (err) {
          deps.logger?.error({ err, tag: 'dungeons/unreadable-zone', zone: row.zoneKey }, 'dungeon zone could not be read — hidden');
        }
      }
      const active = await activeRow(db, playerId);
      const run = active ? toDungeonRun(active) : null;
      const playable = run?.fighter != null && run.currentHp != null;
      const [stats, daily] = await Promise.all([
        deps.combatStats.calculateCombatStats(playerId),
        deps.allowance.status(playerId),
      ]);
      return {
        region,
        zones,
        activeRun: run && playable ? await runView(db, run) : null,
        unplayableRunId: run && !playable ? run.id : null,
        blocker: stats.unavailableReason,
        daily,
      };
    },

    async zone(playerId, zoneKey) {
      await requireUnlocked(playerId);
      const row = await readDungeonZoneRow(db, zoneKey);
      if (!row) throw new DungeonZoneUnavailableError(zoneKey, 'missing');
      if (!row.enabled) throw new DungeonZoneUnavailableError(zoneKey, 'disabled');
      const definition = parseDungeonZoneRow(row);
      const region = await currentRegion(db, playerId);
      if (!definition.availableRegions.includes(region.id)) {
        throw new DungeonZoneUnavailableError(zoneKey, 'region', region.name);
      }
      const [zone, stats, active, daily] = await Promise.all([
        zoneCard(db, playerId, definition),
        deps.combatStats.calculateCombatStats(playerId),
        activeRow(db, playerId),
        deps.allowance.status(playerId),
      ]);
      return { zone, stats, blocker: stats.unavailableReason, activeRunId: active?.id ?? null, daily };
    },

    async start(playerId, zoneKey, opts = {}) {
      try {
        return await startInTransaction(playerId, zoneKey, opts);
      } catch (err) {
        if (err instanceof DungeonDailyLimitError) {
          deps.logger?.info(
            { tag: 'dungeons/start-refused-daily-limit', playerId, zoneKey, limit: err.limit, used: err.used, periodKey: err.periodKey },
            'dungeon run start refused: daily limit reached',
          );
        }
        throw err;
      }
    },

    async activeRun(playerId) {
      await requireUnlocked(playerId);
      const row = await activeRow(db, playerId);
      return row ? runView(db, toDungeonRun(row)) : null;
    },

    async run(playerId, runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new DungeonRunNotFoundError(runId);
      const [row] = await db
        .select()
        .from(dungeonRuns)
        .where(and(eq(dungeonRuns.id, runId), eq(dungeonRuns.playerId, playerId)));
      if (!row) throw new DungeonRunNotFoundError(runId);
      return runView(db, toDungeonRun(row));
    },

    async enterNode(playerId, runId, nodeId) {
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        const run = await lockRun(tx, playerId, runId);
        const w = working(run);
        // Checked before the status: a repeat of the click that entered this
        // node is a replay even if the run has since ended on it.
        if (w.currentNodeId === nodeId) return result(tx, run, 'replayed');
        if (run.status !== 'active') return result(tx, run, 'refused', 'run_over');
        const target = availableNodes(run.graph, w.states, w.currentNodeId).find((n) => n.id === nodeId);
        if (!target) return result(tx, run, 'refused', 'not_available');

        w.states[target.id] = {
          status: 'entered',
          enteredAt: new Date().toISOString(),
          completedAt: null,
          resolution: null,
        };
        w.events.push({
          type: 'node_entered',
          nodeId: target.id,
          payload: { from: w.currentNodeId, depth: target.depth, nodeType: target.type, hp: w.currentHp },
        });
        w.currentNodeId = target.id;
        return result(tx, await commit(tx, w), 'applied');
      });
    },

    async resolveNode(playerId, runId, nodeId) {
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        const run = await lockRun(tx, playerId, runId);
        const w = working(run);
        // Already resolved: read it back. Nothing is fought, healed or paid again.
        if (w.states[nodeId]?.status === 'completed') return result(tx, run, 'replayed');
        if (run.status !== 'active') return result(tx, run, 'refused', 'run_over');
        const node = nodeOf(run.graph, nodeId);
        if (!node || w.currentNodeId !== nodeId || w.states[nodeId]?.status !== 'entered') {
          return result(tx, run, 'refused', 'not_current');
        }
        const combatEvents = await resolve(tx, w, node);
        return result(tx, await commit(tx, w), 'applied', null, combatEvents);
      });
    },

    async extract(playerId, runId, nodeId) {
      return db.transaction(async (tx) => {
        await requireUnlocked(playerId, tx);
        const run = await lockRun(tx, playerId, runId);
        const w = working(run);
        if (run.status === 'extracted' && run.settlement?.nodeId === nodeId) return result(tx, run, 'replayed');
        if (run.status !== 'active') return result(tx, run, 'refused', 'run_over');
        const node = nodeOf(run.graph, nodeId);
        if (!node || w.currentNodeId !== nodeId) return result(tx, run, 'refused', 'not_current');
        if (!node.extraction || w.states[nodeId]?.status !== 'completed') {
          return result(tx, run, 'refused', 'not_extractable');
        }
        await settle(tx, w, 'extracted', 'extraction');
        return result(tx, await commit(tx, w), 'applied');
      });
    },

    async abandon(playerId, runId) {
      return db.transaction(async (tx) => {
        const run = await lockRun(tx, playerId, runId);
        if (!run.fighter || run.currentHp == null || run.currentNodeId == null) {
          // A run with no fighter was never played: there is nothing to settle.
          if (run.status !== 'active') return null;
          const now = new Date();
          await tx
            .update(dungeonRuns)
            .set({ status: 'abandoned', completedAt: now, updatedAt: now })
            .where(eq(dungeonRuns.id, run.id));
          await tx
            .insert(dungeonRunEvents)
            .values({ runId: run.id, playerId, type: 'abandon', nodeId: null, payload: { unplayable: true } });
          return null;
        }
        if (run.status === 'abandoned') return result(tx, run, 'replayed');
        if (run.status !== 'active') return result(tx, run, 'refused', 'run_over');
        const w = working(run);
        await settle(tx, w, 'abandoned', 'abandoned');
        return result(tx, await commit(tx, w), 'applied');
      });
    },

    async history(runId) {
      const rows: DungeonRunEventRow[] = await db
        .select()
        .from(dungeonRunEvents)
        .where(eq(dungeonRunEvents.runId, runId))
        .orderBy(asc(dungeonRunEvents.id));
      return rows.map((r) => ({ id: r.id, type: r.type, nodeId: r.nodeId, payload: r.payload, createdAt: r.createdAt }));
    },

    async dailyAllowance(playerId) {
      return deps.allowance.status(playerId);
    },
  };
}
