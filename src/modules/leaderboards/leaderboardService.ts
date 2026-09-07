/**
 * LeaderboardService — guild-scoped rankings, one reusable query per metric.
 *
 * ## Guild scope is the access boundary (§9, §10)
 *
 * Every query filters on `players.guild_id`. There is no global leaderboard and
 * no way to ask for one: the service is only ever handed the `guildDbId` the
 * caller's Portal session resolved to, and it ranks that guild's players and
 * no one else's. A member of guild A cannot enumerate guild B because guild B's
 * rows are never in the result set.
 *
 * ## No N+1, no per-player query
 *
 * Each metric is a single aggregate over the guild's players — a left join and
 * a `GROUP BY`, never a query per player and never a load of every collection
 * into memory. Guild player counts are small and bounded; the whole guild is
 * ranked in one round trip, which also makes `me.rank` correct for players
 * outside the visible top N without a second query.
 *
 * ## Raw values never leave the backend (§10)
 *
 * These methods return `{ playerId, discordUserId, value }` for the caller to
 * *rank*. The value is an input to `assignRanks`; the API layer serialises only
 * the resulting rank. Nothing in `src/api` puts `value` on the wire.
 */
import { and, count, countDistinct, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { players, playerWaifus, species } from '../../db/schema';

export const LEADERBOARD_METRICS = [
  'trainer',
  'collector',
  'hunter',
  'devoted',
  'legendary',
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

/** Rarities that count toward the "Legendary Hunters" board. */
const LEGENDARY_RARITIES = ['UR', 'LR', 'EX'] as const;

export interface LeaderboardRow {
  playerId: number;
  discordUserId: string;
  /** Internal only — ranked, never serialised. */
  value: number;
}

export interface LeaderboardService {
  /**
   * Every player in the guild with their value for one metric, guild-scoped.
   * Unranked: the caller assigns ranks. One query, no per-player work.
   */
  getGuildMetric(guildDbId: number, metric: LeaderboardMetric): Promise<LeaderboardRow[]>;
}

export function createLeaderboardService(db: Db): LeaderboardService {
  async function getGuildMetric(
    guildDbId: number,
    metric: LeaderboardMetric,
  ): Promise<LeaderboardRow[]> {
    const guildFilter = eq(players.guildId, guildDbId);

    switch (metric) {
      // Top Trainers — trainer XP.
      case 'trainer':
        return db
          .select({
            playerId: players.id,
            discordUserId: players.discordUserId,
            value: players.xp,
          })
          .from(players)
          .where(guildFilter);

      // Master Collectors — distinct species currently owned.
      case 'collector':
        return db
          .select({
            playerId: players.id,
            discordUserId: players.discordUserId,
            value: countDistinct(playerWaifus.speciesId),
          })
          .from(players)
          .leftJoin(
            playerWaifus,
            and(eq(playerWaifus.playerId, players.id), isNull(playerWaifus.releasedAt)),
          )
          .where(guildFilter)
          .groupBy(players.id, players.discordUserId);

      // Elite Hunters — total captures (every copy ever caught).
      case 'hunter':
        return db
          .select({
            playerId: players.id,
            discordUserId: players.discordUserId,
            value: count(playerWaifus.id),
          })
          .from(players)
          .leftJoin(playerWaifus, eq(playerWaifus.playerId, players.id))
          .where(guildFilter)
          .groupBy(players.id, players.discordUserId);

      // Most Devoted — current Buddy's affection.
      case 'devoted':
        return db
          .select({
            playerId: players.id,
            discordUserId: players.discordUserId,
            value: sql<number>`coalesce(${playerWaifus.affection}, 0)::int`,
          })
          .from(players)
          .leftJoin(
            playerWaifus,
            and(
              eq(playerWaifus.id, players.buddyWaifuId),
              eq(playerWaifus.playerId, players.id),
              isNull(playerWaifus.releasedAt),
            ),
          )
          .where(guildFilter);

      // Legendary Hunters — high-rarity captures (UR and above).
      case 'legendary':
        return db
          .select({
            playerId: players.id,
            discordUserId: players.discordUserId,
            value: count(species.id),
          })
          .from(players)
          .leftJoin(playerWaifus, eq(playerWaifus.playerId, players.id))
          .leftJoin(
            species,
            and(
              eq(species.id, playerWaifus.speciesId),
              inArray(species.rarity, [...LEGENDARY_RARITIES]),
            ),
          )
          .where(guildFilter)
          .groupBy(players.id, players.discordUserId);
    }
  }

  return { getGuildMetric };
}
