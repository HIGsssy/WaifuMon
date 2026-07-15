import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { dailyClaims, items, type ItemRow } from '../../db/schema';
import { AlreadyClaimedError, ContentValidationError, isUniqueViolation } from '../../shared/errors';
import { claimDateInTimezone, nextResetAt } from '../../shared/time';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { TablesContent } from '../content/schemas';

export interface DailyClaimResult {
  claimDate: string;
  energySetTo: number;
  waifubux: number;
  items: Array<{ item: ItemRow; quantity: number }>;
  nextResetAt: Date;
}

export interface DailyStatus {
  claimedToday: boolean;
  nextResetAt: Date;
}

export interface DailyService {
  /**
   * Once per calendar day (configured timezone). One transaction: insert the
   * claim row first — the UNIQUE(player_id, claim_date) constraint makes
   * double-claims impossible even under race — then refill energy to max and
   * grant WaifuBux + the charm pack.
   */
  claim(playerId: number, now?: Date): Promise<DailyClaimResult>;
  status(playerId: number, now?: Date): Promise<DailyStatus>;
}

export interface DailyServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  tables: TablesContent;
  timezone: string;
}

export function createDailyService(deps: DailyServiceDeps): DailyService {
  const { db, currency, inventory, tables, timezone } = deps;

  async function claim(playerId: number, now: Date = new Date()): Promise<DailyClaimResult> {
    const claimDate = claimDateInTimezone(now, timezone);
    const reset = nextResetAt(now, timezone);
    const packageItems = tables.dailyPackage.items;
    const energySetTo = tables.energy.baseMax;
    const waifubux = tables.dailyPackage.waifubux;

    try {
      return await db.transaction(async (tx) => {
        const slugs = Object.keys(packageItems);
        const itemRows = slugs.length
          ? await tx.select().from(items).where(inArray(items.slug, slugs))
          : [];
        if (itemRows.length !== slugs.length) {
          throw new ContentValidationError('dailyPackage references items missing from the database');
        }

        await tx.insert(dailyClaims).values({
          playerId,
          claimDate,
          rewards: { energySetTo, waifubux, items: packageItems },
        });

        await currency.lockCurrencies(tx, playerId);
        await currency.setHuntEnergy(tx, playerId, energySetTo);
        if (waifubux > 0) await currency.grantWaifubux(tx, playerId, waifubux);

        const granted: Array<{ item: ItemRow; quantity: number }> = [];
        for (const item of itemRows) {
          const quantity = packageItems[item.slug];
          if (!quantity) continue;
          await inventory.addItem(tx, playerId, item.id, quantity);
          granted.push({ item, quantity });
        }

        return { claimDate, energySetTo, waifubux, items: granted, nextResetAt: reset };
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
