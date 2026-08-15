#!/usr/bin/env tsx
/**
 * `npm run cards:warm` — pre-render card images so the first request is cheap.
 *
 * Thin by design; everything that decides *what* to warm lives in
 * `cardCacheOps.ts`, which is unit-tested against a temp cache.
 *
 * Default strategy: the default appearance of every **enabled** species, at
 * level 1, at the master size. Level is part of the render key, so warming is
 * one level deep on purpose — see `WARM_LEVEL`.
 *
 * Usage:
 *   npm run cards:warm
 *   npm run cards:warm -- --all-appearances     # every look, not just default
 *   npm run cards:warm -- --widths 512,1024     # also warm those derivatives
 *   npm run cards:warm -- --include-disabled
 *   npm run cards:warm -- --concurrency 4
 *   npm run cards:warm -- --content ./content --assets ./assets
 */
import path from 'node:path';
import process from 'node:process';
import { formatWarmReport, runCardWarm } from './cardCacheOps';
import { SUPPORTED_CARD_WIDTHS } from '../modules/cards';
import { createLogger } from '../shared/logger';

interface Args {
  contentDir: string;
  assetsDir: string;
  allAppearances: boolean;
  includeDisabled: boolean;
  widths: number[];
  concurrency: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    contentDir: process.env.CONTENT_DIR ?? path.resolve('content'),
    assetsDir: process.env.ASSETS_DIR ?? path.resolve('assets'),
    allAppearances: false,
    includeDisabled: false,
    widths: [],
    concurrency: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all-appearances') {
      args.allAppearances = true;
    } else if (arg === '--include-disabled') {
      args.includeDisabled = true;
    } else if (arg === '--widths' && argv[i + 1]) {
      args.widths = String(argv[i + 1])
        .split(',')
        .map((w) => Number(w.trim()));
      i += 1;
    } else if (arg === '--concurrency' && argv[i + 1]) {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--content' && argv[i + 1]) {
      args.contentDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--assets' && argv[i + 1]) {
      args.assetsDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npm run cards:warm -- [--all-appearances] [--include-disabled] ' +
          '[--widths 512,1024] [--concurrency N] [--content DIR] [--assets DIR]',
      );
      process.exit(0);
    }
  }

  const unsupported = args.widths.filter((w) => !SUPPORTED_CARD_WIDTHS.includes(w));
  if (unsupported.length > 0) {
    console.error(
      `Unsupported width(s): ${unsupported.join(', ')}. ` +
        `Supported: ${SUPPORTED_CARD_WIDTHS.join(', ')}.`,
    );
    process.exit(1);
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');

  const report = await runCardWarm({
    contentDir: args.contentDir,
    assetsDir: args.assetsDir,
    allAppearances: args.allAppearances,
    includeDisabled: args.includeDisabled,
    widths: args.widths,
    logger,
    ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stderr.write(`\r  warming ${done}/${total}…`);
      }
    },
  });

  process.stderr.write('\r');
  console.log(formatWarmReport(report));

  // A warm run that could not render anything it planned is a broken install,
  // not a slow start — fail the command so CI or a deploy notices.
  if (report.failed.length > 0 && report.rendered === 0 && report.cached === 0) {
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
