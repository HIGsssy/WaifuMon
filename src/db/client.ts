import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DatabaseUnavailableError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A Db or a transaction handle — services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export function createPool(databaseUrl: string): Pool {
  // Bot workloads need a small pool.
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Bounded exponential-backoff connect. Compose healthchecks help, but this
 * covers restart orderings the healthcheck can't.
 */
export async function connectWithRetry(
  pool: Pool,
  logger: Logger,
  { maxAttempts = 12, baseDelayMs = 500, maxDelayMs = 15_000 }: RetryOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      logger.info({ attempt }, 'connected to Postgres');
      return;
    } catch (err) {
      lastError = err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn(
        { attempt, maxAttempts, delayMs: delay, err: (err as Error).message },
        'Postgres not ready, retrying',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new DatabaseUnavailableError(
    `Could not connect to Postgres after ${maxAttempts} attempts: ${(lastError as Error)?.message}`,
  );
}
