/**
 * Startup order (plan §26): validate env → retry-connect to Postgres →
 * run migrations → load/validate/seed content & assets → register slash
 * commands → Discord login. Fail fast and loud before Discord login.
 */
import { loadConfig } from './config/config';
import { connectWithRetry, createDb, createPool } from './db/client';
import { runMigrations } from './db/migrate';
import { createDiscordClient } from './discord/client';
import { registerCommands } from './discord/commandRegistry';
import type { AppContext } from './discord/types';
import { loadContent } from './modules/content/loader';
import { seedContent } from './modules/content/seeder';
import { createCurrencyService } from './modules/currency/currencyService';
import { createDailyService } from './modules/daily/dailyService';
import { createGuildService } from './modules/guilds/guildService';
import { createInventoryService } from './modules/inventory/inventoryService';
import { createPlayerService } from './modules/players/playerService';
import { createShopService } from './modules/shop/shopService';
import { createHuntService } from './modules/hunt/huntService';
import { createCaptureService } from './modules/capture/captureService';
import { createCollectionService } from './modules/collection/collectionService';
import { createProgressionService } from './modules/progression/progressionService';
import { createLogger } from './shared/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });

  const pool = createPool(config.databaseUrl);
  pool.on('error', (err) => logger.error({ err }, 'Postgres pool error'));
  await connectWithRetry(pool, logger);

  const db = createDb(pool);
  await runMigrations(db, logger);

  const content = loadContent(config.contentDir, config.assetsDir, logger);
  await seedContent(db, content, logger);

  const currency = createCurrencyService(db);
  const inventory = createInventoryService(db);
  const progression = createProgressionService({
    config: content.tables.progression,
    baseMaxEnergy: content.tables.energy.baseMax,
  });
  const ctx: AppContext = {
    config,
    logger,
    db,
    content,
    services: {
      guilds: createGuildService(db),
      players: createPlayerService(db, { initialEnergy: content.tables.energy.baseMax }),
      currency,
      inventory,
      progression,
      daily: createDailyService({
        db,
        currency,
        inventory,
        progression,
        tables: content.tables,
        timezone: config.dailyTimezone,
      }),
      shop: createShopService({
        db,
        currency,
        inventory,
        captureCapacity: content.tables.inventory.captureCapacity,
      }),
      hunt: createHuntService({
        db,
        currency,
        inventory,
        progression,
        tables: content.tables,
        logger,
      }),
      capture: createCaptureService({
        db,
        inventory,
        progression,
        progressionConfig: content.tables.progression,
        captureConfig: content.tables.capture,
        logger,
      }),
      collection: createCollectionService({
        db,
        currency,
        duplicateConfig: content.tables.duplicate,
        totalSpeciesCount: content.species.filter((s) => s.enabled).length,
      }),
    },
  };

  // Best-effort startup sweep: mark expired encounters closed after downtime.
  const expired = await ctx.services.hunt.expireStale();
  if (expired > 0) logger.info({ expired }, 'swept stale active encounters');

  await registerCommands(config.discordToken, config.discordClientId, config.discordGuildId, logger);

  const client = createDiscordClient(ctx);
  await client.login(config.discordToken);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await client.destroy();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Logger may not exist yet if config failed — console is the safety net.
  console.error('Fatal startup error:', err);
  process.exit(1);
});
