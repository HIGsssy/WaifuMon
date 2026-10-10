/**
 * Milestone 1 tables only: guilds, players, player_currencies, species, items,
 * player_inventory, daily_claims, shop_transactions.
 * (encounters, capture_attempts, player_waifus, progression events land in M2+.)
 */
import { sql } from 'drizzle-orm';
import { REGION_SQL_LIST } from '../modules/locations/regions';
import {
  EQUIPMENT_EVENT_KIND_SQL_LIST,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_MULTIPLIER_CAP_SQL,
  EQUIPMENT_SLOT_SQL_LIST,
  EQUIPMENT_SOURCE_TYPE_SQL_LIST,
  WORKSHOP_OPERATION_KIND_SQL_LIST,
  WORKSHOP_SLOT_CHOICE_SQL_LIST,
} from '../modules/equipment/vocabulary';
import { FEATURE_KEY_SQL_LIST, FEATURE_UNLOCK_SOURCE_SQL_LIST } from '../modules/features/vocabulary';
import {
  ARTWORK_MODE_SQL_LIST,
  ENCOUNTERED_ARTWORK_KEY_SQL_LIST,
  RESULT_PRESENTATION_FLAVOR_MAX_LENGTH,
  RESULT_PRESENTATION_KEY_SQL_LIST,
} from '../modules/resultPresentation/keys';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
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

/**
 * What an item *is*. The three later additions are all expedition-facing:
 *
 *   - `salvage` — the haul. Exists to be sold; carries a `sell_value` and no
 *     `shop_regions`, so it is vendorable without ever being purchasable.
 *   - `key` — quest and gate items. Sellability is opt-in twice over (a
 *     `sell_value` *and* an explicit content flag), because a key the player
 *     needed and vendored is an unrecoverable mistake.
 *   - `equipment` — **deprecated, do not use.** Equipment shipped as its own
 *     database-backed system (`equipment_definitions` + per-player instances in
 *     `player_equipment`), not as a quantity item. The content loader refuses
 *     any item authored with this category. The value stays in this list, the
 *     `items_category_check` CHECK and the API enum purely for compatibility;
 *     removing it is a later migration.
 */
export const ITEM_CATEGORIES = [
  'capture',
  'material',
  'cosmetic',
  'consumable',
  'salvage',
  'key',
  'equipment',
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * The categories a shop ever *lists for sale to the player*. `capture` is the
 * charm catalog; `consumable` covers the utility items; `key` is for the
 * occasional quest component a regional shop stocks (the Phase Coupler in Base
 * 80085). Everything else is never stocked, so a `shopRegions` assignment on
 * one is a content error, not a hidden shelf. A key item's sellability is
 * still governed by its own double opt-in, so stocking one never makes it
 * vendorable.
 *
 * This is deliberately **not** the mirror of what a player may sell *back*.
 * Buying is region-gated stock; selling is the global `sell_value` on the item
 * row. Widening the category set above therefore cannot put salvage on a shelf.
 */
export const SHOP_ITEM_CATEGORIES = ['capture', 'consumable', 'key'] as const;
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
 *   buddy_affection_gain  — Affection consumables: a flat Affection award to
 *                           whoever is equipped as the Buddy, scaled by the
 *                           `affection_gain` Buddy Bonus like every other
 *                           Affection award in the game.
 */
export const ITEM_EFFECT_TYPES = [
  'restore_energy_full',
  'restore_energy_amount',
  'capture_bonus_charges',
  'buddy_affection_gain',
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

/**
 * Portal Admin access granted to a Discord guild role.
 *
 * The guild *owner* is never represented here: ownership is read live from
 * Discord (see `GuildOwnershipService`) and a row asserting it would be a
 * second, staler opinion. This table holds only the delegated grants an owner
 * has chosen to hand out, so an empty table means "owner only" — which is
 * exactly the behaviour that shipped before it existed.
 *
 * `permissions` is a text array rather than a join table on purpose: a grant
 * is read as one whole set on every authorization, never queried by
 * individual permission, and the set is closed and tiny. The column is
 * validated against `GRANTABLE_PORTAL_PERMISSIONS` in the service, not by a
 * CHECK constraint — the list of permissions is application vocabulary that
 * changes with releases, and a constraint would turn adding one into a
 * migration.
 *
 * Scoped by `discord_guild_id` on every read and write. The unique index on
 * (guild, role) is what makes a grant idempotent to re-add and lets an update
 * address a row by the pair the UI actually knows.
 */
export const guildAdminRoleGrants = pgTable(
  'guild_admin_role_grants',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** Discord guild snowflake — the scope boundary, never an internal id. */
    discordGuildId: text('discord_guild_id').notNull(),
    /** Discord role snowflake. Not validated against Discord at write time. */
    roleId: text('role_id').notNull(),
    permissions: text('permissions').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord user id of the owner who created the grant. Audit only. */
    createdBy: text('created_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord user id of the owner who last changed it. Audit only. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    uniqueIndex('guild_admin_role_grants_guild_role_uq').on(t.discordGuildId, t.roleId),
    index('guild_admin_role_grants_guild_idx').on(t.discordGuildId),
  ],
);

export type GuildAdminRoleGrantRow = typeof guildAdminRoleGrants.$inferSelect;

export const playerCurrencies = pgTable(
  'player_currencies',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .primaryKey()
      .references(() => players.id),
    huntEnergy: integer('hunt_energy').notNull().default(0),
    waifubux: integer('waifubux').notNull().default(0),
    essence: integer('essence').notNull().default(0),
    /**
     * Salvaged Components — the Equipment-only material Patch pays for
     * dismantled gear and charges for fabrication (`0049`). A balance beside
     * the currencies rather than an inventory item, so no inventory flow can
     * sell, trade, gift or consume it. Only `currencyService` moves it, and
     * only the Workshop calls those methods.
     */
    salvagedComponents: integer('salvaged_components').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('player_currencies_hunt_energy_check', sql`${t.huntEnergy} >= 0`),
    check('player_currencies_waifubux_check', sql`${t.waifubux} >= 0`),
    check('player_currencies_essence_check', sql`${t.essence} >= 0`),
    check('player_currencies_salvaged_components_check', sql`${t.salvagedComponents} >= 0`),
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
    /**
     * What a shop pays the player *for* this item. Null means "not sellable",
     * and it is the only spelling of that fact — the CHECK forbids `0`, so
     * every consumer can test `sell_value IS NOT NULL` and be done.
     *
     * Global rather than regional: there is no per-region sell modifier yet,
     * and inventing one in the column shape before content can express it
     * would be a column nobody writes. A regional ladder later is an additive
     * table, not a change to this one.
     */
    sellValue: integer('sell_value'),
    /** Which currency `buy_price` is denominated in. */
    priceCurrency: text('price_currency').notNull().default('waifubux'),
    dailyStockLimit: integer('daily_stock_limit'),
    /** Non-null makes the item usable from the inventory screen. */
    effectType: text('effect_type'),
    effectConfig: jsonb('effect_config').$type<Record<string, unknown>>(),
    description: text('description').notNull().default(''),
    emoji: text('emoji'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * The most of this item one player may hold. Null (almost every item)
     * means unlimited. Enforced by `inventoryService.addItem` inside the same
     * conditional upsert that writes the quantity, so the limit holds under
     * concurrent grants rather than depending on a read-then-write in a
     * caller. Exists for permanent key items such as the Transporter Beacon,
     * where "own two" is meaningless and a second copy would be a bug.
     */
    maxOwned: integer('max_owned'),
  },
  (t) => [
    check('items_max_owned_check', sql`${t.maxOwned} is null or ${t.maxOwned} > 0`),
    check(
      'items_category_check',
      sql`${t.category} in ('capture','material','cosmetic','consumable','salvage','key','equipment')`,
    ),
    // `0` is not a third way to say "not sellable" — see the column comment.
    check('items_sell_value_check', sql`${t.sellValue} is null or ${t.sellValue} > 0`),
    check(
      'items_effect_type_check',
      sql`${t.effectType} is null or ${t.effectType} in ('restore_energy_full','restore_energy_amount','capture_bonus_charges','buddy_affection_gain')`,
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
    /**
     * Which direction the money moved. Every column below keeps its plain
     * meaning in both directions — `quantity` is how many items moved,
     * `total_price` is how much money moved — and the *direction* is read
     * from here, never from a sign. One ledger answers "what happened to this
     * player's money" without a UNION.
     */
    kind: text('kind').notNull().default('purchase'),
    quantity: integer('quantity').notNull(),
    /** `buy_price` on a purchase, `sell_value` on a sale. */
    unitPrice: integer('unit_price').notNull(),
    totalPrice: integer('total_price').notNull(),
    /** Currency the transaction settled in; `balance_after` is that currency. */
    currency: text('currency').notNull().default('waifubux'),
    /** The balance after the debit (purchase) or credit (sale). */
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shop_transactions_player_created_idx').on(t.playerId, t.createdAt),
    index('shop_transactions_player_kind_idx').on(t.playerId, t.kind, t.createdAt),
    check('shop_transactions_currency_check', sql`${t.currency} in ('waifubux','essence')`),
    check('shop_transactions_kind_check', sql`${t.kind} in ('purchase','sale')`),
  ],
);

/** Direction of a `shop_transactions` row. See the `kind` column comment. */
export const SHOP_TRANSACTION_KINDS = ['purchase', 'sale'] as const;
export type ShopTransactionKind = (typeof SHOP_TRANSACTION_KINDS)[number];

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
    /**
     * Where this encounter came from, when it was *spawned* rather than
     * hunted (see `wildEncounterSpawner`).
     *
     * `origin_kind` names the subsystem — `world_encounter`, `quest`, `item`,
     * `event`, `deity`, `admin` — and `origin_ref` is that subsystem's own
     * identifier for the one thing that caused this spawn (for a World
     * Encounter, the `active_world_encounters.id` that resolved).
     *
     * The pair is the **idempotency key**, enforced by a partial unique
     * index below. That is what makes a double-clicked Continue button, a
     * retried job, or a replayed quest step spawn one encounter rather than
     * two: the second insert loses the race on the index and the caller reads
     * the winner back. An ordinary hunt leaves both columns null and is
     * unaffected.
     */
    originKind: text('origin_kind'),
    originRef: text('origin_ref'),
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
    // Idempotency for spawned encounters. Partial, so the millions of rows a
    // hunt writes (both columns null) never enter the index.
    uniqueIndex('encounters_origin_uq')
      .on(t.originKind, t.originRef)
      .where(sql`origin_kind is not null and origin_ref is not null`),
  ],
);

/**
 * Subsystems allowed to spawn a wild encounter directly, rather than through
 * the hunt roll. Kept as a closed set so `origin_kind` stays queryable and a
 * typo becomes a compile error instead of an unanalysable row.
 */
export const WILD_ENCOUNTER_ORIGIN_KINDS = [
  'world_encounter',
  'quest',
  'item',
  'event',
  'exploration',
  'deity',
  'admin',
] as const;
export type WildEncounterOriginKind = (typeof WILD_ENCOUNTER_ORIGIN_KINDS)[number];

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
    /**
     * How this copy was obtained when it was not an ordinary capture, e.g.
     * `dungeon_recruit` (migration 0059). Null for every capture so far: the
     * capture flow does not write it. Provenance only — nothing reads it to
     * decide ownership.
     */
    acquiredVia: text('acquired_via'),
    /**
     * Idempotency key of a direct grant (migration 0059), unique when present,
     * so a retried guaranteed recruitment cannot create a second copy. Null
     * for captures, which are made idempotent by their encounter.
     */
    grantKey: text('grant_key'),
  },
  (t) => [
    uniqueIndex('player_waifus_grant_key_uq')
      .on(t.grantKey)
      .where(sql`grant_key is not null`),
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
    /**
     * The boss's managed artwork at spawn (migration 0058), a logical
     * `artwork_assets` id: it wins over `bossArtwork` while the asset is
     * active, and its image is read live. No foreign key — the encounter is
     * history and must not pin an asset an admin later removes.
     */
    bossArtworkAssetId: uuid('boss_artwork_asset_id'),
    rewardTable: text('reward_table').notNull(),
    /** `rewardTables[key].version` as it stood when the encounter opened. */
    rewardTableVersion: text('reward_table_version').notNull(),
    /**
     * The validated reward table and each Equipment entry's eligible base
     * definitions, frozen at spawn (`BossRewardSnapshot`). Payout reads only
     * this, so an admin edit reaches future bosses and never one already
     * announced. Null on encounters spawned before migration 0047, which pay
     * from the live table.
     */
    rewardSnapshot: jsonb('reward_snapshot').$type<Record<string, unknown>>(),
    /**
     * The boss's player-facing prose, frozen at spawn (`BossEncounterSnapshot`,
     * migration 0057). An admin edit to the definition reaches the next
     * encounter and never one already drawn. Null on encounters spawned before
     * the migration, which read the live definition.
     */
    bossSnapshot: jsonb('boss_snapshot').$type<Record<string, unknown>>(),
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

/** How a constructed key item came to be owned. */
export const KEY_ITEM_CONSTRUCTION_SOURCES = ['construct', 'migration'] as const;
export type KeyItemConstructionSource = (typeof KEY_ITEM_CONSTRUCTION_SOURCES)[number];

/**
 * Audit trail for key-item recipes (`tables.keyItemRecipes`) — the Transporter
 * Beacon today.
 *
 * Audit only, not the entitlement. The item itself lives in `player_inventory`
 * like every other key item, capped by `items.max_owned`; this table records
 * what was paid for it, written inside the construction transaction exactly as
 * `shop_transactions` and `travel_transactions` are. `migration` rows are the
 * 0043 backfill, which granted the beacon to players who had already bought
 * the Assteroid Belt route and paid nothing further for it.
 */
export const keyItemConstructions = pgTable(
  'key_item_constructions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /** Content id from `tables.keyItemRecipes[]`. */
    recipeId: text('recipe_id').notNull(),
    outputItemId: bigint('output_item_id', { mode: 'number' })
      .notNull()
      .references(() => items.id),
    source: text('source').notNull().default('construct'),
    waifubuxSpent: integer('waifubux_spent').notNull().default(0),
    /** `[{ slug, quantity }]` consumed. Empty for a migration grant. */
    inputs: jsonb('inputs').$type<{ slug: string; quantity: number }[]>().notNull(),
    /** WaifuBux after the charge. Null for a migration grant, which charged nothing. */
    balanceAfter: integer('balance_after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('key_item_constructions_player_idx').on(t.playerId, t.createdAt),
    check('key_item_constructions_source_check', sql`${t.source} in ('construct','migration')`),
    check('key_item_constructions_spent_check', sql`${t.waifubuxSpent} >= 0`),
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
  'affection_gain',
  'give_item',
  'give_equipment',
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
    /** Authored flavor text — presentation only. Null when unauthored. */
    outcomeText: text('outcome_text'),
    successText: text('success_text'),
    failureText: text('failure_text'),
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
    /**
     * When this row is a chained continuation, points at the active
     * encounter that resolved with a `trigger_encounter` (or equivalent)
     * follow-up. `ON DELETE SET NULL` so cleaning up historical rows never
     * cascades the child continuation away.
     */
    continuationOfId: bigint('continuation_of_id', { mode: 'number' }),
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
    index('active_world_encounters_continuation_of_idx').on(t.continuationOfId),
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
    /**
     * The flavor line the player was actually shown, resolved at resolution
     * time. A snapshot, so a later edit to the encounter's authored text can
     * never rewrite what history says happened. Null when none was shown —
     * and on every row written before this column existed.
     */
    resolvedOutcomeText: text('resolved_outcome_text'),
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

/**
 * Global World Encounter runtime tuning — one row, edited from Portal Admin.
 *
 * These four values used to live in `content/tables.json`, which meant every
 * change to an encounter rate was a content edit plus a reload. They are the
 * knobs an operator actually wants to turn while watching a live server, so
 * they live in the database instead: a write here is visible to the engine
 * within seconds, with no rebuild, redeploy, or content reload.
 *
 * **A singleton, enforced by the database.** `id` is fixed at 1 by a CHECK, so
 * "the settings" is always exactly one row and no code has to decide which of
 * several rows is authoritative.
 *
 * Ranges are CHECK constraints rather than only application validation,
 * because these values divide the game's pacing: a chance outside [0, 1] or a
 * negative expiry would not error, it would quietly make encounters impossible
 * or instantaneous. The API validates too — this is the backstop for anything
 * that reaches the table another way.
 *
 * Defaults deliberately mirror the shipped `content/tables.json` values, so a
 * deployment that migrates and never opens the panel behaves exactly as it did
 * before this table existed.
 */
export const worldEncounterSettings = pgTable(
  'world_encounter_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** Probability a hunt is interrupted by a world encounter. */
    huntChance: real('hunt_chance').notNull().default(0.35),
    /** Probability a completed travel is interrupted by one. */
    travelChance: real('travel_chance').notNull().default(0.2),
    /** How long a presented encounter stays answerable. */
    defaultExpirySeconds: integer('default_expiry_seconds').notNull().default(600),
    /**
     * Testing switch: skip the probability roll so an eligible encounter fires
     * every time.
     *
     * It replaces *only* the dice. Cooldowns, the one-pending-encounter rule,
     * region and route eligibility, source eligibility and lifecycle all still
     * apply — see `tryRollForHunt` / `tryRollForTravel`, which hand off to the
     * same `rollAndActivate` either way.
     */
    forceTrigger: boolean('force_trigger').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of whoever last saved, for an audit trail. Null when seeded. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('world_encounter_settings_singleton_check', sql`${t.id} = 1`),
    check(
      'world_encounter_settings_hunt_chance_check',
      sql`${t.huntChance} >= 0 and ${t.huntChance} <= 1`,
    ),
    check(
      'world_encounter_settings_travel_chance_check',
      sql`${t.travelChance} >= 0 and ${t.travelChance} <= 1`,
    ),
    check(
      'world_encounter_settings_expiry_check',
      sql`${t.defaultExpirySeconds} >= 30 and ${t.defaultExpirySeconds} <= 86400`,
    ),
  ],
);
export type WorldEncounterSettingsRow = typeof worldEncounterSettings.$inferSelect;

/**
 * World encounter vendor — definition. One row per named vendor
 * (Wandering Merchant, etc.). `stockTemplateJson` is the authoring shape;
 * a per-encounter instance snapshots and possibly randomises it.
 */
/**
 * One row per applied encounter import — the audit trail for content
 * promotion.
 *
 * Written inside the import transaction, so a log row exists if and only if
 * the content it describes actually landed. A failed or refused import leaves
 * nothing behind, which is what makes this table answerable to "what is on
 * this server and who put it there?".
 *
 * Records the actor, the package's own version and label, the source filename
 * the operator uploaded, and the counts the plan predicted. It deliberately
 * does not store the package body: packages are large, they are already in
 * source control or the operator's hands, and a copy here would be a second
 * place for stale content to live.
 */
export const worldEncounterImportLog = pgTable(
  'world_encounter_import_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** Discord user id of the operator who applied it. Null for a bearer call. */
    actorDiscordUserId: text('actor_discord_user_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    packageFormat: text('package_format').notNull(),
    packageVersion: integer('package_version').notNull(),
    /** The package's own `exportedAt`, as sent. Null when absent. */
    packageExportedAt: text('package_exported_at'),
    /** Free-form provenance from the package, e.g. "staging 2026-09-05". */
    packageLabel: text('package_label'),
    /** Filename the operator uploaded, when the client sent one. */
    sourceFilename: text('source_filename'),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    vendorCreatedCount: integer('vendor_created_count').notNull().default(0),
    vendorUpdatedCount: integer('vendor_updated_count').notNull().default(0),
    /** Slugs touched, for a quick "what changed" without re-reading the file. */
    encounterSlugs: jsonb('encounter_slugs').$type<string[]>().notNull().default([]),
  },
  (t) => [index('world_encounter_import_log_applied_idx').on(t.appliedAt)],
);

export type WorldEncounterImportLogRow = typeof worldEncounterImportLog.$inferSelect;

export const worldEncounterVendors = pgTable(
  'world_encounter_vendors',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    vendorKey: text('vendor_key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    stockTemplateJson: jsonb('stock_template_json')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * The vendor as it exists for one active encounter instance. `stockJson` is
 * the mutating source of truth — a purchase decrements the entry inside a
 * transaction under a row lock, so double-clicks and concurrent buys can
 * never oversell.
 *
 * Unique on `activeEncounterId` so re-opening a vendor from the same
 * encounter never regenerates its inventory.
 */
export const worldEncounterVendorInstances = pgTable(
  'world_encounter_vendor_instances',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    activeEncounterId: bigint('active_encounter_id', { mode: 'number' })
      .notNull()
      .references(() => activeWorldEncounters.id),
    vendorKey: text('vendor_key').notNull(),
    stockJson: jsonb('stock_json').$type<Record<string, unknown>[]>().notNull().default([]),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('world_encounter_vendor_instances_active_encounter_uq').on(t.activeEncounterId),
    index('world_encounter_vendor_instances_vendor_key_idx').on(t.vendorKey),
  ],
);

/**
 * Player achievement state (Achievements & Leaderboards, Phase 1).
 *
 * The **only** durable achievement data. Definitions, criteria, categories and
 * hidden flags live in content (`content/achievements.json`) — this table holds
 * nothing an admin would edit, just the per-player facts that current state
 * cannot reconstruct: *when* a badge was first earned.
 *
 * Achievements are otherwise **derived**: progress is computed on read from the
 * canonical player state (level, collection, captures, buddy, bosses…). A row
 * appears here the first time an achievement is observed unlocked, stamping
 * `unlocked_at`. That is the one fact worth persisting — a derived unlock time
 * cannot be recovered later, and once earned a badge must never revert even if
 * the underlying metric later dips (a released copy, a re-tuned threshold).
 *
 * `achievement_id` is the content slug, soft-typed on purpose: adding or
 * retiring an achievement is a content edit, never a migration. A row whose id
 * no longer matches any definition is simply not surfaced.
 */
export const playerAchievements = pgTable(
  'player_achievements',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    achievementId: text('achievement_id').notNull(),
    /**
     * Progress snapshot at the moment of unlock, for auditing only. Live
     * progress on a *locked* achievement is always derived and never stored;
     * this records what the metric read when the badge was earned.
     */
    progress: integer('progress').notNull().default(0),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.achievementId] }),
    index('player_achievements_player_idx').on(t.playerId),
    check('player_achievements_progress_check', sql`${t.progress} >= 0`),
  ],
);

/**
 * Authored presentation for lightweight gameplay outcomes (a hunt find, a
 * released Waifumon): flavor text and artwork, with weighted variants.
 *
 * **Presentation only.** Gameplay decides what happened — amounts, items,
 * species, state — before anything here is read, and nothing here is read
 * back by gameplay. There are deliberately no reward, rarity or chance
 * columns.
 *
 * `presentation_key` is a closed, code-defined list
 * (`modules/resultPresentation/keys.ts`); the CHECKs below mirror it and the
 * per-key artwork rule, so a row the runtime could not honour cannot be
 * stored. Path *shape* is validated in the application; path *containment* is
 * enforced by `resolveAssetPath` when the artwork is used.
 */
export const resultPresentationVariants = pgTable(
  'result_presentation_variants',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    presentationKey: text('presentation_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Relative selection weight among this key's enabled variants. */
    weight: integer('weight').notNull().default(1),
    /** Authored prose shown alongside the code-generated result. Null = none. */
    flavorText: text('flavor_text'),
    /** Path relative to `ASSETS_DIR`; used when `artwork_mode = 'custom'`. */
    artworkPath: text('artwork_path'),
    artworkMode: text('artwork_mode').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'result_presentation_variants_key_check',
      sql`${t.presentationKey} in (${sql.raw(RESULT_PRESENTATION_KEY_SQL_LIST)})`,
    ),
    check('result_presentation_variants_weight_check', sql`${t.weight} > 0`),
    check(
      'result_presentation_variants_artwork_mode_check',
      sql`${t.artworkMode} in (${sql.raw(ARTWORK_MODE_SQL_LIST)})`,
    ),
    check(
      'result_presentation_variants_encountered_key_check',
      sql`${t.artworkMode} <> 'encountered' or ${t.presentationKey} in (${sql.raw(ENCOUNTERED_ARTWORK_KEY_SQL_LIST)})`,
    ),
    check(
      'result_presentation_variants_custom_artwork_check',
      sql`${t.artworkMode} <> 'custom' or ${t.artworkPath} is not null`,
    ),
    check(
      'result_presentation_variants_flavor_text_check',
      sql`${t.flavorText} is null or (btrim(${t.flavorText}) <> '' and char_length(${t.flavorText}) <= ${sql.raw(String(RESULT_PRESENTATION_FLAVOR_MAX_LENGTH))})`,
    ),
    index('result_presentation_variants_key_idx').on(t.presentationKey, t.enabled),
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
export type PlayerExpeditionRow = typeof playerExpeditions.$inferSelect;
export type WaifumonSessionRow = typeof waifumonSessions.$inferSelect;
export type PlayerDailyQuestRow = typeof playerDailyQuests.$inferSelect;
export type PlayerDailySplashViewRow = typeof playerDailySplashViews.$inferSelect;
export type PlayerActiveEffectRow = typeof playerActiveEffects.$inferSelect;
export type AffectionGiftRollRow = typeof affectionGiftRolls.$inferSelect;
export type AffectionGiftRow = typeof affectionGifts.$inferSelect;
export type GuildBossStateRow = typeof guildBossState.$inferSelect;
export type BossDefinitionRow = typeof bossDefinitions.$inferSelect;
export type BossDefinitionEventRow = typeof bossDefinitionEvents.$inferSelect;
export type BossEncounterRow = typeof bossEncounters.$inferSelect;
export type BossParticipationRow = typeof bossParticipations.$inferSelect;
export type RegionEncounterPoolRow = typeof regionEncounterPools.$inferSelect;
export type PlayerTravelPassRow = typeof playerTravelPasses.$inferSelect;
export type PlayerUnlockedRouteRow = typeof playerUnlockedRoutes.$inferSelect;
export type TravelTransactionRow = typeof travelTransactions.$inferSelect;
export type KeyItemConstructionRow = typeof keyItemConstructions.$inferSelect;
export type WorldEncounterRow = typeof worldEncounters.$inferSelect;
export type WorldEncounterRegionRow = typeof worldEncounterRegions.$inferSelect;
export type WorldEncounterRouteRow = typeof worldEncounterRoutes.$inferSelect;
export type WorldEncounterChoiceRow = typeof worldEncounterChoices.$inferSelect;
export type WorldEncounterCooldownRow = typeof worldEncounterCooldowns.$inferSelect;
export type ActiveWorldEncounterRow = typeof activeWorldEncounters.$inferSelect;
export type WorldEncounterHistoryRow = typeof worldEncounterHistory.$inferSelect;
export type WorldEncounterVendorRow = typeof worldEncounterVendors.$inferSelect;
export type WorldEncounterVendorInstanceRow = typeof worldEncounterVendorInstances.$inferSelect;
export type PlayerAchievementRow = typeof playerAchievements.$inferSelect;
export type ResultPresentationVariantRow = typeof resultPresentationVariants.$inferSelect;

/**
 * Expedition lifecycle. `active` is the only state a mission can be deployed
 * into; every other state is terminal in the sense that nothing re-enters
 * `active`.
 *
 *   active ──(due, resolve)──► resolved ──(claim)──► claimed
 *      └────(cancel)────► cancelled
 *
 * `cancelled` never rolls an outcome and never pays: it returns the deployed
 * copy and nothing else.
 */
export const EXPEDITION_STATUSES = ['active', 'resolved', 'claimed', 'cancelled'] as const;
export type ExpeditionStatus = (typeof EXPEDITION_STATUSES)[number];

/**
 * What a resolved mission did. Three values rather than a boolean, because
 * `exceptional` is a *better success*, not a different axis — and because an
 * enum leaves room for a fourth outcome without a column change.
 */
export const EXPEDITION_OUTCOMES = ['failure', 'success', 'exceptional'] as const;
export type ExpeditionOutcome = (typeof EXPEDITION_OUTCOMES)[number];

export const playerExpeditions = pgTable(
  'player_expeditions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /**
     * Which slot *within its region* this mission occupies. 1-based.
     *
     * No longer the concurrency key. Concurrency is regional: the active
     * constraint is `(player_id, region)`, so a player's capacity is the
     * number of regions they can reach with expedition content in them, and
     * adding a region raises it with no edit anywhere.
     *
     * The column is kept, and always written as 1, for one reason: it is the
     * hook for the only concurrency axis regions do *not* derive — a
     * per-region ladder ("Twin Peeks supports two at once"). That future is an
     * index swap to `(player_id, region, slot_index)` and a per-region cap in
     * content; the column, its `>= 1` CHECK and its path through the service
     * and the view are already here. Dropping it would rewrite every
     * historical row to buy back four bytes and close that door.
     */
    slotIndex: integer('slot_index').notNull().default(1),
    /**
     * The content key this mission was deployed from. Recorded rather than
     * referenced: content is not a table, and the definition may be edited,
     * disabled or removed while the mission is in flight.
     */
    expeditionKey: text('expedition_key').notNull(),
    region: text('region').notNull(),
    /**
     * The deployed copy. No FK, matching the documented precedent for
     * `buddy_waifu_id` and `care_mode_waifu_id`.
     */
    waifuId: bigint('waifu_id', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completesAt: timestamp('completes_at', { withTimezone: true }).notNull(),
    /**
     * The chances computed at deployment, from the definition and the copy
     * that was sent. Persisted rather than recomputed so a mission resolves
     * under the rules it was started under, however content moves afterwards.
     *
     * Never serialized to a client — see `suitability_band`, which is.
     */
    successChance: real('success_chance').notNull(),
    exceptionalChance: real('exceptional_chance').notNull(),
    /** The band the player was shown. The only odds any client ever sees. */
    suitabilityBand: text('suitability_band').notNull(),
    /**
     * **The immutable contract.** Everything resolution needs, copied out of
     * content at deployment: the reward tables, the display metadata, and the
     * config version that produced the chances above.
     *
     * This is what makes a mission survive a content deploy. Once it is
     * written, resolution reads nothing from the content snapshot at all — so
     * retuning a table, disabling a mission or removing it from the files
     * affects future deployments only, and a player who committed twelve hours
     * gets the deal they were offered.
     *
     * Cleared at resolution, in the same statement that writes `rewards`: by
     * then the outcome is decided and the plan can never be needed again, so
     * keeping it would be storing every historical mission's tables forever
     * for no reader. The table ids and versions are copied into `rewards` for
     * audit before it goes.
     */
    resolutionPlan: jsonb('resolution_plan').$type<Record<string, unknown> | null>(),
    /** The uniform draw the outcome was decided by. Audit only. */
    resolutionRoll: real('resolution_roll'),
    outcome: text('outcome'),
    /**
     * The resolved payout, written once. A *resolved payload*, not a table
     * reference: what the player won must survive an edit to the table they
     * won it from, and claiming must never need to roll anything.
     */
    rewards: jsonb('rewards').$type<Record<string, unknown> | null>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /**
     * Which derivation produced this row, mirroring `BOSS_REWARD_LOGIC_VERSION`.
     * Records *how* the numbers were computed, so a later change to the maths
     * is auditable rather than retroactive.
     */
    logicVersion: integer('logic_version').notNull().default(1),
  },
  (t) => [
    check(
      'player_expeditions_status_check',
      sql`${t.status} in ('active','resolved','claimed','cancelled')`,
    ),
    check(
      'player_expeditions_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in ('failure','success','exceptional')`,
    ),
    check('player_expeditions_slot_check', sql`${t.slotIndex} >= 1`),
    // Derived from the canonical region list rather than spelled out, so a
    // new region widens this constraint in the same migration that widens
    // every other one.
    check(
      'player_expeditions_region_check',
      sql`${t.region} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    // The state machine's illegal states, made unrepresentable rather than
    // merely unreached. A resolved row has an outcome and rewards; an active
    // one has neither; a claim implies a resolution; a cancellation implies
    // no outcome at all.
    check(
      'player_expeditions_active_shape_check',
      sql`(${t.status} = 'active') = (${t.resolvedAt} is null and ${t.cancelledAt} is null)`,
    ),
    check(
      'player_expeditions_resolved_shape_check',
      sql`(${t.resolvedAt} is null) = (${t.outcome} is null)`,
    ),
    check(
      'player_expeditions_claimed_shape_check',
      sql`${t.claimedAt} is null or ${t.resolvedAt} is not null`,
    ),
    check(
      'player_expeditions_cancelled_shape_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    /**
     * **One active mission per player per region.** This — not a count in the
     * service — is what makes a double-clicked Deploy, or two requests racing
     * on the same region, produce exactly one mission: the loser takes a
     * unique violation rather than passing a check that read a stale count.
     *
     * Keyed on the region rather than on the player alone because that *is*
     * the rule: two active missions in different regions are legal and
     * expected, and a player's concurrency is simply how many regions they can
     * reach. Terminal rows are excluded, so claiming or cancelling frees the
     * region with no extra write.
     */
    uniqueIndex('player_expeditions_player_region_active_uq')
      .on(t.playerId, t.region)
      .where(sql`${t.status} = 'active'`),
    /**
     * A copy cannot be in two places at once — including two *regions*.
     * Deliberately global and deliberately independent of the index above:
     * "one mission per region" and "one mission per WaifuMon" are different
     * rules, and only this one stops a player shuttling the same WaifuMon
     * across every region they have unlocked.
     */
    uniqueIndex('player_expeditions_waifu_active_uq')
      .on(t.waifuId)
      .where(sql`${t.status} = 'active'`),
    /** Serves the due-mission sweep a worker tick would run. */
    index('player_expeditions_due_idx')
      .on(t.completesAt)
      .where(sql`${t.status} = 'active'`),
    /**
     * Serves the per-player open-mission read, which regional concurrency made
     * the hot path: every expedition screen now lists *every* region the
     * player has something running in, not just one row.
     */
    index('player_expeditions_player_open_idx')
      .on(t.playerId, t.region)
      .where(sql`${t.status} in ('active','resolved')`),
    /** Serves the profile/portal history read. */
    index('player_expeditions_player_history_idx').on(t.playerId, t.startedAt),
  ],
);

/**
 * Completed load-test runs (Portal Admin → Load Testing).
 *
 * One row per run, written once when the run ends. This is a comparison log,
 * not a monitoring store: enough to line up "3400GE staging, 25 players"
 * against "Scale VM, 25 players" — scenario, concurrency, client-observed
 * latency and throughput, and one compact System Metrics snapshot from each end
 * of the run. No time series is kept; the System Metrics page is where a run is
 * watched live.
 *
 * `summary`, `metrics_start` and `metrics_end` are JSON because their shape is
 * the harness's own report format, read back only by the Portal page that
 * wrote them. `host_info` records the machine as the process saw it, so a row
 * stays interpretable after the host label is forgotten.
 *
 * Present on every deployment (migrations are not environment-specific), and
 * simply empty wherever `LOAD_TESTING_ENABLED` is off.
 */
export const loadTestRuns = pgTable(
  'load_test_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    runKey: text('run_key').notNull().unique(),
    status: text('status').notNull(),
    profile: text('profile').notNull(),
    cardMode: text('card_mode'),
    concurrency: integer('concurrency').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    elapsedSeconds: integer('elapsed_seconds').notNull(),
    seed: integer('seed').notNull(),
    label: text('label'),
    hostLabel: text('host_label'),
    operatorDiscordId: text('operator_discord_id'),
    hostInfo: jsonb('host_info').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    metricsStart: jsonb('metrics_start').$type<Record<string, unknown>>(),
    metricsEnd: jsonb('metrics_end').$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('load_test_runs_status_check', sql`${t.status} in ('completed','stopped','failed')`),
    index('load_test_runs_started_idx').on(t.startedAt),
  ],
);

export type LoadTestRunRow = typeof loadTestRuns.$inferSelect;

/* ─────────────────────────────── Equipment ───────────────────────────────
 *
 * Player-owned gear that converts the Buddy's Current SP into combat stats
 * (ATK / DEF / HP). Four tables form the model and two are ledgers:
 *
 *   equipment_definitions — the content catalogue. **Database-authoritative**,
 *     like world encounters: startup inserts missing keys and never updates,
 *     and content moves between environments by export/import package.
 *   player_equipment      — one row per owned instance, even when two are
 *     identical. Never hard-deleted; admin removal sets `removed_at`.
 *   player_loadouts       — named configurations. V1 exposes exactly one, the
 *     active loadout; presets are the same rows with `is_active = false`.
 *   player_loadout_slots  — what a loadout has in each slot.
 *   equipment_events      — append-only observability ledger.
 *   equipment_import_log  — audit trail for content packages.
 *
 * The invariants that matter most are enforced by the database, not by code:
 *
 *   - **Ownership and slot compatibility.** A slot row carries `player_id` and
 *     `slot` and is foreign-keyed on `(equipment_id, player_id, slot)` to the
 *     instance, and on `(loadout_id, player_id)` to the loadout. Equipping
 *     another player's instance, or an Attack item into the Health slot, is a
 *     foreign-key violation even if the service has a bug.
 *   - **One item per slot per loadout** — the slot table's primary key.
 *   - **One active loadout per player** — a partial unique index.
 *   - **Referenced definitions cannot be hard-deleted** — `ON DELETE RESTRICT`.
 *   - **A grant is applied once** — a partial unique index on `grant_key`, the
 *     same technique as `encounters_origin_uq`.
 *
 * The one writer of these tables is `modules/equipment`;
 * `tests/unit/equipmentBoundary.test.ts` fails if anything else writes them.
 */

const RARITY_SQL_LIST = RARITIES.map((r) => `'${r}'`).join(',');

export const equipmentDefinitions = pgTable(
  'equipment_definitions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /**
     * The stable identity — the only one content, packages, reward tables and
     * logs ever use. Immutable once created; a rename is a new definition.
     */
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Which slot this gear fills. Immutable once any instance references the
     * definition (service-enforced): instances copy it at grant time, and the
     * slot foreign key depends on the two agreeing.
     */
    slot: text('slot').notNull(),
    /** Waifumon rarity codes; V1 authoring admits N–UR only (see vocabulary). */
    rarity: text('rarity').notNull(),
    /**
     * The range an instance's multiplier is rolled from, in **basis points**
     * (8000 = ×0.80, 32000 = ×3.20): one of `min, min+step, …, max`. The
     * multiplier always applies to the definition's own slot's stat — there is
     * exactly one, so a definition cannot carry a multiplier for another slot.
     *
     * Integers, never floats, for the reason `seductivePower.ts` records: the
     * errors in binary fractions land exactly where rounding decides between
     * two integers a player can see.
     *
     * Authoring input, not combat input: an owned instance stores the value it
     * rolled (`player_equipment.rolled_multiplier_bp`) and combat reads only
     * that, so retuning a range never changes gear a player already has.
     */
    multiplierMinBp: integer('multiplier_min_bp').notNull(),
    multiplierMaxBp: integer('multiplier_max_bp').notNull(),
    multiplierStepBp: integer('multiplier_step_bp').notNull(),
    /**
     * Reserved for the data-driven effect system (`{ effectId, value,
     * qualifiers }`). V1 validation requires an empty array, so no inert
     * effect can ship before the mechanics that would read it.
     */
    secondaryEffects: jsonb('secondary_effects')
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Regional identity for flavour and filtering. Null = not regional. */
    regionId: text('region_id'),
    /** Relative to `ASSETS_DIR`. Null = slot/rarity presentation only. */
    artworkPath: text('artwork_path'),
    /**
     * Gates **acquisition** only: a disabled definition stops dropping, stops
     * appearing in shops and refuses new grants. Instances already owned stay
     * owned and stay equipable.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Mirrors `items.shop_regions`. Unused until shops sell equipment. */
    shopRegions: text('shop_regions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    buyPrice: integer('buy_price'),
    priceCurrency: text('price_currency').notNull().default('waifubux'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of whoever last saved it. Null for seeded rows. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('equipment_definitions_slot_check', sql`${t.slot} in (${sql.raw(EQUIPMENT_SLOT_SQL_LIST)})`),
    check('equipment_definitions_rarity_check', sql`${t.rarity} in (${sql.raw(RARITY_SQL_LIST)})`),
    check(
      'equipment_definitions_multiplier_range_check',
      // The CASE guards the modulo: AND does not short-circuit in SQL, so a
      // zero step must fail the check rather than raise division by zero.
      sql`${t.multiplierMinBp} > 0 and ${t.multiplierMaxBp} >= ${t.multiplierMinBp} and (case when ${t.multiplierStepBp} > 0 then (${t.multiplierMaxBp} - ${t.multiplierMinBp}) % ${t.multiplierStepBp} = 0 else false end)`,
    ),
    check(
      'equipment_definitions_multiplier_bounds_check',
      sql`${t.multiplierMaxBp} <= ${sql.raw(EQUIPMENT_MULTIPLIER_CAP_SQL)}`,
    ),
    check(
      'equipment_definitions_region_check',
      sql`${t.regionId} is null or ${t.regionId} in (${sql.raw(REGION_SQL_LIST)})`,
    ),
    check('equipment_definitions_buy_price_check', sql`${t.buyPrice} is null or ${t.buyPrice} > 0`),
    check('equipment_definitions_price_currency_check', sql`${t.priceCurrency} in ('waifubux','essence')`),
    index('equipment_definitions_enabled_slot_idx').on(t.enabled, t.slot),
    index('equipment_definitions_region_idx').on(t.regionId),
  ],
);

export const playerEquipment = pgTable(
  'player_equipment',
  {
    /** The instance's only identity; exposed to clients and always re-validated. */
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    definitionId: bigint('definition_id', { mode: 'number' })
      .notNull()
      .references(() => equipmentDefinitions.id, { onDelete: 'restrict' }),
    /**
     * Copied from the definition at grant time and never changed. Denormalised
     * so the slot table's composite foreign key can prove slot compatibility.
     */
    slot: text('slot').notNull(),
    /**
     * The multiplier this instance applies to its slot's stat, in basis
     * points — **the** authoritative combat value. Rolled once at grant from
     * the definition's range (or dictated by a fixed grant) and never
     * recalculated: editing the definition's range changes future drops only.
     */
    rolledMultiplierBp: integer('rolled_multiplier_bp').notNull(),
    /**
     * Flavour suffix, by key into `content/equipment/affixes.json`; null for an
     * unaffixed copy. The display name is derived from it on read, never
     * stored. Flavour only — nothing in combat reads it.
     */
    affixKey: text('affix_key'),
    /**
     * The mechanical combat bonuses this instance rolled (migration 0056):
     * `[{ stat, valueBp }]`, at most two, distinct families, in canonical
     * order. Integer basis points (425 = 4.25%). Authoritative and never
     * recomputed, like the multiplier. `[]` is a copy with none — every row
     * that predates the column, every onboarding starter. A collection, not a
     * pair of scalar columns, because SR gear carries two.
     */
    combatBonuses: jsonb('combat_bonuses')
      .$type<{ stat: string; valueBp: number }[]>()
      .notNull()
      .default([]),
    /** Empty in V1; reserved for future rolled properties beyond the above. */
    rolledProperties: jsonb('rolled_properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    isFavorite: boolean('is_favorite').notNull().default(false),
    /** Protects against future selling/salvaging; admin removal may override it. */
    isLocked: boolean('is_locked').notNull().default(false),
    sourceType: text('source_type').notNull(),
    /** The source's own identifier — encounter slug, expedition key, region… */
    sourceKey: text('source_key'),
    /**
     * Idempotency key for the grant that created this row. A retried payout, a
     * double-clicked button or a takeover of a stale resolution races to the
     * same key and exactly one insert survives.
     */
    grantKey: text('grant_key'),
    /** Discord id of the admin behind an admin/event grant. */
    grantedBy: text('granted_by'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft removal. A removed instance is not listed, equipable or countable. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedReason: text('removed_reason'),
  },
  (t) => [
    // Target of `player_loadout_slots`' composite foreign key.
    unique('player_equipment_id_player_slot_uq').on(t.id, t.playerId, t.slot),
    uniqueIndex('player_equipment_grant_key_uq')
      .on(t.grantKey)
      .where(sql`grant_key is not null`),
    index('player_equipment_player_active_idx')
      .on(t.playerId)
      .where(sql`removed_at is null`),
    index('player_equipment_player_definition_idx').on(t.playerId, t.definitionId),
    index('player_equipment_definition_idx').on(t.definitionId),
    check('player_equipment_slot_check', sql`${t.slot} in (${sql.raw(EQUIPMENT_SLOT_SQL_LIST)})`),
    check(
      'player_equipment_source_type_check',
      sql`${t.sourceType} in (${sql.raw(EQUIPMENT_SOURCE_TYPE_SQL_LIST)})`,
    ),
    check(
      'player_equipment_rolled_multiplier_check',
      sql`${t.rolledMultiplierBp} > 0 and ${t.rolledMultiplierBp} <= ${sql.raw(EQUIPMENT_MULTIPLIER_CAP_SQL)}`,
    ),
    check(
      'player_equipment_affix_key_check',
      sql`${t.affixKey} is null or ${t.affixKey} ~ '${sql.raw(EQUIPMENT_KEY_PATTERN.source)}'`,
    ),
    check(
      'player_equipment_combat_bonuses_check',
      sql`jsonb_typeof(${t.combatBonuses}) = 'array' and jsonb_array_length(${t.combatBonuses}) <= 2`,
    ),
    // A removal always says why.
    check(
      'player_equipment_removed_shape_check',
      sql`(${t.removedAt} is null) = (${t.removedReason} is null)`,
    ),
  ],
);

export const playerLoadouts = pgTable(
  'player_loadouts',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    name: text('name').notNull().default('Default'),
    /** Exactly the loadout currently in effect. Presets carry `false`. */
    isActive: boolean('is_active').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of `player_loadout_slots`' composite foreign key.
    unique('player_loadouts_id_player_uq').on(t.id, t.playerId),
    uniqueIndex('player_loadouts_player_active_uq')
      .on(t.playerId)
      .where(sql`is_active`),
    uniqueIndex('player_loadouts_player_name_uq').on(t.playerId, sql`lower(${t.name})`),
    check(
      'player_loadouts_name_check',
      sql`btrim(${t.name}) <> '' and char_length(${t.name}) <= 40`,
    ),
  ],
);

export const playerLoadoutSlots = pgTable(
  'player_loadout_slots',
  {
    loadoutId: bigint('loadout_id', { mode: 'number' }).notNull(),
    /** Denormalised so both composite foreign keys can include it. */
    playerId: bigint('player_id', { mode: 'number' }).notNull(),
    slot: text('slot').notNull(),
    equipmentId: bigint('equipment_id', { mode: 'number' }).notNull(),
    equippedAt: timestamp('equipped_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One item per slot per loadout. Unequip deletes the row.
    primaryKey({ columns: [t.loadoutId, t.slot] }),
    foreignKey({
      name: 'player_loadout_slots_loadout_fk',
      columns: [t.loadoutId, t.playerId],
      foreignColumns: [playerLoadouts.id, playerLoadouts.playerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'player_loadout_slots_equipment_fk',
      columns: [t.equipmentId, t.playerId, t.slot],
      foreignColumns: [playerEquipment.id, playerEquipment.playerId, playerEquipment.slot],
    }).onDelete('restrict'),
    uniqueIndex('player_loadout_slots_loadout_equipment_uq').on(t.loadoutId, t.equipmentId),
    // Deliberately no uniqueness on `equipment_id` alone: one instance may sit
    // in several presets. Only the active loadout is ever in effect.
    index('player_loadout_slots_equipment_idx').on(t.equipmentId),
    check('player_loadout_slots_slot_check', sql`${t.slot} in (${sql.raw(EQUIPMENT_SLOT_SQL_LIST)})`),
  ],
);

export const equipmentEvents = pgTable(
  'equipment_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    equipmentId: bigint('equipment_id', { mode: 'number' }).references(() => playerEquipment.id),
    loadoutId: bigint('loadout_id', { mode: 'number' }).references(() => playerLoadouts.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    slot: text('slot'),
    /** For `equipped`/`unequipped`: what the slot held before. */
    previousEquipmentId: bigint('previous_equipment_id', { mode: 'number' }).references(
      () => playerEquipment.id,
    ),
    actorDiscordId: text('actor_discord_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('equipment_events_kind_check', sql`${t.kind} in (${sql.raw(EQUIPMENT_EVENT_KIND_SQL_LIST)})`),
    check(
      'equipment_events_slot_check',
      sql`${t.slot} is null or ${t.slot} in (${sql.raw(EQUIPMENT_SLOT_SQL_LIST)})`,
    ),
    index('equipment_events_player_created_idx').on(t.playerId, t.createdAt),
    index('equipment_events_kind_created_idx').on(t.kind, t.createdAt),
    index('equipment_events_equipment_idx').on(t.equipmentId),
    // Serves the `ON DELETE SET NULL` from `player_loadouts`: without it,
    // deleting a loadout (a preset, later) scans the whole ledger.
    index('equipment_events_loadout_idx').on(t.loadoutId),
  ],
);

/**
 * One row per applied equipment package, written inside the import
 * transaction — the `world_encounter_import_log` pattern. Exists if and only if
 * the content it describes landed.
 */
export const equipmentImportLog = pgTable(
  'equipment_import_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    actorDiscordUserId: text('actor_discord_user_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    packageFormat: text('package_format').notNull(),
    packageVersion: integer('package_version').notNull(),
    packageExportedAt: text('package_exported_at'),
    packageLabel: text('package_label'),
    sourceFilename: text('source_filename'),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    /** Keys created or updated, for a quick "what changed". */
    definitionKeys: jsonb('definition_keys').$type<string[]>().notNull().default([]),
  },
  (t) => [index('equipment_import_log_applied_idx').on(t.appliedAt)],
);

/**
 * Patch's Workshop — one row per confirmed dismantle or fabrication.
 *
 * Both the idempotency record and the audit ledger, the `key_item_constructions`
 * / `combat_trial_attempts` pattern: `request_key` is the caller's key for one
 * confirmation (a rendered Discord button, a Portal dialog), unique per
 * player, so a retried confirmation reads this row back instead of destroying
 * more gear, paying again or rerolling. `fingerprint` is what the key was
 * spent on; the same key for a different request is refused.
 *
 * Authoritative for nothing but "this request already happened": the balance
 * lives in `player_currencies`, the gear in `player_equipment`, and both were
 * changed in the transaction that wrote this row. The deltas and `*_after`
 * columns are a snapshot for audit and for replaying the result screen.
 *
 * Written only by `equipmentWorkshopService.ts` (`equipmentBoundary.test.ts`).
 */
export const equipmentWorkshopOperations = pgTable(
  'equipment_workshop_operations',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    requestKey: text('request_key').notNull(),
    kind: text('kind').notNull(),
    /** Canonical description of the request (`dismantle:3,8,12`, `fabricate:improved_rebuild:attack`). */
    fingerprint: text('fingerprint').notNull(),
    /** Fabrication only: the recipe, its rarity, and the slot asked for. */
    recipeKey: text('recipe_key'),
    rarity: text('rarity'),
    slotChoice: text('slot_choice'),
    /** Signed: + for a dismantle's yield, − for a fabrication's cost. */
    componentsDelta: integer('components_delta').notNull(),
    /** 0 for a dismantle (never a WaifuBux faucet), − for a fabrication. */
    waifubuxDelta: integer('waifubux_delta').notNull(),
    componentsAfter: integer('components_after').notNull(),
    waifubuxAfter: integer('waifubux_after').notNull(),
    /** Dismantled instances, or the one fabricated instance. */
    equipmentIds: bigint('equipment_ids', { mode: 'number' }).array().notNull(),
    /** Non-authoritative detail for audit and the replayed result screen. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('equipment_workshop_operations_request_uq').on(t.playerId, t.requestKey),
    index('equipment_workshop_operations_player_created_idx').on(t.playerId, t.createdAt),
    check('equipment_workshop_operations_kind_check', sql`${t.kind} in (${sql.raw(WORKSHOP_OPERATION_KIND_SQL_LIST)})`),
    check(
      'equipment_workshop_operations_slot_choice_check',
      sql`${t.slotChoice} is null or ${t.slotChoice} in (${sql.raw(WORKSHOP_SLOT_CHOICE_SQL_LIST)})`,
    ),
    check(
      'equipment_workshop_operations_shape_check',
      sql`(${t.kind} = 'dismantle' and ${t.recipeKey} is null and ${t.slotChoice} is null and ${t.componentsDelta} > 0 and ${t.waifubuxDelta} = 0 and cardinality(${t.equipmentIds}) >= 1)
        or (${t.kind} = 'fabricate' and ${t.recipeKey} is not null and ${t.slotChoice} is not null and ${t.componentsDelta} < 0 and ${t.waifubuxDelta} <= 0 and cardinality(${t.equipmentIds}) = 1)`,
    ),
    check(
      'equipment_workshop_operations_after_check',
      sql`${t.componentsAfter} >= 0 and ${t.waifubuxAfter} >= 0`,
    ),
  ],
);

export type EquipmentWorkshopOperationRow = typeof equipmentWorkshopOperations.$inferSelect;

/**
 * Account features a player has unlocked — Equipment first.
 *
 * The `player_unlocked_routes` / `player_travel_passes` pattern: a permanent
 * per-player entitlement with a composite primary key, a `source` and a
 * timestamp. Deliberately **not** inventory (a key item would be listable,
 * countable and potentially sellable), **not** `players.settings` (no
 * constraint, no audit, easy to clobber), and **not** derived from owning gear
 * (an admin grant would unlock it implicitly, with no completion moment).
 *
 * The primary key makes unlocking idempotent: a double-clicked completion or a
 * retried onboarding step collapses to one row. Revocation deletes the row and
 * is admin-only and audited.
 */
export const playerFeatureUnlocks = pgTable(
  'player_feature_unlocks',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    featureKey: text('feature_key').notNull(),
    source: text('source').notNull(),
    /** The unlocking thing's own identifier, e.g. an onboarding encounter id. */
    sourceRef: text('source_ref'),
    /** Discord id of the admin, for `source = 'admin'`. */
    unlockedBy: text('unlocked_by'),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.featureKey] }),
    check(
      'player_feature_unlocks_feature_check',
      sql`${t.featureKey} in (${sql.raw(FEATURE_KEY_SQL_LIST)})`,
    ),
    check(
      'player_feature_unlocks_source_check',
      sql`${t.source} in (${sql.raw(FEATURE_UNLOCK_SOURCE_SQL_LIST)})`,
    ),
  ],
);

export type EquipmentDefinitionRow = typeof equipmentDefinitions.$inferSelect;
export type PlayerEquipmentRow = typeof playerEquipment.$inferSelect;
export type PlayerLoadoutRow = typeof playerLoadouts.$inferSelect;
export type PlayerLoadoutSlotRow = typeof playerLoadoutSlots.$inferSelect;
export type EquipmentEventRow = typeof equipmentEvents.$inferSelect;
export type EquipmentImportLogRow = typeof equipmentImportLog.$inferSelect;
export type PlayerFeatureUnlockRow = typeof playerFeatureUnlocks.$inferSelect;

/**
 * Live boss and expedition reward tables.
 *
 * Database-authoritative once seeded: the shipped `content/bossRewards.json`
 * and `content/expeditionRewards.json` are the defaults the startup seed
 * inserts, and it updates a row from them only while the row still holds
 * what was last seeded (`contentHash === seedHash`). An admin edit makes the
 * row diverge, and a deploy never overwrites it. See migration 0047 and
 * `modules/rewardTables`.
 *
 * `definition` is the table as the file format writes it — one document, so
 * group and entry order (part of every deterministic draw) is kept exactly.
 */
export const rewardTables = pgTable(
  'reward_tables',
  {
    kind: text('kind').notNull(),
    tableId: text('table_id').notNull(),
    /** Mirrors `definition.enabled`, for listing without parsing. */
    enabled: boolean('enabled').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    /** Bumped on every write; a save must name the revision it edited. */
    revision: integer('revision').notNull().default(1),
    /** Semantic hash of `definition` as it stands. */
    contentHash: text('content_hash').notNull(),
    /** Hash of the shipped table last seeded into this row; null if never shipped. */
    seedHash: text('seed_hash'),
    /** Export order: file order for shipped tables, appended for new ones. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of the admin, `seed`, or `import`. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    primaryKey({ name: 'reward_tables_pk', columns: [t.kind, t.tableId] }),
    check('reward_tables_kind_check', sql`${t.kind} in ('boss', 'expedition')`),
    check('reward_tables_revision_check', sql`${t.revision} >= 1`),
  ],
);

export type RewardTableRow = typeof rewardTables.$inferSelect;

/**
 * Combat Trial attempts — one row per resolved Trial fight (migration 0048).
 *
 * Written once, already finished: V1 Trials are automatic. Every stat and
 * name is a **snapshot** of what was actually fought, so a content edit never
 * rewrites history. `initialState` is the engine's serialisable
 * `CombatState` at the start and `events` its structured event log.
 *
 * `requestKey` is the idempotency key (one per rendered Fight button), unique
 * per player. `firstClear` marks the one attempt that first cleared the Trial,
 * enforced by a partial unique index — the guard on the first-clear reward.
 * See `modules/combatTrials/combatTrialService.ts` and `docs/combat-trials.md`.
 */
export const combatTrialAttempts = pgTable(
  'combat_trial_attempts',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    trialKey: text('trial_key').notNull(),
    enemyKey: text('enemy_key').notNull(),
    requestKey: text('request_key').notNull(),
    result: text('result').notNull(),
    endReason: text('end_reason').notNull(),
    rounds: integer('rounds').notNull(),
    actions: integer('actions').notNull(),
    /** The Buddy copy that fought. No FK: history outlives a release. */
    buddyWaifuId: bigint('buddy_waifu_id', { mode: 'number' }).notNull(),
    playerName: text('player_name').notNull(),
    playerAttack: integer('player_attack').notNull(),
    playerDefense: integer('player_defense').notNull(),
    playerMaxHp: integer('player_max_hp').notNull(),
    playerRemainingHp: integer('player_remaining_hp').notNull(),
    enemyName: text('enemy_name').notNull(),
    enemyAttack: integer('enemy_attack').notNull(),
    enemyDefense: integer('enemy_defense').notNull(),
    enemyMaxHp: integer('enemy_max_hp').notNull(),
    enemyRemainingHp: integer('enemy_remaining_hp').notNull(),
    initialState: jsonb('initial_state').$type<Record<string, unknown>>().notNull(),
    events: jsonb('events').$type<Record<string, unknown>[]>().notNull(),
    /**
     * The seed every random draw of this fight came from (migration 0056),
     * derived from the player, Trial and request key. With `initialState` it
     * reproduces the fight exactly. Null for an attempt fought before Trials
     * were seeded — replayable from `events`, not reproducible.
     */
    combatSeed: bigint('combat_seed', { mode: 'number' }),
    firstClear: boolean('first_clear').notNull().default(false),
    rewards: jsonb('rewards').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'combat_trial_attempts_result_check',
      sql`${t.result} in ('player_victory','enemy_victory','draw')`,
    ),
    check('combat_trial_attempts_end_reason_check', sql`${t.endReason} in ('defeat','round_limit')`),
    check('combat_trial_attempts_first_clear_check', sql`not ${t.firstClear} or ${t.result} = 'player_victory'`),
    check('combat_trial_attempts_counts_check', sql`${t.rounds} >= 1 and ${t.actions} >= 0`),
    uniqueIndex('combat_trial_attempts_request_uq').on(t.playerId, t.requestKey),
    uniqueIndex('combat_trial_attempts_first_clear_uq')
      .on(t.playerId, t.trialKey)
      .where(sql`first_clear`),
    index('combat_trial_attempts_player_trial_idx').on(t.playerId, t.trialKey, t.id.desc()),
  ],
);

export type CombatTrialAttemptRow = typeof combatTrialAttempts.$inferSelect;

/**
 * Dungeons (migration 0059) — one row per dungeon: its mutable **draft**, the
 * editor's layout of it, and the pointer to the published revision new runs
 * start on.
 *
 * `draft` is the definition as `modules/dungeons/content/dungeonDefinition.ts`
 * writes it and `layout` is the canvas layout beside it; the two are separate
 * documents so that moving a room is not a gameplay change. `draftRevision` is
 * the optimistic lock: a save must name the revision it edited.
 *
 * A dungeon is open to players when it is `enabled` **and** has a published
 * revision. Publishing never happens as a side effect of a save or an import.
 *
 * `dungeonKey` is stable for the life of the dungeon: runs, revisions and
 * packages name it by value.
 */
export const dungeonDefinitions = pgTable(
  'dungeon_definitions',
  {
    dungeonKey: text('dungeon_key').primaryKey(),
    /** Off takes a published dungeon away from new runs without unpublishing it. */
    enabled: boolean('enabled').notNull().default(true),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull(),
    layout: jsonb('layout').$type<Record<string, unknown>>().notNull().default({}),
    /** Bumped on every draft or layout write. */
    draftRevision: integer('draft_revision').notNull().default(1),
    /** Gameplay content hash of `draft`; layout is not part of it. */
    draftHash: text('draft_hash').notNull(),
    /** The revision new runs start on; null while unpublished. FK in the migration. */
    publishedRevisionId: bigint('published_revision_id', { mode: 'number' }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of the admin who last wrote the draft. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('dungeon_definitions_key_check', sql`${t.dungeonKey} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check('dungeon_definitions_draft_revision_check', sql`${t.draftRevision} >= 1`),
  ],
);

export type DungeonDefinitionRow = typeof dungeonDefinitions.$inferSelect;

export const DUNGEON_REVISION_SOURCES = ['editor', 'import'] as const;
export type DungeonRevisionSource = (typeof DUNGEON_REVISION_SOURCES)[number];

/**
 * A published dungeon revision (migration 0059): the content as it stood when
 * an admin pressed Publish. **Immutable** — the application has no code path
 * that updates one, and a trigger refuses any that tries. A run names the
 * revision it started on and reads nothing else, so a later publish or a
 * rollback never reaches a run in progress.
 */
export const dungeonRevisions = pgTable(
  'dungeon_revisions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    dungeonKey: text('dungeon_key')
      .notNull()
      .references(() => dungeonDefinitions.dungeonKey),
    /** 1, 2, 3… per dungeon. */
    number: integer('number').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    /** The layout as it stood, for reference. Never read by a run. */
    layout: jsonb('layout').$type<Record<string, unknown>>().notNull().default({}),
    /** Where the published draft came from. */
    source: text('source').$type<DungeonRevisionSource>().notNull().default('editor'),
    /** The draft revision that was published. */
    draftRevision: integer('draft_revision').notNull(),
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('dungeon_revisions_number_check', sql`${t.number} >= 1`),
    check('dungeon_revisions_source_check', sql`${t.source} in ('editor','import')`),
    uniqueIndex('dungeon_revisions_key_number_uq').on(t.dungeonKey, t.number),
  ],
);

export type DungeonRevisionRow = typeof dungeonRevisions.$inferSelect;

export const DUNGEON_CONTENT_EVENT_ACTIONS = [
  'created',
  'draft_saved',
  'published',
  'rolled_back',
  'enabled',
  'disabled',
  'exported',
  'deleted',
] as const;
export type DungeonContentEventAction = (typeof DUNGEON_CONTENT_EVENT_ACTIONS)[number];

/**
 * Append-only audit trail of dungeon authoring (migration 0059), in the shape
 * of `boss_definition_events`. No FK on `dungeonKey`: the trail outlives the
 * dungeon it describes.
 */
export const dungeonContentEvents = pgTable(
  'dungeon_content_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    dungeonKey: text('dungeon_key').notNull(),
    action: text('action').$type<DungeonContentEventAction>().notNull(),
    /** Discord id of the admin, or a system actor. */
    actor: text('actor'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'dungeon_content_events_action_check',
      sql`${t.action} in ('created','draft_saved','published','rolled_back','enabled','disabled','exported','deleted')`,
    ),
    index('dungeon_content_events_key_idx').on(t.dungeonKey, t.id.desc()),
  ],
);

export type DungeonContentEventRow = typeof dungeonContentEvents.$inferSelect;

/**
 * Display metadata for a progression currency (migration 0050). `currencyKey`
 * is the stable reference; every other column is what an admin may rename.
 */
export const progressionCurrencies = pgTable(
  'progression_currencies',
  {
    currencyKey: text('currency_key').primaryKey(),
    singularName: text('singular_name').notNull(),
    pluralName: text('plural_name').notNull(),
    description: text('description').notNull().default(''),
    /** Emoji or short icon text; null for none. */
    icon: text('icon'),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('progression_currencies_key_check', sql`${t.currencyKey} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check('progression_currencies_revision_check', sql`${t.revision} >= 1`),
  ],
);

export type ProgressionCurrencyRow = typeof progressionCurrencies.$inferSelect;

/**
 * A player's balance of one progression currency. Created by the first grant;
 * no row means zero. Only `progressionCurrencyService` moves it — it is not an
 * inventory item, so no shop, sale, gift or consumable flow can.
 */
export const playerProgressionBalances = pgTable(
  'player_progression_balances',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    currencyKey: text('currency_key')
      .notNull()
      .references(() => progressionCurrencies.currencyKey),
    balance: integer('balance').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'player_progression_balances_pk', columns: [t.playerId, t.currencyKey] }),
    check('player_progression_balances_balance_check', sql`${t.balance} >= 0`),
  ],
);

/** Append-only record of every progression-currency change. */
export const progressionCurrencyLedger = pgTable(
  'progression_currency_ledger',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    currencyKey: text('currency_key')
      .notNull()
      .references(() => progressionCurrencies.currencyKey),
    /** Positive for a grant, negative for a spend. */
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    /** What moved it, e.g. `dungeon_extraction`, `admin_grant`. */
    reason: text('reason').notNull(),
    /** What it moved for, e.g. `dungeon_run:42`. */
    sourceRef: text('source_ref'),
    /** Idempotency key, unique per player and currency when present. */
    requestKey: text('request_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('progression_currency_ledger_delta_check', sql`${t.delta} <> 0`),
    check('progression_currency_ledger_after_check', sql`${t.balanceAfter} >= 0`),
    uniqueIndex('progression_currency_ledger_request_uq')
      .on(t.playerId, t.currencyKey, t.requestKey)
      .where(sql`request_key is not null`),
    index('progression_currency_ledger_player_idx').on(t.playerId, t.currencyKey, t.id.desc()),
  ],
);

export type ProgressionCurrencyLedgerRow = typeof progressionCurrencyLedger.$inferSelect;

export const DUNGEON_RUN_STATUSES = ['active', 'extracted', 'defeated', 'completed', 'abandoned'] as const;
export type DungeonRunStatus = (typeof DUNGEON_RUN_STATUSES)[number];

/**
 * A dungeon run (rebuilt in migration 0059).
 *
 * `revisionId` pins the published revision the run began on; the run reads
 * its rooms and sequences from that revision and nothing else. The mutable
 * global content it also depends on — enemy stats, reward tables — is copied
 * into `dependencySnapshot` at start, and the Buddy's stats into `fighter`, so
 * no later edit or gear change reaches it.
 *
 * `step`, `cursor`, `currentHp`, `flags`, `roomStates`, `unbankedCurrency` and
 * `recent` are the engine's state (`modules/dungeons/engine/types.ts`),
 * advanced only by `dungeonRunService` under a row lock. `step` goes up by one
 * per applied interaction and is what a Discord button names, so a stale
 * button changes nothing.
 *
 * One active run per player, by the partial unique index.
 */
export const dungeonRuns = pgTable(
  'dungeon_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    /** No FK: a run outlives whatever later happens to its dungeon. */
    dungeonKey: text('dungeon_key').notNull(),
    revisionId: bigint('revision_id', { mode: 'number' })
      .notNull()
      .references(() => dungeonRevisions.id),
    /** Unsigned 32-bit — the range `seededRng` uses. */
    seed: bigint('seed', { mode: 'number' }).notNull(),
    status: text('status').$type<DungeonRunStatus>().notNull().default('active'),
    step: integer('step').notNull().default(0),
    /** `{ roomId, actionId, waveIndex, cameFrom }`. */
    cursor: jsonb('cursor').$type<Record<string, unknown>>().notNull(),
    currentHp: integer('current_hp').notNull(),
    /** Run-scoped quest flags. */
    flags: jsonb('flags').$type<Record<string, boolean>>().notNull().default({}),
    /** Room id → visits, completion and each action's record. */
    roomStates: jsonb('room_states').$type<Record<string, unknown>>().notNull().default({}),
    /** Reward claims survive retreat and room resume independently. */
    rewardClaims: jsonb('reward_claims').$type<Record<string, unknown>>().notNull().default({}),
    unbankedCurrency: integer('unbanked_currency').notNull().default(0),
    /** What the latest step did, for redisplay. */
    recent: jsonb('recent').$type<Record<string, unknown>[]>().notNull().default([]),
    securedRewards: jsonb('secured_rewards').$type<Record<string, unknown>[]>().notNull().default([]),
    fighter: jsonb('fighter').$type<Record<string, unknown>>().notNull(),
    dependencySnapshot: jsonb('dependency_snapshot').$type<Record<string, unknown>>().notNull(),
    /** How the run ended and what was banked; null while active. */
    settlement: jsonb('settlement').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'dungeon_runs_status_check',
      sql`${t.status} in ('active','extracted','defeated','completed','abandoned')`,
    ),
    check('dungeon_runs_seed_check', sql`${t.seed} >= 0 and ${t.seed} <= 4294967295`),
    check('dungeon_runs_step_check', sql`${t.step} >= 0`),
    check('dungeon_runs_unbanked_check', sql`${t.unbankedCurrency} >= 0`),
    check('dungeon_runs_hp_check', sql`${t.currentHp} >= 0`),
    check('dungeon_runs_completed_check', sql`(${t.status} = 'active') = (${t.completedAt} is null)`),
    check('dungeon_runs_settlement_check', sql`${t.status} <> 'active' or ${t.settlement} is null`),
    uniqueIndex('dungeon_runs_one_active_uq')
      .on(t.playerId)
      .where(sql`status = 'active'`),
    index('dungeon_runs_player_idx').on(t.playerId, t.id.desc()),
    index('dungeon_runs_revision_idx').on(t.revisionId),
  ],
);

export type DungeonRunRow = typeof dungeonRuns.$inferSelect;

export const DUNGEON_RUN_EVENT_TYPES = [
  'run_started',
  'room_entered',
  'action_skipped',
  'action_declined',
  'combat_wave_resolved',
  'action_completed',
  'action_failed',
  'room_completed',
  'room_retreated',
  'connection_taken',
  'extraction',
  'defeat',
  'completion',
  'abandon',
  'currency_banked',
  'rewards_granted',
] as const;
export type DungeonRunEventType = (typeof DUNGEON_RUN_EVENT_TYPES)[number];

/**
 * Append-only history of a dungeon run (rebuilt in migration 0059): one
 * structured row per thing that happened, written in the transaction that made
 * it happen. `step` is the run step that produced it.
 */
export const dungeonRunEvents = pgTable(
  'dungeon_run_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    runId: bigint('run_id', { mode: 'number' })
      .notNull()
      .references(() => dungeonRuns.id),
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    step: integer('step').notNull(),
    type: text('type').$type<DungeonRunEventType>().notNull(),
    roomId: text('room_id'),
    actionId: text('action_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'dungeon_run_events_type_check',
      sql`${t.type} in ('run_started','room_entered','action_skipped','action_declined','combat_wave_resolved','action_completed','action_failed','room_completed','room_retreated','connection_taken','extraction','defeat','completion','abandon','currency_banked','rewards_granted')`,
    ),
    index('dungeon_run_events_run_idx').on(t.runId, t.id),
  ],
);

export type DungeonRunEventRow = typeof dungeonRunEvents.$inferSelect;

/**
 * Delve-wide settings (migration 0052): one row, edited in Portal Admin.
 * `dailyRunLimit` is shared by every zone; 0 closes Delve to new runs.
 */
export const dungeonSettings = pgTable(
  'dungeon_settings',
  {
    id: integer('id').primaryKey().default(1),
    dailyRunLimit: integer('daily_run_limit').notNull().default(3),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of whoever last saved. Null when seeded. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('dungeon_settings_singleton_check', sql`${t.id} = 1`),
    check('dungeon_settings_daily_run_limit_check', sql`${t.dailyRunLimit} >= 0 and ${t.dailyRunLimit} <= 50`),
  ],
);
export type DungeonSettingsRow = typeof dungeonSettings.$inferSelect;

/**
 * Dungeon runs a player started on one game day (migration 0052).
 * `periodKey` is the calendar date in `DAILY_TIMEZONE`, as `daily_claims`
 * keys on. Stored usage, never a refilled counter: a day with no row is a
 * full allowance.
 */
export const dungeonDailyUsage = pgTable(
  'dungeon_daily_usage',
  {
    playerId: bigint('player_id', { mode: 'number' })
      .notNull()
      .references(() => players.id),
    periodKey: date('period_key').notNull(),
    runsStarted: integer('runs_started').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'dungeon_daily_usage_pk', columns: [t.playerId, t.periodKey] }),
    check('dungeon_daily_usage_runs_started_check', sql`${t.runsStarted} >= 0`),
  ],
);
export type DungeonDailyUsageRow = typeof dungeonDailyUsage.$inferSelect;

export const ARTWORK_ASSET_CATEGORIES = [
  'dungeon_zone',
  'dungeon_background',
  'enemy_sprite',
  'enemy_art',
  'event_art',
  'npc_portrait',
  'equipment_art',
  'boss_art',
] as const;
export type ArtworkAssetCategory = (typeof ARTWORK_ASSET_CATEGORIES)[number];

export const ARTWORK_ASSET_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type ArtworkAssetStatus = (typeof ARTWORK_ASSET_STATUSES)[number];

export const ARTWORK_ASSET_MIME_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const;
export type ArtworkAssetMimeType = (typeof ARTWORK_ASSET_MIME_TYPES)[number];

/**
 * Managed artwork (migration 0054): an image uploaded through Portal Admin.
 *
 * The row is the logical asset and its metadata; the bytes live in the
 * artwork storage under `storageKey`. Authored content references `id`.
 * Replacing the image keeps the id and bumps `version` / `contentHash`.
 * See `modules/artworkAssets`.
 */
export const artworkAssets = pgTable(
  'artwork_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: text('category').$type<ArtworkAssetCategory>().notNull(),
    /** Display label. Never a path. */
    name: text('name').notNull(),
    /** The uploader's base file name. Informational; never used on disk. */
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').$type<ArtworkAssetMimeType>().notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    hasAlpha: boolean('has_alpha').notNull().default(false),
    fileSize: integer('file_size').notNull(),
    /** Server-generated: `<category>/<id>/<contentHash>.<ext>`. */
    storageKey: text('storage_key').notNull(),
    /** sha256 of the stored bytes. */
    contentHash: text('content_hash').notNull(),
    version: integer('version').notNull().default(1),
    status: text('status').$type<ArtworkAssetStatus>().notNull().default('active'),
    uploadedBy: text('uploaded_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'artwork_assets_category_check',
      sql`${t.category} in ('dungeon_zone','dungeon_background','enemy_sprite','enemy_art','event_art','npc_portrait','equipment_art','boss_art')`,
    ),
    check('artwork_assets_mime_check', sql`${t.mimeType} in ('image/png','image/webp','image/jpeg')`),
    check('artwork_assets_status_check', sql`${t.status} in ('active','disabled','deleted')`),
    check('artwork_assets_dimensions_check', sql`${t.width} >= 1 and ${t.height} >= 1 and ${t.fileSize} >= 1`),
    check('artwork_assets_version_check', sql`${t.version} >= 1`),
    check('artwork_assets_deleted_check', sql`(${t.status} = 'deleted') = (${t.deletedAt} is not null)`),
    index('artwork_assets_category_idx').on(t.category, t.status, t.updatedAt.desc()),
  ],
);
export type ArtworkAssetRow = typeof artworkAssets.$inferSelect;

export const ARTWORK_ASSET_EVENT_ACTIONS = [
  'upload',
  'replace',
  'update',
  'disable',
  'enable',
  'delete',
  'reference_added',
  'reference_removed',
] as const;
export type ArtworkAssetEventAction = (typeof ARTWORK_ASSET_EVENT_ACTIONS)[number];

/** Append-only audit trail for managed artwork (migration 0054). Never bytes. */
export const artworkAssetEvents = pgTable(
  'artwork_asset_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => artworkAssets.id),
    action: text('action').$type<ArtworkAssetEventAction>().notNull(),
    /** Discord id of the admin; null for a bearer/script caller. */
    actor: text('actor'),
    oldHash: text('old_hash'),
    newHash: text('new_hash'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'artwork_asset_events_action_check',
      sql`${t.action} in ('upload','replace','update','disable','enable','delete','reference_added','reference_removed')`,
    ),
    index('artwork_asset_events_asset_idx').on(t.assetId, t.id.desc()),
  ],
);
export type ArtworkAssetEventRow = typeof artworkAssetEvents.$inferSelect;

/**
 * LEGACY (migration 0054): managed artwork for a combat enemy, from when
 * enemies were file content only. The enemy row (`combat_enemies`) owns these
 * references now; rows here are copied across once at startup and kept as a
 * read-only record. Nothing writes this table any more.
 */
export const combatEnemyArtwork = pgTable(
  'combat_enemy_artwork',
  {
    enemyKey: text('enemy_key').primaryKey(),
    artworkAssetId: uuid('artwork_asset_id').references(() => artworkAssets.id),
    spriteAssetId: uuid('sprite_asset_id').references(() => artworkAssets.id),
    /** `SpritePlacement`; null for the default. */
    spritePlacement: jsonb('sprite_placement').$type<Record<string, unknown>>(),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    /** When this row was copied into `combat_enemies` (migration 0055); null until then. */
    mergedAt: timestamp('merged_at', { withTimezone: true }),
  },
  (t) => [
    check('combat_enemy_artwork_key_check', sql`${t.enemyKey} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check('combat_enemy_artwork_revision_check', sql`${t.revision} >= 1`),
  ],
);
export type CombatEnemyArtworkRow = typeof combatEnemyArtwork.$inferSelect;

/**
 * The central Enemy Catalogue (migration 0055): one row per combat enemy,
 * referenced by key from dungeon zones, Combat Trials and anything later.
 *
 * Seeded from `content/combat/enemies.json` like reward tables and dungeon
 * zones — `seedHash` is the hash of the shipped enemy last seeded into the
 * row (null for an enemy created in the Portal), `contentHash` the hash of
 * what the row holds now. The hash covers the portable definition only:
 * the managed asset ids are local to one environment and stay out of it.
 */
export const combatEnemies = pgTable(
  'combat_enemies',
  {
    enemyKey: text('enemy_key').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enabled: boolean('enabled').notNull(),
    attack: integer('attack').notNull(),
    defense: integer('defense').notNull(),
    hp: integer('hp').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    /** Shipped full artwork, relative to the assets root. */
    artworkPath: text('artwork_path'),
    /** Shipped transparent sprite, relative to the assets root. */
    spriteArtworkPath: text('sprite_artwork_path'),
    /** Managed full artwork; wins over `artworkPath`. */
    artworkAssetId: uuid('artwork_asset_id').references(() => artworkAssets.id),
    /** Managed sprite; wins over `spriteArtworkPath`. */
    spriteAssetId: uuid('sprite_asset_id').references(() => artworkAssets.id),
    /** `SpritePlacement`; null for the system default. */
    spritePlacement: jsonb('sprite_placement').$type<Record<string, unknown>>(),
    /** Bumped on every write; a save must name the revision it edited. */
    revision: integer('revision').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    seedHash: text('seed_hash'),
    /** List order: the shipped file's order, then creation order. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of the admin, or `seed`. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('combat_enemies_key_check', sql`${t.enemyKey} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check('combat_enemies_revision_check', sql`${t.revision} >= 1`),
    check('combat_enemies_attack_check', sql`${t.attack} >= 1`),
    check('combat_enemies_defense_check', sql`${t.defense} >= 0`),
    check('combat_enemies_hp_check', sql`${t.hp} >= 1`),
    index('combat_enemies_position_idx').on(t.position, t.enemyKey),
  ],
);
export type CombatEnemyRow = typeof combatEnemies.$inferSelect;

/**
 * Boss definitions (migration 0057). Authoritative: the scheduler draws from
 * this table. `content/bosses.json` is bootstrap data — a boss whose key has
 * no row is inserted at startup, and a row is never updated from the file.
 */
export const BOSS_DEFINITION_STATUSES = ['draft', 'active', 'disabled'] as const;
export type BossDefinitionStatus = (typeof BOSS_DEFINITION_STATUSES)[number];

/** How a definition's row came to exist. Informational; never changes afterwards. */
export const BOSS_DEFINITION_SOURCES = ['bootstrap', 'portal', 'import'] as const;
export type BossDefinitionSource = (typeof BOSS_DEFINITION_SOURCES)[number];

export const bossDefinitions = pgTable(
  'boss_definitions',
  {
    /** The boss id snapshotted onto every encounter row (`boss_encounters.boss_id`). Never reused. */
    bossKey: text('boss_key').primaryKey(),
    name: text('name').notNull(),
    affinity: text('affinity').$type<Affinity>().notNull(),
    /** Regions whose guilds may draw this boss. */
    regions: jsonb('regions').$type<string[]>().notNull().default([]),
    /** Only `active` bosses spawn. */
    status: text('status').$type<BossDefinitionStatus>().notNull().default('draft'),
    /** Relative to the assets root; null renders a text-only encounter. */
    artwork: text('artwork'),
    /**
     * Managed artwork uploaded through the Portal (migration 0058). Wins over
     * `artwork` while the asset is active; `artwork` stays as the fallback.
     */
    artworkAssetId: uuid('artwork_asset_id').references(() => artworkAssets.id),
    /** A `reward_tables` id of kind `boss`. Empty only on a draft. */
    rewardTable: text('reward_table').notNull().default(''),
    scoutingText: text('scouting_text').notNull().default(''),
    repelledText: text('repelled_text').notNull().default(''),
    unchallengedText: text('unchallenged_text').notNull().default(''),
    description: text('description').notNull().default(''),
    /** `BossSchedule` — owned by `modules/bosses/bossSchedule.ts`. */
    schedule: jsonb('schedule').$type<Record<string, unknown>>().notNull(),
    /** Bumped on every write; a save must name the revision it edited. */
    revision: integer('revision').notNull().default(1),
    source: text('source').$type<BossDefinitionSource>().notNull().default('portal'),
    /** List order: the shipped file's order, then creation order. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Discord id of the admin, or `bootstrap`. */
    updatedBy: text('updated_by'),
  },
  (t) => [
    check('boss_definitions_key_check', sql`${t.bossKey} ~ '^[a-z0-9_]+$'`),
    check('boss_definitions_status_check', sql`${t.status} in ('draft','active','disabled')`),
    check(
      'boss_definitions_affinity_check',
      sql`${t.affinity} in ('dominant','submissive','caregiver','primal','switch')`,
    ),
    check('boss_definitions_source_check', sql`${t.source} in ('bootstrap','portal','import')`),
    check('boss_definitions_revision_check', sql`${t.revision} >= 1`),
    index('boss_definitions_position_idx').on(t.position, t.bossKey),
    index('boss_definitions_status_idx').on(t.status),
    index('boss_definitions_artwork_asset_idx').on(t.artworkAssetId),
  ],
);

export const BOSS_DEFINITION_EVENT_ACTIONS = [
  'bootstrap',
  'create',
  'update',
  'status',
  'duplicate',
  'delete',
  'import',
  'manual_spawn',
  'schedule_override',
  'manual_end',
] as const;
export type BossDefinitionEventAction = (typeof BOSS_DEFINITION_EVENT_ACTIONS)[number];

/** Append-only audit trail for Boss Management (migration 0057). */
export const bossDefinitionEvents = pgTable(
  'boss_definition_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** No foreign key: the trail outlives a deleted definition. */
    bossKey: text('boss_key').notNull(),
    action: text('action').$type<BossDefinitionEventAction>().notNull(),
    /** Discord id of the admin; null for a bearer/script caller. */
    actor: text('actor'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'boss_definition_events_action_check',
      sql`${t.action} in ('bootstrap','create','update','status','duplicate','delete','import','manual_spawn','schedule_override','manual_end')`,
    ),
    index('boss_definition_events_boss_idx').on(t.bossKey, t.id.desc()),
    index('boss_definition_events_recent_idx').on(t.id.desc()),
  ],
);
