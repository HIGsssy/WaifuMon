import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { dailyClaims, items, players, type ItemRow } from '../../db/schema';
import {
  AlreadyClaimedError,
  ContentValidationError,
  isUniqueViolation,
} from '../../shared/errors';
import { defaultRng, type Rng } from '../../shared/random';
import { claimDateInTimezone, nextResetAt } from '../../shared/time';
import type { CareService, CareTickSummary } from '../care/careService';
import type {
  AffectionGiftService,
  GiftRollResult,
} from '../gifts/affectionGiftService';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { TablesContent } from '../content/schemas';
import type {
  GrantXpResult,
  LevelUpEvent,
  ProgressionService,
} from '../progression/progressionService';

export interface DailyClaimResult {
  claimDate: string;
  energySetTo: number;
  waifubux: number;
  items: Array<{ item: ItemRow; quantity: number }>;
  nextResetAt: Date;
  xp: GrantXpResult;
  /** Convenience alias for `xp.levelUps`. */
  levelUps: LevelUpEvent[];
  /** True if the level-30 rare-item chance actually fired. */
  rareItemGranted: boolean;
  /**
   * Care Mode pending-tick summary applied inside the daily transaction
   * before the refill. `null` when Care Mode wasn't active. The daily claim
   * always exits Care Mode.
   */
  careExit: CareTickSummary | null;
  /**
   * Outcome of the affection gift roll performed at this reset.
   *
   * `null` only when no gift service is wired (older tests). Otherwise it is
   * always present and carries either the roll or the reason it was skipped —
   * the coordinator turns a generated gift into a post-commit event.
   */
  giftRoll: GiftRollResult | null;
}

export interface DailyStatus {
  claimedToday: boolean;
  nextResetAt: Date;
}

export interface DailyService {
  /**
   * Once per calendar day (configured timezone). One transaction: insert the
   * claim row (unique constraint blocks races), refill Hunt Energy to the
   * level-scaled max, grant WaifuBux + base charm pack + any level-unlocked
   * bonus items + a rolled rare-item chance, award daily-claim XP, and take
   * the buddy's affection gift roll.
   *
   * The gift roll rides *inside* this transaction because this is the
   * authoritative daily reset: rolling here means the roll cannot happen
   * without the reset, and the reset cannot happen twice. The gift ledger
   * carries its own `(player_id, roll_date)` unique index on top, so the roll
   * is idempotent even if it is ever driven from somewhere else.
   */
  claim(playerId: number, now?: Date): Promise<DailyClaimResult>;

  status(playerId: number, now?: Date): Promise<DailyStatus>;
}

export interface DailyServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  progression: ProgressionService;
  care: CareService;
  /**
   * Affection Gift System. **Optional**: the daily claim is this project's
   * authoritative daily reset, so the roll belongs in its transaction — but a
   * deployment (or an older test) without gifts wired simply does not roll.
   */
  gifts?: AffectionGiftService | undefined;
  tables: TablesContent;
  timezone: string;
  /** Optional injected RNG for the level-30 daily rare roll. */
  rng?: Rng;
}

export function createDailyService(deps: DailyServiceDeps): DailyService {
  const { db, currency, inventory, progression, care, tables, timezone } = deps;
  const gifts = deps.gifts;
  const rng = deps.rng ?? defaultRng();

  async function claim(playerId: number, now: Date = new Date()): Promise<DailyClaimResult> {
    const claimDate = claimDateInTimezone(now, timezone);
    const reset = nextResetAt(now, timezone);
    const packageItems = tables.dailyPackage.items;
    const waifubux = tables.dailyPackage.waifubux;

    try {
      return await db.transaction(async (tx) => {
        // Apply pending Care Mode ticks + exit Care Mode inside the daily
        // transaction. Any accrued XP/affection lands before the refill; the
        // refill below unconditionally sets energy to the level-scaled max,
        // so any care-tick energy is overwritten by the refill (as intended).
        const careExit = await care.applyAndExit(tx, playerId, now);

        const [player] = await tx.select().from(players).where(eq(players.id, playerId));
        if (!player) {
          throw new ContentValidationError(`Player ${playerId} vanished mid-daily`);
        }
        const level = player.level;
        const energySetTo = progression.computeMaxEnergy(level);

        // Base package + level-scaled bonus items merged into one map.
        const bonusItems = progression.computeDailyBonusItems(level);
        const merged: Record<string, number> = { ...packageItems };
        for (const b of bonusItems) merged[b.slug] = (merged[b.slug] ?? 0) + b.quantity;

        // Level-30 rare-item chance — rolled once per claim.
        const rareChance = progression.computeDailyRareChance(level);
        let rareItemGranted = false;
        if (rareChance > 0 && rng.next() < rareChance) {
          const rare = tables.progression.dailyRareItemChance;
          merged[rare.slug] = (merged[rare.slug] ?? 0) + rare.quantity;
          rareItemGranted = true;
        }

        const slugs = Object.keys(merged);
        const itemRows = slugs.length
          ? await tx.select().from(items).where(inArray(items.slug, slugs))
          : [];
        if (itemRows.length !== slugs.length) {
          throw new ContentValidationError('dailyPackage references items missing from the database');
        }

        const [dailyRow] = await tx
          .insert(dailyClaims)
          .values({
            playerId,
            claimDate,
            rewards: {
              energySetTo,
              waifubux,
              items: merged,
              rareItemGranted,
              level,
            },
          })
          .returning();

        await currency.lockCurrencies(tx, playerId);
        await currency.setHuntEnergy(tx, playerId, energySetTo);
        if (waifubux > 0) await currency.grantWaifubux(tx, playerId, waifubux);

        const granted: Array<{ item: ItemRow; quantity: number }> = [];
        for (const item of itemRows) {
          const quantity = merged[item.slug];
          if (!quantity) continue;
          await inventory.addItem(tx, playerId, item.id, quantity);
          granted.push({ item, quantity });
        }

        const xp = await progression.grantXp(tx, playerId, {
          eventType: 'daily_claim',
          xpDelta: tables.progression.xp.dailyClaim,
          refId: dailyRow?.id ?? null,
          metadata: { claimDate, rareItemGranted },
        });

        // Affection gift roll — last, so a gift can never be the reason a
        // daily claim fails, and always inside this transaction so it shares
        // the reset's atomicity.
        const giftRoll = gifts ? await gifts.processDailyRoll(tx, playerId, now) : null;

        return {
          claimDate,
          energySetTo,
          waifubux,
          items: granted,
          nextResetAt: reset,
          xp,
          levelUps: xp.levelUps,
          rareItemGranted,
          careExit:
            careExit.active || careExit.stopped || careExit.ticksProcessed > 0
              ? careExit
              : null,
          giftRoll,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AlreadyClaimedError(reset);
      throw err;
    }
  }

  async function status(playerId: number, now: Date = new Date()): Promise<DailyStatus> {
    const claimDate = claimDateInTimezone(now, timezone);
    const [existing] = await db
      .select({ id: dailyClaims.id })
      .from(dailyClaims)
      .where(and(eq(dailyClaims.playerId, playerId), eq(dailyClaims.claimDate, claimDate)))
      .orderBy(desc(dailyClaims.id))
      .limit(1);
    return { claimedToday: Boolean(existing), nextResetAt: nextResetAt(now, timezone) };
  }

  return { claim, status };
}
