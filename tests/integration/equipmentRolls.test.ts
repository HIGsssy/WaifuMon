/**
 * Instance-based Equipment loot, end to end: a grant decides each copy's
 * multiplier and affix exactly once, every read returns that roll, combat uses
 * it, the Gear Bag never merges materially different copies, and the
 * onboarding stays deterministic however the dice are loaded.
 *
 * The RNG is scripted per test — `pick(...)` queues the exact
 * `intInclusive` answers the next rolls will get (multiplier step, then affix
 * index) — so every expected value here is exact, not statistical.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { equipmentEvents, playerEquipment, players, species as speciesTable } from '../../src/db/schema';
import { buildGearBag, buildItemDetail, summaryGearLines } from '../../src/discord/equipmentPresenter';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  createEquipmentManagementService,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createEquipmentOnboardingService } from '../../src/modules/onboarding/equipmentOnboardingService';
import {
  EquipmentAffixPoolEmptyError,
  EquipmentDefinitionDisabledError,
  EquipmentNotOwnedError,
  EquipmentValidationError,
} from '../../src/shared/errors';
import { buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import { readUnknownAffixKeys } from '../../src/modules/equipment/equipmentQueries';
import { UNKNOWN_AFFIX_LABEL } from '../../src/modules/equipment/equipmentRoll';
import type { Rng } from '../../src/shared/random';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import {
  GEAR,
  TEST_AFFIXES,
  TEST_AFFIX_LIST,
  fixedRange,
  buildEquipmentServices,
  grant,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

// ── a scripted RNG ────────────────────────────────────────────────────────

let script: number[] = [];
/** Queue the next `intInclusive` answers. Unscripted calls answer `min`. */
const pick = (...values: number[]) => {
  script = [...values];
};
const rng: Rng = {
  next: () => 0,
  intInclusive(min, max) {
    const v = script.length > 0 ? script.shift()! : min;
    if (v < min || v > max) throw new Error(`scripted pick ${v} outside [${min}, ${max}]`);
    return v;
  },
};
// TEST_AFFIXES rolls from [poor_planning, mild_regret]; retired_flair is never rolled.
const PP = 0;
const MR = 1;
// GEAR.ranged rolls 4000, 4500, 5000, 5500, 6000 for steps 0–4.

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let mgmt: EquipmentManagementService;
let speciesId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db, { affixes: TEST_AFFIXES, rng });
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  mgmt = createEquipmentManagementService({ equipment: svc.equipment, combatStats: combat, featureUnlocks: svc.featureUnlocks });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await svc.definitions.create(GEAR.ranged);
  await svc.definitions.create(GEAR.defense);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

beforeEach(() => {
  script = [];
});

let seq = 0;
/** A player with a Buddy at exactly 100 Current SP (Base 100, level 1), Equipment unlocked. */
async function setup(opts: { level?: number } = {}) {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-roll-${seq}`, `u-roll-${seq}`);
  const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 100 });
  await t.db.update(players).set({ buddyWaifuId: buddy.id, level: opts.level ?? 1 }).where(eq(players.id, playerId));
  return playerId;
}

async function setupUnlocked() {
  const playerId = await setup();
  await unlockEquipment(t.db, svc, playerId);
  return playerId;
}

const RANDOM = { roll: { kind: 'random' as const } };

const fixed = (rolledMultiplierBp: number, affixKey: string | null = null) => ({
  roll: { kind: 'fixed' as const, rolledMultiplierBp, affixKey },
});

async function rowOf(id: number) {
  const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, id));
  return row!;
}

async function instanceCount(playerId: number) {
  const [row] = await t.db.select({ n: count() }).from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
  return row!.n;
}

async function grantEvents(playerId: number) {
  return t.db
    .select()
    .from(equipmentEvents)
    .where(and(eq(equipmentEvents.playerId, playerId), eq(equipmentEvents.kind, 'granted')));
}

// ── normal (random) grants ────────────────────────────────────────────────

describe('a normal grant', () => {
  it('rolls once, persists the roll, and no read rolls again', async () => {
    const playerId = await setupUnlocked();
    pick(3, PP);
    const id = await grant(t.db, svc, playerId, GEAR.ranged.key, RANDOM);
    expect(await rowOf(id)).toMatchObject({ rolledMultiplierBp: 5_500, affixKey: 'poor_planning' });

    // Load the dice differently: nothing that reads may consume them.
    pick(0, MR, 0, MR, 0, MR);
    const owned = await svc.equipment.getOwned(playerId, id);
    expect(owned).toMatchObject({
      rolledMultiplierBp: 5_500,
      affixKey: 'poor_planning',
      displayName: 'Rusty Test Pipe of Poor Planning',
    });
    const [listed] = (await svc.equipment.listEquipment(playerId)).items;
    expect(listed).toMatchObject({ id, rolledMultiplierBp: 5_500, affixKey: 'poor_planning' });
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: id });
    const loadout = await svc.equipment.getActiveLoadout(playerId);
    expect(loadout.slots.attack).toMatchObject({ id, rolledMultiplierBp: 5_500 });
    expect(script).toEqual([0, MR, 0, MR, 0, MR]);
    expect(await rowOf(id)).toMatchObject({ rolledMultiplierBp: 5_500, affixKey: 'poor_planning' });
  });

  it('rolls each copy of a multi-copy grant independently', async () => {
    const playerId = await setup();
    pick(0, PP, 4, MR, 2, PP);
    const result = await t.db.transaction((tx) =>
      svc.equipment.grantEquipment(tx, { playerId, definitionKey: GEAR.ranged.key, quantity: 3, source: { type: 'admin' } }),
    );
    expect(result.instances.map((i) => [i.rolledMultiplierBp, i.affixKey])).toEqual([
      [4_000, 'poor_planning'],
      [6_000, 'mild_regret'],
      [5_000, 'poor_planning'],
    ]);
  });

  it('records what was granted in the event, as observability only', async () => {
    const playerId = await setup();
    pick(1, MR);
    const id = await grant(t.db, svc, playerId, GEAR.ranged.key, { source: { type: 'boss', key: 'test_boss' }, ...RANDOM });
    const [event] = await grantEvents(playerId);
    expect(event!.equipmentId).toBe(id);
    expect(event!.metadata).toMatchObject({
      definitionKey: GEAR.ranged.key,
      rolledMultiplierBp: 4_500,
      affixKey: 'mild_regret',
      rollKind: 'random',
      sourceType: 'boss',
      sourceKey: 'test_boss',
    });
  });

  it('is refused for a disabled definition; owned copies keep their roll and stay equipable', async () => {
    const playerId = await setupUnlocked();
    await svc.definitions.create({ ...GEAR.ranged, key: 'retiring_pipe', name: 'Retiring Pipe' });
    pick(4, MR);
    const owned = await grant(t.db, svc, playerId, 'retiring_pipe', RANDOM);
    await svc.definitions.setEnabled('retiring_pipe', false);

    await expect(grant(t.db, svc, playerId, 'retiring_pipe', RANDOM)).rejects.toBeInstanceOf(EquipmentDefinitionDisabledError);
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: owned });
    expect((await combat.calculateCombatStats(playerId)).loadout.slots.attack).toMatchObject({
      multiplierBp: 6_000,
      affixKey: 'mild_regret',
    });
  });
});

// ── idempotency ───────────────────────────────────────────────────────────

describe('a retried grant', () => {
  it('returns the original instance and roll, and rolls nothing new', async () => {
    const playerId = await setup();
    const input = { grantKey: `retry-${playerId}` };
    pick(1, PP);
    const first = await t.db.transaction((tx) =>
      svc.equipment.grantEquipment(tx, { playerId, definitionKey: GEAR.ranged.key, source: { type: 'boss' }, ...input }),
    );
    pick(4, MR);
    const retry = await t.db.transaction((tx) =>
      svc.equipment.grantEquipment(tx, { playerId, definitionKey: GEAR.ranged.key, source: { type: 'boss' }, ...input }),
    );
    expect(retry.alreadyGranted).toBe(true);
    expect(retry.newInstanceIds).toEqual([]);
    expect(retry.instances.map((i) => [i.id, i.rolledMultiplierBp, i.affixKey])).toEqual([
      [first.instances[0]!.id, 4_500, 'poor_planning'],
    ]);
    expect(await instanceCount(playerId)).toBe(1);
    expect(await grantEvents(playerId)).toHaveLength(1);
    expect(await rowOf(first.instances[0]!.id)).toMatchObject({ rolledMultiplierBp: 4_500, affixKey: 'poor_planning' });
  });

  it('a retried fixed grant returns the original even after its range moved', async () => {
    const playerId = await setup();
    await svc.definitions.create({ ...GEAR.ranged, key: 'moving_pipe', name: 'Moving Pipe' });
    const grantKey = `moving-${playerId}`;
    const original = await grant(t.db, svc, playerId, 'moving_pipe', { grantKey, ...fixed(4_500) });
    await svc.definitions.update('moving_pipe', { ...GEAR.ranged, key: 'moving_pipe', name: 'Moving Pipe', multiplierMinBp: 5_000 });

    // A fresh grant of the now-invalid value is refused…
    await expect(grant(t.db, svc, playerId, 'moving_pipe', fixed(4_500))).rejects.toBeInstanceOf(EquipmentValidationError);
    // …but the retry is a replay, and returns what it created.
    expect(await grant(t.db, svc, playerId, 'moving_pipe', { grantKey, ...fixed(4_500) })).toBe(original);
    expect(await rowOf(original)).toMatchObject({ rolledMultiplierBp: 4_500 });
    expect(await instanceCount(playerId)).toBe(1);
  });
});

// ── fixed grants ──────────────────────────────────────────────────────────

describe('a fixed grant', () => {
  it('stores exactly the dictated roll, affixed or not, without touching the RNG', async () => {
    const playerId = await setup();
    pick(4, MR);
    const affixed = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000, 'mild_regret'));
    const plain = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000));
    const retired = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(6_000, 'retired_flair'));
    expect(await rowOf(affixed)).toMatchObject({ rolledMultiplierBp: 5_000, affixKey: 'mild_regret' });
    expect(await rowOf(plain)).toMatchObject({ rolledMultiplierBp: 4_000, affixKey: null });
    expect(await rowOf(retired)).toMatchObject({ rolledMultiplierBp: 6_000, affixKey: 'retired_flair' });
    expect(script).toEqual([4, MR]);
    const [event] = await grantEvents(playerId);
    expect(event!.metadata).toMatchObject({ rollKind: 'fixed', rolledMultiplierBp: 5_000, affixKey: 'mild_regret' });
  });

  it.each([
    ['below the range', { rolledMultiplierBp: 3_500, affixKey: null }],
    ['above the range', { rolledMultiplierBp: 6_500, affixKey: null }],
    ['off the step', { rolledMultiplierBp: 4_250, affixKey: null }],
    ['a string multiplier', { rolledMultiplierBp: '5000', affixKey: null }],
    ['a float multiplier', { rolledMultiplierBp: 5_000.5, affixKey: null }],
    ['an uncatalogued affix', { rolledMultiplierBp: 5_000, affixKey: 'of_infinite_power' }],
    ['a smuggled stat', { rolledMultiplierBp: 5_000, affixKey: null, bonusAtk: 9_999 }],
  ])('refuses %s and writes nothing', async (_label, roll) => {
    const playerId = await setup();
    await expect(
      grant(t.db, svc, playerId, GEAR.ranged.key, { roll: { kind: 'fixed', ...(roll as { rolledMultiplierBp: number; affixKey: null }) } }),
    ).rejects.toBeInstanceOf(EquipmentValidationError);
    expect(await instanceCount(playerId)).toBe(0);
    expect(await grantEvents(playerId)).toHaveLength(0);
  });

  it('refuses an unknown roll kind', async () => {
    const playerId = await setup();
    await expect(
      grant(t.db, svc, playerId, GEAR.ranged.key, { roll: { kind: 'max' } as never }),
    ).rejects.toBeInstanceOf(EquipmentValidationError);
    expect(await instanceCount(playerId)).toBe(0);
  });
});

// ── combat ────────────────────────────────────────────────────────────────

describe('combat stats', () => {
  it('use the instance\'s roll: two copies of one definition give different stats', async () => {
    const playerId = await setupUnlocked();
    const low = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000));
    const high = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(6_000, 'poor_planning'));

    // Buddy at 100 SP: ×0.40 → 40 ATK, ×0.60 → 60 ATK.
    const preview = await combat.previewSlot(playerId, 'attack', [low, high]);
    expect(preview.candidates.map((c) => c.value)).toEqual([40, 60]);

    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: high });
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.stats.attack).toBe(60);
    expect(stats.loadout.slots.attack).toMatchObject({
      equipmentId: high,
      multiplierBp: 6_000,
      name: 'Rusty Test Pipe of Poor Planning',
      definitionName: 'Rusty Test Pipe',
      affixKey: 'poor_planning',
    });
  });

  it('do not change when the definition\'s range is retuned', async () => {
    const playerId = await setupUnlocked();
    await svc.definitions.create({ ...GEAR.ranged, key: 'retuned_pipe', name: 'Retuned Pipe' });
    const id = await grant(t.db, svc, playerId, 'retuned_pipe', fixed(4_500));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: id });
    await svc.definitions.update('retuned_pipe', {
      ...GEAR.ranged,
      key: 'retuned_pipe',
      name: 'Retuned Pipe',
      multiplierMinBp: 10_000,
      multiplierMaxBp: 12_000,
    });
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.stats.attack).toBe(45);
    expect(stats.loadout.slots.attack?.multiplierBp).toBe(4_500);
  });
});

// ── Gear Bag grouping and display ─────────────────────────────────────────

describe('the Gear Bag', () => {
  it('groups only truly identical copies, and keeps per-copy flags per copy', async () => {
    const playerId = await setupUnlocked();
    const a1 = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000, 'poor_planning'));
    const a2 = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000, 'poor_planning'));
    const otherAffix = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000, 'mild_regret'));
    const otherRoll = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(6_000, 'poor_planning'));
    const plain = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000));
    await svc.equipment.setFlags(playerId, a2, { isFavorite: true });

    const groups = await svc.equipment.listEquipmentGroups(playerId, { slot: 'attack' });
    const shape = groups.map((g) => ({
      name: g.displayName,
      bp: g.rolledMultiplierBp,
      ids: g.instanceIds,
      fav: g.favoriteCount,
    }));
    expect(shape).toEqual([
      { name: 'Rusty Test Pipe of Poor Planning', bp: 6_000, ids: [otherRoll], fav: 0 },
      { name: 'Rusty Test Pipe', bp: 4_000, ids: [plain], fav: 0 },
      { name: 'Rusty Test Pipe of Mild Regret', bp: 4_000, ids: [otherAffix], fav: 0 },
      { name: 'Rusty Test Pipe of Poor Planning', bp: 4_000, ids: [a1, a2], fav: 1 },
    ]);

    const bag = buildGearBag(await mgmt.bag(playerId, 'attack', 0));
    const text = JSON.stringify(bag.embeds!.map((e) => (e as { toJSON(): unknown }).toJSON()));
    expect(text).toContain('**Rusty Test Pipe of Poor Planning** ×2\\nN • Attack • ×0.40');
    expect(text).toContain('**Rusty Test Pipe of Poor Planning** ×1\\nN • Attack • ×0.60');
    expect(text).toContain('**Rusty Test Pipe of Mild Regret** ×1');
    expect(text).toContain('**Rusty Test Pipe** ×1');
    expect(text).toContain('⭐ 1 of 2');
  });

  it('item detail shows the rolled name and multiplier, and counts only identical copies', async () => {
    const playerId = await setupUnlocked();
    const a = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_500, 'mild_regret'));
    const b = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_500, 'mild_regret'));
    await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000, 'mild_regret'));

    const view = await mgmt.item(playerId, a);
    expect(view.copies).toEqual([a, b]);
    const text = JSON.stringify((buildItemDetail(view, { kind: 'home' }).embeds![0] as { toJSON(): unknown }).toJSON());
    expect(text).toContain('Rusty Test Pipe of Mild Regret');
    expect(text).toContain('ATK ×0.55');
    expect(text).toContain('With this item: 55');
  });

  it('slot screen offers a differently rolled copy of what is equipped, never an identical one', async () => {
    const playerId = await setupUnlocked();
    const equipped = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000));
    await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(4_000)); // identical spare
    const better = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(6_000));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: equipped });

    const view = await mgmt.slot(playerId, 'attack', 0);
    expect(view.candidates.items.map((c) => [c.equipmentId, c.preview.value, c.preview.delta])).toEqual([[better, 60, 20]]);
  });
});

describe('profiles and summaries', () => {
  it('name equipped gear by its generated display name', async () => {
    const playerId = await setupUnlocked();
    const id = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000, 'poor_planning'));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: id });
    const summary = await mgmt.summary(playerId);
    if (!summary.unlocked) throw new Error('expected unlocked');
    expect(summary.slots.attack).toEqual({ name: 'Rusty Test Pipe of Poor Planning', rarity: 'N' });
    expect(summaryGearLines(summary)[0]).toBe('⚔️ Rusty Test Pipe of Poor Planning');
    expect(summaryGearLines(summary, { labelled: true })[0]).toBe('Attack: Rusty Test Pipe of Poor Planning');
  });
});

// ── onboarding ────────────────────────────────────────────────────────────

describe('the Equipment onboarding', () => {
  function onboarding() {
    return createEquipmentOnboardingService({
      db: t.db,
      equipment: svc.equipment,
      featureUnlocks: svc.featureUnlocks,
      combatStats: combat,
      resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
      getContent: () => app.content,
      isEnabled: () => true,
    });
  }

  it('grants the exact fixed starters, unaffixed, however the dice are loaded', async () => {
    const playerId = await setup({ level: 35 });
    const onb = onboarding();
    // Every random roll would be the top of the range with an affix.
    const loaded = () => pick(...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 4 : MR)));
    loaded();
    await onb.advance(playerId, 'intro');
    await onb.advance(playerId, 'attack');
    await onb.advance(playerId, 'defense');
    await onb.advance(playerId, 'health');
    const done = await onb.complete(playerId);
    expect(done.kind).toBe('complete');

    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    const bySlot = Object.fromEntries(rows.map((r) => [r.slot, [r.rolledMultiplierBp, r.affixKey]]));
    expect(bySlot).toEqual({ attack: [4_500, null], defense: [3_500, null], health: [20_000, null] });
    if (done.kind !== 'complete') throw new Error('unreachable');
    expect(done.stats.loadout.slots.attack?.name).toBe('Rusty Pipe');
    // 100 SP × 0.45 / 0.35 / 2.00.
    expect(done.stats.stats).toEqual({ attack: 45, defense: 35, maxHp: 200 });
    expect(script).toHaveLength(20); // no RNG consumed
  });

  it('replays keep the original starter rolls', async () => {
    const playerId = await setup({ level: 35 });
    const onb = onboarding();
    await onb.advance(playerId, 'attack');
    const [before] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    await onb.advance(playerId, 'attack'); // stale double-click
    await onb.complete(playerId); // re-ensures every grant
    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    expect(rows.find((r) => r.slot === 'attack')).toMatchObject({ id: before!.id, rolledMultiplierBp: 4_500, affixKey: null });
  });

  it('is not ready while a starter\'s range no longer contains its fixed roll', async () => {
    const onb = onboarding();
    expect((await onb.isReady()).ready).toBe(true);
    const seeded = loadEquipmentSeedCatalogue(CONTENT_DIR).find((d) => d.key === 'rusty_pipe')!;
    await svc.definitions.update('rusty_pipe', { ...seeded, multiplierMinBp: 5_000 });
    try {
      expect(await onb.isReady()).toMatchObject({ ready: false, invalidStarterRolls: ['rusty_pipe'] });
    } finally {
      await svc.definitions.update('rusty_pipe', seeded);
    }
    expect((await onb.isReady()).ready).toBe(true);
  });
});

// ── security ──────────────────────────────────────────────────────────────

describe('ownership', () => {
  it('another player\'s rolled instance stays unreadable and unusable', async () => {
    const owner = await setupUnlocked();
    const intruder = await setupUnlocked();
    const theirs = await grant(t.db, svc, owner, GEAR.ranged.key, fixed(6_000, 'poor_planning'));

    expect(await svc.equipment.getOwned(intruder, theirs)).toBeNull();
    await expect(mgmt.item(intruder, theirs)).rejects.toBeInstanceOf(EquipmentNotOwnedError);
    await expect(svc.equipment.equip(intruder, { slot: 'attack', equipmentId: theirs })).rejects.toBeInstanceOf(
      EquipmentNotOwnedError,
    );
    const preview = await combat.previewSlot(intruder, 'attack', [theirs]);
    expect(preview.candidates[0]).toEqual({ equipmentId: theirs, available: false, value: null, delta: null });
  });
});

// ── affix pools ───────────────────────────────────────────────────────────

describe('affix pools', () => {
  const RARITIES = ['N', 'R', 'SR'] as const;
  const SLOTS = ['attack', 'defense', 'health'] as const;
  const keyOf = (slot: string, rarity: string) => `pool_${slot}_${rarity.toLowerCase()}`;

  beforeAll(async () => {
    for (const slot of SLOTS) {
      for (const rarity of RARITIES) {
        await svc.definitions.create({
          key: keyOf(slot, rarity),
          name: `Pool ${slot} ${rarity}`,
          slot,
          rarity,
          ...(slot === 'health' ? fixedRange(20_000) : fixedRange(5_000)),
        });
      }
    }
  });

  it.each(SLOTS.flatMap((slot) => RARITIES.map((rarity) => [slot, rarity] as const)))(
    'a random %s %s grant draws from exactly its own pool',
    async (slot, rarity) => {
      const playerId = await setup();
      const id = await grant(t.db, svc, playerId, keyOf(slot, rarity), RANDOM);
      const row = await rowOf(id);
      expect(TEST_AFFIXES.get(row.affixKey!)?.pool).toBe(`${slot}.${rarity}`);
    },
  );

  it('refuses a random grant whose pool has no enabled affix, writing nothing and borrowing from no other pool', async () => {
    const playerId = await setup();
    // attack.R is fully retired; attack.N and attack.SR are untouched.
    const retiredR = buildAffixCatalogue(
      TEST_AFFIX_LIST.map((a) => (a.pool === 'attack.R' ? { ...a, enabled: false } : a)),
    );
    const strict = buildEquipmentServices(t.db, { affixes: retiredR, rng });
    pick(0, 0);
    await expect(grant(t.db, strict, playerId, keyOf('attack', 'R'), RANDOM)).rejects.toBeInstanceOf(
      EquipmentAffixPoolEmptyError,
    );
    expect(await instanceCount(playerId)).toBe(0);
    expect(await grantEvents(playerId)).toHaveLength(0);
    expect(script).toEqual([0, 0]); // no dice consumed
    // A fixed, unaffixed grant of the same definition is still possible.
    await grant(t.db, strict, playerId, keyOf('attack', 'R'), fixed(5_000));
    expect(await instanceCount(playerId)).toBe(1);
  });

  it('refuses a random grant of a rarity with no pool', async () => {
    const playerId = await setup();
    await svc.definitions.create({ key: 'pool_attack_ssr', name: 'Pool SSR', slot: 'attack', rarity: 'SSR', ...fixedRange(9_000) });
    await expect(grant(t.db, svc, playerId, 'pool_attack_ssr', RANDOM)).rejects.toThrow(/attack\.SSR.*not a supported pool/);
    expect(await instanceCount(playerId)).toBe(0);
  });

  it('a fixed grant accepts an affix of its own pool and refuses another rarity or slot', async () => {
    const playerId = await setup();
    const id = await grant(t.db, svc, playerId, keyOf('attack', 'R'), fixed(5_000, 'attack_r_flair'));
    expect(await rowOf(id)).toMatchObject({ affixKey: 'attack_r_flair' });
    for (const wrong of ['poor_planning', 'attack_sr_flair', 'defense_r_flair', 'health_r_flair']) {
      await expect(grant(t.db, svc, playerId, keyOf('attack', 'R'), fixed(5_000, wrong))).rejects.toBeInstanceOf(
        EquipmentValidationError,
      );
    }
    expect(await instanceCount(playerId)).toBe(1);
  });

  it('same definition and multiplier with different affixes stay separate groups', async () => {
    const playerId = await setupUnlocked();
    await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000, 'poor_planning'));
    await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000, 'mild_regret'));
    const groups = await svc.equipment.listEquipmentGroups(playerId);
    expect(groups.map((g) => [g.displayName, g.rolledMultiplierBp, g.count])).toEqual([
      ['Rusty Test Pipe of Mild Regret', 5_000, 1],
      ['Rusty Test Pipe of Poor Planning', 5_000, 1],
    ]);
  });

  it('the affix never changes the combat value', async () => {
    const playerId = await setupUnlocked();
    const plain = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000));
    const affixed = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_000, 'mild_regret'));
    const preview = await combat.previewSlot(playerId, 'attack', [plain, affixed]);
    expect(preview.candidates.map((c) => c.value)).toEqual([50, 50]);
  });
});

// ── affix lifecycle ───────────────────────────────────────────────────────

describe('affix lifecycle', () => {
  it('a disabled affix stops being rolled but keeps rendering on owned copies', async () => {
    const playerId = await setupUnlocked();
    const id = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(5_500, 'poor_planning'));

    const retired = buildAffixCatalogue(
      TEST_AFFIX_LIST.map((a) => (a.key === 'poor_planning' ? { ...a, enabled: false } : a)),
    );
    const after = buildEquipmentServices(t.db, { affixes: retired, rng });
    expect(await after.equipment.getOwned(playerId, id)).toMatchObject({
      affixKey: 'poor_planning',
      displayName: 'Rusty Test Pipe of Poor Planning',
    });
    // attack.N now has one enabled affix; every new random copy gets it.
    for (let i = 0; i < 5; i++) {
      pick(0, 0);
      const fresh = await grant(t.db, after, playerId, GEAR.ranged.key, RANDOM);
      expect((await rowOf(fresh)).affixKey).toBe('mild_regret');
    }
  });

  it('an owned copy whose affix was deleted renders a visible fallback, is reported, and is not mutated', async () => {
    const playerId = await setupUnlocked();
    const id = await grant(t.db, svc, playerId, GEAR.ranged.key, fixed(6_000, 'poor_planning'));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: id });
    const before = await rowOf(id);

    const reported: string[] = [];
    const deleted = buildAffixCatalogue(
      TEST_AFFIX_LIST.filter((a) => a.key !== 'poor_planning'),
      { onUnknownKey: (key) => reported.push(key) },
    );
    const after = buildEquipmentServices(t.db, { affixes: deleted, rng });
    const afterCombat = createCombatStatsService({
      db: t.db,
      resolveActiveBuddy: (tx, pid) => app.collection.resolveActiveBuddy(tx, pid),
      getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
      getAffixes: () => deleted,
    });
    const afterMgmt = createEquipmentManagementService({
      equipment: after.equipment,
      combatStats: afterCombat,
      featureUnlocks: after.featureUnlocks,
    });

    const expected = `Rusty Test Pipe ${UNKNOWN_AFFIX_LABEL}`;
    expect((await after.equipment.getOwned(playerId, id))?.displayName).toBe(expected);
    const stats = await afterCombat.calculateCombatStats(playerId);
    expect(stats.loadout.slots.attack).toMatchObject({ name: expected, affixKey: 'poor_planning', multiplierBp: 6_000 });
    expect(stats.stats.attack).toBe(60);
    const summary = await afterMgmt.summary(playerId);
    expect(summary.unlocked && summary.slots.attack?.name).toBe(expected);
    const bag = JSON.stringify(
      buildGearBag(await afterMgmt.bag(playerId, 'all', 0)).embeds!.map((e) => (e as { toJSON(): unknown }).toJSON()),
    );
    expect(bag).toContain(expected);

    expect(reported).toContain('poor_planning');
    expect(await rowOf(id)).toEqual(before);
    expect(await readUnknownAffixKeys(t.db, deleted)).toEqual(
      expect.arrayContaining([{ affixKey: 'poor_planning', instances: expect.any(Number) }]),
    );
    expect(await readUnknownAffixKeys(t.db, TEST_AFFIXES)).toEqual([]);
  });
});
