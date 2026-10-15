/**
 * Shared "load JSON → validate → seed Postgres → sync Region Pools" step.
 * Startup (`src/index.ts`) and the admin panel's Reload Content action both go
 * through this so the seeding path exists exactly once.
 */
import type { Db } from '../../db/client';
import type { Logger } from '../../shared/logger';
import { syncRegionPools, type RegionPoolSyncResult } from '../regionPools/regionPoolStore';
import { loadContent } from './loader';
import type { LoadedContent } from './schemas';
import { seedContent, type SeedSummary } from './seeder';

export interface ReloadResult {
  content: LoadedContent;
  summary: SeedSummary;
  regionPools: RegionPoolSyncResult;
}

/** Reloads content from disk and re-seeds it. Reused by the admin panel. */
export type ContentReloader = () => Promise<ReloadResult>;

export interface ContentReloaderDeps {
  db: Db;
  contentDir: string;
  assetsDir: string;
  logger: Logger;
}

/**
 * Applies an already-loaded content set to the database: species and items
 * first, then Region Pools, whose bootstrap names those species. The pools are
 * database-authoritative — this bootstraps a region that has none and projects
 * the published revisions, and never overwrites a published pool.
 */
export async function applyContent(
  db: Db,
  content: LoadedContent,
  logger: Logger,
): Promise<{ summary: SeedSummary; regionPools: RegionPoolSyncResult }> {
  const summary = await seedContent(db, content, logger);
  const regionPools = await syncRegionPools(db, content, logger);
  return { summary, regionPools };
}

export function createContentReloader(deps: ContentReloaderDeps): ContentReloader {
  return async () => {
    const content = loadContent(deps.contentDir, deps.assetsDir, deps.logger);
    const { summary, regionPools } = await applyContent(deps.db, content, deps.logger);
    return { content, summary, regionPools };
  };
}
