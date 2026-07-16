/**
 * Milestone 1 tables only: guilds, players, player_currencies, species, items,
 * player_inventory, daily_claims, shop_transactions.
 * (encounters, capture_attempts, player_waifus, progression events land in M2+.)
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'EX'] as const;
export type Rarity = (typeof RARITIES)[number];

export const CONTENT_RATINGS = ['suggestive', 'mature', 'explicit'] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

export const ITEM_CATEGORIES = ['capture', 'material', 'cosmetic', 'consumable'] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const guilds = pgTable('guilds', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  discordGuildId: text('discord_guild_id').notNull().unique(),
  announceChannelId: text('announce_channel_id'),
  hereThresholdRarity: text('here_threshold_rarity').notNull().default('UR'),
  /** Optional admin allowlist of play channel ids; null/empty = any NSFW channel. */
  allowedChannelIds: jsonb('allowed_channel_ids').$type<string[]>(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable(
  'players',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id),
    discordUserId: text('discord_user_id').notNull(),
    xp: integer('xp').notNull().default(0),
    level: integer('level').notNull().default(1),
    showcase: jsonb('showcase').$type<Record<string, unknown>>(),
    lastHuntAt: timestamp('last_hunt_at', { withTimezone: true }),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('players_guild_user_uq').on(t.guildId, t.discordUserId)],
);

export const playerCurrencies = pgTable(
  'player_currencies',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .primaryKey()
      .references(() => players.id),
    huntEnergy: integer('hunt_energy').notNull().default(0),
    waifubux: integer('waifubux').notNull().default(0),
    essence: integer('essence').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('player_currencies_hunt_energy_check', sql`${t.huntEnergy} >= 0`),
    check('player_currencies_waifubux_check', sql`${t.waifubux} >= 0`),
    check('player_currencies_essence_check', sql`${t.essence} >= 0`),
  ],
);

export const species = pgTable(
  'species',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    rarity: text('rarity').notNull(),
    archetype: text('archetype').notNull(),
    baseCaptureRate: real('base_capture_rate'),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    /** Metadata only in MVP — drives no runtime behavior. */
    contentRating: text('content_rating').notNull(),
    imagePath: text('image_path').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    eventKey: text('event_key'),
    perSpeciesWeight: integer('per_species_weight').notNull().default(1),
  },
  (t) => [
    check('species_rarity_check', sql`${t.rarity} in ('N','R','SR','SSR','UR','LR','EX')`),
    check(
      'species_content_rating_check',
      sql`${t.contentRating} in ('suggestive','mature','explicit')`,
    ),
  ],
);

export const items = pgTable(
  'items',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    captureModifier: real('capture_modifier'),
    isGuaranteedCapture: boolean('is_guaranteed_capture').notNull().default(false),
    purchasable: boolean('purchasable').notNull().default(false),
    buyPrice: integer('buy_price'),
    dailyStockLimit: integer('daily_stock_limit'),
    description: text('description').notNull().default(''),
    emoji: text('emoji'),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    check(
      'items_category_check',
      sql`${t.category} in ('capture','material','cosmetic','consumable')`,
    ),
  ],
);

export const playerInventory = pgTable(
  'player_inventory',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => items.id),
    quantity: integer('quantity').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.itemId] }),
    check('player_inventory_quantity_check', sql`${t.quantity} >= 0`),
  ],
);

export const dailyClaims = pgTable(
  'daily_claims',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    claimDate: date('claim_date').notNull(),
    rewards: jsonb('rewards').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('daily_claims_player_date_uq').on(t.playerId, t.claimDate)],
);

export const shopTransactions = pgTable(
  'shop_transactions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => items.id),
    quantity: integer('quantity').notNull(),
    unitPrice: integer('unit_price').notNull(),
    totalPrice: integer('total_price').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shop_transactions_player_created_idx').on(t.playerId, t.createdAt)],
);

export const ENCOUNTER_STATES = [
  'active',
  'captured',
  'escaped',
  'released',
  'expired',
] as const;
export type EncounterState = (typeof ENCOUNTER_STATES)[number];

export const encounters = pgTable(
  'encounters',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    speciesId: bigint('species_id', { mode: 'number' })
      .notNull()
      .references(() => species.id),
    channelId: text('channel_id').notNull(),
    publicMessageId: text('public_message_id'),
    state: text('state').notNull().default('active'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'encounters_state_check',
      sql`${t.state} in ('active','captured','escaped','released','expired')`,
    ),
    check(
      'encounters_attempts_check',
      sql`${t.attemptCount} >= 0 and ${t.attemptCount} <= ${t.maxAttempts}`,
    ),
    // One active encounter per player — enforced by the database, not just code.
    uniqueIndex('encounters_active_player_uq')
      .on(t.playerId)
      .where(sql`state = 'active'`),
    index('encounters_player_state_idx').on(t.playerId, t.state),
  ],
);

/**
 * Every capture button click writes one row here — successful attempts double
 * as the capture log. `guaranteed=true` marks Mythic Contract captures so
 * audits can distinguish them from ordinary rolls.
 */
export const captureAttempts = pgTable(
  'capture_attempts',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => encounters.id),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    attemptNumber: integer('attempt_number').notNull(),
    itemId: bigint('item_id', { mode: 'number' })
      .notNull()
      .references(() => items.id),
    computedChance: real('computed_chance').notNull(),
    roll: real('roll').notNull(),
    success: boolean('success').notNull(),
    guaranteed: boolean('guaranteed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Deterministic ordering + doubles as a per-encounter attempt guard.
    uniqueIndex('capture_attempts_encounter_number_uq').on(t.encounterId, t.attemptNumber),
    index('capture_attempts_encounter_idx').on(t.encounterId),
  ],
);

/**
 * One row per owned copy (duplicates get their own rows, per plan §12).
 * Level/affection/nickname/buddy semantics land in later milestones — the
 * capture path only writes id/player/species/caughtAt today.
 */
export const playerWaifus = pgTable(
  'player_waifus',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    speciesId: bigint('species_id', { mode: 'number' })
      .notNull()
      .references(() => species.id),
    level: integer('level').notNull().default(1),
    xp: integer('xp').notNull().default(0),
    affection: integer('affection').notNull().default(0),
    nickname: text('nickname'),
    isFavorite: boolean('is_favorite').notNull().default(false),
    variant: text('variant').notNull().default('standard'),
    cosmetics: jsonb('cosmetics').$type<string[]>().notNull().default([]),
    caughtAt: timestamp('caught_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    index('player_waifus_player_idx').on(t.playerId),
    index('player_waifus_player_species_idx').on(t.playerId, t.speciesId),
    check('player_waifus_level_check', sql`${t.level} >= 1`),
    check('player_waifus_xp_check', sql`${t.xp} >= 0`),
    check('player_waifus_affection_check', sql`${t.affection} >= 0`),
  ],
);

export type GuildRow = typeof guilds.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type PlayerCurrenciesRow = typeof playerCurrencies.$inferSelect;
export type SpeciesRow = typeof species.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type PlayerInventoryRow = typeof playerInventory.$inferSelect;
export type DailyClaimRow = typeof dailyClaims.$inferSelect;
export type ShopTransactionRow = typeof shopTransactions.$inferSelect;
export type EncounterRow = typeof encounters.$inferSelect;
export type CaptureAttemptRow = typeof captureAttempts.$inferSelect;
export type PlayerWaifuRow = typeof playerWaifus.$inferSelect;
