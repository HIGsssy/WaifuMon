/**
 * Hand-authored response types for the Platform API (plan §5, §11).
 *
 * These are narrow by design: each interface lists the fields the Portal's
 * pages actually read, in the shape the API returns them. There is no codegen
 * step in v1 — the API surface is still evolving and a hand-written wrapper is
 * faster to move with it. Swapping to types generated from
 * `/api/v1/openapi.json` is filed as plan §25.1 and touches this file plus the
 * per-resource helpers, never a page.
 *
 * Encoding rules mirrored from `src/api/schemas/common.ts` on the API side:
 *   - instants are ISO 8601 UTC strings
 *   - calendar days are `YYYY-MM-DD`
 *   - enum-ish columns are real unions here, matching the API's Zod enums
 *
 * `tables.json` is deliberately typed as `unknown`-valued: the API documents it
 * as opaque balance tuning that is explicitly *not* part of the frozen v1
 * contract, and pinning its nested shape here would make every balance patch a
 * Portal typecheck failure.
 */

// ── Envelopes ────────────────────────────────────────────────────────────────

/** Forward-compatible metadata. Tolerate absent and unknown fields. */
export interface ResponseMeta {
  requestId?: string;
  apiVersion?: string;
  generatedAt?: string;
}

export interface DataEnvelope<T> {
  data: T;
  meta?: ResponseMeta;
}

export interface PaginatedEnvelope<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  meta?: ResponseMeta;
}

/** What the paginated helpers hand back to hooks, envelope flattened. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  requestId: string;
}

// ── Enumerations ─────────────────────────────────────────────────────────────

export type Rarity = 'N' | 'R' | 'SR' | 'SSR' | 'UR' | 'LR' | 'EX';
export type Affinity = 'dominant' | 'submissive' | 'caregiver' | 'primal' | 'switch';
export type ContentRating = 'suggestive' | 'mature' | 'explicit';
export type ItemCategory = 'capture' | 'material' | 'cosmetic' | 'consumable';
export type PriceCurrency = 'waifubux' | 'essence';

// ── Content: species ─────────────────────────────────────────────────────────

/** Fields shared by the authored snapshot and the seeded row. */
export interface SpeciesFields {
  slug: string;
  name: string;
  rarity: Rarity;
  /** What a Waifumon *is*. Surfaced in the UI as "Type" (plan §8.2). */
  archetype: string;
  affinity: Affinity;
  contentRating: ContentRating;
  description: string;
  tags: string[];
  baseCaptureRate: number | null;
  /** Internal asset path. Consumed only by the image resolver (§12). */
  imagePath: string;
  enabled: boolean;
  eventKey: string | null;
  perSpeciesWeight: number;
}

/** Authored species from the content snapshot — addressed by slug, no id. */
export type ContentSpecies = SpeciesFields;

/** Seeded species row, embedded in gameplay resources — carries the id. */
export interface Species extends SpeciesFields {
  id: number;
}

// ── Content: items ───────────────────────────────────────────────────────────

export interface ItemFields {
  slug: string;
  name: string;
  category: ItemCategory;
  description: string;
  emoji: string | null;
  enabled: boolean;
  purchasable: boolean;
  buyPrice: number | null;
  priceCurrency: PriceCurrency;
  captureModifier: number | null;
  isGuaranteedCapture: boolean;
  effectType: string | null;
  effectConfig: Record<string, unknown> | null;
  dailyStockLimit: number | null;
}

export type ContentItem = ItemFields;

export interface Item extends ItemFields {
  id: number;
}

// ── Content: tuning tables and quest catalog ─────────────────────────────────

/** Opaque by contract — see the file header. */
export type TuningTables = Record<string, unknown>;

export interface QuestRewards {
  waifubux: number;
  essence: number;
  items: Array<{ slug: string; quantity: number }>;
}

export interface QuestPoolEntry {
  slug: string;
  title: string;
  description: string;
  type: string;
  target: number;
  weight: number;
  difficulty: string;
  rarityAtLeast: Rarity | null;
  rewards: QuestRewards;
}

export interface QuestCatalog {
  enabled: boolean;
  questsPerDay: number;
  allCompleteBonus: QuestRewards | null;
  pool: QuestPoolEntry[];
}

// ── Players ──────────────────────────────────────────────────────────────────

/**
 * Presentation-only Discord identity.
 *
 * Nullable by contract — the gateway may be reconnecting, the user may be
 * unresolvable, or the API may run without a Discord client. Every consumer
 * falls back to `Trainer #<id>` rather than blocking on it.
 */
export interface PlayerIdentity {
  displayName: string;
  avatarUrl: string | null;
}

export interface Player {
  id: number;
  /** Internal guild id, not a Discord snowflake. */
  guildId: number;
  /** Presentation only. Null whenever the API cannot resolve it. */
  identity: PlayerIdentity | null;
  discordUserId: string;
  level: number;
  xp: number;
  /** Owned-waifu id of the active buddy, or null. */
  buddyWaifuId: number | null;
  lastHuntAt: string | null;
  /** Summary only — `GET /players/{id}/care` returns the full state. */
  careMode: { active: boolean; waifuId: number | null; startedAt: string | null };
  createdAt: string;
}

export interface CurrencyBalances {
  playerId: number;
  huntEnergy: number;
  waifubux: number;
  essence: number;
  updatedAt: string;
}

export interface PlayerProfile {
  player: Player;
  currencies: CurrencyBalances;
}

export interface PlayerLookup {
  playerId: number;
}

// ── Collection ───────────────────────────────────────────────────────────────

export interface OwnedWaifu {
  id: number;
  playerId: number;
  speciesId: number;
  level: number;
  xp: number;
  affection: number;
  nickname: string | null;
  isFavorite: boolean;
  variant: string;
  cosmetics: string[];
  caughtAt: string;
  /** Always null on read endpoints — released copies are filtered out. */
  releasedAt: string | null;
}

/** Derived by the service, not the Portal — pure arithmetic over the row. */
export interface WaifuProgress {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpToNext: number;
  atMaxLevel: boolean;
}

export interface OwnedEntry {
  waifu: OwnedWaifu;
  species: Species;
  progress: WaifuProgress;
}

export interface DexStats {
  /** Active (non-released) owned Waifumon. */
  owned: number;
  distinctSpecies: number;
  /** Enabled species in the content set — the denominator. */
  totalSpecies: number;
}

// ── Care Mode ────────────────────────────────────────────────────────────────

export interface CareState {
  /** False when Care Mode is switched off by server configuration. */
  enabled: boolean;
  active: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  target: { waifu: OwnedWaifu; species: Species } | null;
  /** Forecast only — reading does not apply them. */
  pendingTicks: number;
  intervalMinutes: number;
  energyPerTick: number;
  waifuXpPerTick: number;
  affectionPerTick: number;
  recoveryCap: number;
  effectiveEnergyCap: number;
  currentEnergy: number;
  maxEnergy: number;
}

// ── Inventory and shop ───────────────────────────────────────────────────────

export interface InventoryEntry {
  item: Item;
  quantity: number;
}

export interface ShopCatalogEntry {
  item: Item;
  /** True when the item can actually be bought right now. */
  available: boolean;
  /** Display label for unavailable rows, e.g. "Not for sale". */
  availabilityNote: string | null;
  currency: PriceCurrency;
}

// ── System (unauthenticated ops endpoints, used by §23 diagnostics) ──────────

export type ComponentStatus = 'ok' | 'degraded' | 'down';

export interface ComponentReport {
  status: ComponentStatus;
  detail?: string;
  checkedAt: string;
}

export interface ReadinessReport {
  status: ComponentStatus;
  components: Record<string, ComponentReport>;
  checkedAt: string;
}
