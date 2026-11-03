/**
 * Commentary context — authoritative, guild-public facts about one WaifuMon
 * announcement, for a read-only integration that saw the message.
 *
 * The caller names a **message**, never a player. The message resolves through
 * the announcement ledger (captures, level-ups, appearance unlocks, collection
 * completion) or through `boss_encounters`' own message ids (boss posts), and
 * only then is a player read — from the record, never from a name.
 *
 * Two kinds of data, kept apart in the result:
 *   - `announced` — what the message said when it was posted. Immutable.
 *   - `facts` — read live now, each wrapped in a {@link Fact} that is either
 *     `verified` with its `asOf`, or `unavailable` with a reason. A verified 0
 *     is a real zero; nothing unavailable is ever rendered as one.
 *
 * Disclosure stops at what a guild-mate can already see in the Portal (public
 * profile, public collection, leaderboard *ranks*) plus what the announcement
 * itself published. No XP, currency, affection, Seductive Power, inventory,
 * gear, release history, hidden achievements or per-player boss rewards.
 *
 * Every live fact runs under its own time budget and degrades alone; the
 * lookups that decide *whether* there is an answer are the only reads that can
 * fail the request.
 */
import { and, count, countDistinct, eq, inArray, isNull, or, sum } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  RARITIES,
  bossEncounters,
  bossParticipations,
  playerWaifus,
  players,
  species,
  type AnnouncementLedgerRow,
  type BossEncounterRow,
  type PlayerRow,
  type Rarity,
} from '../../db/schema';
import { DatabaseUnavailableError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { AnnouncementLedger } from '../announcements/announcementLedger';
import type { CollectionService } from '../collection/collectionService';
import { assignRanks, rankOf } from '../leaderboards/leaderboardRanking';
import type { LeaderboardService } from '../leaderboards/leaderboardService';

/** Bumped only for breaking changes; new kinds and fact keys are additive. */
export const COMMENTARY_CONTRACT_VERSION = 1;

export type UnavailableReason = 'not_recorded' | 'withheld' | 'player_unavailable' | 'degraded';

export type Fact<T> =
  | { status: 'verified'; value: T; asOf: Date }
  | { status: 'unavailable'; reason: UnavailableReason };

export type CommentaryKind =
  | AnnouncementLedgerRow['kind']
  | 'boss_spawn'
  | 'boss_completed'
  | 'boss_results';

export interface CommentaryPlayer {
  playerId: number | null;
  discordUserId: string | null;
  status: 'active' | 'unavailable';
}

export interface CommentaryContext {
  contractVersion: typeof COMMENTARY_CONTRACT_VERSION;
  announcement: {
    messageId: string;
    /** Null only for a boss encounter whose channel was never recorded. */
    channelId: string | null;
    kind: CommentaryKind;
    eventId: string;
    occurredAt: Date;
  };
  player: CommentaryPlayer | null;
  announced: Record<string, unknown>;
  facts: Record<string, Fact<unknown>>;
}

export interface CommentaryContextDeps {
  db: Db;
  ledger: AnnouncementLedger;
  collection: Pick<CollectionService, 'getDexStats'>;
  leaderboards: LeaderboardService;
  logger: Logger;
  /** Budget per live fact before it degrades. Default 750 ms. */
  factBudgetMs?: number;
  /** Budget for the lookups that decide whether there is an answer. Default 1500 ms. */
  lookupBudgetMs?: number;
  now?: () => Date;
}

export interface CommentaryContextService {
  /**
   * The context for `messageId`, or null when it is not a recorded WaifuMon
   * announcement in `guildDbId`. Throws `DatabaseUnavailableError` when the
   * deciding lookups cannot reach the database.
   */
  forMessage(guildDbId: number, messageId: string): Promise<CommentaryContext | null>;
}

const WITHHELD: Fact<never> = { status: 'unavailable', reason: 'withheld' };
const NOT_RECORDED: Fact<never> = { status: 'unavailable', reason: 'not_recorded' };
const PLAYER_UNAVAILABLE: Fact<never> = { status: 'unavailable', reason: 'player_unavailable' };

const TIMEOUT = Symbol('timeout');

async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Connection-level failures, as `pg` reports them: the server is down, the
 * pool cannot connect, or the connection was dropped. A query bug is not one
 * of these and stays a 500.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = String((err as { code?: unknown }).code ?? '');
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03'].includes(code)) {
    return true;
  }
  if (code.startsWith('08')) return true;
  const message = String((err as { message?: unknown }).message ?? '');
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
    message,
  );
}

function bossKindFor(row: BossEncounterRow, messageId: string): CommentaryKind {
  if (row.resultsMessageId === messageId) return 'boss_results';
  return row.status === 'resolved' || row.status === 'cancelled' ? 'boss_completed' : 'boss_spawn';
}

export function createCommentaryContextService(deps: CommentaryContextDeps): CommentaryContextService {
  const { db, ledger, logger } = deps;
  const factBudgetMs = deps.factBudgetMs ?? 750;
  const lookupBudgetMs = deps.lookupBudgetMs ?? 1500;
  const now = deps.now ?? (() => new Date());

  /** A deciding lookup: a timeout or a lost connection is a 503, never a guess. */
  async function lookup<T>(label: string, work: () => Promise<T>): Promise<T> {
    let result: T | typeof TIMEOUT;
    try {
      result = await withinBudget(work(), lookupBudgetMs);
    } catch (err) {
      if (isDatabaseUnavailable(err)) throw new DatabaseUnavailableError(`commentary ${label}: ${String(err)}`);
      throw err;
    }
    if (result === TIMEOUT) throw new DatabaseUnavailableError(`commentary ${label} exceeded ${lookupBudgetMs}ms`);
    return result;
  }

  /** A live fact: its own budget, its own failure, stamped when it was read. */
  async function fact<T>(label: string, work: () => Promise<T>): Promise<Fact<T>> {
    try {
      const value = await withinBudget(work(), factBudgetMs);
      if (value === TIMEOUT) {
        logger.warn({ tag: 'commentary/fact-degraded', fact: label, budgetMs: factBudgetMs }, 'commentary fact timed out');
        return { status: 'unavailable', reason: 'degraded' };
      }
      return { status: 'verified', value, asOf: now() };
    } catch (err) {
      logger.warn({ err, tag: 'commentary/fact-degraded', fact: label }, 'commentary fact failed');
      return { status: 'unavailable', reason: 'degraded' };
    }
  }

  // ── Live queries. Each is bounded by one player, one species or one guild. ──

  async function playerLevel(playerId: number): Promise<number> {
    const [row] = await db.select({ level: players.level }).from(players).where(eq(players.id, playerId));
    if (!row) throw new Error('player vanished between lookup and fact');
    return row.level;
  }

  async function activeCopiesOfSpecies(playerId: number, slug: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.playerId, playerId), eq(species.slug, slug), isNull(playerWaifus.releasedAt)));
    return row?.n ?? 0;
  }

  async function rarityDistribution(playerId: number): Promise<Record<Rarity, number>> {
    const rows = await db
      .select({ rarity: species.rarity, n: count() })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)))
      .groupBy(species.rarity);
    const out = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<Rarity, number>;
    for (const row of rows) if (row.rarity in out) out[row.rarity as Rarity] = row.n;
    return out;
  }

  async function guildTrainers(guildDbId: number): Promise<number> {
    const [row] = await db.select({ n: count() }).from(players).where(eq(players.guildId, guildDbId));
    return row?.n ?? 0;
  }

  async function guildOwnersOfSpecies(guildDbId: number, slug: string) {
    const [[owners], trainers] = await Promise.all([
      db
        .select({ n: countDistinct(playerWaifus.playerId) })
        .from(playerWaifus)
        .innerJoin(players, eq(playerWaifus.playerId, players.id))
        .innerJoin(species, eq(playerWaifus.speciesId, species.id))
        .where(and(eq(players.guildId, guildDbId), eq(species.slug, slug), isNull(playerWaifus.releasedAt))),
      guildTrainers(guildDbId),
    ]);
    return { trainers: owners?.n ?? 0, guildTrainers: trainers };
  }

  async function trainerRank(guildDbId: number, playerId: number) {
    const rows = await deps.leaderboards.getGuildMetric(guildDbId, 'trainer');
    const rank = rankOf(assignRanks(rows), playerId);
    if (rank === null) throw new Error('player missing from its guild ranking');
    return { rank, guildTrainers: rows.length };
  }

  /** Level of one copy, only while the player still owns it actively. */
  async function copyLevel(playerId: number, waifuId: number): Promise<number | null> {
    const [row] = await db
      .select({ level: playerWaifus.level })
      .from(playerWaifus)
      .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)));
    return row?.level ?? null;
  }

  async function guildBossHistory(guildDbId: number, bossId: string) {
    const rows = await db
      .select({ reason: bossEncounters.resolutionReason, n: count() })
      .from(bossEncounters)
      .where(
        and(
          eq(bossEncounters.guildId, guildDbId),
          eq(bossEncounters.bossId, bossId),
          inArray(bossEncounters.status, ['resolved', 'cancelled']),
        ),
      )
      .groupBy(bossEncounters.resolutionReason);
    const byReason = (r: string) => rows.find((row) => row.reason === r)?.n ?? 0;
    return {
      encounters: rows.reduce((a, row) => a + row.n, 0),
      repelled: byReason('repelled'),
      unchallenged: byReason('unchallenged'),
      cancelled: byReason('cancelled_admin'),
      channelLost: byReason('channel_lost'),
    };
  }

  // ── Resolution ──

  /** The ledger's player, if it still exists and still belongs to this guild. */
  async function playerFor(playerId: number | null, guildDbId: number): Promise<PlayerRow | null> {
    if (playerId === null) return null;
    const [row] = await lookup('player', () => db.select().from(players).where(eq(players.id, playerId)));
    return row && row.guildId === guildDbId ? row : null;
  }

  function describePlayer(row: PlayerRow | null, recordedId: number | null): CommentaryPlayer {
    return row
      ? { playerId: row.id, discordUserId: row.discordUserId, status: 'active' }
      : { playerId: recordedId, discordUserId: null, status: 'unavailable' };
  }

  async function fromLedger(row: AnnouncementLedgerRow, guildDbId: number): Promise<CommentaryContext> {
    const player = await playerFor(row.playerId, guildDbId);
    const announced = row.payload;
    const facts: Record<string, Fact<unknown>> = {};

    const live = <T>(label: string, work: (p: PlayerRow) => Promise<T>): Promise<Fact<T>> =>
      player ? fact(label, () => work(player)) : Promise.resolve(PLAYER_UNAVAILABLE);

    switch (row.kind) {
      case 'rare_capture': {
        const slug = String((announced.species as { slug?: unknown } | undefined)?.slug ?? '');
        const [level, copies, collection, distribution, owners] = await Promise.all([
          live('playerLevel', (p) => playerLevel(p.id)),
          live('activeCopiesOfSpecies', (p) => activeCopiesOfSpecies(p.id, slug)),
          live('collection', (p) => deps.collection.getDexStats(p.id)),
          live('rarityDistribution', (p) => rarityDistribution(p.id)),
          fact('guildOwnersOfSpecies', () => guildOwnersOfSpecies(guildDbId, slug)),
        ]);
        Object.assign(facts, {
          playerLevel: level,
          activeCopiesOfSpecies: copies,
          collection,
          rarityDistribution: distribution,
          guildOwnersOfSpecies: owners,
          // Derivable, but it would reveal release history, which is self-only.
          firstEverCopy: WITHHELD,
          // A copy has no link to the encounter or region that produced it.
          captureRegion: NOT_RECORDED,
        });
        break;
      }
      case 'appearance_unlock': {
        const waifuId = Number(announced.waifuId);
        const [level, collection, copy] = await Promise.all([
          live('playerLevel', (p) => playerLevel(p.id)),
          live('collection', (p) => deps.collection.getDexStats(p.id)),
          player
            ? fact('copyLevel', () => copyLevel(player.id, waifuId))
            : Promise.resolve(PLAYER_UNAVAILABLE),
        ]);
        // A copy no longer in the public collection reads as withheld, never 0.
        const copyFact: Fact<unknown> =
          copy.status === 'verified' && copy.value === null ? WITHHELD : copy;
        Object.assign(facts, { playerLevel: level, collection, copyLevel: copyFact });
        break;
      }
      case 'level_up': {
        const [level, rank] = await Promise.all([
          live('playerLevel', (p) => playerLevel(p.id)),
          live('trainerRank', (p) => trainerRank(guildDbId, p.id)),
        ]);
        Object.assign(facts, { playerLevel: level, trainerRank: rank });
        break;
      }
      case 'collection_completed': {
        facts.collection = await live('collection', (p) => deps.collection.getDexStats(p.id));
        break;
      }
    }

    return {
      contractVersion: COMMENTARY_CONTRACT_VERSION,
      announcement: {
        messageId: row.messageId,
        channelId: row.channelId,
        kind: row.kind,
        eventId: row.eventId,
        occurredAt: row.occurredAt,
      },
      player: describePlayer(player, row.playerId),
      announced,
      facts,
    };
  }

  async function fromBoss(row: BossEncounterRow, messageId: string, guildDbId: number): Promise<CommentaryContext> {
    const kind = bossKindFor(row, messageId);
    const ended = kind !== 'boss_spawn';

    const [attacks, firstOnScene] = ended
      ? await Promise.all([
          lookup('boss attacks', async () => {
            const [r] = await db
              .select({ total: sum(bossParticipations.attackCount) })
              .from(bossParticipations)
              .where(eq(bossParticipations.encounterId, row.id));
            return Number(r?.total ?? 0);
          }),
          kind === 'boss_results'
            ? lookup('boss first on scene', async () => {
                const [r] = await db
                  .select({
                    playerId: bossParticipations.playerId,
                    discordUserId: bossParticipations.discordUserId,
                    trainerName: bossParticipations.trainerName,
                    waifuName: bossParticipations.waifuName,
                  })
                  .from(bossParticipations)
                  .where(eq(bossParticipations.encounterId, row.id))
                  .orderBy(bossParticipations.committedAt, bossParticipations.id)
                  .limit(1);
                return r ?? null;
              })
            : Promise.resolve(null),
        ])
      : [null, null];

    const announced: Record<string, unknown> = {
      encounterId: row.id,
      boss: { id: row.bossId, name: row.bossName, affinity: row.bossAffinity, region: row.region },
      deadlineAt: row.deadlineAt,
    };
    if (ended) {
      Object.assign(announced, {
        outcome: row.resolutionReason,
        participantCount: row.participantCount,
        totalDamage: row.totalDamage,
        totalAttacks: attacks,
        resolvedAt: row.resolvedAt,
      });
    }
    if (kind === 'boss_results') announced.firstOnScene = firstOnScene;

    const facts: Record<string, Fact<unknown>> = {
      guildBossHistory: await fact('guildBossHistory', () => guildBossHistory(guildDbId, row.bossId)),
      // The results embed promises each trainer's payout is private.
      perPlayerRewards: WITHHELD,
      // Bosses are repelled or unchallenged by the guild; no player wins or loses one.
      perPlayerOutcome: NOT_RECORDED,
    };

    const occurredAt =
      kind === 'boss_spawn'
        ? (row.scoutingStartedAt ?? row.createdAt)
        : kind === 'boss_results'
          ? (row.resultsPublishedAt ?? row.resolvedAt ?? row.createdAt)
          : (row.resolvedAt ?? row.createdAt);

    return {
      contractVersion: COMMENTARY_CONTRACT_VERSION,
      announcement: {
        messageId,
        channelId: row.channelId,
        kind,
        // Boss posts are not minted from a GameEvent; the encounter id and the
        // message's role identify the event, stably across retries.
        eventId: `boss:${row.id}:${kind.slice('boss_'.length)}`,
        occurredAt,
      },
      player: null,
      announced,
      facts,
    };
  }

  return {
    async forMessage(guildDbId, messageId) {
      const recorded = await lookup('ledger', () => ledger.findByMessageId(messageId));
      if (recorded) return recorded.guildId === guildDbId ? fromLedger(recorded, guildDbId) : null;

      const [boss] = await lookup('boss message', () =>
        db
          .select()
          .from(bossEncounters)
          .where(
            and(
              eq(bossEncounters.guildId, guildDbId),
              or(eq(bossEncounters.messageId, messageId), eq(bossEncounters.resultsMessageId, messageId)),
            ),
          )
          .limit(1),
      );
      return boss ? fromBoss(boss, messageId, guildDbId) : null;
    },
  };
}
