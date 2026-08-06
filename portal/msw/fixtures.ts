/**
 * Canonical fixtures for the mocked Platform API.
 *
 * These are hand-built to match the API's real response shapes — the same
 * shapes `src/api/types.ts` declares. When a hand-written type drifts from the
 * API (§26), it is these fixtures plus a typecheck that catch it, so they are
 * typed rather than loose objects.
 */
import type {
  CareState,
  ContentItem,
  ContentSpecies,
  CurrencyBalances,
  DexStats,
  InventoryEntry,
  Item,
  OwnedEntry,
  Player,
  ShopCatalogEntry,
  Species,
} from '@/api/types';

export const PLAYER_ID = 1;

export const player: Player = {
  id: PLAYER_ID,
  guildId: 7,
  discordUserId: '123456789012345678',
  level: 12,
  xp: 3480,
  buddyWaifuId: 101,
  lastHuntAt: '2026-08-06T09:14:00.000Z',
  careMode: { active: false, waifuId: null, startedAt: null },
  createdAt: '2026-05-01T12:00:00.000Z',
};

export const currencies: CurrencyBalances = {
  playerId: PLAYER_ID,
  huntEnergy: 34,
  waifubux: 1820,
  essence: 46,
  updatedAt: '2026-08-06T09:14:00.000Z',
};

export const dexStats: DexStats = { owned: 23, distinctSpecies: 18, totalSpecies: 58 };

function makeSpecies(overrides: Partial<Species> & Pick<Species, 'id' | 'slug' | 'name'>): Species {
  return {
    rarity: 'N',
    archetype: 'demi-human',
    affinity: 'switch',
    contentRating: 'suggestive',
    description: 'A placeholder description used by the mocked API.',
    tags: ['placeholder'],
    baseCaptureRate: null,
    imagePath: `waifumon/${overrides.slug}/standard.png`,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    ...overrides,
  };
}

export const speciesRows: Species[] = [
  makeSpecies({ id: 11, slug: 'neko_barista', name: 'Neko Barista', rarity: 'N' }),
  makeSpecies({
    id: 12,
    slug: 'neon_kitsune',
    name: 'Neon Kitsune',
    rarity: 'SR',
    archetype: 'spirit',
    affinity: 'submissive',
  }),
  makeSpecies({
    id: 13,
    slug: 'void_empress',
    name: 'Void Empress',
    rarity: 'UR',
    archetype: 'demon',
    affinity: 'primal',
    contentRating: 'explicit',
  }),
];

/** The content snapshot is the same fields minus the internal id. */
export const contentSpecies: ContentSpecies[] = speciesRows.map(({ id: _id, ...rest }) => rest);

export const ownedEntries: OwnedEntry[] = [
  {
    waifu: {
      id: 101,
      playerId: PLAYER_ID,
      speciesId: 13,
      level: 22,
      xp: 5400,
      affection: 64,
      nickname: 'Nyx',
      isFavorite: true,
      variant: 'standard',
      cosmetics: [],
      caughtAt: '2026-07-02T18:30:00.000Z',
      releasedAt: null,
    },
    species: speciesRows[2]!,
    progress: { level: 22, xp: 5400, xpIntoLevel: 400, xpToNext: 900, atMaxLevel: false },
  },
  {
    waifu: {
      id: 102,
      playerId: PLAYER_ID,
      speciesId: 12,
      level: 9,
      xp: 820,
      affection: 12,
      nickname: null,
      isFavorite: false,
      variant: 'standard',
      cosmetics: [],
      caughtAt: '2026-07-20T08:05:00.000Z',
      releasedAt: null,
    },
    species: speciesRows[1]!,
    progress: { level: 9, xp: 820, xpIntoLevel: 120, xpToNext: 300, atMaxLevel: false },
  },
  {
    waifu: {
      id: 103,
      playerId: PLAYER_ID,
      speciesId: 11,
      level: 3,
      xp: 90,
      affection: 4,
      nickname: null,
      isFavorite: false,
      variant: 'standard',
      cosmetics: [],
      caughtAt: '2026-08-01T21:40:00.000Z',
      releasedAt: null,
    },
    species: speciesRows[0]!,
    progress: { level: 3, xp: 90, xpIntoLevel: 40, xpToNext: 110, atMaxLevel: false },
  },
];

export const buddyEntry: OwnedEntry = ownedEntries[0]!;

function makeItem(overrides: Partial<Item> & Pick<Item, 'id' | 'slug' | 'name'>): Item {
  return {
    category: 'capture',
    description: 'A placeholder item used by the mocked API.',
    emoji: '🩷',
    enabled: true,
    purchasable: true,
    buyPrice: 25,
    priceCurrency: 'waifubux',
    captureModifier: 1,
    isGuaranteedCapture: false,
    effectType: null,
    effectConfig: null,
    dailyStockLimit: null,
    ...overrides,
  };
}

export const itemRows: Item[] = [
  makeItem({ id: 1, slug: 'basic_charm', name: 'Basic Charm' }),
  makeItem({
    id: 2,
    slug: 'silk_charm',
    name: 'Silk Charm',
    buyPrice: 75,
    captureModifier: 1.5,
  }),
  makeItem({
    id: 3,
    slug: 'moon_shard',
    name: 'Moon Shard',
    category: 'material',
    purchasable: false,
    buyPrice: null,
    captureModifier: null,
    emoji: '🌙',
  }),
];

export const contentItems: ContentItem[] = itemRows.map(({ id: _id, ...rest }) => rest);

export const inventoryEntries: InventoryEntry[] = [
  { item: itemRows[0]!, quantity: 12 },
  { item: itemRows[2]!, quantity: 3 },
];

export const shopCatalog: ShopCatalogEntry[] = [
  { item: itemRows[0]!, available: true, availabilityNote: null, currency: 'waifubux' },
  {
    item: itemRows[1]!,
    available: false,
    availabilityNote: 'Not currently available',
    currency: 'waifubux',
  },
];

export const careState: CareState = {
  enabled: true,
  active: false,
  startedAt: null,
  lastTickAt: null,
  nextTickAt: null,
  target: null,
  pendingTicks: 0,
  intervalMinutes: 30,
  energyPerTick: 2,
  waifuXpPerTick: 15,
  affectionPerTick: 1,
  recoveryCap: 60,
  effectiveEnergyCap: 50,
  currentEnergy: 34,
  maxEnergy: 50,
};

export const tuningTables: Record<string, unknown> = {
  energy: { max: 50, regenMinutes: 6 },
  hunt: { energyCost: 5, encounterTtlMinutes: 10 },
  capture: { baseRates: { N: 0.7, R: 0.5, SR: 0.3, SSR: 0.15, UR: 0.07, LR: 0.03, EX: 0.01 } },
};
