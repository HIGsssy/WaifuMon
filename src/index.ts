/**
 * Startup order (plan §26): validate env → retry-connect to Postgres →
 * run migrations → load/validate/seed content & assets → register slash
 * commands → Discord login. Fail fast and loud before Discord login.
 * The optional admin web panel starts last, and only when enabled.
 */
import { startAdminServer } from './admin/server';
import { startPlatformApi } from './api/server';
import { withIdentityCache } from './api/identity';
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
import { createAppearanceService } from './modules/appearance/appearanceService';
import { configureCardRenderer, shutdownCardRenderer } from './modules/cards';
import { OwnedCardWarmer } from './modules/appearance/ownedCardWarm';
import { listOwnedWarmSubjects } from './modules/appearance/ownedCardWarmSubjects';
import { createCollectionService } from './modules/collection/collectionService';
import { createPlayerEffectsService } from './modules/effects/playerEffectsService';
import { createItemUseService } from './modules/items/itemUseService';
import { createProgressionService } from './modules/progression/progressionService';
import { createQuestService } from './modules/quests/questService';
import { createSessionService } from './modules/session/sessionService';
import { createGameEventBus } from './modules/events/gameEvents';
import { createHuntSessionTracker } from './modules/hunt/huntSession';
import { createActivityFeedService } from './modules/activity/activityFeedService';
import { resolveAppearanceAsset } from './modules/appearance/assetResolver';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
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

  // Before anything can draw a card: the shared renderer is built once, and
  // its worker count is fixed at construction. Threads are still started
  // lazily, so this costs nothing in a deployment with cards switched off.
  configureCardRenderer({
    logger,
    ...(config.platformApi.cardRenderWorkers === undefined
      ? {}
      : { workers: config.platformApi.cardRenderWorkers }),
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
  // Cosmetic appearances. Reads the content snapshot through a getter so an
  // admin-panel "Save + Reload" makes newly-authored artwork available (and
  // retroactively unlockable) without a restart — `ctx.content` is reassigned
  // below, and this closure follows it.
  let contentSnapshot = content;
  const appearance = createAppearanceService({ db, getContent: () => contentSnapshot });
  const collection = createCollectionService({
    db,
    currency,
    quests,
    appearance,
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
    appearance,
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

  /**
   * Owned-card warming, built only when there is a renderer to warm into.
   *
   * `undefined` with cards switched off is the whole gate: every caller
   * optional-chains it, so a deployment without card rendering has no warm
   * code path at all rather than a warm path that checks a flag.
   *
   * Nothing here warms anything at startup, deliberately. Warming every
   * player's collection on boot would turn a restart into a render job
   * proportional to the entire player base, on a node that has just come back
   * up and is being asked to serve Discord. The back catalogue is an operator's
   * job (`cards:warm --all-players`); the running process only ever warms in
   * response to something a player just did.
   */
  const cardWarmer = config.platformApi.cardRendererEnabled
    ? new OwnedCardWarmer({
        presentation: { appearance, assetsDir: config.assetsDir, logger },
        listSubjects: (playerId) => listOwnedWarmSubjects(db, playerId),
        logger,
        ...(config.platformApi.cardWarmConcurrency === undefined
          ? {}
          : { concurrency: config.platformApi.cardWarmConcurrency }),
      })
    : undefined;

  const ctx: AppContext = {
    config,
    logger,
    db,
    content,
    events: gameEventBus,
    huntSessions,
    ...(cardWarmer === undefined ? {} : { cardWarmer }),
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
        appearance,
        logger,
      }),
      care,
      collection,
      appearance,
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
    // Alternate-appearance unlock announcements attach the raw PNG so other
    // players see the newly-unlocked artwork itself. Missing artwork → null,
    // and the feed falls back to a plain text line rather than dropping the
    // announcement.
    resolveAppearanceArtwork: (assetId) => {
      const resolved = resolveAppearanceAsset({ assetsDir: config.assetsDir, logger }, assetId);
      if (!resolved) return null;
      return {
        absolutePath: resolved.absolutePath,
        filename: `${assetId.slug}-${assetId.variant}.png`,
      };
    },
    post: async (channelId, request) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      if (request.richEmbed) {
        const embed = new EmbedBuilder()
          .setTitle(request.richEmbed.title)
          .setDescription(request.richEmbed.description)
          .setColor(0xffb6d1)
          .setImage(`attachment://${request.richEmbed.image.filename}`);
        if (request.richEmbed.footer) embed.setFooter({ text: request.richEmbed.footer });
        await channel.send({
          embeds: [embed],
          files: [
            new AttachmentBuilder(request.richEmbed.image.absolutePath, {
              name: request.richEmbed.image.filename,
            }),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }
      await channel.send({ content: request.text, allowedMentions: { parse: [] } });
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
        // Keep the appearance service's view in step: newly-authored artwork
        // must be selectable (and retroactively unlockable) immediately.
        contentSnapshot = result.content;
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
    ctx: {
      services: ctx.services,
      // Read through `ctx` so an admin-panel content reload is visible to the
      // API immediately, exactly as it is to the Discord handlers.
      getContent: () => ctx.content,
      // Only the card routes use this, and only to hand the shared appearance
      // resolver a root to look under. No path derived from it ever reaches a
      // client.
      assetsDir: config.assetsDir,
      // Self-healing warm behind a collection listing. Wired only when the
      // renderer exists *and* the operator has left the collection trigger on:
      // absent means the listing route simply never schedules anything.
      ...(cardWarmer !== undefined && config.platformApi.cardWarmOnCollection === true
        ? { cardWarmer }
        : {}),
      // Presentation-only display name + avatar for HTTP clients, which —
      // unlike the Discord handlers — have no gateway of their own to render
      // from. The API layer holds no Discord types, so the lookup is injected
      // here, the one place that owns the client. `withIdentityCache` adds the
      // TTL, the timeout and the failure handling; see src/api/identity.ts.
      resolveIdentity: withIdentityCache(async (discordUserId) => {
        if (!client.isReady()) return null;
        const user = await client.users.fetch(discordUserId);
        return {
          displayName: user.displayName,
          avatarUrl: user.displayAvatarURL({ size: 256, extension: 'png' }),
        };
      }),
    },
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
    // Background warms are detached, so a shutdown would otherwise terminate a
    // worker mid-render and leave the queued cards undone. Bounded by the warm
    // already in flight, and a no-op when none is.
    await cardWarmer?.whenIdle();
    // After the servers, so nothing can queue a new render into a pool that is
    // going away, and before the process exits, so threads are not orphaned.
    // A no-op unless a card was actually drawn — the pool starts lazily.
    await shutdownCardRenderer();
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
