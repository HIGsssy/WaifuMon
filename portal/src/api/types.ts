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

// ── Appearances (cosmetic progression) ───────────────────────────────────────

/**
 * Cosmetic rarity — **independent from species rarity**. A Rare species may
 * wear a Seasonal look; the Portal styles the two differently on purpose.
 * Descriptive only: it drives nothing.
 */
export type CosmeticRarity =
  | 'standard'
  | 'common'
  | 'rare'
  | 'seasonal'
  | 'limited'
  | 'exclusive';

/**
 * How an appearance is earned. The API publishes reserved future types
 * (`evolution`, `event`, `achievement`, …) that v1 never emits, so a renderer
 * written today needs no change when the first of them ships. Prefer
 * `unlockLabel` for display — the structured form is for filtering and sorting.
 */
export interface AppearanceUnlock {
  type: string;
  /** Present for `type: "level"`: the per-copy waifu level required. */
  atLevel?: number;
}

/** Authored catalog metadata — identical for every player. */
export interface AppearanceCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  /** In-world caption, rendered as a quote. */
  flavorText: string | null;
  cosmeticRarity: CosmeticRarity;
  /** Free-form, e.g. "v1.3". Displayed verbatim. */
  introducedVersion: string | null;
  /**
   * The artwork identifier — **`null` when the artwork is not ours to show**.
   *
   * The API withholds it for locked appearances rather than flagging them,
   * because resolving an `assetId` is what produces the picture and the picture
   * is the reward for reaching the level. So there is nothing here to blur,
   * gate behind a "reveal" control, or recover by editing client state: a
   * locked entry simply arrives without its art. On a species catalog only the
   * `owned` entry carries one; on a gallery it tracks `isUnlocked` exactly.
   *
   * Render `null` as the silhouette — {@link appearanceAsset} returns `null`
   * for it and `Artwork` already draws that as the placeholder.
   */
  assetId: AssetIdResource | null;
  unlock: AppearanceUnlock;
  /**
   * Always populated by the API. Shown on locked *and* unlocked tiles — the
   * gallery is a progression journal, not a lock indicator. With the artwork
   * withheld this label carries the whole locked tile.
   */
  unlockLabel: string;
}

/** Catalog metadata plus one owned copy's state. */
export interface Appearance extends AppearanceCatalogEntry {
  isUnlocked: boolean;
  isSelected: boolean;
}

export interface AppearanceGallery {
  appearances: Appearance[];
  selected: string;
}

/**
 * The API's abstract artwork identifier — structurally identical to the
 * Portal's own `AssetId` (`src/images/types.ts`), so a response field drops
 * straight into `useImage` with no adapter. It names *what* to render and
 * never where it lives.
 */
export interface AssetIdResource {
  kind: 'waifumon';
  slug: string;
  variant: string;
}

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
  enabled: boolean;
  eventKey: string | null;
  perSpeciesWeight: number;
  /**
   * The species' appearance catalog — the authoritative source for the
   * encyclopedia and for previewing artwork the player has not earned. Never
   * empty: a species with no authored catalog carries its implicit `standard`
   * entry. Per-copy state lives on the collection appearance endpoint.
   */
  appearances: AppearanceCatalogEntry[];
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
  /**
   * The selected appearance's id. Cosmetic: it decides which artwork renders
   * and nothing else.
   */
  variant: string;
  cosmetics: string[];
  /** The look she is currently wearing, resolved. Never null. */
  selectedAppearance: Appearance;
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

/**
 * Optional features this deployment has enabled (`GET /v1/capabilities`).
 *
 * Additive by contract: a client should tolerate unknown keys, and treat a key
 * it expects but does not receive as `false`.
 */
export interface PlatformCapabilities {
  /** Rendered card images are available; the card provider knows the routes. */
  cards: boolean;
}

export interface ReadinessReport {
  status: ComponentStatus;
  components: Record<string, ComponentReport>;
  checkedAt: string;
}
