import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import { playerCurrencies, type PlayerCurrenciesRow } from '../../db/schema';
import { InsufficientEssenceError, InsufficientFundsError, PlayerNotFoundError } from '../../shared/errors';

/**
 * Currency operations. Mutations take a DbOrTx so callers compose them into
 * larger transactions (daily claim, shop purchase). Spends are conditional
 * updates (`WHERE balance >= amount`), so over-spends are impossible even if a
 * lock is missed; CHECK constraints back that up at the database level.
 */
export interface CurrencyService {
  getBalances(playerId: number): Promise<PlayerCurrenciesRow>;
  /** `SELECT … FOR UPDATE` on the player's currency row within `tx`. */
  lockCurrencies(tx: DbOrTx, playerId: number): Promise<PlayerCurrenciesRow>;
  grantWaifubux(tx: DbOrTx, playerId: number, amount: number): Promise<PlayerCurrenciesRow>;
  spendWaifubux(tx: DbOrTx, playerId: number, amount: number): Promise<PlayerCurrenciesRow>;
  grantEssence(tx: DbOrTx, playerId: number, amount: number): Promise<PlayerCurrenciesRow>;
  spendEssence(tx: DbOrTx, playerId: number, amount: number): Promise<PlayerCurrenciesRow>;
  setHuntEnergy(tx: DbOrTx, playerId: number, value: number): Promise<PlayerCurrenciesRow>;
}

function assertPositiveInt(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(`Amount must be a positive integer, got ${amount}`);
  }
}

export function createCurrencyService(db: Db): CurrencyService {
  return {
    async getBalances(playerId) {
      const row = await db.query.playerCurrencies.findFirst({
        where: eq(playerCurrencies.playerId, playerId),
      });
      if (!row) throw new PlayerNotFoundError(playerId);
      return row;
    },

    async lockCurrencies(tx, playerId) {
      const [row] = await tx
        .select()
        .from(playerCurrencies)
        .where(eq(playerCurrencies.playerId, playerId))
        .for('update');
      if (!row) throw new PlayerNotFoundError(playerId);
      return row;
    },

    async grantWaifubux(tx, playerId, amount) {
      assertPositiveInt(amount);
      const [row] = await tx
        .update(playerCurrencies)
        .set({
          waifubux: sql`${playerCurrencies.waifubux} + ${amount}`,
          updatedAt: sql`now()`,
        })
        .where(eq(playerCurrencies.playerId, playerId))
        .returning();
      if (!row) throw new PlayerNotFoundError(playerId);
      return row;
    },

    async spendWaifubux(tx, playerId, amount) {
      assertPositiveInt(amount);
      const [row] = await tx
        .update(playerCurrencies)
        .set({
          waifubux: sql`${playerCurrencies.waifubux} - ${amount}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(playerCurrencies.playerId, playerId), gte(playerCurrencies.waifubux, amount)),
        )
        .returning();
      if (!row) {
        const [current] = await tx
          .select({ waifubux: playerCurrencies.waifubux })
          .from(playerCurrencies)
          .where(eq(playerCurrencies.playerId, playerId));
        if (!current) throw new PlayerNotFoundError(playerId);
        throw new InsufficientFundsError(amount, current.waifubux);
      }
      return row;
    },

    async grantEssence(tx, playerId, amount) {
      assertPositiveInt(amount);
      const [row] = await tx
        .update(playerCurrencies)
        .set({
          essence: sql`${playerCurrencies.essence} + ${amount}`,
          updatedAt: sql`now()`,
        })
        .where(eq(playerCurrencies.playerId, playerId))
        .returning();
      if (!row) throw new PlayerNotFoundError(playerId);
      return row;
    },

    async spendEssence(tx, playerId, amount) {
      assertPositiveInt(amount);
      const [row] = await tx
        .update(playerCurrencies)
        .set({
          essence: sql`${playerCurrencies.essence} - ${amount}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(playerCurrencies.playerId, playerId), gte(playerCurrencies.essence, amount)),
        )
        .returning();
      if (!row) {
        const [current] = await tx
          .select({ essence: playerCurrencies.essence })
          .from(playerCurrencies)
          .where(eq(playerCurrencies.playerId, playerId));
        if (!current) throw new PlayerNotFoundError(playerId);
        throw new InsufficientEssenceError(amount, current.essence);
      }
      return row;
    },

    async setHuntEnergy(tx, playerId, value) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`Energy must be a non-negative integer, got ${value}`);
      }
      const [row] = await tx
        .update(playerCurrencies)
        .set({ huntEnergy: value, updatedAt: sql`now()` })
        .where(eq(playerCurrencies.playerId, playerId))
        .returning();
      if (!row) throw new PlayerNotFoundError(playerId);
      return row;
    },
  };
}
