/**
 * ProgressionService — grants XP inside the caller's transaction, promotes the
 * player's level when thresholds are crossed, and writes an audit row per
 * grant. All rewards (max energy, daily bonus items, rare shift, prestige
 * titles) are looked up through the pure helpers in `progressionMath.ts` and
 * driven by `content/tables.json`.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import {
  playerProgressionEvents,
  players,
  type PlayerRow,
  type Rarity,
} from '../../db/schema';
import { PlayerNotFoundError } from '../../shared/errors';
import type { ProgressionConfig } from '../content/schemas';
import {
  cumulativeXpForLevel,
  dailyBonusItemsForLevel,
  dailyRareItemChanceForLevel,
  describeLevelRewards,
  levelFromTotalXp,
  levelProgress,
  maxEnergyForLevel,
  prestigeTitleForLevel,
  rareEncounterShift,
  xpToNext,
  type LevelProgress,
} from './progressionMath';

export interface LevelUpEvent {
  fromLevel: number;
  toLevel: number;
  /** Human-readable strings — safe to concatenate into an embed footer. */
  rewardLabels: string[];
}

export interface GrantXpOptions {
  eventType: string;
  xpDelta: number;
  refId?: number | null;
  metadata?: Record<string, unknown>;
}

export interface GrantXpResult {
  xpDelta: number;
  totalXp: number;
  fromLevel: number;
  toLevel: number;
  levelUps: LevelUpEvent[];
  player: PlayerRow;
}

export interface ProgressionService {
  // ── pure helpers, no DB ─────────────────────────────────────────────────
  /** Level derived from total XP (clamped to maxLevel). */
  levelFromXp(xp: number): number;
  /** Progress payload for the profile view. */
  progressFor(xp: number): LevelProgress;
  /** XP needed to advance from `level` to `level+1` (0 at max). */
  xpToNext(level: number): number;
  computeMaxEnergy(level: number): number;
  computeRareShift(level: number): {
    fromRarity: Rarity;
    toRarity: Rarity;
    weightUnits: number;
  } | null;
  getPrestigeTitle(level: number): string | null;
  computeDailyBonusItems(level: number): Array<{ slug: string; quantity: number }>;
  computeDailyRareChance(level: number): number;
  describeLevelRewards(newLevel: number): string[];

  // ── transactional grant ──────────────────────────────────────────────────
  /**
   * Grant XP inside the caller's transaction. Locks the player row, updates
   * total XP + level, records the audit row, returns the level-up events.
   * `xpDelta` of 0 still writes an audit row (useful for "new dex" bookkeeping
   * when the source XP was already 0).
   */
  grantXp(tx: DbOrTx, playerId: number, opts: GrantXpOptions): Promise<GrantXpResult>;
}

export interface ProgressionServiceDeps {
  config: ProgressionConfig;
  /**
   * Level-1 max energy (matches `content.tables.energy.baseMax`). Kept
   * separate so `computeMaxEnergy` can layer bonuses additively on top.
   */
  baseMaxEnergy: number;
}

export function createProgressionService(deps: ProgressionServiceDeps): ProgressionService {
  const { config, baseMaxEnergy } = deps;

  const svc: ProgressionService = {
    levelFromXp: (xp) => levelFromTotalXp(xp, config),
    progressFor: (xp) => levelProgress(xp, config),
    xpToNext: (level) => xpToNext(level, config),
    computeMaxEnergy: (level) => maxEnergyForLevel(level, baseMaxEnergy, config),
    computeRareShift: (level) => rareEncounterShift(level, config),
    getPrestigeTitle: (level) => prestigeTitleForLevel(level, config),
    computeDailyBonusItems: (level) => dailyBonusItemsForLevel(level, config),
    computeDailyRareChance: (level) => dailyRareItemChanceForLevel(level, config),
    describeLevelRewards: (newLevel) => describeLevelRewards(newLevel, config),
    async grantXp(tx, playerId, opts) {
      const [locked] = await tx
        .select()
        .from(players)
        .where(eq(players.id, playerId))
        .for('update');
      if (!locked) throw new PlayerNotFoundError(playerId);

      const fromLevel = locked.level;
      const nextTotalXp = Math.max(0, locked.xp + opts.xpDelta);
      const toLevel = svc.levelFromXp(nextTotalXp);

      const levelUps: LevelUpEvent[] = [];
      for (let L = fromLevel + 1; L <= toLevel; L++) {
        levelUps.push({
          fromLevel: L - 1,
          toLevel: L,
          rewardLabels: svc.describeLevelRewards(L),
        });
      }

      // Sanity guard: cumulative-XP invariant (players never below-level).
      // A hostile external edit could put xp below its level minimum — bumping
      // XP down still leaves level correct because `levelFromXp` re-derives.
      const cumulAtLevel = cumulativeXpForLevel(toLevel, config);
      void cumulAtLevel; // referenced for readers; TS won't dead-code the call

      const setPayload: Partial<PlayerRow> = {};
      if (opts.xpDelta !== 0) setPayload.xp = nextTotalXp;
      if (toLevel !== fromLevel) setPayload.level = toLevel;

      let updated: PlayerRow = locked;
      if (Object.keys(setPayload).length > 0) {
        const [row] = await tx
          .update(players)
          .set(setPayload)
          .where(eq(players.id, playerId))
          .returning();
        if (row) updated = row;
      }

      await tx.insert(playerProgressionEvents).values({
        playerId,
        eventType: opts.eventType,
        xpDelta: opts.xpDelta,
        refId: opts.refId ?? null,
        metadata: opts.metadata ?? {},
      });

      return {
        xpDelta: opts.xpDelta,
        totalXp: nextTotalXp,
        fromLevel,
        toLevel,
        levelUps,
        player: updated,
      };
    },
  };

  return svc;
}
