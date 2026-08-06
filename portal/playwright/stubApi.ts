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

const species = (
  id: number,
  slug: string,
  name: string,
  rarity: string,
  archetype: string,
  affinity: string,
) => ({
  id,
  slug,
  name,
  rarity,
  archetype,
  affinity,
  contentRating: 'suggestive',
  description: `${name} is a placeholder entry used by the end-to-end suite.`,
  tags: ['e2e'],
  baseCaptureRate: null,
  imagePath: `waifumon/${slug}/standard.png`,
  enabled: true,
  eventKey: null,
  perSpeciesWeight: 1,
});

const SPECIES = [
  species(11, 'neko_barista', 'Neko Barista', 'N', 'demi-human', 'submissive'),
  species(12, 'neon_kitsune', 'Neon Kitsune', 'SR', 'spirit', 'submissive'),
  species(13, 'void_empress', 'Void Empress', 'UR', 'demon', 'primal'),
];

const owned = (id: number, speciesIndex: number, level: number, nickname: string | null) => ({
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
    caughtAt: '2026-07-02T18:30:00.000Z',
    releasedAt: null,
  },
  species: SPECIES[speciesIndex]!,
  progress: { level, xp: level * 100, xpIntoLevel: 40, xpToNext: 60, atMaxLevel: false },
});

const OWNED = [owned(101, 2, 22, 'Nyx'), owned(102, 1, 9, null), owned(103, 0, 3, null)];

const ITEMS = [
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
          waifubux: 1820,
          essence: 46,
          updatedAt: '2026-08-06T09:14:00.000Z',
        },
      }),
  ],
  [
    /\/api\/v1\/players\/\d+\/collection\/stats$/,
    () => envelope({ owned: 3, distinctSpecies: 3, totalSpecies: 50 }),
  ],
  [/\/api\/v1\/players\/\d+\/collection\/buddy$/, () => envelope(OWNED[0])],
  [/\/api\/v1\/players\/\d+\/collection\/owned\/\d+$/, () => envelope(OWNED[0])],
  [/\/api\/v1\/players\/\d+\/collection\/owned/, () => paginated(OWNED)],
  [/\/api\/v1\/players\/\d+\/inventory$/, () => envelope([{ item: ITEMS[0], quantity: 12 }])],
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
      }),
  ],
  [/\/api\/v1\/players\/\d+$/, () => envelope(PLAYER)],
  [
    /\/api\/v1\/shop\/catalog$/,
    () =>
      envelope([{ item: ITEMS[0], available: true, availabilityNote: null, currency: 'waifubux' }]),
  ],
  [/\/api\/v1\/content\/species\/[a-z0-9_]+$/, () => envelope(SPECIES[2])],
  [/\/api\/v1\/content\/species/, () => envelope(SPECIES)],
  [/\/api\/v1\/content\/items/, () => envelope(ITEMS)],
  [/\/api\/v1\/content\/tables$/, () => envelope(TABLES)],
];

const PLAYER = {
  id: 1,
  guildId: 7,
  identity: { displayName: 'Mika', avatarUrl: null },
  discordUserId: '123456789012345678',
  level: 12,
  xp: 3480,
  buddyWaifuId: 101,
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

/** Installs the stubs. Call before the first navigation. */
export async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', respond);
  await page.route('**/dev-assets/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG }),
  );
}
