import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { dungeonRuns } from '../../db/schema';
import type { WaifuUnavailabilityReason } from '../collection/waifuAvailability';

/**
 * Reservation is the active run itself, never a second flag. Plain reads:
 * release already holds the player lock that serialises it with run start;
 * locking runs here would invert the future reward step's run→copy order.
 */
export function createDungeonAvailabilityProvider() {
  return async (tx: DbOrTx, playerId: number, waifuIds: readonly number[]): Promise<Map<number, WaifuUnavailabilityReason[]>> => {
    const result = new Map<number, WaifuUnavailabilityReason[]>();
    if (waifuIds.length === 0) return result;
    const [run] = await tx.select({ fighter: dungeonRuns.fighter }).from(dungeonRuns)
      .where(and(eq(dungeonRuns.playerId, playerId), eq(dungeonRuns.status, 'active')));
    const waifuId = run?.fighter.waifuId;
    if (typeof waifuId === 'number' && waifuIds.includes(waifuId)) result.set(waifuId, ['in_dungeon']);
    return result;
  };
}
