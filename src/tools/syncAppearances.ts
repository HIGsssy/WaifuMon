#!/usr/bin/env tsx
/**
 * `npm run appearances:sync` — CLI wrapper around `appearanceSync.ts`.
 *
 * Deliberately thin. Everything that decides *what* changes lives in the core
 * module, so it is unit-testable against a temp directory and so a later
 * umbrella command (`content:prepare` = sync → thumbnails → validate) can call
 * the same function instead of shelling out to this file and parsing its
 * output.
 *
 * Usage:
 *   npm run appearances:sync                # write
 *   npm run appearances:sync -- --dry-run   # report only, touch nothing
 *   npm run appearances:sync -- --content ./content --assets ./assets
 */
import path from 'node:path';
import process from 'node:process';
import { formatSyncReport, runAppearanceSync } from './appearanceSync';

interface Args {
  dryRun: boolean;
  contentDir: string;
  assetsDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    // Defaults mirror the bot's own layout so the common case is zero flags.
    contentDir: process.env.CONTENT_DIR ?? path.resolve('content'),
    assetsDir: process.env.ASSETS_DIR ?? path.resolve('assets'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--content' && argv[i + 1]) {
      args.contentDir = path.resolve(argv[i + 1] as string);
      i += 1;
    } else if (arg === '--assets' && argv[i + 1]) {
      args.assetsDir = path.resolve(argv[i + 1] as string);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Sync milestone appearances from artwork on disk into content packs.',
          '',
          '  --dry-run           report what would change; write nothing',
          '  --content <dir>     content directory (default: ./content)',
          '  --assets <dir>      assets directory  (default: ./assets)',
          '',
          'An appearance is only added when its PNG already exists at',
          'assets/waifumon/<slug>/<appearance-id>.png. Existing appearances are',
          'never modified.',
        ].join('\n'),
      );
      process.exit(0);
    } else if (arg !== undefined) {
      console.error(`Unknown argument: ${arg}\nTry --help.`);
      process.exit(2);
    }
  }

  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let plan;
  try {
    plan = runAppearanceSync({
      contentDir: args.contentDir,
      assetsDir: args.assetsDir,
      dryRun: args.dryRun,
    });
  } catch (err) {
    // Every abort path — duplicate slugs, content that does not already load,
    // a candidate that would not validate — lands here having written nothing.
    console.error(`appearances:sync failed.\n\n${(err as Error).message}`);
    process.exit(1);
    return;
  }

  if (args.dryRun && plan.totals.appearances > 0) {
    console.log('Dry run — no files were written.\n');
  }
  console.log(formatSyncReport(plan, { dryRun: args.dryRun }));
}

main();
