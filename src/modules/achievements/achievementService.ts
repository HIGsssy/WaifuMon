/**
 * AchievementService — resolves a player's achievements from canonical state
 * and persists the one fact that state cannot reconstruct: when each badge was
 * first earned.
 *
 * ## Derived, with a lazy durable unlock
 *
 * Progress is computed on read from a **metric snapshot** — a handful of
 * bounded, indexed aggregate queries over the player's own rows (never a scan
 * of every player, never an N+1). The first time a read observes an
 * achievement at or past its target, a `player_achievements` row is written
 * with `unlocked_at = now`. That write is idempotent (`ON CONFLICT DO
 * NOTHING`) so two concurrent reads cannot double-insert, and it is the only
 * write on the read path. An earned badge is thereafter reported from the
 * durable row and never re-evaluated, so it cannot revert if the live metric
 * later dips (a released copy, a retuned threshold).
 *
 * ## Backfill
 *
 * There is no migration backfill and none is possible: a derived unlock time is
 * not reconstructable from current state. Every achievement a player already
 * qualifies for on deploy materialises on their next read, stamped with the
 * time of first observation — deliberately not backdated.
 */
import { and, count, countDistinct, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  bossParticipations,
  encounters,
  players,
  playerAchievements,
  playerUnlockedRoutes,
  playerWaifus,
  species,
} from '../../db/schema';
import type { AchievementDefinition } from './achievementRules';
import {
  newlyUnlockedIds,
  resolveAchievements,
  summarize,
  type AchievementCategory,
  type AchievementSummary,
  type MetricSnapshot,
  type ResolvedAchievement,
} from './achievementRules';

export interface PlayerAchievementsResult {
  summary: AchievementSummary;
  achievements: ResolvedAchievement[];
}

export interface PublicAchievement {
  id: string;
  name: string;
  category: AchievementCategory;
  icon: string | null;
  unlockedAt: string;
}

export interface PublicAchievementSummary {
  total: number;
  unlocked: number;
  completionPercent: number;
  /** Most-recently earned, newest first. Never includes a locked achievement. */
  recent: PublicAchievement[];
}

export interface AchievementService {
  /** The loaded definitions, in authored order. */
  getDefinitions(): readonly AchievementDefinition[];
  /**
   * The player's own achievements: resolved progress plus a summary. Lazily
   * persists any newly-earned unlock timestamps.
   */
  getPlayerAchievements(playerId: number): Promise<PlayerAchievementsResult>;
  /**
   * A public, showcase-safe summary for another player in the same guild.
   * Read-only (no lazy persistence for a viewer) and never exposes a locked or
   * hidden-locked achievement.
   */
  getPublicSummary(playerId: number, recentLimit?: number): Promise<PublicAchievementSummary>;
}

const HIGH_RARITY_FLAGS: Record<string, keyof MetricSnapshot | undefined> = {
  SR: 'first_sr',
  SSR: 'first_ssr',
  UR: 'first_ur',
  LR: 'first_lr',
};

export function createAchievementService(
  db: Db,
  definitions: readonly AchievementDefinition[],
): AchievementService {
  /**
   * Every metric an achievement can test, for one player, from durable state.
   * All queries filter to this player's own rows on indexed columns; the whole
   * snapshot is a fixed, small number of aggregates run concurrently.
   */
  async function metricSnapshot(playerId: number): Promise<MetricSnapshot> {
    const ownedFilter = and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt));

    const [
      [playerRow],
      [huntsRow = { total: 0 }],
      [capturesRow = { total: 0 }],
      [distinctRow = { total: 0 }],
      rarityRows,
      [bossRow = { total: 0 }],
      [regionsRow = { total: 0 }],
    ] = await Promise.all([
      db
        .select({ level: players.level, xp: players.xp, buddyWaifuId: players.buddyWaifuId })
        .from(players)
        .where(eq(players.id, playerId)),
      // Hunts completed: every encounter that has left the `active` state,
      // whatever its outcome (captured, escaped, released, expired).
      db
        .select({ total: count() })
        .from(encounters)
        .where(and(eq(encounters.playerId, playerId), ne(encounters.state, 'active'))),
      // Captures: every copy this player has ever caught, released or not — a
      // capture happened even if the copy was later let go.
      db.select({ total: count() }).from(playerWaifus).where(eq(playerWaifus.playerId, playerId)),
      // Distinct species currently owned.
      db.select({ total: countDistinct(playerWaifus.speciesId) }).from(playerWaifus).where(ownedFilter),
      // Every rarity this player has ever captured (released copies included).
      db
        .selectDistinct({ rarity: species.rarity })
        .from(playerWaifus)
        .innerJoin(species, eq(playerWaifus.speciesId, species.id))
        .where(eq(playerWaifus.playerId, playerId)),
      db
        .select({ total: count() })
        .from(bossParticipations)
        .where(eq(bossParticipations.playerId, playerId)),
      // Regions reached: the home region is always available and is never a
      // route row, so the distinct unlocked routes are the regions *beyond* it.
      db
        .select({ total: countDistinct(playerUnlockedRoutes.regionId) })
        .from(playerUnlockedRoutes)
        .where(eq(playerUnlockedRoutes.playerId, playerId)),
    ]);

    const buddyWaifuId = playerRow?.buddyWaifuId ?? null;
    let buddyAffection = 0;
    if (buddyWaifuId !== null) {
      const [buddyRow] = await db
        .select({ affection: playerWaifus.affection })
        .from(playerWaifus)
        .where(
          and(
            eq(playerWaifus.id, buddyWaifuId),
            eq(playerWaifus.playerId, playerId),
            isNull(playerWaifus.releasedAt),
          ),
        );
      buddyAffection = buddyRow?.affection ?? 0;
    }

    const snapshot: MetricSnapshot = {
      level: playerRow?.level ?? 0,
      xp: playerRow?.xp ?? 0,
      hunts: huntsRow.total,
      captures: capturesRow.total,
      distinct_species: distinctRow.total,
      boss_participations: bossRow.total,
      // +1 for the home region every trainer starts in.
      regions_visited: regionsRow.total + 1,
      buddy_set: buddyWaifuId !== null ? 1 : 0,
      buddy_affection: buddyAffection,
      first_sr: 0,
      first_ssr: 0,
      first_ur: 0,
      first_lr: 0,
    };

    for (const row of rarityRows) {
      const flag = HIGH_RARITY_FLAGS[row.rarity];
      if (flag) snapshot[flag] = 1;
    }

    return snapshot;
  }

  async function loadUnlockMap(playerId: number): Promise<Map<string, Date>> {
    const rows = await db
      .select({ id: playerAchievements.achievementId, unlockedAt: playerAchievements.unlockedAt })
      .from(playerAchievements)
      .where(eq(playerAchievements.playerId, playerId));
    return new Map(rows.map((r) => [r.id, r.unlockedAt]));
  }

  return {
    getDefinitions() {
      return definitions;
    },

    async getPlayerAchievements(playerId) {
      const [snapshot, unlockMap] = await Promise.all([
        metricSnapshot(playerId),
        loadUnlockMap(playerId),
      ]);

      const newly = newlyUnlockedIds(definitions, snapshot, unlockMap);
      if (newly.length > 0) {
        const now = new Date();
        await db
          .insert(playerAchievements)
          .values(
            newly.map((n) => ({
              playerId,
              achievementId: n.id,
              progress: n.progress,
              unlockedAt: now,
            })),
          )
          .onConflictDoNothing();
        for (const n of newly) unlockMap.set(n.id, now);
      }

      const achievements = resolveAchievements(definitions, snapshot, unlockMap);
      return { summary: summarize(achievements), achievements };
    },

    async getPublicSummary(playerId, recentLimit = 5) {
      const [snapshot, unlockMap] = await Promise.all([
        metricSnapshot(playerId),
        loadUnlockMap(playerId),
      ]);

      // Read-only: derive unlocked state without materialising rows for a
      // viewer. `resolveAchievements` treats a metric at/over target as
      // unlocked even with no persisted row, so counts are correct.
      const resolved = resolveAchievements(definitions, snapshot, unlockMap);
      const summary = summarize(resolved);

      const byId = new Map(definitions.map((d) => [d.id, d]));
      const recent: PublicAchievement[] = resolved
        .filter((a) => a.unlocked && a.unlockedAt !== null)
        .sort((a, b) => (a.unlockedAt! < b.unlockedAt! ? 1 : a.unlockedAt! > b.unlockedAt! ? -1 : 0))
        .slice(0, recentLimit)
        .map((a) => {
          const def = byId.get(a.id);
          return {
            id: a.id,
            name: def?.name ?? a.name,
            category: def?.category ?? a.category,
            icon: def?.icon ?? null,
            unlockedAt: a.unlockedAt!,
          };
        });

      return {
        total: summary.total,
        unlocked: summary.unlocked,
        completionPercent: summary.completionPercent,
        recent,
      };
    },
  };
}
