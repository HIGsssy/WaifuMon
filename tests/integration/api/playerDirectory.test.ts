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
import type { IdentityResolver } from '../../../src/api/identity';

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
  const [firstSpecies] = await t.db.select().from(species).limit(1);
  const buddy = await insertOwnedWaifu(t.db, {
    playerId: playerIds[key(GUILD_A, AIKO)]!,
    speciesId: firstSpecies!.id,
    level: 9,
  });
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
      collection: { owned: 1, distinctSpecies: 1 },
    });
    expect(Object.keys(body).sort()).toEqual(
      [
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
