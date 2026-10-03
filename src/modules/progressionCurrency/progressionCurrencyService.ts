/**
 * Progression currencies — resources a player earns toward long-term
 * progression, starting with the one dungeons pay (`ascension_currency`).
 *
 * ## Metadata
 *
 * A currency is a `progression_currencies` row: a **stable key** that reward
 * configuration and balances reference, and display fields (names, description,
 * icon, enabled) an admin may change at will. Nothing renames a key.
 *
 * ## Balances
 *
 * `player_progression_balances` holds one integer per player and currency,
 * created by the first grant — no row means zero. It is not an inventory item
 * and not a `player_currencies` column, so no shop, sale, gift, consumable or
 * Workshop flow can reach it: this service is the only writer.
 *
 * Every change is one `progression_currency_ledger` row written in the same
 * transaction as the balance. Grants and spends take a `DbOrTx` so callers
 * compose them into larger transactions. Both lock the balance row first; a
 * spend is a conditional update (`WHERE balance >= amount`) and the `>= 0`
 * CHECK backs that up, so a balance cannot go negative even if a lock is missed.
 *
 * A change that carries a `requestKey` is idempotent: repeating it replays the
 * recorded result instead of moving the balance again.
 */
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../../db/client';
import {
  playerProgressionBalances,
  players,
  progressionCurrencies,
  progressionCurrencyLedger,
  type ProgressionCurrencyRow,
} from '../../db/schema';
import {
  InsufficientProgressionCurrencyError,
  PlayerNotFoundError,
  ProgressionCurrencyDisabledError,
  ProgressionCurrencyInvalidError,
  ProgressionCurrencyNotFoundError,
  ProgressionCurrencyRequestConflictError,
  ProgressionCurrencyStaleError,
} from '../../shared/errors';

export interface ProgressionCurrency {
  /** Stable. Never shown to players and never changed. */
  key: string;
  singularName: string;
  pluralName: string;
  description: string;
  /** Emoji or short icon text; null for none. */
  icon: string | null;
  enabled: boolean;
  revision: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/** What an admin may edit. The key is not among them. */
export const ProgressionCurrencyMetadataSchema = z
  .object({
    singularName: z.string().trim().min(1).max(60),
    pluralName: z.string().trim().min(1).max(60),
    description: z.string().trim().max(500).default(''),
    icon: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .default(null)
      .transform((v) => (v === '' ? null : v)),
    enabled: z.boolean(),
  })
  .strict();
export type ProgressionCurrencyMetadata = z.infer<typeof ProgressionCurrencyMetadataSchema>;

export interface ProgressionCurrencyChange {
  playerId: number;
  currencyKey: string;
  /** A positive integer. */
  amount: number;
  /** What moved the balance, e.g. `dungeon_extraction`. */
  reason: string;
  /** What it moved for, e.g. `dungeon_run:42`. */
  sourceRef?: string | null;
  /** Makes the change idempotent per player and currency. */
  requestKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProgressionCurrencyChangeResult {
  balance: number;
  ledgerId: number;
  /** True when `requestKey` had already been applied and nothing moved. */
  replayed: boolean;
}

export interface ProgressionCurrencyService {
  list(): Promise<ProgressionCurrency[]>;
  get(key: string, tx?: DbOrTx): Promise<ProgressionCurrency | null>;
  /** Edit display metadata. Null when the key names no currency. */
  updateMetadata(
    key: string,
    input: { metadata: unknown; expectedRevision: number },
    actor: string | null,
  ): Promise<ProgressionCurrency | null>;
  /** Zero for a player who has never been granted any. */
  getBalance(playerId: number, currencyKey: string, tx?: DbOrTx): Promise<number>;
  /** Refused for a disabled currency. */
  grant(tx: DbOrTx, change: ProgressionCurrencyChange): Promise<ProgressionCurrencyChangeResult>;
  /** @throws {InsufficientProgressionCurrencyError} when the balance cannot cover it. */
  spend(tx: DbOrTx, change: ProgressionCurrencyChange): Promise<ProgressionCurrencyChangeResult>;
}

/** Largest single change — keeps a balance comfortably inside a 32-bit integer. */
export const MAX_PROGRESSION_CURRENCY_AMOUNT = 1_000_000_000;

/** `3 Ascension Tokens`, `1 Ascension Token` — with the icon when there is one. */
export function formatProgressionAmount(
  currency: Pick<ProgressionCurrency, 'singularName' | 'pluralName' | 'icon'>,
  amount: number,
): string {
  const name = Math.abs(amount) === 1 ? currency.singularName : currency.pluralName;
  return `${currency.icon ? `${currency.icon} ` : ''}${amount.toLocaleString('en-US')} ${name}`;
}

function toCurrency(row: ProgressionCurrencyRow): ProgressionCurrency {
  return {
    key: row.currencyKey,
    singularName: row.singularName,
    pluralName: row.pluralName,
    description: row.description,
    icon: row.icon,
    enabled: row.enabled,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_PROGRESSION_CURRENCY_AMOUNT) {
    throw new RangeError(
      `Amount must be an integer from 1 to ${MAX_PROGRESSION_CURRENCY_AMOUNT}, got ${String(amount)}`,
    );
  }
}

export function createProgressionCurrencyService(db: Db): ProgressionCurrencyService {
  async function readCurrency(tx: DbOrTx, key: string, lock = false) {
    const query = tx.select().from(progressionCurrencies).where(eq(progressionCurrencies.currencyKey, key));
    const [row] = lock ? await query.for('update') : await query;
    return row;
  }

  const balanceKey = (change: Pick<ProgressionCurrencyChange, 'playerId' | 'currencyKey'>) =>
    and(
      eq(playerProgressionBalances.playerId, change.playerId),
      eq(playerProgressionBalances.currencyKey, change.currencyKey),
    );

  /** Grant (`sign` 1) or spend (`sign` -1), with its ledger row. */
  async function apply(
    tx: DbOrTx,
    change: ProgressionCurrencyChange,
    sign: 1 | -1,
  ): Promise<ProgressionCurrencyChangeResult> {
    assertAmount(change.amount);
    const delta = sign * change.amount;
    const currency = await readCurrency(tx, change.currencyKey);
    if (!currency) throw new ProgressionCurrencyNotFoundError(change.currencyKey);
    if (sign === 1 && !currency.enabled) throw new ProgressionCurrencyDisabledError(change.currencyKey);

    const [player] = await tx.select({ id: players.id }).from(players).where(eq(players.id, change.playerId));
    if (!player) throw new PlayerNotFoundError(change.playerId);

    // Make sure the row exists, then lock it: everything below is serialised
    // per player and currency, including the request-key check.
    await tx
      .insert(playerProgressionBalances)
      .values({ playerId: change.playerId, currencyKey: change.currencyKey })
      .onConflictDoNothing();
    const [locked] = await tx.select().from(playerProgressionBalances).where(balanceKey(change)).for('update');

    if (change.requestKey) {
      const [previous] = await tx
        .select()
        .from(progressionCurrencyLedger)
        .where(
          and(
            eq(progressionCurrencyLedger.playerId, change.playerId),
            eq(progressionCurrencyLedger.currencyKey, change.currencyKey),
            eq(progressionCurrencyLedger.requestKey, change.requestKey),
          ),
        );
      if (previous) {
        if (previous.delta !== delta || previous.reason !== change.reason) {
          throw new ProgressionCurrencyRequestConflictError(change.requestKey);
        }
        return { balance: locked!.balance, ledgerId: previous.id, replayed: true };
      }
    }

    const [updated] = await tx
      .update(playerProgressionBalances)
      .set({ balance: sql`${playerProgressionBalances.balance} + ${delta}`, updatedAt: sql`now()` })
      .where(
        sign === 1
          ? balanceKey(change)
          : and(balanceKey(change), gte(playerProgressionBalances.balance, change.amount)),
      )
      .returning({ balance: playerProgressionBalances.balance });
    if (!updated) {
      throw new InsufficientProgressionCurrencyError(
        change.currencyKey,
        change.amount,
        locked?.balance ?? 0,
        currency.pluralName,
      );
    }

    const [entry] = await tx
      .insert(progressionCurrencyLedger)
      .values({
        playerId: change.playerId,
        currencyKey: change.currencyKey,
        delta,
        balanceAfter: updated.balance,
        reason: change.reason,
        sourceRef: change.sourceRef ?? null,
        requestKey: change.requestKey ?? null,
        metadata: change.metadata ?? {},
      })
      .returning({ id: progressionCurrencyLedger.id });
    return { balance: updated.balance, ledgerId: entry!.id, replayed: false };
  }

  return {
    async list() {
      const rows = await db.select().from(progressionCurrencies).orderBy(asc(progressionCurrencies.currencyKey));
      return rows.map(toCurrency);
    },

    async get(key, tx = db) {
      const row = await readCurrency(tx, key);
      return row ? toCurrency(row) : null;
    },

    async updateMetadata(key, { metadata, expectedRevision }, actor) {
      const parsed = ProgressionCurrencyMetadataSchema.safeParse(metadata);
      if (!parsed.success) {
        throw new ProgressionCurrencyInvalidError(
          parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'metadata', message: i.message })),
        );
      }
      return db.transaction(async (tx) => {
        const row = await readCurrency(tx, key, true);
        if (!row) return null;
        if (row.revision !== expectedRevision) {
          throw new ProgressionCurrencyStaleError(key, expectedRevision, row.revision);
        }
        // The key is not in the SET list: display metadata is all this writes.
        const [updated] = await tx
          .update(progressionCurrencies)
          .set({
            ...parsed.data,
            revision: sql`${progressionCurrencies.revision} + 1`,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(progressionCurrencies.currencyKey, key))
          .returning();
        return toCurrency(updated!);
      });
    },

    async getBalance(playerId, currencyKey, tx = db) {
      const [row] = await tx
        .select({ balance: playerProgressionBalances.balance })
        .from(playerProgressionBalances)
        .where(balanceKey({ playerId, currencyKey }));
      return row?.balance ?? 0;
    },

    grant: (tx, change) => apply(tx, change, 1),
    spend: (tx, change) => apply(tx, change, -1),
  };
}
