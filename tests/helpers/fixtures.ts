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
import { createInventoryService } from '../../src/modules/inventory/inventoryService';
import { createPlayerService } from '../../src/modules/players/playerService';
import { createShopService } from '../../src/modules/shop/shopService';
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
}

export interface BootstrapOptions {
  timezone?: string;
  huntRng?: Rng;
}

/** Wires all services against a test database with the shipped content seeded. */
export async function bootstrapApp(
  t: TestDb,
  timezoneOrOpts: string | BootstrapOptions = 'UTC',
): Promise<App> {
  const opts: BootstrapOptions =
    typeof timezoneOrOpts === 'string' ? { timezone: timezoneOrOpts } : timezoneOrOpts;
  const timezone = opts.timezone ?? 'UTC';
  const content = loadShippedContent(t.logger);
  await seedContent(t.db, content, t.logger);
  const currency = createCurrencyService(t.db);
  const inventory = createInventoryService(t.db);
  return {
    content,
    guilds: createGuildService(t.db),
    players: createPlayerService(t.db, { initialEnergy: content.tables.energy.baseMax }),
    currency,
    inventory,
    daily: createDailyService({
      db: t.db,
      currency,
      inventory,
      tables: content.tables,
      timezone,
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
      tables: content.tables,
      logger: t.logger,
      ...(opts.huntRng ? { rng: opts.huntRng } : {}),
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
