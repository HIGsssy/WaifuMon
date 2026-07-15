import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  playerCurrencies,
  players,
  type PlayerCurrenciesRow,
  type PlayerRow,
} from '../../db/schema';
import { AppError } from '../../shared/errors';

export interface PlayerService {
  /**
   * Auto-provisions the player (and currency row) on first interaction —
   * `INSERT … ON CONFLICT DO NOTHING`, race-safe via the
   * (guild_id, discord_user_id) unique constraint. No registration step.
   */
  ensurePlayer(guildId: number, discordUserId: string): Promise<PlayerRow>;
  getById(playerId: number): Promise<PlayerRow | undefined>;
  getProfile(playerId: number): Promise<{ player: PlayerRow; currencies: PlayerCurrenciesRow }>;
}

export interface PlayerServiceOptions {
  /** Hunt Energy granted at provisioning (players start ready to play). */
  initialEnergy: number;
}

export function createPlayerService(db: Db, options: PlayerServiceOptions): PlayerService {
  async function ensurePlayer(guildId: number, discordUserId: string): Promise<PlayerRow> {
    const inserted = await db
      .insert(players)
      .values({ guildId, discordUserId })
      .onConflictDoNothing({ target: [players.guildId, players.discordUserId] })
      .returning();
    let player = inserted[0];
    if (!player) {
      player = await db.query.players.findFirst({
        where: and(eq(players.guildId, guildId), eq(players.discordUserId, discordUserId)),
      });
    }
    if (!player) {
      throw new AppError('PLAYER_PROVISION_FAILED', `Player ${guildId}/${discordUserId} vanished`);
    }
    await db
      .insert(playerCurrencies)
      .values({ playerId: player.id, huntEnergy: options.initialEnergy })
      .onConflictDoNothing({ target: playerCurrencies.playerId });
    return player;
  }

  return {
    ensurePlayer,
    async getById(playerId) {
      return db.query.players.findFirst({ where: eq(players.id, playerId) });
    },
    async getProfile(playerId) {
      const player = await db.query.players.findFirst({ where: eq(players.id, playerId) });
      const currencies = await db.query.playerCurrencies.findFirst({
        where: eq(playerCurrencies.playerId, playerId),
      });
      if (!player || !currencies) {
        throw new AppError('PLAYER_NOT_FOUND', `Player ${playerId} not fully provisioned`);
      }
      return { player, currencies };
    },
  };
}
