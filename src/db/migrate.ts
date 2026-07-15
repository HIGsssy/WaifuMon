import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';
import type { Logger } from '../shared/logger';

/** Runs drizzle-kit generated SQL migrations to head. Idempotent. */
export async function runMigrations(db: Db, logger: Logger, migrationsFolder?: string): Promise<void> {
  const folder = migrationsFolder ?? path.resolve(__dirname, '..', '..', 'drizzle');
  logger.info({ folder }, 'running migrations');
  await migrate(db, { migrationsFolder: folder });
  logger.info('migrations complete');
}
