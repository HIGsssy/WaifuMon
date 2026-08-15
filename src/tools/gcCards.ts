#!/usr/bin/env tsx
/**
 * `npm run cards:gc` — reclaim orphaned card renders.
 *
 * Two rules, both explained at length in `src/modules/cards/gc.ts`:
 * directories for species that no longer exist are removed outright, and
 * everything else expires by age unless it is in the current warm set.
 *
 * It is *not* an exact sweep, and cannot be: level is part of the render key,
 * so the set of legitimate cache entries is unbounded. Age is the honest
 * signal, and a wrongly-collected entry costs exactly one re-render.
 *
 * Usage:
 *   npm run cards:gc -- --dry-run          # report only, touch nothing
 *   npm run cards:gc
 *   npm run cards:gc -- --max-age-days 7
 *   npm run cards:gc -- --cache ./assets/.card-cache
 */
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_MAX_AGE_DAYS } from '../modules/cards';
import { formatGcReport, runCardGc } from './cardCacheOps';
import { createLogger } from '../shared/logger';

interface Args {
  contentDir: string;
  assetsDir: string;
  cacheRoot: string | undefined;
  maxAgeDays: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    contentDir: process.env.CONTENT_DIR ?? path.resolve('content'),
    assetsDir: process.env.ASSETS_DIR ?? path.resolve('assets'),
    cacheRoot: undefined,
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--max-age-days' && argv[i + 1]) {
      args.maxAgeDays = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--cache' && argv[i + 1]) {
      args.cacheRoot = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--content' && argv[i + 1]) {
      args.contentDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--assets' && argv[i + 1]) {
      args.assetsDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npm run cards:gc -- [--dry-run] [--max-age-days N] [--cache DIR] ' +
          '[--content DIR] [--assets DIR]',
      );
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays < 0) {
    console.error('--max-age-days must be a non-negative number');
    process.exit(1);
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');

  const result = await runCardGc({
    contentDir: args.contentDir,
    assetsDir: args.assetsDir,
    maxAgeDays: args.maxAgeDays,
    dryRun: args.dryRun,
    logger,
    ...(args.cacheRoot === undefined ? {} : { cacheRoot: args.cacheRoot }),
  });

  console.log(formatGcReport(result));
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
