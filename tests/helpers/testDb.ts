/**
 * Per-test-file database isolation: create a uniquely named database on the
 * shared Postgres server, run real migrations into it, and hand back a drizzle
 * client. Real SQL, real locks — no mocking, no SQLite stand-in.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { inject } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createLogger, type Logger } from '../../src/shared/logger';

export interface TestDb {
  db: Db;
  pool: Pool;
  logger: Logger;
  cleanup(): Promise<void>;
}

/** Quiet logger for tests. */
export function silentLogger(): Logger {
  return createLogger('fatal');
}

export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject('adminDatabaseUrl');
  const dbName = `waifumon_test_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 10 });
  const db = createDb(pool);
  const logger = silentLogger();
  await runMigrations(db, logger, path.resolve(__dirname, '..', '..', 'drizzle'));

  return {
    db,
    pool,
    logger,
    async cleanup() {
      await pool.end();
      const admin2 = new Client({ connectionString: adminUrl });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin2.end();
    },
  };
}
