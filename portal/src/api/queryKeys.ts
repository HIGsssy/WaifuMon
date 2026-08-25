/**
 * Canonical TanStack Query cache keys (plan §10, §13).
 *
 * Two invariants the whole app relies on:
 *
 *  - **Player-scoped keys start with `['player', playerId, …]`.** A future
 *    runtime switcher (§25.2) can then invalidate one player's subtree with a
 *    single prefix match instead of clearing the cache.
 *  - **Content keys never carry a player id.** Content is global and cached
 *    with `staleTime: Infinity`; mixing a player into the key would multiply
 *    the snapshot per player for no reason.
 *
 * Every key is built here so a typo cannot silently create a second cache entry
 * for the same resource.
 */
import type { ItemCategory, Rarity } from './types';

export const queryKeys = {
  player: (playerId: number) => ['player', playerId] as const,

  playerRecord: (playerId: number) => ['player', playerId, 'record'] as const,
  playerProfile: (playerId: number) => ['player', playerId, 'profile'] as const,
  care: (playerId: number) => ['player', playerId, 'care'] as const,
  inventory: (playerId: number) => ['player', playerId, 'inventory'] as const,

  collection: (playerId: number) => ['player', playerId, 'collection'] as const,
  collectionList: (playerId: number, page: number, rarity?: Rarity | undefined) =>
    ['player', playerId, 'collection', 'list', { page, rarity: rarity ?? null }] as const,
  collectionEntry: (playerId: number, waifuId: number) =>
    ['player', playerId, 'collection', 'entry', waifuId] as const,
  collectionStats: (playerId: number) => ['player', playerId, 'collection', 'stats'] as const,
  /** One copy's appearance gallery — per-copy, so it carries the waifu id. */
  waifuAppearances: (playerId: number, waifuId: number) =>
    ['player', playerId, 'collection', 'appearances', waifuId] as const,
  buddy: (playerId: number) => ['player', playerId, 'collection', 'buddy'] as const,
  /**
   * Every owned page, walked once and cached for the encyclopedia overlay
   * (§8.7).
   *
   * `ownedCount` is part of the key on purpose. The walk is the one player
   * query too expensive to poll, so it cannot rely on a stale time to notice a
   * capture; instead its cache identity carries the number that changes
   * exactly when ownership does (`collection/stats.owned`, a single cheap
   * request under `PLAYER_POLICY`). A capture in Discord moves that number and
   * the overlay is re-derived rather than serving a stale silhouette.
   *
   * The `['player', id, 'collection', 'ownedSlugs']` prefix is still stable, so
   * a prefix invalidation reaches every count.
   */
  ownedSlugs: (playerId: number, ownedCount?: number | undefined) =>
    ['player', playerId, 'collection', 'ownedSlugs', ownedCount ?? 'unknown'] as const,

  content: () => ['content'] as const,
  /**
   * Which optional backend features exist. Deployment-wide and player-free —
   * it describes the server, not a game resource.
   */
  capabilities: () => ['capabilities'] as const,

  contentSpecies: () => ['content', 'species'] as const,
  contentSpeciesEntry: (slug: string) => ['content', 'species', slug] as const,
  contentItems: (category?: ItemCategory | undefined) =>
    ['content', 'items', category ?? 'all'] as const,
  contentTables: () => ['content', 'tables'] as const,
  contentTable: (key: string) => ['content', 'tables', key] as const,
  contentQuests: () => ['content', 'quests'] as const,

  shopCatalog: () => ['shop', 'catalog'] as const,

  /** Dev-only, diagnostics page. */
  readiness: () => ['system', 'readiness'] as const,

  // The developer login's Discord-identity lookup is the one key not built
  // here. It belongs to a subtree a production build drops entirely, and a
  // property on this object would survive that drop as a dead string — see
  // `auth/dev/DevLoginSessionProvider.tsx`.
} as const;
