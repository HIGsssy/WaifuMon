/**
 * The Platform API surface the redesigned Dashboard reads.
 *
 * Three additions, one rule behind all of them: **the server owns the
 * calculation.** Trainer progression and the Energy ceiling are both published
 * in `tables.json`, so a client *could* derive them — and the moment one does,
 * the game has two definitions of a level. Each is asserted here to come from
 * the same service the rest of the codebase already calls, not from a number
 * this test invented.
 *
 * The fourth addition, `sort=newest`, is asserted at the boundary: that the
 * route hands the option through, that the default is untouched, and that it
 * does not drag the whole-collection card warm along with it. The ordering
 * itself is SQL and belongs to the integration suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { toCurrentRegionResource } from '../../../src/api/resources';
import { DEFAULT_REGION } from '../../../src/modules/locations/regions';
import type { LoadedContent, RegionContent } from '../../../src/modules/content/schemas';
import type { ListOptions } from '../../../src/modules/collection/collectionService';
import {
  createApiContext,
  createCapturedLogger,
  createProbes,
  TEST_TOKEN,
  type ApiContextOverrides,
} from '../../helpers/platformApiFixtures';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * A trainer partway through Level 12.
 *
 * The XP figure is not arbitrary: on the fixture curve (`base 100`,
 * `growth 50`) Level 12 begins at 3,850 lifetime XP, so 4,090 puts her 240 into
 * a 650-XP level — mid-level, where `xpIntoLevel` and `xpToNext` are both
 * non-zero and a percentage actually means something.
 *
 * `level` and `xp` are kept consistent on purpose. `progress.level` is derived
 * from total XP by `progressFor`, exactly as it is everywhere else in the game;
 * the stored column is what `grantXp` keeps in step with it. A fixture where
 * the two disagree would be testing a state the game cannot produce.
 */
const PLAYER = {
  id: 7,
  guildId: 3,
  discordUserId: '1234567890',
  xp: 4_090,
  level: 12,
  buddyWaifuId: null,
  showcase: null,
  lastHuntAt: null,
  careModeStartedAt: null,
  careModeLastTickAt: null,
  careModeWaifuId: null,
  currentRegion: 'twin-peeks',
  settings: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const BALANCES = {
  playerId: 7,
  huntEnergy: 18,
  waifubux: 1_820,
  essence: 46,
  updatedAt: new Date('2026-08-06T09:14:00.000Z'),
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

const playerStubs = {
  players: { getById: async () => PLAYER },
  appearance: appearanceStub,
};

let app: ZodFastify | undefined;

async function build(overrides: ApiContextOverrides = {}): Promise<ZodFastify> {
  app = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3120, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: createApiContext(overrides),
  });
  return app;
}

async function get(server: ZodFastify, url: string) {
  const res = await server.inject({ method: 'GET', url, headers: AUTH });
  expect(res.statusCode, url).toBe(200);
  return res.json().data;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// ── Trainer progression ─────────────────────────────────────────────────────

describe('trainer progression', () => {
  it('ships the same shape an owned copy gets', async () => {
    const player = await get(await build({ services: playerStubs }), '/api/v1/players/7');

    expect(player.progress).toEqual({
      level: 12,
      totalXp: 4_090,
      xpIntoLevel: 240,
      xpToNext: 650,
      atMaxLevel: false,
    });
    // Derived from XP, and in step with the stored column.
    expect(player.progress.level).toBe(player.level);
  });

  /**
   * The figures come from `progressionService.progressFor`, not from anything
   * restated here. Asserting the *invariant* rather than a literal is what
   * keeps this test honest when the curve is re-tuned: a client can always
   * draw `xpIntoLevel / xpToNext` as a fraction of the current level.
   */
  it('reports a position inside the current level, not a lifetime total', async () => {
    const player = await get(await build({ services: playerStubs }), '/api/v1/players/7');
    const { xpIntoLevel, xpToNext, totalXp } = player.progress;

    expect(xpIntoLevel).toBeGreaterThanOrEqual(0);
    expect(xpToNext).toBeGreaterThan(0);
    expect(xpIntoLevel).toBeLessThan(xpToNext);
    // The whole point of the field: it is not the lifetime figure.
    expect(xpIntoLevel).toBeLessThan(totalXp);
  });

  it('rides on the composite profile too, so the Dashboard needs one call', async () => {
    const server = await build({
      services: { ...playerStubs, currency: { getBalances: async () => BALANCES } },
    });
    const profile = await get(server, '/api/v1/players/7/profile');

    expect(profile.player.progress.level).toBe(12);
    expect(profile.player.progress.atMaxLevel).toBe(false);
  });

  it('reports atMaxLevel with no next level to climb', async () => {
    const server = await build({
      services: { players: { getById: async () => ({ ...PLAYER, level: 50, xp: 999_999 }) } },
    });
    const player = await get(server, '/api/v1/players/7');

    expect(player.progress.atMaxLevel).toBe(true);
    expect(player.progress.xpToNext).toBe(0);
  });
});

// ── Energy ceiling ──────────────────────────────────────────────────────────

describe('the Energy ceiling', () => {
  const withBalances = { ...playerStubs, currency: { getBalances: async () => BALANCES } };

  it('accompanies the balance on the currency resource', async () => {
    const currencies = await get(await build({ services: withBalances }), '/api/v1/players/7/currency');

    expect(currencies.huntEnergy).toBe(18);
    expect(currencies.maxHuntEnergy).toBeGreaterThan(0);
  });

  it('is the same number on the profile as on the currency route', async () => {
    const server = await build({ services: withBalances });

    const [currencies, profile] = await Promise.all([
      get(server, '/api/v1/players/7/currency'),
      get(server, '/api/v1/players/7/profile'),
    ]);

    expect(profile.currencies.maxHuntEnergy).toBe(currencies.maxHuntEnergy);
  });

  /**
   * The ceiling is level-derived, which is the reason it cannot be a constant
   * in the client: it moves as the player levels, and only the tuning table
   * knows where.
   */
  it('grows with the level bonuses the tuning table declares', async () => {
    const low = await build({
      services: {
        players: { getById: async () => ({ ...PLAYER, level: 1 }) },
        currency: { getBalances: async () => BALANCES },
      },
    });
    const atLevelOne = (await get(low, '/api/v1/players/7/currency')).maxHuntEnergy;
    await low.close();

    const high = await build({
      services: {
        players: { getById: async () => ({ ...PLAYER, level: 25 }) },
        currency: { getBalances: async () => BALANCES },
      },
    });
    const atLevelTwentyFive = (await get(high, '/api/v1/players/7/currency')).maxHuntEnergy;

    expect(atLevelTwentyFive).toBeGreaterThan(atLevelOne);
  });
});

// ── Current region ──────────────────────────────────────────────────────────

describe('current region', () => {
  const region = (id: string, name: string) => ({ id, name, enabled: true }) as RegionContent;

  it('exposes the id and a player-facing name on the player resource', async () => {
    const server = await build({
      services: playerStubs,
      content: { regions: [region('twin-peeks', 'Twin Peeks')] } as Partial<LoadedContent>,
    });
    const player = await get(server, '/api/v1/players/7');

    expect(player.currentRegion).toEqual({ id: 'twin-peeks', name: 'Twin Peeks' });
  });

  it('prefers the name content authored over the id-derived label', () => {
    expect(
      toCurrentRegionResource('twin-peeks', [region('twin-peeks', 'The Twin Peeks Ridge')]),
    ).toEqual({ id: 'twin-peeks', name: 'The Twin Peeks Ridge' });
  });

  it('falls back to the derived label when the snapshot describes no region', () => {
    expect(toCurrentRegionResource('flaccid-foothills', [])).toEqual({
      id: 'flaccid-foothills',
      name: 'Flaccid Foothills',
    });
  });

  /** A row written before a region was renamed reads as home, not as junk. */
  it('reads an unrecognised region as the starting region', () => {
    expect(toCurrentRegionResource('atlantis').id).toBe(DEFAULT_REGION);
  });
});

// ── Newest-first collection sorting ─────────────────────────────────────────

describe('collection sorting', () => {
  /** Captures what the route actually asked the service for. */
  function recordingCollection() {
    const seen: ListOptions[] = [];
    return {
      seen,
      services: {
        ...playerStubs,
        collection: {
          listOwned: async (_playerId: number, opts: ListOptions = {}) => {
            seen.push(opts);
            return {
              entries: [{ waifu: WAIFU, species: SPECIES }],
              page: 1,
              pageSize: opts.pageSize ?? 25,
              totalOwned: 1,
              totalPages: 1,
            };
          },
          waifuProgress: () => PROGRESS,
        },
      },
    };
  }

  it('defaults to the browse order when no sort is asked for', async () => {
    const { seen, services } = recordingCollection();
    await get(await build({ services }), '/api/v1/players/7/collection/owned');

    expect(seen[0]?.sort).toBe('rarity');
  });

  it('passes newest through, with the page size the caller asked for', async () => {
    const { seen, services } = recordingCollection();
    await get(
      await build({ services }),
      '/api/v1/players/7/collection/owned?sort=newest&pageSize=5',
    );

    expect(seen[0]).toMatchObject({ sort: 'newest', pageSize: 5, page: 1 });
  });

  it('rejects a sort it does not implement', async () => {
    const { services } = recordingCollection();
    const server = await build({ services });
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/players/7/collection/owned?sort=oldest',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  /**
   * `schedulePlayerWarm` warms the player's *entire* collection. That is the
   * right bargain ahead of a collection grid and the wrong one behind a
   * five-item summary strip, which would otherwise warm every card a player
   * owns on every dashboard mount.
   */
  it('does not warm the whole collection for a newest-first slice', async () => {
    const { services } = recordingCollection();
    const calls: number[] = [];
    const server = await build({
      services,
      cardWarmer: {
        schedulePlayerWarm: (playerId: number) => {
          calls.push(playerId);
          return 'started' as const;
        },
      },
    });

    await get(server, '/api/v1/players/7/collection/owned?sort=newest&pageSize=5');
    expect(calls).toEqual([]);

    // …and the browse listing still warms, so the fallback is intact.
    await get(server, '/api/v1/players/7/collection/owned');
    expect(calls).toEqual([7]);
  });
});
