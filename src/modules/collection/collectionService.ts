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
  buildGroupedView,
  filterCopiesByLevel,
  type CollectionSortBy,
  type GroupedView,
} from './collectionGrouping';
import {
  NotADuplicateError,
  WaifuAlreadyReleasedError,
  WaifuAtMaxLevelError,
  WaifuIsBuddyError,
  WaifuIsFavoriteError,
  WaifuNicknameTooEarlyError,
  WaifuNotOwnedError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { QuestService } from '../quests/questService';
import {
  appliedBuddyBonus,
  applyPercentModifierInt,
  buddyBonusPercent,
  type AppliedBuddyBonus,
} from '../buddyBonus/buddyBonusEffects';
import type { BuddyBonusService } from '../buddyBonus/buddyBonusService';

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
  /** Distinct species among active owned Waifumon — duplicates count once. */
  distinctSpecies: number;
  /**
   * Every enabled species in the database right now: the base set plus every
   * enabled expansion pack, minus anything disabled. Read live, so enabling a
   * pack moves it without a restart.
   */
  totalSpecies: number;
}

export interface ReleaseResult {
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
  essenceGranted: number;
  /** Set only when `essence_gain` actually raised `essenceGranted`. */
  essenceBonus: AppliedBuddyBonus | null;
  balanceAfter: number;
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
  rarity?: Rarity;
}

/**
 * Filters for the grouped Discord collection browser. `name` matches species
 * name *or* nickname (substring, case-insensitive); the level range narrows
 * individual copies before grouping; `minCopies` is applied to the surviving
 * copy count after grouping. See `collectionGrouping.buildGroupedView`.
 */
export interface GroupedListOptions {
  name?: string | null;
  minLevel?: number | null;
  maxLevel?: number | null;
  minCopies?: number | null;
  sortBy?: CollectionSortBy;
  page?: number;
  pageSize?: number;
}

/** A page of species groups, plus the totals needed for the page indicator. */
export type PaginatedGroups = GroupedView;

/** Level narrowing for a single species' copies (duplicate selector). */
export interface CopyFilterOptions {
  minLevel?: number | null;
  maxLevel?: number | null;
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
  /** How many applications of the base action this call performed. */
  applications: number;
  /** Total Essence consumed: `applications × essenceInvestment.essenceCost`. */
  essenceSpent: number;
  /** Total XP granted: `applications × essenceInvestment.xpGranted`. */
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
  /** Set only when `buddy_xp_gain` actually raised `xpGranted`. */
  xpBonus: AppliedBuddyBonus | null;
  /** Set only when `affection_gain` actually raised `affectionGranted`. */
  affectionBonus: AppliedBuddyBonus | null;
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
  /**
   * True iff the player has at least one active (non-released) copy of the
   * given species. Read-only — the hunt encounter uses it to decide whether
   * to show the CAUGHT duplicate-warning badge *before* charms are spent.
   */
  hasActiveSpeciesCopy(playerId: number, speciesId: number): Promise<boolean>;
  /** Substring match on nickname/species name, active copies only. */
  searchByName(playerId: number, query: string, limit?: number): Promise<OwnedEntry[]>;
  /**
   * Grouped, filtered, sorted view of the player's active copies — one entry
   * per species, carrying its individual copies. Backs the Discord collection
   * browser; `listOwned` is left alone for the HTTP API's flat contract.
   */
  listOwnedGrouped(playerId: number, opts?: GroupedListOptions): Promise<PaginatedGroups>;
  /**
   * Every active copy of one species the player owns, for the duplicate
   * selector. Returns the individual rows — nothing is merged.
   */
  listOwnedCopiesForSpecies(
    playerId: number,
    speciesId: number,
    opts?: CopyFilterOptions,
  ): Promise<OwnedEntry[]>;
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
   * Apply the essence investment `applications` times in **one** transaction:
   * one balance check, one spend, one XP write, one appearance sync. Either
   * the whole batch lands or none of it does — a 10× can never half-apply.
   *
   * Semantics are exactly N applications of `investEssence`, not a new curve:
   * cost is `applications × essenceCost` and XP is `applications × xpGranted`.
   * `investEssence` is this method at `applications = 1`.
   *
   * Throws `WaifuAtMaxLevelError` when the copy is already capped (the 1× path
   * historically spent anyway; the UI disables the buttons there), and
   * `InsufficientEssenceError` when the full batch is unaffordable.
   */
  investEssenceBatch(
    playerId: number,
    waifuId: number,
    applications: number,
  ): Promise<WaifuInvestResult>;
  /**
   * How many applications still convert into levels for this copy — 0 once she
   * is capped. The last application may overshoot, exactly as a 1× does.
   */
  maxUsefulApplications(waifu: PlayerWaifuRow): number;
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
  /**
   * Grant XP to **one named owned copy**, inside the caller's transaction.
   *
   * The buddy-agnostic sibling of {@link awardBuddyOnHunt}, added for boss
   * encounters: a participation names the exact copy that fought at commitment
   * time, and she must receive the XP even if the player has since pointed
   * `buddy_waifu_id` at somebody else. Reading the *current* buddy here would
   * pay the wrong Waifumon an hour later.
   *
   * Returns `null` when the copy is missing or soft-released — a caller
   * records zero XP rather than treating it as an error, because a released
   * copy is gone and the participation's other rewards are still owed. Never
   * clears any buddy pointer: this function has no opinion about who the buddy
   * is, so it must not touch that field.
   *
   * `xpDelta` of 0 is a legal no-op (a max-level buddy), and returns null
   * without locking anything.
   */
  awardWaifuXp(
    tx: DbOrTx,
    playerId: number,
    waifuId: number,
    xpDelta: number,
  ): Promise<BuddyAwardResult | null>;
}

export interface CollectionServiceDeps {
  db: Db;
  currency: CurrencyService;
  quests: QuestService;
  duplicateConfig: DuplicateConfig;
  waifuConfig: WaifuProgressionConfig;
  /**
   * Cosmetic appearance bookkeeping. **Optional**, and deliberately one-way:
   * this service calls into it after a level changes so the player is told
   * about newly-earned artwork, and it never reads anything back that affects
   * gameplay. Omitting it (as older tests do) simply means no unlock toasts.
   */
  appearance?: AppearanceService | undefined;
  /**
   * Active Buddy Bonus lookup. Optional — without it the buddy's hunt award and
   * the release/convert Essence payout are exactly what content configures.
   */
  buddyBonus?: BuddyBonusService | undefined;
}

const DEFAULT_PAGE_SIZE = 10;
/**
 * Ceiling on one batched Essence investment. Not an economy rule — a blast
 * radius: it bounds what a single mis-typed custom amount can spend.
 */
export const MAX_ESSENCE_APPLICATIONS = 100;
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
  const { db, currency, quests, duplicateConfig, waifuConfig } = deps;
  const appearance = deps.appearance;
  const buddyBonus = deps.buddyBonus;

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

  /**
   * Dex progress: copies held, unique species held, and the denominator.
   *
   * **The denominator is counted live, from `species`.** It used to be a number
   * handed in at construction, computed once from the content snapshot the
   * process booted with — so a pack enabled by an admin Reload Content, or any
   * species added after boot, was collectable but never counted, and every
   * profile showed the launch total until someone restarted the bot.
   *
   * `species.enabled` is the right predicate because the seeder keeps it
   * honest in both directions: a species authored `enabled: false`, one whose
   * artwork went missing, and every species belonging to a pack that is
   * switched off (dropped from the content set, then disabled by slug) all
   * land as disabled rows. So "enabled row" means exactly "canonical species a
   * player can currently obtain".
   *
   * Counted from `species`, never from `region_encounter_pools`: a species may
   * be pooled in several regions, and counting membership rows would inflate
   * the denominator by however many places she can be met.
   *
   * The numerator is `countDistinct(species_id)` over unreleased copies — the
   * dex is about *who* you have caught, so a shelf of duplicates counts once.
   */
  async function getDexStats(playerId: number): Promise<DexStats> {
    const ownedFilter = and(
      eq(playerWaifus.playerId, playerId),
      isNull(playerWaifus.releasedAt),
    );
    const [[owned = { total: 0 }], [distinct = { total: 0 }], [available = { total: 0 }]] =
      await Promise.all([
        db.select({ total: count() }).from(playerWaifus).where(ownedFilter),
        db
          .select({ total: countDistinct(playerWaifus.speciesId) })
          .from(playerWaifus)
          .where(ownedFilter),
        db.select({ total: count() }).from(species).where(eq(species.enabled, true)),
      ]);
    return {
      owned: owned.total,
      distinctSpecies: distinct.total,
      totalSpecies: available.total,
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

  /**
   * Every active copy for one player, narrowed only by the predicates that are
   * cheap and index-friendly in SQL (player, not released, name, species).
   *
   * Deliberately unpaginated: the grouped browser must see *all* matching
   * copies before it can group them, count duplicates, and sort — a LIMIT here
   * would silently truncate a group. Collections are bounded (tens to low
   * hundreds of active copies), so the level/minCopies/sort/page work happens
   * in `collectionGrouping` rather than in a window-function query.
   */
  async function fetchActiveCopies(
    playerId: number,
    opts: { name?: string | null; speciesId?: number } = {},
  ): Promise<OwnedEntry[]> {
    const filters = [eq(playerWaifus.playerId, playerId), isNull(playerWaifus.releasedAt)];
    if (opts.speciesId != null) filters.push(eq(playerWaifus.speciesId, opts.speciesId));
    const q = opts.name?.trim() ?? '';
    if (q.length > 0) {
      // Same name-match construction as `searchByName`.
      const nameMatch = or(ilike(species.name, `%${q}%`), ilike(playerWaifus.nickname, `%${q}%`));
      if (nameMatch) filters.push(nameMatch);
    }
    return db
      .select({ waifu: playerWaifus, species })
      .from(playerWaifus)
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(and(...filters))
      .orderBy(sql`${RARITY_RANK_SQL} desc`, asc(species.name), asc(playerWaifus.id));
  }

  /**
   * Applications that still buy levels. The final one may overshoot the cap —
   * that is what a 1× at the last rung has always done — but a copy already at
   * the cap returns 0, which is what disables the buttons.
   */
  function maxUsefulApplications(waifu: PlayerWaifuRow): number {
    if (waifu.level >= waifuConfig.maxLevel) return 0;
    const needed = waifuCumulativeXp(waifuConfig.maxLevel) - waifu.xp;
    if (needed <= 0) return 0;
    return Math.ceil(needed / waifuConfig.essenceInvestment.xpGranted);
  }

  /**
   * N applications, atomically. The whole batch is priced up front and spent
   * with a single conditional update, so an unaffordable 10× consumes nothing
   * rather than applying the 6 the player could afford.
   *
   * One `syncAppearances` call covers the entire level jump: unlock detection
   * compares the *resulting* level against `seen_appearances`, so a batch that
   * crosses three milestones reports all three, exactly as three separate 1×
   * clicks would have.
   */
  async function investEssenceBatch(
    playerId: number,
    waifuId: number,
    applications: number,
  ): Promise<WaifuInvestResult> {
    if (!Number.isInteger(applications) || applications < 1) {
      throw new RangeError(`Applications must be a positive integer, got ${applications}`);
    }
    if (applications > MAX_ESSENCE_APPLICATIONS) {
      throw new RangeError(
        `Applications must be at most ${MAX_ESSENCE_APPLICATIONS}, got ${applications}`,
      );
    }
    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(playerWaifus)
        .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
        .for('update');
      if (!locked) throw new WaifuNotOwnedError(waifuId);
      if (locked.releasedAt != null) throw new WaifuAlreadyReleasedError(waifuId);
      // Re-checked under the row lock, so a concurrent level-up can't sneak a
      // spend past the UI's disabled buttons.
      if (locked.level >= waifuConfig.maxLevel) {
        throw new WaifuAtMaxLevelError(waifuConfig.maxLevel);
      }

      const cost = waifuConfig.essenceInvestment.essenceCost * applications;
      const grant = waifuConfig.essenceInvestment.xpGranted * applications;

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
        applications,
        essenceSpent: cost,
        xpGranted: grant,
        fromLevel,
        toLevel: newLevel,
        essenceBalanceAfter: balance.essence,
        newAppearances,
      };
    });
  }

  async function listOwnedGrouped(
    playerId: number,
    opts: GroupedListOptions = {},
  ): Promise<PaginatedGroups> {
    const rows = await fetchActiveCopies(playerId, { name: opts.name ?? null });
    return buildGroupedView(rows, {
      minLevel: opts.minLevel ?? null,
      maxLevel: opts.maxLevel ?? null,
      minCopies: opts.minCopies ?? null,
      ...(opts.sortBy ? { sortBy: opts.sortBy } : {}),
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? DEFAULT_PAGE_SIZE,
    });
  }

  async function listOwnedCopiesForSpecies(
    playerId: number,
    speciesId: number,
    opts: CopyFilterOptions = {},
  ): Promise<OwnedEntry[]> {
    const rows = await fetchActiveCopies(playerId, { speciesId });
    return filterCopiesByLevel(rows, opts.minLevel, opts.maxLevel);
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

      // `essence_gain` scales the payout, never the rarity table it comes
      // from: content still decides what a copy is worth, the Buddy decides
      // what the player walks away with.
      const baseEssence = essenceForRarity(speciesRow.rarity, fraction);
      const essenceActive = await buddyBonus?.getActiveBuddyBonus(tx, playerId);
      const essence = applyPercentModifierInt(
        baseEssence,
        buddyBonusPercent(essenceActive?.bonus, 'essence_gain'),
      );
      const essenceBonus =
        essenceActive && essence > baseEssence
          ? appliedBuddyBonus(essenceActive.bonus, { base: baseEssence, final: essence })
          : null;

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
        essenceBonus,
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

  async function hasActiveSpeciesCopy(playerId: number, speciesId: number): Promise<boolean> {
    const [row = { total: 0 }] = await db
      .select({ total: count() })
      .from(playerWaifus)
      .where(
        and(
          eq(playerWaifus.playerId, playerId),
          eq(playerWaifus.speciesId, speciesId),
          isNull(playerWaifus.releasedAt),
        ),
      );
    return row.total > 0;
  }

  return {
    listOwned,
    getDexStats,
    getOwned,
    hasOtherActiveCopies,
    hasActiveSpeciesCopy,
    searchByName,
    listOwnedGrouped,
    listOwnedCopiesForSpecies,
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

    maxUsefulApplications,

    async investEssence(playerId, waifuId /* now unused */) {
      // 1× is the batch of one — one code path, so the two can never drift.
      return investEssenceBatch(playerId, waifuId, 1);
    },

    investEssenceBatch,

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
      // The buddy's own bonus applies to her own award: `buddy_xp_gain` and
      // `affection_gain` are read from whoever is equipped, which is by
      // definition the copy being paid here.
      const active = await buddyBonus?.getActiveBuddyBonus(tx, playerId);
      const baseXp = waifuConfig.buddy.xpPerHunt;
      const baseAffection = waifuConfig.buddy.affectionPerHunt;
      const xpDelta = applyPercentModifierInt(
        baseXp,
        buddyBonusPercent(active?.bonus, 'buddy_xp_gain'),
      );
      const affDelta = applyPercentModifierInt(
        baseAffection,
        buddyBonusPercent(active?.bonus, 'affection_gain'),
      );
      // Reported only where the number actually moved, so a bonus is never
      // announced next to an award it did not change.
      const xpBonus =
        active && xpDelta > baseXp
          ? appliedBuddyBonus(active.bonus, { base: baseXp, final: xpDelta })
          : null;
      const affectionBonus =
        active && affDelta > baseAffection
          ? appliedBuddyBonus(active.bonus, { base: baseAffection, final: affDelta })
          : null;
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
        xpBonus,
        affectionBonus,
      };
    },

    async awardWaifuXp(tx, playerId, waifuId, xpDelta) {
      if (xpDelta <= 0) return null;
      const [locked] = await tx
        .select()
        .from(playerWaifus)
        .where(and(eq(playerWaifus.id, waifuId), eq(playerWaifus.playerId, playerId)))
        .for('update');
      // Released or never owned by this player: nothing to award. Deliberately
      // silent rather than throwing — the caller has other rewards to hand
      // over and a vanished copy is a normal outcome, not a fault.
      if (!locked || locked.releasedAt != null) return null;

      const fromLevel = locked.level;
      const newTotalXp = locked.xp + xpDelta;
      const newLevel = waifuLevelFromXp(newTotalXp);
      const [updated] = await tx
        .update(playerWaifus)
        .set({ xp: newTotalXp, level: newLevel })
        .where(eq(playerWaifus.id, waifuId))
        .returning();
      const newAppearances = await syncAppearances(tx, updated!, fromLevel);

      return {
        waifu: updated!,
        xpGranted: xpDelta,
        affectionGranted: 0,
        fromLevel,
        toLevel: newLevel,
        newAppearances,
        // Boss XP and other direct awards do not go through `buddy_xp_gain` —
        // see `awardBuddyOnHunt`, which is the only path that does.
        xpBonus: null,
        affectionBonus: null,
      };
    },
  };
}
