/**
 * CareService (Milestone 5B) — Care Mode: an idle/rest state that lazily
 * recovers Hunt Energy and slowly trains a chosen owned Waifumon.
 *
 * Rules (per Fable_Plan.md 5B):
 *   - Player starts/leaves Care Mode manually; tick evaluation is lazy —
 *     nothing runs in the background.
 *   - Every tick (default 30m): +1 Hunt Energy, +2 target waifu XP,
 *     +1 target waifu affection.
 *   - Energy recovery is capped by `careMode.recoveryCap` AND by the player's
 *     computed max Hunt Energy — Waifumon XP/affection continues even after
 *     the energy cap is hit.
 *   - Hunt and daily-claim entry points apply pending ticks first, then exit
 *     Care Mode, then proceed with their own state changes.
 *   - The care target must be an owned, non-released `player_waifus` row.
 *     If the row disappears (soft-released underneath), Care Mode is stopped
 *     safely and the care fields are cleared.
 *
 * Concurrency: every mutating path locks the player row + currency row + the
 * target waifu row inside a single transaction. Advancing
 * `care_mode_last_tick_at` by full intervals only (never past `now`) makes
 * repeated calls at the same instant a no-op — concurrent clicks can't
 * double-grant.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  playerCurrencies,
  playerWaifus,
  players,
  species,
  type PlayerRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import { PlayerNotFoundError, WaifuAlreadyReleasedError, WaifuNotOwnedError } from '../../shared/errors';
import type { CareModeConfig } from '../content/schemas';
import type { CollectionService } from '../collection/collectionService';
import type { CurrencyService } from '../currency/currencyService';
import type { ProgressionService } from '../progression/progressionService';
import type { QuestService } from '../quests/questService';

/**
 * Summary of applying pending Care Mode ticks. `active` reflects the state
 * *after* the call: it is `false` when Care Mode wasn't running or when the
 * call cleared it (e.g. the target vanished). `stopped=true` means the call
 * itself cleared the care fields.
 */
export interface CareTickSummary {
  /** True iff Care Mode remains active after the call. */
  active: boolean;
  /** True iff this call cleared the care fields (target invalid / released). */
  stopped: boolean;
  ticksProcessed: number;
  energyGained: number;
  waifuXpGained: number;
  affectionGained: number;
  /** Target waifu snapshot after the tick, when still present. */
  target: { waifu: PlayerWaifuRow; species: SpeciesRow } | null;
  fromLevel: number | null;
  toLevel: number | null;
  leveledUp: boolean;
  /** New value of `care_mode_last_tick_at` after this call. */
  lastTickAt: Date | null;
  /** Estimated timestamp of the next tick, when still active. */
  nextTickAt: Date | null;
}

/**
 * Public read-only snapshot of a player's Care Mode state — used by the UI
 * without mutating anything. `pendingTicks` is a forecast: how many ticks
 * *would* be granted if `applyPendingTicks` ran right now.
 */
export interface CareState {
  active: boolean;
  startedAt: Date | null;
  lastTickAt: Date | null;
  nextTickAt: Date | null;
  target: { waifu: PlayerWaifuRow; species: SpeciesRow } | null;
  pendingTicks: number;
  intervalMinutes: number;
  energyPerTick: number;
  waifuXpPerTick: number;
  affectionPerTick: number;
  recoveryCap: number;
  effectiveEnergyCap: number;
  currentEnergy: number;
  maxEnergy: number;
  enabled: boolean;
}

export interface CareService {
  /** Configuration snapshot (used by UI helpers). */
  readonly config: CareModeConfig;

  /**
   * Read-only view of the player's Care Mode state — never mutates. Safe to
   * call from any UI paint.
   */
  getState(playerId: number, now?: Date): Promise<CareState>;

  /**
   * Enter Care Mode. When `targetWaifuId` is omitted the active buddy is
   * used; if no buddy is set the caller must supply an explicit target.
   *
   * If Care Mode is *already* active: pending ticks are applied first, then
   * — if `targetWaifuId` names a different waifu — the target is switched
   * (same fair behavior as {@link changeTarget}). Same-target restarts do
   * not reset `care_mode_last_tick_at` so accumulated partial-interval
   * progress isn't lost.
   */
  start(
    playerId: number,
    targetWaifuId?: number | null,
    now?: Date,
  ): Promise<CareTickSummary>;

  /**
   * Leave Care Mode: apply pending ticks, then clear the care fields. Safe
   * to call when not in Care Mode (returns an inactive summary).
   */
  leave(playerId: number, now?: Date): Promise<CareTickSummary>;

  /**
   * Change the care target to a different owned, non-released waifu. Pending
   * ticks go to the *old* target first; `care_mode_last_tick_at` is then
   * reset to `now` so the new target starts a fresh interval.
   */
  changeTarget(playerId: number, targetWaifuId: number, now?: Date): Promise<CareTickSummary>;

  /**
   * Apply pending Care Mode ticks inside the caller's transaction, then
   * clear the care fields. Used by HuntService and DailyService to
   * atomically exit Care Mode before their own state changes.
   */
  applyAndExit(tx: DbOrTx, playerId: number, now?: Date): Promise<CareTickSummary>;

  /**
   * Apply pending Care Mode ticks in a standalone transaction without
   * exiting. Used by lazy UI paints (menu/profile) so the board always shows
   * a fresh state.
   */
  applyPending(playerId: number, now?: Date): Promise<CareTickSummary>;
}

export interface CareServiceDeps {
  db: Db;
  currency: CurrencyService;
  collection: CollectionService;
  progression: ProgressionService;
  quests: QuestService;
  careConfig: CareModeConfig;
}

const INACTIVE_SUMMARY: CareTickSummary = {
  active: false,
  stopped: false,
  ticksProcessed: 0,
  energyGained: 0,
  waifuXpGained: 0,
  affectionGained: 0,
  target: null,
  fromLevel: null,
  toLevel: null,
  leveledUp: false,
  lastTickAt: null,
  nextTickAt: null,
};

export function createCareService(deps: CareServiceDeps): CareService {
  const { db, currency, collection, progression, quests, careConfig } = deps;

  function intervalMs(): number {
    return Math.max(1, careConfig.intervalMinutes) * 60 * 1000;
  }

  function effectiveEnergyCap(playerLevel: number): number {
    return Math.min(careConfig.recoveryCap, progression.computeMaxEnergy(playerLevel));
  }

  /** Load the owned, non-released target row + its species (locks the row). */
  async function lockOwnedTarget(
    tx: DbOrTx,
    playerId: number,
    waifuId: number,
  ): Promise<{ waifu: PlayerWaifuRow; species: SpeciesRow }> {
    const [locked] = await tx
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
      .for('update');
    if (!locked) throw new WaifuNotOwnedError(waifuId);
    if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
    const [sp] = await tx.select().from(species).where(eq(species.id, locked.speciesId));
    if (!sp) throw new WaifuNotOwnedError(waifuId);
    return { waifu: locked, species: sp };
  }

  /**
   * Core tick application. Locks the player row + currency row + target row,
   * grants pending ticks (or clears fields if the target vanished), and
   * returns a summary. `alsoExit=true` clears the care fields after applying
   * ticks — used by hunt/daily/leave. Otherwise care remains active.
   */
  async function tickCore(
    tx: DbOrTx,
    playerId: number,
    now: Date,
    alsoExit: boolean,
  ): Promise<CareTickSummary> {
    const [player] = await tx
      .select()
      .from(players)
      .where(eq(players.id, playerId))
      .for('update');
    if (!player) throw new PlayerNotFoundError(playerId);

    const active =
      player.careModeStartedAt != null &&
      player.careModeLastTickAt != null &&
      player.careModeWaifuId != null;
    if (!active) return { ...INACTIVE_SUMMARY };

    const targetId = player.careModeWaifuId!;
    const lastTick = player.careModeLastTickAt!;

    // Validate the target still exists & is owned & is not released. If it
    // vanished, stop Care Mode safely (self-heal, no partial grants).
    let target: { waifu: PlayerWaifuRow; species: SpeciesRow } | null;
    try {
      target = await lockOwnedTarget(tx, playerId, targetId);
    } catch (err) {
      if (err instanceof WaifuNotOwnedError || err instanceof WaifuAlreadyReleasedError) {
        await clearCareFields(tx, playerId);
        return {
          ...INACTIVE_SUMMARY,
          stopped: true,
        };
      }
      throw err;
    }

    const interval = intervalMs();
    const elapsedMs = Math.max(0, now.getTime() - lastTick.getTime());
    const ticks = Math.floor(elapsedMs / interval);

    if (ticks <= 0) {
      // Nothing to grant. Either stay in Care Mode with unchanged timing, or
      // exit cleanly if the caller asked (leave/hunt/daily).
      if (alsoExit) {
        await clearCareFields(tx, playerId);
        return {
          ...INACTIVE_SUMMARY,
          stopped: true,
          target,
          fromLevel: target.waifu.level,
          toLevel: target.waifu.level,
        };
      }
      const nextTickAt = new Date(lastTick.getTime() + interval);
      return {
        active: true,
        stopped: false,
        ticksProcessed: 0,
        energyGained: 0,
        waifuXpGained: 0,
        affectionGained: 0,
        target,
        fromLevel: target.waifu.level,
        toLevel: target.waifu.level,
        leveledUp: false,
        lastTickAt: lastTick,
        nextTickAt,
      };
    }

    // Compute energy grant (bounded by recoveryCap AND max energy).
    const currencies = await currency.lockCurrencies(tx, playerId);
    const cap = effectiveEnergyCap(player.level);
    const potentialEnergy = ticks * careConfig.energyPerTick;
    const energyRoom = Math.max(0, cap - currencies.huntEnergy);
    const energyGained = Math.max(0, Math.min(potentialEnergy, energyRoom));

    // Waifu XP/affection is granted for every elapsed tick — never bounded
    // by the energy cap.
    const waifuXpGained = ticks * careConfig.waifuXpPerTick;
    const affectionGained = ticks * careConfig.affectionPerTick;

    if (energyGained > 0) {
      await tx
        .update(playerCurrencies)
        .set({
          huntEnergy: sql`${playerCurrencies.huntEnergy} + ${energyGained}`,
          updatedAt: sql`now()`,
        })
        .where(eq(playerCurrencies.playerId, playerId));
    }

    const fromLevel = target.waifu.level;
    const newXp = target.waifu.xp + waifuXpGained;
    const newLevel = collection.waifuLevelFromXp(newXp);
    const newAffection = target.waifu.affection + affectionGained;
    const [updatedWaifu] = await tx
      .update(playerWaifus)
      .set({ xp: newXp, level: newLevel, affection: newAffection })
      .where(eq(playerWaifus.id, target.waifu.id))
      .returning();

    const newLastTick = new Date(lastTick.getTime() + ticks * interval);

    if (alsoExit) {
      await clearCareFields(tx, playerId);
    } else {
      await tx
        .update(players)
        .set({ careModeLastTickAt: newLastTick })
        .where(eq(players.id, playerId));
    }

    // Daily-quest progress: care ticks + accrued affection count toward the
    // matching quests inside this same transaction so rollback covers them.
    await quests.recordQuestEvent(tx, playerId, 'care_mode_ticks', ticks, {}, now);
    if (affectionGained > 0) {
      await quests.recordQuestEvent(
        tx,
        playerId,
        'waifu_affection_gained',
        affectionGained,
        {},
        now,
      );
    }

    const targetSnapshot = updatedWaifu
      ? { waifu: updatedWaifu, species: target.species }
      : target;
    const nextTickAt = alsoExit ? null : new Date(newLastTick.getTime() + interval);

    return {
      active: !alsoExit,
      stopped: alsoExit,
      ticksProcessed: ticks,
      energyGained,
      waifuXpGained,
      affectionGained,
      target: targetSnapshot,
      fromLevel,
      toLevel: newLevel,
      leveledUp: newLevel > fromLevel,
      lastTickAt: alsoExit ? null : newLastTick,
      nextTickAt,
    };
  }

  async function clearCareFields(tx: DbOrTx, playerId: number): Promise<void> {
    await tx
      .update(players)
      .set({
        careModeStartedAt: null,
        careModeLastTickAt: null,
        careModeWaifuId: null,
      })
      .where(eq(players.id, playerId));
  }

  async function readPlayer(playerId: number): Promise<PlayerRow> {
    const [row] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
    if (!row) throw new PlayerNotFoundError(playerId);
    return row;
  }

  const service: CareService = {
    config: careConfig,

    async getState(playerId, now = new Date()) {
      const [player] = await db
        .select()
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (!player) throw new PlayerNotFoundError(playerId);
      const [cur] = await db
        .select()
        .from(playerCurrencies)
        .where(eq(playerCurrencies.playerId, playerId))
        .limit(1);
      const currentEnergy = cur?.huntEnergy ?? 0;
      const maxEnergy = progression.computeMaxEnergy(player.level);
      const cap = Math.min(careConfig.recoveryCap, maxEnergy);
      const active =
        player.careModeStartedAt != null &&
        player.careModeLastTickAt != null &&
        player.careModeWaifuId != null;
      let target: { waifu: PlayerWaifuRow; species: SpeciesRow } | null = null;
      let pendingTicks = 0;
      let nextTickAt: Date | null = null;
      if (active) {
        const [row] = await db
          .select({ waifu: playerWaifus, species })
          .from(playerWaifus)
          .innerJoin(species, eq(playerWaifus.speciesId, species.id))
          .where(
            and(
              eq(playerWaifus.id, player.careModeWaifuId!),
              eq(playerWaifus.playerId, playerId),
            ),
          )
          .limit(1);
        if (row && row.waifu.releasedAt == null) {
          target = { waifu: row.waifu, species: row.species };
          const interval = intervalMs();
          const elapsed = Math.max(0, now.getTime() - player.careModeLastTickAt!.getTime());
          pendingTicks = Math.floor(elapsed / interval);
          nextTickAt = new Date(player.careModeLastTickAt!.getTime() + interval);
        }
      }
      return {
        active: active && target != null,
        startedAt: player.careModeStartedAt,
        lastTickAt: player.careModeLastTickAt,
        nextTickAt,
        target,
        pendingTicks,
        intervalMinutes: careConfig.intervalMinutes,
        energyPerTick: careConfig.energyPerTick,
        waifuXpPerTick: careConfig.waifuXpPerTick,
        affectionPerTick: careConfig.affectionPerTick,
        recoveryCap: careConfig.recoveryCap,
        effectiveEnergyCap: cap,
        currentEnergy,
        maxEnergy,
        enabled: careConfig.enabled,
      };
    },

    async start(playerId, targetWaifuId = null, now = new Date()) {
      return db.transaction(async (tx) => {
        const [player] = await tx
          .select()
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new PlayerNotFoundError(playerId);

        const alreadyActive =
          player.careModeStartedAt != null &&
          player.careModeLastTickAt != null &&
          player.careModeWaifuId != null;

        // Resolve the intended target. Explicit id wins; otherwise fall back
        // to the buddy pointer; otherwise fall back to the currently-cared
        // waifu (a bare "start" while already active keeps the same target).
        let intendedTargetId: number | null = targetWaifuId ?? null;
        if (intendedTargetId == null && player.buddyWaifuId != null) {
          intendedTargetId = player.buddyWaifuId;
        }
        if (intendedTargetId == null && alreadyActive) {
          intendedTargetId = player.careModeWaifuId!;
        }
        if (intendedTargetId == null) {
          // No target and no way to infer one — the UI is responsible for
          // asking the player to choose. Surface as a not-owned error so
          // callers can distinguish it uniformly.
          throw new WaifuNotOwnedError(0);
        }

        // Validate the intended target belongs to this player and is active.
        // (Lock inside tickCore too, but a preflight here gives a clean
        // error for the "target not owned" case before any tick math runs.)
        const preflight = await lockOwnedTarget(tx, playerId, intendedTargetId);

        if (alreadyActive) {
          if (player.careModeWaifuId === intendedTargetId) {
            // Same target: apply pending ticks and stay in Care Mode. Do NOT
            // reset last_tick_at — partial-interval progress is preserved.
            return tickCore(tx, playerId, now, false);
          }
          // Different target: apply pending ticks to the OLD target, then
          // switch. Reset last_tick_at to `now` so the new target starts a
          // fresh interval.
          const old = await tickCore(tx, playerId, now, false);
          await tx
            .update(players)
            .set({ careModeWaifuId: intendedTargetId, careModeLastTickAt: now })
            .where(eq(players.id, playerId));
          const interval = intervalMs();
          return {
            ...old,
            active: true,
            stopped: false,
            target: preflight,
            fromLevel: preflight.waifu.level,
            toLevel: preflight.waifu.level,
            leveledUp: false,
            lastTickAt: now,
            nextTickAt: new Date(now.getTime() + interval),
          };
        }

        // Fresh start.
        await tx
          .update(players)
          .set({
            careModeStartedAt: now,
            careModeLastTickAt: now,
            careModeWaifuId: intendedTargetId,
          })
          .where(eq(players.id, playerId));
        const interval = intervalMs();
        return {
          active: true,
          stopped: false,
          ticksProcessed: 0,
          energyGained: 0,
          waifuXpGained: 0,
          affectionGained: 0,
          target: preflight,
          fromLevel: preflight.waifu.level,
          toLevel: preflight.waifu.level,
          leveledUp: false,
          lastTickAt: now,
          nextTickAt: new Date(now.getTime() + interval),
        };
      });
    },

    async leave(playerId, now = new Date()) {
      return db.transaction((tx) => tickCore(tx, playerId, now, true));
    },

    async changeTarget(playerId, targetWaifuId, now = new Date()) {
      return db.transaction(async (tx) => {
        const [player] = await tx
          .select()
          .from(players)
          .where(eq(players.id, playerId))
          .for('update');
        if (!player) throw new PlayerNotFoundError(playerId);
        const alreadyActive =
          player.careModeStartedAt != null &&
          player.careModeLastTickAt != null &&
          player.careModeWaifuId != null;
        // Validate the *new* target up front (clean error if not owned).
        const preflight = await lockOwnedTarget(tx, playerId, targetWaifuId);
        if (!alreadyActive) {
          // Treat as start-with-target (fresh interval).
          await tx
            .update(players)
            .set({
              careModeStartedAt: now,
              careModeLastTickAt: now,
              careModeWaifuId: targetWaifuId,
            })
            .where(eq(players.id, playerId));
          const interval = intervalMs();
          return {
            active: true,
            stopped: false,
            ticksProcessed: 0,
            energyGained: 0,
            waifuXpGained: 0,
            affectionGained: 0,
            target: preflight,
            fromLevel: preflight.waifu.level,
            toLevel: preflight.waifu.level,
            leveledUp: false,
            lastTickAt: now,
            nextTickAt: new Date(now.getTime() + interval),
          };
        }
        if (player.careModeWaifuId === targetWaifuId) {
          // Same target — behave like start: apply pending ticks, keep
          // interval alignment.
          return tickCore(tx, playerId, now, false);
        }
        const old = await tickCore(tx, playerId, now, false);
        await tx
          .update(players)
          .set({ careModeWaifuId: targetWaifuId, careModeLastTickAt: now })
          .where(eq(players.id, playerId));
        const interval = intervalMs();
        return {
          ...old,
          active: true,
          stopped: false,
          target: preflight,
          fromLevel: preflight.waifu.level,
          toLevel: preflight.waifu.level,
          leveledUp: false,
          lastTickAt: now,
          nextTickAt: new Date(now.getTime() + interval),
        };
      });
    },

    async applyAndExit(tx, playerId, now = new Date()) {
      return tickCore(tx, playerId, now, true);
    },

    async applyPending(playerId, now = new Date()) {
      // Cheap short-circuit: skip the transaction entirely when Care Mode
      // is not active. Keeps UI paints from acquiring row locks for the
      // vastly-more-common inactive case.
      const player = await readPlayer(playerId);
      const active =
        player.careModeStartedAt != null &&
        player.careModeLastTickAt != null &&
        player.careModeWaifuId != null;
      if (!active) return { ...INACTIVE_SUMMARY };
      return db.transaction((tx) => tickCore(tx, playerId, now, false));
    },
  };

  return service;
}
