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
 * ## Rewards (Phase 1A)
 *
 * A `reward` action pays an existing expedition reward table and a range of
 * progression currency. Gear, WaifuBux and items are **secured** — granted in
 * the step's transaction; currency is **unbanked** until settlement (all of
 * it on extraction or completion, the dungeon's retention share on defeat or
 * abandon). Delivery is safe against replay because it shares the step's
 * transaction and step check; gear additionally carries a grant key derived
 * from the action's claim key, and banking the existing ledger request key.
 * Phase 2 puts a claims row behind the same claim key — nothing here assumes
 * it will not.
 *
 * ## Eligibility, allowance and regions
 *
 * Unchanged from the prototype: the `equipment` feature unlock, an active
 * Buddy and a complete loadout; one daily run spent in the start transaction
 * and never refunded; a dungeon is startable only from one of its regions,
 * while an active run is playable anywhere.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { managedArtworkKey, resolveManagedArtworkIds } from '../artworkAssets/managedArtworkLookup';
import {
  artworkAssets,
  dungeonRunEvents,
  dungeonRuns,
  items,
  players,
  rewardTables,
  type DungeonRunRow,
} from '../../db/schema';
import {
  DungeonDailyLimitError,
  DungeonInvalidError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonUnavailableError,
  EquipmentRewardConfigError,
  FeatureLockedError,
  PlayerNotFoundError,
  uniqueViolationConstraint,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { resolveEnemyVisual, type EnemyVisual, type ManagedEnemyArtwork } from '../artworkAssets/enemyArtworkService';
import type { ArtworkRef } from '../artworkAssets/sceneLayers';
import type { CombatEvent, CombatRules } from '../combat/combatTypes';
import type { CombatEnemyDefinition } from '../combat/enemyDefinitions';
import type { ExpeditionRewardTable } from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
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
  isCombatAction,
  type DungeonArtworkRef,
  type DungeonDefinition,
} from './content/dungeonDefinition';
import type { DungeonAllowanceService, DungeonDailyAllowance } from './dungeonAllowanceService';
import type { DungeonContentService } from './dungeonContentService';
import { fighterFromCombatStats, type DungeonFighter } from './dungeonFighter';
import { equipmentGrantKey } from './engine/rewards';
import { applyDungeonEffects } from './engine/sandbox';
import { randomDungeonSeed } from './engine/seeds';
import { startDungeonRun, stepDungeon } from './engine/step';
import type {
  DungeonEffect,
  DungeonEffectReceipt,
  DungeonEffectsPort,
  DungeonEngineContext,
  DungeonEquipmentGrant,
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
}

/** A reward a run has already handed to the player for good. */
export type DungeonSecuredReward =
  | ({ kind: 'equipment'; source: string; step: number } & DungeonEquipmentGrant)
  | { kind: 'waifubux'; source: string; step: number; amount: number }
  | { kind: 'item'; source: string; step: number; slug: string; quantity: number };

/** How a run ended and what was banked. Stored on the run once, when it ends. */
export interface DungeonSettlement extends DungeonRunEnd {
  /** Why nothing could be banked, when the dungeon's currency is missing or disabled. */
  bankingSkipped: 'no_currency' | 'currency_disabled' | null;
  /** The permanent balance after banking; null when nothing was banked. */
  balanceAfter: number | null;
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
  settlement: DungeonSettlement | null;
  startedAt: Date;
  completedAt: Date | null;
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

/**
 * - `applied` — this call moved the run;
 * - `refused` — the input is not legal for the run as it stands (`refusal`
 *   says why; `stale` is a button from an earlier step). Nothing changed.
 */
export interface DungeonActionResult {
  status: 'applied' | 'refused';
  refusal: DungeonRefusal | null;
  run: DungeonRunView;
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
  currencies: Pick<ProgressionCurrencyService, 'get' | 'getBalance' | 'grant'>;
  currency: Pick<CurrencyService, 'grantWaifubux'>;
  inventory: Pick<InventoryService, 'addItem'>;
  equipmentRewards: Pick<EquipmentRewardService, 'grantChosenEquipmentReward'>;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> | undefined;
  /** A region's display name, from the region catalogue. Defaults to a title-cased id. */
  regionName?: ((regionId: string) => string) | undefined;
  /**
   * Overrides for the rules a dungeon fight is created under. Production
   * leaves this unset. Tests that assert exact HP pin the variance here.
   */
  combatRules?: Partial<CombatRules> | undefined;
}

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
    unbankedCurrency: row.unbankedCurrency,
    recent: row.recent as unknown as DungeonRunState['recent'],
    end: row.settlement ? (row.settlement as unknown as DungeonRunEnd) : null,
  };
}

interface LoadedRun {
  row: DungeonRunRow;
  definition: DungeonDefinition;
  revisionNumber: number;
  snapshot: DungeonDependencySnapshot;
  fighter: DungeonFighter;
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
    const pinned = await deps.content.revisionById(tx, row.revisionId);
    if (!pinned) throw new DungeonRunNotFoundError(row.id);
    const snapshot = row.dependencySnapshot as unknown as DungeonDependencySnapshot;
    const fighter = row.fighter as unknown as DungeonFighter;
    return {
      row,
      definition: pinned.definition,
      revisionNumber: pinned.revision.number,
      snapshot,
      fighter,
      ctx: {
        definition: pinned.definition,
        dependencies: { enemies: snapshot.enemies, rewardTables: snapshot.rewardTables },
        fighter,
        runKey: String(row.id),
        combatRules: deps.combatRules,
      },
    };
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
    const room = definition.rooms.find((r) => r.id === core.room.id);
    const roomBackground = resolveDungeonArtwork(room?.background ?? null, snapshot.artwork ?? {});
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
      enemy: sceneEnemy(run, core.action?.wave?.enemy ?? (lastWave?.kind === 'wave' ? snapshot.enemies[lastWave.wave.enemyKey] : undefined)),
      roomBackground: roomBackground.assetId || roomBackground.artworkPath ? roomBackground : dungeonBackground,
      combatEvents: events,
      currency: await currencyView(tx, run),
      defeatRetentionBasisPoints: definition.settings.defeatCurrencyRetentionBasisPoints,
      secured,
      latestSecured: secured.filter((s) => s.step === row.step),
      settlement: (row.settlement as unknown as DungeonSettlement | null) ?? null,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  // ── the live effects adapter ──────────────────────────────────────────────

  /**
   * Carries the engine's effects out for real, inside the step's transaction.
   * The only place a dungeon touches inventory, currency or Equipment.
   */
  function liveEffectsPort(tx: DbOrTx, run: LoadedRun): DungeonEffectsPort {
    const { row } = run;
    return {
      async apply(effect: DungeonEffect): Promise<DungeonEffectReceipt> {
        if (effect.type === 'grant_rewards') {
          const { plan, claimKey } = effect;
          if (plan.waifubux > 0) await deps.currency.grantWaifubux(tx, row.playerId, plan.waifubux);

          const granted: typeof plan.items = [];
          if (plan.items.length > 0) {
            const slugs = [...new Set(plan.items.map((i) => i.slug))];
            const rows = await tx.select({ id: items.id, slug: items.slug }).from(items).where(inArray(items.slug, slugs));
            const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
            for (const grant of plan.items) {
              const itemId = idBySlug.get(grant.slug);
              if (itemId === undefined) {
                // The seeder disables items, never deletes them; a missing row
                // must not cost the player the rest of the reward.
                deps.logger?.error(
                  { tag: 'dungeons/missing-item', runId: row.id, claimKey, slug: grant.slug },
                  'dungeon reward names an item that is not in the database — skipped',
                );
                continue;
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

        const { end, currencyKey, requestKey } = effect;
        if (end.banked <= 0) return { type: 'settle_run', banked: 0, bankingSkipped: null, balanceAfter: null };
        const live = currencyKey ? await deps.currencies.get(currencyKey, tx) : null;
        if (!live || !live.enabled) {
          // The currency was removed or switched off under the run. The run
          // still ends; what could not be banked is recorded, not invented.
          deps.logger?.warn(
            { tag: 'dungeons/banking-skipped', runId: row.id, currencyKey, amount: end.banked },
            'dungeon settlement could not bank: the progression currency is missing or disabled',
          );
          return { type: 'settle_run', banked: 0, bankingSkipped: live ? 'currency_disabled' : 'no_currency', balanceAfter: null };
        }
        const grant = await deps.currencies.grant(tx, {
          playerId: row.playerId,
          currencyKey: live.key,
          amount: end.banked,
          reason: BANK_REASON[end.outcome],
          sourceRef: `dungeon_run:${row.id}`,
          requestKey,
          metadata: { dungeonKey: row.dungeonKey, outcome: end.outcome, earned: end.earned, retentionBasisPoints: end.retentionBasisPoints },
        });
        return { type: 'settle_run', banked: end.banked, bankingSkipped: null, balanceAfter: grant.balance };
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
        log.push({
          type: 'rewards_granted',
          roomId: null,
          actionId: null,
          payload: { claimKey: receipt.claimKey, waifubux: receipt.waifubux, items: receipt.items, equipment: receipt.equipment },
        });
      } else if (settlement) {
        settlement = {
          ...settlement,
          banked: receipt.banked,
          lost: settlement.earned - receipt.banked,
          bankingSkipped: receipt.bankingSkipped,
          balanceAfter: receipt.balanceAfter,
        };
        if (receipt.banked > 0) {
          log.push({
            type: 'currency_banked',
            roomId: settlement.roomId,
            actionId: null,
            payload: { currencyKey: run.definition.settings.progressionCurrency, amount: receipt.banked, balanceAfter: receipt.balanceAfter },
          });
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
      return runView(tx, { ...run, row }, started.combat.at(-1)?.events ?? null);
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
        unbankedCurrency: state.unbankedCurrency,
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
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(dungeonRuns)
          .where(and(eq(dungeonRuns.id, runId), eq(dungeonRuns.playerId, playerId)))
          .for('update');
        if (!row) throw new DungeonRunNotFoundError(runId);
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
        return { status: 'applied', refusal: null, run: await runView(tx, { ...run, row: written }, result.combat.at(-1)?.events ?? null) };
      });
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
