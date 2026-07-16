/**
 * HuntService integration — real Postgres, seeded/scripted RNG.
 * Covers energy spend, cooldown, one-active-encounter, stale expiry, non-
 * encounter rewards, encounter row creation, Let Her Go, disabled-species
 * skipping, and transaction rollback on injected failure.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encounters, playerCurrencies, players, species } from '../../src/db/schema';
import { createHuntService } from '../../src/modules/hunt/huntService';
import {
  ActiveEncounterError,
  HuntCooldownError,
  InsufficientEnergyError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
const CHANNEL_ID = 'chan-hunt';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

/** RNG stub that walks a pre-programmed script of `next()` outputs. */
function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  const next = (): number => {
    if (i >= nexts.length) {
      throw new Error(`scriptedRng exhausted at index ${i}`);
    }
    return nexts[i++]!;
  };
  return {
    next,
    intInclusive(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
  };
}

async function resetPlayer(playerId: number, energy = 25): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: energy, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, playerId));
}

describe('HuntService — energy, cooldown, encounter lifecycle', () => {
  let playerId: number;
  beforeAll(async () => {
    const p = await provisionPlayer(app, 'g-hunt', 'u-1');
    playerId = p.playerId;
  });
  beforeEach(() => resetPlayer(playerId));

  it('spends 1 energy on a successful hunt', async () => {
    // Pick "encounter" first (0.0 hits weight 70), then rarity N (0.0 hits N),
    // then species pick (0.0 → first species).
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0]),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('encounter');
    expect(result.energyRemaining).toBe(24);
    const bal = await app.currency.getBalances(playerId);
    expect(bal.huntEnergy).toBe(24);
  });

  it('rejects when out of energy — no rows written', async () => {
    await app.currency.setHuntEnergy(t.db, playerId, 0);
    const before = await t.db
      .select()
      .from(encounters)
      .where(eq(encounters.playerId, playerId));
    await expect(app.hunt.hunt(playerId, CHANNEL_ID)).rejects.toBeInstanceOf(
      InsufficientEnergyError,
    );
    const after = await t.db.select().from(encounters).where(eq(encounters.playerId, playerId));
    expect(after.length).toBe(before.length);
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(0);
  });

  it('enforces the hunt cooldown', async () => {
    const now = new Date('2026-07-15T12:00:00Z');
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      // Two flavor rolls (each consumes 2 next() calls). The cooldown-blocked
      // second hunt is rejected before any RNG is touched.
      rng: scriptedRng([0.99, 0.0, 0.99, 0.0]),
    });
    // First hunt lands on 'flavor' (0.99 picks the last weighted bucket).
    const first = await scripted.hunt(playerId, CHANNEL_ID, now);
    expect(first.kind).toBe('flavor');

    // Immediately try again — cooldown blocks.
    const soon = new Date(now.getTime() + 1000);
    await expect(scripted.hunt(playerId, CHANNEL_ID, soon)).rejects.toBeInstanceOf(
      HuntCooldownError,
    );
    // Energy unchanged after the rejection.
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(24);

    // After cooldown elapses, hunts succeed again.
    const later = new Date(now.getTime() + app.content.tables.hunt.cooldownSeconds * 1000 + 500);
    const third = await scripted.hunt(playerId, CHANNEL_ID, later);
    expect(third.kind).toBe('flavor');
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(23);
  });

  it('blocks new hunts while an encounter is still active', async () => {
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0]),
    });
    const first = await scripted.hunt(playerId, CHANNEL_ID);
    expect(first.kind).toBe('encounter');

    const energyAfterFirst = (await app.currency.getBalances(playerId)).huntEnergy;
    // Bypass the cooldown for the second call (nulling lastHuntAt).
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
    await expect(app.hunt.hunt(playerId, CHANNEL_ID)).rejects.toBeInstanceOf(ActiveEncounterError);
    // Second call must not spend energy.
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(energyAfterFirst);
  });

  it('lazily expires stale active encounters, freeing the next hunt', async () => {
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    });
    const first = await scripted.hunt(playerId, CHANNEL_ID);
    if (first.kind !== 'encounter') throw new Error('expected encounter');
    // Time-travel: force the encounter to look expired.
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(encounters.id, first.encounter.id));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));

    const second = await scripted.hunt(playerId, CHANNEL_ID);
    expect(second.kind).toBe('encounter');
    const [expired] = await t.db
      .select()
      .from(encounters)
      .where(eq(encounters.id, first.encounter.id));
    expect(expired?.state).toBe('expired');
  });

  it('expireStale sweeps stale actives across all players', async () => {
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0]),
    });
    const first = await scripted.hunt(playerId, CHANNEL_ID);
    if (first.kind !== 'encounter') throw new Error('expected encounter');
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(encounters.id, first.encounter.id));
    const swept = await app.hunt.expireStale();
    expect(swept).toBeGreaterThanOrEqual(1);
    const [row] = await t.db
      .select()
      .from(encounters)
      .where(eq(encounters.id, first.encounter.id));
    expect(row?.state).toBe('expired');
  });

  it('Let Her Go resolves an active encounter as released', async () => {
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0]),
    });
    const first = await scripted.hunt(playerId, CHANNEL_ID);
    if (first.kind !== 'encounter') throw new Error('expected encounter');
    const released = await app.hunt.letHerGo(playerId, first.encounter.id);
    expect(released.state).toBe('released');
    expect(released.resolvedAt).not.toBeNull();
    // And the active-encounter slot is now free.
    expect(await app.hunt.getActiveEncounter(playerId)).toBeNull();
  });

  it('encounter row carries the expected defaults and expiry', async () => {
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.0, 0.0, 0.0]),
    });
    const before = Date.now();
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    if (result.kind !== 'encounter') throw new Error('expected encounter');
    expect(result.encounter.state).toBe('active');
    expect(result.encounter.attemptCount).toBe(0);
    expect(result.encounter.maxAttempts).toBe(3);
    expect(result.encounter.channelId).toBe(CHANNEL_ID);
    const window = result.encounter.expiresAt.getTime() - before;
    const expiryMs = app.content.tables.hunt.encounterExpirySeconds * 1000;
    expect(window).toBeGreaterThanOrEqual(expiryMs - 2_000);
    expect(window).toBeLessThanOrEqual(expiryMs + 2_000);
  });
});

describe('HuntService — non-encounter rewards', () => {
  let playerId: number;
  beforeAll(async () => {
    const p = await provisionPlayer(app, 'g-hunt-rewards', 'u-1');
    playerId = p.playerId;
  });
  beforeEach(() => resetPlayer(playerId));

  const rewardsRng = (bucketPick: number, subPick: number, qtyPick: number): Rng =>
    scriptedRng([bucketPick, subPick, qtyPick]);

  it('grants a WaifuBux find', async () => {
    // First .next() picks result bucket — WaifuBux is at cumulative ~90-98/100.
    // Weights [70,12,8,5,3,2] total 100; cumulative: 70,82,90,95,98,100.
    // wb bucket is (82,90]/100 → 0.85 lands in wb_find.
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: rewardsRng(0.85, 0.5, 0.0),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('waifubux_find');
    if (result.kind !== 'waifubux_find') throw new Error();
    expect(result.amount).toBeGreaterThanOrEqual(app.content.tables.hunt.waifubuxFind.min);
    expect(result.amount).toBeLessThanOrEqual(app.content.tables.hunt.waifubuxFind.max);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(result.amount);
  });

  it('grants an Essence find', async () => {
    // essence bucket 90-95 → 0.92.
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: rewardsRng(0.92, 0.5, 0.0),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('essence_find');
    if (result.kind !== 'essence_find') throw new Error();
    expect((await app.currency.getBalances(playerId)).essence).toBe(result.amount);
  });

  it('grants an item find into inventory', async () => {
    // item_find bucket 70-82 → 0.75, then sub roll (basic weight 70/100 → 0.1 picks basic), then qty.
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: rewardsRng(0.75, 0.1, 0.0),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('item_find');
    if (result.kind !== 'item_find') throw new Error();
    const basic = await getItemBySlug(t.db, 'basic_charm');
    expect(result.item.slug).toBe('basic_charm');
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(result.quantity);
  });

  it('grants a rare item find (Mythic is reachable via this path)', async () => {
    // rare bucket 95-98 → 0.96, then sub pick — 0.999 selects the last (mythic).
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: rewardsRng(0.96, 0.999, 0.0),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('rare_item_find');
    if (result.kind !== 'rare_item_find') throw new Error();
    expect(result.item.slug).toBe('mythic_contract');
    const mythic = await getItemBySlug(t.db, 'mythic_contract');
    expect(await app.inventory.getQuantity(playerId, mythic.id)).toBe(1);
  });

  it('yields a flavor result at the tail of the table', async () => {
    // flavor bucket 98-100 → 0.99, then flavor line index (intInclusive(0, N-1)).
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: rewardsRng(0.99, 0.0, 0.0),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('flavor');
  });

  it('skips disabled species when rolling an encounter', async () => {
    // Disable every N species so rarity N returns an empty bucket → reroll.
    await t.db.update(species).set({ enabled: false }).where(eq(species.rarity, 'N'));

    // First rarity roll → N (weight 60/100 → 0.0). After empty bucket, reroll:
    // second rarity roll needs to land somewhere with species. 0.99 → LR (tail).
    // But there's no LR in placeholders either — walk up to UR: void_empress.
    // Rarity weights: N60 R25 SR10 SSR4 UR0.9 LR0.1 → cumulative 60/85/95/99/99.9/100.
    // 0.995 lands in UR bucket → void_empress (single enabled species there).
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([
        // pick encounter kind
        0.0,
        // first rarity attempt → N (empty)
        0.0,
        // second rarity attempt → UR
        0.995,
        // species-within-rarity (only one enabled)
        0.0,
      ]),
    });
    const result = await scripted.hunt(playerId, CHANNEL_ID);
    expect(result.kind).toBe('encounter');
    if (result.kind !== 'encounter') throw new Error();
    expect(result.species.rarity).not.toBe('N');

    // Restore.
    await t.db.update(species).set({ enabled: true }).where(eq(species.rarity, 'N'));
  });
});

describe('HuntService — transaction safety', () => {
  it('rolls back energy when the reward grant throws', async () => {
    const { playerId } = await provisionPlayer(app, 'g-hunt-tx', 'u-1');
    await resetPlayer(playerId, 10);
    const spy = vi.spyOn(app.currency, 'grantWaifubux').mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const scripted = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      tables: app.content.tables,
      logger: t.logger,
      // pick waifubux_find bucket then amount.
      rng: scriptedRng([0.85, 0.5, 0.0]),
    });
    await expect(scripted.hunt(playerId, CHANNEL_ID)).rejects.toThrow('boom');
    // Energy must be unchanged because the whole hunt was one transaction.
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(10);
    // And no encounter row leaked in.
    const rows = await t.db
      .select()
      .from(encounters)
      .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
    expect(rows).toHaveLength(0);
    spy.mockRestore();
  });
});
