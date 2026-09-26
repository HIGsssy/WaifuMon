/**
 * `GET /players/:playerId/expeditions` against the real stack.
 *
 * The claims this file exists for:
 *
 *   - the read is **genuinely read-only** — a mission past its finish line is
 *     reported as ready to claim, but the database is byte-for-byte unchanged;
 *   - the boards are the canonical ones: equal to Discord's `getBoard` for the
 *     region the player is standing in, and to `buildBoard` everywhere else;
 *   - nothing internal leaves — no chance, no outcome, no payout, no mission
 *     key, no reward table;
 *   - a Portal session sees its own player and nobody else's.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import {
  playerCurrencies,
  playerExpeditions,
  playerInventory,
  playerWaifus,
  species,
} from '../../../src/db/schema';
import { buildBoard, orderBoardForDisplay } from '../../../src/modules/expeditions/expeditionBoard';
import {
  bootstrapApp,
  forceRegion,
  insertOwnedWaifus,
  provisionPlayer,
  unlockRoute,
  type App,
} from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const GUILD = '111222333444555666';
const MIKA = '777888999000111222';
const AIKO = '777888999000111333';

let t: TestDb;
let app: App;
let api: ZodFastify;
let mikaId: number;
let aikoId: number;
const playerIds: Record<string, number> = {};
let guildDbId: number;
/** Mika's copies: [valley, peeks, idle]. */
let mikaWaifus: number[];
let aikoWaifu: number;

function asPortal(user: string) {
  return { cookie: `wm_portal_session=${GUILD}:${user}` };
}

async function overview(user: string, playerId: number) {
  return api.inject({
    method: 'GET',
    url: `/api/v1/players/${playerId}/expeditions`,
    headers: asPortal(user),
  });
}

async function mine(): Promise<any> {
  const res = await overview(MIKA, mikaId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}

/** Every row a read could conceivably touch, for before/after comparison. */
async function snapshotState() {
  const ids = [mikaId, aikoId];
  return {
    expeditions: await t.db
      .select()
      .from(playerExpeditions)
      .where(inArray(playerExpeditions.playerId, ids))
      .orderBy(playerExpeditions.id),
    waifus: await t.db
      .select()
      .from(playerWaifus)
      .where(inArray(playerWaifus.playerId, ids))
      .orderBy(playerWaifus.id),
    currencies: await t.db
      .select()
      .from(playerCurrencies)
      .where(inArray(playerCurrencies.playerId, ids))
      .orderBy(playerCurrencies.playerId),
    inventory: await t.db
      .select()
      .from(playerInventory)
      .where(inArray(playerInventory.playerId, ids)),
  };
}

/** The canonical board for a region, straight from the pure generator. */
function canonicalOffers(playerId: number, regionId: string): string[] {
  const cfg = app.content.tables.expeditions;
  return orderBoardForDisplay(
    buildBoard({
      playerId,
      regionId,
      expeditions: app.content.expeditions,
      durations: Object.values(cfg.durations),
      boardSize: cfg.boardSize,
      rotationHours: cfg.rotationHours,
      now: new Date(),
    }),
  ).map((d) => d.name);
}

/** Every string value anywhere in a JSON body. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

/** Every key anywhere in a JSON body. */
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ guildDbId, playerId: mikaId } = await provisionPlayer(app, GUILD, MIKA));
  ({ playerId: aikoId } = await provisionPlayer(app, GUILD, AIKO));
  playerIds[MIKA] = mikaId;
  playerIds[AIKO] = aikoId;

  const [first, second, third] = await t.db
    .select()
    .from(species)
    .where(eq(species.enabled, true))
    .limit(3);
  const mikaRows = await insertOwnedWaifus(t.db, [
    { playerId: mikaId, speciesId: first!.id, level: 7, nickname: 'Valley Girl' },
    { playerId: mikaId, speciesId: second!.id, level: 12 },
    { playerId: mikaId, speciesId: third!.id, level: 3 },
  ]);
  mikaWaifus = mikaRows.map((r) => r.id);
  aikoWaifu = (
    await insertOwnedWaifus(t.db, [{ playerId: aikoId, speciesId: first!.id, level: 5 }])
  )[0]!.id;

  // Mika: Twin Peeks, Thirstlands and Base 80085 unlocked; Flaccid Foothills
  // locked. One mission in Waifu Valley (made overdue below), one in Twin
  // Peeks, and she ends up standing in Twin Peeks.
  for (const region of ['twin-peeks', 'thirstlands', 'base-80085']) {
    await unlockRoute(app, mikaId, region);
  }
  const valleyBoard = await app.expeditions.getBoard(mikaId);
  await app.expeditions.deploy(mikaId, valleyBoard.entries[0]!.definition.key, mikaWaifus[0]!);
  await forceRegion(t.db, mikaId, 'twin-peeks');
  const peeksBoard = await app.expeditions.getBoard(mikaId);
  await app.expeditions.deploy(mikaId, peeksBoard.entries[1]!.definition.key, mikaWaifus[1]!);

  await t.db
    .update(playerExpeditions)
    .set({ completesAt: sql`now() - interval '5 minutes'` })
    .where(eq(playerExpeditions.region, 'waifu-valley'));

  // Aiko has her own mission, which Mika must never see.
  const aikoBoard = await app.expeditions.getBoard(aikoId);
  await app.expeditions.deploy(aikoId, aikoBoard.entries[0]!.definition.key, aikoWaifu);

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
      sessions: stubSessions() as unknown as PortalSessionService,
    },
    ctx: { services: app, getContent: () => app.content },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

function stubSessions() {
  return {
    async getSession(token: string | undefined): Promise<PortalSession | null> {
      if (!token) return null;
      const [, user] = token.split(':');
      const playerId = user ? playerIds[user] : undefined;
      if (!playerId) return null;
      return {
        sessionDigest: token,
        discordUserId: user!,
        discordUsername: null,
        discordAvatarUrl: null,
        selectedDiscordGuildId: GUILD,
        selectedGuildDbId: guildDbId,
        playerId,
        eligibleGuilds: [],
        csrfToken: 'csrf',
        expiresAt: new Date(Date.now() + 60_000),
      } as PortalSession;
    },
    toBrowserSession: (s: PortalSession | null) => ({ authenticated: s != null }),
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

describe('GET /players/:playerId/expeditions — read-only', () => {
  it('writes nothing, even with an overdue mission in flight', async () => {
    const before = await snapshotState();
    // The overdue row really is overdue and really is still active.
    const valley = before.expeditions.find((r) => r.playerId === mikaId && r.region === 'waifu-valley')!;
    expect(valley.status).toBe('active');
    expect(valley.completesAt.getTime()).toBeLessThan(Date.now());

    for (let i = 0; i < 3; i++) await mine();
    const after = await snapshotState();
    expect(after).toEqual(before);
  });

  it('returns the same body on every refresh — no reroll', async () => {
    const a = await mine();
    const b = await mine();
    expect(b.regions).toEqual(a.regions);
    expect(b.rotatesAt).toBe(a.rotatesAt);
    expect(b.active.map((x: any) => x.name)).toEqual(a.active.map((x: any) => x.name));
  });
});

describe('active expeditions', () => {
  it('lists every open mission across regions with the assigned copy', async () => {
    const data = await mine();
    expect(data.active.map((a: any) => a.region)).toEqual(['twin-peeks', 'waifu-valley']);
    const [peeks, valley] = data.active;

    expect(peeks.waifu.waifu.id).toBe(mikaWaifus[1]);
    expect(peeks.waifu.waifu.level).toBe(12);
    expect(peeks.waifu.species.name).toBeTruthy();
    expect(peeks.waifu.waifu.selectedAppearance).toBeTruthy();
    expect(valley.waifuName).toBe('Valley Girl');
    expect(valley.waifu.waifu.id).toBe(mikaWaifus[0]);
    expect(valley.regionName).toBe('Waifu Valley');
  });

  it('reports a running mission as underway with a real countdown', async () => {
    const peeks = (await mine()).active.find((a: any) => a.region === 'twin-peeks');
    expect(peeks.status).toBe('active');
    expect(peeks.isDue).toBe(false);
    expect(peeks.readyToClaim).toBe(false);
    expect(peeks.secondsRemaining).toBeGreaterThan(0);
    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.region, 'twin-peeks'));
    // Duration is the snapshot's; the timestamps are the row's.
    expect(peeks.durationMinutes).toBe(
      Math.round((row!.completesAt.getTime() - row!.startedAt.getTime()) / 60_000),
    );
    expect(new Date(peeks.completesAt).getTime()).toBe(row!.completesAt.getTime());
    expect(new Date(peeks.startedAt).getTime()).toBe(row!.startedAt.getTime());
    // Match quality is the one persisted at deployment.
    expect(peeks.match).toBe(row!.suitabilityBand);
  });

  it('reports an overdue mission as ready to claim without resolving it', async () => {
    const valley = (await mine()).active.find((a: any) => a.region === 'waifu-valley');
    expect(valley.status).toBe('active');
    expect(valley.isDue).toBe(true);
    expect(valley.readyToClaim).toBe(true);
    expect(valley.secondsRemaining).toBe(0);
  });

  it("never includes another player's missions", async () => {
    const data = await mine();
    expect(data.active.some((a: any) => a.waifu?.waifu.id === aikoWaifu)).toBe(false);
    expect(data.active).toHaveLength(2);
  });
});

describe('regional boards', () => {
  it('lists current then unlocked regions in travel order, and no locked ones', async () => {
    const data = await mine();
    const status = await app.travel.getStatus(mikaId);
    const travelOrder = status.destinations
      .filter((d) => d.state === 'unlocked')
      .map((d) => d.regionId);
    expect(data.currentRegion).toBe('twin-peeks');
    expect(data.regions.map((r: any) => r.regionId)).toEqual(['twin-peeks', ...travelOrder]);
    expect(travelOrder).toEqual(
      expect.arrayContaining(['waifu-valley', 'thirstlands', 'base-80085']),
    );
    expect(data.regions.map((r: any) => r.regionId)).not.toContain('flaccid-foothills');
    expect(data.regions.filter((r: any) => r.isCurrent).map((r: any) => r.regionId)).toEqual([
      'twin-peeks',
    ]);
  });

  it('marks occupied regions by the canonical open-mission rule', async () => {
    const byId = Object.fromEntries((await mine()).regions.map((r: any) => [r.regionId, r]));
    expect(byId['twin-peeks'].occupied).toBe(true);
    expect(byId['waifu-valley'].occupied).toBe(true);
    expect(byId['thirstlands'].occupied).toBe(false);
  });

  it('serves the canonical board for every region, with duration and planning detail', async () => {
    const data = await mine();
    for (const region of data.regions) {
      expect(region.offers.map((o: any) => o.name)).toEqual(canonicalOffers(mikaId, region.regionId));
    }
    const peeks = data.regions.find((r: any) => r.regionId === 'twin-peeks');
    expect(peeks.offers.length).toBeGreaterThan(0);
    const minutes = peeks.offers.map((o: any) => o.durationMinutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
    const defs = new Map(app.content.expeditions.map((e) => [e.name, e]));
    for (const offer of peeks.offers) {
      const def = defs.get(offer.name)!;
      expect(offer).toEqual({
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        type: def.type,
        durationMinutes: def.durationMinutes,
        recommendedLevel: def.recommendedLevel,
        preferredAffinities: def.preferredAffinities,
        preferredRaces: def.preferredRaces,
        rewardPreview: def.rewardPreview,
      });
    }
  });

  it('shows an unlocked region with no expedition content as an empty board', async () => {
    const base = (await mine()).regions.find((r: any) => r.regionId === 'base-80085');
    expect(base.offers).toEqual([]);
  });

  it('carries a single epoch-aligned rotation time', async () => {
    const data = await mine();
    const hours = app.content.tables.expeditions.rotationHours;
    const window = hours * 3_600_000;
    expect(new Date(data.rotatesAt).getTime() % window).toBe(0);
    expect(new Date(data.rotatesAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('nothing internal leaves', () => {
  it('exposes no chance, outcome, payout, key, table or row id', async () => {
    const data = await mine();
    const keys = keysIn({ active: data.active.map(({ waifu: _w, ...rest }: any) => rest), regions: data.regions });
    for (const forbidden of [
      'successChance',
      'exceptionalChance',
      'resolutionRoll',
      'outcome',
      'rewards',
      'expeditionKey',
      'key',
      'id',
      'slotIndex',
      'waifuId',
      'rewardTable',
      'exceptionalRewardTable',
      'failureRewardTable',
      'baseSuccessChance',
      'resolutionPlan',
      'factors',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    const strings = new Set(stringsIn(data));
    for (const def of app.content.expeditions) expect(strings.has(def.key), def.key).toBe(false);
    for (const table of app.content.expeditionRewards) {
      expect(strings.has(table.id), table.id).toBe(false);
    }
  });
});

describe('authorization', () => {
  it("refuses a Portal session asking for another player's expeditions", async () => {
    const res = await overview(MIKA, aikoId);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Valley');
  });

  it('lets each player read their own', async () => {
    const res = await overview(AIKO, aikoId);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.active).toHaveLength(1);
    expect(data.active[0].waifu.waifu.id).toBe(aikoWaifu);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await api.inject({ method: 'GET', url: `/api/v1/players/${mikaId}/expeditions` });
    expect(res.statusCode).toBe(401);
  });
});

describe('route surface', () => {
  it('registers GET only — no Portal gameplay endpoint for expeditions', async () => {
    const res = await api.inject({
      method: 'GET',
      url: '/api/v1/openapi.json',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    const paths = res.json().paths as Record<string, Record<string, unknown>>;
    const expeditionPaths = Object.entries(paths).filter(([p]) => p.includes('expedition'));
    expect(expeditionPaths.map(([p]) => p)).toEqual(['/api/v1/players/{playerId}/expeditions']);
    for (const [, methods] of expeditionPaths) expect(Object.keys(methods)).toEqual(['get']);

    // Bearer rather than a Portal cookie: a cookie-authenticated write is
    // refused by the CSRF guard before routing, which would hide a real route.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await api.inject({
        method,
        url: `/api/v1/players/${mikaId}/expeditions`,
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.statusCode, method).toBe(404);
    }
  });
});

describe('after Discord resolves the overdue mission', () => {
  it('Discord board for the current region equals the Portal board', async () => {
    // Discord's own read — which *does* resolve, as it always has.
    const board = await app.expeditions.getBoard(mikaId);
    const data = await mine();
    const current = data.regions.find((r: any) => r.isCurrent);
    expect(current.regionId).toBe(board.regionId);
    expect(current.offers.map((o: any) => o.name)).toEqual(
      board.entries.map((e) => e.definition.name),
    );
    expect(current.occupied).toBe(board.regionMission != null);
  });

  it('shows the resolved mission as ready to claim, still without its result', async () => {
    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.region, 'waifu-valley'))
      .orderBy(playerExpeditions.id)
      .limit(1);
    expect(row!.status).toBe('resolved');
    expect(row!.rewards).not.toBeNull();

    const data = await mine();
    const valley = data.active.find((a: any) => a.region === 'waifu-valley');
    expect(valley.status).toBe('resolved');
    expect(valley.readyToClaim).toBe(true);
    expect(valley).not.toHaveProperty('outcome');
    expect(valley).not.toHaveProperty('rewards');
  });
});
