/**
 * The guild player directory, end to end over HTTP and a real database.
 *
 * What these tests are actually for is the boundary, not the list. The
 * directory is the first Platform API surface that answers with somebody
 * *else's* data, so three properties matter more than anything about sorting:
 *
 *   1. **Guild scope is the session's, always.** A member of guild A cannot
 *      enumerate guild B by any request they can construct — there is no guild
 *      parameter for a Portal session, and naming one is refused rather than
 *      ignored.
 *   2. **The payload is an allowlist.** No snowflakes, no XP, no currencies, no
 *      collection contents. Asserted against the response's actual key set, so
 *      a field added upstream fails here rather than shipping quietly.
 *   3. **The public profile did not become a second self-profile.** The
 *      self-only rule on every other `/players/:id` route still holds; exactly
 *      one route opts out of it, and only inside the selected guild.
 *   4. **Whose ownership unlocks what.** The *owner's* ownership decides which
 *      copies the payload carries. The *viewer's* decides which artwork it may
 *      name and which bytes it may serve. Conflating the two is what let a
 *      viewer read the artwork of any species anybody in their guild owned, and
 *      the artwork tests below hold the two apart deliberately.
 *
 * A player who plays in two guilds has two `players` rows, one per guild, and
 * the multi-guild test asserts that both directories list them with that
 * guild's own level — which is what "may appear in each relevant guild" means
 * when guild membership is what a row *is*.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { players, species } from '../../../src/db/schema';
import { makeTempDir, writeArtwork } from '../../helpers/cardFixtures';
import type { IdentityResolver } from '../../../src/api/identity';
import path from 'node:path';

const GUILD_A = '111222333444555666';
const GUILD_B = '222333444555666777';

/** Guild A: three players, deliberately not in name, level or recency order. */
const MIKA = '900000000000000001';
const AIKO = '900000000000000002';
const ZARA = '900000000000000003';
/** Plays in both guilds — the multi-guild case. */
const NOMAD = '900000000000000004';
/** Guild B only. Must never appear in guild A's directory.  */
const OUTSIDER = '900000000000000005';

const NAMES: Record<string, string> = {
  [MIKA]: 'Mika',
  [AIKO]: 'Aiko',
  [ZARA]: 'Zara',
  [NOMAD]: 'Nomad',
  [OUTSIDER]: 'Outsider',
};

let t: TestDb;
let app: App;
let api: ZodFastify;
let sessions: StubSessions;

/** guild snowflake → internal id, and discord user → player id, per guild. */
let guildDbIds: Record<string, number> = {};
let playerIds: Record<string, number> = {};

const key = (guild: string, user: string) => `${guild}:${user}`;

/** Counts every query the API issues, so an N+1 is a number, not a vibe. */
let queryCount = 0;

/**
 * A temp assets root holding real artwork for the seeded species, so the
 * byte-serving routes answer 200 rather than "content gap" 404s. The shipped
 * asset tree is deliberately not used: these tests are about *authorization*,
 * and must not start failing because a species lost its picture.
 */
let assetsDir: string;
/** Aiko's copies in guild A, and the slug they wear. */
let aikoBuddyWaifuId: number;
/**
 * Mika's own copy — of `seededSlug` only.
 *
 * She is the viewer in almost every assertion here, and the artwork rule is
 * about *her* dex, so she has to be able to fail it for one species and pass it
 * for the other. Without a copy of her own every artwork case would answer 403
 * and the tests would agree with each other about nothing.
 */
let mikaWaifuId: number;
let aikoSecondWaifuId: number;
let outsiderWaifuId: number;
let seededSlug: string;
let secondSlug: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);

  for (const [guild, users] of [
    [GUILD_A, [MIKA, AIKO, ZARA, NOMAD]],
    [GUILD_B, [OUTSIDER, NOMAD]],
  ] as const) {
    for (const user of users) {
      const { guildDbId, playerId } = await provisionPlayer(app, guild, user);
      guildDbIds[guild] = guildDbId;
      playerIds[key(guild, user)] = playerId;
    }
  }

  const now = Date.now();
  // Levels and activity are set explicitly so each sort has a different
  // correct answer and no ordering can pass by accident.
  const state: [string, string, number, Date][] = [
    [GUILD_A, MIKA, 12, new Date(now - 2 * 86_400_000)],
    [GUILD_A, AIKO, 31, new Date(now - 1 * 86_400_000)],
    // Zara last hunted 90 days ago — outside the 30-day activity window.
    [GUILD_A, ZARA, 4, new Date(now - 90 * 86_400_000)],
    [GUILD_A, NOMAD, 7, new Date(now - 3 * 86_400_000)],
    // The same person, a different guild, a different level. Two rows.
    [GUILD_B, NOMAD, 44, new Date(now - 1 * 86_400_000)],
    [GUILD_B, OUTSIDER, 50, new Date(now - 1 * 86_400_000)],
  ];
  for (const [guild, user, level, lastHuntAt] of state) {
    await t.db
      .update(players)
      .set({ level, lastHuntAt })
      .where(eq(players.id, playerIds[key(guild, user)]!));
  }

  // One buddy, so the preview has something to prove and the query count has
  // something to stay flat against.
  // Two species, ordered so the rarity sort has something to say, and both
  // given real artwork under a temp assets root.
  const seeded = await t.db.select().from(species).orderBy(species.id).limit(2);
  const [firstSpecies, secondSpecies] = seeded;
  seededSlug = firstSpecies!.slug;
  secondSlug = secondSpecies!.slug;

  assetsDir = await makeTempDir('public-collection-assets');
  for (const slug of [seededSlug, secondSlug]) {
    await writeArtwork(
      path.join(assetsDir, 'waifumon', slug, 'standard.png'),
      { r: 200, g: 40, b: 90 },
    );
  }

  // Aiko owns two copies; the first is her buddy. Outsider (guild B) owns one,
  // which is what the cross-guild assertions try — and fail — to reach.
  const buddy = await insertOwnedWaifu(t.db, {
    playerId: playerIds[key(GUILD_A, AIKO)]!,
    speciesId: firstSpecies!.id,
    level: 9,
  });
  aikoBuddyWaifuId = buddy.id;
  const second = await insertOwnedWaifu(t.db, {
    playerId: playerIds[key(GUILD_A, AIKO)]!,
    speciesId: secondSpecies!.id,
    level: 3,
    nickname: 'Pumpkin',
  });
  aikoSecondWaifuId = second.id;
  // Mika discovers the first species and only the first. `secondSlug` is her
  // blind spot, and Aiko owning a copy of it must not change that.
  const mikaCopy = await insertOwnedWaifu(t.db, {
    playerId: playerIds[key(GUILD_A, MIKA)]!,
    speciesId: firstSpecies!.id,
    level: 2,
  });
  mikaWaifuId = mikaCopy.id;
  const outsiderCopy = await insertOwnedWaifu(t.db, {
    playerId: playerIds[key(GUILD_B, OUTSIDER)]!,
    speciesId: secondSpecies!.id,
    level: 20,
  });
  outsiderWaifuId = outsiderCopy.id;

  await t.db
    .update(players)
    .set({ buddyWaifuId: buddy.id })
    .where(eq(players.id, playerIds[key(GUILD_A, AIKO)]!));

  // Presentation identity is host-injected. A deterministic stub keeps the
  // name-sort and search assertions about the API's behaviour rather than
  // about a live gateway.
  const resolveIdentity: IdentityResolver = async (discordUserId) => {
    const displayName = NAMES[discordUserId];
    return displayName ? { displayName, avatarUrl: null } : null;
  };

  sessions = makeStubSessions();

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3133, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    portalAuth: {
      config: {
        publicUrl: 'http://localhost',
        forwardedProto: 'http',
        discordClientId: 'x',
        discordClientSecret: 'x',
        sessionSecret: 'x',
        sessionTtlSeconds: 3600,
      },
      sessions: sessions as unknown as PortalSessionService,
    },
    ctx: {
      services: app,
      getContent: () => app.content,
      resolveIdentity,
      // Registers the byte-serving artwork routes, including the public one.
      assetsDir,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

interface StubSessions {
  getSession: (token: string | undefined) => Promise<PortalSession | null>;
  toBrowserSession: (session: PortalSession | null) => Record<string, unknown>;
  safeEquals: (a: string, b: string) => boolean;
  logout: () => Promise<void>;
  selectGuild: () => Promise<null>;
  completeOAuth: () => Promise<never>;
  createOAuthState: () => Promise<string>;
  consumeOAuthState: () => Promise<boolean>;
}

/**
 * Sessions are addressed by a `<guild>:<user>` token so a test says which
 * account it is acting as in the cookie itself. `noguild:<user>` is the
 * mid-selection state.
 */
function makeStubSessions(): StubSessions {
  return {
    async getSession(token) {
      if (!token) return null;
      const [guild, user] = token.split(':');
      if (!guild || !user) return null;
      const noGuild = guild === 'noguild';
      const guildDbId = noGuild ? null : (guildDbIds[guild] ?? null);
      const playerId = noGuild ? null : (playerIds[key(guild, user)] ?? null);
      if (!noGuild && (guildDbId === null || playerId === null)) return null;
      return {
        sessionDigest: token,
        discordUserId: user,
        discordUsername: NAMES[user] ?? null,
        discordAvatarUrl: null,
        selectedDiscordGuildId: noGuild ? null : guild,
        selectedGuildDbId: guildDbId,
        playerId,
        eligibleGuilds: [],
        csrfToken: 'csrf',
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    toBrowserSession: (session) => (session ? { authenticated: true } : { authenticated: false }),
    safeEquals: (a, b) => a === b,
    async logout() {},
    async selectGuild() {
      return null;
    },
    async completeOAuth() {
      throw new Error('not stubbed');
    },
    async createOAuthState() {
      return 'state';
    },
    async consumeOAuthState() {
      return true;
    },
  };
}

function asPortal(guild: string, user: string) {
  return { cookie: `wm_portal_session=${guild}:${user}` };
}

async function directory(guild: string, user: string, query = '') {
  return api.inject({
    method: 'GET',
    url: `/api/v1/players${query}`,
    headers: asPortal(guild, user),
  });
}

const names = (res: { json: () => unknown }) =>
  (res.json() as { data: { displayName: string }[] }).data.map((p) => p.displayName);

describe('GET /v1/players — the guild directory', () => {
  it('returns the players of the session\'s selected guild', async () => {
    const res = await directory(GUILD_A, MIKA);
    expect(res.statusCode).toBe(200);
    expect(names(res).sort()).toEqual(['Aiko', 'Mika', 'Nomad', 'Zara']);
  });

  it('excludes players from every other guild', async () => {
    const res = await directory(GUILD_A, MIKA);
    expect(names(res)).not.toContain('Outsider');

    const b = await directory(GUILD_B, OUTSIDER);
    expect(names(b).sort()).toEqual(['Nomad', 'Outsider']);
    for (const absent of ['Mika', 'Aiko', 'Zara']) {
      expect(names(b)).not.toContain(absent);
    }
  });

  it('lists a multi-guild player in each guild, at that guild\'s level', async () => {
    const a = (await directory(GUILD_A, MIKA)).json() as {
      data: { id: number; displayName: string; level: number }[];
    };
    const b = (await directory(GUILD_B, OUTSIDER)).json() as {
      data: { id: number; displayName: string; level: number }[];
    };

    const inA = a.data.find((p) => p.displayName === 'Nomad');
    const inB = b.data.find((p) => p.displayName === 'Nomad');
    expect(inA?.level).toBe(7);
    expect(inB?.level).toBe(44);
    // Two guilds, two player rows, two ids — the same human, two profiles.
    expect(inA?.id).not.toBe(inB?.id);
  });

  it('changes results when the session\'s selected guild changes', async () => {
    // The same Discord user, two sessions differing only in selected guild.
    const inA = names(await directory(GUILD_A, NOMAD));
    const inB = names(await directory(GUILD_B, NOMAD));
    expect(inA).not.toEqual(inB);
    expect(inA).toContain('Mika');
    expect(inB).toContain('Outsider');
    expect(inB).not.toContain('Mika');
  });

  it('refuses a guild the session has not selected, rather than ignoring it', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players?discordGuildId=${GUILD_B}`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PORTAL_GUILD_FORBIDDEN');
  });

  it('fails closed while no guild is selected', async () => {
    const res = await directory('noguild', MIKA);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PORTAL_GUILD_REQUIRED');
  });

  it('rejects an unauthenticated request outright', async () => {
    const res = await api.inject({ method: 'GET', url: '/api/v1/players' });
    expect(res.statusCode).toBe(401);
  });

  it('searches by display name', async () => {
    const res = await directory(GUILD_A, MIKA, '?search=ai');
    expect(names(res)).toEqual(['Aiko']);

    // Case-insensitive, and a substring rather than a prefix.
    expect(names(await directory(GUILD_A, MIKA, '?search=OMA'))).toEqual(['Nomad']);
  });

  it('sorts by name', async () => {
    expect(names(await directory(GUILD_A, MIKA, '?sort=name'))).toEqual([
      'Aiko',
      'Mika',
      'Nomad',
      'Zara',
    ]);
  });

  it('sorts by trainer level, highest first', async () => {
    expect(names(await directory(GUILD_A, MIKA, '?sort=level'))).toEqual([
      'Aiko', // 31
      'Mika', // 12
      'Nomad', // 7
      'Zara', // 4
    ]);
  });

  it('sorts by recent activity', async () => {
    expect(names(await directory(GUILD_A, MIKA, '?sort=recent'))).toEqual([
      'Aiko', // 1 day
      'Mika', // 2 days
      'Nomad', // 3 days
      'Zara', // 90 days
    ]);
  });

  it('applies the documented active-player rule', async () => {
    // The rule: a `players` row in the guild is a member. `activity=recent`
    // narrows to 30 days of `coalesce(last_hunt_at, created_at)`. Zara hunted
    // 90 days ago and is the only one outside the window.
    expect(names(await directory(GUILD_A, MIKA, '?activity=all'))).toContain('Zara');
    const recent = names(await directory(GUILD_A, MIKA, '?activity=recent'));
    expect(recent).not.toContain('Zara');
    expect(recent.sort()).toEqual(['Aiko', 'Mika', 'Nomad']);
  });

  it('paginates', async () => {
    const res = await directory(GUILD_A, MIKA, '?sort=name&page=2&pageSize=2');
    const body = res.json() as { data: unknown[]; page: number; pageSize: number; total: number };
    expect(body).toMatchObject({ page: 2, pageSize: 2, total: 4 });
    expect(names(res)).toEqual(['Nomad', 'Zara']);
  });

  it('carries the buddy preview without a per-player query', async () => {
    const res = await directory(GUILD_A, MIKA);
    const rows = res.json() as {
      data: { displayName: string; buddy: { speciesName: string; assetId: unknown } | null }[];
    };
    const aiko = rows.data.find((p) => p.displayName === 'Aiko');
    expect(aiko?.buddy).toMatchObject({
      level: 9,
      assetId: { kind: 'waifumon' },
    });
    expect(rows.data.find((p) => p.displayName === 'Mika')?.buddy).toBeNull();
  });

  it('exposes only public-safe fields', async () => {
    const rows = (await directory(GUILD_A, MIKA)).json() as { data: Record<string, unknown>[] };
    for (const row of rows.data) {
      expect(Object.keys(row).sort()).toEqual(
        ['avatarUrl', 'buddy', 'displayName', 'id', 'lastActiveAt', 'level'].sort(),
      );
    }
    // Belt and braces against a serializer that stopped stripping: no
    // snowflake, no XP, no currency figure appears anywhere in the body.
    const raw = (await directory(GUILD_A, MIKA)).body;
    for (const leak of [MIKA, AIKO, 'xp', 'waifubux', 'essence', 'huntEnergy', 'discordUserId']) {
      expect(raw).not.toContain(leak);
    }
  });
});

describe('GET /v1/players/:id/public — the profile the directory links to', () => {
  it('serves a guild-mate\'s profile', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_A, AIKO)]}/public`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: Record<string, unknown> }).data;
    expect(body).toMatchObject({
      displayName: 'Aiko',
      level: 31,
      collection: { owned: 2, distinctSpecies: 2 },
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'achievements',
        'avatarUrl',
        'buddy',
        'collection',
        'createdAt',
        'currentRegion',
        'displayName',
        'id',
        'lastActiveAt',
        'level',
      ].sort(),
    );
    expect(res.body).not.toContain('waifubux');
    expect(res.body).not.toContain('"xp"');
  });

  it('404s for a player in another guild — the same answer as an unknown id', async () => {
    const crossGuild = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_B, OUTSIDER)]}/public`,
      headers: asPortal(GUILD_A, MIKA),
    });
    const unknown = await api.inject({
      method: 'GET',
      url: '/api/v1/players/999999/public',
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(crossGuild.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect((crossGuild.json() as { error: { code: string } }).error.code).toBe(
      (unknown.json() as { error: { code: string } }).error.code,
    );
  });

  it('does not widen the self-only rule on any other player route', async () => {
    // The scope hook's opt-in is per route. A guild-mate's *private* resources
    // stay refused, which is what makes the public route a widening of one
    // endpoint rather than of the boundary.
    const aiko = playerIds[key(GUILD_A, AIKO)];
    for (const path of [`/api/v1/players/${aiko}`, `/api/v1/players/${aiko}/profile`, `/api/v1/players/${aiko}/currency`]) {
      const res = await api.inject({ method: 'GET', url: path, headers: asPortal(GUILD_A, MIKA) });
      expect(res.statusCode, path).toBe(403);
    }
  });
});

describe('query volume', () => {
  it('answers the directory in one database query, whatever the page size', async () => {
    queryCount = 0;
    // Counted at the pool, which is every statement the request actually
    // issues — not at the service, which could hide a second call behind a
    // helper.
    const pool = t.pool as unknown as { query: (...args: never[]) => unknown };
    const original = pool.query.bind(pool);
    pool.query = (...args: never[]) => {
      queryCount += 1;
      return original(...args);
    };
    try {
      await directory(GUILD_A, MIKA, '?pageSize=50');
    } finally {
      pool.query = original;
    }

    // One directory query. Four players and one buddy would be five or more
    // under an N+1; the buddy join is what keeps it at one.
    expect(queryCount).toBe(1);
  });
});

/**
 * The public collection — viewing a guild-mate's Waifumon.
 *
 * The authorization shape is the point. Every route below carries the owner's
 * player id in the path, and the scope hook resolves that id against the
 * *session's selected guild* before any handler runs, so "can I read this
 * collection?" is answered before a collection row is touched. The tests that
 * matter most are the ones that try to get around that.
 */
describe('the public collection', () => {
  const publicCollection = (guild: string, user: string, targetPlayerId: number, query = '') =>
    api.inject({
      method: 'GET',
      url: `/api/v1/players/${targetPlayerId}/public/collection${query}`,
      headers: asPortal(guild, user),
    });

  const aiko = () => playerIds[key(GUILD_A, AIKO)]!;
  const outsider = () => playerIds[key(GUILD_B, OUTSIDER)]!;

  it('lets a guild-mate view another player\'s collection', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { waifu: { id: number } }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.data.map((e) => e.waifu.id).sort()).toEqual(
      [aikoBuddyWaifuId, aikoSecondWaifuId].sort(),
    );
  });

  it('shows only copies the target player owns', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko());
    const body = res.json() as { data: { waifu: { id: number; playerId: number } }[] };
    for (const entry of body.data) {
      expect(entry.waifu.playerId).toBe(aiko());
    }
    // Guild B's copy is not reachable through guild A's player, even though
    // both copies share a species.
    expect(body.data.map((e) => e.waifu.id)).not.toContain(outsiderWaifuId);
  });

  it('refuses a different guild\'s player — handcrafted id included', async () => {
    const res = await publicCollection(GUILD_A, MIKA, outsider());
    expect(res.statusCode).toBe(404);
    // Identical to an id that does not exist: a prober learns nothing.
    const unknown = await publicCollection(GUILD_A, MIKA, 999999);
    expect(unknown.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      (unknown.json() as { error: { code: string } }).error.code,
    );
  });

  it('fails closed for a session with no selected guild', async () => {
    const res = await publicCollection('noguild', MIKA, aiko());
    expect(res.statusCode).toBe(404);
  });

  it('follows the multi-guild scope — the same viewer, two selections', async () => {
    // Nomad plays in both guilds. Viewing Outsider works only while guild B is
    // the selected one; from guild A the very same target is invisible.
    expect((await publicCollection(GUILD_B, NOMAD, outsider())).statusCode).toBe(200);
    expect((await publicCollection(GUILD_A, NOMAD, outsider())).statusCode).toBe(404);
  });

  it('marks the owner\'s active buddy, and only that copy', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko());
    const body = res.json() as { data: { waifu: { id: number }; isBuddy: boolean }[] };
    const flagged = body.data.filter((e) => e.isBuddy).map((e) => e.waifu.id);
    expect(flagged).toEqual([aikoBuddyWaifuId]);
  });

  it('filters by rarity and sorts, against the target\'s collection', async () => {
    const all = (await publicCollection(GUILD_A, MIKA, aiko())).json() as {
      data: { species: { rarity: string; slug: string } }[];
    };
    const rarity = all.data[0]!.species.rarity;
    const filtered = (
      await publicCollection(GUILD_A, MIKA, aiko(), `?rarity=${rarity}`)
    ).json() as { data: { species: { rarity: string } }[]; total: number };
    expect(filtered.data.length).toBeGreaterThan(0);
    for (const entry of filtered.data) expect(entry.species.rarity).toBe(rarity);

    // `sort=newest` is the server's own order, applied to this player's copies.
    const newest = (await publicCollection(GUILD_A, MIKA, aiko(), '?sort=newest')).json() as {
      data: { waifu: { id: number } }[];
    };
    expect(newest.data[0]!.waifu.id).toBe(aikoSecondWaifuId);
  });

  it('paginates', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko(), '?page=1&pageSize=1');
    const body = res.json() as { data: unknown[]; page: number; pageSize: number; total: number };
    expect(body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(body.data).toHaveLength(1);
  });

  it('exposes only public-safe copy fields', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko());
    const body = res.json() as { data: { waifu: Record<string, unknown> }[] };
    for (const entry of body.data) {
      expect(Object.keys(entry.waifu).sort()).toEqual(
        [
          'caughtAt',
          'id',
          'isFavorite',
          'level',
          'nickname',
          'playerId',
          'selectedAppearance',
          'variant',
        ].sort(),
      );
    }
    // Nothing progression-, economy- or release-shaped anywhere in the body.
    for (const leak of [
      '"xp"',
      'affection',
      'seductivePower',
      'releasedAt',
      'waifubux',
      'essence',
      'huntEnergy',
      '"progress"',
    ]) {
      expect(res.body).not.toContain(leak);
    }
  });

  /**
   * `caughtAt` is the one field where the public view is deliberately less
   * precise than the row behind it. These assertions pin all three halves of
   * that decision: the wire loses the time of day, the *self* resource does
   * not, and the server's own ordering still uses the untruncated column.
   */
  it('publishes caughtAt as a calendar day, with no time of day', async () => {
    const res = await publicCollection(GUILD_A, MIKA, aiko());
    const body = res.json() as { data: { waifu: { caughtAt: string } }[] };

    for (const entry of body.data) {
      expect(entry.waifu.caughtAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Nothing time-shaped survives anywhere in the public body: no `T`
    // separator, no `Z`, no seconds, no milliseconds.
    expect(res.body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves the self resource\'s full-precision caughtAt untouched', async () => {
    // Same copies, read by their owner through the self route: still the whole
    // instant, milliseconds included. The truncation is scoped to the public
    // serialization boundary and nothing else.
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${aiko()}/collection/owned`,
      headers: asPortal(GUILD_A, AIKO),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { waifu: { caughtAt: string } }[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.waifu.caughtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('orders sort=newest by the real timestamp, not the truncated day', async () => {
    // Both of Aiko's copies are seeded within the same second, so a sort
    // keyed on the published `YYYY-MM-DD` could not separate them. The server
    // still reads `caught_at`, so the newest is unambiguous — which is what
    // makes the client's same-day tie-break ("keep the server's order")
    // correct rather than arbitrary.
    const res = await publicCollection(GUILD_A, MIKA, aiko(), '?sort=newest');
    const body = res.json() as { data: { waifu: { id: number; caughtAt: string } }[] };

    expect(body.data.map((e) => e.waifu.id)).toEqual([aikoSecondWaifuId, aikoBuddyWaifuId]);
    // Same published day, different rows — the ordering cannot have come from
    // the field on the wire.
    expect(new Set(body.data.map((e) => e.waifu.caughtAt)).size).toBe(1);
  });

  it('serves one copy for inspection, and 404s for a copy the target does not own', async () => {
    const ok = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${aiko()}/public/collection/${aikoSecondWaifuId}`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { data: { waifu: { nickname: string } } }).data.waifu.nickname).toBe(
      'Pumpkin',
    );

    // A real copy id — but somebody else's. Scoped to the owner, so it is a
    // plain 404 rather than a cross-account read.
    const wrongOwner = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${aiko()}/public/collection/${outsiderWaifuId}`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(wrongOwner.statusCode).toBe(404);
  });

  it('exposes no mutation surface on the public namespace', async () => {
    // Release, favourite, buddy and appearance changes are game actions that
    // live in Discord; the public namespace must not offer even a shape for
    // them. These requests carry a *valid* CSRF pair, so nothing upstream can
    // account for the refusal — the router itself has no such route.
    const writable = {
      cookie: `wm_portal_session=${GUILD_A}:${MIKA}; wm_portal_csrf=csrf`,
      'x-portal-csrf': 'csrf',
    };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await api.inject({
        method,
        url: `/api/v1/players/${aiko()}/public/collection/${aikoBuddyWaifuId}`,
        headers: writable,
      });
      expect(res.statusCode, method).toBe(404);
    }
    // And the self-only appearance mutation still refuses a guild-mate.
    const appearance = await api.inject({
      method: 'PUT',
      url: `/api/v1/players/${aiko()}/collection/owned/${aikoBuddyWaifuId}/appearance`,
      headers: writable,
      payload: { appearanceId: 'standard' },
    });
    expect(appearance.statusCode).toBe(403);
  });
});


/**
 * Artwork authorization — whose dex decides.
 *
 * Two ownerships meet on the public collection, and the bug these tests exist
 * for was treating them as one:
 *
 *   - **The owner's** puts the copy in the payload. It is authorized by guild,
 *     before a row is read, and nothing here changes that.
 *   - **The viewer's** decides whether the picture may be seen. It is the same
 *     dex `/assets/waifumon/:slug` has always been gated on.
 *
 * The route used to check only the first, which made it a species oracle with
 * extra steps: any viewer could read the full-resolution artwork of anything
 * anybody in their guild owned by walking copy ids — precisely what the slug
 * route refuses. Both halves are now asserted together, and the payload's
 * `assetId` follows the same line so nothing is merely hidden on the client.
 *
 * Mika owns `seededSlug` and not `secondSlug`; Zara owns nothing at all. Aiko
 * owns a copy of both, which is the fact that must not move either of them.
 */
describe('public collection artwork', () => {
  const artwork = (guild: string, user: string, playerId: number, waifuId: number) =>
    api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerId}/public/collection/${waifuId}/artwork`,
      headers: asPortal(guild, user),
    });

  const aikoId = () => playerIds[key(GUILD_A, AIKO)]!;

  it('serves artwork for a species the viewer has discovered', async () => {
    // Aiko's buddy wears `seededSlug`, and Mika owns a copy of it herself — so
    // she is already entitled to the picture and merely seeing it on somebody
    // else's shelf changes nothing.
    const res = await artwork(GUILD_A, MIKA, aikoId(), aikoBuddyWaifuId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\//);
    // Caller-dependent, so it must never land in a shared cache.
    expect(String(res.headers['cache-control'])).toContain('private');
  });

  it('refuses artwork for a species only the owner has discovered', async () => {
    // Aiko's second copy wears `secondSlug`. Aiko owning it is what puts the
    // copy on her public profile; it is not a reason to hand Mika the art.
    const res = await artwork(GUILD_A, MIKA, aikoId(), aikoSecondWaifuId);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('SPECIES_NOT_DISCOVERED');
  });

  it('refuses every species for a viewer who owns nothing', async () => {
    // Zara's dex is empty, so the owner's collection is entirely silhouettes
    // for her — including the copy Mika is allowed to see.
    for (const waifuId of [aikoBuddyWaifuId, aikoSecondWaifuId]) {
      const res = await artwork(GUILD_A, ZARA, aikoId(), waifuId);
      expect(res.statusCode, String(waifuId)).toBe(403);
    }
  });

  it('refuses artwork for a player outside the selected guild', async () => {
    // Guild scope is checked first, and answers 404 — a viewer must not learn
    // from a 403 that the species exists and is merely undiscovered.
    const res = await artwork(GUILD_A, MIKA, playerIds[key(GUILD_B, OUTSIDER)]!, outsiderWaifuId);
    expect(res.statusCode).toBe(404);
  });

  it('is refused outright for a session with no resolved player', async () => {
    // Mid guild-selection there is no dex to check against, so there is no
    // artwork. Unknown is refused, never allowed.
    const res = await artwork('noguild', MIKA, aikoId(), aikoBuddyWaifuId);
    expect([403, 404]).toContain(res.statusCode);
  });

  it('does not become a species oracle', async () => {
    // Zara owns nothing, so she has discovered nothing. The slug route is the
    // one that could leak the encyclopedia, and it is unchanged: still 403 for
    // both slugs.
    for (const slug of [seededSlug, secondSlug]) {
      const res = await api.inject({
        method: 'GET',
        url: `/api/v1/assets/waifumon/${slug}`,
        headers: asPortal(GUILD_A, ZARA),
      });
      expect(res.statusCode, slug).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'SPECIES_NOT_DISCOVERED',
      );
    }

    // And the public artwork route is addressed by owner + copy only — there
    // is no slug parameter through which a species could be requested.
    const bogus = await artwork(GUILD_A, MIKA, aikoId(), 999999);
    expect(bogus.statusCode).toBe(404);
  });

  it('leaves the viewer’s own copies alone', async () => {
    // The self route is unaffected: owning the copy is the proof, and no dex
    // lookup stands between a player and their own Waifumon.
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_A, MIKA)]!}/collection/owned/${mikaWaifuId}/artwork`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(res.statusCode).toBe(200);
  });
});

/**
 * The payload half of the same rule.
 *
 * Hiding a field in React is not a privacy boundary while the endpoint still
 * sends it: devtools, a saved HAR and a hand-crafted `curl` all read what the
 * component chose not to draw. An `assetId` resolves deterministically to a
 * picture on every consumer, so it is the artwork as far as this boundary is
 * concerned, and it follows the viewer's dex rather than the owner's.
 *
 * Species *text* deliberately does not. The whole authored catalog — names,
 * rarities, lore, appearance names — is already served to any authenticated
 * session by `GET /content/species`, which is what the Encyclopedia renders
 * from; withholding it here would be theatre, not a boundary, and the
 * Encyclopedia's `???` is a spoiler treatment the Portal now applies to this
 * surface too. The field-by-field allowlist above is what keeps *player* data
 * out of this payload; this is about the pictures.
 */
describe('public collection payload — artwork identifiers', () => {
  const entry = (guild: string, user: string, waifuId: number) =>
    api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_A, AIKO)]!}/public/collection/${waifuId}`,
      headers: asPortal(guild, user),
    });

  type Entry = {
    data: {
      waifu: { selectedAppearance: { assetId: unknown; isUnlocked: boolean; name: string } };
      species: { name: string; rarity: string; appearances: { assetId: unknown }[] };
    };
  };

  it('names the artwork for a species the viewer has discovered', async () => {
    const body = (await entry(GUILD_A, MIKA, aikoBuddyWaifuId)).json() as Entry;
    expect(body.data.waifu.selectedAppearance.assetId).not.toBeNull();
    expect(body.data.species.appearances.some((a) => a.assetId !== null)).toBe(true);
  });

  it('withholds every artwork identifier for a species the viewer has not', async () => {
    const body = (await entry(GUILD_A, MIKA, aikoSecondWaifuId)).json() as Entry;
    expect(body.data.waifu.selectedAppearance.assetId).toBeNull();
    for (const appearance of body.data.species.appearances) {
      expect(appearance.assetId).toBeNull();
    }
    // The owner's facts are still stated truthfully — she *is* wearing it, and
    // it *is* unlocked for her. Only the picture is withheld.
    expect(body.data.waifu.selectedAppearance.isUnlocked).toBe(true);
    expect(body.data.waifu.selectedAppearance.name.length).toBeGreaterThan(0);
  });

  it('applies the same rule across a whole page', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_A, AIKO)]!}/public/collection`,
      headers: asPortal(GUILD_A, MIKA),
    });
    const body = res.json() as {
      data: {
        species: { slug: string };
        waifu: { selectedAppearance: { assetId: unknown } };
      }[];
    };
    for (const row of body.data) {
      const expected = row.species.slug === seededSlug;
      expect(row.waifu.selectedAppearance.assetId !== null, row.species.slug).toBe(expected);
    }
  });

  it('withholds them all for a viewer who owns nothing', async () => {
    const body = (await entry(GUILD_A, ZARA, aikoBuddyWaifuId)).json() as Entry;
    expect(body.data.waifu.selectedAppearance.assetId).toBeNull();
    // The row itself is still served: what the owner owns is public, and the
    // level, nickname and buddy flag on it are the point of the feature.
    expect(body.data.species.rarity.length).toBeGreaterThan(0);
  });

  it('leaves the viewer’s own collection resource untouched', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${playerIds[key(GUILD_A, MIKA)]!}/collection/owned/${mikaWaifuId}`,
      headers: asPortal(GUILD_A, MIKA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { waifu: { selectedAppearance: { assetId: unknown } } };
    };
    expect(body.data.waifu.selectedAppearance.assetId).not.toBeNull();
  });
});
