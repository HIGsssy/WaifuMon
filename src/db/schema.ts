/**
 * Milestone 1 tables only: guilds, players, player_currencies, species, items,
 * player_inventory, daily_claims, shop_transactions.
 * (encounters, capture_attempts, player_waifus, progression events land in M2+.)
 */
import { sql } from 'drizzle-orm';
import { REGION_SQL_LIST } from '../modules/locations/regions';
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
 * The categories a shop ever lists. `capture` is the charm catalog; `consumable`
 * covers the utility items. Material and cosmetic items are never sold, so a
 * `shopRegions` assignment on one is a content error, not a hidden shelf.
 */
export const SHOP_ITEM_CATEGORIES = ['capture', 'consumable'] as const;
export type ShopItemCategory = (typeof SHOP_ITEM_CATEGORIES)[number];

/**
 * Active-use item effects (shop/items expansion). An item with a non-null
 * `effect_type` can be *used* from the inventory screen; its `effect_config`
 * carries the per-effect tunables (validated by type in content/schemas.ts).
 *
 *   restore_energy_full   — Energy Drink / Full Body Massage: refill Hunt
 *                           Energy to the computed max.
 *   restore_energy_amount — Quickie Coffee / Reach Around: add a fixed amount,
 *                           clamped to the computed max.
 *   capture_bonus_charges — Microdose: flat capture bonus for N attempts.
 */
export const ITEM_EFFECT_TYPES = [
  'restore_energy_full',
  'restore_energy_amount',
  'capture_bonus_charges',
] as const;
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
  /**
   * Dedicated Boss Encounter channel (Boss Encounters, Stage 1).
   *
   * Deliberately its own column rather than a key in `settings`: encounters do
   * not schedule at all until it is set, so it is a gate the scheduler reads on
   * every tick, not a preference. Null means bosses are off for this guild.
   * Kept separate from `announce_channel_id` because the Waifumon Log is a
   * narration feed and this is a live event venue — sharing one would bury a
   * countdown under capture lines.
   */
  bossChannelId: text('boss_channel_id'),
  hereThresholdRarity: text('here_threshold_rarity').notNull().default('UR'),
  /** Optional admin allowlist of play channel ids; null/empty = any guild channel. */
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
    /**
     * Where this trainer currently stands (Locations & Travel).
     *
     * Persistent, not per-session: a player who travels to Twin Peeks is still
     * there next week. Defaults to Waifu Valley so every pre-existing row —
     * and every future player — starts in the region the game opens in,
     * without a backfill. The CHECK is generated from
     * `modules/locations/regions.ts`, so a typo cannot be stored and adding a
     * region needs a migration that widens it.
     *
     * Read by exactly one gameplay path: which species the hunt may draw. It
     * does **not** reach capture math, rarity, energy, cooldown, care, gifts
     * or boss participation, and nothing downstream should start reading it.
     */
    currentRegion: text('current_region').notNull().default('waifu-valley'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('players_guild_user_uq').on(t.guildId, t.discordUserId),
    check('players_current_region_check', sql`${t.currentRegion} in (${sql.raw(REGION_SQL_LIST)})`),
  ],
);

export interface PortalEligibleGuild {
  discordGuildId: string;
  guildDbId: number;
  playerId: number;
  name: string | null;
  iconUrl: string | null;
}

export const portalOauthStates = pgTable(
  'portal_oauth_states',
  {
    stateDigest: text('state_digest').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('portal_oauth_states_expires_idx').on(t.expiresAt)],
);

export const portalSessions = pgTable(
  'portal_sessions',
  {
    sessionDigest: text('session_digest').primaryKey(),
    discordUserId: text('discord_user_id').notNull(),
    discordUsername: text('discord_username'),
    discordAvatarUrl: text('discord_avatar_url'),
    selectedDiscordGuildId: text('selected_discord_guild_id'),
    selectedGuildDbId: bigint('selected_guild_db_id', { mode: 'number' }).references(() => guilds.id),
    playerId: bigint('player_id', { mode: 'number' }).references(() => players.id),
    eligibleGuilds: jsonb('eligible_guilds').$type<PortalEligibleGuild[]>().notNull().default([]),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('portal_sessions_expires_idx').on(t.expiresAt),
    index('portal_sessions_discord_user_idx').on(t.discordUserId),
    index('portal_sessions_player_idx').on(t.playerId),
  ],
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
    /**
     * Flat, additive capture-chance bonus in *probability points* (0.30 =
     * +30pp), applied after the `capture_modifier` multiply and before the
     * clamp — exactly like the buddy-affinity and Microdose terms. Null for
     * charms, which express their strength multiplicatively instead.
     */
    captureBonus: real('capture_bonus'),
    /**
     * Encounter rarities this capture item may be committed against. Null =
     * every rarity (the charms). Non-null is what keeps rarity gating in
     * content instead of hard-coding item slugs into the capture logic.
     */
    captureRarities: jsonb('capture_rarities').$type<string[]>(),
    isGuaranteedCapture: boolean('is_guaranteed_capture').notNull().default(false),
    /**
     * The regions whose shops sell this item. Empty means sold nowhere — there
     * is no global shop. An item is buyable exactly in the regions listed here,
     * always at its own `buy_price`/`price_currency`/`daily_stock_limit`.
     */
    shopRegions: text('shop_regions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
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
      sql`${t.effectType} is null or ${t.effectType} in ('restore_energy_full','restore_energy_amount','capture_bonus_charges')`,
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
    /**
     * Capture item the player has *chosen* for this encounter but not yet
     * committed (encounter-time item selection).
     *
     * Selection is deliberately server-side state rather than a value carried
     * in a Discord custom id: the authoritative capture reads it back under
     * the same `SELECT … FOR UPDATE` that serializes attempts, so a stale
     * button cannot smuggle in an item the player never picked. Nothing is
     * consumed while this is set — changing it, walking away, or letting the
     * encounter expire all cost the player nothing.
     */
    selectedItemId: bigint('selected_item_id', { mode: 'number' }).references(() => items.id),
    /**
     * The region the player was standing in when this encounter was rolled.
     *
     * A **snapshot**, deliberately: it records where she was met, and nothing
     * reads it back to make a decision. Capture math is region-agnostic and
     * must stay that way, so this column exists for analytics and for keeping
     * an encounter's origin auditable after the player travels away. Nullable
     * because rows that predate travel have no answer.
     */
    regionId: text('region_id'),
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
    /**
     * The player's **selected appearance** (Appearance Progression System v1).
     * Purely cosmetic: it decides which artwork renders and touches nothing
     * else. Holds an appearance id from the species' content catalog; the
     * default `'standard'` is the implicit entry every species has.
     */
    variant: text('variant').notNull().default('standard'),
    cosmetics: jsonb('cosmetics').$type<string[]>().notNull().default([]),
    /**
     * Appearance ids this copy has already been *notified* about.
     *
     * Not an unlock ledger — V1 unlock state is derived from waifu state
     * (`owned`, `level`), so retroactively-added artwork unlocks itself with no
     * backfill. This column answers only "have we toasted this one yet?", which
     * is what keeps a level-40 copy from spamming six notifications the first
     * time new milestone art ships.
     */
    seenAppearances: jsonb('seen_appearances').$type<string[]>().notNull().default([]),
    /**
     * **Base Seductive Power** — the Level 1 SP rolled once for this copy at
     * capture, from her species' rarity band.
     *
     * Permanent and per-copy: two captures of the same species routinely carry
     * different values, and this column is never recomputed — not on read, not
     * on level-up, not on a content reload. *Current* SP is derived from this
     * plus `level` by `modules/power/seductivePower.ts` and is deliberately
     * not stored, because a stored copy of a pure function is just a third
     * value that can drift.
     *
     * `NOT NULL` with **no default**, on purpose: drizzle's inferred insert
     * type then forces every creation site to supply a rolled value, so a copy
     * can never quietly come into existence at some neutral midpoint. The
     * rarity-band invariant itself is application-enforced (CaptureService) —
     * a CHECK constraint cannot reach across to `species.rarity`.
     */
    baseSp: integer('base_sp').notNull(),
    /**
     * Eligible daily gift rolls this copy has taken *since her last gift*
     * (Affection Gift System). Per-copy on purpose: swapping buddies must
     * neither transfer nor reset anyone's progress toward their guarantee.
     * Reset to 0 the moment a gift is generated; frozen while a gift sits
     * unclaimed (a paused copy takes no roll, so it advances nothing).
     */
    giftRollCounter: integer('gift_roll_counter').notNull().default(0),
    caughtAt: timestamp('caught_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    index('player_waifus_player_idx').on(t.playerId),
    index('player_waifus_player_species_idx').on(t.playerId, t.speciesId),
    check('player_waifus_level_check', sql`${t.level} >= 1`),
    check('player_waifus_xp_check', sql`${t.xp} >= 0`),
    check('player_waifus_affection_check', sql`${t.affection} >= 0`),
    check('player_waifus_gift_roll_counter_check', sql`${t.giftRollCounter} >= 0`),
    check('player_waifus_base_sp_check', sql`${t.baseSp} >= 1`),
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

/**
 * Affection Gift System — tiers, and the vocabulary shared by the roll ledger
 * and the gift rows. Thresholds and chances live in `content/tables.json`;
 * these are only the *names* the columns store, so an audit query never has to
 * re-derive which band a historic gift came from.
 */
export const AFFECTION_GIFT_TIERS = ['low', 'mid', 'high'] as const;
export type AffectionGiftTier = (typeof AFFECTION_GIFT_TIERS)[number];

/** Why a gift was generated: the chance roll hit, or the guarantee fired. */
export const AFFECTION_GIFT_SOURCES = ['random', 'guaranteed'] as const;
export type AffectionGiftSource = (typeof AFFECTION_GIFT_SOURCES)[number];

/** What one eligible daily roll produced. */
export const AFFECTION_GIFT_ROLL_RESULTS = ['gift', 'none'] as const;
export type AffectionGiftRollResult = (typeof AFFECTION_GIFT_ROLL_RESULTS)[number];

/**
 * One row per player per reset date — the authoritative "this player has
 * already been rolled today" record.
 *
 * The unique `(player_id, roll_date)` index is the whole idempotency story:
 * the roll inserts here *first*, so a retried daily, a duplicate worker, or
 * two concurrent transactions produce exactly one roll and at most one gift.
 * A losing insert is a unique violation, which the service reads as "already
 * processed" rather than an error.
 *
 * Rows are written for *every* eligible roll, gift or not — a `result='none'`
 * row is what proves the day was spent and the guarantee counter advanced.
 * Ineligible players (no buddy, affection below the floor) are not rolled and
 * get no row, so they can be rolled the instant they become eligible.
 */
export const affectionGiftRolls = pgTable(
  'affection_gift_rolls',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    rollDate: date('roll_date').notNull(),
    /** The active buddy at roll time — FK-less, matching `buddy_waifu_id`. */
    waifuId: bigint('waifu_id', { mode: 'number' }).notNull(),
    /** Affection and tier snapshotted so retuning content can't rewrite history. */
    affection: integer('affection').notNull(),
    tier: text('tier').notNull(),
    result: text('result').notNull(),
    /** True when the guarantee produced the gift after the chance roll missed. */
    guaranteed: boolean('guaranteed').notNull().default(false),
    /** Counter *before* this roll and after it — the audit trail for a guarantee. */
    counterBefore: integer('counter_before').notNull(),
    counterAfter: integer('counter_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('affection_gift_rolls_player_date_uq').on(t.playerId, t.rollDate),
    index('affection_gift_rolls_waifu_idx').on(t.waifuId),
    check('affection_gift_rolls_tier_check', sql`${t.tier} in ('low','mid','high')`),
    check('affection_gift_rolls_result_check', sql`${t.result} in ('gift','none')`),
  ],
);

/**
 * A gift a specific owned Waifumon is holding for her trainer.
 *
 * The item is rolled **when the gift is generated**, never at claim time, so
 * what she is holding cannot change under the player while it waits. Gifts do
 * not expire; `claimed_at` is the only lifecycle there is.
 *
 * The partial unique index on `waifu_id WHERE claimed_at IS NULL` is what
 * enforces "at most one unclaimed gift per copy" in the database, and it is
 * also what makes a double-clicked Accept Gift safe: the claim marks the row
 * claimed inside the same transaction that adds the item, so the second click
 * finds nothing left to claim.
 */
export const affectionGifts = pgTable(
  'affection_gifts',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /** The owned copy that produced it — FK-less, matching `buddy_waifu_id`. */
    waifuId: bigint('waifu_id', { mode: 'number' }).notNull(),
    /** Rolled at generation time and frozen; resolved to an item row on claim. */
    itemSlug: text('item_slug').notNull(),
    quantity: integer('quantity').notNull(),
    affectionAtGeneration: integer('affection_at_generation').notNull(),
    tierAtGeneration: text('tier_at_generation').notNull(),
    source: text('source').notNull(),
    /** Reset date of the roll that produced it (configured timezone). */
    resetDate: date('reset_date').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('affection_gifts_waifu_unclaimed_uq')
      .on(t.waifuId)
      .where(sql`claimed_at is null`),
    index('affection_gifts_player_idx').on(t.playerId),
    index('affection_gifts_player_unclaimed_idx')
      .on(t.playerId)
      .where(sql`claimed_at is null`),
    check('affection_gifts_quantity_check', sql`${t.quantity} > 0`),
    check('affection_gifts_tier_check', sql`${t.tierAtGeneration} in ('low','mid','high')`),
    check('affection_gifts_source_check', sql`${t.source} in ('random','guaranteed')`),
  ],
);

/**
 * Boss Encounters (Stage 1) — three tables and one guild column.
 *
 * `guild_boss_state` is per-guild scheduler state: the persistent shuffle bag,
 * when the next boss is due, and whether scheduling is paused or suspended.
 * `boss_encounters` is one row per appearance. `boss_participations` is one row
 * per committed buddy, and is the immutable record a historical result is
 * rendered from.
 *
 * Two invariants are enforced by the database rather than by code, because
 * both of them are races that code alone loses:
 *
 *   - **One active encounter per guild** — a partial unique index over the
 *     three live statuses, the same technique `encounters_active_player_uq`
 *     already uses for hunt encounters.
 *   - **One participation per player per encounter** — a plain unique index,
 *     which is what makes a double-clicked Commit button safe: the second
 *     insert loses and is read as "already committed" rather than as an error.
 */

/**
 * Encounter lifecycle.
 *
 *   scheduled  — drawn and persisted, not yet announced. A restart in this
 *                state re-attempts the announcement; it never re-draws.
 *   scouting   — announced, accepting commitments until `deadline_at`.
 *   resolving  — claimed by exactly one process for payout. Retryable: a
 *                claim that goes stale may be taken over, and every payout is
 *                individually idempotent.
 *   resolved   — terminal. Results are immutable from here.
 *   cancelled  — terminal. An admin ended it, or the channel disappeared.
 */
export const BOSS_ENCOUNTER_STATUSES = [
  'scheduled',
  'scouting',
  'resolving',
  'resolved',
  'cancelled',
] as const;
export type BossEncounterStatus = (typeof BOSS_ENCOUNTER_STATUSES)[number];

/** Statuses that occupy the guild's one active-encounter slot. */
export const BOSS_ACTIVE_STATUSES: readonly BossEncounterStatus[] = [
  'scheduled',
  'scouting',
  'resolving',
];

/**
 * Why an encounter ended. Recorded rather than derived, because "nobody came"
 * and "an admin cancelled it" both leave zero participations behind and a
 * later audit needs to tell them apart.
 */
export const BOSS_RESOLUTION_REASONS = [
  /** At least one trainer committed; the boss was driven away. */
  'repelled',
  /** Nobody committed; the boss left unchallenged. Rewards: none. */
  'unchallenged',
  /** An admin ended it early. Committed participants are still paid. */
  'cancelled_admin',
  /** The configured channel vanished mid-encounter. */
  'channel_lost',
] as const;
export type BossResolutionReason = (typeof BOSS_RESOLUTION_REASONS)[number];

/** Whether a participation's rewards have actually been handed over. */
export const BOSS_REWARD_STATUSES = ['pending', 'applied'] as const;
export type BossRewardStatus = (typeof BOSS_REWARD_STATUSES)[number];

/**
 * Per-guild boss scheduler state. One row per guild, created lazily the first
 * time a boss channel is configured.
 *
 * Separate from `guilds` on purpose: this row is written on every scheduler
 * tick and locked `FOR UPDATE` while a bag is drawn from, and putting that
 * traffic on the guild row would serialize it against every unrelated guild
 * setting read.
 */
export const guildBossState = pgTable(
  'guild_boss_state',
  {
    guildId: bigint('guild_id', { mode: 'number' })
      .primaryKey()
      .references(() => guilds.id),
    /** Which region this guild is currently scouting. */
    region: text('region').notNull().default('waifu-valley'),
    /**
     * The persistent shuffle bag — remaining ids in draw order, plus the last
     * boss drawn. Shape owned by `modules/bosses/bossShuffleBag.ts`, which
     * normalizes anything unexpected rather than trusting the column.
     */
    bagState: jsonb('bag_state').$type<Record<string, unknown>>(),
    /**
     * When the next boss may appear. Chosen and persisted **when the previous
     * encounter resolves**, so a restart cannot reroll it. Null means "as soon
     * as possible" — the state a guild is in the moment it is first configured.
     */
    nextSpawnAt: timestamp('next_spawn_at', { withTimezone: true }),
    /** Admin pause. Nothing new is scheduled; a live encounter still resolves. */
    paused: boolean('paused').notNull().default(false),
    /**
     * Non-null when scheduling has been suspended by a failure rather than by
     * an admin — a deleted channel, a missing permission. Carries the operator
     * -facing reason so `/waifumon-admin boss status` can say what to fix.
     * Cleared automatically the next time the channel checks out.
     */
    suspendedReason: text('suspended_reason'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('guild_boss_state_region_check', sql`${t.region} in ('waifu-valley')`)],
);

/**
 * One boss appearance.
 *
 * Content is **snapshotted** onto the row (name, affinity, artwork, reward
 * table and its version, the calculation version). A boss renamed, retuned or
 * retired in content must not rewrite an encounter that already happened, and
 * a result rendered a month later must read exactly as it did on the day.
 */
export const bossEncounters = pgTable(
  'boss_encounters',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    guildId: bigint('guild_id', { mode: 'number' })
      .notNull()
      .references(() => guilds.id),
    region: text('region').notNull(),
    /** Content id from `bosses.json` — the join key for a historical audit. */
    bossId: text('boss_id').notNull(),
    bossName: text('boss_name').notNull(),
    bossAffinity: text('boss_affinity').notNull(),
    /** Relative artwork path at announcement time; null = text-only encounter. */
    bossArtwork: text('boss_artwork'),
    rewardTable: text('reward_table').notNull(),
    /** `rewardTables[key].version` as it stood when the encounter opened. */
    rewardTableVersion: text('reward_table_version').notNull(),
    /** `BOSS_DAMAGE_FORMULA_VERSION` — which formula produced these numbers. */
    calcVersion: integer('calc_version').notNull(),
    /** `BOSS_AFFINITY_VERSION` — which advantage table applied. */
    affinityVersion: integer('affinity_version').notNull(),
    /** Where the announcement lives. Null until the announcement is posted. */
    channelId: text('channel_id'),
    /**
     * The announcement message. Persisted so the original can be edited after
     * a restart — and so a restart cannot post a second one: a non-null value
     * is the "already announced" flag.
     *
     * This message is **permanent**. It is edited in place — participant count
     * while the window is open, terminal outcome prose when it closes — and it
     * is never deleted, never replaced, and never repurposed into the results.
     */
    messageId: text('message_id'),
    /**
     * The separate public results message, posted immediately below the
     * announcement when the encounter ends. Null until it exists.
     *
     * Deliberately its own column rather than a second use of `message_id`:
     * the channel's permanent history is the *pair*, so a repair that repoints
     * one must not be able to lose the other.
     */
    resultsMessageId: text('results_message_id'),
    /**
     * Delivery state, one stamp per Discord step that resolution owes.
     *
     * Null means "still owed", which is what makes recovery a query rather
     * than a guess: a restart repairs the completion edit when
     * `completionEditedAt` is null and publishes results when
     * `resultsPublishedAt` is null, and a retry that finds both stamped does
     * nothing. Timestamps rather than booleans, matching `resolvedAt` and
     * `resolvingAt` — an operator debugging a stuck encounter gets a *when*.
     */
    completionEditedAt: timestamp('completion_edited_at', { withTimezone: true }),
    resultsPublishedAt: timestamp('results_published_at', { withTimezone: true }),
    /**
     * The page size the results message was rendered with, frozen at
     * publication. Pagination after a restart then pages the encounter exactly
     * as it was published even if `resultsPageSize` has since been retuned —
     * otherwise a reader could press "All Results" and find the page
     * boundaries had moved under a message that is already history.
     */
    resultsPageSize: integer('results_page_size'),
    status: text('status').notNull().default('scheduled'),
    /**
     * True for an admin force-spawn. Recorded so a test spawn is visibly not
     * ordinary shuffle-bag consumption in any later audit — and so the bag is
     * left alone, which is what makes forcing a specific boss repeatable
     * without derailing the rotation.
     */
    forced: boolean('forced').notNull().default(false),
    /** When the boss was due to appear. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    /** When the announcement actually went up; the response-bracket origin. */
    scoutingStartedAt: timestamp('scouting_started_at', { withTimezone: true }),
    /** Participation deadline. Set once, at scouting start, and never moved. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** When a process claimed resolution — the staleness clock for a takeover. */
    resolvingAt: timestamp('resolving_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** The next appearance, chosen here so a restart cannot reroll it. */
    nextSpawnAt: timestamp('next_spawn_at', { withTimezone: true }),
    participantCount: integer('participant_count').notNull().default(0),
    /** `bigint` in `number` mode: totals stay far inside 2^53. */
    totalDamage: bigint('total_damage', { mode: 'number' }).notNull().default(0),
    resolutionReason: text('resolution_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'boss_encounters_status_check',
      sql`${t.status} in ('scheduled','scouting','resolving','resolved','cancelled')`,
    ),
    check(
      'boss_encounters_reason_check',
      sql`${t.resolutionReason} is null or ${t.resolutionReason} in ('repelled','unchallenged','cancelled_admin','channel_lost')`,
    ),
    check('boss_encounters_participants_check', sql`${t.participantCount} >= 0`),
    check('boss_encounters_damage_check', sql`${t.totalDamage} >= 0`),
    // One active encounter per guild — the database's job, not the scheduler's.
    // Two processes ticking at once both try to insert; exactly one wins.
    uniqueIndex('boss_encounters_active_guild_uq')
      .on(t.guildId)
      .where(sql`status in ('scheduled','scouting','resolving')`),
    index('boss_encounters_guild_status_idx').on(t.guildId, t.status),
    index('boss_encounters_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`status = 'scouting'`),
    index('boss_encounters_message_idx').on(t.messageId),
  ],
);

/**
 * One committed buddy.
 *
 * Every stat the damage formula reads is **snapshotted at commitment**, not
 * looked up at resolution. Three consequences that are all deliberate: the
 * number a player was quoted in their preview is the number they are paid on;
 * switching buddies afterwards changes nothing about this participation; and
 * the row survives the owned copy being released, so a historical result never
 * develops holes.
 *
 * `waifu_id` carries no foreign key, matching `players.buddy_waifu_id` and the
 * affection-gift rows — a released copy must not take an encounter result with
 * it.
 */
export const bossParticipations = pgTable(
  'boss_participations',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => bossEncounters.id),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /**
     * Discord identity, snapshotted. A public result must render correctly
     * years later without resolving a member who may have left, been renamed,
     * or never been fetchable in the first place.
     */
    discordUserId: text('discord_user_id').notNull(),
    trainerName: text('trainer_name').notNull(),

    /** The exact owned copy. FK-less on purpose — see the table comment. */
    waifuId: bigint('waifu_id', { mode: 'number' }).notNull(),
    speciesId: bigint('species_id', { mode: 'number' }).notNull(),
    speciesSlug: text('species_slug').notNull(),
    /** Nickname when set, species name otherwise — what the result prints. */
    waifuName: text('waifu_name').notNull(),
    level: integer('level').notNull(),
    baseSp: integer('base_sp').notNull(),
    /**
     * **Current** SP at commitment — the value the formula multiplies.
     * Snapshotted rather than re-derived so a later level-up (or a change to
     * the SP formula) cannot rewrite a battle that already happened.
     */
    currentSp: integer('current_sp').notNull(),
    rarity: text('rarity').notNull(),
    affinity: text('affinity').notNull(),
    race: text('race').notNull(),
    affection: integer('affection').notNull(),

    committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Frozen at commitment so a later retune cannot alter this participation. */
    responseBonus: real('response_bonus').notNull().default(0),
    /** Also frozen at commitment — both affinities are known by then. */
    affinityBonus: real('affinity_bonus').notNull().default(0),

    // ── Filled at resolution ────────────────────────────────────────────────
    /** Integer 85–115, interpreted as hundredths. Derived, so a retry matches. */
    performancePercent: integer('performance_percent'),
    attackCount: integer('attack_count'),
    totalDamage: bigint('total_damage', { mode: 'number' }),
    /** XP actually applied — 0 for a max-level buddy, never redirected. */
    xpAwarded: integer('xp_awarded'),
    /** What was granted, as `[{ slug, name, quantity }]`. Empty array is valid. */
    rewardItems: jsonb('reward_items').$type<Record<string, unknown>[]>(),
    /**
     * The idempotency flag. Flipped to `applied` inside the *same* transaction
     * that writes the XP and the inventory rows, so a resolution retry — or a
     * second process taking over a stale claim — pays nobody twice.
     */
    rewardStatus: text('reward_status').notNull().default('pending'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    // One participation per player per encounter. This is what makes a
    // double-clicked Commit safe rather than merely unlikely.
    uniqueIndex('boss_participations_encounter_player_uq').on(t.encounterId, t.playerId),
    index('boss_participations_encounter_idx').on(t.encounterId, t.id),
    index('boss_participations_player_idx').on(t.playerId),
    index('boss_participations_waifu_idx').on(t.waifuId),
    index('boss_participations_pending_idx')
      .on(t.encounterId)
      .where(sql`reward_status = 'pending'`),
    check('boss_participations_level_check', sql`${t.level} >= 1`),
    check('boss_participations_sp_check', sql`${t.currentSp} >= 0 and ${t.baseSp} >= 1`),
    check('boss_participations_damage_check', sql`${t.totalDamage} is null or ${t.totalDamage} >= 0`),
    check('boss_participations_xp_check', sql`${t.xpAwarded} is null or ${t.xpAwarded} >= 0`),
    check(
      'boss_participations_reward_status_check',
      sql`${t.rewardStatus} in ('pending','applied')`,
    ),
  ],
);

/* ───────────────────────── Locations & Travel ───────────────────────── */

/**
 * Which species may be encountered in which region, and how often.
 *
 * A junction table rather than a `species.region` scalar, and the reason is a
 * product requirement rather than taste: the same Waifumon appears in more
 * than one region at *different* rates (a Waifu Valley regular showing up in
 * Twin Peeks at a boosted weight), which a scalar column cannot express.
 *
 * `weight` is region-local and completely replaces `species.per_species_weight`
 * for the regional draw — the global column stays as the authoring default and
 * as the seeder's fallback when a pool entry omits a weight. Waifu Valley is a
 * real row-set here, not an implicit "everything else": modelling the starting
 * region explicitly is what lets the hunt fall back to a *curated* pool rather
 * than to the whole species table.
 *
 * Seeded from region content on every content load, so JSON stays canonical.
 */
export const regionEncounterPools = pgTable(
  'region_encounter_pools',
  {
    regionId: text('region_id').notNull(),
    speciesId: bigint('species_id', { mode: 'number' })
      .notNull()
      .references(() => species.id),
    weight: integer('weight').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.regionId, t.speciesId] }),
    check('region_encounter_pools_weight_check', sql`${t.weight} > 0`),
    check(
      'region_encounter_pools_region_check',
      sql`${t.regionId} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    // The hunt query filters (region_id, rarity) and joins species; region is
    // the selective half and the only one that lives on this table.
    index('region_encounter_pools_region_idx').on(t.regionId),
  ],
);

/** How a pass or route came to be owned. Purchases are audited; grants are not. */
export const TRAVEL_GRANT_SOURCES = ['purchase', 'admin'] as const;
export type TravelGrantSource = (typeof TRAVEL_GRANT_SOURCES)[number];

/**
 * Travel passes a player owns.
 *
 * Explicitly **not** inventory: a pass is a permanent, non-stackable
 * entitlement, and putting it in `player_inventory` would make it a quantity
 * someone could hold two of, sell, or lose to a capacity cap. The composite
 * primary key is the real anti-double-purchase backstop — two concurrent buy
 * clicks race to the same key and exactly one insert survives, so the loser
 * rolls back with its currency deduction intact-and-undone rather than
 * charging twice.
 *
 * Owning the pass and owning a given route are independent facts (see
 * {@link playerUnlockedRoutes}); the pass is the container, routes are the
 * destinations it has been stamped for.
 */
export const playerTravelPasses = pgTable(
  'player_travel_passes',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /** Content id from `tables.travel.passes[]` — 'caravan_pass' today. */
    passId: text('pass_id').notNull(),
    source: text('source').notNull().default('purchase'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.passId] }),
    check('player_travel_passes_source_check', sql`${t.source} in ('purchase','admin')`),
  ],
);

/**
 * Destinations a player has unlocked.
 *
 * Separate from the pass so the first purchase (pass + Twin Peeks, atomically)
 * and every later destination (a route unlock stamped onto the same pass) are
 * the same shape of row. The starting region is deliberately **absent** from
 * this table — Waifu Valley is always reachable, and storing a row for it
 * would invite code that checks the row instead of the rule.
 */
export const playerUnlockedRoutes = pgTable(
  'player_unlocked_routes',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    regionId: text('region_id').notNull(),
    source: text('source').notNull().default('purchase'),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.regionId] }),
    check(
      'player_unlocked_routes_region_check',
      sql`${t.regionId} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    check('player_unlocked_routes_source_check', sql`${t.source} in ('purchase','admin')`),
  ],
);

/** What a travel purchase bought. */
export const TRAVEL_TRANSACTION_KINDS = ['pass', 'route'] as const;
export type TravelTransactionKind = (typeof TRAVEL_TRANSACTION_KINDS)[number];

/**
 * Audit trail for pass and route purchases.
 *
 * A dedicated table rather than a reuse of `shop_transactions`, because that
 * table's `item_id` is `NOT NULL` and foreign-keyed to `items` — a pass is not
 * an item and never will be, so reusing it would mean either minting a fake
 * item row or dropping a constraint that protects every existing shop row.
 * Same shape and same discipline (written inside the purchase transaction),
 * different subject.
 */
export const travelTransactions = pgTable(
  'travel_transactions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    kind: text('kind').notNull(),
    /** Pass purchased, or the pass a route was stamped onto. */
    passId: text('pass_id'),
    /** Destination unlocked. Null only for a pass that grants no route. */
    regionId: text('region_id'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('waifubux'),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('travel_transactions_player_created_idx').on(t.playerId, t.createdAt),
    check('travel_transactions_kind_check', sql`${t.kind} in ('pass','route')`),
    check('travel_transactions_currency_check', sql`${t.currency} in ('waifubux','essence')`),
  ],
);

/* ─────────────────────── World Encounters ───────────────────────
 *
 * Interactive, choice-driven encounters that fire during Hunt or Travel.
 * Distinct from `encounters` (the hunt/species table) — those model a met
 * Waifumon and its capture attempts; world encounters model a decision point
 * with buttons, checks, and effects.
 *
 * Definitions are DB-backed (authored via the admin panel), not JSON —
 * because they carry rich choice/effect trees the JSON content service was
 * not shaped to edit. Region eligibility and route restrictions live in
 * junction tables so an encounter can span several regions or be scoped to a
 * single directed route.
 */

export const WORLD_ENCOUNTER_TYPES = [
  'decision',
  'skill_check',
  'combat',
  'vendor',
  'deity',
  'discovery',
] as const;
export type WorldEncounterType = (typeof WORLD_ENCOUNTER_TYPES)[number];

export const WORLD_ENCOUNTER_RARITIES = ['common', 'uncommon', 'rare', 'mythic'] as const;
export type WorldEncounterRarity = (typeof WORLD_ENCOUNTER_RARITIES)[number];

export const WORLD_ENCOUNTER_LIFECYCLES = ['draft', 'active', 'disabled'] as const;
export type WorldEncounterLifecycle = (typeof WORLD_ENCOUNTER_LIFECYCLES)[number];

/** How the engine reached this encounter. Also stamped on history rows. */
export const WORLD_ENCOUNTER_SOURCES = ['hunt', 'travel'] as const;
export type WorldEncounterSource = (typeof WORLD_ENCOUNTER_SOURCES)[number];

/** Active-instance state machine. */
export const WORLD_ENCOUNTER_ACTIVE_STATUS = [
  'pending',
  'resolved',
  'expired',
  'abandoned',
] as const;
export type WorldEncounterActiveStatus = (typeof WORLD_ENCOUNTER_ACTIVE_STATUS)[number];

/**
 * Effect types the {@link module:src/modules/worldEncounters/effectExecutor}
 * dispatch table understands. Soft-typed (text column) so adding an effect is
 * one handler + one enum entry, no migration required.
 */
export const WORLD_ENCOUNTER_EFFECT_TYPES = [
  'waifubux_gain',
  'waifubux_loss',
  'waifubux_loss_percent',
  'essence_gain',
  'essence_loss',
  'energy_gain',
  'energy_loss',
  'player_xp',
  'buddy_xp',
  'give_item',
  'consume_item',
  'trigger_encounter',
  'trigger_waifumon_encounter',
  'temp_buff',
  'open_vendor',
] as const;
export type WorldEncounterEffectType = (typeof WORLD_ENCOUNTER_EFFECT_TYPES)[number];

/** Check kinds a choice can gate its success/failure on. `none` = auto-success. */
export const WORLD_ENCOUNTER_CHECK_TYPES = ['none', 'sp'] as const;
export type WorldEncounterCheckType = (typeof WORLD_ENCOUNTER_CHECK_TYPES)[number];

export const worldEncounters = pgTable(
  'world_encounters',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull(),
    rarity: text('rarity').notNull(),
    /** Selection weight, scoped to the source pool that survives filtering. */
    weight: integer('weight').notNull().default(10),
    lifecycle: text('lifecycle').notNull().default('draft'),
    huntEligible: boolean('hunt_eligible').notNull().default(true),
    travelEligible: boolean('travel_eligible').notNull().default(false),
    /** Player cooldown in seconds. 0 = no cooldown. */
    cooldownSeconds: integer('cooldown_seconds').notNull().default(0),
    /** Relative path under assets/, e.g. `encounters/bandit_ambush.png`. Nullable. */
    artworkPath: text('artwork_path'),
    /** Optional slug of another world encounter to chain into on resolution. */
    chainedEncounterSlug: text('chained_encounter_slug'),
    /**
     * When true, resolution requires the player to pick a choice; the engine
     * refuses to auto-resolve. Discovery encounters can set false and provide
     * effects on the encounter itself via a synthetic "continue" choice.
     */
    choicesRequired: boolean('choices_required').notNull().default(true),
    /** Free-form metadata for future evolution — vendor inventory template etc. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'world_encounters_type_check',
      sql`${t.type} in ('decision','skill_check','combat','vendor','deity','discovery')`,
    ),
    check(
      'world_encounters_rarity_check',
      sql`${t.rarity} in ('common','uncommon','rare','mythic')`,
    ),
    check(
      'world_encounters_lifecycle_check',
      sql`${t.lifecycle} in ('draft','active','disabled')`,
    ),
    check('world_encounters_weight_check', sql`${t.weight} > 0`),
    check('world_encounters_cooldown_check', sql`${t.cooldownSeconds} >= 0`),
    index('world_encounters_lifecycle_idx').on(t.lifecycle),
  ],
);

/**
 * Region eligibility. An encounter with **no** rows here is treated as
 * globally eligible for its enabled sources — this keeps travel-only global
 * encounters (Bandit Ambush, Wandering Merchant) light on rows.
 */
export const worldEncounterRegions = pgTable(
  'world_encounter_regions',
  {
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id, { onDelete: 'cascade' }),
    regionId: text('region_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.encounterId, t.regionId] }),
    check(
      'world_encounter_regions_region_check',
      sql`${t.regionId} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    index('world_encounter_regions_region_idx').on(t.regionId),
  ],
);

/**
 * Route eligibility for travel encounters. Directional: reverse travel needs
 * its own row. An encounter with `travelEligible=true` and no rows here is
 * eligible on every travel edge, region-scoped only.
 */
export const worldEncounterRoutes = pgTable(
  'world_encounter_routes',
  {
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id, { onDelete: 'cascade' }),
    fromRegion: text('from_region').notNull(),
    toRegion: text('to_region').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.encounterId, t.fromRegion, t.toRegion] }),
    check(
      'world_encounter_routes_from_check',
      sql`${t.fromRegion} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    check(
      'world_encounter_routes_to_check',
      sql`${t.toRegion} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    check('world_encounter_routes_distinct', sql`${t.fromRegion} <> ${t.toRegion}`),
    index('world_encounter_routes_route_idx').on(t.fromRegion, t.toRegion),
  ],
);

/**
 * One choice on an encounter. `requirementsJson`, `checkJson`,
 * `successEffectsJson` and `failureEffectsJson` are validated against the
 * runtime Zod schemas in the module — the DB does not restate them.
 */
export const worldEncounterChoices = pgTable(
  'world_encounter_choices',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    label: text('label').notNull(),
    emoji: text('emoji'),
    requirementsJson: jsonb('requirements_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checkJson: jsonb('check_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({ type: 'none' }),
    successEffectsJson: jsonb('success_effects_json')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    failureEffectsJson: jsonb('failure_effects_json')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    index('world_encounter_choices_encounter_idx').on(t.encounterId, t.sortOrder),
  ],
);

/**
 * Per-player cooldown ledger. Written when an encounter resolves for a
 * player; the selection engine excludes any row whose `expires_at > now`.
 */
export const worldEncounterCooldowns = pgTable(
  'world_encounter_cooldowns',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.encounterId] }),
    index('world_encounter_cooldowns_expires_idx').on(t.expiresAt),
  ],
);

/**
 * A pending interactive world encounter. Discord button clicks resolve it;
 * a partial unique index on `player_id WHERE status='pending'` guarantees a
 * player cannot have two open at once — a double-click races on the insert.
 */
export const activeWorldEncounters = pgTable(
  'active_world_encounters',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id),
    source: text('source').notNull(),
    /** Region the player was in when the encounter fired. */
    regionId: text('region_id').notNull(),
    /** Travel-only: where the trip started. Null on hunt encounters. */
    originRegionId: text('origin_region_id'),
    /** Travel-only: intended destination (already committed before the encounter). */
    destinationRegionId: text('destination_region_id'),
    guildId: bigint('guild_id', { mode: 'number' }),
    channelId: text('channel_id'),
    messageId: text('message_id'),
    status: text('status').notNull().default('pending'),
    /** Snapshot: rolled vendor inventory, deity riddle answers, etc. */
    contextJson: jsonb('context_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedChoiceId: bigint('resolved_choice_id', { mode: 'number' }),
    resolutionJson: jsonb('resolution_json').$type<Record<string, unknown>>(),
  },
  (t) => [
    check(
      'active_world_encounters_source_check',
      sql`${t.source} in ('hunt','travel')`,
    ),
    check(
      'active_world_encounters_status_check',
      sql`${t.status} in ('pending','resolved','expired','abandoned')`,
    ),
    // At most one pending encounter per player — the anti-double-click rail.
    uniqueIndex('active_world_encounters_player_pending_uq')
      .on(t.playerId)
      .where(sql`status = 'pending'`),
    index('active_world_encounters_player_idx').on(t.playerId, t.status),
    index('active_world_encounters_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Immutable audit trail. Written in the same transaction that flips an
 * active encounter to `resolved`, so analytics can never disagree with the
 * player's history.
 */
export const worldEncounterHistory = pgTable(
  'world_encounter_history',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    encounterId: bigint('encounter_id', { mode: 'number' })
      .notNull()
      .references(() => worldEncounters.id),
    choiceId: bigint('choice_id', { mode: 'number' }),
    source: text('source').notNull(),
    regionId: text('region_id').notNull(),
    success: boolean('success'),
    effectsAppliedJson: jsonb('effects_applied_json')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'world_encounter_history_source_check',
      sql`${t.source} in ('hunt','travel')`,
    ),
    index('world_encounter_history_player_idx').on(t.playerId, t.resolvedAt),
    index('world_encounter_history_encounter_idx').on(t.encounterId, t.resolvedAt),
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
export type AffectionGiftRollRow = typeof affectionGiftRolls.$inferSelect;
export type AffectionGiftRow = typeof affectionGifts.$inferSelect;
export type GuildBossStateRow = typeof guildBossState.$inferSelect;
export type BossEncounterRow = typeof bossEncounters.$inferSelect;
export type BossParticipationRow = typeof bossParticipations.$inferSelect;
export type RegionEncounterPoolRow = typeof regionEncounterPools.$inferSelect;
export type PlayerTravelPassRow = typeof playerTravelPasses.$inferSelect;
export type PlayerUnlockedRouteRow = typeof playerUnlockedRoutes.$inferSelect;
export type TravelTransactionRow = typeof travelTransactions.$inferSelect;
export type WorldEncounterRow = typeof worldEncounters.$inferSelect;
export type WorldEncounterRegionRow = typeof worldEncounterRegions.$inferSelect;
export type WorldEncounterRouteRow = typeof worldEncounterRoutes.$inferSelect;
export type WorldEncounterChoiceRow = typeof worldEncounterChoices.$inferSelect;
export type WorldEncounterCooldownRow = typeof worldEncounterCooldowns.$inferSelect;
export type ActiveWorldEncounterRow = typeof activeWorldEncounters.$inferSelect;
export type WorldEncounterHistoryRow = typeof worldEncounterHistory.$inferSelect;
