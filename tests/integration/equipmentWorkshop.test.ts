/**
 * Patch's Workshop against a real database: dismantle yields and safeguards,
 * all-or-nothing batches, fabrication through the shared random-reward path,
 * the economy transaction, request-key idempotency and concurrency.
 *
 * The configuration under test is the V1 tuning (N 1 / R 4 / SR 12; 5+250,
 * 15+750, 40+2000) plus one disabled recipe — passed explicitly, so a content
 * retune does not silently change what these tests prove. `workshopContent`
 * pins the shipped file to the same numbers.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentEvents,
  equipmentWorkshopOperations,
  playerCurrencies,
  playerEquipment,
} from '../../src/db/schema';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import {
  createEquipmentWorkshopService,
  fabricationGrantKey,
  type EquipmentWorkshopService,
} from '../../src/modules/equipment/equipmentWorkshopService';
import type { WorkshopConfig } from '../../src/modules/equipment/workshopConfig';
import {
  EquipmentDismantleRefusedError,
  EquipmentDismantleSelectionError,
  FeatureLockedError,
  InsufficientComponentsError,
  InsufficientFundsError,
  WorkshopNoEligibleEquipmentError,
  WorkshopPreviewStaleError,
  WorkshopRecipeUnavailableError,
  WorkshopRequestConflictError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { GEAR, fixedRange, grant, unlockEquipment } from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let workshop: EquipmentWorkshopService;

const CONFIG: WorkshopConfig = {
  salvageYields: { N: 1, R: 4, SR: 12 },
  recipes: [
    { key: 'standard_rebuild', name: 'Standard Rebuild', rarity: 'N', componentCost: 5, waifubuxCost: 250, enabled: true },
    { key: 'improved_rebuild', name: 'Improved Rebuild', rarity: 'R', componentCost: 15, waifubuxCost: 750, enabled: true },
    { key: 'advanced_rebuild', name: 'Advanced Rebuild', rarity: 'SR', componentCost: 40, waifubuxCost: 2000, enabled: true },
    { key: 'retired_rebuild', name: 'Retired Rebuild', rarity: 'N', componentCost: 2, waifubuxCost: 1, enabled: false },
  ],
};

/** R gear with a real range, an R defense piece, and an SSR relic nothing salvages. */
const EXTRA = {
  knife: { key: 'test_knife', name: 'Test Knife', slot: 'attack', rarity: 'R', multiplierMinBp: 6_500, multiplierMaxBp: 8_500, multiplierStepBp: 500 },
  vest: { key: 'test_vest', name: 'Test Vest', slot: 'defense', rarity: 'R', ...fixedRange(6_000) },
  relic: { key: 'test_relic', name: 'Test Relic', slot: 'attack', rarity: 'SSR', ...fixedRange(9_500) },
} as const;

/** Always the highest index: the last eligible definition by key, and the top of every range. */
const HIGH: Rng = { next: () => 0.999999, intInclusive: (_min, max) => max };
const LOW: Rng = { next: () => 0, intInclusive: (min) => min };

function makeWorkshop(opts: { rewardRng?: Rng; config?: WorkshopConfig | null } = {}): EquipmentWorkshopService {
  const rewards = opts.rewardRng
    ? createEquipmentRewardService({
        equipment: app.gear.equipment,
        getAffixes: app.gear.getAffixes,
        featureUnlocks: app.gear.featureUnlocks,
        rng: opts.rewardRng,
      })
    : app.equipmentRewards;
  return createEquipmentWorkshopService({
    db: t.db,
    featureUnlocks: app.gear.featureUnlocks,
    equipment: app.gear.equipment,
    equipmentRewards: rewards,
    currency: app.currency,
    getAffixes: app.gear.getAffixes,
    getConfig: () => (opts.config === undefined ? CONFIG : opts.config),
  });
}

let seq = 0;
async function newPlayer(opts: { unlocked?: boolean; components?: number; waifubux?: number } = {}): Promise<number> {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-ws-${seq}`, `u-ws-${seq}`);
  if (opts.unlocked !== false) await unlockEquipment(t.db, app.gear, playerId);
  await t.db
    .update(playerCurrencies)
    .set({ salvagedComponents: opts.components ?? 0, waifubux: opts.waifubux ?? 0 })
    .where(eq(playerCurrencies.playerId, playerId));
  return playerId;
}

const give = (playerId: number, key: string) => grant(t.db, app.gear, playerId, key);
let keySeq = 0;
const key = (label = 'req') => `test-${label}-${++keySeq}-${Date.now()}`;

async function balances(playerId: number) {
  const [row] = await t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
  return { components: row!.salvagedComponents, waifubux: row!.waifubux };
}

async function live(ids: number[]) {
  const rows = await t.db.select().from(playerEquipment).where(inArray(playerEquipment.id, ids));
  return rows.filter((r) => r.removedAt == null).map((r) => r.id).sort((a, b) => a - b);
}

async function owned(playerId: number) {
  return t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
}

async function refused(promise: Promise<unknown>): Promise<EquipmentDismantleRefusedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EquipmentDismantleRefusedError);
  return err as EquipmentDismantleRefusedError;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  for (const g of [GEAR.attack, GEAR.attack2, GEAR.defense, GEAR.health, GEAR.ranged, EXTRA.knife, EXTRA.vest, EXTRA.relic]) {
    await app.gear.definitions.create(g);
  }
  workshop = makeWorkshop();
});

afterAll(async () => {
  await t?.cleanup();
});

/* ─────────────────────────── gate ─────────────────────────── */

describe('the Equipment unlock gates the Workshop', () => {
  it('refuses every read and action before the unlock, and changes nothing', async () => {
    const p = await newPlayer({ unlocked: false, components: 50, waifubux: 5_000 });
    const ring = await give(p, 'training_ring');
    expect(await workshop.isAvailable(p)).toBe(false);
    await expect(workshop.overview(p)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(workshop.dismantleCandidates(p, 0)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(workshop.previewDismantle(p, [ring])).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(workshop.dismantle(p, { equipmentIds: [ring], requestKey: key() })).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(
      workshop.fabricate(p, { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: key() }),
    ).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await live([ring])).toEqual([ring]);
    expect(await balances(p)).toEqual({ components: 50, waifubux: 5_000 });
  });
});

/* ─────────────────────────── overview ─────────────────────────── */

describe('overview', () => {
  it('shows balances, yields and enabled recipes with live slot availability', async () => {
    const p = await newPlayer({ components: 18, waifubux: 4_250 });
    const view = await workshop.overview(p);
    expect(view.balances).toEqual({ components: 18, waifubux: 4_250 });
    expect(view.salvageYields).toEqual([
      { rarity: 'N', components: 1 },
      { rarity: 'R', components: 4 },
      { rarity: 'SR', components: 12 },
    ]);
    expect(view.recipes.map((r) => r.key)).toEqual(['standard_rebuild', 'improved_rebuild', 'advanced_rebuild']);

    const slots = (k: string) =>
      Object.fromEntries(view.recipes.find((r) => r.key === k)!.slots.map((s) => [s.choice, [s.eligibleCount, s.available]]));
    expect(slots('standard_rebuild')).toEqual({ attack: [2, true], defense: [1, true], health: [1, true], any: [4, true] });
    // Health R / SR: no definition yet — shown as unavailable, never substituted.
    expect(slots('improved_rebuild')).toEqual({ attack: [1, true], defense: [1, true], health: [0, false], any: [2, true] });
    expect(slots('advanced_rebuild')).toEqual({ attack: [1, true], defense: [0, false], health: [0, false], any: [1, true] });

    const improved = view.recipes.find((r) => r.key === 'improved_rebuild')!;
    expect(improved).toMatchObject({ componentCost: 15, waifubuxCost: 750, affordable: true, shortfall: { components: 0, waifubux: 0 } });
    const advanced = view.recipes.find((r) => r.key === 'advanced_rebuild')!;
    expect(advanced).toMatchObject({ affordable: false, shortfall: { components: 22, waifubux: 0 } });
  });

  it('is empty, not broken, without a Workshop configuration', async () => {
    const p = await newPlayer();
    const view = await makeWorkshop({ config: null }).overview(p);
    expect(view.recipes).toEqual([]);
    expect(view.salvageYields).toEqual([]);
  });
});

/* ─────────────────────────── dismantling ─────────────────────────── */

describe('dismantle yields', () => {
  it.each([
    ['N', 'training_ring', 1],
    ['R', 'test_knife', 4],
    ['SR', 'plasma_coil_ring', 12],
  ])('%s pays %i… exactly once', async (_rarity, definition, expected) => {
    const p = await newPlayer({ components: 3 });
    const id = await give(p, definition);
    const out = await workshop.dismantle(p, { equipmentIds: [id], requestKey: key() });
    expect(out).toMatchObject({ replayed: false, count: 1, totalComponents: expected });
    expect(await balances(p)).toEqual({ components: 3 + expected, waifubux: 0 });
    expect(await live([id])).toEqual([]);
  });

  it('ignores roll quality: the worst and best roll of a definition pay the same', async () => {
    const p = await newPlayer();
    const worst = await grant(t.db, app.gear, p, 'test_knife', { roll: { kind: 'fixed', rolledMultiplierBp: 6_500, affixKey: null } });
    const best = await grant(t.db, app.gear, p, 'test_knife', { roll: { kind: 'fixed', rolledMultiplierBp: 8_500, affixKey: null } });
    const preview = await workshop.previewDismantle(p, [worst, best]);
    expect(preview.items.map((i) => i.components)).toEqual([4, 4]);
  });

  it('refuses an unsupported rarity rather than guessing a value', async () => {
    const p = await newPlayer();
    const relic = await give(p, 'test_relic');
    const err = await refused(workshop.dismantle(p, { equipmentIds: [relic], requestKey: key() }));
    expect(err.problems).toEqual([{ equipmentId: relic, reason: 'unsupported_rarity' }]);
    expect(await live([relic])).toEqual([relic]);
    expect((await balances(p)).components).toBe(0);
  });

  it('writes a dismantled event per copy and an operation row, never marks gear "sold"', async () => {
    const p = await newPlayer();
    const a = await give(p, 'training_ring');
    const b = await give(p, 'test_knife');
    const requestKey = key();
    await workshop.dismantle(p, { equipmentIds: [a, b], requestKey });
    const rows = await t.db.select().from(playerEquipment).where(inArray(playerEquipment.id, [a, b]));
    expect(rows.map((r) => r.removedReason)).toEqual(['dismantled', 'dismantled']);
    const events = await t.db
      .select()
      .from(equipmentEvents)
      .where(and(eq(equipmentEvents.playerId, p), eq(equipmentEvents.kind, 'dismantled')));
    expect(events.map((e) => [e.equipmentId, (e.metadata as { components: number }).components]).sort()).toEqual(
      [[a, 1], [b, 4]].sort(),
    );
    const [op] = await t.db.select().from(equipmentWorkshopOperations).where(eq(equipmentWorkshopOperations.requestKey, requestKey));
    expect(op).toMatchObject({ kind: 'dismantle', componentsDelta: 5, waifubuxDelta: 0, componentsAfter: 5 });
    expect([...op!.equipmentIds].sort()).toEqual([a, b].sort());
  });
});

describe('dismantle safeguards', () => {
  it('refuses equipped, favourite and locked copies, naming each', async () => {
    const p = await newPlayer();
    const equipped = await give(p, 'training_ring');
    const favourite = await give(p, 'padded_belt');
    const locked = await give(p, 'basic_harness');
    const free = await give(p, 'rusty_test_pipe');
    await app.gear.equipment.equip(p, { slot: 'attack', equipmentId: equipped });
    await app.gear.equipment.setFlags(p, favourite, { isFavorite: true });
    await app.gear.equipment.setFlags(p, locked, { isLocked: true });

    const err = await refused(
      workshop.dismantle(p, { equipmentIds: [free, equipped, favourite, locked], requestKey: key() }),
    );
    expect(err.problems).toEqual([
      { equipmentId: equipped, reason: 'equipped' },
      { equipmentId: favourite, reason: 'favorite' },
      { equipmentId: locked, reason: 'locked' },
    ]);
    // All or nothing: the one free copy survived too.
    expect(await live([free, equipped, favourite, locked])).toEqual([free, equipped, favourite, locked].sort((x, y) => x - y));
    expect((await balances(p)).components).toBe(0);
  });

  it('refuses a foreign copy exactly like a missing one', async () => {
    const owner = await newPlayer();
    const thief = await newPlayer();
    const ring = await give(owner, 'training_ring');
    const err = await refused(workshop.dismantle(thief, { equipmentIds: [ring], requestKey: key() }));
    expect(err.problems).toEqual([{ equipmentId: ring, reason: 'not_owned' }]);
    const missing = await refused(workshop.previewDismantle(thief, [999_999_999]));
    expect(missing.problems).toEqual([{ equipmentId: 999_999_999, reason: 'not_owned' }]);
    expect(await live([ring])).toEqual([ring]);
  });

  it('refuses duplicate ids and empty or oversized selections', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    const err = await refused(workshop.dismantle(p, { equipmentIds: [ring, ring], requestKey: key() }));
    expect(err.problems).toEqual([{ equipmentId: ring, reason: 'duplicate' }]);
    await expect(workshop.dismantle(p, { equipmentIds: [], requestKey: key() })).rejects.toBeInstanceOf(
      EquipmentDismantleSelectionError,
    );
    await expect(
      workshop.previewDismantle(p, Array.from({ length: 51 }, (_, i) => i + 1)),
    ).rejects.toBeInstanceOf(EquipmentDismantleSelectionError);
    expect(await live([ring])).toEqual([ring]);
  });

  it('refuses a stale confirmation: favourited after review, nothing is destroyed', async () => {
    const p = await newPlayer();
    const a = await give(p, 'training_ring');
    const b = await give(p, 'padded_belt');
    const preview = await workshop.previewDismantle(p, [a, b]);
    expect(preview).toMatchObject({ count: 2, totalComponents: 2, componentsAfter: 2 });
    await app.gear.equipment.setFlags(p, b, { isFavorite: true });
    const err = await refused(
      workshop.dismantle(p, { equipmentIds: [a, b], requestKey: key(), expectedComponents: preview.totalComponents }),
    );
    expect(err.problems).toEqual([{ equipmentId: b, reason: 'favorite' }]);
    expect(await live([a, b])).toEqual([a, b].sort((x, y) => x - y));
  });

  it('refuses when the reviewed yield no longer matches, and rolls the removal back', async () => {
    const p = await newPlayer();
    const knife = await give(p, 'test_knife');
    await expect(
      workshop.dismantle(p, { equipmentIds: [knife], requestKey: key(), expectedComponents: 1 }),
    ).rejects.toBeInstanceOf(WorkshopPreviewStaleError);
    expect(await live([knife])).toEqual([knife]);
    expect((await balances(p)).components).toBe(0);
  });

  it('never pays WaifuBux', async () => {
    const p = await newPlayer({ waifubux: 100 });
    const id = await give(p, 'plasma_coil_ring');
    const out = await workshop.dismantle(p, { equipmentIds: [id], requestKey: key() });
    expect(out.balances.waifubux).toBe(100);
  });
});

describe('dismantle idempotency and concurrency', () => {
  it('a retried confirmation replays: no second credit, no further gear destroyed', async () => {
    const p = await newPlayer();
    const a = await give(p, 'training_ring');
    const b = await give(p, 'test_knife');
    const requestKey = key();
    const first = await workshop.dismantle(p, { equipmentIds: [a, b], requestKey });
    const again = await workshop.dismantle(p, { equipmentIds: [b, a], requestKey });
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, count: 2, totalComponents: 5 });
    expect(again.items.map((i) => i.displayName).sort()).toEqual(first.items.map((i) => i.displayName).sort());
    expect((await balances(p)).components).toBe(5);
  });

  it('refuses a key reused for a different selection', async () => {
    const p = await newPlayer();
    const a = await give(p, 'training_ring');
    const b = await give(p, 'padded_belt');
    const requestKey = key();
    await workshop.dismantle(p, { equipmentIds: [a], requestKey });
    await expect(workshop.dismantle(p, { equipmentIds: [b], requestKey })).rejects.toBeInstanceOf(
      WorkshopRequestConflictError,
    );
    expect(await live([b])).toEqual([b]);
  });

  it('the same confirmation sent twice at once credits exactly once', async () => {
    const p = await newPlayer();
    const ids = [await give(p, 'training_ring'), await give(p, 'test_knife')];
    const requestKey = key();
    const results = await Promise.all([
      workshop.dismantle(p, { equipmentIds: ids, requestKey }),
      workshop.dismantle(p, { equipmentIds: ids, requestKey }),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect((await balances(p)).components).toBe(5);
  });

  it('two different requests racing for one copy: exactly one wins', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    const settled = await Promise.allSettled([
      workshop.dismantle(p, { equipmentIds: [ring], requestKey: key('a') }),
      workshop.dismantle(p, { equipmentIds: [ring], requestKey: key('b') }),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(EquipmentDismantleRefusedError);
    expect((await balances(p)).components).toBe(1);
  });

  it('a favourite racing a dismantle never leaves a favourited copy destroyed', async () => {
    const p = await newPlayer();
    const ring = await give(p, 'training_ring');
    const [dismantle] = await Promise.allSettled([
      workshop.dismantle(p, { equipmentIds: [ring], requestKey: key() }),
      app.gear.equipment.setFlags(p, ring, { isFavorite: true }).catch(() => null),
    ]);
    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, ring));
    if (dismantle.status === 'fulfilled') {
      expect(row!.removedReason).toBe('dismantled');
      expect(row!.isFavorite).toBe(false);
    } else {
      expect(row!.removedAt).toBeNull();
      expect(row!.isFavorite).toBe(true);
    }
  });
});

/* ─────────────────────────── fabrication ─────────────────────────── */

describe('fabrication', () => {
  it('charges the recipe once and grants one copy of its rarity in the chosen slot', async () => {
    const p = await newPlayer({ components: 20, waifubux: 1_000 });
    const out = await workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key() });
    expect(out).toMatchObject({
      replayed: false,
      recipe: { key: 'improved_rebuild', rarity: 'R' },
      slotChoice: 'attack',
      cost: { components: 15, waifubux: 750 },
      balances: { components: 5, waifubux: 250 },
      item: { name: 'Test Knife', slot: 'attack', rarity: 'R' },
    });
    expect(await balances(p)).toEqual({ components: 5, waifubux: 250 });
    // The normal random roll: one of the definition's discrete values, an affix from its own pool.
    expect([6_500, 7_000, 7_500, 8_000, 8_500]).toContain(out.item.rolledMultiplierBp);
    expect(out.item.affixSuffix).toBe('of Attack R Flair');
    expect(out.item.displayName).toBe('Test Knife of Attack R Flair');
    expect((await owned(p)).map((r) => r.id)).toEqual([out.item.equipmentId]);
  });

  it('records the fabrication source on the instance and the audit trail', async () => {
    const p = await newPlayer({ components: 5, waifubux: 250 });
    const requestKey = key();
    const out = await workshop.fabricate(p, { recipeKey: 'standard_rebuild', slot: 'defense', requestKey });
    const [row] = await owned(p);
    expect(row).toMatchObject({
      sourceType: 'fabrication',
      sourceKey: 'standard_rebuild',
      grantKey: `${fabricationGrantKey(p, requestKey)}:0`,
      isFavorite: false,
      isLocked: false,
    });
    const [granted] = await t.db
      .select()
      .from(equipmentEvents)
      .where(and(eq(equipmentEvents.equipmentId, out.item.equipmentId), eq(equipmentEvents.kind, 'granted')));
    expect(granted!.metadata).toMatchObject({ sourceType: 'fabrication', sourceKey: 'standard_rebuild', rollKind: 'random' });
    const [op] = await t.db.select().from(equipmentWorkshopOperations).where(eq(equipmentWorkshopOperations.requestKey, requestKey));
    expect(op).toMatchObject({
      kind: 'fabricate',
      recipeKey: 'standard_rebuild',
      rarity: 'N',
      slotChoice: 'defense',
      componentsDelta: -5,
      waifubuxDelta: -250,
      componentsAfter: 0,
      waifubuxAfter: 0,
      equipmentIds: [out.item.equipmentId],
    });
  });

  it('picks uniformly from the eligible definitions through the shared reward picker', async () => {
    // Eligible N attack, sorted by key: rusty_test_pipe, training_ring.
    const p = await newPlayer({ components: 10, waifubux: 500 });
    const low = await makeWorkshop({ rewardRng: LOW }).fabricate(p, { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: key() });
    const high = await makeWorkshop({ rewardRng: HIGH }).fabricate(p, { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: key() });
    expect([low.item.name, high.item.name]).toEqual(['Rusty Test Pipe', 'Training Ring']);
  });

  it('"Any" draws across every slot of the rarity', async () => {
    const p = await newPlayer({ components: 30, waifubux: 1_500 });
    // Eligible R, any slot, sorted by key: test_knife (attack), test_vest (defense).
    const low = await makeWorkshop({ rewardRng: LOW }).fabricate(p, { recipeKey: 'improved_rebuild', slot: 'any', requestKey: key() });
    const high = await makeWorkshop({ rewardRng: HIGH }).fabricate(p, { recipeKey: 'improved_rebuild', slot: 'any', requestKey: key() });
    expect([low.item.slot, high.item.slot]).toEqual(['attack', 'defense']);
    expect([low.item.rarity, high.item.rarity]).toEqual(['R', 'R']);
  });

  it('a single eligible Health definition is selected normally', async () => {
    const p = await newPlayer({ components: 5, waifubux: 250 });
    const out = await workshop.fabricate(p, { recipeKey: 'standard_rebuild', slot: 'health', requestKey: key() });
    expect(out.item).toMatchObject({ name: 'Basic Harness', slot: 'health', rarity: 'N' });
  });

  it('refuses a slot with no eligible definition before charging, never substituting', async () => {
    const p = await newPlayer({ components: 100, waifubux: 10_000 });
    await expect(
      workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'health', requestKey: key() }),
    ).rejects.toBeInstanceOf(WorkshopNoEligibleEquipmentError);
    await expect(
      workshop.fabricate(p, { recipeKey: 'advanced_rebuild', slot: 'defense', requestKey: key() }),
    ).rejects.toBeInstanceOf(WorkshopNoEligibleEquipmentError);
    expect(await balances(p)).toEqual({ components: 100, waifubux: 10_000 });
    expect(await owned(p)).toEqual([]);
  });

  it('refuses unknown and disabled recipes', async () => {
    const p = await newPlayer({ components: 100, waifubux: 10_000 });
    for (const recipeKey of ['retired_rebuild', 'no_such_recipe']) {
      await expect(workshop.fabricate(p, { recipeKey, slot: 'attack', requestKey: key() })).rejects.toBeInstanceOf(
        WorkshopRecipeUnavailableError,
      );
    }
    expect(await balances(p)).toEqual({ components: 100, waifubux: 10_000 });
  });

  it('refuses short Components or WaifuBux without moving either balance', async () => {
    const shortComponents = await newPlayer({ components: 14, waifubux: 10_000 });
    await expect(
      workshop.fabricate(shortComponents, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key() }),
    ).rejects.toBeInstanceOf(InsufficientComponentsError);
    expect(await balances(shortComponents)).toEqual({ components: 14, waifubux: 10_000 });

    const shortBux = await newPlayer({ components: 100, waifubux: 749 });
    await expect(
      workshop.fabricate(shortBux, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key() }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await balances(shortBux)).toEqual({ components: 100, waifubux: 749 });
    expect(await owned(shortBux)).toEqual([]);
  });

  it('a retry returns the same item, charged once, never rerolled', async () => {
    const p = await newPlayer({ components: 30, waifubux: 2_000 });
    const requestKey = key();
    const first = await workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey });
    const again = await workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey });
    expect(again.replayed).toBe(true);
    expect(again.item).toEqual(first.item);
    expect(again.cost).toEqual({ components: 15, waifubux: 750 });
    expect(await balances(p)).toEqual({ components: 15, waifubux: 1_250 });
    expect(await owned(p)).toHaveLength(1);
    await expect(
      workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'defense', requestKey }),
    ).rejects.toBeInstanceOf(WorkshopRequestConflictError);
  });

  it('the same confirmation sent twice at once charges once and grants one item', async () => {
    const p = await newPlayer({ components: 30, waifubux: 2_000 });
    const requestKey = key();
    const results = await Promise.all([
      workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey }),
      workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey }),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.item.equipmentId).toBe(results[1]!.item.equipmentId);
    expect(await balances(p)).toEqual({ components: 15, waifubux: 1_250 });
    expect(await owned(p)).toHaveLength(1);
  });

  it('concurrent fabrications cannot overspend one balance', async () => {
    const p = await newPlayer({ components: 5, waifubux: 1_000 });
    const settled = await Promise.allSettled(
      [0, 1, 2].map(() => workshop.fabricate(p, { recipeKey: 'standard_rebuild', slot: 'any', requestKey: key() })),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[]) {
      expect(s.reason).toBeInstanceOf(InsufficientComponentsError);
    }
    expect(await balances(p)).toEqual({ components: 0, waifubux: 750 });
    expect(await owned(p)).toHaveLength(1);
  });

  it('fabrication racing another WaifuBux spend never goes negative', async () => {
    const p = await newPlayer({ components: 5, waifubux: 300 });
    const settled = await Promise.allSettled([
      workshop.fabricate(p, { recipeKey: 'standard_rebuild', slot: 'attack', requestKey: key() }),
      t.db.transaction((tx) => app.currency.spendWaifubux(tx, p, 100)),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const after = await balances(p);
    expect(after.waifubux).toBeGreaterThanOrEqual(0);
    expect([50, 200]).toContain(after.waifubux);
  });

  it('a disabled definition stops being fabricated, and an empty pool is refused', async () => {
    const p = await newPlayer({ components: 100, waifubux: 10_000 });
    await app.gear.definitions.setEnabled('test_vest', false);
    try {
      const view = await workshop.overview(p);
      const improved = view.recipes.find((r) => r.key === 'improved_rebuild')!;
      expect(improved.slots.find((s) => s.choice === 'defense')).toMatchObject({ eligibleCount: 0, available: false });
      await expect(
        workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'defense', requestKey: key() }),
      ).rejects.toBeInstanceOf(WorkshopNoEligibleEquipmentError);
      expect(await balances(p)).toEqual({ components: 100, waifubux: 10_000 });
    } finally {
      await app.gear.definitions.setEnabled('test_vest', true);
    }
  });

  it('fabricated gear is ordinary gear: equip, flag, and later dismantle it', async () => {
    const p = await newPlayer({ components: 15, waifubux: 750 });
    const made = await workshop.fabricate(p, { recipeKey: 'improved_rebuild', slot: 'attack', requestKey: key() });
    const id = made.item.equipmentId;
    await app.gear.equipment.equip(p, { slot: 'attack', equipmentId: id });
    await refused(workshop.dismantle(p, { equipmentIds: [id], requestKey: key() }));
    await app.gear.equipment.unequip(p, { slot: 'attack' });
    const out = await workshop.dismantle(p, { equipmentIds: [id], requestKey: key() });
    // 15 spent, 4 back: the loop is a sink, never a faucet.
    expect(out.balances).toEqual({ components: 4, waifubux: 0 });
  });
});

/* ─────────────────────────── Discord list ─────────────────────────── */

describe('dismantle candidates', () => {
  it('lists every copy cheapest-first with its yield and why it is protected', async () => {
    const p = await newPlayer();
    const sr = await give(p, 'plasma_coil_ring');
    const n = await give(p, 'training_ring');
    const relic = await give(p, 'test_relic');
    await app.gear.equipment.setFlags(p, n, { isLocked: true });
    const page = await workshop.dismantleCandidates(p, 0);
    expect(page.items.map((c) => [c.item.id, c.components, c.blockedBy])).toEqual([
      [n, 1, 'locked'],
      [sr, 12, null],
      [relic, null, 'unsupported_rarity'],
    ]);
  });

  it('paginates', async () => {
    const p = await newPlayer();
    for (let i = 0; i < 12; i += 1) await give(p, 'training_ring');
    const first = await workshop.dismantleCandidates(p, 0);
    const second = await workshop.dismantleCandidates(p, 1);
    expect([first.items.length, second.items.length, first.totalPages, first.totalItems]).toEqual([10, 2, 2, 12]);
  });
});
