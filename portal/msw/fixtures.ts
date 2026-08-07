/**
 * Canonical fixtures for the mocked Platform API.
 *
 * These are hand-built to match the API's real response shapes — the same
 * shapes `src/api/types.ts` declares. When a hand-written type drifts from the
 * API (§26), it is these fixtures plus a typecheck that catch it, so they are
 * typed rather than loose objects.
 */
import type {
  Appearance,
  AppearanceCatalogEntry,
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

/**
 * The Discord pair the developer-login flow resolves to `PLAYER_ID`.
 *
 * `vitest.setup.ts` seeds it into `localStorage` before every test, which is
 * the test-suite equivalent of "already signed in" — the state every page test
 * assumes. The guild snowflake has no counterpart on the player resource
 * (which carries the internal `guildId` instead), so it lives only here.
 */
export const DISCORD_GUILD_ID = '987654321098765432';
export const DISCORD_USER_ID = '123456789012345678';

export const player: Player = {
  id: PLAYER_ID,
  guildId: 7,
  identity: {
    displayName: 'Mika',
    avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/abcdef.png',
  },
  discordUserId: DISCORD_USER_ID,
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

/**
 * Every species has at least the implicit `standard` / `owned` entry — that is
 * what makes a species authored before the appearance system still render.
 */
export function standardAppearance(slug: string): AppearanceCatalogEntry {
  return {
    id: 'standard',
    name: 'Standard',
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    assetId: { kind: 'waifumon', slug, variant: 'standard' },
    unlock: { type: 'owned' },
    unlockLabel: 'Owned',
  };
}

/** A level-gated entry, for exercising the locked half of the gallery. */
export function levelAppearance(
  slug: string,
  id: string,
  atLevel: number,
  overrides: Partial<AppearanceCatalogEntry> = {},
): AppearanceCatalogEntry {
  return {
    id,
    name: 'Midnight Bloom',
    description: 'A darker cut of her usual silhouette.',
    flavorText: 'Prepared for the annual shrine celebration.',
    cosmeticRarity: 'seasonal',
    introducedVersion: 'v1.3',
    assetId: { kind: 'waifumon', slug, variant: id },
    unlock: { type: 'level', atLevel },
    unlockLabel: `Reach Level ${atLevel}`,
    ...overrides,
  };
}

function makeSpecies(overrides: Partial<Species> & Pick<Species, 'id' | 'slug' | 'name'>): Species {
  return {
    rarity: 'N',
    archetype: 'demi-human',
    affinity: 'switch',
    contentRating: 'suggestive',
    description: 'A placeholder description used by the mocked API.',
    tags: ['placeholder'],
    baseCaptureRate: null,
    enabled: true,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances: [standardAppearance(overrides.slug)],
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
    // Two-entry catalog: the owned default plus a level gate the fixture copy
    // has *not* reached, so the gallery's locked half is exercised by default.
    appearances: [
      standardAppearance('void_empress'),
      levelAppearance('void_empress', 'level_40', 40),
    ],
  }),
];

/** Catalog metadata + per-copy state, as the gallery endpoint returns it. */
function withState(
  entry: AppearanceCatalogEntry,
  state: { isUnlocked: boolean; isSelected: boolean },
): Appearance {
  return { ...entry, ...state };
}

/** Keyed by owned-waifu id, mirroring `GET …/appearances`. */
export const appearanceGalleries: Record<number, { appearances: Appearance[]; selected: string }> =
  {
    101: {
      selected: 'standard',
      appearances: [
        withState(standardAppearance('void_empress'), { isUnlocked: true, isSelected: true }),
        withState(levelAppearance('void_empress', 'level_40', 40), {
          isUnlocked: false,
          isSelected: false,
        }),
      ],
    },
    102: {
      selected: 'standard',
      appearances: [
        withState(standardAppearance('neon_kitsune'), { isUnlocked: true, isSelected: true }),
      ],
    },
    103: {
      selected: 'standard',
      appearances: [
        withState(standardAppearance('neko_barista'), { isUnlocked: true, isSelected: true }),
      ],
    },
  };

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
      selectedAppearance: withState(standardAppearance('void_empress'), {
        isUnlocked: true,
        isSelected: true,
      }),
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
      selectedAppearance: withState(standardAppearance('neon_kitsune'), {
        isUnlocked: true,
        isSelected: true,
      }),
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
      selectedAppearance: withState(standardAppearance('neko_barista'), {
        isUnlocked: true,
        isSelected: true,
      }),
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

/**
 * Mirrors the *real* shape of `tables.json`, checked against a live Platform
 * API rather than invented. The Guide reads this defensively either way, but a
 * fixture that disagreed with production would let a broken path pass tests.
 */
export const tuningTables: Record<string, unknown> = {
  energy: {
    baseMax: 25,
    careMode: {
      enabled: true,
      intervalMinutes: 30,
      energyPerTick: 1,
      recoveryCap: 20,
      waifuXpPerTick: 2,
      affectionPerTick: 1,
    },
  },
  hunt: {
    cooldownSeconds: 2,
    encounterExpirySeconds: 120,
    sessionIdleMinutes: 15,
    locationFlavors: ['the Whispering Forest', 'the Neon Boardwalk'],
  },
  capture: {
    baseRatesByRarity: { N: 0.5, R: 0.35, SR: 0.22, SSR: 0.12, UR: 0.06, LR: 0.03, EX: 0.03 },
    minChance: 0.02,
    maxChance: 0.95,
  },
  progression: {
    levelCurve: { base: 100, growth: 50 },
    maxLevel: 50,
    maxEnergy: { cap: 40, levelBonuses: [{ atLevel: 7, delta: 5 }] },
  },
};
