/**
 * Equipment management against a real database, driven through the real
 * Discord handlers with the real services: what a player can see, equip,
 * unequip and flag — and every way a button can be stale, doubled, forged or
 * pointed at someone else's gear.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  equipmentEvents,
  playerEquipment,
  playerLoadoutSlots,
  playerLoadouts,
  playerWaifus,
  players,
  species as speciesTable,
} from '../../src/db/schema';
import {
  handleEquipmentEquip,
  handleEquipmentFlag,
  handleEquipmentHome,
  handleEquipmentItem,
  handleEquipmentPick,
  handleEquipmentSlot,
  handleEquipmentUnequip,
  handleGearBag,
} from '../../src/discord/commands/waifumonEquipment';
import { EQUIPMENT_HOME_TITLE, LOCKED_FEATURE, STALE_ITEM } from '../../src/discord/equipmentPresenter';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  createEquipmentManagementService,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createEquipmentOnboardingService } from '../../src/modules/onboarding/equipmentOnboardingService';
import { EquipmentNotOwnedError, FeatureLockedError, LoadoutConflictError } from '../../src/shared/errors';
import { createTestDb, silentLogger, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { fixedRange, GEAR, buildEquipmentServices, grant, starterRoll, unlockEquipment, type EquipmentServices } from '../helpers/equipmentFixtures';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let mgmt: EquipmentManagementService;
let ctx: AppContext;
let speciesId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  mgmt = createEquipmentManagementService({ equipment: svc.equipment, combatStats: combat, featureUnlocks: svc.featureUnlocks });
  ctx = { config: { assetsDir: './assets' }, logger: silentLogger(), services: { equipmentManagement: mgmt } } as unknown as AppContext;
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  // Plasma Coil Ring ×0.86 (attack), Padded Belt ×0.40, Basic Harness ×2.00, Training Ring ×0.50.
  for (const g of [GEAR.attack, GEAR.attack2, GEAR.defense, GEAR.health]) await svc.definitions.create(g);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
/** An unlocked player with a Buddy at 420 Current SP and the three starters equipped. */
async function setup(opts: { buddy?: boolean; unlocked?: boolean; starters?: boolean } = {}) {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-mg-${seq}`, `u-mg-${seq}`);
  if (opts.buddy !== false) {
    const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 420, nickname: 'Warband Princess' });
    await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  }
  if (opts.unlocked !== false) await unlockEquipment(t.db, svc, playerId);
  const ids: Record<string, number> = {};
  if (opts.starters !== false && opts.unlocked !== false) {
    ids.pipe = await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe'));
    ids.plate = await grant(t.db, svc, playerId, 'scrap_plate', starterRoll('scrap_plate'));
    ids.box = await grant(t.db, svc, playerId, 'dented_lunchbox', starterRoll('dented_lunchbox'));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ids.pipe });
    await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: ids.plate });
    await svc.equipment.equip(playerId, { slot: 'health', equipmentId: ids.box });
  }
  const prov = { playerId, guildDbId: 1 } as unknown as Provisioned;
  return { playerId, prov, ids };
}

function click(values?: string[]) {
  const painted: { content?: string; embeds?: { toJSON(): unknown }[]; components?: { toJSON(): unknown }[] }[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as (typeof painted)[number]);
  });
  const i = { replied: false, deferred: false, values, isButton: () => !values, isStringSelectMenu: () => !!values, update: paint, reply: paint, editReply: paint, followUp: paint };
  const last = () => painted[painted.length - 1]!;
  const text = () => {
    const p = last();
    return [p.content ?? '', JSON.stringify((p.embeds ?? []).map((e) => e.toJSON()))].join('\n');
  };
  const ids = () =>
    (last().components ?? []).flatMap((r) =>
      (r.toJSON() as { components: { custom_id?: string; options?: { value: string }[] }[] }).components.map((c) => c.custom_id ?? ''),
    );
  const options = () =>
    (last().components ?? []).flatMap((r) =>
      (r.toJSON() as { components: { options?: { value: string }[] }[] }).components.flatMap((c) => (c.options ?? []).map((o) => o.value)),
    );
  return { i: i as never, painted, last, text, ids, options };
}

async function slots(playerId: number): Promise<Record<string, number>> {
  const rows = await t.db
    .select({ slot: playerLoadoutSlots.slot, equipmentId: playerLoadoutSlots.equipmentId })
    .from(playerLoadoutSlots)
    .innerJoin(playerLoadouts, eq(playerLoadouts.id, playerLoadoutSlots.loadoutId))
    .where(and(eq(playerLoadoutSlots.playerId, playerId), eq(playerLoadouts.isActive, true)));
  return Object.fromEntries(rows.map((r) => [r.slot, r.equipmentId]));
}

async function eventCount(playerId: number, kind: string): Promise<number> {
  const [row] = await t.db
    .select({ n: count() })
    .from(equipmentEvents)
    .where(and(eq(equipmentEvents.playerId, playerId), eq(equipmentEvents.kind, kind)));
  return row!.n;
}

/* ─────────────────────────── access ─────────────────────────── */

describe('access', () => {
  it('an unlocked player opens Equipment and sees authoritative stats', async () => {
    const { playerId, prov } = await setup();
    const c = click();
    await handleEquipmentHome(ctx, c.i, prov);
    const stats = await combat.calculateCombatStats(playerId);
    expect(c.text()).toContain(EQUIPMENT_HOME_TITLE);
    expect(c.text()).toContain(`ATK **${stats.stats.attack}**`);
    expect(stats.stats).toEqual({ attack: 189, defense: 147, maxHp: 840 }); // 420 × .45 / .35 / 2.00
  });

  it('a locked player reaches no management screen and changes nothing, even with forged ids', async () => {
    const { playerId, prov } = await setup({ unlocked: false });
    const pipe = await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe')); // owning gear does not unlock it
    const attempts: [string, (i: never) => Promise<void>][] = [
      ['home', (i) => handleEquipmentHome(ctx, i, prov)],
      ['slot', (i) => handleEquipmentSlot(ctx, i, prov, ['attack', '0'])],
      ['bag', (i) => handleGearBag(ctx, i, prov, ['all', '0'])],
      ['item', (i) => handleEquipmentItem(ctx, i, prov, [String(pipe), 'h'])],
      ['equip', (i) => handleEquipmentEquip(ctx, i, prov, [String(pipe), '-', 'h'])],
      ['uneq', (i) => handleEquipmentUnequip(ctx, i, prov, ['attack', String(pipe), 'h'])],
      ['flag', (i) => handleEquipmentFlag(ctx, i, prov, [String(pipe), 'f', '1', 'h'])],
    ];
    for (const [label, attempt] of attempts) {
      const c = click();
      await attempt(c.i);
      expect(c.last().content, label).toBe(LOCKED_FEATURE);
    }
    const pick = click([String(pipe)]);
    await handleEquipmentPick(ctx, pick.i, prov, ['h']);
    expect(pick.last().content).toBe(LOCKED_FEATURE);
    expect(await slots(playerId)).toEqual({});
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, pipe));
    expect(row!.isFavorite).toBe(false);
  });

  it('a staging reset that revokes the unlock while a screen is open stops the next action', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await t.db.transaction((tx) =>
      svc.featureUnlocks.revoke(tx, { playerId, featureKey: 'equipment', actorDiscordId: 'a', reason: 'reset' }),
    );
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(coil), String(ids.pipe), 's.attack.0']);
    expect(c.last().content).toBe(LOCKED_FEATURE);
    expect((await slots(playerId)).attack).toBe(ids.pipe);
  });

  it('management ignores the onboarding switch: switched off, an unlocked player keeps everything', async () => {
    const { playerId, prov } = await setup();
    const off = createEquipmentOnboardingService({
      db: t.db,
      equipment: svc.equipment,
      featureUnlocks: svc.featureUnlocks,
      combatStats: combat,
      resolveActiveBuddy: (tx, id) => app.collection.resolveActiveBuddy(tx, id),
      getContent: () => app.content,
      isEnabled: () => false,
    });
    expect((await off.getState(playerId)).entry).toBe('available');
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(coil), String((await slots(playerId)).attack), 's.attack.0']);
    expect(c.text()).toContain('Equipped **Plasma Coil Ring**');
  });
});

/* ─────────────────────────── slots ─────────────────────────── */

describe('slot management', () => {
  it.each([
    ['attack', 'plasma_coil_ring', 'ATK'],
    ['defense', 'padded_belt', 'DEF'],
    ['health', 'basic_harness', 'HP'],
  ] as const)('%s shows only compatible gear, compared by the combat-stat service', async (slot, key, stat) => {
    const { playerId, prov } = await setup();
    const candidate = await grant(t.db, svc, playerId, key);
    await grant(t.db, svc, playerId, slot === 'attack' ? 'padded_belt' : 'plasma_coil_ring'); // another slot's gear
    const c = click();
    await handleEquipmentSlot(ctx, c.i, prov, [slot, '0']);
    expect(c.options()).toEqual([String(candidate)]);
    const expected = await combat.calculateCombatStats(playerId, { slotOverrides: { [slot]: candidate } });
    const value = expected.stats[slot === 'attack' ? 'attack' : slot === 'defense' ? 'defense' : 'maxHp'];
    expect(c.text()).toContain(`Would give: **${value} ${stat}**`);
  });

  it('equips a better item, reports before → after, and repaints fresh state', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(coil), String(ids.pipe), 's.attack.0']);
    expect(c.last().content).toBe('✅ Equipped **Plasma Coil Ring**.\nATK 189 → 361 (+172)'); // 420 × .86 = 361.2
    expect((await slots(playerId)).attack).toBe(coil);
    // The repainted screen shows the new item as current and the pipe as a candidate.
    expect(c.text()).toContain('Current ATK: **361**');
    expect(c.options()).toEqual([String(ids.pipe)]);
  });

  it('equips a worse item when asked, showing the drop', async () => {
    const { playerId, prov } = await setup({ starters: false });
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const pipe = await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe'));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: coil });
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(pipe), String(coil), 's.attack.0']);
    expect(c.last().content).toContain('ATK 361 → 189 (-172)');
    expect((await slots(playerId)).attack).toBe(pipe);
  });

  it('unequips, leaving the slot empty and every other slot alone', async () => {
    const { playerId, prov, ids } = await setup();
    const c = click();
    await handleEquipmentUnequip(ctx, c.i, prov, ['attack', String(ids.pipe), 's.attack.0']);
    expect(c.last().content).toBe('Attack Gear unequipped.\nATK unavailable until Attack Gear is equipped.');
    expect(await slots(playerId)).toEqual({ defense: ids.plate, health: ids.box });
    expect((await combat.calculateCombatStats(playerId)).stats.attack).toBeNull();
    // Nothing re-fills it: the next screen still shows it empty.
    const again = click();
    await handleEquipmentHome(ctx, again.i, prov);
    expect(again.text()).toContain('Nothing equipped');
  });

  it('a double-clicked Equip changes the slot once', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const before = await eventCount(playerId, 'equipped');
    const a = click();
    const b = click();
    await Promise.all([
      handleEquipmentEquip(ctx, a.i, prov, [String(coil), String(ids.pipe), 's.attack.0']),
      handleEquipmentEquip(ctx, b.i, prov, [String(coil), String(ids.pipe), 's.attack.0']),
    ]);
    expect((await slots(playerId)).attack).toBe(coil);
    expect((await eventCount(playerId, 'equipped')) - before).toBe(1);
    const contents = [a.last().content, b.last().content];
    expect(contents.filter((x) => x?.startsWith('✅ Equipped'))).toHaveLength(1);
    expect(contents.some((x) => /changed in another window|already equipped/.test(x ?? ''))).toBe(true);
  });

  it('a stale expected item (another window changed the slot first) is refused and repainted', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const ring = await grant(t.db, svc, playerId, 'training_ring');
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ring }); // the "other window"
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(coil), String(ids.pipe), 's.attack.0']);
    expect(c.last().content).toMatch(/Attack Gear changed in another window/);
    expect((await slots(playerId)).attack).toBe(ring);
    expect(c.text()).toContain('Training Ring');
    await expect(mgmt.equip(playerId, coil, ids.pipe!)).rejects.toBeInstanceOf(LoadoutConflictError);
  });

  it('a stale Unequip after the slot changed is refused the same way', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: coil });
    const c = click();
    await handleEquipmentUnequip(ctx, c.i, prov, ['attack', String(ids.pipe), 's.attack.0']);
    expect(c.last().content).toMatch(/changed in another window/);
    expect((await slots(playerId)).attack).toBe(coil);
  });

  it('equipping one slot never touches another', async () => {
    const { playerId, prov } = await setup({ starters: false });
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await grant(t.db, svc, playerId, 'padded_belt');
    await grant(t.db, svc, playerId, 'basic_harness');
    const c = click();
    await handleEquipmentEquip(ctx, c.i, prov, [String(coil), '-', 's.attack.0']);
    expect(await slots(playerId)).toEqual({ attack: coil });
  });
});

/* ─────────────────────────── stale and foreign ids ─────────────────────────── */

describe('removed, foreign and wrong-slot gear', () => {
  it('a removed item selected from an old menu is stale; it never appears again', async () => {
    const { playerId, prov } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId, equipmentId: coil, reason: 't', actorDiscordId: 'a' }),
    );
    const c = click([String(coil)]);
    await handleEquipmentPick(ctx, c.i, prov, ['s.attack.0']);
    expect(c.last().content).toBe(STALE_ITEM);
    expect(c.options()).not.toContain(String(coil)); // the repainted slot screen
    const bag = click();
    await handleGearBag(ctx, bag.i, prov, ['all', '0']);
    expect(bag.text()).not.toContain('Plasma Coil Ring');
    const eq2 = click();
    await handleEquipmentEquip(ctx, eq2.i, prov, [String(coil), '-', 'h']);
    expect(eq2.last().content).toBe(STALE_ITEM);
  });

  it("another player's item reads exactly like a missing one", async () => {
    const owner = await setup();
    const theirs = await grant(t.db, svc, owner.playerId, 'plasma_coil_ring');
    const { playerId, prov } = await setup();
    const responses: (string | undefined)[] = [];
    for (const id of [theirs, 987654321]) {
      const c = click();
      await handleEquipmentItem(ctx, c.i, prov, [String(id), 'h']);
      responses.push(c.last().content);
      const e = click();
      await handleEquipmentEquip(ctx, e.i, prov, [String(id), '-', 'h']);
      responses.push(e.last().content);
      const f = click();
      await handleEquipmentFlag(ctx, f.i, prov, [String(id), 'f', '1', 'h']);
      responses.push(f.last().content);
    }
    expect(new Set(responses)).toEqual(new Set([STALE_ITEM]));
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, theirs));
    expect(row!.isFavorite).toBe(false);
    expect(await slots(playerId)).not.toHaveProperty('attack', theirs);
  });

  it('wrong-slot gear is never a candidate, and an equip uses the item’s own slot', async () => {
    const { playerId } = await setup();
    const belt = await grant(t.db, svc, playerId, 'padded_belt');
    const owner = await setup();
    const foreign = await grant(t.db, svc, owner.playerId, 'plasma_coil_ring');
    const removed = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId, equipmentId: removed, reason: 't', actorDiscordId: 'a' }),
    );
    const before = await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId));
    const preview = await combat.previewSlot(playerId, 'attack', [belt, foreign, removed, 987_654_321]);
    // Wrong slot, someone else's, removed and missing all read exactly the same.
    expect(preview.candidates).toEqual(
      [belt, foreign, removed, 987_654_321].map((equipmentId) => ({ equipmentId, available: false, value: null, delta: null })),
    );
    expect(await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId))).toEqual(before);
    const outcome = await mgmt.equip(playerId, belt, (await slots(playerId)).defense!);
    expect(outcome.slot).toBe('defense');
    expect((await slots(playerId)).defense).toBe(belt);
  });

  it('the management service refuses missing ids with the Phase 1 error', async () => {
    const { playerId } = await setup();
    await expect(mgmt.item(playerId, 999_999)).rejects.toBeInstanceOf(EquipmentNotOwnedError);
  });
});

/* ─────────────────────────── flags ─────────────────────────── */

describe('favourite and lock', () => {
  it('toggle independently, are instance-specific, and do not block equipping', async () => {
    const { playerId, prov, ids } = await setup();
    const coilA = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const coilB = await grant(t.db, svc, playerId, 'plasma_coil_ring');

    const fav = click();
    await handleEquipmentFlag(ctx, fav.i, prov, [String(coilA), 'f', '1', 'b.all.0']);
    expect(fav.last().content).toBe('⭐ Added to favourites.');
    const lock = click();
    await handleEquipmentFlag(ctx, lock.i, prov, [String(coilA), 'l', '1', 'b.all.0']);
    expect(lock.last().content).toBe('🔒 Locked.');

    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    const a = rows.find((r) => r.id === coilA)!;
    const b = rows.find((r) => r.id === coilB)!;
    expect([a.isFavorite, a.isLocked]).toEqual([true, true]);
    expect([b.isFavorite, b.isLocked]).toEqual([false, false]); // the other copy is untouched

    // Unfavourite leaves the lock; locked gear still equips and unequips.
    await handleEquipmentFlag(ctx, click().i, prov, [String(coilA), 'f', '0', 'h']);
    const [after] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, coilA));
    expect([after!.isFavorite, after!.isLocked]).toEqual([false, true]);
    await handleEquipmentEquip(ctx, click().i, prov, [String(coilA), String(ids.pipe), 'h']);
    expect((await slots(playerId)).attack).toBe(coilA);
    await handleEquipmentUnequip(ctx, click().i, prov, ['attack', String(coilA), 'h']);
    expect((await slots(playerId)).attack).toBeUndefined();
    // Flags never change stats.
    await handleEquipmentEquip(ctx, click().i, prov, [String(coilA), '-', 'h']);
    const locked = await combat.calculateCombatStats(playerId);
    await handleEquipmentEquip(ctx, click().i, prov, [String(coilB), String(coilA), 'h']);
    expect((await slots(playerId)).attack).toBe(coilB);
    expect((await combat.calculateCombatStats(playerId)).stats).toEqual(locked.stats);
  });

  it('a doubled flag click lands on the same value', async () => {
    const { playerId, prov } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await Promise.all([
      handleEquipmentFlag(ctx, click().i, prov, [String(coil), 'f', '1', 'h']),
      handleEquipmentFlag(ctx, click().i, prov, [String(coil), 'f', '1', 'h']),
    ]);
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, coil));
    expect(row!.isFavorite).toBe(true);
    expect(await eventCount(playerId, 'flag_changed')).toBe(1);
  });
});

/* ─────────────────────────── Gear Bag ─────────────────────────── */

describe('Gear Bag', () => {
  it('groups identical copies and opens the equipped copy when one is equipped', async () => {
    const { playerId, prov, ids } = await setup();
    const extra1 = await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe'));
    const extra2 = await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe'));
    const bag = click();
    await handleGearBag(ctx, bag.i, prov, ['attack', '0']);
    expect(bag.text()).toContain('Rusty Pipe** ×3');
    expect(bag.options()).toEqual([String(ids.pipe)]); // the equipped copy

    const detail = click([String(ids.pipe)]);
    await handleEquipmentPick(ctx, detail.i, prov, ['b.attack.0']);
    expect(detail.text()).toContain('3 (viewing copy 1)');
    expect(detail.ids().some((id) => id.includes(`|item|${extra1}|`))).toBe(true); // Next copy
    // Another copy of what is equipped is not offered on the slot screen.
    const slot = click();
    await handleEquipmentSlot(ctx, slot.i, prov, ['attack', '0']);
    expect(slot.options()).not.toContain(String(extra1));
    expect(slot.options()).not.toContain(String(extra2));
  });

  it('"Next copy" re-validates: a copy removed since the screen was drawn is stale, not shown', async () => {
    const { playerId, prov } = await setup({ starters: false });
    const a = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const b = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    const first = click();
    await handleEquipmentItem(ctx, first.i, prov, [String(a), 'b.all.0']);
    const next = first.ids().find((id) => id.includes(`|item|${b}|`));
    expect(next).toBeDefined();
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId, equipmentId: b, reason: 't', actorDiscordId: 'a' }),
    );
    const c = click();
    await handleEquipmentItem(ctx, c.i, prov, [String(b), 'b.all.0']);
    expect(c.last().content).toBe(STALE_ITEM);
    expect(c.text()).toContain('Plasma Coil Ring** ×1'); // the bag, repainted without the removed copy
  });

  it('flags on one of several identical copies are shown as "n of N", never as the whole group', async () => {
    const { playerId, prov } = await setup({ starters: false });
    const a = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await mgmt.setFlag(playerId, a, 'favorite', true);
    await mgmt.setFlag(playerId, a, 'locked', true);
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: a });
    const bag = click();
    await handleGearBag(ctx, bag.i, prov, ['all', '0']);
    expect(bag.text()).toContain('✅ 1 of 3 equipped · ⭐ 1 of 3 · 🔒 1 of 3');
    expect(bag.text()).not.toMatch(/(✅|⭐|🔒) \*\*Plasma Coil Ring/u);
  });

  it('a page that no longer exists after the bag shrinks repaints the last real page', async () => {
    const { playerId, prov } = await setup({ starters: false });
    const granted: number[] = [];
    for (let i = 0; i < 12; i++) {
      const key = `shrink_ring_${String(i).padStart(2, '0')}`;
      await svc.definitions.create({ key, name: `Shrink Ring ${i}`, slot: 'attack', rarity: 'N', ...fixedRange(2000 + i) });
      granted.push(await grant(t.db, svc, playerId, key));
    }
    const before = click();
    await handleGearBag(ctx, before.i, prov, ['all', '1']);
    expect(before.text()).toContain('Page 2 / 2');
    for (const id of granted.slice(0, 5)) {
      await t.db.transaction((tx) =>
        svc.equipment.adminRemove(tx, { playerId, equipmentId: id, reason: 't', actorDiscordId: 'a' }),
      );
    }
    const stale = click(); // the old "page 2" button
    await handleGearBag(ctx, stale.i, prov, ['all', '1']);
    expect(stale.text()).toContain('Page 1 / 1');
    expect(stale.options()).toHaveLength(7);
    const slotStale = click();
    await handleEquipmentSlot(ctx, slotStale.i, prov, ['attack', '1']);
    expect(slotStale.options()).toHaveLength(7);
  });

  it('pages a bag larger than Discord limits, clamping stale pages', async () => {
    const { playerId, prov } = await setup();
    for (let i = 0; i < 30; i++) {
      const key = `bulk_ring_${String(i).padStart(2, '0')}`;
      await svc.definitions.create({ key, name: `Bulk Ring ${i}`, slot: 'attack', rarity: 'N', ...fixedRange(1000 + i) });
      await grant(t.db, svc, playerId, key);
    }
    const all = await mgmt.bag(playerId, 'all', 0);
    expect(all.entries.totalItems).toBe(33);
    expect(all.entries.totalPages).toBe(4);
    const seen = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const c = click();
      await handleGearBag(ctx, c.i, prov, ['all', String(page)]);
      expect(c.options().length).toBeLessThanOrEqual(10);
      for (const v of c.options()) seen.add(v);
      expect(c.text()).toContain(`Page ${page + 1} / 4`);
    }
    expect(seen.size).toBe(33);
    const stale = click();
    await handleGearBag(ctx, stale.i, prov, ['all', '57']);
    expect(stale.text()).toContain('Page 4 / 4');
    // Slot screen pages too: 30 candidates (the equipped Rusty Pipe's own
    // definition is not offered), 10 per page.
    const slotPage = await mgmt.slot(playerId, 'attack', 2);
    expect(slotPage.candidates.totalPages).toBe(3);
    expect(slotPage.candidates.items.length).toBeGreaterThan(0);
  });

  it('filters by favourites', async () => {
    const { playerId, prov } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await mgmt.setFlag(playerId, coil, 'favorite', true);
    const c = click();
    await handleGearBag(ctx, c.i, prov, ['fav', '0']);
    expect(c.options()).toEqual([String(coil)]);
  });
});

/* ─────────────────────────── Buddy and definitions ─────────────────────────── */

describe('Buddy and definitions', () => {
  it('a Buddy changed between renders changes the next screen; nothing is cached', async () => {
    const { playerId, prov } = await setup();
    const first = click();
    await handleEquipmentHome(ctx, first.i, prov);
    expect(first.text()).toContain('Current SP: **420**');
    const other = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 310, nickname: 'Witchy Mechanic' });
    await t.db.update(players).set({ buddyWaifuId: other.id }).where(eq(players.id, playerId));
    const second = click();
    await handleEquipmentHome(ctx, second.i, prov);
    expect(second.text()).toContain('Witchy Mechanic');
    expect(second.text()).toContain('Current SP: **310**');
    expect(second.text()).toContain('ATK **140**'); // 310 × 0.45 = 139.5 → 140
  });

  it('without a Buddy, every management action still works', async () => {
    const { playerId, prov, ids } = await setup({ buddy: false });
    const home = click();
    await handleEquipmentHome(ctx, home.i, prov);
    expect(home.text()).toContain('No active Buddy.');
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await handleEquipmentEquip(ctx, click().i, prov, [String(coil), String(ids.pipe), 'h']);
    expect((await slots(playerId)).attack).toBe(coil);
    await handleEquipmentUnequip(ctx, click().i, prov, ['attack', String(coil), 'h']);
    expect((await slots(playerId)).attack).toBeUndefined();
    await handleEquipmentFlag(ctx, click().i, prov, [String(coil), 'l', '1', 'h']);
    const bag = click();
    await handleGearBag(ctx, bag.i, prov, ['all', '0']);
    expect(bag.text()).toContain('Plasma Coil Ring');
  });

  it('a released Buddy reads as no Buddy', async () => {
    const { playerId, prov } = await setup();
    const [player] = await t.db.select({ buddy: players.buddyWaifuId }).from(players).where(eq(players.id, playerId));
    await t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, player!.buddy!));
    const c = click();
    await handleEquipmentHome(ctx, c.i, prov);
    expect(c.text()).toContain('No active Buddy.');
  });

  it('gear whose definition was disabled stays listed, equipped and equipable', async () => {
    const { playerId, prov, ids } = await setup();
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    await svc.definitions.setEnabled('plasma_coil_ring', false);
    try {
      const bag = click();
      await handleGearBag(ctx, bag.i, prov, ['attack', '0']);
      expect(bag.text()).toContain('Plasma Coil Ring');
      const slot = click();
      await handleEquipmentSlot(ctx, slot.i, prov, ['attack', '0']);
      expect(slot.options()).toContain(String(coil));
      expect(slot.text()).toContain('Would give: **361 ATK**');
      const detail = click();
      await handleEquipmentItem(ctx, detail.i, prov, [String(coil), 'h']);
      expect(detail.text()).toContain('Difference: +172');
      expect(detail.ids().some((id) => id.includes(`|equip|${coil}|`))).toBe(true);
      await handleEquipmentEquip(ctx, click().i, prov, [String(coil), String(ids.pipe), 'h']);
      expect((await slots(playerId)).attack).toBe(coil);
      const home = click();
      await handleEquipmentHome(ctx, home.i, prov);
      expect(home.text()).toContain('Plasma Coil Ring');
    } finally {
      await svc.definitions.setEnabled('plasma_coil_ring', true);
    }
  });
});

/* ─────────────────────────── service-level guard ─────────────────────────── */

describe('management service', () => {
  it('refuses every read and write without the unlock', async () => {
    const { playerId } = await setup({ unlocked: false });
    for (const call of [
      () => mgmt.home(playerId),
      () => mgmt.slot(playerId, 'attack', 0),
      () => mgmt.bag(playerId, 'all', 0),
      () => mgmt.item(playerId, 1),
      () => mgmt.equip(playerId, 1, null),
      () => mgmt.unequip(playerId, 'attack', 1),
      () => mgmt.setFlag(playerId, 1, 'favorite', true),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(FeatureLockedError);
    }
  });

  it('legacy gear owned while locked stays put and unusable, then is ordinary gear once unlocked', async () => {
    // Not a supported acquisition path (random rewards need the unlock) —
    // staging, admin or test state. Nothing deletes or migrates it.
    const { playerId } = await setup({ unlocked: false });
    const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring');
    // The domain service refuses on its own, not just the management layer.
    await expect(svc.equipment.equip(playerId, { slot: 'attack', equipmentId: coil })).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(svc.equipment.unequip(playerId, { slot: 'attack' })).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(svc.equipment.setFlags(playerId, coil, { isLocked: true })).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await slots(playerId)).toEqual({});

    await unlockEquipment(t.db, svc, playerId);
    const bag = await mgmt.bag(playerId, 'all', 0);
    expect(bag.entries.items.map((e) => e.focusId)).toEqual([coil]);
    const outcome = await mgmt.equip(playerId, coil, null);
    expect(outcome.changed).toBe(true);
    expect(await slots(playerId)).toEqual({ attack: coil });
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, coil));
    expect(row!.removedAt).toBeNull();
  });
});
