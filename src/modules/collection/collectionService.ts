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
import type { Db } from '../../db/client';
import {
  playerWaifus,
  species,
  type PlayerWaifuRow,
  type Rarity,
  type SpeciesRow,
} from '../../db/schema';
import type { DuplicateConfig } from '../content/schemas';
import {
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuIsFavoriteError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';

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
   */
  convertDuplicateToEssence(
    playerId: number,
    waifuId: number,
    opts?: ConvertOptions,
  ): Promise<ReleaseResult>;
  /**
   * Manual release from inspect: soft-release + grant `floor(dupEssence ×
   * releaseFraction)`. Favorites require `force=true` (second confirmation).
   */
  releaseWaifu(playerId: number, waifuId: number, opts?: ReleaseOptions): Promise<ReleaseResult>;
  toggleFavorite(playerId: number, waifuId: number): Promise<PlayerWaifuRow>;
}

export interface CollectionServiceDeps {
  db: Db;
  currency: CurrencyService;
  duplicateConfig: DuplicateConfig;
  /** Total enabled species in the content set (dex denominator). */
  totalSpeciesCount: number;
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
  const { db, currency, duplicateConfig, totalSpeciesCount } = deps;

  function essenceForRarity(rarity: string, fraction = 1): number {
    const value = (duplicateConfig.essenceByRarity as Record<string, number>)[rarity] ?? 0;
    return Math.max(0, Math.floor(value * fraction));
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

      // TODO(post-buddy): also block converting/releasing the active buddy
      // once `players.buddy_waifu_id` exists (see plan §14).

      if (requireDuplicate) {
        // Count another active copy of the same species for this player.
        // If the count is zero, this is the only copy — release instead.
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
  };
}
