/**
 * ProgressionService integration — verifies that XP grants land in the
 * player_progression_events audit log, that the player row's level advances
 * across thresholds (including multiple level-ups from one big grant), and
 * that the level-scaled effects reach into daily / hunt / rarity.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  items,
  playerCurrencies,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
} from '../../src/db/schema';
import type { Rng } from '../../src/shared/random';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  return {
    next: () => {
      if (i >= nexts.length) throw new Error(`scriptedRng exhausted at ${i}`);
      return nexts[i++]!;
    },
    intInclusive(min, max) {
      const v = nexts[i++]!;
      return Math.floor(v * (max - min + 1)) + min;
    },
  };
}

async function resetPlayerState(playerId: number, xp = 0, level = 1): Promise<void> {
  await t.db.delete(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, playerId));
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  await t.db.update(players).set({ xp, level, lastHuntAt: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, playerId));
}

async function eventTypesFor(playerId: number): Promise<string[]> {
  const rows = await t.db
    .select({ eventType: playerProgressionEvents.eventType })
    .from(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId))
    .orderBy(playerProgressionEvents.id);
  return rows.map((r) => r.eventType);
}

describe('grantXp — audit and level-up mechanics', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-progression', 'u-1'));
  });
  beforeEach(() => resetPlayerState(playerId));

  it('records an audit row per grant and updates total XP', async () => {
    const grant = await t.db.transaction(async (tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'hunt', xpDelta: 5 }),
    );
    expect(grant.totalXp).toBe(5);
    expect(grant.fromLevel).toBe(1);
    expect(grant.toLevel).toBe(1);
    expect(grant.levelUps).toEqual([]);
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.xp).toBe(5);
    const [{ n }] = await t.db
      .select({ n: count() })
      .from(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, playerId));
    expect(n).toBe(1);
  });

  it('levels up once when crossing exactly one threshold', async () => {
    const grant = await t.db.transaction(async (tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'hunt', xpDelta: 100 }),
    );
    expect(grant.fromLevel).toBe(1);
    expect(grant.toLevel).toBe(2);
    expect(grant.levelUps).toHaveLength(1);
    expect(grant.levelUps[0]!.toLevel).toBe(2);
  });

  it('reports multiple level-ups from one large grant', async () => {
    // Level 4 threshold cumulative XP = 100 + 150 + 200 = 450.
    const grant = await t.db.transaction(async (tx) =>
      app.progression.grantXp(tx, playerId, { eventType: 'hunt', xpDelta: 500 }),
    );
    expect(grant.fromLevel).toBe(1);
    expect(grant.toLevel).toBe(4);
    expect(grant.levelUps.map((l) => l.toLevel)).toEqual([2, 3, 4]);
  });

  it('caps at maxLevel (never advances beyond)', async () => {
    // Absurd XP grant.
    const grant = await t.db.transaction(async (tx) =>
      app.progression.grantXp(tx, playerId, {
        eventType: 'daily_claim',
        xpDelta: 10_000_000,
      }),
    );
    expect(grant.toLevel).toBe(app.content.tables.progression.maxLevel);
  });

  it('rolls XP back with the transaction on failure', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await app.progression.grantXp(tx, playerId, { eventType: 'hunt', xpDelta: 500 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.xp).toBe(0);
    expect(player?.level).toBe(1);
    const [{ n }] = await t.db
      .select({ n: count() })
      .from(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, playerId));
    expect(n).toBe(0);
  });
});

describe('hunt grants +5 XP and audit row', () => {
  it('records a hunt event on every hunt', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-hunt', 'u-1');
    await resetPlayerState(playerId);
    const scriptedApp = await bootstrapApp(t, {
      huntRng: scriptedRng([0.99, 0.0]), // flavor bucket → flavor line 0
    });
    // provisionPlayer stored the row in shared app; scripted app shares the DB.
    const result = await scriptedApp.hunt.hunt(playerId, 'c-1');
    expect(result.kind).toBe('flavor');
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.xp).toBe(5);
    expect(await eventTypesFor(playerId)).toContain('hunt');
  });
});

describe('capture XP', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-progression-capture', 'u-1'));
  });
  beforeEach(() => resetPlayerState(playerId));

  async function makeEncounter(slug: string): Promise<number> {
    const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
    const [enc] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: sp!.id,
        channelId: 'c-1',
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return enc!.id;
  }

  async function grantItem(slug: string, qty: number): Promise<void> {
    const item = await getItemBySlug(t.db, slug);
    await app.inventory.addItem(t.db, playerId, item.id, qty);
  }

  it('successful capture grants rarity XP + new-dex bonus, first time only', async () => {
    await grantItem('mythic_contract', 2);
    const encId = await makeEncounter('neko_barista'); // N — 10 XP + 25 new dex = 35
    const r1 = await app.capture.attemptCapture(playerId, encId, 'mythic_contract');
    expect(r1.outcome).toBe('success');
    expect(r1.isNewDex).toBe(true);
    expect(r1.xpGranted).toBe(35);
    const [afterFirst] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(afterFirst?.xp).toBe(35);

    const encId2 = await makeEncounter('neko_barista');
    const r2 = await app.capture.attemptCapture(playerId, encId2, 'mythic_contract');
    expect(r2.outcome).toBe('success');
    expect(r2.isNewDex).toBe(false);
    // Duplicate: base rarity value only.
    expect(r2.xpGranted).toBe(10);
    // Audit shows: 1 capture_success + 1 new_dex_entry + 1 capture_success.
    expect(await eventTypesFor(playerId)).toEqual([
      'capture_success',
      'new_dex_entry',
      'capture_success',
    ]);
  });

  it('failed capture attempt grants 2 XP', async () => {
    await grantItem('basic_charm', 3);
    // UR species (void_empress) with basic charm: chance clamped at 0.02;
    // roll 0.99 fails.
    const scriptedApp = await bootstrapApp(t, { captureRng: scriptedRng([0.99, 0.99, 0.99]) });
    const encId = await makeEncounter('void_empress');
    const r1 = await scriptedApp.capture.attemptCapture(playerId, encId, 'basic_charm');
    expect(r1.outcome).toBe('failure');
    expect(r1.xpGranted).toBe(2);
    const r2 = await scriptedApp.capture.attemptCapture(playerId, encId, 'basic_charm');
    expect(r2.outcome).toBe('failure');
    const r3 = await scriptedApp.capture.attemptCapture(playerId, encId, 'basic_charm');
    expect(r3.outcome).toBe('escape');
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.xp).toBe(6);
    expect(await eventTypesFor(playerId)).toEqual([
      'capture_failed',
      'capture_failed',
      'capture_failed',
    ]);
  });
});

describe('daily scales with level', () => {
  it('grants +20 XP and refills to computed max energy', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-daily', 'u-1');
    await resetPlayerState(playerId);
    const result = await app.daily.claim(playerId);
    expect(result.energySetTo).toBe(25);
    expect(result.xp.xpDelta).toBe(20);
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(player?.xp).toBe(20);
  });

  it('at level 12 the package adds +1 Silk Charm', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-daily-12', 'u-1');
    await resetPlayerState(playerId, /* xp */ 0, /* level */ 12);
    const result = await app.daily.claim(playerId);
    const silk = result.items.find((i) => i.item.slug === 'silk_charm');
    // Base pack has 2 silk + level-12 bonus 1 = 3.
    expect(silk?.quantity).toBe(3);
  });

  it('at level 20 the daily refills energy to 35', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-daily-20', 'u-1');
    await resetPlayerState(playerId, 0, 20);
    const result = await app.daily.claim(playerId);
    expect(result.energySetTo).toBe(35);
  });

  it('at level 30 the daily rolls a rare-item chance (RNG-driven, deterministic)', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-daily-30', 'u-1');
    await resetPlayerState(playerId, 0, 30);
    // 0.01 < 0.15 → grants; 0.99 > 0.15 → does not.
    const grantsApp = await bootstrapApp(t, { dailyRng: scriptedRng([0.01]) });
    const withRare = await grantsApp.daily.claim(playerId);
    expect(withRare.rareItemGranted).toBe(true);
    const velvet = withRare.items.find((i) => i.item.slug === 'velvet_charm');
    // Base pack has 1 velvet + rare bonus 1 = 2.
    expect(velvet?.quantity).toBe(2);
  });

  it('at level 30 the daily does not grant rare item on a bad roll', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-daily-30-miss', 'u-1');
    await resetPlayerState(playerId, 0, 30);
    const missApp = await bootstrapApp(t, { dailyRng: scriptedRng([0.99]) });
    const result = await missApp.daily.claim(playerId);
    expect(result.rareItemGranted).toBe(false);
  });
});

describe('level 40 rarity shift', () => {
  it('adjusts the rarity table so N loses weight and R gains it', async () => {
    const { playerId } = await provisionPlayer(app, 'g-progression-rarity', 'u-1');
    // Baseline weights: N=60 R=25 SR=10 SSR=4 UR=0.9 LR=0.1 (sum 100).
    // Cumulative N covers [0, 60). At level 40, N=59 → covers [0, 59).
    // A `rng.next()` of 0.595 (= 59.5) sits inside N at lvl 1 and inside R at lvl 40.

    // First: level 40 → should land in R.
    await resetPlayerState(playerId, 0, 40);
    const scriptedApp = await bootstrapApp(t, {
      // [encounter kind, rarity roll, species pick within rarity]
      huntRng: scriptedRng([0.0, 0.595, 0.0]),
    });
    const result = await scriptedApp.hunt.hunt(playerId, 'c-1');
    expect(result.kind).toBe('encounter');
    if (result.kind !== 'encounter') throw new Error();
    expect(result.species.rarity).toBe('R');

    // Reset: same seed at level 1 should now land in N.
    await resetPlayerState(playerId, 0, 1);
    const level1App = await bootstrapApp(t, {
      huntRng: scriptedRng([0.0, 0.595, 0.0]),
    });
    const result2 = await level1App.hunt.hunt(playerId, 'c-1');
    expect(result2.kind).toBe('encounter');
    if (result2.kind !== 'encounter') throw new Error();
    expect(result2.species.rarity).toBe('N');
  });
});

describe('data-driven XP config drives daily-claim value', () => {
  it('reads dailyClaim XP from tables.json', async () => {
    expect(app.content.tables.progression.xp.dailyClaim).toBeGreaterThan(0);
    const { playerId } = await provisionPlayer(app, 'g-progression-config', 'u-1');
    await resetPlayerState(playerId);
    const before = await t.db
      .select({ xp: sql<number>`xp` })
      .from(players)
      .where(eq(players.id, playerId));
    const beforeXp = Number(before[0]?.xp ?? 0);
    const result = await app.daily.claim(playerId);
    const [after] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(after?.xp).toBe(beforeXp + app.content.tables.progression.xp.dailyClaim);
    expect(result.xp.xpDelta).toBe(app.content.tables.progression.xp.dailyClaim);
    // Silence unused import lint: `items` — some queries may want it later.
    void items;
  });
});
