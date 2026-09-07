import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  guilds,
  playerCurrencies,
  playerWaifus,
  players,
  species,
  type PlayerCurrenciesRow,
  type PlayerRow,
} from '../../db/schema';
import { AppError } from '../../shared/errors';

/**
 * How many rows the guild directory will ever consider.
 *
 * The directory sorts and searches by *display name*, which lives on Discord
 * and not in this database, so those two operations cannot be pushed into SQL
 * (see `listGuildDirectory`). Everything after the query therefore happens in
 * memory, and this is the bound that makes that safe: a guild with more
 * players than this is truncated to its {@link DIRECTORY_MAX_PLAYERS} most
 * recently active, which is the population a directory is actually for.
 */
export const DIRECTORY_MAX_PLAYERS = 500;

/** The window `activity: 'recent'` means. See {@link listGuildDirectory}. */
export const ACTIVE_PLAYER_WINDOW_DAYS = 30;

/**
 * One row of the guild player directory.
 *
 * Deliberately not a `PlayerRow`: this is the *only* shape that crosses into a
 * response describing somebody other than the caller, so it lists what it
 * carries rather than inheriting a table. `xp`, currencies, care state,
 * settings and showcase are absent by construction, not by filtering later.
 *
 * `discordUserId` is here because presentation identity is resolved from it one
 * layer up; the API resource drops it (see `directoryPlayerSchema`).
 */
export interface DirectoryPlayer {
  id: number;
  discordUserId: string;
  level: number;
  /**
   * The canonical activity signal — `last_hunt_at`, falling back to
   * `created_at` for a player who has joined but never hunted. Coarse by
   * design: it is a date, not a presence indicator.
   */
  lastActiveAt: Date;
  buddy: {
    waifuId: number;
    level: number;
    variant: string;
    speciesSlug: string;
    speciesName: string;
    rarity: string;
  } | null;
}

export interface DirectoryQuery {
  guildDbId: number;
  /**
   * `all` (default) lists every player row in the guild — the safest existing
   * definition of membership. `recent` narrows to
   * {@link ACTIVE_PLAYER_WINDOW_DAYS} days of activity.
   */
  activity?: 'all' | 'recent' | undefined;
  /**
   * Narrow to a single player. Used by the public profile route so it reads
   * one player's directory row — buddy joined in — with the same query and the
   * same guild predicate as the list, rather than a second code path that
   * could disagree about scope.
   */
  playerId?: number | undefined;
  /** Injectable clock so the activity window is testable. */
  now?: Date | undefined;
}

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
  /**
   * Every Waifumon player in one guild, with their active buddy, in a single
   * query.
   *
   * ## What counts as a player here
   *
   * A row in `players` for this guild. That row is created the first time
   * somebody interacts with Waifumon in that server (`ensurePlayer`) and is
   * never created any other way, so its existence *is* the application's
   * record of guild participation. The bot does not maintain Discord
   * membership state — there is no members table, no join/leave bookkeeping,
   * and nothing that observes a departure — so this is the strongest signal
   * available, and it is the definition the directory uses by default.
   *
   * `activity: 'recent'` layers the one reliable *timestamp* on top of it:
   * `COALESCE(last_hunt_at, created_at)` within
   * {@link ACTIVE_PLAYER_WINDOW_DAYS} days. That is a coarse recency filter,
   * not an online indicator, and nothing here fabricates presence.
   *
   * ## Why one query
   *
   * The buddy comes back on the same row through two LEFT JOINs, so a page of
   * fifty players costs one round trip rather than fifty-one. The join is
   * `players.buddy_waifu_id → player_waifus.id` with `released_at IS NULL`,
   * which mirrors the invariant `CollectionService` maintains — a soft-released
   * copy that is still pointed at reads as "no buddy" rather than as a ghost.
   */
  listGuildDirectory(query: DirectoryQuery): Promise<DirectoryPlayer[]>;
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
    async listGuildDirectory({ guildDbId, activity = 'all', playerId, now = new Date() }) {
      // `COALESCE(last_hunt_at, created_at)` is written once and reused for the
      // filter, the ordering and the returned field, so the three cannot drift
      // into disagreeing about when somebody was last seen.
      const lastActive = sql<Date>`coalesce(${players.lastHuntAt}, ${players.createdAt})`;
      const cutoff = new Date(now.getTime() - ACTIVE_PLAYER_WINDOW_DAYS * 86_400_000);

      const rows = await db
        .select({
          id: players.id,
          discordUserId: players.discordUserId,
          level: players.level,
          lastActiveAt: lastActive,
          buddyWaifuId: playerWaifus.id,
          buddyLevel: playerWaifus.level,
          buddyVariant: playerWaifus.variant,
          buddySpeciesSlug: species.slug,
          buddySpeciesName: species.name,
          buddyRarity: species.rarity,
        })
        .from(players)
        .leftJoin(
          playerWaifus,
          and(eq(playerWaifus.id, players.buddyWaifuId), isNull(playerWaifus.releasedAt)),
        )
        .leftJoin(species, eq(species.id, playerWaifus.speciesId))
        .where(
          and(
            eq(players.guildId, guildDbId),
            ...(activity === 'recent' ? [gte(lastActive, cutoff)] : []),
            ...(playerId === undefined ? [] : [eq(players.id, playerId)]),
          ),
        )
        // Most-recently-active first so the cap, when it bites, drops the most
        // dormant rows rather than an arbitrary slice. `id` breaks ties so the
        // page boundary is stable across requests.
        .orderBy(desc(lastActive), players.id)
        .limit(DIRECTORY_MAX_PLAYERS);

      return rows.map((row) => ({
        id: row.id,
        discordUserId: row.discordUserId,
        level: row.level,
        // node-postgres hands back a Date for a timestamptz expression, but the
        // expression is untyped SQL — normalise rather than trust the cast.
        lastActiveAt: row.lastActiveAt instanceof Date ? row.lastActiveAt : new Date(String(row.lastActiveAt)),
        buddy:
          row.buddyWaifuId !== null &&
          row.buddySpeciesSlug !== null &&
          row.buddySpeciesName !== null &&
          row.buddyRarity !== null
            ? {
                waifuId: row.buddyWaifuId,
                level: row.buddyLevel ?? 1,
                variant: row.buddyVariant ?? 'standard',
                speciesSlug: row.buddySpeciesSlug,
                speciesName: row.buddySpeciesName,
                rarity: row.buddyRarity,
              }
            : null,
      }));
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
