/**
 * Patch's Workshop routes against the real stack: real database, the real
 * Workshop / equipment / reward services, the shipped `workshop.json`, and
 * Portal browser sessions (cookie + CSRF) — the way the Portal calls them.
 *
 * Pinned: the unlock gate, self-only scope and CSRF on every write, the
 * overview read model (balances, yields, recipes, live slot availability,
 * nothing internal), the Gear Bag's server-decided dismantle eligibility,
 * preview → confirm, refusal details, idempotent retries, and fabrication.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { playerCurrencies, playerEquipment } from '../../../src/db/schema';
import { createCombatStatsService } from '../../../src/modules/equipment/combatStatsService';
import { createEquipmentManagementService } from '../../../src/modules/equipment/equipmentManagementService';
import { createEquipmentWorkshopService } from '../../../src/modules/equipment/equipmentWorkshopService';
import { bootstrapApp, provisionPlayer, type App } from '../../helpers/fixtures';
import { GEAR, fixedRange, grant, unlockEquipment } from '../../helpers/equipmentFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

let t: TestDb;
let app: App;
let api: ZodFastify;

/** A private assets root: a Workshop image and a Patch portrait, nothing else. */
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-workshop-api-'));
const WORKSHOP_BYTES = Buffer.from('RIFF-workshop-webp');
const PORTRAIT_BYTES = Buffer.from('PNG-patch-portrait');
fs.mkdirSync(path.join(assetsDir, 'equipment', 'workshop'), { recursive: true });
fs.mkdirSync(path.join(assetsDir, 'npcs'), { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'equipment', 'workshop', 'patch-workshop.webp'), WORKSHOP_BYTES);
fs.writeFileSync(path.join(assetsDir, 'npcs', 'patch.png'), PORTRAIT_BYTES);

const sessions = new Map<string, { playerId: number; guildDbId: number }>();

interface Player {
  playerId: number;
  token: string;
}

function stubSessions() {
  return {
    async getSession(token: string | undefined): Promise<PortalSession | null> {
      const s = token ? sessions.get(token) : undefined;
      if (!token || !s) return null;
      const [guild, user] = token.split(':');
      return {
        sessionDigest: token,
        discordUserId: user!,
        discordUsername: null,
        discordAvatarUrl: null,
        selectedDiscordGuildId: guild!,
        selectedGuildDbId: s.guildDbId,
        playerId: s.playerId,
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

function headers(p: Player, opts: { csrf?: boolean } = {}) {
  return opts.csrf === false
    ? { cookie: `wm_portal_session=${p.token}` }
    : { cookie: `wm_portal_session=${p.token}; wm_portal_csrf=csrf`, 'x-portal-csrf': 'csrf' };
}

async function call(
  p: Player,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts: { csrf?: boolean; as?: number } = {},
) {
  const res = await api.inject({
    method,
    url: `/api/v1/players/${opts.as ?? p.playerId}/equipment${path}`,
    headers: headers(p, opts),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as any, raw: res.body };
}

let seq = 0;
async function newPlayer(opts: { unlocked?: boolean; components?: number; waifubux?: number } = {}): Promise<Player> {
  seq += 1;
  const guild = `g-wsp-${seq}`;
  const user = `u-wsp-${seq}`;
  const { playerId, guildDbId } = await provisionPlayer(app, guild, user);
  const token = `${guild}:${user}`;
  sessions.set(token, { playerId, guildDbId });
  if (opts.unlocked !== false) await unlockEquipment(t.db, app.gear, playerId);
  await t.db
    .update(playerCurrencies)
    .set({ salvagedComponents: opts.components ?? 0, waifubux: opts.waifubux ?? 0 })
    .where(eq(playerCurrencies.playerId, playerId));
  return { playerId, token };
}

const give = (p: Player, key: string) => grant(t.db, app.gear, p.playerId, key);
let keySeq = 0;
const requestKey = () => `portal-test-${++keySeq}-${Date.now()}`;

async function balances(p: Player) {
  const [row] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, p.playerId));
  return { components: row!.salvagedComponents, waifubux: row!.waifubux };
}

async function liveIds(ids: number[]) {
  const rows = await t.db.select().from(playerEquipment).where(inArray(playerEquipment.id, ids));
  return rows.filter((r) => r.removedAt == null).map((r) => r.id).sort((a, b) => a - b);
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  for (const g of [GEAR.attack, GEAR.attack2, GEAR.defense, GEAR.health]) await app.gear.definitions.create(g);
  await app.gear.definitions.create({ key: 'test_knife', name: 'Test Knife', slot: 'attack', rarity: 'R', ...fixedRange(7_000) });
  await app.gear.definitions.create({ key: 'test_relic', name: 'Test Relic', slot: 'attack', rarity: 'SSR', ...fixedRange(9_500) });

  const combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: app.gear.getAffixes,
  });
  const equipmentManagement = createEquipmentManagementService({
    equipment: app.gear.equipment,
    combatStats: combat,
    featureUnlocks: app.gear.featureUnlocks,
  });
  const equipmentWorkshop = createEquipmentWorkshopService({
    db: t.db,
    featureUnlocks: app.gear.featureUnlocks,
    equipment: app.gear.equipment,
    equipmentRewards: app.equipmentRewards,
    currency: app.currency,
    getAffixes: app.gear.getAffixes,
    getConfig: () => app.content.equipmentWorkshop ?? null,
  });

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3178, token: TEST_TOKEN },
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
    ctx: {
      services: {
        ...app,
        equipment: app.gear.equipment,
        featureUnlocks: app.gear.featureUnlocks,
        combatStats: combat,
        equipmentManagement,
        equipmentWorkshop,
      } as never,
      getContent: () => app.content,
      assetsDir,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t?.cleanup();
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

/* ─────────────────────────── gate and scope ─────────────────────────── */

describe('access', () => {
  it('a locked player is refused by every Workshop route, and nothing changes', async () => {
    const p = await newPlayer({ unlocked: false, components: 50, waifubux: 5_000 });
    const ring = await give(p, 'training_ring');
    for (const res of [
      await call(p, 'GET', '/workshop'),
      await call(p, 'POST', '/workshop/dismantle/preview', { equipmentIds: [ring] }),
      await call(p, 'POST', '/workshop/dismantle', { equipmentIds: [ring], requestKey: requestKey() }),
      await call(p, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: requestKey() }),
    ]) {
      expect(res.status, res.raw).toBe(422);
      expect(res.body.error.code).toBe('FEATURE_LOCKED');
    }
    expect(await liveIds([ring])).toEqual([ring]);
    expect(await balances(p)).toEqual({ components: 50, waifubux: 5_000 });
  });

  it('a session cannot address another player’s Workshop', async () => {
    const p = await newPlayer();
    const other = await newPlayer({ components: 50, waifubux: 5_000 });
    const theirs = await give(other, 'training_ring');
    for (const res of [
      await call(p, 'GET', '/workshop', undefined, { as: other.playerId }),
      await call(p, 'POST', '/workshop/dismantle/preview', { equipmentIds: [theirs] }, { as: other.playerId }),
      await call(p, 'POST', '/workshop/dismantle', { equipmentIds: [theirs], requestKey: requestKey() }, { as: other.playerId }),
      await call(
        p,
        'POST',
        '/workshop/fabricate',
        { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: requestKey() },
        { as: other.playerId },
      ),
    ]) {
      expect(res.status, res.raw).toBe(403);
    }
    expect(await liveIds([theirs])).toEqual([theirs]);
    expect(await balances(other)).toEqual({ components: 50, waifubux: 5_000 });
  });

  it('your own session cannot dismantle someone else’s copy by id', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    const theirs = await give(other, 'training_ring');
    const res = await call(p, 'POST', '/workshop/dismantle', { equipmentIds: [theirs], requestKey: requestKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.details.problems).toEqual([{ id: theirs, reason: 'not_owned' }]);
    expect(await liveIds([theirs])).toEqual([theirs]);
  });

  it('writes without the CSRF token are refused', async () => {
    const p = await newPlayer({ components: 50, waifubux: 5_000 });
    const ring = await give(p, 'training_ring');
    const dismantle = await call(p, 'POST', '/workshop/dismantle', { equipmentIds: [ring], requestKey: requestKey() }, { csrf: false });
    const fabricate = await call(
      p,
      'POST',
      '/workshop/fabricate',
      { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: requestKey() },
      { csrf: false },
    );
    expect([dismantle.status, fabricate.status]).toEqual([403, 403]);
    expect(await liveIds([ring])).toEqual([ring]);
    expect(await balances(p)).toEqual({ components: 50, waifubux: 5_000 });
  });
});

/* ─────────────────────────── overview ─────────────────────────── */

describe('GET /workshop', () => {
  it('shows balances, yields and recipes with backend-decided availability', async () => {
    const p = await newPlayer({ components: 18, waifubux: 4_250 });
    const res = await call(p, 'GET', '/workshop');
    expect(res.status, res.raw).toBe(200);
    const data = res.body.data;
    expect(data.balances).toEqual({ components: 18, waifubux: 4_250 });
    expect(data.salvageYields).toEqual([
      { rarity: 'N', components: 1 },
      { rarity: 'R', components: 4 },
      { rarity: 'SR', components: 12 },
    ]);
    expect(data.recipes.map((r: any) => [r.key, r.name, r.rarity, r.componentCost, r.waifubuxCost])).toEqual([
      ['standard_rebuild', 'Standard Rebuild', 'N', 5, 250],
      ['improved_rebuild', 'Improved Rebuild', 'R', 15, 750],
      ['advanced_rebuild', 'Advanced Rebuild', 'SR', 40, 2000],
    ]);
    const improved = data.recipes.find((r: any) => r.key === 'improved_rebuild');
    expect(improved.slots).toEqual([
      { choice: 'attack', eligibleCount: 1, available: true },
      { choice: 'defense', eligibleCount: 0, available: false },
      { choice: 'health', eligibleCount: 0, available: false },
      { choice: 'any', eligibleCount: 1, available: true },
    ]);
    expect(data.recipes.find((r: any) => r.key === 'advanced_rebuild')).toMatchObject({
      affordable: false,
      shortfall: { components: 22, waifubux: 0 },
    });
  });

  it('never carries definition keys, affix keys, basis points or grant keys', async () => {
    const p = await newPlayer();
    const res = await call(p, 'GET', '/workshop');
    for (const leak of ['training_ring', 'test_knife', 'flair', 'Bp', 'grant', '7000', 'workshop:']) {
      expect(res.raw).not.toContain(leak);
    }
  });
});

/* ─────────────────────────── Gear Bag eligibility ─────────────────────────── */

describe('Gear Bag salvage eligibility', () => {
  it('is decided by the server for every copy', async () => {
    const p = await newPlayer();
    const free = await give(p, 'test_knife');
    const fav = await give(p, 'padded_belt');
    const relic = await give(p, 'test_relic');
    const equipped = await give(p, 'training_ring');
    await app.gear.equipment.setFlags(p.playerId, fav, { isFavorite: true });
    await app.gear.equipment.equip(p.playerId, { slot: 'attack', equipmentId: equipped });
    const res = await call(p, 'GET', '/items?limit=50');
    const byId = Object.fromEntries(res.body.data.items.map((i: any) => [i.id, i.salvage]));
    expect(byId[free]).toEqual({ components: 4, blockedBy: null });
    expect(byId[fav]).toEqual({ components: 1, blockedBy: 'favorite' });
    expect(byId[relic]).toEqual({ components: null, blockedBy: 'unsupported_rarity' });
    expect(byId[equipped]).toEqual({ components: 1, blockedBy: 'equipped' });
  });
});

/* ─────────────────────────── dismantle ─────────────────────────── */

describe('dismantle', () => {
  it('previews, then dismantles exactly what was reviewed', async () => {
    const p = await newPlayer({ components: 2 });
    const ids = [await give(p, 'training_ring'), await give(p, 'padded_belt'), await give(p, 'test_knife')];
    const preview = await call(p, 'POST', '/workshop/dismantle/preview', { equipmentIds: ids });
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body.data).toMatchObject({
      count: 3,
      byRarity: [
        { rarity: 'N', count: 2, components: 2 },
        { rarity: 'R', count: 1, components: 4 },
      ],
      totalComponents: 6,
      balances: { components: 2 },
      componentsAfter: 8,
    });
    expect(preview.body.data.items.map((i: any) => i.name).sort()).toEqual(['Padded Belt', 'Test Knife', 'Training Ring']);
    expect(await liveIds(ids)).toEqual([...ids].sort((a, b) => a - b));

    const key = requestKey();
    const res = await call(p, 'POST', '/workshop/dismantle', { equipmentIds: ids, requestKey: key, expectedComponents: 6 });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ replayed: false, count: 3, totalComponents: 6, balances: { components: 8 } });
    expect(await liveIds(ids)).toEqual([]);

    // The Gear Bag no longer lists them.
    const bag = await call(p, 'GET', '/items?limit=50');
    expect(bag.body.data.items).toEqual([]);

    // A retry replays — no further credit.
    const retry = await call(p, 'POST', '/workshop/dismantle', { equipmentIds: ids, requestKey: key, expectedComponents: 6 });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ replayed: true, totalComponents: 6, balances: { components: 8 } });
    expect((await balances(p)).components).toBe(8);
  });

  it('refuses a protected copy with details and destroys nothing', async () => {
    const p = await newPlayer();
    const free = await give(p, 'training_ring');
    const locked = await give(p, 'padded_belt');
    await app.gear.equipment.setFlags(p.playerId, locked, { isLocked: true });
    for (const path of ['/workshop/dismantle/preview', '/workshop/dismantle']) {
      const res = await call(p, 'POST', path, { equipmentIds: [free, locked], requestKey: requestKey() });
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe('EQUIPMENT_DISMANTLE_REFUSED');
      expect(res.body.error.details.problems).toEqual([{ id: locked, reason: 'locked' }]);
    }
    expect(await liveIds([free, locked])).toEqual([free, locked].sort((a, b) => a - b));
  });

  it('a stale confirmation (favourited after review) fails safely', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    const preview = await call(p, 'POST', '/workshop/dismantle/preview', { equipmentIds: [ring] });
    expect(preview.status).toBe(200);
    await app.gear.equipment.setFlags(p.playerId, ring, { isFavorite: true });
    const res = await call(p, 'POST', '/workshop/dismantle', {
      equipmentIds: [ring],
      requestKey: requestKey(),
      expectedComponents: preview.body.data.totalComponents,
    });
    expect(res.status).toBe(409);
    expect(await liveIds([ring])).toEqual([ring]);
  });

  it('validates the request shape', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    for (const body of [
      { equipmentIds: [], requestKey: requestKey() },
      { equipmentIds: Array.from({ length: 51 }, (_, i) => i + 1), requestKey: requestKey() },
      { equipmentIds: [ring], requestKey: 'short' },
      { equipmentIds: [ring], requestKey: 'has spaces in it' },
      { equipmentIds: ['1'], requestKey: requestKey() },
    ]) {
      const res = await call(p, 'POST', '/workshop/dismantle', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await liveIds([ring])).toEqual([ring]);
  });

  it('refuses a duplicate id', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    const res = await call(p, 'POST', '/workshop/dismantle', { equipmentIds: [ring, ring], requestKey: requestKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.details.problems).toEqual([{ id: ring, reason: 'duplicate' }]);
  });
});

/* ─────────────────────────── fabricate ─────────────────────────── */

describe('fabricate', () => {
  it('charges once and reveals the item without internal keys', async () => {
    const p = await newPlayer({ components: 20, waifubux: 1_000 });
    const key = requestKey();
    const res = await call(p, 'POST', '/workshop/fabricate', { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toEqual({
      replayed: false,
      recipe: { key: 'improved_rebuild', name: 'Improved Rebuild', rarity: 'R' },
      slotChoice: 'attack',
      cost: { components: 15, waifubux: 750 },
      item: {
        id: expect.any(Number),
        name: 'Test Knife of Attack R Flair',
        baseName: 'Test Knife',
        slot: 'attack',
        rarity: 'R',
        multiplier: 0.7,
        affix: 'of Attack R Flair',
        // The test services deploy no combat-bonus catalogue, so nothing is rolled.
        combatBonuses: [],
      },
      balances: { components: 5, waifubux: 250 },
    });
    expect(res.raw).not.toContain('test_knife');
    expect(res.raw).not.toContain('attack_r_flair');

    // Retry: the same item, charged once.
    const retry = await call(p, 'POST', '/workshop/fabricate', { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key });
    expect(retry.body.data.replayed).toBe(true);
    expect(retry.body.data.item).toEqual(res.body.data.item);
    expect(await balances(p)).toEqual({ components: 5, waifubux: 250 });

    // It is ordinary gear: listed, labelled as fabricated.
    const detail = await call(p, 'GET', `/items/${res.body.data.item.id}`);
    expect(detail.body.data.item).toMatchObject({ name: 'Test Knife of Attack R Flair', source: 'Fabricated by Patch' });
  });

  it('refuses unaffordable and unavailable orders before charging', async () => {
    const poor = await newPlayer({ components: 14, waifubux: 10_000 });
    const noComponents = await call(poor, 'POST', '/workshop/fabricate', { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: requestKey() });
    expect([noComponents.status, noComponents.body.error.code]).toEqual([422, 'INSUFFICIENT_COMPONENTS']);

    const broke = await newPlayer({ components: 100, waifubux: 249 });
    const noBux = await call(broke, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: requestKey() });
    expect([noBux.status, noBux.body.error.code]).toEqual([422, 'INSUFFICIENT_FUNDS']);

    const rich = await newPlayer({ components: 100, waifubux: 10_000 });
    const noHealth = await call(rich, 'POST', '/workshop/fabricate', { recipeKey: 'improved_rebuild', slot: 'health', requestKey: requestKey() });
    expect([noHealth.status, noHealth.body.error.code]).toEqual([422, 'WORKSHOP_NO_ELIGIBLE_EQUIPMENT']);
    const unknown = await call(rich, 'POST', '/workshop/fabricate', { recipeKey: 'mystery_rebuild', slot: 'attack', requestKey: requestKey() });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'WORKSHOP_RECIPE_UNAVAILABLE']);
    const badSlot = await call(rich, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'relic', requestKey: requestKey() });
    expect(badSlot.status).toBe(400);

    expect(await balances(poor)).toEqual({ components: 14, waifubux: 10_000 });
    expect(await balances(broke)).toEqual({ components: 100, waifubux: 249 });
    expect(await balances(rich)).toEqual({ components: 100, waifubux: 10_000 });
  });

  it('concurrent orders cannot overspend', async () => {
    const p = await newPlayer({ components: 5, waifubux: 1_000 });
    const results = await Promise.all(
      [0, 1].map(() =>
        call(p, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'any', requestKey: requestKey() }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await balances(p)).toEqual({ components: 0, waifubux: 750 });
  });

  it('a request key reused for a different order is a conflict', async () => {
    const p = await newPlayer({ components: 20, waifubux: 1_000 });
    const key = requestKey();
    await call(p, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: key });
    const res = await call(p, 'POST', '/workshop/fabricate', { recipeKey: 'standard_rebuild', slot: 'defense', requestKey: key });
    expect([res.status, res.body.error.code]).toEqual([409, 'WORKSHOP_REQUEST_CONFLICT']);
    expect(await balances(p)).toEqual({ components: 15, waifubux: 750 });
  });
});

/* ─────────────────────────── artwork ─────────────────────────── */

describe('Workshop artwork', () => {
  /** Point the live content at an image (or none) for one test, then restore it. */
  async function withArt(
    artworkPath: string | null,
    portraitPath: string | null,
    run: () => Promise<void>,
  ): Promise<void> {
    const config = app.content.equipmentWorkshop!;
    const npcs = app.content.npcs;
    const before = config.artworkPath;
    config.artworkPath = artworkPath;
    app.content.npcs = (npcs ?? []).map((n) => (n.key === 'patch' ? { ...n, portraitPath } : n));
    try {
      await run();
    } finally {
      config.artworkPath = before;
      app.content.npcs = npcs;
    }
  }

  async function bytes(p: Player) {
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${p.playerId}/equipment/workshop/artwork`,
      headers: headers(p),
    });
    return res;
  }

  it('with no image configured the overview is text-only and the artwork route 404s', async () => {
    const p = await newPlayer();
    await withArt(null, null, async () => {
      expect((await call(p, 'GET', '/workshop')).body.data.artwork).toBeNull();
      expect((await bytes(p)).statusCode).toBe(404);
    });
  });

  it('serves the configured Workshop artwork, which wins over Patch’s portrait', async () => {
    const p = await newPlayer();
    await withArt('equipment/workshop/patch-workshop.webp', 'npcs/patch.png', async () => {
      const overview = await call(p, 'GET', '/workshop');
      expect(overview.body.data.artwork).toEqual({ source: 'workshop' });
      // A source, never a path.
      expect(overview.raw).not.toContain('equipment/workshop');
      expect(overview.raw).not.toContain('npcs/patch');
      const res = await bytes(p);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toContain('private');
      expect(res.rawPayload.equals(WORKSHOP_BYTES)).toBe(true);
      const again = await api.inject({
        method: 'GET',
        url: `/api/v1/players/${p.playerId}/equipment/workshop/artwork`,
        headers: { ...headers(p), 'if-none-match': String(res.headers.etag) },
      });
      expect(again.statusCode).toBe(304);
    });
  });

  it('falls back to Patch’s portrait when the Workshop file is missing or unsafe', async () => {
    const p = await newPlayer();
    for (const artworkPath of ['equipment/workshop/not-there.webp', '../outside.webp', null]) {
      await withArt(artworkPath, 'npcs/patch.png', async () => {
        expect((await call(p, 'GET', '/workshop')).body.data.artwork).toEqual({ source: 'patch' });
        const res = await bytes(p);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.rawPayload.equals(PORTRAIT_BYTES)).toBe(true);
      });
    }
  });

  it('nothing on disk is text-only, and the Workshop still works', async () => {
    const p = await newPlayer();
    await withArt('equipment/workshop/gone.webp', 'npcs/gone.png', async () => {
      const res = await call(p, 'GET', '/workshop');
      expect(res.status).toBe(200);
      expect(res.body.data.artwork).toBeNull();
      expect(res.body.data.recipes).toHaveLength(3);
      expect((await bytes(p)).statusCode).toBe(404);
    });
  });

  it('is unlock-gated and self-only', async () => {
    const locked = await newPlayer({ unlocked: false });
    const p = await newPlayer();
    const other = await newPlayer();
    await withArt('equipment/workshop/patch-workshop.webp', null, async () => {
      const lockedRes = await bytes(locked);
      expect(lockedRes.statusCode).toBe(422);
      const foreign = await api.inject({
        method: 'GET',
        url: `/api/v1/players/${other.playerId}/equipment/workshop/artwork`,
        headers: headers(p),
      });
      expect(foreign.statusCode).toBe(403);
    });
  });
});
