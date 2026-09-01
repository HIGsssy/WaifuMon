/**
 * Encounter-time capture-item selection + the new restraint items — real
 * Postgres, real locks.
 *
 * The through-line: **selecting is free, committing is authoritative**. Every
 * test here either proves nothing was consumed, or proves exactly one thing
 * was — and that the number the screen would show is the number the server
 * rolls against.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerInventory,
  players,
  species,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import { computeCaptureChance } from '../../src/modules/capture/captureMath';
import {
  CaptureItemNotEligibleError,
  EncounterStaleError,
  InsufficientItemsError,
  NoCaptureItemSelectedError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import {
  bootstrapApp,
  getItemBySlug,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-capture-items', 'u-1'));
});
afterAll(async () => {
  await t.cleanup();
});


/** A capture service with a fixed RNG, wired exactly as production does. */
function captureService(rng: Rng) {
  return createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    appearance: app.appearance,
    logger: t.logger,
    rng,
  });
}

async function speciesOfRarity(rarity: string): Promise<SpeciesRow> {
  const [row] = await t.db
    .select()
    .from(species)
    .where(and(eq(species.rarity, rarity), eq(species.enabled, true)))
    .limit(1);
  if (!row) throw new Error(`no enabled ${rarity} species seeded`);
  return row;
}

async function createEncounter(rarity: string): Promise<{
  encounter: EncounterRow;
  speciesRow: SpeciesRow;
}> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const speciesRow = await speciesOfRarity(rarity);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: speciesRow.id,
      channelId: 'chan-capture-items',
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return { encounter: row!, speciesRow };
}

async function grant(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, qty);
}

async function owned(slug: string): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(playerId, item.id);
}

async function selectedItemIdOf(encounterId: number): Promise<number | null> {
  const [row] = await t.db
    .select({ id: encounters.selectedItemId })
    .from(encounters)
    .where(eq(encounters.id, encounterId));
  return row!.id;
}

beforeEach(async () => {
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  await t.db.update(players).set({ buddyWaifuId: null }).where(eq(players.id, playerId));
  await app.effects.listActive(playerId).then(async () => {
    // Clear any leftover Microdose buff between tests.
    await t.db.execute(sql`delete from player_active_effects where player_id = ${playerId}`);
  });
});

// ─────────────────────────── content + seeding ──────────────────────────

describe('new capture items', () => {
  it('seed with their additive bonus and their rarity gate', async () => {
    expect(await getItemBySlug(t.db, 'fluffy_cuffs')).toMatchObject({
      category: 'capture',
      captureModifier: 1,
      captureBonus: 0.3,
      captureRarities: ['N', 'R', 'SR'],
      isGuaranteedCapture: false,
      shopRegions: [],
      enabled: true,
    });
    expect(await getItemBySlug(t.db, 'shibari_rope')).toMatchObject({
      category: 'capture',
      captureModifier: 1,
      captureBonus: 0.15,
      captureRarities: ['SSR', 'UR', 'LR', 'EX'],
      shopRegions: ['twin-peeks'],
      enabled: true,
    });
  });

  it('are absent from the hunt tables and the daily package', () => {
    const tables = app.content.tables;
    const notFound = [
      'fluffy_cuffs',
      'shibari_rope',
      'quickie_coffee',
      'reach_around',
      'full_body_massage',
    ];
    for (const slug of notFound) {
      expect(Object.keys(tables.dailyPackage.items)).not.toContain(slug);
      expect(tables.hunt.itemFind.sub.map((s) => s.slug)).not.toContain(slug);
      expect(tables.hunt.rareItemFind.sub.map((s) => s.slug)).not.toContain(slug);
      expect(tables.progression.dailyBonusItems.map((b) => b.slug)).not.toContain(slug);
    }
    // Sold-nowhere gifts name no region; Shibari Rope is sold only in Twin Peeks.
    for (const slug of ['fluffy_cuffs', 'quickie_coffee', 'reach_around', 'full_body_massage']) {
      expect(app.content.items.find((i) => i.slug === slug)?.shopRegions, slug).toEqual([]);
    }
    expect(app.content.items.find((i) => i.slug === 'shibari_rope')?.shopRegions).toEqual([
      'twin-peeks',
    ]);
  });
});

// ───────────────────────────── the selector ─────────────────────────────

describe('selector contents', () => {
  it('offers the owned charms plus the rarity-appropriate restraint', async () => {
    for (const slug of [
      'basic_charm',
      'silk_charm',
      'velvet_charm',
      'prismatic_charm',
      'mythic_contract',
      'fluffy_cuffs',
      'shibari_rope',
    ]) {
      await grant(slug, 2);
    }
    const { encounter } = await createEncounter('SR');
    const slugs = (
      await app.capture.listEligibleCaptureItems(playerId, encounter.id)
    ).map((e) => e.item.slug);

    expect(slugs).toEqual(
      expect.arrayContaining([
        'basic_charm',
        'silk_charm',
        'velvet_charm',
        'prismatic_charm',
        'mythic_contract',
        'fluffy_cuffs',
      ]),
    );
    // Rope is SSR+ only.
    expect(slugs).not.toContain('shibari_rope');
  });

  it('swaps which restraint is eligible at SSR', async () => {
    await grant('fluffy_cuffs', 1);
    await grant('shibari_rope', 1);
    const { encounter } = await createEncounter('SSR');
    const slugs = (
      await app.capture.listEligibleCaptureItems(playerId, encounter.id)
    ).map((e) => e.item.slug);
    expect(slugs).toContain('shibari_rope');
    expect(slugs).not.toContain('fluffy_cuffs');
  });

  it('excludes items the player does not own', async () => {
    await grant('basic_charm', 1);
    const { encounter } = await createEncounter('N');
    const slugs = (
      await app.capture.listEligibleCaptureItems(playerId, encounter.id)
    ).map((e) => e.item.slug);
    expect(slugs).toEqual(['basic_charm']);
  });

  it('never offers a consumable, only capture-category items', async () => {
    await grant('microdose', 3);
    await grant('energy_drink', 1);
    await grant('basic_charm', 1);
    const { encounter } = await createEncounter('N');
    const slugs = (
      await app.capture.listEligibleCaptureItems(playerId, encounter.id)
    ).map((e) => e.item.slug);
    expect(slugs).not.toContain('microdose');
    expect(slugs).not.toContain('energy_drink');
  });
});

// ──────────────────────────── chance arithmetic ─────────────────────────

describe('capture chance', () => {
  const base = () => app.content.tables.capture.baseRatesByRarity;

  it('Fluffy Cuffs adds exactly 0.30 against N-SR', async () => {
    await grant('fluffy_cuffs', 1);
    for (const rarity of ['N', 'R', 'SR'] as const) {
      const { encounter } = await createEncounter(rarity);
      const quote = await app.capture.quoteCapture(playerId, encounter.id, 'fluffy_cuffs');
      expect(quote.eligible).toBe(true);
      expect(quote.itemCaptureBonus).toBe(0.3);
      // Base rate is the species override when set; the quote's own baseline
      // is the honest reference point.
      expect(quote.chance).toBeCloseTo(
        Math.min(quote.baselineChance + 0.3, app.content.tables.capture.maxChance),
        10,
      );
    }
    // The documented example: SR 22% -> 52%.
    expect(base().SR).toBe(0.22);
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'SR',
        captureModifier: 1,
        config: app.content.tables.capture,
        itemCaptureBonus: 0.3,
      }),
    ).toBeCloseTo(0.52, 10);
  });

  it('Fluffy Cuffs is refused against SSR and above', async () => {
    await grant('fluffy_cuffs', 1);
    for (const rarity of ['SSR', 'UR', 'LR'] as const) {
      const { encounter } = await createEncounter(rarity);
      const quote = await app.capture.quoteCapture(playerId, encounter.id, 'fluffy_cuffs');
      expect(quote.eligible).toBe(false);
      await expect(
        app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs'),
      ).rejects.toBeInstanceOf(CaptureItemNotEligibleError);
    }
  });

  it.each([
    ['SSR', 0.12, 0.27],
    ['UR', 0.06, 0.21],
    ['LR', 0.03, 0.18],
  ])('Shibari Rope takes %s from %f to %f', async (rarity, from, to) => {
    expect(base()[rarity as 'SSR']).toBe(from);
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: rarity as 'SSR',
        captureModifier: 1,
        config: app.content.tables.capture,
        itemCaptureBonus: 0.15,
      }),
    ).toBeCloseTo(to as number, 10);

    await grant('shibari_rope', 1);
    const { encounter } = await createEncounter(rarity as string);
    const quote = await app.capture.quoteCapture(playerId, encounter.id, 'shibari_rope');
    expect(quote.eligible).toBe(true);
    expect(quote.itemCaptureBonus).toBe(0.15);
  });

  it('Shibari Rope is refused against N-SR', async () => {
    await grant('shibari_rope', 1);
    for (const rarity of ['N', 'R', 'SR'] as const) {
      const { encounter } = await createEncounter(rarity);
      await expect(
        app.capture.selectCaptureItem(playerId, encounter.id, 'shibari_rope'),
      ).rejects.toBeInstanceOf(CaptureItemNotEligibleError);
    }
  });

  it('existing charms keep their multiplicative behaviour', async () => {
    await grant('silk_charm', 1);
    const { encounter, speciesRow } = await createEncounter('R');
    const quote = await app.capture.quoteCapture(playerId, encounter.id, 'silk_charm');
    const expected = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: speciesRow.baseCaptureRate,
      rarity: 'R',
      captureModifier: 1.5,
      config: app.content.tables.capture,
    });
    expect(quote.itemCaptureBonus).toBe(0);
    expect(quote.chance).toBeCloseTo(expected, 10);
  });

  it('a persistent Microdose buff stacks on top of the item bonus', async () => {
    await grant('microdose', 1);
    await grant('fluffy_cuffs', 1);
    await app.itemUse.use(playerId, 'microdose');

    const { encounter } = await createEncounter('SR');
    const withBoth = await app.capture.quoteCapture(playerId, encounter.id, 'fluffy_cuffs');
    expect(withBoth.captureBonusModifier).toBe(0.03);
    expect(withBoth.itemCaptureBonus).toBe(0.3);
    // Both additive terms land, and the baseline already carries the buff.
    expect(withBoth.chance).toBeCloseTo(withBoth.baselineChance + 0.3, 10);
  });

  it('Mythic Contract is guaranteed and bypasses the max-chance clamp', async () => {
    await grant('mythic_contract', 1);
    const { encounter } = await createEncounter('LR');
    const quote = await app.capture.quoteCapture(playerId, encounter.id, 'mythic_contract');
    expect(quote.guaranteed).toBe(true);
    expect(quote.chance).toBe(1);
    expect(quote.chance).toBeGreaterThan(app.content.tables.capture.maxChance);

    // And the commit agrees: an RNG that would fail every roll still captures.
    const service = captureService(scriptedRng([0.999]));
    const result = await service.attemptCapture(playerId, encounter.id, 'mythic_contract');
    expect(result.outcome).toBe('success');
    expect(result.attempt.guaranteed).toBe(true);
    expect(result.attempt.computedChance).toBe(1);
  });

  it('the displayed quote and the authoritative attempt agree exactly', async () => {
    await grant('shibari_rope', 1);
    const { encounter } = await createEncounter('UR');
    const quote = await app.capture.selectCaptureItem(playerId, encounter.id, 'shibari_rope');

    // Roll just above the quoted chance: it must fail, which only holds if the
    // server used the same number the screen showed.
    const service = captureService(scriptedRng([quote.chance + 0.0001]));
    const result = await service.attemptCapture(playerId, encounter.id, null);
    expect(result.attempt.computedChance).toBeCloseTo(quote.chance, 10);
    expect(result.outcome).not.toBe('success');
    expect(result.itemCaptureBonus).toBe(0.15);
  });
});

// ───────────────────────── selecting consumes nothing ───────────────────

describe('selection is free', () => {
  it('selecting, then changing, consumes neither item', async () => {
    await grant('basic_charm', 2);
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');

    await app.capture.selectCaptureItem(playerId, encounter.id, 'basic_charm');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'basic_charm');

    expect(await owned('basic_charm')).toBe(2);
    expect(await owned('fluffy_cuffs')).toBe(1);
    const charm = await getItemBySlug(t.db, 'basic_charm');
    expect(await selectedItemIdOf(encounter.id)).toBe(charm.id);
  });

  it('walking away consumes nothing', async () => {
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');

    await app.hunt.letHerGo(playerId, encounter.id);
    expect(await owned('fluffy_cuffs')).toBe(1);
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row!.state).toBe('released');
  });

  it('expiry consumes nothing, and the expired encounter cannot be captured', async () => {
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');

    await t.db
      .update(encounters)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(encounters.id, encounter.id));

    await expect(
      app.capture.attemptCapture(playerId, encounter.id, null),
    ).rejects.toThrow();
    expect(await owned('fluffy_cuffs')).toBe(1);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(0);
  });

  it('refuses to select an item the player does not own', async () => {
    const { encounter } = await createEncounter('SR');
    await expect(
      app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs'),
    ).rejects.toBeInstanceOf(InsufficientItemsError);
    expect(await selectedItemIdOf(encounter.id)).toBeNull();
  });
});

// ───────────────────────────── committing ───────────────────────────────

describe('commit', () => {
  it('consumes exactly one of the selected item and records one attempt', async () => {
    await grant('fluffy_cuffs', 3);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');

    const service = captureService(scriptedRng([0]));
    const result = await service.attemptCapture(playerId, encounter.id, null);
    expect(result.outcome).toBe('success');
    expect(result.item.slug).toBe('fluffy_cuffs');
    expect(await owned('fluffy_cuffs')).toBe(2);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(1);
  });

  it('refuses when nothing is selected, and consumes nothing', async () => {
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');
    await expect(
      app.capture.attemptCapture(playerId, encounter.id, null),
    ).rejects.toBeInstanceOf(NoCaptureItemSelectedError);
    expect(await owned('fluffy_cuffs')).toBe(1);
  });

  it('a stale button (double-click) resolves exactly one attempt', async () => {
    await grant('basic_charm', 5);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'basic_charm');
    const before = await owned('basic_charm');

    // Both clicks were rendered against attempt_count = 0.
    const service = captureService(scriptedRng([0.99, 0.99]));
    const outcomes = await Promise.allSettled([
      service.attemptCapture(playerId, encounter.id, null, { expectedAttemptCount: 0 }),
      service.attemptCapture(playerId, encounter.id, null, { expectedAttemptCount: 0 }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(EncounterStaleError);

    expect(await owned('basic_charm')).toBe(before - 1);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(1);
  });

  it('a fresh button after a failure is accepted', async () => {
    await grant('basic_charm', 5);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'basic_charm');
    const service = captureService(scriptedRng([0.99, 0.99]));

    const first = await service.attemptCapture(playerId, encounter.id, null, {
      expectedAttemptCount: 0,
    });
    expect(first.outcome).toBe('failure');
    // The selection survives the failure, so "Try Again" is one click.
    const charm = await getItemBySlug(t.db, 'basic_charm');
    expect(await selectedItemIdOf(encounter.id)).toBe(charm.id);

    const second = await service.attemptCapture(playerId, encounter.id, null, {
      expectedAttemptCount: 1,
    });
    expect(second.attempt.attemptNumber).toBe(2);
    expect(await owned('basic_charm')).toBe(3);
  });

  it('an item sold out from under the selection blocks the capture', async () => {
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');

    // Something else consumes the last one between selection and commit.
    const cuffs = await getItemBySlug(t.db, 'fluffy_cuffs');
    await app.inventory.consumeItem(t.db, playerId, cuffs.id, 1);

    await expect(
      app.capture.attemptCapture(playerId, encounter.id, null),
    ).rejects.toBeInstanceOf(InsufficientItemsError);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(0);
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row!.state).toBe('active');
  });

  it('a selection that became rarity-ineligible is refused authoritatively', async () => {
    await grant('fluffy_cuffs', 1);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'fluffy_cuffs');

    // Repoint the encounter at an SSR species — the same thing a content edit
    // to `capture_rarities` would do, and the selector is only a convenience.
    const ssr = await speciesOfRarity('SSR');
    await t.db
      .update(encounters)
      .set({ speciesId: ssr.id })
      .where(eq(encounters.id, encounter.id));

    await expect(
      app.capture.attemptCapture(playerId, encounter.id, null),
    ).rejects.toBeInstanceOf(CaptureItemNotEligibleError);
    expect(await owned('fluffy_cuffs')).toBe(1);
  });

  it('clears the selection once the encounter resolves', async () => {
    await grant('mythic_contract', 1);
    const { encounter } = await createEncounter('SR');
    await app.capture.selectCaptureItem(playerId, encounter.id, 'mythic_contract');
    await captureService(scriptedRng([0])).attemptCapture(playerId, encounter.id, null);
    expect(await selectedItemIdOf(encounter.id)).toBeNull();
  });
});
