/**
 * Phase 2 read routes — handler shape, driven with `inject()` against service
 * doubles. No database, no network.
 *
 * These tests own the parts of the contract that do not need real data:
 * authorization on every route, the response envelope, request validation,
 * 404 mapping, and the fact that each route calls the service it claims to.
 * Real data flows through `tests/integration/api/readEndpoints.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import type { LoadedContent } from '../../../src/modules/content/schemas';
import { WaifuNotOwnedError } from '../../../src/shared/errors';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
  type ApiContextOverrides,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

const PLAYER = {
  id: 7,
  guildId: 3,
  discordUserId: '1234567890',
  xp: 120,
  level: 4,
  buddyWaifuId: null,
  showcase: null,
  lastHuntAt: new Date('2026-08-05T10:00:00.000Z'),
  careModeStartedAt: null,
  careModeLastTickAt: null,
  careModeWaifuId: null,
  currentRegion: 'waifu-valley',
  settings: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const SPECIES = {
  id: 11,
  slug: 'alley_catgirl',
  name: 'Alley Catgirl',
  rarity: 'R',
  archetype: 'feline',
  baseCaptureRate: 0.4,
  description: 'Streetwise.',
  tags: ['cat'],
  contentRating: 'suggestive',
  affinity: 'switch',
  imagePath: 'waifumon/alley_catgirl/standard.png',
  enabled: true,
  eventKey: null,
  perSpeciesWeight: 1,
};

const ITEM = {
  id: 21,
  slug: 'basic_charm',
  name: 'Basic Charm',
  category: 'capture',
  captureModifier: 0.1,
  captureBonus: null,
  captureRarities: null,
  isGuaranteedCapture: false,
  shopRegions: ['waifu-valley'],
  buyPrice: 50,
  priceCurrency: 'waifubux',
  dailyStockLimit: null,
  effectType: null,
  effectConfig: null,
  description: 'A charm.',
  emoji: '✨',
  enabled: true,
};

const WAIFU = {
  id: 31,
  playerId: 7,
  speciesId: 11,
  level: 2,
  xp: 40,
  affection: 5,
  nickname: null,
  isFavorite: false,
  variant: 'standard',
  cosmetics: [],
  seenAppearances: ['standard'],
  giftRollCounter: 0,
  baseSp: 96,
  caughtAt: new Date('2026-02-02T00:00:00.000Z'),
  releasedAt: null,
};

/**
 * The appearance service is a pure content lookup on these routes — no DB, no
 * I/O — so a small hand-rolled double keeps the route contract test focused on
 * shapes rather than on wiring a real content snapshot.
 */
const STANDARD_APPEARANCE = {
  id: 'standard',
  name: 'Standard',
  description: null,
  flavorText: null,
  cosmeticRarity: 'standard' as const,
  introducedVersion: null,
  contentRating: 'suggestive' as const,
  sortOrder: 0,
  tags: [],
  assetId: { kind: 'waifumon' as const, slug: 'alley_catgirl', variant: 'standard' },
  unlock: { type: 'owned' as const },
  unlockLabel: 'Owned',
};

const appearanceStub = {
  catalogFor: () => [STANDARD_APPEARANCE],
  currentAppearance: () => STANDARD_APPEARANCE,
  speciesContent: () => null,
};

const PROGRESS = { level: 2, xp: 40, xpIntoLevel: 10, xpToNext: 30, atMaxLevel: false };

/** Services every player-scoped route needs before its own double matters. */
const basePlayerStubs = {
  players: { getById: async () => PLAYER },
  appearance: appearanceStub,
};

let app: ZodFastify;

async function build(overrides: ApiContextOverrides = {}): Promise<ZodFastify> {
  return createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: createApiContext(overrides),
  });
}

afterEach(async () => {
  await app?.close();
});

// ── Authorization + envelope, swept across the whole surface ────────────────

/** Every Phase 2 route, with a context that satisfies its happy path. */
const ROUTES: Array<{ url: string; overrides: ApiContextOverrides }> = [
  {
    url: '/api/v1/players/lookup?discordGuildId=1&discordUserId=2',
    overrides: { services: { players: { findPlayerId: async () => 7 } } },
  },
  { url: '/api/v1/players/7', overrides: { services: basePlayerStubs } },
  {
    url: '/api/v1/players/7/profile',
    overrides: {
      services: {
        ...basePlayerStubs,
        currency: {
          getBalances: async () => ({
            playerId: 7,
            huntEnergy: 20,
            waifubux: 300,
            essence: 12,
            updatedAt: new Date(),
          }),
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/collection/stats',
    overrides: {
      services: {
        ...basePlayerStubs,
        collection: { getDexStats: async () => ({ owned: 3, distinctSpecies: 2, totalSpecies: 49 }) },
      },
    },
  },
  {
    url: '/api/v1/players/7/collection/owned',
    overrides: {
      services: {
        ...basePlayerStubs,
        collection: {
          listOwned: async () => ({
            entries: [{ waifu: WAIFU, species: SPECIES }],
            page: 1,
            pageSize: 10,
            totalOwned: 1,
            totalPages: 1,
          }),
          waifuProgress: () => PROGRESS,
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/collection/owned/31',
    overrides: {
      services: {
        ...basePlayerStubs,
        collection: {
          getOwned: async () => ({ waifu: WAIFU, species: SPECIES }),
          waifuProgress: () => PROGRESS,
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/collection/buddy',
    overrides: {
      services: {
        ...basePlayerStubs,
        collection: {
          getBuddy: async () => ({ waifu: WAIFU, species: SPECIES }),
          waifuProgress: () => PROGRESS,
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/currency',
    overrides: {
      services: {
        ...basePlayerStubs,
        currency: {
          getBalances: async () => ({
            playerId: 7,
            huntEnergy: 20,
            waifubux: 300,
            essence: 12,
            updatedAt: new Date(),
          }),
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/inventory',
    overrides: {
      services: {
        ...basePlayerStubs,
        inventory: { getInventory: async () => [{ item: ITEM, quantity: 4 }] },
      },
    },
  },
  {
    url: '/api/v1/players/7/effects/capture-bonus',
    overrides: {
      services: { ...basePlayerStubs, effects: { getCaptureBonus: async () => null } },
    },
  },
  {
    url: '/api/v1/players/7/care',
    overrides: {
      services: {
        ...basePlayerStubs,
        care: {
          getState: async () => ({
            enabled: true,
            active: false,
            startedAt: null,
            lastTickAt: null,
            nextTickAt: null,
            target: null,
            pendingTicks: 0,
            intervalMinutes: 15,
            energyPerTick: 1,
            waifuXpPerTick: 2,
            affectionPerTick: 1,
            recoveryCap: 20,
            effectiveEnergyCap: 25,
            currentEnergy: 20,
            maxEnergy: 25,
          }),
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/encounter',
    overrides: {
      services: {
        ...basePlayerStubs,
        hunt: {
          getActiveEncounterDetail: async () => ({
            encounter: {
              id: 41,
              playerId: 7,
              speciesId: 11,
              channelId: '999',
              state: 'active',
              attemptCount: 0,
              maxAttempts: 3,
              selectedItemId: null,
              regionId: 'waifu-valley',
              originKind: null,
              originRef: null,
              createdAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              resolvedAt: null,
            },
            species: SPECIES,
          }),
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/daily',
    overrides: {
      services: {
        ...basePlayerStubs,
        daily: { status: async () => ({ claimedToday: false, nextResetAt: new Date() }) },
      },
    },
  },
  {
    url: '/api/v1/players/7/quests/daily',
    overrides: {
      services: {
        ...basePlayerStubs,
        quests: {
          getDailyQuests: async () => [],
          hasClaimedAllCompleteBonus: async () => false,
        },
      },
    },
  },
  {
    url: '/api/v1/players/7/sessions/999',
    overrides: {
      services: {
        ...basePlayerStubs,
        session: {
          findByPlayerAndChannel: async () => ({
            id: 51,
            guildId: 3,
            playerId: 7,
            channelId: '999',
            profileMessageId: null,
            summaryJson: {},
            summaryDate: '2026-08-05',
            createdAt: new Date(),
            updatedAt: new Date(),
            lastActivityAt: new Date(),
          }),
          readSummary: () => ({
            hunts: 1,
            caught: 0,
            escaped: 0,
            srPlus: 0,
            levelUps: 0,
            caughtNames: [],
            escapedNames: [],
            notableFinds: [],
            buddyXp: 0,
            buddyAffection: 0,
          }),
          isSummaryFresh: () => true,
        },
      },
    },
  },
  { url: '/api/v1/shop/catalog', overrides: { services: { shop: { getCatalog: async () => [] } } } },
  { url: '/api/v1/content/species', overrides: {} },
  { url: '/api/v1/content/items', overrides: {} },
  { url: '/api/v1/content/tables', overrides: {} },
  { url: '/api/v1/content/quests', overrides: {} },
  {
    url: '/api/v1/guilds/1234',
    overrides: {
      services: {
        guilds: {
          getByDiscordId: async () => ({
            id: 3,
            discordGuildId: '1234',
            announceChannelId: null,
            bossChannelId: null,
            hereThresholdRarity: 'UR',
            allowedChannelIds: null,
            settings: {},
            createdAt: new Date(),
          }),
        },
      },
    },
  },
];

const CONTENT: Partial<LoadedContent> = {
  species: [SPECIES],
  items: [ITEM],
  tables: {
    energy: { baseMax: 25 },
    dailyQuests: { enabled: true, questsPerDay: 3, pool: [] },
  },
} as unknown as Partial<LoadedContent>;

describe('every read route', () => {
  it.each(ROUTES.map((r) => r.url))('requires a bearer token: %s', async (url) => {
    const route = ROUTES.find((r) => r.url === url)!;
    app = await build({ ...route.overrides, content: CONTENT });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it.each(ROUTES.map((r) => r.url))('answers 200 in the standard envelope: %s', async (url) => {
    const route = ROUTES.find((r) => r.url === url)!;
    app = await build({ ...route.overrides, content: CONTENT });
    const res = await app.inject({ method: 'GET', url, headers: AUTH });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('data');
    // meta.requestId is populated in v1 and mirrors the response header.
    expect(body.meta.requestId).toBe(res.headers['x-request-id']);
    expect(res.headers['x-waifumon-api-version']).toBe('1');
  });

  it.each(ROUTES.map((r) => r.url))('rejects a write to a read-only route: %s', async (url) => {
    const route = ROUTES.find((r) => r.url === url)!;
    app = await build({ ...route.overrides, content: CONTENT });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: '{}',
    });
    // Phase 2 registers no mutations at all, so every one of these is a 404.
    expect(res.statusCode).toBe(404);
  });
});

// ── Unknown resources ───────────────────────────────────────────────────────

describe('missing resources', () => {
  it('404s an unknown player before the route runs', async () => {
    app = await build({ services: { players: { getById: async () => undefined } } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/players/999/currency', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLAYER_NOT_FOUND');
    // The currency service was never reached — the double would have thrown.
  });

  it('404s a lookup that has never played, without provisioning', async () => {
    app = await build({ services: { players: { findPlayerId: async () => null } } });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/lookup?discordGuildId=1&discordUserId=2',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLAYER_NOT_FOUND');
  });

  it('404s when no buddy is set', async () => {
    app = await build({
      services: { ...basePlayerStubs, collection: { getBuddy: async () => null } },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/buddy',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BUDDY_NOT_SET');
  });

  it('404s when there is no active encounter', async () => {
    app = await build({
      services: { ...basePlayerStubs, hunt: { getActiveEncounterDetail: async () => null } },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/players/7/encounter', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ENCOUNTER_NOT_FOUND');
  });

  it('404s a channel the player has never used', async () => {
    app = await build({
      services: { ...basePlayerStubs, session: { findByPlayerAndChannel: async () => null } },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/sessions/999',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SESSION_NOT_FOUND');
  });

  it('404s an unknown guild without provisioning one', async () => {
    app = await build({ services: { guilds: { getByDiscordId: async () => undefined } } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/guilds/404404', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('GUILD_NOT_FOUND');
  });

  it('404s unknown content slugs and table keys', async () => {
    app = await build({ content: CONTENT });
    for (const [url, code] of [
      ['/api/v1/content/species/nobody', 'SPECIES_NOT_FOUND'],
      ['/api/v1/content/items/nothing', 'ITEM_NOT_FOUND'],
      ['/api/v1/content/tables/nosuchtable', 'TABLE_NOT_FOUND'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe(code);
    }
  });

  it('maps the service\'s own WAIFU_NOT_OWNED to 404', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        collection: {
          getOwned: async () => {
            throw new WaifuNotOwnedError(31);
          },
        },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned/31',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({
      code: 'WAIFU_NOT_OWNED',
      message: "That Waifumon isn't in your collection~",
    });
  });
});

// ── Invalid requests ────────────────────────────────────────────────────────

describe('request validation', () => {
  beforeEach(async () => {
    app = await build({ services: basePlayerStubs, content: CONTENT });
  });

  it.each([
    ['/api/v1/players/abc/currency', 'non-numeric player id'],
    ['/api/v1/players/0/currency', 'zero player id'],
    ['/api/v1/players/-3/currency', 'negative player id'],
    ['/api/v1/players/7/collection/owned/abc', 'non-numeric waifu id'],
    ['/api/v1/players/7/collection/owned?page=0', 'page below 1'],
    ['/api/v1/players/7/collection/owned?pageSize=100', 'pageSize above the service cap'],
    ['/api/v1/players/7/collection/owned?rarity=ZZ', 'unknown rarity'],
    ['/api/v1/content/species?rarity=ZZ', 'unknown rarity filter'],
    ['/api/v1/content/items?category=nope', 'unknown category filter'],
    ['/api/v1/guilds/not-a-snowflake', 'non-numeric guild id'],
    ['/api/v1/players/lookup?discordGuildId=1', 'missing discordUserId'],
  ])('400s %s (%s)', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // Field paths are reported; submitted values never are.
    expect(Array.isArray(res.json().error.details.issues)).toBe(true);
  });

  it('accepts pageSize at the documented ceiling of 25', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        collection: {
          listOwned: async () => ({
            entries: [],
            page: 1,
            pageSize: 25,
            totalOwned: 0,
            totalPages: 1,
          }),
          waifuProgress: () => PROGRESS,
        },
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned?pageSize=25',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pageSize).toBe(25);
  });
});

// ── Background card warming ─────────────────────────────────────────────────

/**
 * The collection listing is the trigger for the self-healing owned-card warm.
 * Two properties matter, and both are easy to break by "just awaiting it":
 * the response must not wait, and the trigger must not exist at all in a
 * deployment without a renderer.
 */
describe('owned card warming behind the collection listing', () => {
  const listStubs = {
    ...basePlayerStubs,
    collection: {
      listOwned: async () => ({
        entries: [{ waifu: WAIFU, species: SPECIES }],
        page: 1,
        pageSize: 25,
        totalOwned: 1,
        totalPages: 1,
      }),
      waifuProgress: () => PROGRESS,
    },
  };

  /** Records the calls and stays pending, like a warm that has not finished. */
  function recordingWarmer() {
    const calls: number[] = [];
    return {
      calls,
      warmer: {
        schedulePlayerWarm: (playerId: number) => {
          calls.push(playerId);
          return 'started' as const;
        },
      },
    };
  }

  it('schedules a warm for the listed player', async () => {
    const { calls, warmer } = recordingWarmer();
    app = await build({ services: listStubs, cardWarmer: warmer });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([7]);
  });

  /**
   * A warm that never settles must not hold the response open. If the route
   * ever awaited it, this test would time out rather than fail — which is
   * exactly the failure mode worth having a test for.
   */
  it('answers without waiting for the warm to finish', async () => {
    const warmer = {
      schedulePlayerWarm: () => {
        // Detached work that outlives the request, and never settles.
        void new Promise(() => {});
        return 'started' as const;
      },
    };
    app = await build({ services: listStubs, cardWarmer: warmer });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('does not schedule anything when no warmer is wired', async () => {
    app = await build({ services: listStubs });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned',
      headers: AUTH,
    });

    // No warmer, no warm, no error — the route behaves exactly as it did
    // before warming existed.
    expect(res.statusCode).toBe(200);
  });
});

// ── Payload shape ───────────────────────────────────────────────────────────

describe('response payloads', () => {
  it('nests the player\'s care summary and encodes timestamps as ISO 8601', async () => {
    app = await build({ services: basePlayerStubs });
    const res = await app.inject({ method: 'GET', url: '/api/v1/players/7', headers: AUTH });
    expect(res.json().data).toMatchObject({
      id: 7,
      discordUserId: '1234567890',
      careMode: { active: false, waifuId: null, startedAt: null },
      lastHuntAt: '2026-08-05T10:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reports identity: null when no resolver is wired', async () => {
    app = await build({ services: basePlayerStubs });
    const res = await app.inject({ method: 'GET', url: '/api/v1/players/7', headers: AUTH });
    // A process without a Discord client still answers every other field.
    expect(res.json().data.identity).toBeNull();
  });

  it('carries the display name and avatar when a resolver is wired', async () => {
    app = await build({
      services: basePlayerStubs,
      resolveIdentity: async (discordUserId) => ({
        displayName: `user-${discordUserId}`,
        avatarUrl: 'https://cdn.discordapp.com/avatars/1234567890/abc.png',
      }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/players/7', headers: AUTH });
    expect(res.json().data.identity).toEqual({
      displayName: 'user-1234567890',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1234567890/abc.png',
    });
  });

  it('embeds identity in the composite profile too', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        currency: {
          getBalances: async () => ({
            playerId: 7,
            huntEnergy: 10,
            waifubux: 100,
            essence: 5,
            updatedAt: new Date('2026-08-05T10:00:00.000Z'),
          }),
        },
      },
      resolveIdentity: async () => ({ displayName: 'Alice', avatarUrl: null }),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/profile',
      headers: AUTH,
    });
    expect(res.json().data.player.identity).toEqual({ displayName: 'Alice', avatarUrl: null });
  });

  it('drops columns the schema does not declare', async () => {
    app = await build({ services: basePlayerStubs });
    const body = (await app.inject({ method: 'GET', url: '/api/v1/players/7', headers: AUTH })).json();
    // `settings` and `showcase` are internal and must not reach the wire.
    expect(body.data).not.toHaveProperty('settings');
    expect(body.data).not.toHaveProperty('showcase');
    expect(body.data).not.toHaveProperty('careModeStartedAt');
  });

  it('reports pagination beside data, using the values the service settled on', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        collection: {
          // The service clamps an out-of-range page; the client sees where it landed.
          listOwned: async () => ({
            entries: [{ waifu: WAIFU, species: SPECIES }],
            page: 2,
            pageSize: 10,
            totalOwned: 14,
            totalPages: 2,
          }),
          waifuProgress: () => PROGRESS,
        },
      },
    });
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/players/7/collection/owned?page=99',
        headers: AUTH,
      })
    ).json();
    expect(body).toMatchObject({ page: 2, pageSize: 10, total: 14 });
    expect(body.data).toHaveLength(1);
    expect(body.data[0].progress).toEqual(PROGRESS);
  });

  it('returns data:null rather than 404 when no capture buff is active', async () => {
    app = await build({
      services: { ...basePlayerStubs, effects: { getCaptureBonus: async () => null } },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/players/7/effects/capture-bonus',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });

  it('reads quest snapshots off the row and reports a null questDate when none exist', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        quests: { getDailyQuests: async () => [], hasClaimedAllCompleteBonus: async () => false },
      },
    });
    const body = (
      await app.inject({ method: 'GET', url: '/api/v1/players/7/quests/daily', headers: AUTH })
    ).json();
    expect(body.data).toEqual({ questDate: null, quests: [], allCompleteBonusClaimed: false });
  });

  it('filters content in memory without touching any service', async () => {
    app = await build({ content: CONTENT });
    const all = (
      await app.inject({ method: 'GET', url: '/api/v1/content/species', headers: AUTH })
    ).json();
    expect(all.data).toHaveLength(1);

    const filtered = (
      await app.inject({ method: 'GET', url: '/api/v1/content/species?rarity=EX', headers: AUTH })
    ).json();
    expect(filtered.data).toEqual([]);
  });

  it('serves content without internal ids, and gameplay resources with them', async () => {
    app = await build({
      services: {
        ...basePlayerStubs,
        inventory: { getInventory: async () => [{ item: ITEM, quantity: 4 }] },
      },
      content: CONTENT,
    });
    const content = (
      await app.inject({ method: 'GET', url: '/api/v1/content/items/basic_charm', headers: AUTH })
    ).json();
    expect(content.data).not.toHaveProperty('id');
    expect(content.data.slug).toBe('basic_charm');

    const inventory = (
      await app.inject({ method: 'GET', url: '/api/v1/players/7/inventory', headers: AUTH })
    ).json();
    expect(inventory.data[0].item.id).toBe(21);
  });

  it('returns a single tuning table by key', async () => {
    app = await build({ content: CONTENT });
    const body = (
      await app.inject({ method: 'GET', url: '/api/v1/content/tables/energy', headers: AUTH })
    ).json();
    expect(body.data).toEqual({ baseMax: 25 });
  });
});

// ── OpenAPI registration ────────────────────────────────────────────────────

describe('OpenAPI registration', () => {
  beforeEach(async () => {
    app = await build({ content: CONTENT });
  });

  it('documents every Phase 2 route', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    const documented = Object.keys(spec.paths);
    for (const expected of [
      '/api/v1/players/lookup',
      '/api/v1/players/{playerId}',
      '/api/v1/players/{playerId}/profile',
      '/api/v1/players/{playerId}/collection/stats',
      '/api/v1/players/{playerId}/collection/owned',
      '/api/v1/players/{playerId}/collection/owned/{waifuId}',
      '/api/v1/players/{playerId}/collection/buddy',
      '/api/v1/players/{playerId}/currency',
      '/api/v1/players/{playerId}/inventory',
      '/api/v1/players/{playerId}/effects/capture-bonus',
      '/api/v1/players/{playerId}/care',
      '/api/v1/players/{playerId}/encounter',
      '/api/v1/players/{playerId}/daily',
      '/api/v1/players/{playerId}/quests/daily',
      '/api/v1/players/{playerId}/sessions/{channelId}',
      '/api/v1/shop/catalog',
      '/api/v1/content/species',
      '/api/v1/content/species/{slug}',
      '/api/v1/content/items',
      '/api/v1/content/items/{slug}',
      '/api/v1/content/tables',
      '/api/v1/content/tables/{key}',
      '/api/v1/content/quests',
      '/api/v1/guilds/{discordGuildId}',
      '/api/v1/guilds/{discordGuildId}/channels',
    ]) {
      expect(documented, expected).toContain(expected);
    }
  });

  /**
   * v1 is read-only for **gameplay**. The single documented exception is
   * choosing a Waifumon's appearance, which is cosmetic by construction: the
   * handler writes `player_waifus.variant` and nothing else (proved by the
   * row-diff test in the collection integration suite).
   *
   * Pinned as an explicit allowlist rather than relaxed to "any mutation",
   * so adding a second write verb is a deliberate, reviewable edit here.
   */
  it('registers no mutation verbs in v1 beyond the cosmetic appearance write', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    const mutations: string[] = [];
    for (const [path, item] of Object.entries(spec.paths) as Array<
      [string, Record<string, unknown>]
    >) {
      for (const verb of Object.keys(item)) {
        if (verb !== 'get') mutations.push(`${verb.toUpperCase()} ${path}`);
      }
    }
    // Phase 2 also introduces the World Encounter admin namespace — those
    // routes carry a distinct `Admin — Encounters` tag and are permission-
    // gated at the request layer (`requirePortalPermission`), never
    // reachable by an ordinary player-scoped session.
    expect(mutations.sort()).toEqual([
      'DELETE /api/v1/admin/encounters/{id}',
      'PATCH /api/v1/admin/encounters/{id}/lifecycle',
      'POST /api/v1/admin/encounters',
      'POST /api/v1/admin/encounters/{id}/clone',
      'POST /api/v1/admin/encounters/{id}/preview',
      'POST /api/v1/admin/encounters/{id}/simulate',
      // Global runtime tuning. Gated on `encounters.publish` rather than
      // `.write`: it changes the live game for every player at once.
      'PUT /api/v1/admin/encounters/settings',
      'PUT /api/v1/admin/encounters/{id}',
      'PUT /api/v1/players/{playerId}/collection/owned/{waifuId}/appearance',
    ]);
  });

  it('gives every operation a summary, a tag and the shared error responses', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    for (const [path, item] of Object.entries(spec.paths) as Array<
      [string, Record<string, { summary?: string; tags?: string[]; responses: object }>]
    >) {
      for (const [verb, op] of Object.entries(item)) {
        expect(op.summary, `${verb} ${path}`).toBeTruthy();
        expect(op.tags?.length, `${verb} ${path}`).toBeGreaterThan(0);
        // /health and /ready are unauthenticated ops targets outside the
        // versioned contract — they cannot 401 and take no input to reject.
        if (!path.startsWith('/api/v1/')) continue;
        for (const status of ['400', '401', '500']) {
          expect(Object.keys(op.responses), `${verb} ${path} ${status}`).toContain(status);
        }
      }
    }
  });

  it('describes the reserved meta slot on success responses', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    const schema =
      spec.paths['/api/v1/players/{playerId}/currency'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['data', 'meta']));
    expect(schema.required).toEqual(['data']);
  });

  it('reserves /api/v1/system — nothing is registered under it', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(spec.paths).filter((p) => p.startsWith('/api/v1/system'))).toEqual([]);

    const res = await app.inject({ method: 'GET', url: '/api/v1/system/version', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
