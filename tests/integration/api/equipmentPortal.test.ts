/**
 * Portal Equipment management routes against the real stack: real database,
 * real equipment / combat-stat / management services, and Portal browser
 * sessions (cookie + CSRF) rather than the shared bearer token — the way the
 * Portal actually calls them.
 *
 * What is pinned: the unlock gate on every route, self-only scope, bounded and
 * validated paging, display-name search (suffix included, keys excluded),
 * authoritative stats and previews, equip / unequip / flag semantics, and the
 * stale-slot conflict.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PortalSession, PortalSessionService } from '../../../src/api/portalSession';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { playerLoadoutSlots, playerLoadouts, players, species as speciesTable } from '../../../src/db/schema';
import { createCombatStatsService, type CombatStatsService } from '../../../src/modules/equipment/combatStatsService';
import { createEquipmentManagementService } from '../../../src/modules/equipment/equipmentManagementService';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../../helpers/fixtures';
import { GEAR, grant, unlockEquipment } from '../../helpers/equipmentFixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

let t: TestDb;
let app: App;
let api: ZodFastify;
let combat: CombatStatsService;
let speciesId: number;

/** session token (`guild:user`) → the player and guild it signs in as. */
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

async function call(p: Player, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, opts: { csrf?: boolean; as?: number } = {}) {
  const res = await api.inject({
    method,
    url: `/api/v1/players/${opts.as ?? p.playerId}/equipment${path}`,
    headers: headers(p, opts),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() as any, raw: res.body };
}

let seq = 0;
async function newPlayer(opts: { unlocked?: boolean; buddy?: boolean } = {}): Promise<Player> {
  seq += 1;
  const guild = `g-eqp-${seq}`;
  const user = `u-eqp-${seq}`;
  const { playerId, guildDbId } = await provisionPlayer(app, guild, user);
  const token = `${guild}:${user}`;
  sessions.set(token, { playerId, guildDbId });
  if (opts.buddy !== false) {
    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 420, nickname: 'Warband Princess' });
    await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  }
  if (opts.unlocked !== false) await unlockEquipment(t.db, app.gear, playerId);
  return { playerId, token };
}

/**
 * The standard bag (granted oldest → newest):
 *   ring    Training Ring          attack  N   ×0.50  equipped
 *   belt    Padded Belt            defense N   ×0.40  equipped
 *   plasma  Plasma Coil Ring       attack  SR  ×0.86
 *   pipe    Rusty Test Pipe of Poor Planning  attack N ×0.55 (range 0.40–0.60 → 75%)
 *   pipe2   Rusty Test Pipe        attack  N   ×0.40 (0%)
 *   harness Basic Harness          health  N   ×2.00  (health slot left empty)
 */
async function stockBag(p: Player) {
  const id = {
    ring: await grant(t.db, app.gear, p.playerId, 'training_ring'),
    belt: await grant(t.db, app.gear, p.playerId, 'padded_belt'),
    plasma: await grant(t.db, app.gear, p.playerId, 'plasma_coil_ring'),
    pipe: await grant(t.db, app.gear, p.playerId, 'rusty_test_pipe', {
      roll: { kind: 'fixed', rolledMultiplierBp: 5_500, affixKey: 'poor_planning' },
    }),
    pipe2: await grant(t.db, app.gear, p.playerId, 'rusty_test_pipe', {
      roll: { kind: 'fixed', rolledMultiplierBp: 4_000, affixKey: null },
    }),
    harness: await grant(t.db, app.gear, p.playerId, 'basic_harness'),
  };
  await app.gear.equipment.equip(p.playerId, { slot: 'attack', equipmentId: id.ring });
  await app.gear.equipment.equip(p.playerId, { slot: 'defense', equipmentId: id.belt });
  return id;
}

async function slotRows(playerId: number): Promise<Record<string, number>> {
  const rows = await t.db
    .select({ slot: playerLoadoutSlots.slot, equipmentId: playerLoadoutSlots.equipmentId })
    .from(playerLoadoutSlots)
    .innerJoin(playerLoadouts, eq(playerLoadouts.id, playerLoadoutSlots.loadoutId))
    .where(and(eq(playerLoadoutSlots.playerId, playerId), eq(playerLoadouts.isActive, true)));
  return Object.fromEntries(rows.map((r) => [r.slot, r.equipmentId]));
}

async function listAll(p: Player, query: string): Promise<any[]> {
  const res = await call(p, 'GET', `/items?${query}`);
  expect(res.status, res.raw).toBe(200);
  return res.body.data.items;
}

const names = (items: any[]) => items.map((i) => i.name);

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  for (const g of [GEAR.attack, GEAR.attack2, GEAR.defense, GEAR.health, GEAR.ranged]) await app.gear.definitions.create(g);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;

  combat = createCombatStatsService({
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

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3177, token: TEST_TOKEN },
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
      } as never,
      getContent: () => app.content,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t?.cleanup();
});

/* ─────────────────────────── combat bonuses ─────────────────────────── */

describe('secondary combat bonuses', () => {
  /** An equipped R-style ring with one bonus, an SR coil with two, and a plain belt. */
  async function bonusBag(p: Player) {
    const id = {
      ring: await grant(t.db, app.gear, p.playerId, 'training_ring', {
        roll: { kind: 'fixed', rolledMultiplierBp: 5_000, affixKey: null, combatBonuses: [{ stat: 'crit_chance_bp', valueBp: 425 }] },
      }),
      belt: await grant(t.db, app.gear, p.playerId, 'padded_belt'),
      harness: await grant(t.db, app.gear, p.playerId, 'basic_harness', {
        roll: {
          kind: 'fixed',
          rolledMultiplierBp: 20_000,
          affixKey: null,
          combatBonuses: [
            { stat: 'crit_chance_bp', valueBp: 550 },
            { stat: 'crit_damage_bonus_bp', valueBp: 1_750 },
          ],
        },
      }),
      plasma: await grant(t.db, app.gear, p.playerId, 'plasma_coil_ring', {
        roll: {
          kind: 'fixed',
          rolledMultiplierBp: 8_600,
          affixKey: null,
          combatBonuses: [
            { stat: 'armor_penetration_bp', valueBp: 750 },
            { stat: 'lifesteal_bp', valueBp: 400 },
          ],
        },
      }),
    };
    await app.gear.equipment.equip(p.playerId, { slot: 'attack', equipmentId: id.ring });
    await app.gear.equipment.equip(p.playerId, { slot: 'defense', equipmentId: id.belt });
    await app.gear.equipment.equip(p.playerId, { slot: 'health', equipmentId: id.harness });
    return id;
  }

  it('an item lists its own rolled bonuses: none, one or two', async () => {
    const p = await newPlayer();
    const id = await bonusBag(p);
    const byId = new Map((await listAll(p, 'limit=50')).map((i) => [i.id, i]));
    expect(byId.get(id.belt).combatBonuses).toEqual([]);
    expect(byId.get(id.ring).combatBonuses).toEqual([{ stat: 'crit_chance', label: 'Crit Chance', percent: 4.25, text: '+4.25% Crit Chance' }]);
    expect(byId.get(id.plasma).combatBonuses).toEqual([
      { stat: 'armor_penetration', label: 'Armor Pen', percent: 7.5, text: '+7.5% Armor Pen' },
      { stat: 'lifesteal', label: 'Lifesteal', percent: 4, text: '+4% Lifesteal' },
    ]);
  });

  it('the overview carries the capped cumulative totals from the combat service', async () => {
    const p = await newPlayer();
    await bonusBag(p);
    const o = (await call(p, 'GET', '')).body.data;
    expect((await combat.calculateCombatStats(p.playerId)).combatModifiers).toMatchObject({ critChanceBp: 975, critDamageBonusBp: 1_750 });
    // Zero rows are omitted; Crit DMG is the total multiplier.
    expect(o.combatModifiers).toEqual([
      { key: 'crit_chance', label: 'Crit', value: '9.75%' },
      { key: 'crit_damage', label: 'Crit DMG', value: '167.5%' },
    ]);
    expect(o.slots.health.combatBonuses.map((b: { text: string }) => b.text)).toEqual(['+5.5% Crit Chance', '+17.5% Crit Damage']);
  });

  it('a loadout without bonuses has no totals', async () => {
    const p = await newPlayer();
    await stockBag(p);
    expect((await call(p, 'GET', '')).body.data.combatModifiers).toEqual([]);
  });

  it('the detail comparison carries both sides’ bonuses, unscored', async () => {
    const p = await newPlayer();
    const id = await bonusBag(p);
    const d = (await call(p, 'GET', `/items/${id.plasma}`)).body.data;
    expect(d.item.combatBonuses.map((b: { text: string }) => b.text)).toEqual(['+7.5% Armor Pen', '+4% Lifesteal']);
    expect(d.comparison.equippedItem.combatBonuses.map((b: { text: string }) => b.text)).toEqual(['+4.25% Crit Chance']);
    expect(d.comparison).toMatchObject({ stat: 'attack', hasBuddy: true });
    expect(Object.keys(d.comparison).sort()).toEqual(['current', 'delta', 'equippedItem', 'hasBuddy', 'stat', 'withItem']);
  });

  it('copies that differ only in their bonuses are not counted as identical', async () => {
    const p = await newPlayer();
    const id = await bonusBag(p);
    await grant(t.db, app.gear, p.playerId, 'training_ring');
    expect((await call(p, 'GET', `/items/${id.ring}`)).body.data.identicalCopies).toBe(1);
  });

  it('never sends basis points or storage keys', async () => {
    const p = await newPlayer();
    const id = await bonusBag(p);
    for (const raw of [(await call(p, 'GET', '')).raw, (await call(p, 'GET', '/items')).raw, (await call(p, 'GET', `/items/${id.plasma}`)).raw]) {
      for (const leak of ['Bp"', '_bp', 'valueBp', '"425"', ':425', ':1750', ':750']) expect(raw).not.toContain(leak);
    }
  });
});

/* ─────────────────────────── feature gate ─────────────────────────── */

describe('a player who has not unlocked Equipment', () => {
  it('reads only `{ unlocked: false }` — no counts, no legacy gear', async () => {
    const p = await newPlayer({ unlocked: false });
    // Gear granted before the unlock waits in the bag; it must not show.
    await grant(t.db, app.gear, p.playerId, 'training_ring');
    const res = await call(p, 'GET', '');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ unlocked: false });
    expect(res.raw).not.toContain('Training Ring');
  });

  it('is refused by every other route, reads and writes alike, and nothing changes', async () => {
    const p = await newPlayer({ unlocked: false });
    const ring = await grant(t.db, app.gear, p.playerId, 'training_ring');
    const refused = [
      await call(p, 'GET', '/items'),
      await call(p, 'GET', `/items/${ring}`),
      await call(p, 'POST', `/items/${ring}/equip`, { expectedCurrentId: null }),
      await call(p, 'POST', '/loadout/attack/unequip', { expectedCurrentId: null }),
      await call(p, 'PUT', `/items/${ring}/flags/favorite`, { value: true }),
      await call(p, 'PUT', `/items/${ring}/flags/locked`, { value: true }),
    ];
    for (const res of refused) {
      expect(res.status, res.raw).toBe(422);
      expect(res.body.error.code).toBe('FEATURE_LOCKED');
      expect(res.raw).not.toContain('Training Ring');
    }
    expect(await slotRows(p.playerId)).toEqual({});
    const [owned] = await app.gear.equipment.listEquipment(p.playerId).then((r) => r.items);
    expect(owned!.isFavorite).toBe(false);
    expect(owned!.isLocked).toBe(false);
  });
});

/* ─────────────────────────── overview ─────────────────────────── */

describe('overview', () => {
  it('shows the Buddy, combat-service stats and the three slots', async () => {
    const p = await newPlayer();
    await stockBag(p);
    const spy = vi.spyOn(combat, 'calculateCombatStats');
    const res = await call(p, 'GET', '');
    expect(res.status, res.raw).toBe(200);
    expect(spy).toHaveBeenCalledWith(p.playerId);
    const authoritative = await combat.calculateCombatStats(p.playerId);
    spy.mockRestore();

    const o = res.body.data;
    expect(o.unlocked).toBe(true);
    expect(o.buddy).toMatchObject({ name: 'Warband Princess', currentSp: 420 });
    expect(o.stats).toEqual(authoritative.stats);
    expect(o.stats).toEqual({ attack: 210, defense: 168, maxHp: null });
    expect(o.unavailableReason).toBe('incomplete_loadout');
    expect(o.slots.attack).toMatchObject({
      name: 'Training Ring',
      rarity: 'N',
      slot: 'attack',
      multiplier: 0.5,
      range: { min: 0.5, max: 0.5 },
      rollQuality: 100,
      equipped: true,
      favorite: false,
      locked: false,
    });
    expect(o.slots.defense.name).toBe('Padded Belt');
    expect(o.slots.health).toBeNull();
  });

  it('never carries internal keys, basis points or grant/source metadata', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    await app.gear.equipment.equip(p.playerId, { slot: 'attack', equipmentId: id.pipe });
    const bodies = [
      (await call(p, 'GET', '')).raw,
      (await call(p, 'GET', '/items')).raw,
      (await call(p, 'GET', `/items/${id.pipe}`)).raw,
    ];
    for (const raw of bodies) {
      for (const leak of ['training_ring', 'rusty_test_pipe', 'poor_planning', 'Bp"', 'grantKey', 'sourceKey', 'sourceType', 'affixKey', 'definitionKey', 'rolledProperties']) {
        expect(raw).not.toContain(leak);
      }
    }
  });

  it('without a Buddy: stats are null, management still works', async () => {
    const p = await newPlayer({ buddy: false });
    const id = await stockBag(p);
    const o = (await call(p, 'GET', '')).body.data;
    expect(o.buddy).toBeNull();
    expect(o.stats).toEqual({ attack: null, defense: null, maxHp: null });
    expect(o.unavailableReason).toBe('no_buddy');
    expect(o.slots.attack.name).toBe('Training Ring');

    const detail = (await call(p, 'GET', `/items/${id.plasma}`)).body.data;
    expect(detail.comparison).toMatchObject({ hasBuddy: false, current: null, withItem: null, delta: null });

    const equipped = await call(p, 'POST', `/items/${id.plasma}/equip`, { expectedCurrentId: id.ring });
    expect(equipped.status, equipped.raw).toBe(200);
    expect(equipped.body.data).toMatchObject({ changed: true, before: null, after: null });
    expect((await slotRows(p.playerId)).attack).toBe(id.plasma);
  });
});

/* ─────────────────────────── gear bag ─────────────────────────── */

describe('gear bag paging', () => {
  it('pages by cursor through every copy exactly once', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(p, 'GET', `/items?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.data.items.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.items.map((i: any) => i.id));
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual(Object.values(id).sort((a, b) => a - b));
  });

  it('caps the page size and validates it', async () => {
    const p = await newPlayer();
    expect((await call(p, 'GET', '/items?limit=50')).status).toBe(200);
    expect((await call(p, 'GET', '/items?limit=51')).status).toBe(400);
    expect((await call(p, 'GET', '/items?limit=0')).status).toBe(400);
    expect((await call(p, 'GET', '/items?limit=1000000')).status).toBe(400);
  });

  it('refuses a garbage cursor', async () => {
    const p = await newPlayer();
    const res = await call(p, 'GET', '/items?cursor=not-a-cursor');
    expect(res.status).toBe(400);
  });
});

describe('gear bag filters', () => {
  it('filters by slot, rarity and equipped state', async () => {
    const p = await newPlayer();
    await stockBag(p);
    expect(await listAll(p, 'slot=attack')).toHaveLength(4);
    expect(names(await listAll(p, 'slot=health'))).toEqual(['Basic Harness']);
    expect(names(await listAll(p, 'rarity=SR'))).toEqual(['Plasma Coil Ring']);
    expect(names(await listAll(p, 'equipped=true&sort=name'))).toEqual(['Padded Belt', 'Training Ring']);
    expect(await listAll(p, 'equipped=false')).toHaveLength(4);
    expect((await call(p, 'GET', '/items?slot=relic')).status).toBe(400);
    expect((await call(p, 'GET', '/items?equipped=yes')).status).toBe(400);
  });

  it('filters by favourite and lock, independently', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    await call(p, 'PUT', `/items/${id.plasma}/flags/favorite`, { value: true });
    await call(p, 'PUT', `/items/${id.harness}/flags/locked`, { value: true });
    expect(names(await listAll(p, 'favorite=true'))).toEqual(['Plasma Coil Ring']);
    expect(names(await listAll(p, 'locked=true'))).toEqual(['Basic Harness']);
    expect(await listAll(p, 'favorite=true&locked=true')).toEqual([]);
  });
});

describe('gear bag search', () => {
  it('finds copies by base name', async () => {
    const p = await newPlayer();
    await stockBag(p);
    expect(names(await listAll(p, 'search=Test%20Pipe&sort=quality'))).toEqual([
      'Rusty Test Pipe of Poor Planning',
      'Rusty Test Pipe',
    ]);
    expect(names(await listAll(p, 'search=training'))).toEqual(['Training Ring']);
  });

  it('finds copies by affix suffix, and across the join', async () => {
    const p = await newPlayer();
    await stockBag(p);
    expect(names(await listAll(p, 'search=Poor%20Planning'))).toEqual(['Rusty Test Pipe of Poor Planning']);
    expect(names(await listAll(p, 'search=pipe%20of%20poor'))).toEqual(['Rusty Test Pipe of Poor Planning']);
  });

  it('never matches internal keys, and treats LIKE wildcards literally', async () => {
    const p = await newPlayer();
    await stockBag(p);
    expect(await listAll(p, 'search=poor_planning')).toEqual([]);
    expect(await listAll(p, 'search=rusty_test_pipe')).toEqual([]);
    expect(await listAll(p, 'search=%25')).toEqual([]);
    expect(await listAll(p, 'search=_')).toEqual([]);
  });
});

describe('gear bag sorting', () => {
  it('sorts by every supported key', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const ids = async (sort: string) => (await listAll(p, `sort=${sort}`)).map((i) => i.id);
    expect(await ids('newest')).toEqual([id.harness, id.pipe2, id.pipe, id.plasma, id.belt, id.ring]);
    expect(await ids('oldest')).toEqual([id.ring, id.belt, id.plasma, id.pipe, id.pipe2, id.harness]);
    expect((await ids('multiplier'))[0]).toBe(id.harness);
    expect((await ids('rarity'))[0]).toBe(id.plasma);
    // Base name, then acquisition order within a name.
    expect(names(await listAll(p, 'sort=name'))).toEqual([
      'Basic Harness',
      'Padded Belt',
      'Plasma Coil Ring',
      'Rusty Test Pipe of Poor Planning',
      'Rusty Test Pipe',
      'Training Ring',
    ]);
    const bySlot = (await listAll(p, 'sort=slot')).map((i) => i.slot);
    expect(bySlot).toEqual(['attack', 'attack', 'attack', 'attack', 'defense', 'health']);
    const byQuality = await listAll(p, 'sort=quality');
    const qualities = byQuality.map((i) => i.rollQuality);
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a));
    expect(byQuality[byQuality.length - 1].id).toBe(id.pipe2);
  });

  it('refuses an unknown sort, including prototype names', async () => {
    const p = await newPlayer();
    for (const sort of ['bogus', 'constructor', '__proto__', 'acquired', 'rolled_multiplier_bp']) {
      const res = await call(p, 'GET', `/items?sort=${sort}`);
      expect(res.status, sort).toBe(400);
    }
  });
});

/* ─────────────────────────── detail + comparison ─────────────────────────── */

describe('item detail', () => {
  it('shows the roll, its range, its quality and a combat-service comparison', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const spy = vi.spyOn(combat, 'previewSlot');
    const res = await call(p, 'GET', `/items/${id.pipe}`);
    expect(spy).toHaveBeenCalledWith(p.playerId, 'attack', [id.pipe]);
    spy.mockRestore();
    expect(res.status, res.raw).toBe(200);
    const d = res.body.data;
    expect(d.item).toMatchObject({
      name: 'Rusty Test Pipe of Poor Planning',
      baseName: 'Rusty Test Pipe',
      rarity: 'N',
      slot: 'attack',
      multiplier: 0.55,
      range: { min: 0.4, max: 0.6 },
      rollQuality: 75,
      equipped: false,
      source: 'Granted',
    });
    expect(typeof d.item.acquiredAt).toBe('string');
    expect(d.identicalCopies).toBe(1);
    expect(d.comparison).toMatchObject({
      stat: 'attack',
      current: 210,
      withItem: 231,
      delta: 21,
      hasBuddy: true,
    });
    expect(d.comparison.equippedItem.name).toBe('Training Ring');
  });

  it('compares against an empty slot', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const d = (await call(p, 'GET', `/items/${id.harness}`)).body.data;
    expect(d.comparison).toMatchObject({ stat: 'maxHp', current: null, withItem: 840, delta: null, equippedItem: null });
  });

  it('marks the equipped copy as the one already active', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const d = (await call(p, 'GET', `/items/${id.ring}`)).body.data;
    expect(d.item.equipped).toBe(true);
    expect(d.comparison).toMatchObject({ current: 210, withItem: 210, delta: 0 });
    expect(d.comparison.equippedItem.id).toBe(id.ring);
  });

  it('answers 404 for missing ids and for another player’s copy alike', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    const theirs = await stockBag(other);
    for (const path of [`/items/${theirs.plasma}`, '/items/999999999']) {
      const res = await call(p, 'GET', path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('EQUIPMENT_NOT_OWNED');
      expect(res.raw).not.toContain('Plasma');
    }
  });
});

/* ─────────────────────────── actions ─────────────────────────── */

describe('equip', () => {
  it('equips through the service and the new stats follow', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', `/items/${id.plasma}/equip`, { expectedCurrentId: id.ring });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ slot: 'attack', changed: true, before: 210, after: 361 });
    expect((await slotRows(p.playerId)).attack).toBe(id.plasma);
    const o = (await call(p, 'GET', '')).body.data;
    expect(o.slots.attack.name).toBe('Plasma Coil Ring');
    expect(o.stats.attack).toBe(361);
  });

  it('fills an empty slot when the client saw it empty', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', `/items/${id.harness}/equip`, { expectedCurrentId: null });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ slot: 'health', before: null, after: 840 });
  });

  it('refuses a stale view with 409 and changes nothing', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    // Someone else (Discord) swapped the attack slot after the page loaded.
    await app.gear.equipment.equip(p.playerId, { slot: 'attack', equipmentId: id.plasma });
    const res = await call(p, 'POST', `/items/${id.pipe}/equip`, { expectedCurrentId: id.ring });
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error.code).toBe('LOADOUT_CONFLICT');
    expect((await slotRows(p.playerId)).attack).toBe(id.plasma);
  });

  it('requires the stale-view guard to be sent', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', `/items/${id.plasma}/equip`, {});
    expect(res.status).toBe(400);
    expect((await slotRows(p.playerId)).attack).toBe(id.ring);
  });

  it('cannot equip another player’s copy', async () => {
    const p = await newPlayer();
    await stockBag(p);
    const other = await newPlayer();
    const theirs = await stockBag(other);
    const res = await call(p, 'POST', `/items/${theirs.plasma}/equip`, { expectedCurrentId: null });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EQUIPMENT_NOT_OWNED');
    expect((await slotRows(other.playerId)).attack).toBe(theirs.ring);
  });
});

describe('unequip', () => {
  it('empties the slot and the stat becomes null — no fallback', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', '/loadout/defense/unequip', { expectedCurrentId: id.belt });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ slot: 'defense', changed: true, before: 168, after: null });
    expect(res.body.data.item.name).toBe('Padded Belt');
    expect(await slotRows(p.playerId)).toEqual({ attack: id.ring });
    const o = (await call(p, 'GET', '')).body.data;
    expect(o.slots.defense).toBeNull();
    expect(o.stats.defense).toBeNull();
  });

  it('refuses a stale view with 409', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', '/loadout/attack/unequip', { expectedCurrentId: id.plasma });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LOADOUT_CONFLICT');
    expect((await slotRows(p.playerId)).attack).toBe(id.ring);
  });
});

describe('favourite and lock', () => {
  it('sets each flag independently, idempotently', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const fav = await call(p, 'PUT', `/items/${id.plasma}/flags/favorite`, { value: true });
    expect(fav.status, fav.raw).toBe(200);
    expect(fav.body.data).toMatchObject({ favorite: true, locked: false });
    const again = await call(p, 'PUT', `/items/${id.plasma}/flags/favorite`, { value: true });
    expect(again.body.data).toMatchObject({ favorite: true, locked: false });
    const lock = await call(p, 'PUT', `/items/${id.plasma}/flags/locked`, { value: true });
    expect(lock.body.data).toMatchObject({ favorite: true, locked: true });
    const unfav = await call(p, 'PUT', `/items/${id.plasma}/flags/favorite`, { value: false });
    expect(unfav.body.data).toMatchObject({ favorite: false, locked: true });
    const unlock = await call(p, 'PUT', `/items/${id.plasma}/flags/locked`, { value: false });
    expect(unlock.body.data).toMatchObject({ favorite: false, locked: false });
    expect((await call(p, 'PUT', `/items/${id.plasma}/flags/shiny`, { value: true })).status).toBe(400);
  });

  it('a lock does not stop equipping or unequipping — the backend rule', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    await call(p, 'PUT', `/items/${id.plasma}/flags/locked`, { value: true });
    const eq1 = await call(p, 'POST', `/items/${id.plasma}/equip`, { expectedCurrentId: id.ring });
    expect(eq1.status, eq1.raw).toBe(200);
    const un = await call(p, 'POST', '/loadout/attack/unequip', { expectedCurrentId: id.plasma });
    expect(un.status, un.raw).toBe(200);
  });

  it('cannot flag another player’s copy', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    const theirs = await stockBag(other);
    const res = await call(p, 'PUT', `/items/${theirs.plasma}/flags/locked`, { value: true });
    expect(res.status).toBe(404);
    const [row] = (await app.gear.equipment.listEquipment(other.playerId, { rarity: 'SR' })).items;
    expect(row!.isLocked).toBe(false);
  });
});

/* ─────────────────────────── scope ─────────────────────────── */

describe('self-only scope', () => {
  it('a session cannot address another player’s Equipment at all', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    const theirs = await stockBag(other);
    const attempts = [
      await call(p, 'GET', '', undefined, { as: other.playerId }),
      await call(p, 'GET', '/items', undefined, { as: other.playerId }),
      await call(p, 'GET', `/items/${theirs.ring}`, undefined, { as: other.playerId }),
      await call(p, 'POST', `/items/${theirs.plasma}/equip`, { expectedCurrentId: theirs.ring }, { as: other.playerId }),
      await call(p, 'POST', '/loadout/attack/unequip', { expectedCurrentId: theirs.ring }, { as: other.playerId }),
      await call(p, 'PUT', `/items/${theirs.ring}/flags/locked`, { value: true }, { as: other.playerId }),
    ];
    for (const res of attempts) {
      expect(res.status, res.raw).toBe(403);
      expect(res.raw).not.toContain('Training Ring');
    }
    expect((await slotRows(other.playerId)).attack).toBe(theirs.ring);
  });

  it('a write without the CSRF token is refused', async () => {
    const p = await newPlayer();
    const id = await stockBag(p);
    const res = await call(p, 'POST', `/items/${id.plasma}/equip`, { expectedCurrentId: id.ring }, { csrf: false });
    expect(res.status).toBe(403);
    expect((await slotRows(p.playerId)).attack).toBe(id.ring);
  });
});
