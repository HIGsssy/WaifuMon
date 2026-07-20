/**
 * QuestService (Milestone 5C) — Daily Quests.
 *
 * Each calendar day (in the configured timezone) a player is assigned
 * `questsPerDay` quests, drawn from the pool with weighted-random selection.
 * Assignment freezes each quest's title/description/rewards on the row so
 * later config edits don't rewrite already-issued quests.
 *
 * Event recording is transactional: `recordQuestEvent(tx, ...)` is invoked
 * inside the same transaction as the gameplay action, so a rollback of the
 * action also rolls back the quest progress. Progress clamps at target;
 * repeated events after completion are no-ops. Completing sets `completed_at`;
 * `claimAllCompleted` pays out and stamps `claimed_at` — the row's uniqueness
 * (`player_id + quest_date + quest_slug`) plus a conditional `claimed_at IS
 * NULL` guard makes double-claim impossible even under concurrent clicks.
 *
 * The all-quests-complete bonus is tracked on a sentinel row with
 * `quest_slug = '__all_complete_bonus__'` — created lazily on first claim
 * that clears the last quest, so it needs no extra column on `players`.
 */
import { and, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  ALL_COMPLETE_BONUS_SLUG,
  items,
  playerDailyQuests,
  type ItemRow,
  type PlayerDailyQuestRow,
  type Rarity,
} from '../../db/schema';
import { ItemNotFoundError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, rollWeighted, type Rng } from '../../shared/random';
import { claimDateInTimezone } from '../../shared/time';
import { rarityAtLeast } from '../capture/captureMath';
import type {
  DailyQuestsConfig,
  QuestEventType,
  QuestPoolEntry,
  QuestRewards,
} from '../content/schemas';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';

export interface QuestEventContext {
  /** Rarity of the captured species, when relevant. */
  rarity?: Rarity;
}

export interface RewardGrant {
  waifubux: number;
  essence: number;
  items: Array<{ item: ItemRow; quantity: number }>;
}

export interface QuestClaimResult {
  claimed: PlayerDailyQuestRow[];
  /** Rewards from the claimed quests only (excludes the all-complete bonus). */
  questRewards: RewardGrant;
  /** Grand total: quest rewards plus the all-complete bonus when granted. */
  totalRewards: RewardGrant;
  allCompleteBonusGranted: boolean;
  allCompleteBonusRewards: RewardGrant | null;
}

export interface QuestService {
  readonly config: DailyQuestsConfig;

  /**
   * Ensure the player has a full set of daily quests for `now`'s calendar
   * date. Idempotent: repeated calls the same day return the existing rows
   * without re-rolling. Never overwrites a quest already in progress.
   */
  ensureDailyQuests(playerId: number, now?: Date): Promise<PlayerDailyQuestRow[]>;

  /**
   * Read today's assigned quest rows (does not create any). Excludes the
   * all-complete bonus sentinel row.
   */
  getDailyQuests(playerId: number, now?: Date): Promise<PlayerDailyQuestRow[]>;

  /**
   * Record a gameplay event that advances any matching in-progress quest.
   * Callable inside an existing transaction (`tx`) or standalone. Blocked
   * interactions must NOT call this — the dispatcher's guard runs first.
   */
  recordQuestEvent(
    tx: DbOrTx | null,
    playerId: number,
    eventType: QuestEventType,
    amount: number,
    context?: QuestEventContext,
    now?: Date,
  ): Promise<void>;

  /**
   * Pay out every completed-but-unclaimed quest for today, plus the
   * all-complete bonus if all today's quests are now claimed. Transactional
   * and safe under double-click.
   */
  claimAllCompleted(playerId: number, now?: Date): Promise<QuestClaimResult>;

  /**
   * Whether today's all-complete bonus has already been granted (the
   * sentinel row exists). Used by the UI to keep the bonus visibly claimed.
   */
  hasClaimedAllCompleteBonus(playerId: number, now?: Date): Promise<boolean>;
}

export interface QuestServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  config: DailyQuestsConfig;
  timezone: string;
  logger: Logger;
  rng?: Rng;
}

interface FrozenQuest {
  slug: string;
  title: string;
  description: string;
  type: QuestEventType;
  rarityAtLeast: Rarity | null;
  target: number;
  rewards: QuestRewards;
}

function freezeEntry(entry: QuestPoolEntry): FrozenQuest {
  return {
    slug: entry.slug,
    title: entry.title,
    description: entry.description,
    type: entry.type,
    rarityAtLeast: entry.rarityAtLeast ?? null,
    target: entry.target,
    rewards: entry.rewards,
  };
}

/**
 * Parse the frozen rewards JSON off a row into a typed rewards struct.
 * Defensive: missing fields default to empty so a bad row can't crash the UI.
 */
export function parseQuestRewards(raw: unknown): QuestRewards {
  const r = (raw ?? {}) as Record<string, unknown>;
  const waifubux = typeof r.waifubux === 'number' && Number.isFinite(r.waifubux) ? r.waifubux : 0;
  const essence = typeof r.essence === 'number' && Number.isFinite(r.essence) ? r.essence : 0;
  const items: Array<{ slug: string; quantity: number }> = Array.isArray(r.items)
    ? r.items
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i) => ({
          slug: typeof i.slug === 'string' ? i.slug : '',
          quantity:
            typeof i.quantity === 'number' && Number.isFinite(i.quantity)
              ? Math.max(0, Math.floor(i.quantity))
              : 0,
        }))
        .filter((i) => i.slug.length > 0 && i.quantity > 0)
    : [];
  return { waifubux, essence, items } as QuestRewards;
}

function pickWeighted<T>(entries: readonly { weight: number; value: T }[], rng: Rng): T {
  return rollWeighted(entries, rng);
}
export function createQuestService(deps: QuestServiceDeps): QuestService {
  const { db, currency, inventory, config, timezone, logger } = deps;
  const rng = deps.rng ?? defaultRng();

  function today(now: Date): string {
    return claimDateInTimezone(now, timezone);
  }

  /** Weighted-random pick of N distinct pool entries. */
  function selectQuests(count: number): FrozenQuest[] {
    if (config.pool.length === 0) return [];
    const available = config.pool.slice();
    const picked: QuestPoolEntry[] = [];
    const n = Math.min(count, available.length);
    for (let i = 0; i < n; i++) {
      const entries = available.map((e) => ({ weight: e.weight, value: e }));
      const chosen = pickWeighted(entries, rng);
      picked.push(chosen);
      const idx = available.indexOf(chosen);
      if (idx >= 0) available.splice(idx, 1);
    }
    return picked.map(freezeEntry);
  }

  async function loadItemRowsBySlug(
    tx: DbOrTx,
    slugs: string[],
  ): Promise<Map<string, ItemRow>> {
    if (slugs.length === 0) return new Map();
    // small N — a single fetch is fine.
    const rows = await tx.select().from(items);
    const bySlug = new Map<string, ItemRow>();
    for (const r of rows) if (slugs.includes(r.slug)) bySlug.set(r.slug, r);
    return bySlug;
  }

  /**
   * Grant a rewards bundle inside an open transaction. Returns the resolved
   * grant (with item rows) for reporting.
   */
  async function grantRewards(
    tx: DbOrTx,
    playerId: number,
    rewards: QuestRewards,
  ): Promise<RewardGrant> {
    await currency.lockCurrencies(tx, playerId);
    if (rewards.waifubux > 0) {
      await currency.grantWaifubux(tx, playerId, rewards.waifubux);
    }
    if (rewards.essence > 0) {
      await currency.grantEssence(tx, playerId, rewards.essence);
    }
    const slugs = rewards.items.map((i) => i.slug);
    const bySlug = await loadItemRowsBySlug(tx, slugs);
    const granted: Array<{ item: ItemRow; quantity: number }> = [];
    for (const ri of rewards.items) {
      const item = bySlug.get(ri.slug);
      if (!item) {
        // Frozen snapshot references a slug the DB doesn't have. Throwing
        // rolls the whole claim transaction back, so the quest stays
        // unclaimed rather than silently losing part of its rewards.
        // Should be impossible if seed matches content (loader validates).
        logger.error({ slug: ri.slug }, 'quest reward references unknown item slug — claim aborted');
        throw new ItemNotFoundError(ri.slug);
      }
      await inventory.addItem(tx, playerId, item.id, ri.quantity);
      granted.push({ item, quantity: ri.quantity });
    }
    return {
      waifubux: rewards.waifubux,
      essence: rewards.essence,
      items: granted,
    };
  }

  async function ensureDailyQuests(
    playerId: number,
    now: Date = new Date(),
  ): Promise<PlayerDailyQuestRow[]> {
    if (!config.enabled || config.pool.length === 0) return [];
    const questDate = today(now);
    // Fast path: already assigned.
    const existing = await db
      .select()
      .from(playerDailyQuests)
      .where(
        and(
          eq(playerDailyQuests.playerId, playerId),
          eq(playerDailyQuests.questDate, questDate),
          ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
        ),
      );
    if (existing.length >= Math.min(config.questsPerDay, config.pool.length)) {
      return existing;
    }
    // Assign inside a transaction — unique constraint serializes concurrent
    // callers. ON CONFLICT DO NOTHING makes repeated ensures idempotent.
    const frozen = selectQuests(config.questsPerDay);
    if (frozen.length < config.questsPerDay) {
      logger.warn(
        { pool: config.pool.length, questsPerDay: config.questsPerDay },
        'dailyQuests pool smaller than questsPerDay — assigning as many as possible',
      );
    }
    return db.transaction(async (tx) => {
      for (const q of frozen) {
        await tx
          .insert(playerDailyQuests)
          .values({
            playerId,
            questDate,
            questSlug: q.slug,
            titleSnapshot: q.title,
            descriptionSnapshot: q.description,
            type: q.type,
            rarityAtLeast: q.rarityAtLeast,
            target: q.target,
            progress: 0,
            rewardsJson: q.rewards as unknown as Record<string, unknown>,
          })
          .onConflictDoNothing({
            target: [
              playerDailyQuests.playerId,
              playerDailyQuests.questDate,
              playerDailyQuests.questSlug,
            ],
          });
      }
      const rows = await tx
        .select()
        .from(playerDailyQuests)
        .where(
          and(
            eq(playerDailyQuests.playerId, playerId),
            eq(playerDailyQuests.questDate, questDate),
            ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
          ),
        );
      return rows;
    });
  }

  async function getDailyQuests(
    playerId: number,
    now: Date = new Date(),
  ): Promise<PlayerDailyQuestRow[]> {
    const questDate = today(now);
    return db
      .select()
      .from(playerDailyQuests)
      .where(
        and(
          eq(playerDailyQuests.playerId, playerId),
          eq(playerDailyQuests.questDate, questDate),
          ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
        ),
      );
  }

  /**
   * Core progress writer — called with a transaction handle. `poolTypesActive`
   * is derived from `type`/`rarityAtLeast` matching. Advances progress up to
   * `target` and stamps `completed_at` when the target is reached.
   */
  async function advanceProgress(
    tx: DbOrTx,
    playerId: number,
    questDate: string,
    eventType: QuestEventType,
    amount: number,
    context: QuestEventContext,
    at: Date,
  ): Promise<void> {
    if (amount <= 0) return;
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) return;

    // Load in-progress quests for today matching this event type.
    const rows = await tx
      .select()
      .from(playerDailyQuests)
      .where(
        and(
          eq(playerDailyQuests.playerId, playerId),
          eq(playerDailyQuests.questDate, questDate),
          eq(playerDailyQuests.type, eventType),
          isNull(playerDailyQuests.completedAt),
          ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
        ),
      )
      .for('update');
    if (rows.length === 0) return;

    for (const row of rows) {
      // Rarity-at-least gate.
      if (row.rarityAtLeast) {
        if (!context.rarity) continue;
        if (!rarityAtLeast(context.rarity, row.rarityAtLeast as Rarity)) continue;
      }
      const nextProgress = Math.min(row.target, row.progress + amount);
      if (nextProgress === row.progress) continue;
      const completed = nextProgress >= row.target;
      await tx
        .update(playerDailyQuests)
        .set({
          progress: nextProgress,
          completedAt: completed ? at : row.completedAt,
          updatedAt: at,
        })
        .where(
          and(
            eq(playerDailyQuests.id, row.id),
            // Guard against a concurrent writer completing first.
            lt(playerDailyQuests.progress, row.target),
          ),
        );
    }
  }

  async function recordQuestEvent(
    tx: DbOrTx | null,
    playerId: number,
    eventType: QuestEventType,
    amount: number,
    context: QuestEventContext = {},
    now: Date = new Date(),
  ): Promise<void> {
    if (!config.enabled) return;
    if (amount <= 0) return;
    const questDate = today(now);
    if (tx) {
      await advanceProgress(tx, playerId, questDate, eventType, amount, context, now);
      return;
    }
    await db.transaction((tx2) =>
      advanceProgress(tx2, playerId, questDate, eventType, amount, context, now),
    );
  }

  async function claimAllCompleted(
    playerId: number,
    now: Date = new Date(),
  ): Promise<QuestClaimResult> {
    const questDate = today(now);
    return db.transaction(async (tx) => {
      // Lock every completed-unclaimed quest row for this day.
      const readyRows = await tx
        .select()
        .from(playerDailyQuests)
        .where(
          and(
            eq(playerDailyQuests.playerId, playerId),
            eq(playerDailyQuests.questDate, questDate),
            isNotNull(playerDailyQuests.completedAt),
            isNull(playerDailyQuests.claimedAt),
            ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
          ),
        )
        .for('update');

      const questRewards: RewardGrant = { waifubux: 0, essence: 0, items: [] };
      const claimed: PlayerDailyQuestRow[] = [];

      for (const row of readyRows) {
        // Conditional stamp: another concurrent claim can't double-pay.
        const [stamped] = await tx
          .update(playerDailyQuests)
          .set({ claimedAt: now, updatedAt: now })
          .where(and(eq(playerDailyQuests.id, row.id), isNull(playerDailyQuests.claimedAt)))
          .returning();
        if (!stamped) continue;
        const rewards = parseQuestRewards(row.rewardsJson);
        const grant = await grantRewards(tx, playerId, rewards);
        questRewards.waifubux += grant.waifubux;
        questRewards.essence += grant.essence;
        questRewards.items.push(...grant.items);
        claimed.push(stamped);
      }

      // All-complete bonus: every real assigned quest is claimed AND no
      // sentinel row has been created yet.
      let allCompleteBonusGranted = false;
      let allCompleteBonusRewards: RewardGrant | null = null;
      if (config.allCompleteBonus) {
        const remaining = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(playerDailyQuests)
          .where(
            and(
              eq(playerDailyQuests.playerId, playerId),
              eq(playerDailyQuests.questDate, questDate),
              ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
              isNull(playerDailyQuests.claimedAt),
            ),
          );
        const remainingCount = remaining[0]?.count ?? 0;
        const totalToday = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(playerDailyQuests)
          .where(
            and(
              eq(playerDailyQuests.playerId, playerId),
              eq(playerDailyQuests.questDate, questDate),
              ne(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
            ),
          );
        const totalTodayCount = totalToday[0]?.count ?? 0;
        if (totalTodayCount > 0 && remainingCount === 0) {
          // Try to insert the sentinel row — uniqueness serializes concurrent
          // callers; only the first insert grants the bonus.
          const inserted = await tx
            .insert(playerDailyQuests)
            .values({
              playerId,
              questDate,
              questSlug: ALL_COMPLETE_BONUS_SLUG,
              titleSnapshot: 'All Quests Complete',
              descriptionSnapshot: 'Bonus for completing every daily quest.',
              type: 'capture_success', // sentinel type — never event-matched
              target: 1,
              progress: 1,
              rewardsJson: config.allCompleteBonus as unknown as Record<string, unknown>,
              completedAt: now,
              claimedAt: now,
            })
            .onConflictDoNothing({
              target: [
                playerDailyQuests.playerId,
                playerDailyQuests.questDate,
                playerDailyQuests.questSlug,
              ],
            })
            .returning();
          if (inserted.length > 0) {
            allCompleteBonusRewards = await grantRewards(
              tx,
              playerId,
              config.allCompleteBonus,
            );
            allCompleteBonusGranted = true;
          }
        }
      }

      const totalRewards: RewardGrant = {
        waifubux: questRewards.waifubux + (allCompleteBonusRewards?.waifubux ?? 0),
        essence: questRewards.essence + (allCompleteBonusRewards?.essence ?? 0),
        items: [...questRewards.items, ...(allCompleteBonusRewards?.items ?? [])],
      };
      return {
        claimed,
        questRewards,
        totalRewards,
        allCompleteBonusGranted,
        allCompleteBonusRewards,
      };
    });
  }

  async function hasClaimedAllCompleteBonus(
    playerId: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const questDate = today(now);
    const [row] = await db
      .select({ id: playerDailyQuests.id })
      .from(playerDailyQuests)
      .where(
        and(
          eq(playerDailyQuests.playerId, playerId),
          eq(playerDailyQuests.questDate, questDate),
          eq(playerDailyQuests.questSlug, ALL_COMPLETE_BONUS_SLUG),
        ),
      )
      .limit(1);
    return row != null;
  }

  return {
    config,
    ensureDailyQuests,
    getDailyQuests,
    recordQuestEvent,
    claimAllCompleted,
    hasClaimedAllCompleteBonus,
  };
}

/** Snapshot type poolBySlug isn't used externally — dropped intentionally. */
export type { PlayerDailyQuestRow } from '../../db/schema';
