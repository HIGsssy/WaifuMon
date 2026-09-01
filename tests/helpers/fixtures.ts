import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import {
  items,
  playerWaifus,
  players as playersTable,
  species as speciesTable,
  type ItemRow,
  type PlayerWaifuRow,
} from '../../src/db/schema';
import {
  deterministicBaseSeductivePower,
} from '../../src/modules/power/seductivePowerBackfill';
import { loadContent } from '../../src/modules/content/loader';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { seedContent } from '../../src/modules/content/seeder';
import { createCurrencyService } from '../../src/modules/currency/currencyService';
import { createDailyService } from '../../src/modules/daily/dailyService';
import { createGuildService } from '../../src/modules/guilds/guildService';
import { createHuntService } from '../../src/modules/hunt/huntService';
import { createCaptureService } from '../../src/modules/capture/captureService';
import { createCareService } from '../../src/modules/care/careService';
import { createAppearanceService } from '../../src/modules/appearance/appearanceService';
import { createCollectionService } from '../../src/modules/collection/collectionService';
import { createPlayerEffectsService } from '../../src/modules/effects/playerEffectsService';
import { createItemUseService } from '../../src/modules/items/itemUseService';
import { createAffectionGiftService } from '../../src/modules/gifts/affectionGiftService';
import { createProgressionService } from '../../src/modules/progression/progressionService';
import { createBuddyBonusService } from '../../src/modules/buddyBonus/buddyBonusService';
import { createQuestService } from '../../src/modules/quests/questService';
import { createInventoryService } from '../../src/modules/inventory/inventoryService';
import { createPlayerService } from '../../src/modules/players/playerService';
import { createShopService } from '../../src/modules/shop/shopService';
import { createSessionService } from '../../src/modules/session/sessionService';
import { createBossEncounterService } from '../../src/modules/bosses/bossEncounterService';
import { createTravelService } from '../../src/modules/travel/travelService';
import {
  createGameEventBus,
  type GameEvent,
  type GameEventBus,
} from '../../src/modules/events/gameEvents';
import {
  createHuntSessionTracker,
  type HuntSessionTracker,
} from '../../src/modules/hunt/huntSession';
import {
  createActivityFeedService,
  type ActivityFeedService,
} from '../../src/modules/activity/activityFeedService';
import type { EventVisibility } from '../../src/modules/events/gameEvents';
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
  /** Active Buddy Bonus resolver, wired into every service that reads it. */
  buddyBonus: ReturnType<typeof createBuddyBonusService>;
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
  appearance: ReturnType<typeof createAppearanceService>;
  progression: ReturnType<typeof createProgressionService>;
  quests: ReturnType<typeof createQuestService>;
  session: ReturnType<typeof createSessionService>;
  effects: ReturnType<typeof createPlayerEffectsService>;
  itemUse: ReturnType<typeof createItemUseService>;
  gifts: ReturnType<typeof createAffectionGiftService>;
  /**
   * Boss encounters, wired exactly as production does.
   *
   * Non-optional here even though it is optional on `AppServices`: a test app
   * always has one, so no boss test has to build a second service by hand and
   * risk wiring it differently from the real thing.
   */
  bosses: ReturnType<typeof createBossEncounterService>;
  /**
   * Locations & Travel, wired exactly as production does — including the
   * `getContent()` closure, so a test that edits the snapshot in place (to
   * change a price or disable a region) is seen by the service the way an
   * admin reload would be.
   */
  travel: ReturnType<typeof createTravelService>;
}

export interface BootstrapOptions {
  timezone?: string;
  huntRng?: Rng;
  captureRng?: Rng;
  dailyRng?: Rng;
  /** Drives the affection gift chance roll and its loot pick, in that order. */
  giftRng?: Rng;
  /**
   * Whether the daily launch splash is enabled for this test app. Defaults
   * to `false` so pre-existing tests continue to exercise the main menu
   * directly on `/waifumon`. Splash-specific tests opt in with `true`.
   */
  splashEnabled?: boolean;
  /**
   * Drives the boss shuffle bag and the 2–5 hour downtime pick. Damage and
   * rewards are *derived*, not rolled, so this never touches them — a test
   * that wants specific damage changes the snapshot, not the RNG.
   */
  bossRng?: Rng;
  /**
   * Replaces the shipped `bossEncounters` block. Lets a scheduling test shrink
   * the window to minutes without editing `content/tables.json`.
   */
  bossEncounters?: Partial<LoadedContent['tables']['bossEncounters']>;
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
      bossEncounters: {
        ...loaded.tables.bossEncounters,
        ...(opts.bossEncounters ?? {}),
      },
    },
  };
  await seedContent(t.db, content, t.logger);
  const currency = createCurrencyService(t.db);
  const inventory = createInventoryService(t.db);
  // Wired exactly as production does, so integration tests exercise real Buddy
  // Bonuses rather than an unbonused game.
  const buddyBonus = createBuddyBonusService({ getContent: () => content });
  const progression = createProgressionService({
    config: content.tables.progression,
    baseMaxEnergy: content.tables.energy.baseMax,
    buddyBonus,
  });
  const quests = createQuestService({
    db: t.db,
    currency,
    inventory,
    config: content.tables.dailyQuests,
    timezone,
    logger: t.logger,
  });
  // Wired exactly as production does, so integration tests exercise the real
  // unlock/acknowledge path rather than a stub.
  const appearance = createAppearanceService({ db: t.db, getContent: () => content });
  const collection = createCollectionService({
    db: t.db,
    currency,
    quests,
    appearance,
    duplicateConfig: content.tables.duplicate,
    waifuConfig: content.tables.waifuProgression,
    buddyBonus,
  });
  const care = createCareService({
    db: t.db,
    currency,
    collection,
    progression,
    quests,
    appearance,
    careConfig: content.tables.energy.careMode,
    buddyBonus,
  });
  const effects = createPlayerEffectsService(t.db);
  // Wired exactly as production does, so the encounter-consumable path is the
  // default in tests rather than an opt-in.
  const itemUse = createItemUseService({
    db: t.db,
    currency,
    inventory,
    effects,
    progression,
    care,
  });
  // Wired exactly as production does — the daily claim is the authoritative
  // daily reset, so the gift roll rides inside its transaction.
  const gifts = createAffectionGiftService({
    db: t.db,
    inventory,
    collection,
    config: content.tables.affectionGifts,
    captureCapacity: content.tables.inventory.captureCapacity,
    timezone,
    logger: t.logger,
    ...(opts.giftRng ? { rng: opts.giftRng } : {}),
  });
  // Reads `content` through a closure, matching production's `contentSnapshot`
  // pattern — so a test that mutates the snapshot in place is visible to the
  // service exactly as an admin reload would be.
  const bosses = createBossEncounterService({
    db: t.db,
    inventory,
    collection,
    getContent: () => content,
    buddyBonus,
    logger: t.logger,
    ...(opts.bossRng ? { rng: opts.bossRng } : {}),
  });
  const travel = createTravelService({ db: t.db, currency, getContent: () => content });
  return {
    content,
    buddyBonus,
    gifts,
    bosses,
    travel,
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
      gifts,
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
      buddyBonus,
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
      seductivePowerConfig: content.tables.seductivePower,
      collection,
      quests,
      effects,
      itemUse,
      appearance,
      buddyBonus,
      logger: t.logger,
      ...(opts.captureRng ? { rng: opts.captureRng } : {}),
    }),
    care,
    collection,
    appearance,
    quests,
    effects,
    itemUse,
    session: createSessionService({
      db: t.db,
      timezone,
    }),
  };
}

export interface ActivityLineCapture {
  channelId: string;
  text: string;
  visibility: EventVisibility;
  richEmbed?: {
    title: string;
    description: string;
    image: { absolutePath: string; filename: string };
    footer?: string;
  };
}

/**
 * Event-bus harness for integration tests: a real bus + hunt-session tracker
 * (so handlers behave exactly as in production), a recorder subscriber that
 * captures every emitted event, and a real Activity Feed whose Discord side
 * is a spy.
 */
export interface EventHarness {
  bus: GameEventBus;
  huntSessions: HuntSessionTracker;
  activityFeed: ActivityFeedService;
  /** Every event that reached the bus, in emission order. */
  events: GameEvent[];
  /** Every line the Activity Feed posted. */
  lines: ActivityLineCapture[];
  /** Events of one kind, for concise assertions. */
  ofKind<K extends GameEvent['kind']>(kind: K): Extract<GameEvent, { kind: K }>[];
  reset(): void;
}

export interface EventHarnessOptions {
  /** Waifumon Log channel id the feed resolves to. Null = unconfigured. */
  feedChannelId?: string | null;
}

export function createEventHarness(
  app: App,
  logger: Logger = silentLogger(),
  opts: EventHarnessOptions = {},
): EventHarness {
  const feedChannelId = opts.feedChannelId === undefined ? 'c-waifumon-log' : opts.feedChannelId;
  const events: GameEvent[] = [];
  const lines: ActivityLineCapture[] = [];
  const bus = createGameEventBus({ logger });
  bus.subscribe((event) => {
    events.push(event);
  });
  const activityFeed = createActivityFeedService({
    logger,
    richEmbedMinRarity: app.content.tables.capture.announceMinRarity,
    resolveChannel: async () => feedChannelId,
    post: async (channelId, request) => {
      lines.push({
        channelId,
        text: request.text,
        visibility: request.visibility,
        ...(request.richEmbed ? { richEmbed: request.richEmbed } : {}),
      });
    },
  });
  activityFeed.subscribe(bus);
  return {
    bus,
    huntSessions: createHuntSessionTracker({
      locations: app.content.tables.hunt.locationFlavors,
    }),
    activityFeed,
    events,
    lines,
    ofKind(kind) {
      return events.filter((e) => e.kind === kind) as Extract<
        GameEvent,
        { kind: typeof kind }
      >[];
    },
    reset() {
      events.length = 0;
      lines.length = 0;
    },
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

/**
 * Values for one directly-inserted owned Waifumon.
 *
 * `player_waifus.base_sp` is NOT NULL with no database default — that is the
 * invariant that stops a copy existing without a Seductive Power roll — so
 * every test that mints a copy outside the capture path needs a value. This is
 * the one place that decides it, rather than 25 fixtures each inventing one.
 */
export type OwnedWaifuSeed = Omit<typeof playerWaifus.$inferInsert, 'baseSp'> & {
  /** Explicit Base SP. Omitted, a valid in-band value is derived. */
  baseSp?: number;
};

/**
 * Insert owned Waifumon directly, with a valid Base SP for each one's rarity.
 *
 * The derived value reuses the migration's own deterministic function keyed on
 * a per-call counter, so fixtures are **stable across runs** (no uncontrolled
 * randomness in a test) while duplicate copies still receive different values —
 * which is exactly the property the production model has, and therefore the
 * one fixtures should exhibit too. Pass `baseSp` explicitly whenever a test
 * asserts on the number itself.
 */
let seedCounter = 0;

export async function insertOwnedWaifus(
  db: Db,
  seeds: OwnedWaifuSeed[],
): Promise<PlayerWaifuRow[]> {
  if (seeds.length === 0) return [];
  const speciesIds = [...new Set(seeds.map((seed) => seed.speciesId))];
  const rows = await db
    .select({ id: speciesTable.id, rarity: speciesTable.rarity })
    .from(speciesTable)
    .where(inArray(speciesTable.id, speciesIds));
  const rarityById = new Map(rows.map((r) => [r.id, r.rarity]));

  const values = seeds.map((seed) => {
    const rarity = rarityById.get(seed.speciesId);
    if (!rarity) throw new Error(`insertOwnedWaifus: unknown species id ${seed.speciesId}`);
    const { baseSp, ...rest } = seed;
    return {
      ...rest,
      baseSp: baseSp ?? deterministicBaseSeductivePower(++seedCounter, rarity),
    };
  });
  return db.insert(playerWaifus).values(values).returning();
}

/** Single-row convenience over {@link insertOwnedWaifus}. */
export async function insertOwnedWaifu(
  db: Db,
  seed: OwnedWaifuSeed,
): Promise<PlayerWaifuRow> {
  const [row] = await insertOwnedWaifus(db, [seed]);
  return row!;
}

/**
 * A deterministic {@link Rng} driven by a fixed script.
 *
 * `next()` walks the script and throws once it runs out, so a test that
 * silently started consuming more randomness than it scripted fails loudly
 * rather than drifting onto real entropy.
 *
 * `intInclusive()` is deliberately *softer*: it consumes the script while
 * there is script left, then falls back to the bottom of the requested range.
 * That is what lets a test script the decision it cares about (a capture
 * chance, a loot pick) without also having to script every incidental integer
 * draw the same transaction makes — the Base Seductive Power roll being the
 * one that motivated it. Tests that care about the integer supply a value; the
 * rest get a stable, in-range default instead of a NaN.
 */
export function scriptedRng(nexts: readonly number[]): Rng {
  let i = 0;
  return {
    next: () => {
      if (i >= nexts.length) throw new Error(`scriptedRng exhausted at ${i}`);
      return nexts[i++]!;
    },
    intInclusive(min, max) {
      if (max < min) throw new RangeError(`intInclusive: max ${max} < min ${min}`);
      if (i >= nexts.length) return min;
      const fraction = nexts[i++]!;
      return Math.min(max, Math.floor(fraction * (max - min + 1)) + min);
    },
  };
}

/**
 * Grants a travel pass (and the routes it stamps) without spending anything.
 *
 * Goes through the service's admin path rather than inserting rows directly,
 * so a test that sets a player up as "already has the Caravan Pass" gets
 * exactly the row shape a real purchase produces, minus the charge.
 */
export async function grantPass(app: App, playerId: number, passId = 'caravan_pass'): Promise<void> {
  await app.travel.grantPass(playerId, passId);
}

/** Unlocks one destination with no pass check and no charge. */
export async function unlockRoute(app: App, playerId: number, regionId: string): Promise<void> {
  await app.travel.grantRoute(playerId, regionId);
}

/** Moves a player without going through the travel rules (level, pass, encounter). */
export async function forceRegion(db: Db, playerId: number, regionId: string): Promise<void> {
  await db.update(playersTable).set({ currentRegion: regionId }).where(eq(playersTable.id, playerId));
}

export async function getItemBySlug(db: Db, slug: string): Promise<ItemRow> {
  const [row] = await db.select().from(items).where(eq(items.slug, slug));
  if (!row) throw new Error(`Missing seeded item: ${slug}`);
  return row;
}
