#!/usr/bin/env tsx
/**
 * `npm run artwork:build` — CLI wrapper around `artworkBuild.ts`.
 *
 * A selection is required: building the full-size WebP for an asset switches
 * its live runtime source (the resolver prefers WebP), so the whole library is
 * only ever converted by asking for it with `--all`.
 *
 * Usage:
 *   npm run artwork:build -- --all                         # every master
 *   npm run artwork:build -- --species alley_catgirl       # one species (repeatable, or a,b)
 *   npm run artwork:build -- --asset alley_catgirl/level_20  # one artwork (repeatable, or a,b)
 *   npm run artwork:build -- --all --only thumbnails       # renditions only; no runtime switch
 *   npm run artwork:build -- --all --dry-run               # plan, write nothing
 *   npm run artwork:build -- --all --check                 # as --dry-run; exit 1 if anything is stale
 *   npm run artwork:build -- --asset x/standard --force    # rebuild regardless of the manifest
 *
 * Only runtime artwork is built: masters named by the species content (every
 * appearance, `standard`, legacy `imagePath`), core and expansion packs alike.
 * Other PNGs under `waifumon/` — backups, working files — are counted as ignored.
 *
 * Options: --assets <dir> (default $ASSETS_DIR or ./assets), --content <dir>
 * (default $CONTENT_DIR or ./content), --concurrency <n>, --verbose (one line
 * per asset built, plus every ignored PNG).
 */
import path from 'node:path';
import process from 'node:process';
import {
  formatBuildReport,
  OUTPUT_KEYS,
  readRuntimeArtworkCatalog,
  runArtworkBuild,
  THUMBNAIL_KEYS,
  type ArtworkSelection,
  type OutputKey,
} from './artworkBuild';

interface Args {
  assetsDir: string;
  contentDir: string;
  all: boolean;
  species: string[];
  assets: string[];
  outputs: readonly OutputKey[];
  force: boolean;
  dryRun: boolean;
  check: boolean;
  verbose: boolean;
  concurrency: number | undefined;
}

const HELP = [
  'Build runtime WebP artwork (full size + 256/512/1024 renditions) from PNG masters.',
  '',
  '  --all                      every runtime-artwork master under <assets>/waifumon/',
  '  --species <slug>[,<slug>]  every master of these species (repeatable)',
  '  --asset <slug/variant>     one master (repeatable, comma-separated allowed)',
  '  --only full|thumbnails     build only these outputs (default: both)',
  '  --force                    rebuild selected outputs regardless of the manifest',
  '  --dry-run                  report what would be built; write nothing',
  '  --check                    as --dry-run, but exit 1 when anything is stale',
  '  --assets <dir>             assets directory (default: $ASSETS_DIR or ./assets)',
  '  --content <dir>            content directory (default: $CONTENT_DIR or ./content)',
  '  --concurrency <n>          assets encoded in parallel',
  '  --verbose                  one line per asset built, and every ignored PNG',
  '',
  'Runtime artwork is what the species content names; other PNGs are ignored.',
  'Building the full-size WebP for an asset makes it the live runtime artwork.',
].join('\n');

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    assetsDir: process.env.ASSETS_DIR ?? path.resolve('assets'),
    contentDir: process.env.CONTENT_DIR ?? path.resolve('content'),
    all: false,
    species: [],
    assets: [],
    outputs: OUTPUT_KEYS,
    force: false,
    dryRun: false,
    check: false,
    verbose: false,
    concurrency: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    if (arg === '--all') args.all = true;
    else if (arg === '--species') args.species.push(...list(value()));
    else if (arg === '--asset') args.assets.push(...list(value()));
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--assets') args.assetsDir = path.resolve(value() ?? '');
    else if (arg === '--content') args.contentDir = path.resolve(value() ?? '');
    else if (arg === '--concurrency') args.concurrency = Number(value());
    else if (arg === '--only') {
      const only = value();
      if (only === 'full') args.outputs = ['full'];
      else if (only === 'thumbnails') args.outputs = THUMBNAIL_KEYS;
      else fail(`--only expects "full" or "thumbnails", got ${only ?? 'nothing'}`);
    } else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else fail(`Unknown argument: ${arg}`);
  }
  if (!args.all && args.species.length === 0 && args.assets.length === 0) {
    fail('Nothing selected. Pass --all, --species or --asset.');
  }
  if (args.all && (args.species.length > 0 || args.assets.length > 0)) {
    fail('--all cannot be combined with --species or --asset.');
  }
  if (args.concurrency !== undefined && !(Number.isInteger(args.concurrency) && args.concurrency > 0)) {
    fail('--concurrency expects a positive integer.');
  }
  return args;
}

function fail(message: string): never {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selection: ArtworkSelection = args.all
    ? { all: true }
    : { species: args.species, assets: args.assets };

  const report = await runArtworkBuild({
    assetsDir: args.assetsDir,
    runtimeArtwork: readRuntimeArtworkCatalog(args.contentDir),
    selection,
    outputs: args.outputs,
    force: args.force,
    dryRun: args.dryRun || args.check,
    ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
    ...(args.verbose ? { onAsset: (line: string) => console.log(line) } : {}),
  });

  if (args.verbose) for (const file of report.ignored) console.log(`ignored ${file}`);
  console.log(formatBuildReport(report));
  const stale = args.check && report.built.length > 0;
  if (report.failed.length > 0 || report.unknown.length > 0 || stale) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`artwork:build failed: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
