/**
 * Browser-side Platform API stubs for the Playwright suite.
 *
 * Mirrors the Vitest/MSW fixtures, but installed through `page.route` so the
 * built bundle is exercised end to end without a bot, a database or a Discord
 * client. Response shapes are the API's real envelopes.
 *
 * Artwork is stubbed too: a 1×1 PNG stands in for the real files, which are
 * multi-megabyte and would make the suite slow and flaky for no coverage gain.
 */
import type { Page, Route } from '@playwright/test';

import type {
  Affinity,
  AppearanceCatalogEntry,
  AppearanceGallery,
  CareState,
  CurrencyBalances,
  DexStats,
  InventoryEntry,
  Item,
  OwnedEntry,
  Player,
  Race,
  Rarity,
  ShopCatalogEntry,
  Species,
} from '@/api/types';
import type { PortalSessionPayload } from '@/auth/types';

/** A transparent 1×1 PNG — enough for the `<img>` load path to complete. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function envelope(data: unknown) {
  return JSON.stringify({ data, meta: { requestId: 'e2e' } });
}

function paginated(items: unknown[], total = items.length) {
  return JSON.stringify({ data: items, page: 1, pageSize: 25, total, meta: { requestId: 'e2e' } });
}

/** The implicit `standard` look every species carries (see `msw/fixtures.ts`). */
const standardAppearance = (slug: string): AppearanceCatalogEntry => ({
  id: 'standard',
  name: 'Standard',
  description: null,
  flavorText: null,
  cosmeticRarity: 'standard',
  introducedVersion: null,
  assetId: { kind: 'waifumon', slug, variant: 'standard' },
  unlock: { type: 'owned' },
  unlockLabel: 'Owned',
});

// Typed against the Portal's API types so the stubs cannot silently drift from
// the contract the pages render — a missing field is a typecheck error here,
// not a crash in the browser.
const species = (
  id: number,
  slug: string,
  name: string,
  rarity: Rarity,
  race: Race,
  affinity: Affinity,
): Species => ({
  id,
  slug,
  name,
  rarity,
  archetype: race,
  race,
  affinity,
  contentRating: 'suggestive',
  description: `${name} is a placeholder entry used by the end-to-end suite.`,
  tags: ['e2e'],
  baseCaptureRate: null,
  enabled: true,
  eventKey: null,
  perSpeciesWeight: 1,
  appearances: [standardAppearance(slug)],
});

const SPECIES = [
  species(11, 'neko_barista', 'Neko Barista', 'N', 'demi-human', 'submissive'),
  species(12, 'neon_kitsune', 'Neon Kitsune', 'SR', 'spirit', 'submissive'),
  species(13, 'void_empress', 'Void Empress', 'UR', 'demon', 'primal'),
];

const owned = (
  id: number,
  speciesIndex: number,
  level: number,
  nickname: string | null,
): OwnedEntry => ({
  waifu: {
    id,
    playerId: 1,
    speciesId: SPECIES[speciesIndex]!.id,
    level,
    xp: level * 100,
    affection: level * 3,
    nickname,
    isFavorite: id === 101,
    variant: 'standard',
    cosmetics: [],
    selectedAppearance: {
      ...standardAppearance(SPECIES[speciesIndex]!.slug),
      isUnlocked: true,
      isSelected: true,
    },
    caughtAt: '2026-07-02T18:30:00.000Z',
    releasedAt: null,
  },
  species: SPECIES[speciesIndex]!,
  progress: { level, xp: level * 100, xpIntoLevel: 40, xpToNext: 60, atMaxLevel: false },
});

const OWNED = [owned(101, 2, 22, 'Nyx'), owned(102, 1, 9, null), owned(103, 0, 3, null)];

const ITEMS: Item[] = [
  {
    id: 1,
    slug: 'basic_charm',
    name: 'Basic Charm',
    category: 'capture',
    description: 'A simple heart-shaped charm.',
    emoji: '💗',
    enabled: true,
    purchasable: true,
    buyPrice: 25,
    priceCurrency: 'waifubux',
    captureModifier: 1,
    isGuaranteedCapture: false,
    effectType: null,
    effectConfig: null,
    dailyStockLimit: null,
  },
];

const TABLES = {
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
  hunt: { cooldownSeconds: 2, encounterExpirySeconds: 120 },
  capture: { baseRatesByRarity: { N: 0.5, R: 0.35, SR: 0.22, SSR: 0.12, UR: 0.06 } },
  progression: { maxLevel: 50, maxEnergy: { cap: 40 } },
};

/** Routes matched in order; the first hit wins. */
const ROUTES: ReadonlyArray<[RegExp, () => string]> = [
  [
    /\/api\/v1\/players\/\d+\/profile$/,
    () =>
      envelope({
        player: PLAYER,
        currencies: {
          playerId: 1,
          huntEnergy: 22,
          maxHuntEnergy: 25,
          waifubux: 1820,
          essence: 46,
          updatedAt: '2026-08-06T09:14:00.000Z',
        } satisfies CurrencyBalances,
      }),
  ],
  [
    /\/api\/v1\/players\/\d+\/collection\/stats$/,
    () => envelope({ owned: 3, distinctSpecies: 3, totalSpecies: 50 } satisfies DexStats),
  ],
  [/\/api\/v1\/players\/\d+\/collection\/buddy$/, () => envelope(OWNED[0])],
  [/\/api\/v1\/players\/\d+\/collection\/owned\/\d+$/, () => envelope(OWNED[0])],
  // Must precede the unanchored `owned` pattern below, which would otherwise
  // answer this with a page of copies.
  [
    /\/api\/v1\/players\/\d+\/collection\/owned\/\d+\/appearances$/,
    () =>
      envelope({
        appearances: [OWNED[0]!.waifu.selectedAppearance],
        selected: 'standard',
      } satisfies AppearanceGallery),
  ],
  [/\/api\/v1\/players\/\d+\/collection\/owned/, () => paginated(OWNED)],
  [
    /\/api\/v1\/players\/\d+\/inventory$/,
    () => envelope([{ item: ITEMS[0]!, quantity: 12 }] satisfies InventoryEntry[]),
  ],
  [
    /\/api\/v1\/players\/\d+\/care$/,
    () =>
      envelope({
        enabled: true,
        active: false,
        startedAt: null,
        lastTickAt: null,
        nextTickAt: null,
        target: null,
        pendingTicks: 0,
        intervalMinutes: 30,
        energyPerTick: 1,
        waifuXpPerTick: 2,
        affectionPerTick: 1,
        recoveryCap: 20,
        effectiveEnergyCap: 25,
        currentEnergy: 22,
        maxEnergy: 25,
      } satisfies CareState),
  ],
  [/\/api\/v1\/players\/\d+$/, () => envelope(PLAYER)],
  [
    /\/api\/v1\/shop\/catalog$/,
    () =>
      envelope([
        { item: ITEMS[0]!, available: true, availabilityNote: null, currency: 'waifubux' },
      ] satisfies ShopCatalogEntry[]),
  ],
  [/\/api\/v1\/admin\/gallery\/species$/, () => envelope(GALLERY_CATALOG)],
  [/\/api\/v1\/admin\/gallery\/species\/neon_kitsune$/, () => envelope(GALLERY_DETAILS[0])],
  [/\/api\/v1\/admin\/gallery\/species\/star_marshal$/, () => envelope(GALLERY_DETAILS[1])],
  [/\/api\/v1\/content\/species\/[a-z0-9_]+$/, () => envelope(SPECIES[2])],
  [/\/api\/v1\/content\/species/, () => envelope(SPECIES)],
  [/\/api\/v1\/content\/items/, () => envelope(ITEMS)],
  [/\/api\/v1\/content\/tables$/, () => envelope(TABLES)],
];

// ── Admin Waifumon Gallery ─────────────────────────────────────────────────
// One loaded species with complete artwork and one future species whose
// artwork is missing — enough to lay out tiles, badges, QA placeholders and
// the appearance grid at every breakpoint.

const GALLERY_LOOKS = ['standard', 'level_10', 'level_20', 'level_30', 'level_40', 'level_50'];

function galleryLook(slug: string, id: string, i: number, loaded: boolean, missing: boolean) {
  return {
    id,
    name: i === 0 ? 'Standard' : `Level ${i * 10}`,
    description: null,
    flavorText: null,
    cosmeticRarity: 'standard',
    introducedVersion: null,
    contentRating: 'mature',
    contentRatingSource: 'species',
    sortOrder: i * 10,
    tags: [],
    unlock: i === 0 ? { type: 'owned' } : { type: 'level', atLevel: i * 10 },
    unlockLabel: i === 0 ? 'Owned' : `Reach Level ${i * 10}`,
    isDefault: i === 0,
    implicit: false,
    assetId: { kind: 'waifumon', slug, variant: id },
    inRuntime: loaded,
    artwork: missing
      ? { status: 'missing', format: null, storageStem: `waifumon/${slug}/${id}` }
      : {
          status: 'available',
          format: 'webp',
          storageStem: `waifumon/${slug}/${id}`,
          renditions: { 256: true, 512: true, 1024: true },
        },
    loaderDiagnostics: [],
    issues: missing
      ? [
          {
            code: i === 0 ? 'default_artwork_missing' : 'appearance_artwork_missing',
            severity: 'error',
            appearanceId: id,
          },
        ]
      : [],
  };
}

function gallerySpecies(slug: string, name: string, loaded: boolean) {
  const appearances = GALLERY_LOOKS.map((id, i) => galleryLook(slug, id, i, loaded, !loaded));
  return {
    slug,
    name,
    rarity: loaded ? 'SR' : 'LR',
    race: loaded ? 'spirit' : 'android',
    archetype: loaded ? 'spirit' : 'android',
    affinity: 'submissive',
    contentRating: 'mature',
    tags: loaded ? ['waifu_valley'] : ['expansion'],
    source: loaded
      ? { kind: 'core' }
      : {
          kind: 'expansion',
          expansionId: 'assteroid_belt',
          expansionName: 'Assteroid Belt',
          expansionEnabled: false,
        },
    authoredEnabled: true,
    runtime: { loaded, enabled: loaded ? true : null, disabledByLoader: false },
    appearanceCounts: {
      authored: 6,
      inRuntime: loaded ? 6 : null,
      artworkAvailable: loaded ? 6 : 0,
    },
    primary: {
      appearanceId: 'standard',
      assetId: { kind: 'waifumon', slug, variant: 'standard' },
      status: loaded ? 'available' : 'missing',
      format: loaded ? 'webp' : null,
    },
    issues: appearances.flatMap((a) => a.issues),
    description: `${name} is a placeholder entry used by the end-to-end suite.`,
    card: null,
    buddyBonus: null,
    baseCaptureRate: null,
    eventKey: null,
    perSpeciesWeight: 1,
    appearances,
    loaderDiagnostics: [],
  };
}

const GALLERY_DETAILS = [
  gallerySpecies('neon_kitsune', 'Neon Kitsune', true),
  gallerySpecies('star_marshal', 'Star Marshal', false),
];

const GALLERY_CATALOG = {
  summary: {
    authoredSpecies: 2,
    runtimeLoadedSpecies: 1,
    runtimeEnabledSpecies: 1,
    loaderDisabledSpecies: 0,
    unloadedSpecies: 1,
    authoredAppearances: 12,
    runtimeAppearances: 6,
    artworkAvailableAppearances: 6,
    speciesWithIssues: 1,
    issueCounts: { default_artwork_missing: 1, appearance_artwork_missing: 5 },
  },
  species: GALLERY_DETAILS.map(
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

const PLAYER: Player & { identity: NonNullable<Player['identity']> } = {
  id: 1,
  guildId: 7,
  identity: { displayName: 'Mika', avatarUrl: null },
  discordUserId: '123456789012345678',
  level: 12,
  xp: 3480,
  buddyWaifuId: 101,
  progress: { level: 12, totalXp: 3480, xpIntoLevel: 280, xpToNext: 650, atMaxLevel: false },
  currentRegion: { id: 'twin-peeks', name: 'Twin Peeks' },
  lastHuntAt: '2026-08-06T09:14:00.000Z',
  careMode: { active: false, waifuId: null, startedAt: null },
  createdAt: '2026-05-01T12:00:00.000Z',
};

async function respond(route: Route): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  const match = ROUTES.find(([pattern]) => pattern.test(path));

  if (!match) {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'Not found.' },
        requestId: 'e2e',
      }),
    });
    return;
  }

  await route.fulfill({ status: 200, contentType: 'application/json', body: match[1]() });
}

// ── Session ────────────────────────────────────────────────────────────────
// A production bundle authenticates through `OAuthSessionProvider`, which reads
// `GET /auth/session` — at the origin root, not under `/api/v1`, and returned
// bare rather than in the API envelope. Without it the Portal never leaves the
// sign-in screen.

/**
 * Every Portal permission — the server's `ALL_PORTAL_PERMISSIONS`
 * (`src/modules/portalAuth/portalAuthService.ts`), which a Discord guild owner
 * is granted. The Portal has no copy of that list, so it is mirrored here.
 */
export const ALL_PORTAL_PERMISSIONS: readonly string[] = [
  'admin.access',
  'admin.roles.manage',
  'encounters.read',
  'encounters.write',
  'encounters.publish',
  'encounters.simulate',
  'encounters.history',
  'presentations.read',
  'presentations.write',
  'gallery.read',
];

/** Named session profiles a spec can ask for. */
export const SESSION_PROFILES = {
  /** A guild owner: every permission, so every admin screen is reachable. */
  owner: ALL_PORTAL_PERMISSIONS,
  /** An ordinary player: signed in, no admin capability at all. */
  player: [],
} as const satisfies Record<string, readonly string[]>;

export type SessionProfile = keyof typeof SESSION_PROFILES;

const CSRF_COOKIE = 'wm_portal_csrf';
const CSRF_TOKEN = 'e2e-csrf-token';

const GUILD = {
  discordGuildId: '987654321098765432',
  guildDbId: PLAYER.guildId,
  playerId: PLAYER.id,
  name: 'E2E Guild',
  iconUrl: null,
};

/** The payload the API's `toBrowserSession` + permission enrichment produce. */
function sessionPayload(permissions: readonly string[]): PortalSessionPayload {
  return {
    authenticated: true,
    discordUser: {
      id: PLAYER.discordUserId,
      displayName: PLAYER.identity.displayName,
      avatarUrl: PLAYER.identity.avatarUrl,
    },
    selectedGuild: GUILD,
    playerId: PLAYER.id,
    eligibleGuilds: [GUILD],
    needsGuildSelection: false,
    noProfile: false,
    csrfToken: CSRF_TOKEN,
    permissions: [...permissions],
  };
}

export interface StubApiOptions {
  /**
   * Which session `/auth/session` reports: a named profile, or an explicit
   * permission list for a narrower case. Defaults to `owner`.
   */
  session?: SessionProfile | { permissions: readonly string[] };
}

/** Installs the stubs. Call before the first navigation. */
export async function stubApi(page: Page, options: StubApiOptions = {}): Promise<void> {
  const session = options.session ?? 'owner';
  const permissions = typeof session === 'string' ? SESSION_PROFILES[session] : session.permissions;

  await page.route('**/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // The API refreshes the readable CSRF cookie on every session read.
      headers: { 'Set-Cookie': `${CSRF_COOKIE}=${CSRF_TOKEN}; Path=/; SameSite=Lax` },
      body: JSON.stringify(sessionPayload(permissions)),
    }),
  );
  await page.route('**/api/v1/**', respond);
  await page.route('**/dev-assets/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }),
  );
  // Registered after the JSON catch-all, so it wins for admin gallery artwork.
  await page.route('**/api/v1/admin/gallery/species/*/appearances/*/artwork*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }),
  );
}
