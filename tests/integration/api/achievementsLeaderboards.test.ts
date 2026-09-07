/**
 * Achievements + Leaderboards over HTTP and a real database.
 *
 * The two systems are deliberately tested together because they share the one
 * boundary that matters most: **guild scope**. A leaderboard must rank only the
 * session's guild and never leak a raw metric value; an achievement wall is a
 * player's own, and its public showcase must expose only unlocked, non-hidden
 * badges. Everything else — ranking order, tie behaviour, lazy unlock, hidden
 * concealment — is asserted on top of that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  bootstrapApp,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { encounters, players, playerAchievements, playerUnlockedRoutes, playerWaifus, species } from '../../../src/db/schema';
import type { IdentityResolver } from '../../../src/api/identity';

const GUILD_A = '111000000000000001';
const GUILD_B = '222000000000000002';

const HERO = '900000000000000101';
const RIVAL = '900000000000000102';
const TWIN = '900000000000000103';
const NOVICE = '900000000000000104';
const STRANGER = '900000000000000201';

const NAMES: Record<string, string> = {
  [HERO]: 'Hero',
  [RIVAL]: 'Rival',
  [TWIN]: 'Twin',
  [NOVICE]: 'Novice',
  [STRANGER]: 'Stranger',
};

let t: TestDb;
let app: App;
let api: ZodFastify;

const guildDbIds: Record<string, number> = {};
const playerIds: Record<string, number> = {};
const key = (guild: string, user: string) => `${guild}:${user}`;
const pid = (guild: string, user: string) => playerIds[key(guild, user)]!;

/** Pick the first species id of a given rarity from the seeded catalogue. */
let speciesByRarity: Record<string, number[]> = {};
function speciesOf(rarity: string, n = 1): number[] {
  const ids = speciesByRarity[rarity] ?? [];
  if (ids.length < n) throw new Error(`need ${n} ${rarity} species, have ${ids.length}`);
  return ids.slice(0, n);
}

async function setXp(guild: string, user: string, xp: number, level: number) {
  await t.db.update(players).set({ xp, level }).where(eq(players.id, pid(guild, user)));
}

async function addEncounters(guild: string, user: string, count: number) {
  const [speciesId] = speciesOf('N');
  const rows = Array.from({ length: count }, () => ({
    playerId: pid(guild, user),
    speciesId: speciesId!,
    channelId: 'c1',
    state: 'escaped',
    expiresAt: new Date(Date.now() + 3_600_000),
  }));
  if (rows.length) await t.db.insert(encounters).values(rows);
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);

  for (const [guild, users] of [
    [GUILD_A, [HERO, RIVAL, TWIN, NOVICE]],
    [GUILD_B, [STRANGER]],
  ] as const) {
    for (const user of users) {
      const { guildDbId, playerId } = await provisionPlayer(app, guild, user);
      guildDbIds[guild] = guildDbId;
      playerIds[key(guild, user)] = playerId;
    }
  }

  const seeded = await t.db.select({ id: species.id, rarity: species.rarity }).from(species);
  speciesByRarity = {};
  for (const row of seeded) {
    (speciesByRarity[row.rarity] ??= []).push(row.id);
  }

  // ── Hero: a well-rounded veteran ─────────────────────────────────────────
  await setXp(GUILD_A, HERO, 5000, 30);
  await addEncounters(GUILD_A, HERO, 30); // hunter_1, hunter_2 unlock; hunter_3 (100) locked
  // 12 distinct species incl one of each high rarity — collector_1 + all rarity_*.
  const heroSpecies = [
    ...speciesOf('N', 6),
    ...speciesOf('R', 2),
    ...speciesOf('SR', 1),
    ...speciesOf('SSR', 1),
    ...speciesOf('UR', 1),
    ...speciesOf('LR', 1),
  ];
  let heroBuddyId = 0;
  for (const [i, speciesId] of heroSpecies.entries()) {
    const w = await insertOwnedWaifu(t.db, { playerId: pid(GUILD_A, HERO), speciesId, level: 5 });
    if (i === 0) heroBuddyId = w.id;
  }
  // Buddy affection 5200 → devoted_1 (500), devoted_2 (2500) and the hidden
  // secret_devotion (5000) all unlock and reveal.
  await t.db
    .update(players)
    .set({ buddyWaifuId: heroBuddyId })
    .where(eq(players.id, pid(GUILD_A, HERO)));
  await t.db
    .update(playerWaifus)
    .set({ affection: 5200 })
    .where(eq(playerWaifus.id, heroBuddyId));
  // One unlocked route → regions_visited = 2 → explorer_1.
  await t.db
    .insert(playerUnlockedRoutes)
    .values({ playerId: pid(GUILD_A, HERO), regionId: 'twin-peeks' });

  // ── Rival: mid-game, ties Twin on XP ─────────────────────────────────────
  await setXp(GUILD_A, RIVAL, 3000, 15);
  await addEncounters(GUILD_A, RIVAL, 5);
  const rivalSpecies = [...speciesOf('N', 4), ...speciesOf('SR', 1)];
  let rivalBuddyId = 0;
  for (const [i, speciesId] of rivalSpecies.entries()) {
    const w = await insertOwnedWaifu(t.db, { playerId: pid(GUILD_A, RIVAL), speciesId, level: 4 });
    if (i === 0) rivalBuddyId = w.id;
  }
  await t.db.update(players).set({ buddyWaifuId: rivalBuddyId }).where(eq(players.id, pid(GUILD_A, RIVAL)));
  // Affection 600 → devoted_1 only; hidden secret_devotion stays locked.
  await t.db
    .update(playerWaifus)
    .set({ affection: 600 })
    .where(eq(playerWaifus.id, rivalBuddyId));

  // ── Twin: same XP as Rival, nothing else ─────────────────────────────────
  await setXp(GUILD_A, TWIN, 3000, 15);

  // ── Novice: brand new, zero everything ───────────────────────────────────
  await setXp(GUILD_A, NOVICE, 0, 1);

  // ── Stranger: another guild, huge XP that must never appear in guild A ────
  await setXp(GUILD_B, STRANGER, 999999, 60);

  const resolveIdentity: IdentityResolver = async (discordUserId) => {
    const displayName = NAMES[discordUserId];
    return displayName ? { displayName, avatarUrl: null } : null;
  };

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3141, token: TEST_TOKEN },
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
      sessions: makeStubSessions() as unknown as PortalSessionService,
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

function makeStubSessions() {
  return {
    async getSession(token: string | undefined): Promise<PortalSession | null> {
      if (!token) return null;
      const [guild, user] = token.split(':');
      if (!guild || !user) return null;
      const guildDbId = guildDbIds[guild] ?? null;
      const playerId = playerIds[key(guild, user)] ?? null;
      if (guildDbId === null || playerId === null) return null;
      return {
        sessionDigest: token,
        discordUserId: user,
        discordUsername: NAMES[user] ?? null,
        discordAvatarUrl: null,
        selectedDiscordGuildId: guild,
        selectedGuildDbId: guildDbId,
        playerId,
        eligibleGuilds: [],
        csrfToken: 'csrf',
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
    toBrowserSession: (s: PortalSession | null) => (s ? { authenticated: true } : { authenticated: false }),
    safeEquals: (a: string, b: string) => a === b,
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

interface Achievement {
  id: string;
  status: string;
  unlocked: boolean;
  unlockedAt: string | null;
  name: string;
  description: string;
  hidden: boolean;
  progress: { current: number; target: number } | null;
}

async function getAchievements(guild: string, user: string) {
  const res = await api.inject({
    method: 'GET',
    url: `/api/v1/players/${pid(guild, user)}/achievements`,
    headers: asPortal(guild, user),
  });
  return res;
}

function byId(res: { json: () => unknown }): Map<string, Achievement> {
  const body = (res.json() as { data: { achievements: Achievement[] } }).data;
  return new Map(body.achievements.map((a) => [a.id, a]));
}

async function getLeaderboard(guild: string, user: string, query: string) {
  return api.inject({
    method: 'GET',
    url: `/api/v1/leaderboards${query}`,
    headers: asPortal(guild, user),
  });
}

describe('GET /players/:id/achievements — derived state + lazy unlock', () => {
  it('materialises no rows until the wall is read, then persists earned unlocks', async () => {
    const before = await t.db
      .select()
      .from(playerAchievements)
      .where(eq(playerAchievements.playerId, pid(GUILD_A, HERO)));
    expect(before.length).toBe(0);

    const res = await getAchievements(GUILD_A, HERO);
    expect(res.statusCode).toBe(200);

    const after = await t.db
      .select()
      .from(playerAchievements)
      .where(eq(playerAchievements.playerId, pid(GUILD_A, HERO)));
    expect(after.length).toBeGreaterThan(0);
  });

  it('reports unlocked, in-progress and locked correctly (backfill on first read)', async () => {
    const map = byId(await getAchievements(GUILD_A, HERO));
    // Progression: level 30 → level_10, level_25 unlocked; level_50 in progress.
    expect(map.get('level_25')!.unlocked).toBe(true);
    expect(map.get('level_50')!.status).toBe('in_progress');
    expect(map.get('level_50')!.progress).toEqual({ current: 30, target: 50 });
    // Hunts: 30 → hunter_1, hunter_2 unlocked; hunter_3 (100) shows real progress.
    expect(map.get('hunter_2')!.unlocked).toBe(true);
    expect(map.get('hunter_3')!.progress).toEqual({ current: 30, target: 100 });
    // Rarity: one of each captured.
    for (const id of ['rarity_sr', 'rarity_ssr', 'rarity_ur', 'rarity_lr']) {
      expect(map.get(id)!.unlocked).toBe(true);
    }
    // Collection: 12 distinct → collector_1 (10) yes, collector_2 (25) no.
    expect(map.get('collector_1')!.unlocked).toBe(true);
    expect(map.get('collector_2')!.unlocked).toBe(false);
    // Travel: one route → explorer_1 (2 regions) yes, explorer_2 (4) no.
    expect(map.get('explorer_1')!.unlocked).toBe(true);
    expect(map.get('explorer_2')!.unlocked).toBe(false);
  });

  it('keeps an unlocked achievement unlocked with a stable timestamp on re-read', async () => {
    const first = byId(await getAchievements(GUILD_A, HERO)).get('level_25')!;
    const second = byId(await getAchievements(GUILD_A, HERO)).get('level_25')!;
    expect(first.unlocked).toBe(true);
    expect(second.unlocked).toBe(true);
    expect(second.unlockedAt).toBe(first.unlockedAt);
  });

  it('does not falsely award a metric the player has not reached', async () => {
    // Rival captured only an SR — never SSR/UR/LR.
    const map = byId(await getAchievements(GUILD_A, RIVAL));
    expect(map.get('rarity_sr')!.unlocked).toBe(true);
    for (const id of ['rarity_ssr', 'rarity_ur', 'rarity_lr']) {
      expect(map.get(id)!.unlocked).toBe(false);
    }
  });

  it('hides a locked hidden achievement and leaks none of its criteria', async () => {
    const res = await getAchievements(GUILD_A, RIVAL); // affection 600 < 5000
    const map = byId(res);
    const secret = map.get('secret_devotion')!;
    expect(secret.unlocked).toBe(false);
    expect(secret.name).toBe('???');
    expect(secret.description).toBe('Hidden Achievement');
    expect(secret.progress).toBeNull();
    // The definition's real name and threshold never reach the wire.
    expect(res.body).not.toContain('Soulbound');
    expect(res.body).not.toContain('5000');
  });

  it('reveals a hidden achievement normally once unlocked', async () => {
    const secret = byId(await getAchievements(GUILD_A, HERO)).get('secret_devotion')!; // affection 5200
    expect(secret.unlocked).toBe(true);
    expect(secret.name).toBe('Soulbound');
    expect(secret.progress).toEqual({ current: 5000, target: 5000 });
  });

  it('reports correct summary counts', async () => {
    const res = await getAchievements(GUILD_A, HERO);
    const summary = (res.json() as { data: { summary: { total: number; unlocked: number; completionPercent: number } } })
      .data.summary;
    const map = byId(res);
    const unlockedCount = [...map.values()].filter((a) => a.unlocked).length;
    expect(summary.total).toBe(map.size);
    expect(summary.unlocked).toBe(unlockedCount);
    expect(summary.completionPercent).toBe(Math.round((unlockedCount / map.size) * 100));
  });

  it('is self-scoped: a session cannot read another player\'s wall', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${pid(GUILD_A, HERO)}/achievements`,
      headers: asPortal(GUILD_A, RIVAL),
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not leak cached data across a guild/user switch', async () => {
    const hero = byId(await getAchievements(GUILD_A, HERO));
    const novice = byId(await getAchievements(GUILD_A, NOVICE));
    expect(hero.get('level_25')!.unlocked).toBe(true);
    expect(novice.get('level_25')!.unlocked).toBe(false);
    expect(novice.get('hunter_1')!.unlocked).toBe(false);
  });
});

describe('public profile achievement summary', () => {
  it('shows only unlocked, non-hidden-locked badges to a guild-mate', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${pid(GUILD_A, HERO)}/public`,
      headers: asPortal(GUILD_A, RIVAL),
    });
    expect(res.statusCode).toBe(200);
    const summary = (res.json() as { data: { achievements: { unlocked: number; recent: { id: string }[] } } })
      .data.achievements;
    expect(summary.unlocked).toBeGreaterThan(0);
    // Recent only ever contains unlocked ids — never a locked one like collector_2.
    const heroWall = byId(await getAchievements(GUILD_A, HERO));
    for (const entry of summary.recent) {
      expect(heroWall.get(entry.id)!.unlocked).toBe(true);
    }
  });
});

interface LbEntry {
  rank: number;
  playerId: number;
  displayName: string;
  avatarUrl: string | null;
  isMe: boolean;
}

function entries(res: { json: () => unknown }): LbEntry[] {
  return (res.json() as { data: { entries: LbEntry[] } }).data.entries;
}

describe('GET /leaderboards — guild-scoped ranking', () => {
  it('ranks only the session\'s guild and excludes other guilds', async () => {
    const res = await getLeaderboard(GUILD_A, HERO, '?metric=trainer');
    expect(res.statusCode).toBe(200);
    const names = entries(res).map((e) => e.displayName);
    expect(names).toContain('Hero');
    expect(names).not.toContain('Stranger');
  });

  it('orders by the metric with competition ties and a deterministic tiebreak', async () => {
    const list = entries(await getLeaderboard(GUILD_A, HERO, '?metric=trainer'));
    // Hero 5000, Rival 3000, Twin 3000, Novice 0 → ranks 1, 2, 2, 4.
    const ranks = new Map(list.map((e) => [e.displayName, e.rank]));
    expect(ranks.get('Hero')).toBe(1);
    expect(ranks.get('Rival')).toBe(2);
    expect(ranks.get('Twin')).toBe(2);
    expect(ranks.get('Novice')).toBe(4);
    // Within the tie, ascending playerId decides presentation order (Rival was
    // provisioned before Twin), never the rank.
    const rivalIdx = list.findIndex((e) => e.displayName === 'Rival');
    const twinIdx = list.findIndex((e) => e.displayName === 'Twin');
    expect(rivalIdx).toBeLessThan(twinIdx);
  });

  it('never serialises the raw metric value', async () => {
    const res = await getLeaderboard(GUILD_A, HERO, '?metric=trainer');
    expect(res.body).not.toContain('5000');
    expect(res.body).not.toContain('"value"');
    expect(res.body).not.toContain('"xp"');
    for (const e of entries(res)) {
      expect(Object.keys(e).sort()).toEqual(
        ['avatarUrl', 'displayName', 'isMe', 'playerId', 'rank'].sort(),
      );
    }
  });

  it('returns me.rank inside the top N and flags the caller\'s own row', async () => {
    const res = await getLeaderboard(GUILD_A, HERO, '?metric=trainer&limit=25');
    const me = (res.json() as { data: { me: { rank: number } | null } }).data.me;
    expect(me).toEqual({ rank: 1 });
    const mine = entries(res).find((e) => e.isMe);
    expect(mine?.displayName).toBe('Hero');
  });

  it('returns me.rank even when the caller is outside the returned page', async () => {
    const res = await getLeaderboard(GUILD_A, NOVICE, '?metric=trainer&limit=1');
    expect(entries(res).length).toBe(1); // only the top player
    expect(entries(res)[0]!.displayName).toBe('Hero');
    const me = (res.json() as { data: { me: { rank: number } | null } }).data.me;
    expect(me).toEqual({ rank: 4 }); // Novice is last after the 2,2 tie
  });

  it('exposes playerId so a row can link to the existing public profile', async () => {
    const list = entries(await getLeaderboard(GUILD_A, HERO, '?metric=collector'));
    for (const e of list) expect(typeof e.playerId).toBe('number');
    // Hero owns the most distinct species → rank 1 on the collector board.
    expect(list[0]!.displayName).toBe('Hero');
  });

  it('ranks the legendary board by high-rarity captures', async () => {
    const list = entries(await getLeaderboard(GUILD_A, HERO, '?metric=legendary'));
    // Only Hero captured UR/LR copies.
    expect(list[0]!.displayName).toBe('Hero');
    expect(list[0]!.rank).toBe(1);
  });

  it('refuses a guild the session has not selected (no cross-guild enumeration)', async () => {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/leaderboards?metric=trainer&discordGuildId=${GUILD_B}`,
      headers: asPortal(GUILD_A, HERO),
    });
    expect(res.statusCode).toBe(403);
  });

  it('handles a minimal board (a guild with a single, zero-value player)', async () => {
    // Guild B has only Stranger; on the devoted board their affection is 0.
    const res = await getLeaderboard(GUILD_B, STRANGER, '?metric=devoted');
    expect(res.statusCode).toBe(200);
    const list = entries(res);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ rank: 1, displayName: 'Stranger', isMe: true });
    const me = (res.json() as { data: { me: { rank: number } | null } }).data.me;
    expect(me).toEqual({ rank: 1 });
  });

  it('answers a leaderboard in one database query (no N+1)', async () => {
    const pool = t.pool as unknown as { query: (...args: never[]) => unknown };
    const original = pool.query.bind(pool);
    let count = 0;
    pool.query = (...args: never[]) => {
      count += 1;
      return original(...args);
    };
    try {
      await getLeaderboard(GUILD_A, HERO, '?metric=trainer&limit=25');
    } finally {
      pool.query = original;
    }
    expect(count).toBe(1);
  });
});
