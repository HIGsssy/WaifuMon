/**
 * CaptureService integration — real Postgres, scripted RNG.
 * Covers the 3-attempt state machine, Mythic guaranteed capture, inventory
 * consumption + rollback safety, expired encounters, item enable/disable,
 * ownership, and double-click concurrency.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  items,
  playerCurrencies,
  playerInventory,
  playerWaifus,
  species,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import {
  EncounterAlreadyResolvedError,
  EncounterExpiredError,
  EncounterNotFoundError,
  InsufficientItemsError,
  ItemNotFoundError,
} from '../../src/shared/errors';
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

async function grantItem(playerId: number, slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, qty);
}

async function createActiveEncounter(
  playerId: number,
  speciesSlug: string,
  channelId = 'chan-cap',
): Promise<{ encounter: EncounterRow; speciesRow: SpeciesRow }> {
  // Clean any existing active encounter first.
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const [speciesRow] = await t.db.select().from(species).where(eq(species.slug, speciesSlug));
  if (!speciesRow) throw new Error(`missing seeded species ${speciesSlug}`);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: speciesRow.id,
      channelId,
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return { encounter: row!, speciesRow };
}

async function itemQuantity(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(playerId, item.id);
}

describe('CaptureService — capture math and state machine', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-capture-core', 'u-1'));
  });
  beforeEach(async () => {
    // Reset inventory + encounters + waifus between tests.
    await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
    await t.db
      .update(playerCurrencies)
      .set({ huntEnergy: 25, waifubux: 0, essence: 0 })
      .where(eq(playerCurrencies.playerId, playerId));
  });

  it('success on first attempt marks captured, creates player_waifus, consumes item', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    const { encounter, speciesRow } = await createActiveEncounter(playerId, 'neko_barista');
    const capture = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      buddyAffinityConfig: app.content.tables.buddyAffinity,
      collection: app.collection,
      quests: app.quests,
      effects: app.effects,
      logger: t.logger,
      rng: scriptedRng([0.0]), // low roll → below any N chance
    });

    const result = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');
    expect(result.outcome).toBe('success');
    expect(result.encounter.state).toBe('captured');
    expect(result.encounter.attemptCount).toBe(1);
    expect(result.attempt.attemptNumber).toBe(1);
    expect(result.attempt.success).toBe(true);
    expect(result.attempt.guaranteed).toBe(false);
    expect(result.newWaifu).toBeTruthy();
    expect(result.newWaifu?.speciesId).toBe(speciesRow.id);
    expect(result.isDuplicate).toBe(false);
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(0);
  });

  it('failed attempt keeps encounter active and increments attempt_count', async () => {
    await grantItem(playerId, 'basic_charm', 3);
    const { encounter } = await createActiveEncounter(playerId, 'void_empress'); // UR (low chance)
    const capture = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      buddyAffinityConfig: app.content.tables.buddyAffinity,
      collection: app.collection,
      quests: app.quests,
      effects: app.effects,
      logger: t.logger,
      rng: scriptedRng([0.99]), // roll near 1 — well above UR chance
    });

    const result = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');
    expect(result.outcome).toBe('failure');
    expect(result.encounter.state).toBe('active');
    expect(result.encounter.attemptCount).toBe(1);
    expect(result.attemptsRemaining).toBe(2);
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(2);
  });

  it('third failed attempt marks escaped', async () => {
    await grantItem(playerId, 'basic_charm', 3);
    const { encounter } = await createActiveEncounter(playerId, 'void_empress');
    const capture = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      buddyAffinityConfig: app.content.tables.buddyAffinity,
      collection: app.collection,
      quests: app.quests,
      effects: app.effects,
      logger: t.logger,
      rng: scriptedRng([0.99, 0.99, 0.99]),
    });

    const r1 = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');
    expect(r1.outcome).toBe('failure');
    const r2 = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');
    expect(r2.outcome).toBe('failure');
    const r3 = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');
    expect(r3.outcome).toBe('escape');
    expect(r3.encounter.state).toBe('escaped');
    expect(r3.encounter.attemptCount).toBe(3);
    expect(r3.encounter.resolvedAt).not.toBeNull();
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(0);
  });

  it('Mythic Contract guarantees capture regardless of roll', async () => {
    await grantItem(playerId, 'mythic_contract', 1);
    const { encounter } = await createActiveEncounter(playerId, 'void_empress');
    const capture = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      buddyAffinityConfig: app.content.tables.buddyAffinity,
      collection: app.collection,
      quests: app.quests,
      effects: app.effects,
      logger: t.logger,
      // Even if RNG were to be consulted, the guaranteed path skips it.
      rng: scriptedRng([0.9999]),
    });
    const result = await capture.attemptCapture(playerId, encounter.id, 'mythic_contract');
    expect(result.outcome).toBe('success');
    expect(result.attempt.guaranteed).toBe(true);
    expect(result.attempt.computedChance).toBe(1);
    expect(result.newWaifu).toBeTruthy();
    expect(await itemQuantity(playerId, 'mythic_contract')).toBe(0);
  });

  it('captures a duplicate when the player already owns the species', async () => {
    await grantItem(playerId, 'mythic_contract', 2);
    const first = await createActiveEncounter(playerId, 'neko_barista');
    const capture = createCaptureService({
      db: t.db,
      inventory: app.inventory,
      progression: app.progression,
      progressionConfig: app.content.tables.progression,
      captureConfig: app.content.tables.capture,
      buddyAffinityConfig: app.content.tables.buddyAffinity,
      collection: app.collection,
      quests: app.quests,
      effects: app.effects,
      logger: t.logger,
      rng: scriptedRng([0]),
    });
    const r1 = await capture.attemptCapture(playerId, first.encounter.id, 'mythic_contract');
    expect(r1.outcome).toBe('success');
    expect(r1.isDuplicate).toBe(false);

    const second = await createActiveEncounter(playerId, 'neko_barista');
    const r2 = await capture.attemptCapture(playerId, second.encounter.id, 'mythic_contract');
    expect(r2.outcome).toBe('success');
    expect(r2.isDuplicate).toBe(true);
    // Two player_waifus rows for the same species.
    const owned = await t.db
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.playerId, playerId), eq(playerWaifus.speciesId, first.speciesRow.id)));
    expect(owned).toHaveLength(2);
  });
});

describe('CaptureService — guard failures write nothing', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-capture-guards', 'u-1'));
  });
  beforeEach(async () => {
    await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  });

  it('expired encounter cannot be captured and consumes no item', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    const { encounter } = await createActiveEncounter(playerId, 'neko_barista');
    // Force expiry.
    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(encounters.id, encounter.id));

    await expect(
      app.capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
    ).rejects.toBeInstanceOf(EncounterExpiredError);
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(1);
    const attemptRows = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounter.id));
    expect(attemptRows).toHaveLength(0);
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row?.state).toBe('expired');
  });

  it('non-owned encounter cannot be captured', async () => {
    const other = await provisionPlayer(app, 'g-capture-guards', 'u-other');
    await grantItem(other.playerId, 'basic_charm', 1);
    const { encounter } = await createActiveEncounter(other.playerId, 'neko_barista');
    // playerId (the outer test's user) tries to capture other's encounter.
    await grantItem(playerId, 'basic_charm', 1);
    await expect(
      app.capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
    ).rejects.toBeInstanceOf(EncounterNotFoundError);
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(1);
    // Other player's inventory untouched too.
    expect(await itemQuantity(other.playerId, 'basic_charm')).toBe(1);
  });

  it('no item quantity blocks the attempt and writes nothing', async () => {
    const { encounter } = await createActiveEncounter(playerId, 'neko_barista');
    // Player has no basic charms.
    await expect(
      app.capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
    ).rejects.toBeInstanceOf(InsufficientItemsError);
    const attemptRows = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounter.id));
    expect(attemptRows).toHaveLength(0);
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row?.attemptCount).toBe(0);
    expect(row?.state).toBe('active');
  });

  it('disabled item blocks the attempt', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    const { encounter } = await createActiveEncounter(playerId, 'neko_barista');
    await t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'basic_charm'));
    try {
      await expect(
        app.capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
      ).rejects.toBeInstanceOf(ItemNotFoundError);
      expect(await itemQuantity(playerId, 'basic_charm')).toBe(1);
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'basic_charm'));
    }
  });

  it('cannot re-attempt a resolved encounter', async () => {
    await grantItem(playerId, 'mythic_contract', 2);
    const { encounter } = await createActiveEncounter(playerId, 'neko_barista');
    const r1 = await app.capture.attemptCapture(playerId, encounter.id, 'mythic_contract');
    expect(r1.outcome).toBe('success');
    // Second attempt on the now-captured encounter must be rejected.
    await expect(
      app.capture.attemptCapture(playerId, encounter.id, 'mythic_contract'),
    ).rejects.toBeInstanceOf(EncounterAlreadyResolvedError);
    // No second item consumed.
    expect(await itemQuantity(playerId, 'mythic_contract')).toBe(1);
  });
});

describe('CaptureService — concurrency', () => {
  it('two concurrent charm clicks resolve safely (item consumed once on success)', async () => {
    const { playerId } = await provisionPlayer(app, 'g-capture-race', 'u-1');
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
    await grantItem(playerId, 'mythic_contract', 2);
    const { encounter } = await createActiveEncounter(playerId, 'neko_barista');

    const results = await Promise.allSettled([
      app.capture.attemptCapture(playerId, encounter.id, 'mythic_contract'),
      app.capture.attemptCapture(playerId, encounter.id, 'mythic_contract'),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(
      (failed[0] as PromiseRejectedResult).reason,
    ).toBeInstanceOf(EncounterAlreadyResolvedError);
    // Item consumed exactly once (Mythic guaranteed → first click captures).
    expect(await itemQuantity(playerId, 'mythic_contract')).toBe(1);
    const attemptRows = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounter.id));
    expect(attemptRows).toHaveLength(1);
  });
});

describe('CaptureService — public-message safety', () => {
  it('capture state stays committed even if the caller drops the public post', async () => {
    // CaptureService itself never touches Discord. Simulate the "public send
    // failed" world by simply ignoring setPublicMessageId — the capture result
    // must be visible in the DB regardless.
    const { playerId } = await provisionPlayer(app, 'g-capture-public', 'u-1');
    await grantItem(playerId, 'mythic_contract', 1);
    const { encounter, speciesRow } = await createActiveEncounter(playerId, 'neko_barista');
    const result = await app.capture.attemptCapture(playerId, encounter.id, 'mythic_contract');
    expect(result.outcome).toBe('success');

    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row?.state).toBe('captured');
    expect(row?.publicMessageId).toBeNull();
    const owned = await t.db
      .select()
      .from(playerWaifus)
      .where(and(eq(playerWaifus.playerId, playerId), eq(playerWaifus.speciesId, speciesRow.id)));
    expect(owned).toHaveLength(1);
  });
});
