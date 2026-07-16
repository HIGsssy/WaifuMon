import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  guilds,
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
  /**
   * Read-only lookup by discord ids — returns the player row's id if it
   * already exists, else null. Never writes (used by autocomplete).
   */
  findPlayerId(discordGuildId: string, discordUserId: string): Promise<number | null>;
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
    async findPlayerId(discordGuildId, discordUserId) {
      const [row] = await db
        .select({ id: players.id })
        .from(players)
        .innerJoin(guilds, eq(players.guildId, guilds.id))
        .where(and(eq(guilds.discordGuildId, discordGuildId), eq(players.discordUserId, discordUserId)))
        .limit(1);
      return row?.id ?? null;
    },
  };
}
