#!/usr/bin/env tsx
/**
 * `npm run cards:warm` — pre-render card images so the first request is cheap.
 *
 * Thin by design; everything that decides *what* to warm lives in
 * `cardCacheOps.ts`, which is unit-tested against a temp cache.
 *
 * Two modes, and they warm genuinely different cards:
 *
 *   - **Species previews** (the default). The default appearance of every
 *     enabled species, at level 1, unowned. This is the encyclopedia's set.
 *     Level is part of the render key, so warming is one level deep on
 *     purpose — see `WARM_LEVEL`.
 *   - **Owned cards** (`--player`, `--all-players`). One card per owned copy at
 *     her *current* level wearing her *current* appearance, with the CAUGHT
 *     badge, plus the @256 and @512 grid derivatives the Portal's collection
 *     tiles resolve to. Needs a database, and is the back-catalogue half of the
 *     collection grid's warm story — the other halves being warm-on-capture and
 *     the bounded self-heal behind a collection listing.
 *
 * Concurrency defaults to 1 in owned mode and is not derived from the core
 * count. The deployment this exists for is a 16 GB mini-PC that is also running
 * Postgres and the gateway, and a warm that makes the bot unresponsive has
 * traded the wrong thing for speed.
 *
 * Usage:
 *   npm run cards:warm
 *   npm run cards:warm -- --all-appearances     # every look, not just default
 *   npm run cards:warm -- --widths 512,1024     # also warm those derivatives
 *   npm run cards:warm -- --include-disabled
 *   npm run cards:warm -- --concurrency 4
 *   npm run cards:warm -- --content ./content --assets ./assets
 *
 *   npm run cards:warm -- --player 12
 *   npm run cards:warm -- --all-players
 *   npm run cards:warm -- --all-players --player-concurrency 2
 */
import path from 'node:path';
import process from 'node:process';
import {
  formatOwnedWarmReport,
  formatWarmReport,
  runCardWarm,
  runOwnedCardWarm,
} from './cardCacheOps';
import { createDb, createPool } from '../db/client';
import { shutdownCardRenderer, SUPPORTED_CARD_WIDTHS } from '../modules/cards';
import { createLogger } from '../shared/logger';

interface Args {
  contentDir: string;
  assetsDir: string;
  allAppearances: boolean;
  includeDisabled: boolean;
  widths: number[];
  concurrency: number | undefined;
  /** Explicit player ids from `--player`. */
  playerIds: number[];
  allPlayers: boolean;
  playerConcurrency: number | undefined;
}

const USAGE =
  'Usage: npm run cards:warm -- [--all-appearances] [--include-disabled] ' +
  '[--widths 512,1024] [--concurrency N] [--content DIR] [--assets DIR]\n' +
  '       npm run cards:warm -- --player <playerId> [--player <playerId> …]\n' +
  '       npm run cards:warm -- --all-players [--player-concurrency N]';

function parseArgs(argv: string[]): Args {
  const args: Args = {
    contentDir: process.env.CONTENT_DIR ?? path.resolve('content'),
    assetsDir: process.env.ASSETS_DIR ?? path.resolve('assets'),
    allAppearances: false,
    includeDisabled: false,
    widths: [],
    concurrency: undefined,
    playerIds: [],
    allPlayers: false,
    playerConcurrency: undefined,
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
    } else if (arg === '--player' && argv[i + 1]) {
      // Repeatable: `--player 3 --player 7` warms both in one run, sharing one
      // renderer and therefore one worker pool.
      args.playerIds.push(Number(argv[i + 1]));
      i += 1;
    } else if (arg === '--all-players') {
      args.allPlayers = true;
    } else if (arg === '--player-concurrency' && argv[i + 1]) {
      args.playerConcurrency = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--content' && argv[i + 1]) {
      args.contentDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--assets' && argv[i + 1]) {
      args.assetsDir = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
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

  if (args.playerIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    console.error('--player takes a positive integer player id.');
    process.exit(1);
  }

  return args;
}

/**
 * Owned mode. Returns whether the run should be treated as a failure.
 *
 * The database connection is opened here rather than in `cardCacheOps` so the
 * species-preview path — which needs no database at all — keeps working in an
 * environment that has none.
 */
async function warmOwned(args: Args): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('--player / --all-players need DATABASE_URL to be set.');
    process.exit(1);
  }

  const logger = createLogger(process.env.LOG_LEVEL ?? 'warn');
  const pool = createPool(databaseUrl);

  try {
    const db = createDb(pool);
    const report = await runOwnedCardWarm({
      db,
      contentDir: args.contentDir,
      assetsDir: args.assetsDir,
      logger,
      ...(args.allPlayers ? {} : { playerIds: args.playerIds }),
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
      ...(args.playerConcurrency === undefined
        ? {}
        : { playerConcurrency: args.playerConcurrency }),
      onPlayer: (done, total, playerId) => {
        process.stderr.write(`\r  warming player ${playerId} (${done}/${total})…`);
      },
    });

    process.stderr.write('\r');
    console.log(formatOwnedWarmReport(report));

    // A run that planned work and could not do any of it is a broken install.
    // A run that found nothing to warm is not — a player with no copies, or an
    // already-hot cache, are both perfectly good outcomes.
    return (
      report.failed.length > 0 &&
      report.mastersRendered === 0 &&
      report.derivativesCreated === 0 &&
      report.mastersCached === 0
    );
  } finally {
    await pool.end();
  }
}

async function warmSpecies(args: Args): Promise<boolean> {
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

  return report.failed.length > 0 && report.rendered === 0 && report.cached === 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const owned = args.allPlayers || args.playerIds.length > 0;

  const broken = owned ? await warmOwned(args) : await warmSpecies(args);

  // Masters are drawn on worker threads; release them explicitly rather than
  // leaning on the pool's idle unref to let the command exit.
  await shutdownCardRenderer();

  // A warm run that could not render anything it planned is a broken install,
  // not a slow start — fail the command so CI or a deploy notices.
  if (broken) process.exit(1);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
