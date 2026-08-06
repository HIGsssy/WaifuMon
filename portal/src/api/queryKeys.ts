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
  buddy: (playerId: number) => ['player', playerId, 'collection', 'buddy'] as const,
  /** Every owned page, walked once and cached for the encyclopedia overlay (§8.7). */
  ownedSlugs: (playerId: number) => ['player', playerId, 'collection', 'ownedSlugs'] as const,

  content: () => ['content'] as const,
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
} as const;
