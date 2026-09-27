/**
 * Synthetic load-test players: who the virtual players *are*.
 *
 * ## Why synthetic players at all
 *
 * The workloads are read-only, but "read-only" is not the same as "harmless":
 * `GET /achievements` inserts newly-met unlocks and `GET /encounter` expires a
 * stale encounter. Pointing fifty virtual players at real accounts would change
 * real state. So every virtual player is one of these, in one synthetic guild,
 * and nothing in the harness can name anyone else — `assertSyntheticPlayers`
 * refuses before a single session is minted.
 *
 * ## What they look like
 *
 * Deterministic from the player's index, so a fixture built on the 3400GE and
 * one built on the Scale VM hold the same collections — the same sizes, the
 * same species, the same levels. Every player owns the same 24-card *grid*
 * (the warm card workload's pool, and the species every player has discovered,
 * which the cold workload draws from) plus a varying tail of 10–50 more
 * copies, so collection pages differ in length the way real ones do.
 *
 * ## What they cannot do
 *
 * - **Appear to real players.** Directories and leaderboards are guild-scoped
 *   and these live in a guild no real member belongs to.
 * - **Reach Discord.** The guild has no announce channel and no boss channel,
 *   so nothing narrates or schedules for it; identity, ownership and role
 *   lookups short-circuit on the synthetic prefix (`synthetic.ts`).
 * - **Hold admin.** The synthetic guild has no Discord owner, so its sessions
 *   compute an empty permission set.
 *
 * The fixture persists between runs — rebuilding fifty collections every run
 * would put a write burst in front of every measurement. It is created on
 * first use, extended when a run asks for more players than exist, and marked
 * per player with the fixture version it was built from.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  guilds,
  items,
  playerCurrencies,
  playerInventory,
  players,
  playerWaifus,
  portalSessions,
  species,
} from '../../db/schema';
import { seededRng } from '../../shared/random';
import {
  isSyntheticDiscordId,
  SYNTHETIC_GUILD_DISCORD_ID,
  SYNTHETIC_ID_SQL_PATTERN,
  syntheticDiscordUserId,
} from './synthetic';

/** Bump when the shape of a synthetic collection changes. */
export const FIXTURE_VERSION = 1;

/** Cards every synthetic player owns and the warm workload requests. */
export const GRID_SIZE = 24;

/** Level printed on grid copies: a handful of values, so the warm set stays small. */
const GRID_LEVELS = [1, 5, 10, 15] as const;
const TAIL_LEVELS = [1, 2, 3, 5, 8, 12, 16, 20, 25, 30] as const;

export interface SyntheticPlayer {
  index: number;
  playerId: number;
  guildDbId: number;
  discordUserId: string;
  ownedWaifuIds: number[];
  gridWaifuIds: number[];
  speciesSlugs: string[];
}

export class SyntheticIsolationError extends Error {
  constructor(message: string) {
    super(`load-test isolation violated: ${message}`);
    this.name = 'SyntheticIsolationError';
  }
}

/**
 * Refuses unless every id is a synthetic player in the synthetic guild. The
 * one gate between "the harness's list of players" and "sessions minted for
 * them" — checked against the database, not against the list's own claims.
 */
export async function assertSyntheticPlayers(db: Db, playerIds: readonly number[]): Promise<void> {
  if (playerIds.length === 0) return;
  const rows = await db
    .select({
      id: players.id,
      discordUserId: players.discordUserId,
      discordGuildId: guilds.discordGuildId,
    })
    .from(players)
    .innerJoin(guilds, eq(players.guildId, guilds.id))
    .where(inArray(players.id, [...playerIds]));
  if (rows.length !== new Set(playerIds).size) {
    throw new SyntheticIsolationError('a planned player does not exist');
  }
  for (const row of rows) {
    if (row.discordGuildId !== SYNTHETIC_GUILD_DISCORD_ID || !isSyntheticDiscordId(row.discordUserId)) {
      throw new SyntheticIsolationError(`player ${row.id} is not a synthetic load-test player`);
    }
  }
}

async function ensureSyntheticGuild(db: Db): Promise<number> {
  await db
    .insert(guilds)
    .values({
      discordGuildId: SYNTHETIC_GUILD_DISCORD_ID,
      // Explicitly null: no Waifumon Log, no boss scheduling, ever.
      announceChannelId: null,
      bossChannelId: null,
      settings: { loadTest: true },
    })
    .onConflictDoNothing({ target: guilds.discordGuildId });
  const [row] = await db
    .select({ id: guilds.id, announce: guilds.announceChannelId, boss: guilds.bossChannelId })
    .from(guilds)
    .where(eq(guilds.discordGuildId, SYNTHETIC_GUILD_DISCORD_ID));
  if (!row) throw new Error('synthetic guild could not be provisioned');
  if (row.announce !== null || row.boss !== null) {
    // Someone configured channels on the synthetic guild. Clear them rather
    // than run: a channel here is a Discord side effect waiting to happen.
    await db
      .update(guilds)
      .set({ announceChannelId: null, bossChannelId: null })
      .where(eq(guilds.id, row.id));
  }
  return row.id;
}

interface SpeciesRef {
  id: number;
  slug: string;
}

/**
 * The same species on every host: enabled species in slug order. Deterministic
 * as long as content matches, which is the premise of comparing two hosts.
 */
async function speciesPool(db: Db): Promise<SpeciesRef[]> {
  return db
    .select({ id: species.id, slug: species.slug })
    .from(species)
    .where(eq(species.enabled, true))
    .orderBy(asc(species.slug));
}

async function seedPlayerCollection(
  db: Db,
  playerId: number,
  index: number,
  pool: readonly SpeciesRef[],
): Promise<void> {
  const rng = seededRng(0x5eed + index);
  const grid = pool.slice(0, Math.min(GRID_SIZE, pool.length));
  const tailCount = 10 + ((index * 7) % 41);
  const rows = [
    ...grid.map((s, i) => ({
      playerId,
      speciesId: s.id,
      level: GRID_LEVELS[i % GRID_LEVELS.length]!,
      baseSp: 10 + i,
    })),
    ...Array.from({ length: tailCount }, () => {
      const s = pool[rng.intInclusive(0, pool.length - 1)]!;
      return {
        playerId,
        speciesId: s.id,
        level: TAIL_LEVELS[rng.intInclusive(0, TAIL_LEVELS.length - 1)]!,
        baseSp: rng.intInclusive(5, 60),
      };
    }),
  ];

  await db.transaction(async (tx) => {
    const inserted = await tx.insert(playerWaifus).values(rows).returning({ id: playerWaifus.id });
    const buddy = inserted[0]?.id ?? null;
    await tx
      .update(players)
      .set({ buddyWaifuId: buddy, settings: { loadTestFixture: FIXTURE_VERSION } })
      .where(eq(players.id, playerId));
    await tx
      .update(playerCurrencies)
      .set({ huntEnergy: 30, waifubux: 5_000, essence: 500 })
      .where(eq(playerCurrencies.playerId, playerId));
    const itemRows = await tx
      .select({ id: items.id })
      .from(items)
      .orderBy(asc(items.slug))
      .limit(6);
    if (itemRows.length > 0) {
      await tx
        .insert(playerInventory)
        .values(itemRows.map((it, i) => ({ playerId, itemId: it.id, quantity: 1 + ((index + i) % 9) })))
        .onConflictDoNothing();
    }
  });
}

/**
 * Ensures `count` synthetic players exist with their collections, and returns
 * them in index order. Idempotent: an existing, current player is read, not
 * rebuilt.
 */
export async function ensureSyntheticPlayers(db: Db, count: number): Promise<SyntheticPlayer[]> {
  const guildDbId = await ensureSyntheticGuild(db);
  const pool = await speciesPool(db);
  if (pool.length === 0) throw new Error('no enabled species — content has not been seeded');

  const out: SyntheticPlayer[] = [];
  for (let index = 0; index < count; index += 1) {
    const discordUserId = syntheticDiscordUserId(index);
    await db
      .insert(players)
      .values({ guildId: guildDbId, discordUserId })
      .onConflictDoNothing({ target: [players.guildId, players.discordUserId] });
    const [player] = await db
      .select({ id: players.id, settings: players.settings })
      .from(players)
      .where(and(eq(players.guildId, guildDbId), eq(players.discordUserId, discordUserId)));
    if (!player) throw new Error(`synthetic player ${discordUserId} could not be provisioned`);
    await db
      .insert(playerCurrencies)
      .values({ playerId: player.id, huntEnergy: 30 })
      .onConflictDoNothing({ target: playerCurrencies.playerId });

    if ((player.settings as { loadTestFixture?: number }).loadTestFixture !== FIXTURE_VERSION) {
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(playerWaifus)
        .where(eq(playerWaifus.playerId, player.id));
      if (n === 0) await seedPlayerCollection(db, player.id, index, pool);
    }

    const owned = await db
      .select({ id: playerWaifus.id, slug: species.slug })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.playerId, player.id), isNull(playerWaifus.releasedAt)))
      .orderBy(asc(playerWaifus.id));
    out.push({
      index,
      playerId: player.id,
      guildDbId,
      discordUserId,
      ownedWaifuIds: owned.map((o) => o.id),
      gridWaifuIds: owned.slice(0, GRID_SIZE).map((o) => o.id),
      speciesSlugs: [...new Set(owned.map((o) => o.slug))].sort(),
    });
  }
  await assertSyntheticPlayers(db, out.map((p) => p.playerId));
  return out;
}

/**
 * Removes every synthetic Portal session. Run at the start (a crashed run may
 * have left some) and the end of each run, so no load-test credential outlives
 * the run it was minted for. Scoped by the synthetic id pattern, which no real
 * Discord user id can match (see `synthetic.ts`).
 */
export async function deleteSyntheticSessions(db: Db): Promise<number> {
  const deleted = await db
    .delete(portalSessions)
    .where(sql`${portalSessions.discordUserId} ~ ${SYNTHETIC_ID_SQL_PATTERN}`)
    .returning({ digest: portalSessions.sessionDigest });
  return deleted.length;
}
