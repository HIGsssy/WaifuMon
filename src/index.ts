/**
 * Startup order (plan §26): validate env → retry-connect to Postgres →
 * run migrations → load/validate/seed content & assets → register slash
 * commands → Discord login. Fail fast and loud before Discord login.
 * The optional admin web panel starts last, and only when enabled.
 */
import { startAdminServer } from './admin/server';
import { startPlatformApi } from './api/server';
import { withIdentityCache } from './api/identity';
import { createPortalSessionService } from './api/portalSession';
import { loadConfig, testAdminControlsAllowed } from './config/config';
import { connectWithRetry, createDb, createPool } from './db/client';
import { runMigrations } from './db/migrate';
import { createDiscordClient } from './discord/client';
import { registerCommands } from './discord/commandRegistry';
import type { AppContext } from './discord/types';
import { createAdminContentService } from './modules/content/adminContentService';
import { createContentReloader } from './modules/content/reloadService';
import { resolveExistingAssetFile } from './modules/assets/assetContainment';
import { createCurrencyService } from './modules/currency/currencyService';
import { createEssenceAwardService } from './modules/currency/essenceAwardService';
import { createDailyService } from './modules/daily/dailyService';
import { createGuildService } from './modules/guilds/guildService';
import { createInventoryService } from './modules/inventory/inventoryService';
import { createPlayerService } from './modules/players/playerService';
import { createShopService } from './modules/shop/shopService';
import { createTravelService } from './modules/travel/travelService';
import { createKeyItemService } from './modules/keyItems/keyItemService';
import { createHuntService } from './modules/hunt/huntService';
import { createWildEncounterSpawner } from './modules/encounters/wildEncounterSpawner';
import {
  createFilteredSpeciesPicker,
  createSpeciesSelectorService,
  raceResolverFromContent,
} from './modules/encounters/speciesSelection';
import { createCaptureService } from './modules/capture/captureService';
import { createCareService } from './modules/care/careService';
import { createWorldEncounterService } from './modules/worldEncounters/worldEncounterService';
import { createWorldEncounterSettingsService } from './modules/worldEncounters/settingsService';
import { createResultPresentationService } from './modules/resultPresentation/resultPresentationService';
import { createWorldEncounterAdminService } from './modules/worldEncounters/adminService';
import { createEncounterPromotionService } from './modules/worldEncounters/encounterImportService';
import { seedWorldEncounters } from './modules/worldEncounters/seed';
import { createFeatureUnlockService } from './modules/features/featureUnlockService';
import { createEquipmentService } from './modules/equipment/equipmentService';
import {
  auditRewardTableSelectors,
  createEquipmentRewardService,
  listRewardableDefinitions,
} from './modules/equipment/equipmentRewardService';
import { describeEquipmentSelector } from './modules/equipment/rewardSelector';
import { rewardTables as rewardTablesTable } from './db/schema';
import {
  databaseRewardTableSource,
  loadShippedRewardTables,
  parseRewardTableRow,
  seedRewardTables,
} from './modules/rewardTables/rewardTableStore';
import { createRewardTableService } from './modules/rewardTables/rewardTableService';
import { loadShippedDungeonZones, seedDungeonZones } from './modules/dungeons/dungeonZoneStore';
import { createDungeonZoneService } from './modules/dungeons/dungeonZoneService';
import { createDungeonRunService } from './modules/dungeons/dungeonRunService';
import { createDungeonPlayService } from './modules/dungeons/dungeonPlayService';
import { createDungeonAllowanceService } from './modules/dungeons/dungeonAllowanceService';
import { createProgressionCurrencyService } from './modules/progressionCurrency/progressionCurrencyService';
import { buildAffixCatalogue } from './modules/equipment/affixCatalogue';
import { readUnknownAffixKeys } from './modules/equipment/equipmentQueries';
import { createEquipmentDefinitionService } from './modules/equipment/equipmentDefinitionService';
import { createCombatStatsService } from './modules/equipment/combatStatsService';
import { createEquipmentManagementService } from './modules/equipment/equipmentManagementService';
import { createEquipmentWorkshopService } from './modules/equipment/equipmentWorkshopService';
import {
  combatTrialCatalogueFromContent,
  createCombatTrialService,
} from './modules/combatTrials/combatTrialService';
import { createEquipmentOnboardingService } from './modules/onboarding/equipmentOnboardingService';
import { equipmentOnboardingLevelLabels } from './modules/onboarding/onboardingState';
import { createEquipmentPromotionService } from './modules/equipment/equipmentImportService';
import {
  loadEquipmentSeedCatalogue,
  seedEquipmentDefinitions,
} from './modules/equipment/seed';
import {
  createWorldEncounterVendorService,
  seedWorldEncounterVendors,
} from './modules/worldEncounters/vendorService';
import { createGuildOwnershipService } from './modules/portalAuth/guildOwnershipService';
import { createGuildRoleService } from './modules/portalAuth/guildRoleService';
import { createAdminRoleGrantService } from './modules/portalAuth/adminRoleGrantService';
import { createPortalAuthorizationService } from './modules/portalAuth/portalAuthService';
import { createStagingTestControlsService } from './modules/testControls/stagingTestControlsService';
import { createAppearanceService } from './modules/appearance/appearanceService';
import {
  configureCardRenderer,
  getCardRenderer,
  peekCardRenderer,
  shutdownCardRenderer,
} from './modules/cards';
import { EventLoopMonitor, LatencyRecorder, SystemSampler } from './shared/metrics';
import { OwnedCardWarmer } from './modules/appearance/ownedCardWarm';
import { listOwnedWarmSubjects } from './modules/appearance/ownedCardWarmSubjects';
import { createCollectionService } from './modules/collection/collectionService';
import {
  createCoreAvailabilityProvider,
  createWaifuAvailabilityService,
} from './modules/collection/waifuAvailability';
import {
  createExpeditionService,
  type ExpeditionService,
} from './modules/expeditions/expeditionService';
import { createAchievementService } from './modules/achievements/achievementService';
import { loadAchievementDefinitions } from './modules/achievements/achievementDefinitions';
import { createLeaderboardService } from './modules/leaderboards/leaderboardService';
import { createPlayerEffectsService } from './modules/effects/playerEffectsService';
import { createItemUseService } from './modules/items/itemUseService';
import { createAffectionGiftService } from './modules/gifts/affectionGiftService';
import { createProgressionService } from './modules/progression/progressionService';
import { createBuddyBonusService } from './modules/buddyBonus/buddyBonusService';
import { createQuestService } from './modules/quests/questService';
import { createSessionService } from './modules/session/sessionService';
import { createGameEventBus, emitGameEvents, gameEvent } from './modules/events/gameEvents';
import { createBossEncounterService } from './modules/bosses/bossEncounterService';
import { createBossScheduler } from './modules/bosses/bossScheduler';
import { createBossAnnouncer } from './discord/bossAnnouncer';
import { createHuntSessionTracker } from './modules/hunt/huntSession';
import { createCollectionFilterTracker } from './discord/collectionFilterTracker';
import { createEphemeralRegistry } from './discord/ephemeralCleanup';
import { createActivityFeedService } from './modules/activity/activityFeedService';
import { resolveAppearanceAsset } from './modules/appearance/assetResolver';
import { artworkAttachmentFilename } from './modules/assets/artworkPath';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import {
  createTrainerProfileService,
  type ProfileChannel,
} from './discord/trainerProfile';
import { ownedCardImage } from './discord/assets/attachRenderedCard';
import { createLogger } from './shared/logger';
import { buildMetricsReport } from './api/routes/metrics';
import { PORTAL_SESSION_COOKIE } from './api/portalSession';
import { DEFAULT_CACHE_ROOT } from './modules/cards';
import { LoadTestController } from './modules/loadTest/controller';
import { createColdCardService, createRunPreparer } from './modules/loadTest/wiring';
import { createLoadTestRunStore } from './modules/loadTest/store';
import { describeHost } from './modules/loadTest/metricsSnapshot';

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
  // Boss and expedition reward tables as shipped in Git, read raw so a seeded
  // row exports back to the file it came from. The database is authoritative
  // once seeded (below); these are the defaults and the "reset" target.
  const shippedRewardTables = loadShippedRewardTables(config.contentDir);
  // Dungeon zones follow the same model: the shipped file is the default and
  // the "matches Git" reference; the database row is authoritative once seeded.
  const shippedDungeonZones = loadShippedDungeonZones(config.contentDir);

  const currency = createCurrencyService(db);
  const inventory = createInventoryService(db);
  /**
   * Buddy Bonuses. Reads the live content snapshot through the same closure
   * the appearance / boss / travel services use, so a retuned bonus ships with
   * an admin "Save + Reload" rather than a restart. Declared before the
   * gameplay services because every one of them takes it.
   *
   * `contentSnapshot` is the one mutable content handle every getter-based
   * service reads through; the admin panel's Reload Content action reassigns
   * it and every closure follows.
   */
  let contentSnapshot = content;
  const buddyBonus = createBuddyBonusService({ getContent: () => contentSnapshot });
  /**
   * The one gameplay path for awarding Essence. Every reward that a player
   * *earned* goes through this rather than `currency.grantEssence`, which
   * stays the raw system mutation for admin grants and compensation. Declared
   * next to `buddyBonus` because it is the same kind of thing: a cross-cutting
   * rule the reward services depend on rather than re-implement.
   */
  const essenceAward = createEssenceAwardService({ currency, buddyBonus });
  const leaderboards = createLeaderboardService(db);
  const worldEncounterVendorService = createWorldEncounterVendorService({
    db,
    currency,
    inventory,
  });
  /**
   * Live encounter tuning. Replaces the `content/tables.json` values these
   * four settings used to come from — the row seeds itself from the identical
   * defaults, so this changes nothing until an operator edits it in Portal
   * Admin, and then it changes things immediately.
   */
  const worldEncounterSettings = createWorldEncounterSettingsService({ db, logger });
  /**
   * Authored presentation for hunt finds and Let Her Go. Presentation only —
   * it owns its own randomness and is read after gameplay commits, so an
   * empty table (or a broken one) simply means the built-in screens.
   */
  const resultPresentation = createResultPresentationService({ db, logger });
  const equipmentOnboardingEnabled = config.equipmentOnboarding?.enabled === true;
  const progression = createProgressionService({
    config: content.tables.progression,
    baseMaxEnergy: content.tables.energy.baseMax,
    buddyBonus,
    // Announces the Equipment onboarding on the level-up screen that reaches
    // its level. A label only — the onboarding itself waits in the main menu.
    extraLevelRewardLabels: (level) =>
      equipmentOnboardingLevelLabels(level, {
        enabled: equipmentOnboardingEnabled,
        label: contentSnapshot.onboarding?.equipment?.levelUpLabel,
      }),
  });
  const quests = createQuestService({
    db,
    currency,
    essenceAward,
    inventory,
    config: content.tables.dailyQuests,
    timezone: config.dailyTimezone,
    logger,
  });
  // Cosmetic appearances. Reads the content snapshot through a getter so an
  // admin-panel "Save + Reload" makes newly-authored artwork available (and
  // retroactively unlockable) without a restart — `ctx.content` is reassigned
  // below, and this closure follows it.
  const appearance = createAppearanceService({ db, getContent: () => contentSnapshot });

  /**
   * Waifu availability, and the one knot in this graph.
   *
   * Expeditions depend on collection (they award XP to the deployed copy), and
   * collection depends on availability, which depends on expeditions to answer
   * "is she away". That is a genuine cycle in the *data*, not a mistake in the
   * layering — so it is tied here, at the composition root, with a late-bound
   * closure rather than by making any module import another one backwards.
   *
   * Before `expeditions` is assigned the provider reports nothing, which is
   * correct: nothing can be on an expedition before the expedition service
   * exists to have deployed it.
   */
  /**
   * Hoisted above expeditions, which now needs it: a deployment is only legal
   * from the region the mission belongs to, and this is the canonical answer
   * to "where is the player". Travel itself depends on nothing in the
   * availability knot below, so the move is a reordering and not a new edge.
   */
  // Key-item recipes (the Transporter Beacon). Travel reads their progress to
  // explain a key-gated destination, so this is built first.
  const keyItems = createKeyItemService({
    db,
    currency,
    inventory,
    getContent: () => contentSnapshot,
  });
  const travel = createTravelService({
    db,
    currency,
    inventory,
    keyItems,
    // Same `contentSnapshot` closure the appearance and boss services use,
    // so an admin Reload Content republishes prices and destinations
    // without a restart.
    getContent: () => contentSnapshot,
  });

  // Achievement definitions are content, validated on load like every other
  // content file. Static for Phase 1 (no admin editing), so they are read once
  // here rather than through the reload pipeline.
  // Built after travel: "regions unlocked" is a travel-catalog question now
  // that the Assteroid Belt is reached by a key item rather than a route row.
  const achievements = createAchievementService(
    db,
    loadAchievementDefinitions(config.contentDir),
    (playerId) => travel.accessibleRegions(playerId),
  );
  let expeditions: ExpeditionService | undefined;
  const availability = createWaifuAvailabilityService({
    bulkProviders: [
      createCoreAvailabilityProvider(),
      (tx, playerId, waifuIds) =>
        expeditions?.unavailabilityFor(tx, playerId, waifuIds) ?? Promise.resolve(new Map()),
    ],
  });

  const collection = createCollectionService({
    db,
    currency,
    essenceAward,
    quests,
    appearance,
    duplicateConfig: content.tables.duplicate,
    waifuConfig: content.tables.waifuProgression,
    buddyBonus,
    availability,
  });
  /**
   * Equipment (Phase 1: domain only — no Discord screen or API route reads
   * these yet). `combatStats` resolves the Buddy through the collection's own
   * self-healing read and follows `maxLevel` through the live content getter.
   */
  const featureUnlocks = createFeatureUnlockService(db);
  // The affix catalogue follows content reloads; rebuilt only when the
  // snapshot's list actually changes, not on every read.
  // An owned item naming an affix the catalogue no longer has (deleted rather
  // than retired) renders "[Unknown Affix]" and is logged — once per key per
  // catalogue, so a busy Gear Bag cannot flood the log.
  let affixSource: typeof contentSnapshot.equipmentAffixes | null = null;
  let affixCatalogue = buildAffixCatalogue([]);
  const getAffixes = () => {
    if (contentSnapshot.equipmentAffixes !== affixSource) {
      affixSource = contentSnapshot.equipmentAffixes;
      const reported = new Set<string>();
      affixCatalogue = buildAffixCatalogue(affixSource ?? [], {
        onUnknownKey: (affixKey) => {
          if (reported.has(affixKey)) return;
          reported.add(affixKey);
          logger.error(
            { tag: 'equipment/unknown-affix', affixKey },
            'owned equipment names an affix missing from content/equipment/affixes.json — restore it (disable, never delete)',
          );
        },
      });
    }
    return affixCatalogue;
  };
  const equipment = createEquipmentService({ db, featureUnlocks, getAffixes });
  // The one path World Encounters, bosses and expeditions hand out random gear
  // through: they choose *whether* and *which kind*; it picks the base
  // definition and `grantEquipment` rolls the instance.
  const equipmentRewards = createEquipmentRewardService({ equipment, getAffixes, featureUnlocks });
  const equipmentDefinitions = createEquipmentDefinitionService(db);
  const combatStats = createCombatStatsService({
    db,
    resolveActiveBuddy: (tx, playerId) => collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => contentSnapshot.tables.waifuProgression.maxLevel,
    getAffixes,
  });
  const equipmentPromotion = createEquipmentPromotionService({ db });
  /**
   * Equipment onboarding (Phase 2A): Patch, the three starters and the
   * `equipment` unlock, delivered from the main menu. Gated by
   * `EQUIPMENT_ONBOARDING_ENABLED`; the read-only overview it serves to
   * unlocked players is not.
   */
  /**
   * Equipment management (Phase 2B): the Discord home, slot, Gear Bag and item
   * screens. Gated by the `equipment` unlock on every call — never by the
   * onboarding switch.
   */
  const equipmentManagement = createEquipmentManagementService({ equipment, combatStats, featureUnlocks });
  /**
   * Patch's Workshop: dismantle gear for Salvaged Components, spend them (and
   * WaifuBux) on fabrication through the shared random-reward path. Yields and
   * recipes follow `content/equipment/workshop.json` through content reloads.
   */
  const equipmentWorkshop = createEquipmentWorkshopService({
    db,
    featureUnlocks,
    equipment,
    equipmentRewards,
    currency,
    getAffixes,
    getConfig: () => contentSnapshot.equipmentWorkshop ?? null,
  });
  /**
   * Combat Trials: automatic fights against content-defined enemies, gated by
   * the `equipment` unlock. Stats from `combatStats`, Trials and enemies from
   * the live content snapshot.
   */
  const combatTrials = createCombatTrialService({
    db,
    featureUnlocks,
    combatStats,
    currency,
    inventory,
    getCatalogue: () => combatTrialCatalogueFromContent(contentSnapshot),
  });
  /**
   * Dungeons. Zones are authored in Portal Admin; the run service generates
   * and snapshots a run; the play service is what a player drives — it starts
   * runs with a fighter snapshot from `combatStats` and resolves nodes through
   * the combat engine and the shared Equipment reward path. Enemies and events
   * follow the live content snapshot through reloads.
   */
  const progressionCurrency = createProgressionCurrencyService(db);
  const dungeonZones = createDungeonZoneService({
    db,
    getContent: () => contentSnapshot,
    getShipped: () => shippedDungeonZones,
  });
  const dungeonRuns = createDungeonRunService({
    db,
    getContent: () => contentSnapshot,
    currencies: progressionCurrency,
  });
  const dungeonAllowance = createDungeonAllowanceService({ db, timezone: config.dailyTimezone, logger });
  const dungeonPlay = createDungeonPlayService({
    db,
    runs: dungeonRuns,
    allowance: dungeonAllowance,
    featureUnlocks,
    combatStats,
    currencies: progressionCurrency,
    currency,
    inventory,
    equipmentRewards,
    logger,
  });
  const equipmentOnboarding = createEquipmentOnboardingService({
    db,
    equipment,
    featureUnlocks,
    combatStats,
    resolveActiveBuddy: (tx, playerId) => collection.resolveActiveBuddy(tx, playerId),
    getContent: () => contentSnapshot,
    isEnabled: () => equipmentOnboardingEnabled,
    logger,
  });

  const care = createCareService({
    db,
    currency,
    collection,
    progression,
    quests,
    appearance,
    careConfig: content.tables.energy.careMode,
    buddyBonus,
    availability,
  });
  // Ties the knot opened above. Everything it needs exists by this line.
  expeditions = createExpeditionService({
    db,
    logger,
    getContent: () => contentSnapshot,
    resolveRace: raceResolverFromContent(() => contentSnapshot),
    currency,
    essenceAward,
    inventory,
    collection,
    progression,
    availability,
    equipmentRewards,
    rewardTables: databaseRewardTableSource,
    // The narrow location port. Passed as a bound method rather than the whole
    // service so expeditions cannot reach for a route or a pass.
    getCurrentRegion: (playerId) => travel.getCurrentRegion(playerId),
  });
  const effects = createPlayerEffectsService(db);
  // Hoisted above the context literal because CaptureService now takes it:
  // the encounter-time Microdose is spent through this one service, inside
  // the transaction that locks the encounter.
  const itemUse = createItemUseService({
    db,
    currency,
    inventory,
    effects,
    progression,
    care,
    collection,
  });
  // Affection gifts. Built before the context because DailyService takes it —
  // the daily claim is the authoritative daily reset the roll rides inside.
  const gifts = createAffectionGiftService({
    db,
    inventory,
    collection,
    config: content.tables.affectionGifts,
    captureCapacity: content.tables.inventory.captureCapacity,
    timezone: config.dailyTimezone,
    logger,
  });
  /**
   * Boss encounters (Stage 1).
   *
   * Built only when content actually enables them, and left `undefined`
   * otherwise. That is the whole feature gate: with no service on the context,
   * the admin commands say the feature is not enabled, the buttons read as
   * stale, and no scheduler ever starts — rather than a live scheduler that
   * checks a flag on every pass.
   *
   * Reads content through the same `contentSnapshot` closure the appearance
   * service uses, so an admin "Save + Reload" makes a newly-authored boss
   * drawable without a restart.
   */
  const bosses = content.tables.bossEncounters.enabled
    ? createBossEncounterService({
        db,
        inventory,
        collection,
        getContent: () => contentSnapshot,
        buddyBonus,
        equipmentRewards,
        rewardTables: databaseRewardTableSource,
        logger,
      })
    : undefined;

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

  // Hoisted out of the services literal because two things need to reference
  // it: the literal itself, and the wild-encounter spawner, which borrows the
  // hunt's own region/rarity draw rather than restating it.
  const huntService = createHuntService({
    db,
    currency,
    essenceAward,
    inventory,
    progression,
    collection,
    care,
    quests,
    tables: content.tables,
    buddyBonus,
    logger,
  });

  /**
   * The one way anything but a hunt puts a wild Waifumon in front of a player.
   * Phase 2 wires `trigger_waifumon_encounter` to it; quests, items, events,
   * exploration and deity rewards are meant to reuse the same seam.
   */
  // Filtered selectors: the hunt's rarity weights conditioned on the authored
  // filter, with race read from the live content snapshot. One instance,
  // shared by the spawner and by Portal previews, so an authoring preview is
  // the runtime's answer rather than a second implementation of it.
  const pickFilteredSpecies = createFilteredSpeciesPicker({
    resolveRace: raceResolverFromContent(() => contentSnapshot),
    rarityWeightsFor: (level) => huntService.spawnRarityWeights(level),
  });
  const speciesSelector = createSpeciesSelectorService(db, pickFilteredSpecies);
  const wildEncounters = createWildEncounterSpawner({
    db,
    currency,
    logger,
    getDefaultExpirySeconds: () => contentSnapshot.tables.hunt.encounterExpirySeconds,
    pickSpecies: (tx, playerId, playerLevel, regionId) =>
      huntService.pickSpeciesForSpawn(tx, playerId, playerLevel, regionId),
    pickFilteredSpecies,
  });

  const ctx: AppContext = {
    config,
    logger,
    db,
    content,
    events: gameEventBus,
    huntSessions,
    collectionFilters: createCollectionFilterTracker(),
    ephemerals: createEphemeralRegistry(),
    ...(cardWarmer === undefined ? {} : { cardWarmer }),
    services: {
      guilds,
      players: createPlayerService(db, { initialEnergy: content.tables.energy.baseMax }),
      currency,
      inventory,
      progression,
      expeditions,
      availability,
      daily: createDailyService({
        db,
        currency,
        inventory,
        progression,
        care,
        gifts,
        tables: content.tables,
        timezone: config.dailyTimezone,
      }),
      travel,
      keyItems,
      shop: createShopService({
        db,
        currency,
        inventory,
        captureCapacity: content.tables.inventory.captureCapacity,
      }),
      hunt: huntService,
      capture: createCaptureService({
        db,
        inventory,
        progression,
        progressionConfig: content.tables.progression,
        captureConfig: content.tables.capture,
        buddyAffinityConfig: content.tables.buddyAffinity,
        seductivePowerConfig: content.tables.seductivePower,
        collection,
        quests,
        effects,
        itemUse,
        appearance,
        buddyBonus,
        logger,
      }),
      care,
      collection,
      achievements,
      leaderboards,
      appearance,
      quests,
      effects,
      itemUse,
      gifts,
      session: createSessionService({
        db,
        timezone: config.dailyTimezone,
      }),
      ...(bosses === undefined ? {} : { bosses }),
      worldEncounter: createWorldEncounterService({
        db,
        currency,
        essenceAward,
        inventory,
        progression,
        collection,
        buddyBonus,
        equipmentRewards,
        vendor: worldEncounterVendorService,
        wildEncounters,
        // Read per roll, from the database, through a short-TTL cache — so a
        // save in Portal Admin is felt by the next hunt with no redeploy and
        // no content reload.
        getConfig: () => worldEncounterSettings.get(),
        getMaxWaifuLevel: () => contentSnapshot.tables.waifuProgression.maxLevel,
        // One `world-encounter/roll` line per roll. The gates after the dice
        // (cooldowns, region/route scoping, the one-pending rule) are
        // otherwise indistinguishable from a lost roll in production.
        logger,
      }),
      worldEncounterAdmin: createWorldEncounterAdminService(db, () => contentSnapshot),
      // Content promotion: staging exports a package, production imports it.
      // `artworkExists` lets a preview warn about images that have not been
      // deployed yet without ever failing the import for them.
      encounterPromotion: createEncounterPromotionService({
        db,
        getContent: () => contentSnapshot,
        // A path the resolver refuses (traversal, escape) is not "missing" —
        // the planner rejects it on its own terms.
        artworkExists: (relative) =>
          resolveExistingAssetFile(config.assetsDir, relative).status !== 'missing',
      }),
      worldEncounterVendor: worldEncounterVendorService,
      rewardTables: createRewardTableService({
        db,
        getContent: () => contentSnapshot,
        getShipped: () => shippedRewardTables,
      }),
      worldEncounterSettings,
      wildEncounters,
      speciesSelector,
      resultPresentation,
      equipment,
      equipmentDefinitions,
      combatStats,
      equipmentPromotion,
      featureUnlocks,
      equipmentOnboarding,
      equipmentManagement,
      combatTrials,
      equipmentWorkshop,
      dungeonZones,
      dungeonRuns,
      dungeonPlay,
      dungeonAllowance,
      progressionCurrency,
    },
  };

  // Best-effort startup sweep: mark expired encounters closed after downtime.
  const expired = await ctx.services.hunt.expireStale();
  if (expired > 0) logger.info({ expired }, 'swept stale active encounters');

  // Bootstrap world encounters and vendors: insert any shipped slug/key that
  // is missing, and leave every existing one exactly as it is. The database
  // owns live encounter content — Portal edits survive restarts and deploys,
  // and changed content reaches a live server through export/import only.
  try {
    const seedResult = await seedWorldEncounters(db, { mode: 'insert-missing' });
    if (seedResult.created.length > 0) {
      logger.info({ created: seedResult.created }, 'seeded missing world encounters');
    }
    await seedWorldEncounterVendors(db, { mode: 'insert-missing' });
  } catch (err) {
    logger.warn({ err }, 'world encounter seed failed — feature will run with whatever is in the DB');
  }

  // Equipment definitions follow the same rule: insert any seeded key that is
  // missing and never touch one that exists. The database owns live
  // definitions; changed content reaches a server through export/import.
  try {
    const equipmentSeed = await seedEquipmentDefinitions(db, {
      mode: 'insert-missing',
      catalogue: loadEquipmentSeedCatalogue(config.contentDir),
    });
    if (equipmentSeed.created.length > 0) {
      logger.info({ created: equipmentSeed.created }, 'seeded missing equipment definitions');
    }
  } catch (err) {
    logger.warn({ err }, 'equipment seed failed — equipment will run with whatever is in the DB');
  }
  // Boss and expedition reward tables: insert any shipped table that is
  // missing, and update one from Git only while its row still holds what was
  // last seeded. A table edited in Portal Admin is never overwritten by a
  // deploy — the divergence is logged, and exporting the table is how the
  // edit reaches Git.
  try {
    const rewardSeed = await seedRewardTables(db, shippedRewardTables);
    if (rewardSeed.created.length > 0 || rewardSeed.updated.length > 0 || rewardSeed.adopted.length > 0) {
      logger.info(
        {
          tag: 'reward-tables/seed',
          created: rewardSeed.created,
          updated: rewardSeed.updated,
          adopted: rewardSeed.adopted,
        },
        'seeded reward tables from shipped content',
      );
    }
    for (const d of rewardSeed.diverged) {
      const fields = { tag: 'reward-tables/diverged', ...d };
      if (d.shippedChanged) {
        logger.warn(
          fields,
          `reward table ${d.kind}/${d.id} was edited in Portal Admin and Git has also changed it — ` +
            'the shipped change was NOT applied. Export the live table to reconcile, or reset it to shipped.',
        );
      } else {
        logger.info(fields, `reward table ${d.kind}/${d.id} keeps its Portal Admin edit (differs from Git)`);
      }
    }
  } catch (err) {
    logger.error({ err }, 'reward table seed failed — bosses and expeditions will use whatever is in the DB');
  }
  // Dungeon zones, seeded like reward tables: insert a missing shipped zone,
  // update one from Git only while its row still holds what was last seeded,
  // and never overwrite a zone edited in Portal Admin.
  try {
    const zoneSeed = await seedDungeonZones(db, shippedDungeonZones);
    if (zoneSeed.created.length > 0 || zoneSeed.updated.length > 0 || zoneSeed.adopted.length > 0) {
      logger.info(
        { tag: 'dungeon-zones/seed', created: zoneSeed.created, updated: zoneSeed.updated, adopted: zoneSeed.adopted },
        'seeded dungeon zones from shipped content',
      );
    }
    for (const d of zoneSeed.diverged) {
      const fields = { tag: 'dungeon-zones/diverged', ...d };
      if (d.shippedChanged) {
        logger.warn(
          fields,
          `dungeon zone ${d.key} was edited in Portal Admin and Git has also changed it — ` +
            'the shipped change was NOT applied. Export the live zones to reconcile.',
        );
      } else {
        logger.info(fields, `dungeon zone ${d.key} keeps its Portal Admin edit (differs from Git)`);
      }
    }
    // A seeded zone is not validated against this server by the seed itself;
    // say so now rather than when the first run is refused.
    for (const zone of await dungeonZones.list()) {
      if (!zone.enabled) continue;
      const detail = await dungeonZones.get(zone.key);
      const errors = detail?.issues.filter((i) => i.severity === 'error') ?? [];
      if (errors.length > 0) {
        logger.error(
          { tag: 'dungeon-zones/invalid', zone: zone.key, issues: errors },
          `dungeon zone ${zone.key} is enabled but cannot generate runs on this server until it is fixed`,
        );
      }
    }
  } catch (err) {
    logger.error({ err }, 'dungeon zone seed failed — dungeons will use whatever is in the DB');
  }
  try {
    // Reward tables and gear definitions are both rows, but nothing ties a
    // gear selector to a definition. Check the live tables against this
    // server now, so a bad one is heard about before a spawn skips it or a
    // deploy refuses it.
    const liveTables = await db.select().from(rewardTablesTable);
    const findings = auditRewardTableSelectors(
      liveTables.map((row) => ({
        ...parseRewardTableRow(row),
        label: `${row.kind === 'boss' ? 'bossRewards' : 'expeditionRewards'}["${row.tableId}"]`,
      })),
      await listRewardableDefinitions(db),
    );
    for (const finding of findings) {
      logger.error(
        { tag: 'equipment/reward-selector-invalid', location: finding.location, issues: finding.issues },
        `${finding.location} can never pay "${describeEquipmentSelector(finding.selector)}" on this server — ` +
          'bosses paid from it will not spawn and expedition deploys that reach it will be refused until it is fixed',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'equipment reward selector audit failed');
  }
  try {
    // Affixes are file-backed, so nothing stops a deploy deleting one that
    // players own. Say so loudly at startup rather than on first render.
    const unknownAffixes = await readUnknownAffixKeys(db, getAffixes());
    if (unknownAffixes.length > 0) {
      logger.error(
        { tag: 'equipment/unknown-affix', unknownAffixes },
        'owned equipment references affixes missing from the catalogue — they render as [Unknown Affix]',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'equipment affix reference check failed');
  }
  try {
    const readiness = await equipmentOnboarding.isReady();
    const fields = { tag: 'equipment-onboarding/readiness', enabled: equipmentOnboardingEnabled, ...readiness };
    if (readiness.ready) logger.info(fields, 'equipment onboarding ready');
    else logger.warn(fields, 'equipment onboarding NOT ready — it will not be offered');
  } catch (err) {
    logger.warn({ err }, 'equipment onboarding readiness check failed');
  }

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
    // Alternate-appearance unlock announcements attach the raw artwork so
    // other players see the newly-unlocked look itself, under a filename
    // whose extension matches the file actually resolved. Missing artwork →
    // null, and the feed falls back to a plain text line rather than dropping
    // the announcement.
    resolveAppearanceArtwork: (assetId) => {
      const resolved = resolveAppearanceAsset({ assetsDir: config.assetsDir, logger }, assetId);
      if (!resolved) return null;
      const filename = artworkAttachmentFilename(
        `${assetId.slug}_${assetId.variant}`,
        resolved.absolutePath,
      );
      return filename === null ? null : { absolutePath: resolved.absolutePath, filename };
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
    // The same helper the collection inspect card uses, so the dashboard shows
    // the buddy exactly as inspecting her would: her real level, and the look
    // she is actually wearing.
    renderBuddyCard: (target) => ownedCardImage(ctx, target),
  });
  trainerProfile.subscribe(gameEventBus);

  await client.login(config.discordToken);

  /**
   * Boss scheduler. Started **after** login, because its very first pass
   * verifies channel permissions and posts announcements — both of which need
   * a connected gateway. The first pass also *is* restart recovery: it resumes
   * a live scouting window, re-attempts an announcement that never went up,
   * and finishes a resolution a previous process died partway through.
   */
  const bossScheduler = bosses
    ? (() => {
        const announcer = createBossAnnouncer({ ctx, client, encounters: bosses });
        // Parked on the context so `/waifumon-admin boss end` can republish an
        // encounter's results without reaching into the scheduler.
        ctx.bossAnnouncer = announcer;
        /**
         * Guild-scoped event envelope. Boss events belong to a *server*, not
         * to a player, so the player fields carry the sentinel values the bus
         * requires rather than a fabricated identity — every boss event is
         * `internal` scope and nothing narrates them under a player's name.
         */
        const guildSource = (guildDbId: number, channelId: string | null) => ({
          guildId: '',
          guildDbId,
          playerId: 0,
          playerName: 'Waifu Valley',
          playerMention: '',
          channelId,
        });
        return createBossScheduler({
          db,
          encounters: bosses,
          announcer,
          logger,
          events: {
            encounterStarted: (encounter) =>
              emitGameEvents(gameEventBus, guildSource(encounter.guildId, encounter.channelId), [
                gameEvent('BOSS_ENCOUNTER_STARTED', {
                  encounterId: encounter.id,
                  bossId: encounter.bossId,
                  bossName: encounter.bossName,
                  bossAffinity: encounter.bossAffinity,
                  region: encounter.region,
                  deadlineAt: encounter.deadlineAt?.toISOString() ?? '',
                }),
              ]),
            encounterResolved: (encounter, summary) =>
              emitGameEvents(gameEventBus, guildSource(encounter.guildId, encounter.channelId), [
                gameEvent('BOSS_ENCOUNTER_RESOLVED', {
                  encounterId: encounter.id,
                  bossId: encounter.bossId,
                  bossName: encounter.bossName,
                  ...summary,
                }),
              ]),
            rewardsApplied: (encounter, summary) =>
              emitGameEvents(gameEventBus, guildSource(encounter.guildId, encounter.channelId), [
                gameEvent('BOSS_REWARDS_APPLIED', { encounterId: encounter.id, ...summary }),
              ]),
            schedulingSuspended: (guildDbId, reason, channelId) =>
              emitGameEvents(gameEventBus, guildSource(guildDbId, channelId), [
                gameEvent('BOSS_SCHEDULING_SUSPENDED', { reason, channelId }),
              ]),
          },
        });
      })()
    : undefined;
  bossScheduler?.start();

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
    worldEncounters: createWorldEncounterAdminService(db, () => contentSnapshot),
  });

  // Guild ownership: the Portal admin authorization layer answers "who owns
  // this guild?" through this service. Reads live from the bot's client cache
  // via `guilds.fetch`, falling back to a `null` on any error — meaning
  // "unknown" and therefore no admin permissions.
  const guildOwnership = createGuildOwnershipService({
    fetchOwnerId: async (discordGuildId) => {
      if (!client.isReady()) return null;
      const guild = await client.guilds.fetch(discordGuildId);
      return guild.ownerId;
    },
    logger,
  });
  // Prime the cache from the client's guild cache once ready, and keep it
  // fresh on updates. Guild ownership transfer is rare, but the invalidation
  // is a two-line hook that keeps the cache honest.
  client.once('ready', (readyClient) => {
    for (const g of readyClient.guilds.cache.values()) {
      guildOwnership.set(g.id, g.ownerId);
    }
  });
  client.on('guildUpdate', (before, after) => {
    if (before.ownerId !== after.ownerId) guildOwnership.set(after.id, after.ownerId);
  });
  client.on('guildCreate', (g) => guildOwnership.set(g.id, g.ownerId));

  // Discord role lookups behind delegated Portal Admin access. Same shape as
  // the ownership service and for the same reason: role membership is
  // Discord's state, so it is read live from the gateway rather than stored.
  //
  // `guilds.fetch` and `members.fetch` both serve from the client's cache when
  // it is warm, so the common path is not an HTTP call. Any throw propagates
  // to the service, which logs once and answers "unknown" — no access.
  const guildRoles = createGuildRoleService({
    fetchMemberRoleIds: async (discordGuildId, discordUserId) => {
      if (!client.isReady()) return null;
      const guild = await client.guilds.fetch(discordGuildId);
      // `null` for a user who is not a member: `fetch` throws for an unknown
      // member, which the service already treats as unknown, but being
      // explicit keeps the two "no access" paths readable.
      const member = await guild.members.fetch(discordUserId).catch(() => null);
      if (!member) return null;
      return [...member.roles.cache.keys()];
    },
    fetchGuildRoles: async (discordGuildId) => {
      if (!client.isReady()) return null;
      const guild = await client.guilds.fetch(discordGuildId);
      const roles = await guild.roles.fetch();
      return [...roles.values()]
        .filter((role): role is NonNullable<typeof role> => role != null)
        .map((role) => ({
          id: role.id,
          name: role.name,
          color: role.color,
          position: role.position,
          managed: role.managed,
        }));
    },
    logger,
  });
  // Bound staleness from the gateway rather than only by TTL. A role removed
  // from a member must stop granting admin access promptly, and these are the
  // events Discord already sends us.
  client.on('guildMemberUpdate', (_before, after) => {
    guildRoles.invalidateMember(after.guild.id, after.id);
  });
  client.on('guildMemberRemove', (member) => {
    guildRoles.invalidateMember(member.guild.id, member.id);
  });
  client.on('roleUpdate', (_before, after) => guildRoles.invalidateGuildRoles(after.guild.id));
  client.on('roleCreate', (role) => guildRoles.invalidateGuildRoles(role.guild.id));
  // A deleted role can still be named by a grant row. Authorization already
  // ignores it — nobody holds a role that does not exist — but dropping the
  // cached role list keeps the Portal's picker honest.
  client.on('roleDelete', (role) => guildRoles.invalidateGuildRoles(role.guild.id));

  const adminRoleGrants = createAdminRoleGrantService(db);

  const portalAuthorization = createPortalAuthorizationService({
    guildOwnership,
    guildRoles,
    roleGrants: adminRoleGrants,
    // `system.loadtest.run` is issued to nobody unless this deployment opted in.
    loadTestingEnabled: config.loadTesting?.enabled === true,
    // Likewise `players.testcontrols`: never issued unless the flag is on *and*
    // DEPLOYMENT_ENV is explicitly non-production.
    testControlsEnabled: testAdminControlsAllowed(config.testAdminControls),
  });

  // Attached after construction rather than in the `ctx` literal above: both
  // depend on the Discord client, which is itself built from `ctx`. The
  // Platform API is started further down and reads `ctx.services` then, so it
  // sees both — and the Discord handlers never touch either.
  ctx.services.adminRoleGrants = adminRoleGrants;
  ctx.services.guildRoles = guildRoles;

  /**
   * Runtime instrumentation for capacity measurement.
   *
   * Built here, and only when enabled, because this is the one place that can
   * see all three subjects: the event loop it shares with the gateway, the
   * Postgres pool, and the card renderer. The API layer is handed closures
   * rather than the objects themselves, which is what keeps `api/routes/
   * metrics.ts` free of `pg` and of the cards module — the same arrangement
   * `probes` below uses for the database and the Discord client.
   *
   * The event-loop monitor is started here rather than at the top of `main` so
   * that a deployment with metrics off pays for no libuv timer at all.
   */
  const metrics =
    config.platformApi.metricsEnabled === true
      ? (() => {
          const eventLoop = new EventLoopMonitor();
          eventLoop.start();
          const http = new LatencyRecorder();
          // The one clock for every "right now" reading. It measures CPU as a
          // rate and, at the same instant, closes the HTTP and event-loop
          // collectors' recent intervals — so the Portal dashboard, a shell
          // `curl` and the load harness all see the same ~5 s interval rather
          // than each reader shortening the others'.
          const system = new SystemSampler({
            onSample: () => {
              eventLoop.rotateRecent();
              http.rotateRecent();
            },
            onError: (err) =>
              logger.warn({ err, tag: 'metrics/sample-failed' }, 'system metrics sample failed'),
          });
          system.start();
          return {
            eventLoop,
            system,
            http,
            describeDatabasePool: () => ({
              totalCount: pool.totalCount,
              idleCount: pool.idleCount,
              waitingCount: pool.waitingCount,
              // `options` is public on pg.Pool but not in its typings.
              max: (pool as unknown as { options?: { max?: number } }).options?.max ?? null,
            }),
            // `peek`, never `get`: reading stats must not be what constructs the
            // renderer. See `modules/cards/renderer.ts`.
            describeCardRenderer: () => {
              const stats = peekCardRenderer()?.getStats();
              if (stats === undefined) {
                return {
                  active: false,
                  masterRenders: null,
                  derivativeRenders: null,
                  cacheHits: null,
                  dedupedRenders: null,
                  poolSize: null,
                  workers: null,
                };
              }
              return {
                active: true,
                masterRenders: stats.masterRenders,
                derivativeRenders: stats.derivativeRenders,
                cacheHits: stats.cacheHits,
                dedupedRenders: stats.dedupedRenders,
                poolSize: stats.workerPoolSize ?? null,
                workers: stats.workers ?? null,
              };
            },
          };
        })()
      : undefined;

  const portalSessions = config.portalAuth?.enabled
    ? createPortalSessionService(db, config.portalAuth)
    : undefined;

  /**
   * Load testing — staging only, by configuration.
   *
   * Built only under `LOAD_TESTING_ENABLED=true` (which config validation
   * already refuses without the Platform API and Portal auth). Without it there
   * is no controller, so the admin routes are never registered, and the
   * controller's own constructor refuses besides. The generator it forks runs
   * in a separate process and reaches this one only over loopback HTTP.
   */
  const loadTesting =
    config.loadTesting?.enabled === true && portalSessions !== undefined
      ? new LoadTestController({
          enabled: true,
          baseUrl: resolveLoopbackUrl(config.platformApi.host, config.platformApi.port),
          sessionCookieName: PORTAL_SESSION_COOKIE,
          cardsAvailable: config.platformApi.cardRendererEnabled === true,
          hostLabel: config.loadTesting.hostLabel,
          hostInfo: () =>
            describeHost({
              cardRenderWorkers: config.platformApi.cardRenderWorkers ?? null,
              databasePoolMax:
                (pool as unknown as { options?: { max?: number } }).options?.max ?? null,
            }),
          preparer: createRunPreparer(db, portalSessions),
          cold:
            config.platformApi.cardRendererEnabled === true
              ? createColdCardService({
                  renderer: () => getCardRenderer(),
                  presentation: { appearance, assetsDir: config.assetsDir, logger },
                  cacheRoot: DEFAULT_CACHE_ROOT,
                  maxLevel: () => ctx.content.tables.waifuProgression?.maxLevel ?? 50,
                  rendererBusy: () => {
                    const workers = peekCardRenderer()?.getStats().workers;
                    return workers !== undefined && (workers.active > 0 || workers.queued > 0);
                  },
                  warmer: cardWarmer,
                })
              : undefined,
          store: createLoadTestRunStore(db),
          readMetrics: metrics === undefined ? undefined : () => buildMetricsReport(metrics),
          resetMetrics:
            metrics === undefined
              ? undefined
              : () => {
                  metrics.http.reset();
                  metrics.eventLoop.reset();
                },
          logger,
        })
      : undefined;
  if (loadTesting) {
    logger.warn(
      {
        tag: 'load-test/enabled',
        hostLabel: config.loadTesting?.hostLabel ?? null,
        operatorAllowlist: (config.loadTesting?.operatorDiscordIds.length ?? 0) > 0,
      },
      'LOAD TESTING IS ENABLED on this deployment — Portal owners can generate synthetic load. ' +
        'This must never be set in production.',
    );
  }

  /**
   * Staging Test Controls — non-production only, by configuration.
   *
   * `loadConfig` already refuses to start with the flag on in production; this
   * is the second lock (no service, so no routes), and the service's own
   * constructor and per-call checks are the third.
   */
  const testControls = testAdminControlsAllowed(config.testAdminControls)
    ? createStagingTestControlsService({
        db,
        currency: ctx.services.currency,
        inventory: ctx.services.inventory,
        travel: ctx.services.travel,
        progression: ctx.services.progression,
        getContent: () => ctx.content,
        logger,
        config: config.testAdminControls!,
        equipment,
        featureUnlocks,
        equipmentOnboarding,
        dungeonAllowance,
      })
    : undefined;
  if (testControls) {
    logger.warn(
      { tag: 'test-controls/enabled', deploymentEnv: config.testAdminControls?.deploymentEnv },
      'STAGING TEST CONTROLS ARE ENABLED on this deployment — Portal admins can set player ' +
        'level, WaifuBux, Energy and travel access directly. This must never be set in production.',
    );
  }

  // Platform API: a thin HTTP adapter over the same service layer the Discord
  // handlers call, on its own port and behind its own token. Silent and
  // zero-overhead unless PLATFORM_API_ENABLED=true. It reads `ctx` live rather
  // than capturing it, so a content reload is visible to /ready immediately.
  const platformApi = await startPlatformApi({
    ...(metrics === undefined ? {} : { metrics }),
    config: config.platformApi,
    ...(config.portalAuth?.enabled && portalSessions !== undefined
      ? {
          portalAuth: {
            config: config.portalAuth,
            sessions: portalSessions,
            authorization: portalAuthorization,
          },
        }
      : {}),
    logger,
    ctx: {
      services: ctx.services,
      portalAuthorization,
      // Fail-closed by default: the shared Platform API token stays a read
      // credential unless an operator has deliberately made it administrative.
      adminBearerAllowed: config.platformApi.adminBearer,
      ...(loadTesting === undefined
        ? {}
        : { loadTesting, loadTestingOperatorIds: config.loadTesting?.operatorDiscordIds ?? [] }),
      ...(testControls === undefined ? {} : { testControls }),
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
    // First, so no new pass can start posting into a client that is closing.
    bossScheduler?.stop();
    // Before the API closes: the generator's requests target it, and the run's
    // cleanup (synthetic sessions, cold-render cards) needs the database.
    await loadTesting?.shutdown();
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
    // Holds a libuv timer, so leaving it enabled would be a handle that
    // outlives everything above it.
    metrics?.eventLoop.stop();
    metrics?.system.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Where the generator reaches this process: its own API port, over loopback. */
function resolveLoopbackUrl(host: string, port: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]';
  const target = wildcard ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${target}:${port}`;
}

main().catch((err) => {
  // Logger may not exist yet if config failed — console is the safety net.
  console.error('Fatal startup error:', err);
  process.exit(1);
});
