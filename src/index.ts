/**
 * Startup order (plan §26): validate env → retry-connect to Postgres →
 * run migrations → load/validate/seed content & assets → register slash
 * commands → Discord login. Fail fast and loud before Discord login.
 * The optional admin web panel starts last, and only when enabled.
 */
import { startAdminServer } from './admin/server';
import { startPlatformApi } from './api/server';
import { loadConfig } from './config/config';
import { connectWithRetry, createDb, createPool } from './db/client';
import { runMigrations } from './db/migrate';
import { createDiscordClient } from './discord/client';
import { registerCommands } from './discord/commandRegistry';
import type { AppContext } from './discord/types';
import { createAdminContentService } from './modules/content/adminContentService';
import { createContentReloader } from './modules/content/reloadService';
import { createCurrencyService } from './modules/currency/currencyService';
import { createDailyService } from './modules/daily/dailyService';
import { createGuildService } from './modules/guilds/guildService';
import { createInventoryService } from './modules/inventory/inventoryService';
import { createPlayerService } from './modules/players/playerService';
import { createShopService } from './modules/shop/shopService';
import { createHuntService } from './modules/hunt/huntService';
import { createCaptureService } from './modules/capture/captureService';
import { createCareService } from './modules/care/careService';
import { createCollectionService } from './modules/collection/collectionService';
import { createPlayerEffectsService } from './modules/effects/playerEffectsService';
import { createItemUseService } from './modules/items/itemUseService';
import { createProgressionService } from './modules/progression/progressionService';
import { createQuestService } from './modules/quests/questService';
import { createSessionService } from './modules/session/sessionService';
import { createGameEventBus } from './modules/events/gameEvents';
import { createHuntSessionTracker } from './modules/hunt/huntSession';
import { createActivityFeedService } from './modules/activity/activityFeedService';
import {
  createTrainerProfileService,
  type ProfileChannel,
} from './discord/trainerProfile';
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

  // The same reloader the admin panel calls, so startup and hot reload can
  // never drift apart.
  const reloadContent = createContentReloader({
    db,
    contentDir: config.contentDir,
    assetsDir: config.assetsDir,
    logger,
  });
  const { content } = await reloadContent();

  const currency = createCurrencyService(db);
  const inventory = createInventoryService(db);
  const progression = createProgressionService({
    config: content.tables.progression,
    baseMaxEnergy: content.tables.energy.baseMax,
  });
  const quests = createQuestService({
    db,
    currency,
    inventory,
    config: content.tables.dailyQuests,
    timezone: config.dailyTimezone,
    logger,
  });
  const collection = createCollectionService({
    db,
    currency,
    quests,
    duplicateConfig: content.tables.duplicate,
    waifuConfig: content.tables.waifuProgression,
    totalSpeciesCount: content.species.filter((s) => s.enabled).length,
  });
  const care = createCareService({
    db,
    currency,
    collection,
    progression,
    quests,
    careConfig: content.tables.energy.careMode,
  });
  const effects = createPlayerEffectsService(db);
  // Central gameplay-event seam. Handlers emit onto it after their
  // transaction commits; subscribers (Activity Feed today, Trainer Profile
  // next) are strictly downstream and can never fail a gameplay write.
  const gameEventBus = createGameEventBus({ logger });
  const huntSessions = createHuntSessionTracker({
    locations: content.tables.hunt.locationFlavors,
  });
  const guilds = createGuildService(db);
  const ctx: AppContext = {
    config,
    logger,
    db,
    content,
    events: gameEventBus,
    huntSessions,
    services: {
      guilds,
      players: createPlayerService(db, { initialEnergy: content.tables.energy.baseMax }),
      currency,
      inventory,
      progression,
      daily: createDailyService({
        db,
        currency,
        inventory,
        progression,
        care,
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
        collection,
        care,
        quests,
        tables: content.tables,
        logger,
      }),
      capture: createCaptureService({
        db,
        inventory,
        progression,
        progressionConfig: content.tables.progression,
        captureConfig: content.tables.capture,
        buddyAffinityConfig: content.tables.buddyAffinity,
        collection,
        quests,
        effects,
        logger,
      }),
      care,
      collection,
      quests,
      effects,
      itemUse: createItemUseService({
        db,
        currency,
        inventory,
        effects,
        progression,
        care,
      }),
      session: createSessionService({
        db,
        timezone: config.dailyTimezone,
      }),
    },
  };

  // Best-effort startup sweep: mark expired encounters closed after downtime.
  const expired = await ctx.services.hunt.expireStale();
  if (expired > 0) logger.info({ expired }, 'swept stale active encounters');

  await registerCommands(config.discordToken, config.discordClientId, config.discordGuildId, logger);

  const client = createDiscordClient(ctx);

  // Activity Feed: the first bus subscriber. It narrates player-visible
  // events into the guild's "Waifumon Log" (`guilds.announce_channel_id`).
  // Guilds without one configured stay silent — we deliberately do not fall
  // back to the play channel, which is reserved for Trainer Profiles.
  const activityFeed = createActivityFeedService({
    logger,
    richEmbedMinRarity: content.tables.capture.announceMinRarity,
    resolveChannel: async (discordGuildId) => {
      const guild = await guilds.getByDiscordId(discordGuildId);
      return guild?.announceChannelId ?? null;
    },
    post: async (channelId, text) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    },
  });
  activityFeed.subscribe(gameEventBus);

  // Trainer Profile: the second bus subscriber. It owns the one public
  // message Waifumon posts on a player's behalf — their Care Mode dashboard
  // in the play channel. Create / edit / remove are driven entirely by events.
  const trainerProfile = createTrainerProfileService({
    logger,
    services: ctx.services,
    resolveChannel: async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !('send' in channel) || !('messages' in channel)) return null;
        return channel as unknown as ProfileChannel;
      } catch (err) {
        logger.warn({ err, channelId }, 'trainer profile: channel fetch failed');
        return null;
      }
    },
  });
  trainerProfile.subscribe(gameEventBus);

  await client.login(config.discordToken);

  // Admin "Save + Reload" re-seeds Postgres *and* republishes the in-memory
  // content snapshot, so item/species metadata rendered from `ctx.content`
  // (shop rows, charm buttons, effect labels) goes live without a restart.
  // tables.json tuning is still baked into service closures at construction —
  // that part genuinely needs a restart, and the panel says so.
  const adminServer = await startAdminServer({
    config: config.adminWeb,
    logger,
    content: createAdminContentService({
      contentDir: config.contentDir,
      assetsDir: config.assetsDir,
      logger,
      reload: async () => {
        const result = await reloadContent();
        ctx.content = result.content;
        return result;
      },
    }),
  });

  // Platform API: a thin HTTP adapter over the same service layer the Discord
  // handlers call, on its own port and behind its own token. Silent and
  // zero-overhead unless PLATFORM_API_ENABLED=true. It reads `ctx` live rather
  // than capturing it, so a content reload is visible to /ready immediately.
  const platformApi = await startPlatformApi({
    config: config.platformApi,
    logger,
    probes: {
      pingDatabase: async () => {
        await pool.query('SELECT 1');
      },
      describeContent: () => ({
        species: ctx.content.species.length,
        items: ctx.content.items.length,
      }),
      describeDiscord: () =>
        client.isReady()
          ? { status: 'ok', detail: 'gateway connected' }
          : { status: 'down', detail: 'gateway not connected' },
      describeBind: () => `listening on ${config.platformApi.host}:${config.platformApi.port}`,
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await platformApi?.close();
    await adminServer?.close();
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
