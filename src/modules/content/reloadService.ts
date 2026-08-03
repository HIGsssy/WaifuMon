/**
 * Shared "load JSON → validate → seed Postgres" step. Startup (`src/index.ts`)
 * and the admin panel's Reload Content action both go through this so the
 * seeding path exists exactly once.
 */
import type { Db } from '../../db/client';
import type { Logger } from '../../shared/logger';
import { loadContent } from './loader';
import type { LoadedContent } from './schemas';
import { seedContent, type SeedSummary } from './seeder';

export interface ReloadResult {
  content: LoadedContent;
  summary: SeedSummary;
}

/** Reloads content from disk and re-seeds it. Reused by the admin panel. */
export type ContentReloader = () => Promise<ReloadResult>;

export interface ContentReloaderDeps {
  db: Db;
  contentDir: string;
  assetsDir: string;
  logger: Logger;
}

export function createContentReloader(deps: ContentReloaderDeps): ContentReloader {
  return async () => {
    const content = loadContent(deps.contentDir, deps.assetsDir, deps.logger);
    const summary = await seedContent(deps.db, content, deps.logger);
    return { content, summary };
  };
}
