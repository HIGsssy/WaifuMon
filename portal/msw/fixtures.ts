/**
 * Canonical fixtures for the mocked Platform API.
 *
 * These are hand-built to match the API's real response shapes — the same
 * shapes `src/api/types.ts` declares. When a hand-written type drifts from the
 * API (§26), it is these fixtures plus a typecheck that catch it, so they are
 * typed rather than loose objects.
 */
import type {
  AchievementsResponse,
  BuddyBonus,
  Appearance,
  AppearanceCatalogEntry,
  CareState,
  ContentItem,
  ContentSpecies,
  CurrencyBalances,
  DexStats,
  ExpeditionOverview,
  InventoryEntry,
  Item,
  DirectoryPlayer,
  LeaderboardResponse,
  OwnedEntry,
  Player,
  PublicOwnedEntry,
  PublicOwnedWaifu,
  PublicPlayerProfile,
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
  /**
   * Server-resolved, and internally consistent with `xp`: 3,480 lifetime XP is
   * partway through Level 12, leaving 280 of a 650-XP level behind her. The
   * Portal never derives any of this — the fixture mirrors what
   * `progressionService.progressFor` returns.
   */
  progress: {
    level: 12,
    totalXp: 3480,
    xpIntoLevel: 280,
    xpToNext: 650,
    atMaxLevel: false,
  },
  /** Both fields come from the API; the Portal never title-cases the id itself. */
  currentRegion: { id: 'twin-peeks', name: 'Twin Peeks' },
  lastHuntAt: '2026-08-06T09:14:00.000Z',
  careMode: { active: false, waifuId: null, startedAt: null },
  createdAt: '2026-05-01T12:00:00.000Z',
};

export const currencies: CurrencyBalances = {
  playerId: PLAYER_ID,
  huntEnergy: 34,
  /** Level-derived on the server — 25 base plus the Level 7 and 20 bonuses. */
  maxHuntEnergy: 35,
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

/**
 * A level-gated entry, for exercising the locked half of the gallery.
 *
 * **`assetId` is `null`, mirroring the real catalog endpoint.** A species
 * catalog has no player in scope, so it can only reveal artwork for the ungated
 * `owned` entry; a gated entry travels as a named slot with its requirement and
 * nothing to resolve. `withState` puts the identifier back for a copy that has
 * actually earned it — which is the only place the real API ever does.
 *
 * It therefore takes no `slug`: there is no asset to address until something
 * grants one, and accepting a slug here would invite exactly the reconstruction
 * (`{ slug, variant: id }`) the fix exists to prevent.
 */
export function levelAppearance(
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
    assetId: null,
    unlock: { type: 'level', atLevel },
    unlockLabel: `Reach Level ${atLevel}`,
    ...overrides,
  };
}

/** The artwork identifier a gated entry carries *once earned*. */
export function unlockedAssetId(slug: string, variant: string) {
  return { kind: 'waifumon' as const, slug, variant };
}

function makeSpecies(overrides: Partial<Species> & Pick<Species, 'id' | 'slug' | 'name'>): Species {
  return {
    rarity: 'N',
    archetype: 'demi-human',
    race: 'demi-human',
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
    race: 'spirit',
    affinity: 'submissive',
  }),
  makeSpecies({
    id: 13,
    slug: 'void_empress',
    name: 'Void Empress',
    rarity: 'UR',
    archetype: 'demon',
    race: 'demon',
    affinity: 'primal',
    contentRating: 'explicit',
    // Two-entry catalog: the owned default plus a level gate the fixture copy
    // has *not* reached, so the gallery's locked half is exercised by default.
    appearances: [
      standardAppearance('void_empress'),
      levelAppearance('level_40', 40),
    ],
  }),
];

/**
 * Catalog metadata + per-copy state, as the gallery endpoint returns it.
 *
 * Enforces the API's own invariant so no fixture can drift from it: `assetId`
 * is present exactly when `isUnlocked` is true. A locked entry has its
 * identifier stripped no matter what was passed in, and an unlocked gated entry
 * gets one back — that reveal is the *only* place the real API grants one for
 * gated artwork.
 */
function withState(
  entry: AppearanceCatalogEntry,
  state: { isUnlocked: boolean; isSelected: boolean },
  revealed?: { kind: 'waifumon'; slug: string; variant: string },
): Appearance {
  return {
    ...entry,
    ...state,
    assetId: state.isUnlocked ? (revealed ?? entry.assetId) : null,
  };
}

/** Keyed by owned-waifu id, mirroring `GET …/appearances`. */
export const appearanceGalleries: Record<number, { appearances: Appearance[]; selected: string }> =
  {
    101: {
      selected: 'standard',
      appearances: [
        withState(standardAppearance('void_empress'), { isUnlocked: true, isSelected: true }),
        withState(levelAppearance('level_40', 40), {
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

/**
 * Buddy Bonuses, keyed by slug — the one field a seeded row cannot carry, so it
 * is layered on when the rows become the content snapshot.
 *
 * Three shapes on purpose, because they are the three the Portal has to render
 * differently: a race-qualified capture bonus, an untargeted non-capture one,
 * and (by omission) a species that grants nothing at all. `targetLabel` and
 * `effectSummary` are exactly the strings the API resolves from its own effect
 * registry — the fixture mirrors the wire, it does not re-derive it.
 */
export const buddyBonuses: Record<string, BuddyBonus> = {
  void_empress: {
    name: 'Hijack',
    flavorText: 'She talks to their firmware the way most people talk to a dog.',
    effectId: 'capture_chance',
    value: 15,
    target: { type: 'race', value: 'android' },
    targetLabel: 'android Waifumon',
    effectSummary: '+15% capture chance against android Waifumon',
  },
  neon_kitsune: {
    name: 'Trash Treasure',
    flavorText: 'Nothing in the alley is rubbish if you know a buyer.',
    effectId: 'hunt_item_find_chance',
    value: 5,
    target: null,
    targetLabel: null,
    effectSummary: '+5% item-find chance',
  },
  // `neko_barista` deliberately has none — most species do not.
};

/**
 * The content snapshot is the same fields minus the internal id, plus the
 * Buddy Bonus. A species without one carries **no key**, mirroring the API,
 * which omits it rather than sending a null.
 */
export const contentSpecies: ContentSpecies[] = speciesRows.map(({ id: _id, ...rest }) => {
  const bonus = buddyBonuses[rest.slug];
  return bonus ? { ...rest, buddyBonus: bonus } : rest;
});

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
    buyPrice: 25,
    priceCurrency: 'waifubux',
    shopRegions: ['waifu-valley'],
    captureModifier: 1,
    captureBonus: null,
    captureRarities: [],
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
    shopRegions: [],
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

/** Optional backend features, as `/api/v1/capabilities` reports them. */
export const capabilities = { cards: true };

/**
 * A minimal valid WebP — a 1×1 lossy image, 34 bytes.
 *
 * Real bytes rather than a JSON stub so an `<img>` can decode it and the export
 * flow has a genuine `Blob` to save. Base64 because a binary fixture file would
 * be the only one in this directory.
 */
const CARD_WEBP_BASE64 = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

export function cardWebpBytes(): Uint8Array {
  const binary = atob(CARD_WEBP_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Guild player directory ──────────────────────────────────────────────────

/**
 * The Players directory for `player.guildId` (7).
 *
 * Deliberately not name-ordered, not level-ordered and not recency-ordered as
 * authored, so a test asserting any of the three orders is asserting that the
 * order was *applied* rather than that the fixture happened to be right.
 *
 * Note what the shape does not contain: no `discordUserId`, no `xp`, no
 * currencies. That is the API's contract, and a payload test asserts it against
 * this fixture, so widening the fixture would fail that test rather than
 * quietly bless a leak.
 */
export const directoryPlayers: DirectoryPlayer[] = [
  {
    id: PLAYER_ID,
    displayName: 'Mika',
    avatarUrl: 'https://cdn.discordapp.com/avatars/123456789012345678/abcdef.png',
    level: 12,
    lastActiveAt: '2026-08-06T09:14:00.000Z',
    buddy: {
      speciesSlug: 'nyx',
      speciesName: 'Nyx',
      rarity: 'SSR',
      level: 14,
      assetId: { kind: 'waifumon', slug: 'nyx', variant: 'standard' },
    },
  },
  {
    id: 42,
    displayName: 'Aiko',
    avatarUrl: null,
    level: 31,
    lastActiveAt: '2026-08-07T18:00:00.000Z',
    buddy: null,
  },
  {
    id: 77,
    displayName: 'Zara',
    avatarUrl: null,
    level: 4,
    lastActiveAt: '2026-06-01T08:00:00.000Z',
    buddy: null,
  },
];

/** The directory of a *different* guild — nothing here may reach guild 7's page. */
export const otherGuildDirectoryPlayers: DirectoryPlayer[] = [
  {
    id: 900,
    displayName: 'Outsider',
    avatarUrl: null,
    level: 50,
    lastActiveAt: '2026-08-07T18:00:00.000Z',
    buddy: null,
  },
];

export const publicProfile: PublicPlayerProfile = {
  ...(directoryPlayers[1] as DirectoryPlayer),
  createdAt: '2026-04-02T12:00:00.000Z',
  currentRegion: { id: 'waifu-valley', name: 'Waifu Valley' },
  collection: { owned: 61, distinctSpecies: 30, totalSpecies: 58 },
  achievements: {
    total: 23,
    unlocked: 7,
    completionPercent: 30,
    recent: [
      { id: 'level_25', name: 'Accomplished Trainer', category: 'progression', icon: '🌟', unlockedAt: '2026-05-01T10:00:00.000Z' },
      { id: 'rarity_ssr', name: 'Superstar', category: 'rarity', icon: '🥇', unlockedAt: '2026-04-20T10:00:00.000Z' },
    ],
  },
};

/** A player's own achievement wall — a mix of unlocked, in-progress and hidden. */
export const achievementsResponse: AchievementsResponse = {
  summary: { total: 5, unlocked: 2, completionPercent: 40 },
  achievements: [
    {
      id: 'hunter_1',
      category: 'hunting',
      hidden: false,
      status: 'unlocked',
      unlocked: true,
      unlockedAt: '2026-05-01T10:00:00.000Z',
      name: 'First Hunt',
      description: 'Complete your first hunt.',
      icon: '🌱',
      series: 'hunter',
      tier: 1,
      progress: { current: 1, target: 1 },
    },
    {
      id: 'hunter_3',
      category: 'hunting',
      hidden: false,
      status: 'in_progress',
      unlocked: false,
      unlockedAt: null,
      name: 'Seasoned Hunter',
      description: 'Complete 100 hunts.',
      icon: '🎯',
      series: 'hunter',
      tier: 3,
      progress: { current: 82, target: 100 },
    },
    {
      id: 'collector_1',
      category: 'collection',
      hidden: false,
      status: 'unlocked',
      unlocked: true,
      unlockedAt: '2026-04-28T10:00:00.000Z',
      name: 'Budding Collector',
      description: 'Own 10 distinct species.',
      icon: '📗',
      series: 'collector',
      tier: 1,
      progress: { current: 10, target: 10 },
    },
    {
      id: 'devoted_1',
      category: 'buddy',
      hidden: false,
      status: 'locked',
      unlocked: false,
      unlockedAt: null,
      name: 'Growing Closer',
      description: 'Reach 500 Affection with your Buddy.',
      icon: '💞',
      series: 'devoted',
      tier: 1,
      progress: { current: 0, target: 500 },
    },
    {
      // Hidden + locked: concealed exactly as the backend ships it.
      id: 'secret_devotion',
      category: 'special',
      hidden: true,
      status: 'locked',
      unlocked: false,
      unlockedAt: null,
      name: '???',
      description: 'Hidden Achievement',
      icon: null,
      series: null,
      tier: null,
      progress: null,
    },
  ],
};

/** A guild leaderboard — ranks only, never a metric value. */
export const leaderboardResponse: LeaderboardResponse = {
  metric: 'trainer',
  entries: [
    { rank: 1, playerId: 7, displayName: 'Vex', avatarUrl: null, isMe: false },
    { rank: 2, playerId: 42, displayName: 'Aiko', avatarUrl: null, isMe: false },
    { rank: 2, playerId: 43, displayName: 'Rin', avatarUrl: null, isMe: false },
    { rank: 4, playerId: PLAYER_ID, displayName: 'You', avatarUrl: null, isMe: true },
  ],
  me: { rank: 4 },
};

// ── A guild-mate's public collection ────────────────────────────────────────

/**
 * What Aiko (player 42) owns, as her guild-mates see it.
 *
 * Deliberately **not** a slice of `ownedEntries`: these are different copies,
 * different ids, different nicknames and a different species mix. A test that
 * mixes up "the viewer's collection" with "the viewed player's" therefore fails
 * on the assertion rather than passing because the two fixtures agreed.
 *
 * The shape is the API's `publicOwnedEntrySchema` exactly — note the absent
 * `xp`, `affection`, `seductivePower`, `cosmetics`, `speciesId`, `releasedAt`
 * and `progress`, and note that `caughtAt` is a calendar day rather than the
 * full instant `ownedEntries` carries. A payload test asserts both against this
 * fixture, so widening it fails a test rather than quietly blessing a
 * disclosure.
 */
function publicCopy(
  waifu: Omit<PublicOwnedWaifu, 'playerId' | 'variant' | 'selectedAppearance'> & {
    slug: string;
  },
  species: Species,
  isBuddy = false,
): PublicOwnedEntry {
  const { slug, ...rest } = waifu;
  return {
    waifu: {
      ...rest,
      playerId: 42,
      variant: 'standard',
      selectedAppearance: withState(standardAppearance(slug), {
        isUnlocked: true,
        isSelected: true,
      }),
    },
    species,
    isBuddy,
  };
}

export const aikoCollection: PublicOwnedEntry[] = [
  publicCopy(
    {
      id: 501,
      slug: 'void_empress',
      level: 40,
      nickname: 'Vesper',
      isFavorite: true,
      caughtAt: '2026-05-11',
    },
    speciesRows[2]!,
    true,
  ),
  publicCopy(
    {
      id: 502,
      slug: 'neko_barista',
      level: 6,
      nickname: null,
      isFavorite: false,
      caughtAt: '2026-08-01',
    },
    speciesRows[0]!,
  ),
  publicCopy(
    {
      id: 503,
      slug: 'neon_kitsune',
      level: 18,
      nickname: 'Amber',
      isFavorite: false,
      caughtAt: '2026-06-15',
    },
    speciesRows[1]!,
  ),
];

/**
 * Public collections by owner id. A player absent from this map is one the API
 * would answer 404 for — which is how the mock expresses "not in your guild"
 * without inventing a guild parameter the real endpoint does not have.
 */
export const publicCollections: Record<number, PublicOwnedEntry[]> = {
  42: aikoCollection,
};

// ── Admin Waifumon Gallery ───────────────────────────────────────────────────
//
// A small catalog covering every state the gallery must tell apart: loaded vs
// future, enabled vs disabled (by the author and by the loader), missing and
// unsafe primary artwork, a PNG-only look, a dropped appearance, and species
// with and without a recognised zone.

type GalleryArtworkStatus = import('@/api/adminGallery').GalleryArtworkStatus;
type GalleryAppearanceFixture = import('@/api/adminGallery').GalleryAppearance;
type GallerySpeciesDetailFixture = import('@/api/adminGallery').GallerySpeciesDetail;
type GalleryIssueFixture = import('@/api/adminGallery').GalleryIssue;

const GALLERY_LOOKS = ['standard', 'level_10', 'level_20', 'level_30', 'level_40', 'level_50'];

interface LookOverride {
  status?: GalleryArtworkStatus;
  format?: 'webp' | 'png';
  inRuntime?: boolean;
  renditions?: Record<string, boolean>;
  dropped?: boolean;
}

function galleryLook(
  slug: string,
  id: string,
  index: number,
  loaded: boolean,
  over: LookOverride = {},
): GalleryAppearanceFixture {
  const status = over.status ?? 'available';
  const isDefault = id === 'standard';
  const format = status === 'available' ? (over.format ?? 'webp') : null;
  const renditions =
    status === 'available' ? (over.renditions ?? { 256: true, 512: true, 1024: true }) : undefined;
  const inRuntime = loaded && (over.inRuntime ?? true);
  const issues: GalleryIssueFixture[] = [];
  if (status === 'missing') {
    issues.push({
      code: isDefault ? 'default_artwork_missing' : 'appearance_artwork_missing',
      severity: 'error',
      appearanceId: id,
    });
  }
  if (status === 'unsafe')
    issues.push({ code: 'artwork_unsafe', severity: 'error', appearanceId: id });
  if (format === 'png')
    issues.push({ code: 'artwork_png_only', severity: 'warning', appearanceId: id });
  if (loaded && !inRuntime) {
    issues.push({ code: 'appearance_not_in_runtime', severity: 'warning', appearanceId: id });
  }
  if (renditions && Object.values(renditions).some((present) => !present)) {
    issues.push({ code: 'renditions_missing', severity: 'warning', appearanceId: id });
  }
  const level = index * 10;
  return {
    id,
    name: isDefault ? 'Standard' : `Level ${level}`,
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    contentRating: 'mature',
    contentRatingSource: 'species',
    sortOrder: level,
    tags: [],
    unlock: isDefault ? { type: 'owned' } : { type: 'level', atLevel: level },
    unlockLabel: isDefault ? 'Owned' : `Reach Level ${level}`,
    isDefault,
    implicit: false,
    assetId: { kind: 'waifumon', slug, variant: id },
    inRuntime,
    artwork: {
      status,
      format,
      storageStem: `waifumon/${slug}/${id}`,
      ...(renditions ? { renditions } : {}),
    },
    loaderDiagnostics: over.dropped ? ['appearance_dropped_artwork_missing'] : [],
    issues,
  };
}

interface GallerySpeciesFixtureInput {
  slug: string;
  name: string;
  rarity: import('@/api/types').Rarity;
  race: string;
  affinity: import('@/api/types').Affinity;
  contentRating: import('@/api/types').ContentRating;
  tags: string[];
  source: GallerySpeciesDetailFixture['source'];
  authoredEnabled?: boolean;
  loaded: boolean;
  runtimeEnabled?: boolean;
  disabledByLoader?: boolean;
  looks?: Record<string, LookOverride>;
}

function gallerySpeciesFixture(input: GallerySpeciesFixtureInput): GallerySpeciesDetailFixture {
  const appearances = GALLERY_LOOKS.map((id, i) =>
    galleryLook(input.slug, id, i, input.loaded, input.looks?.[id]),
  );
  const primary = appearances[0]!;
  const speciesIssues: GalleryIssueFixture[] = input.disabledByLoader
    ? [{ code: 'species_disabled_by_loader', severity: 'error', appearanceId: 'standard' }]
    : [];
  return {
    slug: input.slug,
    name: input.name,
    rarity: input.rarity,
    race: input.race,
    archetype: input.race,
    affinity: input.affinity,
    contentRating: input.contentRating,
    tags: input.tags,
    source: input.source,
    authoredEnabled: input.authoredEnabled ?? true,
    runtime: {
      loaded: input.loaded,
      enabled: input.loaded ? (input.runtimeEnabled ?? true) : null,
      disabledByLoader: input.disabledByLoader ?? false,
    },
    appearanceCounts: {
      authored: appearances.length,
      inRuntime: input.loaded ? appearances.filter((a) => a.inRuntime).length : null,
      artworkAvailable: appearances.filter((a) => a.artwork.status === 'available').length,
    },
    primary: {
      appearanceId: primary.id,
      assetId: primary.assetId,
      status: primary.artwork.status,
      format: primary.artwork.format,
    },
    issues: [...speciesIssues, ...appearances.flatMap((a) => a.issues)],
    description: `${input.name} is an admin gallery fixture.`,
    card: null,
    buddyBonus: null,
    baseCaptureRate: null,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances,
    loaderDiagnostics: [
      ...(input.disabledByLoader
        ? [
            {
              code: 'species_disabled_default_artwork_missing',
              slug: input.slug,
              appearanceId: 'standard',
              assetId: { kind: 'waifumon' as const, slug: input.slug, variant: 'standard' },
            },
          ]
        : []),
      ...Object.entries(input.looks ?? {})
        .filter(([, o]) => o.dropped)
        .map(([id]) => ({
          code: 'appearance_dropped_artwork_missing',
          slug: input.slug,
          appearanceId: id,
          assetId: { kind: 'waifumon' as const, slug: input.slug, variant: id },
        })),
    ],
  };
}

const CORE = { kind: 'core' } as const;

export const adminGalleryDetails: GallerySpeciesDetailFixture[] = [
  gallerySpeciesFixture({
    slug: 'alley_catgirl',
    name: 'Alley Catgirl',
    rarity: 'N',
    race: 'demi-human',
    affinity: 'dominant',
    contentRating: 'suggestive',
    tags: ['starter', 'waifu_valley'],
    source: CORE,
    loaded: true,
  }),
  gallerySpeciesFixture({
    slug: 'onsen_maid',
    name: 'Onsen Maid',
    rarity: 'SR',
    race: 'human',
    affinity: 'caregiver',
    contentRating: 'mature',
    tags: ['expansion', 'region_exclusive', 'twin_peeks'],
    source: {
      kind: 'expansion',
      expansionId: 'twin_peaks',
      expansionName: 'Twin Peaks',
      expansionEnabled: true,
    },
    loaded: true,
    looks: {
      level_10: { format: 'png' },
      level_20: { renditions: { 256: true, 512: false, 1024: false } },
      level_40: { status: 'missing', inRuntime: false, dropped: true },
    },
  }),
  gallerySpeciesFixture({
    slug: 'ghost_girl',
    name: 'Ghost Girl',
    rarity: 'UR',
    race: 'spirit',
    affinity: 'primal',
    contentRating: 'explicit',
    tags: ['waifu_valley'],
    source: CORE,
    loaded: true,
    runtimeEnabled: false,
    disabledByLoader: true,
    looks: Object.fromEntries(GALLERY_LOOKS.map((id) => [id, { status: 'missing' as const }])),
  }),
  gallerySpeciesFixture({
    slug: 'retired_idol',
    name: 'Retired Idol',
    rarity: 'SSR',
    race: 'angel',
    affinity: 'submissive',
    contentRating: 'suggestive',
    tags: ['flaccid_foothills'],
    source: CORE,
    authoredEnabled: false,
    loaded: true,
    runtimeEnabled: false,
  }),
  gallerySpeciesFixture({
    slug: 'star_marshal',
    name: 'Star Marshal',
    rarity: 'LR',
    race: 'android',
    affinity: 'switch',
    contentRating: 'explicit',
    tags: ['expansion'],
    source: {
      kind: 'expansion',
      expansionId: 'assteroid_belt',
      expansionName: 'Assteroid Belt',
      expansionEnabled: false,
    },
    loaded: false,
  }),
  gallerySpeciesFixture({
    slug: 'chrome_corsair',
    name: 'Chrome Corsair',
    rarity: 'R',
    race: 'valkyrie',
    affinity: 'submissive',
    contentRating: 'mature',
    tags: ['expansion'],
    source: {
      kind: 'expansion',
      expansionId: 'assteroid_belt',
      expansionName: 'Assteroid Belt',
      expansionEnabled: false,
    },
    loaded: false,
    looks: { standard: { status: 'unsafe' } },
  }),
];

function gallerySummaryOf(species: readonly GallerySpeciesDetailFixture[]) {
  const loaded = species.filter((s) => s.runtime.loaded);
  const issueCounts: Record<string, number> = {};
  for (const s of species)
    for (const i of s.issues) issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;
  return {
    authoredSpecies: species.length,
    runtimeLoadedSpecies: loaded.length,
    runtimeEnabledSpecies: loaded.filter((s) => s.runtime.enabled).length,
    loaderDisabledSpecies: species.filter((s) => s.runtime.disabledByLoader).length,
    unloadedSpecies: species.length - loaded.length,
    authoredAppearances: species.reduce((n, s) => n + s.appearanceCounts.authored, 0),
    runtimeAppearances: loaded.reduce((n, s) => n + (s.appearanceCounts.inRuntime ?? 0), 0),
    artworkAvailableAppearances: species.reduce(
      (n, s) => n + s.appearanceCounts.artworkAvailable,
      0,
    ),
    speciesWithIssues: species.filter((s) => s.issues.length > 0).length,
    issueCounts,
  };
}

/** The list response: summaries only, sorted by name like the server. */
export const adminGalleryCatalog = {
  summary: gallerySummaryOf(adminGalleryDetails),
  species: [...adminGalleryDetails]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      ({
        description: _d,
        card: _c,
        buddyBonus: _b,
        baseCaptureRate: _r,
        eventKey: _e,
        perSpeciesWeight: _w,
        appearances: _a,
        loaderDiagnostics: _l,
        ...summary
      }) => summary,
    ),
};

// ── Expeditions ──────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/**
 * Two open missions — one underway in the current region, one finished and
 * waiting in Discord — and three reachable regions: the occupied current one,
 * a free one with a board, and one with no Expedition content at all.
 * Times are relative to load so countdowns always have something to count.
 */
export const expeditionOverview: ExpeditionOverview = {
  enabled: true,
  currentRegion: 'twin-peeks',
  rotatesAt: iso(3 * HOUR_MS + 30 * 60 * 1000),
  active: [
    {
      region: 'twin-peeks',
      regionName: 'Twin Peeks',
      name: 'Summit Relay',
      emoji: '⛰️',
      description: 'Carry the mail over the pass.',
      type: 'supply_run',
      durationMinutes: 360,
      recommendedLevel: 12,
      rewardPreview: ['waifubux', 'salvage'],
      match: 'STRONG_MATCH',
      status: 'active',
      isDue: false,
      readyToClaim: false,
      startedAt: iso(-4 * HOUR_MS),
      completesAt: iso(2 * HOUR_MS + 14 * 60 * 1000 + 30 * 1000),
      secondsRemaining: 2 * 3600 + 14 * 60 + 30,
      waifuName: ownedEntries[0]!.waifu.nickname ?? 'Nyx',
      waifu: { waifu: ownedEntries[0]!.waifu, species: ownedEntries[0]!.species },
    },
    {
      region: 'waifu-valley',
      regionName: 'Waifu Valley',
      name: 'Orchard Watch',
      emoji: '🍑',
      description: 'Keep the pickers company.',
      type: 'escort',
      durationMinutes: 60,
      recommendedLevel: 3,
      rewardPreview: ['essence'],
      match: 'PERFECT_MATCH',
      status: 'active',
      isDue: true,
      readyToClaim: true,
      startedAt: iso(-2 * HOUR_MS),
      completesAt: iso(-HOUR_MS),
      secondsRemaining: 0,
      waifuName: 'Lilith',
      waifu: { waifu: ownedEntries[1]!.waifu, species: ownedEntries[1]!.species },
    },
  ],
  regions: [
    {
      regionId: 'twin-peeks',
      name: 'Twin Peeks',
      emoji: '🏔️',
      isCurrent: true,
      occupied: true,
      offers: [
        {
          name: 'Ridge Survey',
          emoji: '🧭',
          description: 'Map the northern ridge.',
          type: 'scouting',
          durationMinutes: 60,
          recommendedLevel: 8,
          preferredAffinities: ['dominant'],
          preferredRaces: ['demi-human'],
          rewardPreview: ['waifubux'],
        },
      ],
    },
    {
      regionId: 'thirstlands',
      name: 'Thirstlands',
      emoji: '🏜️',
      isCurrent: false,
      occupied: false,
      offers: [
        {
          name: 'Dune Salvage',
          emoji: '📦',
          description: 'Dig out what the storm buried.',
          type: 'salvage_dive',
          durationMinutes: 180,
          recommendedLevel: 15,
          preferredAffinities: [],
          preferredRaces: ['android'],
          rewardPreview: ['salvage', 'rare_find'],
        },
        {
          name: 'Oasis Escort',
          emoji: '🐫',
          description: '',
          type: 'escort',
          durationMinutes: 1080,
          recommendedLevel: 18,
          preferredAffinities: ['caregiver', 'switch'],
          preferredRaces: [],
          rewardPreview: [],
        },
      ],
    },
    {
      regionId: 'base-80085',
      name: 'Base 80085',
      emoji: null,
      isCurrent: false,
      occupied: false,
      offers: [],
    },
  ],
};
