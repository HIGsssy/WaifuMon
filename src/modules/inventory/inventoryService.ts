import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { items, playerInventory, type ItemRow } from '../../db/schema';
import { InsufficientItemsError } from '../../shared/errors';

export interface InventoryEntry {
  item: ItemRow;
  quantity: number;
}

/**
 * Inventory is a quantity table keyed (player_id, item_id). Adds are upserts;
 * consumes are conditional decrements (`WHERE quantity >= n`), backed by a
 * CHECK (quantity >= 0) so negatives are impossible.
 */
export interface InventoryService {
  getInventory(playerId: number): Promise<InventoryEntry[]>;
  getQuantity(playerId: number, itemId: number): Promise<number>;
  addItem(tx: DbOrTx, playerId: number, itemId: number, quantity: number): Promise<number>;
  consumeItem(tx: DbOrTx, playerId: number, itemId: number, quantity: number): Promise<number>;
  /** Total quantity across capture-category items — for the acquisition-time soft cap. */
  countCaptureItems(tx: DbOrTx, playerId: number): Promise<number>;
}

function assertPositiveInt(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Quantity must be a positive integer, got ${quantity}`);
  }
}

export function createInventoryService(db: Db): InventoryService {
  return {
    async getInventory(playerId) {
      const rows = await db
        .select({ item: items, quantity: playerInventory.quantity })
        .from(playerInventory)
        .innerJoin(items, eq(playerInventory.itemId, items.id))
        .where(eq(playerInventory.playerId, playerId))
        .orderBy(items.category, items.buyPrice, items.slug);
      return rows.filter((r) => r.quantity > 0);
    },

    async getQuantity(playerId, itemId) {
      const [row] = await db
        .select({ quantity: playerInventory.quantity })
        .from(playerInventory)
        .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, itemId)));
      return row?.quantity ?? 0;
    },

    async addItem(tx, playerId, itemId, quantity) {
      assertPositiveInt(quantity);
      const [row] = await tx
        .insert(playerInventory)
        .values({ playerId, itemId, quantity })
        .onConflictDoUpdate({
          target: [playerInventory.playerId, playerInventory.itemId],
          set: { quantity: sql`${playerInventory.quantity} + ${quantity}` },
        })
        .returning({ quantity: playerInventory.quantity });
      return row?.quantity ?? quantity;
    },

    async consumeItem(tx, playerId, itemId, quantity) {
      assertPositiveInt(quantity);
      const [row] = await tx
        .update(playerInventory)
        .set({ quantity: sql`${playerInventory.quantity} - ${quantity}` })
        .where(
          and(
            eq(playerInventory.playerId, playerId),
            eq(playerInventory.itemId, itemId),
            gte(playerInventory.quantity, quantity),
          ),
        )
        .returning({ quantity: playerInventory.quantity });
      if (!row) throw new InsufficientItemsError(itemId, quantity);
      return row.quantity;
    },

    async countCaptureItems(tx, playerId) {
      const [row] = await tx
        .select({ total: sql<number>`coalesce(sum(${playerInventory.quantity}), 0)::int` })
        .from(playerInventory)
        .innerJoin(items, eq(playerInventory.itemId, items.id))
        .where(and(eq(playerInventory.playerId, playerId), eq(items.category, 'capture')));
      return row?.total ?? 0;
    },
  };
}
