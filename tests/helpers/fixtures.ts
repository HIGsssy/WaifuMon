import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { items, type ItemRow } from '../../src/db/schema';
import { loadContent } from '../../src/modules/content/loader';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { seedContent } from '../../src/modules/content/seeder';
import { createCurrencyService } from '../../src/modules/currency/currencyService';
import { createDailyService } from '../../src/modules/daily/dailyService';
import { createGuildService } from '../../src/modules/guilds/guildService';
import { createHuntService } from '../../src/modules/hunt/huntService';
import { createCaptureService } from '../../src/modules/capture/captureService';
import { createCareService } from '../../src/modules/care/careService';
import { createCollectionService } from '../../src/modules/collection/collectionService';
import { createProgressionService } from '../../src/modules/progression/progressionService';
import { createQuestService } from '../../src/modules/quests/questService';
import { createInventoryService } from '../../src/modules/inventory/inventoryService';
import { createPlayerService } from '../../src/modules/players/playerService';
import { createShopService } from '../../src/modules/shop/shopService';
import { createSessionService } from '../../src/modules/session/sessionService';
import type { Rng } from '../../src/shared/random';
import type { Logger } from '../../src/shared/logger';
import { silentLogger, type TestDb } from './testDb';

export const CONTENT_DIR = path.resolve(__dirname, '..', '..', 'content');
export const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets');

export function loadShippedContent(logger: Logger = silentLogger()): LoadedContent {
  return loadContent(CONTENT_DIR, ASSETS_DIR, logger);
}

export interface App {
  content: LoadedContent;
  guilds: ReturnType<typeof createGuildService>;
  players: ReturnType<typeof createPlayerService>;
  currency: ReturnType<typeof createCurrencyService>;
  inventory: ReturnType<typeof createInventoryService>;
  daily: ReturnType<typeof createDailyService>;
  shop: ReturnType<typeof createShopService>;
  hunt: ReturnType<typeof createHuntService>;
  capture: ReturnType<typeof createCaptureService>;
  care: ReturnType<typeof createCareService>;
  collection: ReturnType<typeof createCollectionService>;
  progression: ReturnType<typeof createProgressionService>;
  quests: ReturnType<typeof createQuestService>;
  session: ReturnType<typeof createSessionService>;
}

export interface BootstrapOptions {
  timezone?: string;
  huntRng?: Rng;
  captureRng?: Rng;
  dailyRng?: Rng;
  /**
   * Whether the daily launch splash is enabled for this test app. Defaults
   * to `false` so pre-existing tests continue to exercise the main menu
   * directly on `/waifumon`. Splash-specific tests opt in with `true`.
   */
  splashEnabled?: boolean;
}

/** Wires all services against a test database with the shipped content seeded. */
export async function bootstrapApp(
  t: TestDb,
  timezoneOrOpts: string | BootstrapOptions = 'UTC',
): Promise<App> {
  const opts: BootstrapOptions =
    typeof timezoneOrOpts === 'string' ? { timezone: timezoneOrOpts } : timezoneOrOpts;
  const timezone = opts.timezone ?? 'UTC';
  const loaded = loadShippedContent(t.logger);
  // Override the shipped splash config on a per-test basis without touching
  // tables.json. Splash-specific tests pass `splashEnabled: true`; every
  // other test keeps the pre-splash behavior of `/waifumon` opening the menu.
  const content: LoadedContent = {
    ...loaded,
    tables: {
      ...loaded.tables,
      uiSplash: {
        ...(loaded.tables.uiSplash ?? {
          enabled: false,
          title: 'Welcome to Waifumon',
          body: [],
          imagePath: null,
          buttonLabel: 'Start Hunt',
          frequency: 'daily',
        }),
        enabled: opts.splashEnabled ?? false,
      },
    },
  };
  await seedContent(t.db, content, t.logger);
  const currency = createCurrencyService(t.db);
  const inventory = createInventoryService(t.db);
  const progression = createProgressionService({
    config: content.tables.progression,
    baseMaxEnergy: content.tables.energy.baseMax,
  });
  const quests = createQuestService({
    db: t.db,
    currency,
    inventory,
    config: content.tables.dailyQuests,
    timezone,
    logger: t.logger,
  });
  const collection = createCollectionService({
    db: t.db,
    currency,
    quests,
    duplicateConfig: content.tables.duplicate,
    waifuConfig: content.tables.waifuProgression,
    totalSpeciesCount: content.species.filter((s) => s.enabled).length,
  });
  const care = createCareService({
    db: t.db,
    currency,
    collection,
    progression,
    quests,
    careConfig: content.tables.energy.careMode,
  });
  return {
    content,
    guilds: createGuildService(t.db),
    players: createPlayerService(t.db, { initialEnergy: content.tables.energy.baseMax }),
    currency,
    inventory,
    progression,
    daily: createDailyService({
      db: t.db,
      currency,
      inventory,
      progression,
      care,
      tables: content.tables,
      timezone,
      ...(opts.dailyRng ? { rng: opts.dailyRng } : {}),
    }),
    shop: createShopService({
      db: t.db,
      currency,
      inventory,
      captureCapacity: content.tables.inventory.captureCapacity,
    }),
    hunt: createHuntService({
      db: t.db,
      currency,
      inventory,
      progression,
      collection,
      care,
      quests,
      tables: content.tables,
      logger: t.logger,
      ...(opts.huntRng ? { rng: opts.huntRng } : {}),
    }),
    capture: createCaptureService({
      db: t.db,
      inventory,
      progression,
      progressionConfig: content.tables.progression,
      captureConfig: content.tables.capture,
      buddyAffinityConfig: content.tables.buddyAffinity,
      collection,
      quests,
      logger: t.logger,
      ...(opts.captureRng ? { rng: opts.captureRng } : {}),
    }),
    care,
    collection,
    quests,
    session: createSessionService({
      db: t.db,
      timezone,
      inactiveTimeoutMinutes: content.tables.session?.inactiveTimeoutMinutes,
    }),
  };
}

/** Provisions a guild + player and returns the player id. */
export async function provisionPlayer(
  app: App,
  discordGuildId = 'g-1',
  discordUserId = 'u-1',
): Promise<{ guildDbId: number; playerId: number }> {
  const guild = await app.guilds.ensureGuild(discordGuildId);
  const player = await app.players.ensurePlayer(guild.id, discordUserId);
  return { guildDbId: guild.id, playerId: player.id };
}

export async function getItemBySlug(db: Db, slug: string): Promise<ItemRow> {
  const [row] = await db.select().from(items).where(eq(items.slug, slug));
  if (!row) throw new Error(`Missing seeded item: ${slug}`);
  return row;
}
