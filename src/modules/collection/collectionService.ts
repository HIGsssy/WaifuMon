/**
 * CollectionService (Milestone 3) — owned Waifumon browsing, inspect, favorite
 * toggle, duplicate → Essence conversion, and release.
 *
 * Reads happen without locks (rendering the collection can be eventually
 * consistent). State-mutating operations use `SELECT … FOR UPDATE` on the
 * owned-waifu row and the currency row, so concurrent double-clicks on
 * Convert / Release / Favorite can't drift.
 *
 * Soft-release model: `releasedAt` is set instead of deleting the row, so
 * capture history and audit trails stay intact. `listOwned`, `getOwned`, and
 * `getDexStats` all filter on `releasedAt IS NULL`.
 */
import { and, asc, count, countDistinct, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  playerWaifus,
  players,
  species,
  type PlayerRow,
  type PlayerWaifuRow,
  type Rarity,
  type SpeciesRow,
} from '../../db/schema';
import type {
  AppearanceService,
  AppearanceUnlockRef,
} from '../appearance/appearanceService';
import type { DuplicateConfig, WaifuProgressionConfig } from '../content/schemas';
import {
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuIsBuddyError,
  WaifuIsFavoriteError,
  WaifuNicknameTooEarlyError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { QuestService } from '../quests/questService';

export interface OwnedEntry {
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
}

export interface PaginatedOwned {
  entries: OwnedEntry[];
  page: number;
  pageSize: number;
  totalOwned: number;
  totalPages: number;
}

export interface DexStats {
  /** Number of active (non-released) owned Waifumon. */
  owned: number;
  /** Distinct species among active owned Waifumon. */
  distinctSpecies: number;
  /** Total enabled species in the content set. */
  totalSpecies: number;
}

export interface ReleaseResult {
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
  essenceGranted: number;
  balanceAfter: number;
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
  rarity?: Rarity;
}

export interface ReleaseOptions {
  /** When true, bypass the favorite-guard (second confirmation). */
  force?: boolean;
  now?: Date;
}

export interface ConvertOptions {
  /** When true, bypass the favorite-guard (second confirmation). */
  force?: boolean;
  now?: Date;
}

export interface WaifuProgress {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpToNext: number;
  atMaxLevel: boolean;
}

export interface WaifuInvestResult {
  waifu: PlayerWaifuRow;
  essenceSpent: number;
  xpGranted: number;
  fromLevel: number;
  toLevel: number;
  essenceBalanceAfter: number;
  /**
   * Cosmetic appearances this level gain unlocked. Presentation only — the
   * caller renders a toast; nothing downstream branches on it. Empty when the
   * appearance service is not wired.
   */
  newAppearances: AppearanceUnlockRef[];
}

export interface BuddyAwardResult {
  waifu: PlayerWaifuRow;
  xpGranted: number;
  affectionGranted: number;
  fromLevel: number;
  toLevel: number;
  /** Cosmetic unlocks the buddy's hunt XP produced. Presentation only. */
  newAppearances: AppearanceUnlockRef[];
}

export interface CollectionService {
  listOwned(playerId: number, opts?: ListOptions): Promise<PaginatedOwned>;
  getDexStats(playerId: number): Promise<DexStats>;
  getOwned(playerId: number, waifuId: number): Promise<OwnedEntry>;
  /**
   * True iff the player has at least one *other* active (non-released) copy
   * of the same species — i.e. the given waifu row is a duplicate. Read-only.
   */
  hasOtherActiveCopies(playerId: number, waifuId: number): Promise<boolean>;
  /** Substring match on nickname/species name, active copies only. */
  searchByName(playerId: number, query: string, limit?: number): Promise<OwnedEntry[]>;
  /**
   * Convert this owned copy to Essence. Fails with `NotADuplicateError` when
   * it's the player's only active copy of the species — release instead.
   * Fails with `WaifuIsFavoriteError` on favorites unless `force` is set.
   * Fails with `WaifuIsBuddyError` if the copy is the active buddy.
   */
  convertDuplicateToEssence(
    playerId: number,
    waifuId: number,
    opts?: ConvertOptions,
  ): Promise<ReleaseResult>;
  /**
   * Manual release from inspect: soft-release + grant `floor(dupEssence ×
   * releaseFraction)`. Favorites require `force=true` (second confirmation).
   * Active buddy always throws `WaifuIsBuddyError`.
   */
  releaseWaifu(playerId: number, waifuId: number, opts?: ReleaseOptions): Promise<ReleaseResult>;
  toggleFavorite(playerId: number, waifuId: number): Promise<PlayerWaifuRow>;

  // ── Buddy ─────────────────────────────────────────────────────────────────
  /** Sets the active buddy — must be an owned, non-released copy. */
  setBuddy(playerId: number, waifuId: number): Promise<{ player: PlayerRow; buddy: OwnedEntry }>;
  /** Clears the active buddy (no-op if none). */
  clearBuddy(playerId: number): Promise<PlayerRow>;
  /** Returns the currently-active buddy entry, or null. */
  getBuddy(playerId: number): Promise<OwnedEntry | null>;
  /**
   * Transaction-scoped buddy lookup for callers that already hold a tx (the
   * capture path). Mirrors `awardBuddyOnHunt`'s self-heal: a pointer aiming at
   * a missing or soft-released copy is cleared and read as "no buddy", so a
   * stale buddy can never contribute an affinity bonus.
   */
  resolveActiveBuddy(tx: DbOrTx, playerId: number): Promise<OwnedEntry | null>;

  // ── Individual Waifumon progression ───────────────────────────────────────
  /** XP required to advance the waifu from `level` to `level+1` (0 at max). */
  waifuXpToNext(level: number): number;
  /** Level derived from total waifu XP (clamped to `waifuProgression.maxLevel`). */
  waifuLevelFromXp(xp: number): number;
  /** Progress payload for the inspect card. */
  waifuProgress(waifu: PlayerWaifuRow): WaifuProgress;
  /**
   * Spend `essenceInvestment.essenceCost` Essence to grant
   * `essenceInvestment.xpGranted` XP to the given owned waifu. Transactional:
   * currency + waifu row lock; may cascade multiple waifu level-ups.
   */
  investEssence(playerId: number, waifuId: number, now?: Date): Promise<WaifuInvestResult>;
  /**
   * Set a nickname on the given waifu. Requires the waifu's level to meet
   * `waifuProgression.nicknameMinLevel`. Empty/null clears the nickname.
   */
  setNickname(playerId: number, waifuId: number, nickname: string | null): Promise<PlayerWaifuRow>;
  /**
   * Called from HuntService inside its transaction — if the player has an
   * active buddy, grant per-hunt XP + affection. Returns null when no buddy.
   */
  awardBuddyOnHunt(tx: DbOrTx, playerId: number): Promise<BuddyAwardResult | null>;
}

export interface CollectionServiceDeps {
  db: Db;
  currency: CurrencyService;
  quests: QuestService;
  duplicateConfig: DuplicateConfig;
  waifuConfig: WaifuProgressionConfig;
  /** Total enabled species in the content set (dex denominator). */
  totalSpeciesCount: number;
  /**
   * Cosmetic appearance bookkeeping. **Optional**, and deliberately one-way:
   * this service calls into it after a level changes so the player is told
   * about newly-earned artwork, and it never reads anything back that affects
   * gameplay. Omitting it (as older tests do) simply means no unlock toasts.
   */
  appearance?: AppearanceService | undefined;
}

const DEFAULT_PAGE_SIZE = 10;
/** Larger cap for select-menu options (Discord permits ≤25). */
const MAX_SEARCH_LIMIT = 25;

/** Rarity ordering as a CASE expression — higher rank = rarer, sorted DESC. */
const RARITY_RANK_SQL = sql`case ${species.rarity}
  when 'EX' then 6
  when 'LR' then 5
  when 'UR' then 4
  when 'SSR' then 3
  when 'SR' then 2
  when 'R' then 1
  when 'N' then 0
  else -1
end`;

export function createCollectionService(deps: CollectionServiceDeps): CollectionService {
  const { db, currency, quests, duplicateConfig, waifuConfig, totalSpeciesCount } = deps;
  const appearance = deps.appearance;

  /**
   * Cosmetic side effect of a level gain, run inside the caller's transaction.
   * Never throws outward: a content mistake must not roll back an Essence
   * investment or a buddy's hunt XP.
   */
  async function syncAppearances(
    tx: DbOrTx,
    waifu: PlayerWaifuRow,
    fromLevel: number,
  ): Promise<AppearanceUnlockRef[]> {
    if (!appearance || waifu.level <= fromLevel) return [];
    return appearance.syncUnlocks(tx, waifu, undefined, 'level');
  }

  function essenceForRarity(rarity: string, fraction = 1): number {
    const value = (duplicateConfig.essenceByRarity as Record<string, number>)[rarity] ?? 0;
    return Math.max(0, Math.floor(value * fraction));
  }

  // ── Waifu level curve (mirrors the pure math in progressionMath). ─────────
  function waifuXpToNext(level: number): number {
    if (level >= waifuConfig.maxLevel) return 0;
    return waifuConfig.levelCurve.base + waifuConfig.levelCurve.growth * (level - 1);
  }
  function waifuCumulativeXp(level: number): number {
    let total = 0;
    const bound = Math.min(level, waifuConfig.maxLevel);
    for (let l = 1; l < bound; l++) total += waifuXpToNext(l);
    return total;
  }
  function waifuLevelFromXp(xp: number): number {
    let level = 1;
    let consumed = 0;
    while (level < waifuConfig.maxLevel) {
      const need = waifuXpToNext(level);
      if (consumed + need > xp) break;
      consumed += need;
      level++;
    }
    return level;
  }
  function waifuProgressPayload(waifu: PlayerWaifuRow): WaifuProgress {
    const level = waifu.level;
    const cumul = waifuCumulativeXp(level);
    const need = waifuXpToNext(level);
    return {
      level,
      xp: waifu.xp,
      xpIntoLevel: waifu.xp - cumul,
      xpToNext: need,
      atMaxLevel: level >= waifuConfig.maxLevel,
    };
  }

  async function listOwned(playerId: number, opts: ListOptions = {}): Promise<PaginatedOwned> {
    const pageSize = Math.max(1, Math.min(25, opts.pageSize ?? DEFAULT_PAGE_SIZE));
    const page = Math.max(1, opts.page ?? 1);
    const filters = [eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)];
    if (opts.rarity) filters.push(eq(species.rarity, opts.rarity));

    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(...filters));

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(page, totalPages);

    const rows = await db
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(...filters))
      .orderBy(sql`${RARITY_RANK_SQL} desc`, asc(species.name), asc(playerWaifus.id))
      .limit(pageSize)
      .offset((clampedPage - 1) * pageSize);

    return {
      entries: rows,
      page: clampedPage,
      pageSize,
      totalOwned: total,
      totalPages,
    };
  }

  async function getDexStats(playerId: number): Promise<DexStats> {
    const [owned = { total: 0 }] = await db
      .select({ total: count() })
      .from(playerWaifus)
      .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)));
    const [distinct = { total: 0 }] = await db
      .select({ total: countDistinct(playerWaifus.speciesId) })
      .from(playerWaifus)
      .where(and(eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)));
    return {
      owned: owned.total,
      distinctSpecies: distinct.total,
      totalSpecies: totalSpeciesCount,
    };
  }

  async function getOwned(playerId: number, waifuId: number): Promise<OwnedEntry> {
    const [row] = await db
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)));
    if (!row) throw new WaifuNotOwnedError(waifuId);
    if (row.waifu.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
    return row;
  }

  async function searchByName(
    playerId: number,
    query: string,
    limit = MAX_SEARCH_LIMIT,
  ): Promise<OwnedEntry[]> {
    const q = query.trim();
    const cap = Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit));
    const base = [eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)];
    const filters =
      q.length > 0
        ? [
            ...base,
            or(ilike(species.name, `%${q}%`), ilike(playerWaifus.nickname, `%${q}%`)),
          ]
        : base;
    return db
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(...filters))
      .orderBy(sql`${RARITY_RANK_SQL} desc`, asc(species.name), asc(playerWaifus.id))
      .limit(cap);
  }

  async function softRelease(
    playerId: number,
    waifuId: number,
    fraction: number,
    now: Date,
    allowFavorite: boolean,
    requireDuplicate: boolean,
  ): Promise<ReleaseResult> {
    return db.transaction(async (tx) => {
      // Lock the owned-waifu row.
      const [locked] = await tx
        .select()
        .from(playerWaifus)
        .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
        .for('update');
      if (!locked) throw new WaifuNotOwnedError(waifuId);
      if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
      if (locked.isFavorite && !allowFavorite) throw new WaifuIsFavoriteError();

      // Buddy guard: releasing / converting the active buddy is blocked.
      // Player must switch buddies (or clear) before saying goodbye.
      const [player] = await tx
        .select({ buddyWaifuId: players.buddyWaifuId })
        .from(players)
        .where(eq(players.id, playerId))
        .for('update');
      if (player?.buddyWaifuId === waifuId) throw new WaifuIsBuddyError();

      if (requireDuplicate) {
        const [others = { total: 0 }] = await tx
          .select({ total: count() })
          .from(playerWaifus)
          .where(
            and(
              eq(playerWaifus.playerId, playerId),
              eq(playerWaifus.speciesId, locked.speciesId),
              ne(playerWaifus.id, waifuId),
              isNull(playerWaifus.releasedAt),
            ),
          );
        if (others.total <= 0) throw new NotADuplicateError(waifuId);
      }

      const [speciesRow] = await tx
        .select()
        .from(species)
        .where(eq(species.id, locked.speciesId));
      if (!speciesRow) throw new WaifuNotOwnedError(waifuId);

      const essence = essenceForRarity(speciesRow.rarity, fraction);

      // Serialize with concurrent shop/daily spends on the same player.
      const currencyRow = await currency.lockCurrencies(tx, playerId);
      const [updatedWaifu] = await tx
        .update(playerWaifus)
        .set({ releasedAt: now })
        .where(eq(playerWaifus.id, waifuId))
        .returning();
      let balanceAfter = currencyRow.essence;
      if (essence > 0) {
        const row = await currency.grantEssence(tx, playerId, essence);
        balanceAfter = row.essence;
      }

      // Daily-quest progress: only "convert duplicate" counts. Plain release
      // is a different intent and doesn't tick the convert quest.
      if (requireDuplicate) {
        await quests.recordQuestEvent(tx, playerId, 'duplicate_converted', 1, {}, now);
      }

      return {
        waifu: updatedWaifu!,
        species: speciesRow,
        essenceGranted: essence,
        balanceAfter,
      };
    });
  }

  async function hasOtherActiveCopies(playerId: number, waifuId: number): Promise<boolean> {
    // Read-only: existence check for another active copy of the same species.
    const [row] = await db
      .select({ speciesId: playerWaifus.speciesId })
      .from(playerWaifus)
      .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)));
    if (!row) return false;
    const [others = { total: 0 }] = await db
      .select({ total: count() })
      .from(playerWaifus)
      .where(
        and(
          eq(playerWaifus.playerId, playerId),
          eq(playerWaifus.speciesId, row.speciesId),
          ne(playerWaifus.id, waifuId),
          isNull(playerWaifus.releasedAt),
        ),
      );
    return others.total > 0;
  }

  return {
    listOwned,
    getDexStats,
    getOwned,
    hasOtherActiveCopies,
    searchByName,
    async convertDuplicateToEssence(playerId, waifuId, opts = {}) {
      // Convert to full duplicate-essence value; require the copy to actually
      // be a duplicate (post-capture and post-hoc from inspect both satisfy
      // this because the "other" copy is either the pre-existing one or a
      // duplicate captured earlier).
      return softRelease(
        playerId,
        waifuId,
        1,
        opts.now ?? new Date(),
        opts.force === true,
        true,
      );
    },
    async releaseWaifu(playerId, waifuId, opts = {}) {
      return softRelease(
        playerId,
        waifuId,
        duplicateConfig.releaseFraction,
        opts.now ?? new Date(),
        opts.force === true,
        false,
      );
    },
    async toggleFavorite(playerId, waifuId) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(playerWaifus)
          .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
          .for('update');
        if (!locked) throw new WaifuNotOwnedError(waifuId);
        if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
        const [updated] = await tx
          .update(playerWaifus)
          .set({ isFavorite: !locked.isFavorite })
          .where(eq(playerWaifus.id, waifuId))
          .returning();
        return updated!;
      });
    },

    // ────────────────────────────── buddy ──────────────────────────────
    async setBuddy(playerId, waifuId) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(playerWaifus)
          .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
          .for('update');
        if (!locked) throw new WaifuNotOwnedError(waifuId);
        if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
        const [speciesRow] = await tx
          .select()
          .from(species)
          .where(eq(species.id, locked.speciesId));
        if (!speciesRow) throw new WaifuNotOwnedError(waifuId);
        const [updatedPlayer] = await tx
          .update(players)
          .set({ buddyWaifuId: waifuId })
          .where(eq(players.id, playerId))
          .returning();
        return { player: updatedPlayer!, buddy: { waifu: locked, species: speciesRow } };
      });
    },

    async clearBuddy(playerId) {
      const [row] = await db
        .update(players)
        .set({ buddyWaifuId: null })
        .where(eq(players.id, playerId))
        .returning();
      return row!;
    },

    async getBuddy(playerId) {
      const [player] = await db
        .select({ buddyWaifuId: players.buddyWaifuId })
        .from(players)
        .where(eq(players.id, playerId));
      if (!player?.buddyWaifuId) return null;
      const [row] = await db
        .select({ waifu: playerWaifus, species })
        .from(playerWaifus)
        .innerJoin(species, eq(playerWaifus.speciesId, species.id))
        .where(
          and(
            eq(playerWaifus.id, player.buddyWaifuId),
            eq(playerWaifus.playerId, playerId),
          ),
        );
      // If the buddy row was somehow soft-released out from under the FK-less
      // pointer, treat it as no buddy (application-level self-heal).
      if (!row || row.waifu.releasedAt != null) return null;
      return row;
    },

    async resolveActiveBuddy(tx, playerId) {
      const [player] = await tx
        .select({ buddyWaifuId: players.buddyWaifuId })
        .from(players)
        .where(eq(players.id, playerId));
      const buddyId = player?.buddyWaifuId;
      if (!buddyId) return null;
      const [row] = await tx
        .select({ waifu: playerWaifus, species })
        .from(playerWaifus)
        .innerJoin(species, eq(playerWaifus.speciesId, species.id))
        .where(and(eq(playerWaifus.id, buddyId), eq(playerWaifus.playerId, playerId)));
      if (!row || row.waifu.releasedAt != null) {
        // Same self-heal as awardBuddyOnHunt — drop the dangling pointer so the
        // player isn't stuck with an invisible buddy.
        await tx.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
        return null;
      }
      return row;
    },

    // ─────────────────── individual waifu progression ──────────────────
    waifuXpToNext,
    waifuLevelFromXp,
    waifuProgress: waifuProgressPayload,

    async investEssence(playerId, waifuId /* now unused */) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(playerWaifus)
          .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
          .for('update');
        if (!locked) throw new WaifuNotOwnedError(waifuId);
        if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);

        const cost = waifuConfig.essenceInvestment.essenceCost;
        const grant = waifuConfig.essenceInvestment.xpGranted;

        // Lock + conditionally spend the currency row (matches the shop path).
        await currency.lockCurrencies(tx, playerId);
        const balance = await currency.spendEssence(tx, playerId, cost);

        const fromLevel = locked.level;
        const newTotalXp = locked.xp + grant;
        const newLevel = waifuLevelFromXp(newTotalXp);
        const [updated] = await tx
          .update(playerWaifus)
          .set({ xp: newTotalXp, level: newLevel })
          .where(eq(playerWaifus.id, waifuId))
          .returning();

        const newAppearances = await syncAppearances(tx, updated!, fromLevel);

        return {
          waifu: updated!,
          essenceSpent: cost,
          xpGranted: grant,
          fromLevel,
          toLevel: newLevel,
          essenceBalanceAfter: balance.essence,
          newAppearances,
        };
      });
    },

    async setNickname(playerId, waifuId, nickname) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(playerWaifus)
          .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
          .for('update');
        if (!locked) throw new WaifuNotOwnedError(waifuId);
        if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
        if (locked.level < waifuConfig.nicknameMinLevel) {
          throw new WaifuNicknameTooEarlyError(waifuConfig.nicknameMinLevel);
        }
        const trimmed = nickname?.trim() ?? '';
        const nextNickname = trimmed.length === 0 ? null : trimmed.slice(0, 32);
        const [updated] = await tx
          .update(playerWaifus)
          .set({ nickname: nextNickname })
          .where(eq(playerWaifus.id, waifuId))
          .returning();
        return updated!;
      });
    },

    async awardBuddyOnHunt(tx, playerId) {
      const xpDelta = waifuConfig.buddy.xpPerHunt;
      const affDelta = waifuConfig.buddy.affectionPerHunt;
      if (xpDelta <= 0 && affDelta <= 0) return null;
      const [player] = await tx
        .select({ buddyWaifuId: players.buddyWaifuId })
        .from(players)
        .where(eq(players.id, playerId));
      const buddyId = player?.buddyWaifuId;
      if (!buddyId) return null;
      const [locked] = await tx
        .select()
        .from(playerWaifus)
        .where(and(eq(playerWaifus.id, buddyId), eq(playerWaifus.playerId, playerId)))
        .for('update');
      // Buddy vanished (e.g. released before the buddy pointer was cleared);
      // clear the pointer defensively and skip the award.
      if (!locked || locked.releasedAt != null) {
        await tx
          .update(players)
          .set({ buddyWaifuId: null })
          .where(eq(players.id, playerId));
        return null;
      }
      const fromLevel = locked.level;
      const newTotalXp = locked.xp + xpDelta;
      const newLevel = waifuLevelFromXp(newTotalXp);
      const newAffection = locked.affection + affDelta;
      const [updated] = await tx
        .update(playerWaifus)
        .set({ xp: newTotalXp, level: newLevel, affection: newAffection })
        .where(eq(playerWaifus.id, buddyId))
        .returning();
      const newAppearances = await syncAppearances(tx, updated!, fromLevel);

      return {
        waifu: updated!,
        xpGranted: xpDelta,
        affectionGranted: affDelta,
        fromLevel,
        toLevel: newLevel,
        newAppearances,
      };
    },
  };
}
