#!/usr/bin/env tsx
/**
 * `npm run expeditions:due` — make an active expedition due *now*, for local
 * playtesting only.
 *
 * Waiting one, three, six or eighteen real hours to exercise the claim path is not a
 * test loop, it is a day off. This tool pulls exactly one lever:
 *
 *     UPDATE player_expeditions SET completes_at = now() WHERE status = 'active' AND ...
 *
 * and nothing else. It does **not** resolve, roll, grant or claim anything.
 * Resolution still happens where it always happens — inside the service, on
 * the next read or claim, gated on `completes_at <= now()` evaluated by the
 * database — so every production rule still applies to the row afterwards:
 * the same deterministic roll, the same conditional UPDATE, the same
 * idempotency. Moving the clock is the smallest intervention that reaches the
 * whole downstream path without forging any part of it.
 *
 * What this deliberately is not: a "skip timer" mechanic. There is no command,
 * no button, no item and no API route. It is a developer's shell, it refuses
 * to run against a production NODE_ENV, and it names the rows it touched so a
 * mistake is visible immediately.
 *
 * Usage:
 *   npm run expeditions:due -- --user 123456789012345678
 *   npm run expeditions:due -- --player 42
 *   npm run expeditions:due -- --expedition 7
 *   npm run expeditions:due -- --user 1234... --dry-run
 */
import process from 'node:process';
import { and, eq, sql } from 'drizzle-orm';
import { connectWithRetry, createDb, createPool } from '../db/client';
import { playerExpeditions, players } from '../db/schema';
import { createLogger } from '../shared/logger';

interface Args {
  discordUserId: string | null;
  playerId: number | null;
  expeditionId: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { discordUserId: null, playerId: null, expeditionId: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--user' && next) {
      args.discordUserId = String(next);
      i += 1;
    } else if (arg === '--player' && next) {
      args.playerId = Number(next);
      i += 1;
    } else if (arg === '--expedition' && next) {
      args.expeditionId = Number(next);
      i += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npm run expeditions:due -- (--user <discordId> | --player <id> | --expedition <id>) [--dry-run]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

async function main(): Promise<void> {
  // The one hard gate. A tool that rewrites completion times has no business
  // existing in production, so it refuses rather than warns.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'expeditions:due refuses to run with NODE_ENV=production. It is a local ' +
        'playtesting tool, not an operational one.',
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.discordUserId == null && args.playerId == null && args.expeditionId == null) {
    console.error(
      'Refusing to touch every active expedition. Name one: --user <discordId>, ' +
        '--player <id> or --expedition <id>.',
    );
    process.exit(1);
  }

  // DATABASE_URL directly rather than `loadConfig()`: moving one timestamp has
  // no business demanding a Discord token and a full valid bot environment.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Run this with the same environment the bot uses.');
    process.exit(1);
  }

  const logger = createLogger('info');
  const pool = createPool(databaseUrl);
  await connectWithRetry(pool, logger, { maxAttempts: 3 });
  const db = createDb(pool);

  try {
    let playerId = args.playerId;
    if (playerId == null && args.discordUserId != null) {
      const rows = await db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.discordUserId, args.discordUserId));
      if (rows.length === 0) {
        console.error(`No player with discord_user_id ${args.discordUserId}.`);
        process.exit(1);
      }
      // One Discord account can have a player row per guild. Every one of them
      // is the same human sitting at the same keyboard waiting for the same
      // mission, so all of them are fair game.
      console.log(`discord_user_id ${args.discordUserId} → player ids ${rows.map((r) => r.id).join(', ')}`);
      playerId = rows[0]!.id;
      if (rows.length > 1) {
        console.error(
          'That Discord account has more than one player row. Re-run with an explicit ' +
            '--player <id> so the row you meant is the row that moves.',
        );
        process.exit(1);
      }
    }

    const where =
      args.expeditionId != null
        ? and(eq(playerExpeditions.status, 'active'), eq(playerExpeditions.id, args.expeditionId))
        : and(eq(playerExpeditions.status, 'active'), eq(playerExpeditions.playerId, playerId!));

    const matches = await db
      .select({
        id: playerExpeditions.id,
        playerId: playerExpeditions.playerId,
        key: playerExpeditions.expeditionKey,
        completesAt: playerExpeditions.completesAt,
      })
      .from(playerExpeditions)
      .where(where);

    if (matches.length === 0) {
      console.log('No active expedition matched. Nothing to do.');
      return;
    }
    for (const row of matches) {
      console.log(
        `${args.dryRun ? 'would set due' : 'set due'}: expedition ${row.id} (player ${row.playerId}, ` +
          `${row.key}) was completing at ${row.completesAt.toISOString()}`,
      );
    }
    if (args.dryRun) return;

    // `now()` rather than a Node timestamp: `completes_at <= now()` is compared
    // against the database clock, and a tool that disagreed with it by a few
    // hundred milliseconds would be flaky for no reason.
    await db.update(playerExpeditions).set({ completesAt: sql`now()` }).where(where);
    console.log(
      `${matches.length} expedition(s) now due. Open Expeditions in Discord — the normal ` +
        'resolution path does the rest.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
