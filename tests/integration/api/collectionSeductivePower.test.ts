/**
 * The SP the Portal Collection shows, against the real stack: real rows, real
 * level scaling, real equipment. The Portal displays `seductivePower.current`
 * and computes nothing, so these are what make its number trustworthy.
 *
 * Copies are per-player, so ownership is covered too; the public allowlist that
 * withholds SP from guild-mates is pinned by `playerDirectory.test.ts`.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformApiServer } from '../../../src/api/server';
import type { ZodFastify } from '../../../src/api/plugins/typeProvider';
import { playerWaifus, species } from '../../../src/db/schema';
import { createCombatStatsService } from '../../../src/modules/equipment/combatStatsService';
import { currentSeductivePower } from '../../../src/modules/power/seductivePower';
import { fixedRange, grant, unlockEquipment } from '../../helpers/equipmentFixtures';
import { bootstrapApp, insertOwnedWaifus, provisionPlayer, type App } from '../../helpers/fixtures';
import { createCapturedLogger, createProbes, TEST_TOKEN } from '../../helpers/platformApiFixtures';
import { createTestDb, type TestDb } from '../../helpers/testDb';

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const GUILD_ID = '111222333444555777';
const USER_ID = '777888999000111333';
const BLADE = { key: 'sp_view_blade', name: 'View Blade', slot: 'attack', rarity: 'SSR', ...fixedRange(10_000) } as const;

let t: TestDb;
let app: App;
let api: ZodFastify;
let playerId: number;
let lowId: number;
let highId: number;
let levelledId: number;

async function owned(): Promise<any[]> {
  const res = await api.inject({
    method: 'GET',
    url: `/api/v1/players/${playerId}/collection/owned`,
    headers: AUTH,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}

async function spOf(id: number) {
  const entry = (await owned()).find((e) => e.waifu.id === id);
  return entry.waifu.seductivePower as { base: number; current: number };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, GUILD_ID, USER_ID));
  const [row] = await t.db.select().from(species).where(eq(species.enabled, true)).limit(1);

  // Same species and level for the first two: only the capture roll differs.
  const inserted = await insertOwnedWaifus(t.db, [
    { playerId, speciesId: row!.id, level: 10, baseSp: 90 },
    { playerId, speciesId: row!.id, level: 10, baseSp: 100 },
    { playerId, speciesId: row!.id, level: 50, baseSp: 100 },
  ]);
  [lowId, highId, levelledId] = inserted.map((w) => w.id) as [number, number, number];

  await app.gear.definitions.create(BLADE);

  api = await createPlatformApiServer({
    config: { enabled: true, host: '127.0.0.1', port: 3178, token: TEST_TOKEN },
    logger: createCapturedLogger('silent').logger,
    probes: createProbes(),
    ctx: {
      services: {
        guilds: app.guilds,
        travel: app.travel,
        keyItems: app.keyItems,
        players: app.players,
        achievements: app.achievements,
        leaderboards: app.leaderboards,
        currency: app.currency,
        inventory: app.inventory,
        daily: app.daily,
        shop: app.shop,
        hunt: app.hunt,
        capture: app.capture,
        care: app.care,
        collection: app.collection,
        expeditions: app.expeditions,
        availability: app.availability,
        appearance: app.appearance,
        progression: app.progression,
        quests: app.quests,
        session: app.session,
        effects: app.effects,
        itemUse: app.itemUse,
        gifts: app.gifts,
      },
      getContent: () => app.content,
    },
  });
});

afterAll(async () => {
  await api?.close();
  await t.cleanup();
});

describe('per-copy SP on the owned collection', () => {
  it('reports each copy of one species from its own roll', async () => {
    const [low, high] = [await spOf(lowId), await spOf(highId)];

    expect(low.base).toBe(90);
    expect(high.base).toBe(100);
    expect(low.current).toBe(currentSeductivePower(90, 10));
    expect(high.current).toBe(currentSeductivePower(100, 10));
    expect(low.current).not.toBe(high.current);
  });

  it('scales Current SP by level and leaves Base SP alone', async () => {
    // The specification's half-up boundary: 100 × 2.225 = 222.5.
    expect(await spOf(levelledId)).toMatchObject({ base: 100, current: 223 });
  });

  it('follows a level change without storing anything new', async () => {
    const before = await spOf(highId);
    await t.db.update(playerWaifus).set({ level: 11 }).where(eq(playerWaifus.id, highId));
    const after = await spOf(highId);
    await t.db.update(playerWaifus).set({ level: 10 }).where(eq(playerWaifus.id, highId));

    expect(after.base).toBe(before.base);
    expect(after.current).toBe(currentSeductivePower(100, 11));
    expect(after.current).toBeGreaterThan(before.current);
  });

  it('does not move when equipment that raises combat SP is equipped', async () => {
    await app.collection.setBuddy(playerId, highId);
    await unlockEquipment(t.db, app.gear, playerId);
    const combat = createCombatStatsService({
      db: t.db,
      resolveActiveBuddy: (tx, id) => app.collection.resolveActiveBuddy(tx, id),
      getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
      getAffixes: app.gear.getAffixes,
    });
    const before = await spOf(highId);

    const blade = await grant(t.db, app.gear, playerId, BLADE.key, {
      roll: {
        kind: 'fixed',
        rolledMultiplierBp: 10_000,
        affixKey: null,
        flatSp: 40,
        combatBonuses: [{ stat: 'flat_sp', valueBp: 10 }],
      },
    });
    await app.gear.equipment.equip(playerId, { slot: 'attack', equipmentId: blade });

    // Proves the gear really did raise combat SP, so the next line is not vacuous.
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.sp!.equipmentBonus).toBe(50);
    expect(stats.sp!.effective).toBe(before.current + 50);

    expect(await spOf(highId)).toEqual(before);
  });

  it('does not serve one player’s copy through another player’s route', async () => {
    const { playerId: other } = await provisionPlayer(app, GUILD_ID, '777888999000111444');
    const res = await api.inject({
      method: 'GET',
      url: `/api/v1/players/${other}/collection/owned/${lowId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('seductivePower');
  });
});
