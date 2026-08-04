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

/**
 * Buddy affinity (Milestone 5D). Not to be confused with `archetype` (what a
 * Waifumon *is*) or `variant` (which art is rendered) — affinity only drives
 * the buddy-vs-encounter capture matchup. `switch` is the neutral default:
 * no strengths, no weaknesses, and the fallback for any unknown value.
 */
export const AFFINITIES = ['dominant', 'submissive', 'caregiver', 'primal', 'switch'] as const;
export type Affinity = (typeof AFFINITIES)[number];
export const DEFAULT_AFFINITY: Affinity = 'switch';

export const ITEM_CATEGORIES = ['capture', 'material', 'cosmetic', 'consumable'] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Active-use item effects (shop/items expansion). An item with a non-null
 * `effect_type` can be *used* from the inventory screen; its `effect_config`
 * carries the per-effect tunables (validated by type in content/schemas.ts).
 *
 *   restore_energy_full   — Energy Drink: refill Hunt Energy to computed max.
 *   capture_bonus_charges — Microdose: flat capture bonus for N attempts.
 */
export const ITEM_EFFECT_TYPES = ['restore_energy_full', 'capture_bonus_charges'] as const;
export type ItemEffectType = (typeof ITEM_EFFECT_TYPES)[number];

/** Currencies a shop entry can be priced in. */
export const PRICE_CURRENCIES = ['waifubux', 'essence'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

/**
 * Canonical `player_active_effects.effect_type` for the capture-chance buff.
 * Deliberately *not* the item's `effectType`: every item that grants a capture
 * bonus shares this one slot, which is what makes the buff non-stacking (the
 * unique index on (player_id, effect_type) enforces it in the database).
 */
export const CAPTURE_BONUS_EFFECT = 'capture_bonus';

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
    /**
     * Currently active buddy — nullable, no FK (player_waifus is defined below
     * and drizzle can't express a self-referencing cycle cleanly). Application
     * code (CollectionService) enforces the invariants: buddy must be an owned
     * active copy; soft-release/convert clears the field if it matched.
     */
    buddyWaifuId: bigint('buddy_waifu_id', { mode: 'number' }),
    showcase: jsonb('showcase').$type<Record<string, unknown>>(),
    lastHuntAt: timestamp('last_hunt_at', { withTimezone: true }),
    /**
     * Care Mode (Milestone 5B) — idle state that lazily recovers Hunt Energy
     * and slowly trains a chosen owned Waifumon. All three fields move
     * together: non-null means the player is in Care Mode; null means not.
     * `careModeWaifuId` points at an owned, unreleased `player_waifus` row —
     * no FK (matches the buddy pattern); application code enforces the
     * invariant and self-heals if the row is soft-released underneath.
     */
    careModeStartedAt: timestamp('care_mode_started_at', { withTimezone: true }),
    careModeLastTickAt: timestamp('care_mode_last_tick_at', { withTimezone: true }),
    careModeWaifuId: bigint('care_mode_waifu_id', { mode: 'number' }),
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
    /** Buddy capture matchup style; defaults to the neutral `switch`. */
    affinity: text('affinity').notNull().default('switch'),
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
    check(
      'species_affinity_check',
      sql`${t.affinity} in ('dominant','submissive','caregiver','primal','switch')`,
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
    /** Which currency `buy_price` is denominated in. */
    priceCurrency: text('price_currency').notNull().default('waifubux'),
    dailyStockLimit: integer('daily_stock_limit'),
    /** Non-null makes the item usable from the inventory screen. */
    effectType: text('effect_type'),
    effectConfig: jsonb('effect_config').$type<Record<string, unknown>>(),
    description: text('description').notNull().default(''),
    emoji: text('emoji'),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    check(
      'items_category_check',
      sql`${t.category} in ('capture','material','cosmetic','consumable')`,
    ),
    check(
      'items_effect_type_check',
      sql`${t.effectType} is null or ${t.effectType} in ('restore_energy_full','capture_bonus_charges')`,
    ),
    check('items_price_currency_check', sql`${t.priceCurrency} in ('waifubux','essence')`),
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
    /** Currency the purchase was paid in; `balance_after` is that currency. */
    currency: text('currency').notNull().default('waifubux'),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shop_transactions_player_created_idx').on(t.playerId, t.createdAt),
    check('shop_transactions_currency_check', sql`${t.currency} in ('waifubux','essence')`),
  ],
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

/**
 * Audit log for every XP-affecting action. `event_type` is a soft-typed text
 * column so new sources (quests, events, admin grants) can be added without a
 * migration; ProgressionService owns the vocabulary. `ref_id` is optional and
 * points to a related row (encounter, capture_attempt, daily_claim) for
 * cross-referencing during investigations.
 */
export const playerProgressionEvents = pgTable(
  'player_progression_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    eventType: text('event_type').notNull(),
    xpDelta: integer('xp_delta').notNull(),
    refId: bigint('ref_id', { mode: 'number' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('progression_events_player_created_idx').on(t.playerId, t.createdAt),
  ],
);

/**
 * Per-(player, channel) bookkeeping.
 *
 * One active session per (player, channel). `message_id` is the public
 * channel-post that every navigation edits in place; `summary_json` holds
 * today's per-player tally that renders in the menu embed. The row is
 * upserted on `/waifumon` and refreshed on every action.
 */
export const waifumonSessions = pgTable(
  'waifumon_sessions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    channelId: text('channel_id').notNull(),
    /**
     * Id of the player's public Care Mode Trainer Profile message in this
     * channel, or null when they are not in Care Mode. Formerly the public
     * session-board id (see migration 0012) — gameplay is ephemeral now, so
     * this is the only message the bot owns on the player's behalf.
     */
    profileMessageId: text('profile_message_id'),
    summaryJson: jsonb('summary_json').$type<Record<string, unknown>>().notNull().default({}),
    summaryDate: date('summary_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One active session per (player, channel). The Trainer Profile is looked
    // up through this index; the old reverse message_id index was dropped in
    // 0012 along with the public-board ownership check it served.
    uniqueIndex('waifumon_sessions_player_channel_uq').on(t.playerId, t.channelId),
  ],
);

/**
 * Daily Quests (Milestone 5C): one row per (player, quest_date, quest_slug).
 * `title_snapshot`, `description_snapshot`, and `rewards_json` freeze the
 * pool entry at assignment time so content edits don't break already-assigned
 * quests. `type` is a soft-typed text column (matches
 * `player_progression_events`) — QuestService owns the vocabulary.
 *
 * The all-complete bonus for a given day is tracked on a dedicated
 * `quest_slug='__all_complete_bonus__'` row so no second table / no extra
 * column on `players` is needed. That sentinel row's `claimed_at` doubles as
 * the "bonus already granted" flag.
 */
export const playerDailyQuests = pgTable(
  'player_daily_quests',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    questDate: date('quest_date').notNull(),
    questSlug: text('quest_slug').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    descriptionSnapshot: text('description_snapshot').notNull(),
    type: text('type').notNull(),
    /** For rarity-gated event types; null otherwise. */
    rarityAtLeast: text('rarity_at_least'),
    target: integer('target').notNull(),
    progress: integer('progress').notNull().default(0),
    rewardsJson: jsonb('rewards_json').$type<Record<string, unknown>>().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_daily_quests_player_date_slug_uq').on(
      t.playerId,
      t.questDate,
      t.questSlug,
    ),
    index('player_daily_quests_player_date_idx').on(t.playerId, t.questDate),
    check('player_daily_quests_target_check', sql`${t.target} > 0`),
    check('player_daily_quests_progress_check', sql`${t.progress} >= 0`),
  ],
);

/** Sentinel quest slug for the "all quests complete" daily bonus row. */
export const ALL_COMPLETE_BONUS_SLUG = '__all_complete_bonus__';

/**
 * Daily launch splash tracking. One row per (player, guild-day) marks the
 * first `/waifumon` of that day so the splash screen renders exactly once
 * per calendar day (configured timezone). The unique constraint keeps the
 * insert idempotent under races.
 */
export const playerDailySplashViews = pgTable(
  'player_daily_splash_views',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    splashDate: date('splash_date').notNull(),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_daily_splash_views_player_date_uq').on(t.playerId, t.splashDate),
  ],
);

/**
 * Charge-based (and, later, time-based) buffs granted by using a consumable.
 *
 * One row per (player, effect_type) — the unique index is what makes buffs
 * non-stacking: using a second Microdose while one is active *refreshes*
 * `charges_remaining` instead of creating a parallel effect. `modifier_json`
 * snapshots the item's tuning at use time so a later content edit can't change
 * a buff the player already paid for. Rows are deleted once the last charge is
 * consumed, so "has an active effect" is simply "a row exists".
 *
 * `expires_at` is reserved for future time-boxed buffs; charge-based effects
 * leave it null and readers treat null as "never expires".
 */
export const playerActiveEffects = pgTable(
  'player_active_effects',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    effectType: text('effect_type').notNull(),
    sourceItemSlug: text('source_item_slug').notNull(),
    modifierJson: jsonb('modifier_json').$type<Record<string, unknown>>().notNull().default({}),
    chargesRemaining: integer('charges_remaining').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_active_effects_player_type_uq').on(t.playerId, t.effectType),
    check('player_active_effects_charges_check', sql`${t.chargesRemaining} >= 0`),
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
export type PlayerProgressionEventRow = typeof playerProgressionEvents.$inferSelect;
export type WaifumonSessionRow = typeof waifumonSessions.$inferSelect;
export type PlayerDailyQuestRow = typeof playerDailyQuests.$inferSelect;
export type PlayerDailySplashViewRow = typeof playerDailySplashViews.$inferSelect;
export type PlayerActiveEffectRow = typeof playerActiveEffects.$inferSelect;
