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
import type { AppliedBuddyBonus } from '../buddyBonus/buddyBonusEffects';
import {
  createEssenceAwardService,
  type EssenceAwardService,
} from '../currency/essenceAwardService';
import type { InventoryService } from '../inventory/inventoryService';

export interface QuestEventContext {
  /** Rarity of the captured species, when relevant. */
  rarity?: Rarity;
}

export interface RewardGrant {
  waifubux: number;
  /**
   * Essence **actually granted** — after the `essence_gain` Buddy Bonus. This
   * is the number a result screen prints, and it is what the player's balance
   * moved by.
   */
  essence: number;
  /**
   * The authored Essence, before any bonus. Equal to {@link essence} when no
   * bonus applied, so a surface can show `Base: 40` only when it differs.
   */
  essenceBase: number;
  /**
   * Set only when the bonus actually raised the Essence. On an aggregate
   * (`totalRewards`, or a multi-quest claim) `baseValue` / `finalValue` are
   * the aggregate figures, so a summary line stays arithmetically honest.
   *
   * Only Essence is affected: a quest's Waifubux and items are untouched by
   * `essence_gain`, which is a modifier on Essence awards and nothing else.
   */
  essenceBonus: AppliedBuddyBonus | null;
  items: Array<{ item: ItemRow; quantity: number }>;
}

/**
 * Sum two grants' Essence and carry the bonus onto the total.
 *
 * Both operands come from the same player in the same transaction, so at most
 * one distinct bonus can be in play; whichever side has it describes the pair,
 * restated against the combined figures.
 */
function mergeEssence(
  a: { essence: number; essenceBase: number; essenceBonus: AppliedBuddyBonus | null },
  b: { essence: number; essenceBase: number; essenceBonus: AppliedBuddyBonus | null } | null,
): Pick<RewardGrant, 'essence' | 'essenceBase' | 'essenceBonus'> {
  const essence = a.essence + (b?.essence ?? 0);
  const essenceBase = a.essenceBase + (b?.essenceBase ?? 0);
  const source = a.essenceBonus ?? b?.essenceBonus ?? null;
  return {
    essence,
    essenceBase,
    essenceBonus:
      source && essence > essenceBase
        ? { ...source, baseValue: essenceBase, finalValue: essence }
        : null,
  };
}

/**
 * One authored reward bundle, quoted against the player's **current** Buddy.
 *
 * The pre-claim counterpart to {@link RewardGrant}, and deliberately the same
 * field names: a board that quotes `essence` and a claim that reports
 * `essence` are talking about the same number, so a surface can render either
 * without knowing which it holds.
 *
 * **Not authoritative.** The player may equip a different Buddy between
 * reading the board and pressing Claim, and `claimAllCompleted` re-resolves at
 * that moment. That is correct: this describes the reward as it stands now,
 * not a promise about later. Nothing here is cached or persisted, and the
 * authored `rewardsJson` it was derived from is never touched.
 */
export interface QuestRewardsPreview {
  waifubux: number;
  /** Essence the player would receive right now, after `essence_gain`. */
  essence: number;
  /** The authored Essence, before any bonus. Equal to {@link essence} when none applies. */
  essenceBase: number;
  /** Set only when the current Buddy would actually raise the Essence. */
  essenceBonus: AppliedBuddyBonus | null;
  /** Untouched: `essence_gain` scales Essence and nothing else. */
  items: readonly { slug: string; quantity: number }[];
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

  /**
   * Quote authored reward bundles against the player's current Buddy, for the
   * screens shown **before** a claim. Reads only — no row is written, no
   * balance moves, no quest state changes.
   *
   * Takes a list rather than one bundle for two reasons, and the second is the
   * important one:
   *
   *   - the Buddy is resolved once for the whole board rather than once per
   *     quest;
   *   - each bundle is still scaled and rounded **on its own**, which is what
   *     the claim does. A board showing a 5-Essence quest and a 5-Essence
   *     all-complete bonus at +10% must quote 6 and 6 — because the claim pays
   *     two separate awards — not preview their combined 10 as 11.
   *
   * Returns one preview per input, index-aligned.
   */
  previewRewards(
    playerId: number,
    rewards: readonly QuestRewards[],
  ): Promise<QuestRewardsPreview[]>;
}

export interface QuestServiceDeps {
  db: Db;
  currency: CurrencyService;
  /**
   * The shared gameplay Essence award path, so a Daily Quest reward pays the
   * `essence_gain` Buddy Bonus that a hunt find and a duplicate conversion
   * already do.
   *
   * Deliberately this rather than a `BuddyBonusService`: quests have no
   * business knowing what a Buddy Bonus is or how a percentage is applied.
   * They know they owe the player some Essence, and they hand that to the one
   * service that owns what "owing a player Essence" means.
   *
   * Optional only so hand-built fixtures keep working: when omitted one is
   * constructed from `currency`, which grants the authored amount exactly —
   * identical to the pre-existing behaviour.
   */
  essenceAward?: EssenceAwardService | undefined;
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
  const essenceAward = deps.essenceAward ?? createEssenceAwardService({ currency });
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
    // Both the per-quest claim and the all-complete bonus come through this
    // one helper, so migrating it covers both Essence reward paths at once.
    const essenceAwarded =
      rewards.essence > 0
        ? await essenceAward.awardEssence(tx, playerId, rewards.essence)
        : null;
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
      // What actually landed, not what the frozen snapshot authored — a
      // result screen prints this number. `essenceBase` carries the authored
      // figure alongside it so the uplift can be shown without arithmetic.
      essence: essenceAwarded?.essenceGranted ?? rewards.essence,
      essenceBase: rewards.essence,
      essenceBonus: essenceAwarded?.bonus ?? null,
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

      const questRewards: RewardGrant = {
        waifubux: 0,
        essence: 0,
        essenceBase: 0,
        essenceBonus: null,
        items: [],
      };
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
        Object.assign(questRewards, mergeEssence(questRewards, grant));
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
        ...mergeEssence(questRewards, allCompleteBonusRewards),
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

  /**
   * Read-only quote of authored bundles against the live Buddy.
   *
   * Every Essence figure comes from `essenceAward.previewEssenceMany`, which
   * is the same modifier logic `awardEssence` runs at claim time — this
   * function contains no percentage, no rounding and no Buddy lookup of its
   * own. Waifubux and items are passed through untouched: `essence_gain`
   * scales Essence and nothing else.
   */
  async function previewRewards(
    playerId: number,
    rewards: readonly QuestRewards[],
  ): Promise<QuestRewardsPreview[]> {
    // One batch call, so the Buddy is resolved once — but each base amount is
    // still scaled on its own inside it, matching per-award claim rounding.
    const previews = await essenceAward.previewEssenceMany(
      db,
      playerId,
      rewards.map((r) => r.essence),
    );
    return rewards.map((r, i) => {
      const preview = previews[i]!;
      return {
        waifubux: r.waifubux,
        essence: preview.finalAmount,
        essenceBase: preview.baseAmount,
        essenceBonus: preview.bonus,
        items: r.items,
      };
    });
  }

  return {
    config,
    ensureDailyQuests,
    getDailyQuests,
    recordQuestEvent,
    claimAllCompleted,
    hasClaimedAllCompleteBonus,
    previewRewards,
  };
}

/** Snapshot type poolBySlug isn't used externally — dropped intentionally. */
export type { PlayerDailyQuestRow } from '../../db/schema';
