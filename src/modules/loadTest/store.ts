/**
 * Finished runs, one row each, in `load_test_runs`. Written once when a run
 * ends; read by the Portal page's history table.
 */
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { loadTestRuns, type LoadTestRunRow } from '../../db/schema';

export type NewLoadTestRun = Omit<typeof loadTestRuns.$inferInsert, 'id'>;

export interface LoadTestRunStore {
  save(run: NewLoadTestRun): Promise<LoadTestRunRow>;
  list(limit: number): Promise<LoadTestRunRow[]>;
  get(id: number): Promise<LoadTestRunRow | null>;
}

export function createLoadTestRunStore(db: Db): LoadTestRunStore {
  return {
    async save(run) {
      const [row] = await db.insert(loadTestRuns).values(run).returning();
      if (!row) throw new Error('load_test_runs insert returned no row');
      return row;
    },
    async list(limit) {
      return db.select().from(loadTestRuns).orderBy(desc(loadTestRuns.startedAt)).limit(limit);
    },
    async get(id) {
      const [row] = await db.select().from(loadTestRuns).where(eq(loadTestRuns.id, id));
      return row ?? null;
    },
  };
}
