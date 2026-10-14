/**
 * Phase 4B2A — capture-service extraction.
 *
 * Two halves:
 *
 *   1. **Hunt goldens.** Scripted hunted captures driven through the public
 *      `attemptCapture` only. The snapshot beside this file was recorded
 *      against the service *before* the extraction (Delve e7f8f0b), so a pass
 *      means the diagnostic breakdown, audit rows, XP, quests and result shape
 *      of a normal hunt are what they were.
 *   2. **Extracted operations.** `quoteSpecies`, `resolveCaptureAttempt` and
 *      `grantSpeciesCopy` called the way a dungeon step will call them: inside
 *      a caller-owned transaction, with a pinned Buddy, a supplied roll and a
 *      stable grant key.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureAttempts,
  encounters,
  playerDailyQuests,
  playerProgressionEvents,
  players,
  playerWaifus,
  species,
  type Affinity,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  createCaptureService,
  type CaptureAttemptResult,
  type CaptureService,
} from '../../src/modules/capture/captureService';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { CaptureGrantKeyConflictError, InsufficientItemsError } from '../../src/shared/errors';
import type { Logger } from '../../src/shared/logger';
import { seededRng, type Rng } from '../../src/shared/random';
import {
  bootstrapApp,
  getItemBySlug,
  insertOwnedWaifu,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const COMMON = 'neko_barista'; // N
const COMMON_OTHER = 'gym_oni'; // N
const RARE = 'neon_kitsune'; // SR
const EPIC = 'eclipse_valkyrie'; // SSR

let t: TestDb;
let app: App;
let playerSeq = 0;

interface LogLine {
  message: string;
  fields: Record<string, unknown>;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  // Affinities are pinned so no case depends on what the corpus ships.
  for (const slug of [COMMON, COMMON_OTHER, RARE, EPIC]) await setAffinity(slug, 'switch');
});
afterAll(async () => {
  await t.cleanup();
});

async function setAffinity(slug: string, affinity: Affinity): Promise<void> {
  await t.db.update(species).set({ affinity }).where(eq(species.slug, slug));
}

async function speciesBySlug(slug: string): Promise<SpeciesRow> {
  const [row] = await t.db.select().from(species).where(eq(species.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}

/** A capture service wired as production wires it, with its log lines kept. */
function captureWith(rng?: Rng): { capture: CaptureService; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => logs.push({ message, fields }),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
  const capture = createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    seductivePowerConfig: app.content.tables.seductivePower,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    itemUse: app.itemUse,
    appearance: app.appearance,
    buddyBonus: app.buddyBonus,
    logger,
    ...(rng ? { rng } : {}),
  });
  return { capture, logs };
}

/** A fresh player holding the three capture quests, so every case stands alone. */
async function freshPlayer(now: Date): Promise<number> {
  const { playerId } = await provisionPlayer(app, 'g-capture-extraction', `u-${++playerSeq}`);
  const questDate = now.toISOString().slice(0, 10);
  await t.db.insert(playerDailyQuests).values(
    [
      { type: 'capture_attempts', rarityAtLeast: null },
      { type: 'capture_success', rarityAtLeast: null },
      { type: 'capture_success_rarity_at_least', rarityAtLeast: 'SR' },
    ].map((quest) => ({
      playerId,
      questDate,
      questSlug: `test_${quest.type}`,
      titleSnapshot: quest.type,
      descriptionSnapshot: quest.type,
      type: quest.type,
      rarityAtLeast: quest.rarityAtLeast,
      target: 50,
      progress: 0,
      rewardsJson: {},
    })),
  );
  return playerId;
}

async function grant(playerId: number, slug: string, quantity: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, quantity);
}

async function owned(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(playerId, item.id);
}

async function createEncounter(playerId: number, slug: string): Promise<EncounterRow> {
  const speciesRow = await speciesBySlug(slug);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: speciesRow.id,
      channelId: 'chan-capture-extraction',
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!;
}

async function equipBuddy(playerId: number, slug: string): Promise<number> {
  const speciesRow = await speciesBySlug(slug);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: speciesRow.id });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, playerId));
  return waifu.id;
}

async function microdose(playerId: number, charges: number): Promise<void> {
  await app.effects.grantCaptureBonus(t.db, playerId, {
    sourceItemSlug: 'microdose',
    modifier: 0.1,
    charges,
  });
}

/** Author a Buddy Bonus onto a species for the length of `body`. */
async function withBuddyBonus<T>(slug: string, bonus: BuddyBonus, body: () => Promise<T>): Promise<T> {
  const entry = app.content.species.find((s) => s.slug === slug);
  if (!entry) throw new Error(`no such species in content: ${slug}`);
  const original = entry.buddyBonus;
  entry.buddyBonus = bonus;
  try {
    return await body();
  } finally {
    if (original) entry.buddyBonus = original;
    else delete entry.buddyBonus;
  }
}

const CAPTURE_BONUS: BuddyBonus = {
  name: 'Test Bonus',
  flavorText: 'Display only.',
  effectId: 'capture_chance',
  value: 20,
};

/** Database ids differ per run; everything else in a capture is deterministic. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return '<date>';
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        (key === 'buddyWaifuId' || key === 'encounterId' || key === 'playerId') && entry != null
          ? `<${key}>`
          : scrub(entry),
      ]),
    );
  }
  return value;
}

function summarise(result: CaptureAttemptResult): unknown {
  return scrub({
    outcome: result.outcome,
    attemptsRemaining: result.attemptsRemaining,
    isDuplicate: result.isDuplicate,
    isNewDex: result.isNewDex,
    xpGranted: result.xpGranted,
    xpBonus: result.xpBonus,
    levelUps: result.levelUps,
    affinity: result.affinity,
    effect: result.effect,
    itemCaptureBonus: result.itemCaptureBonus,
    newAppearances: result.newAppearances,
    item: result.item.slug,
    species: result.species.slug,
    attempt: {
      attemptNumber: result.attempt.attemptNumber,
      computedChance: result.attempt.computedChance,
      roll: result.attempt.roll,
      success: result.attempt.success,
      guaranteed: result.attempt.guaranteed,
    },
    encounter: {
      state: result.encounter.state,
      attemptCount: result.encounter.attemptCount,
      holdsSelection: result.encounter.selectedItemId != null,
      resolved: result.encounter.resolvedAt != null,
    },
    newWaifu: result.newWaifu && {
      species: result.species.slug,
      baseSp: result.newWaifu.baseSp,
      level: result.newWaifu.level,
      acquiredVia: result.newWaifu.acquiredVia,
      grantKey: result.newWaifu.grantKey,
      seenAppearances: result.newWaifu.seenAppearances,
    },
  });
}

/** Everything a capture leaves behind for one player, in write order. */
async function ledger(playerId: number, charms: readonly string[]): Promise<unknown> {
  const attempts = await t.db
    .select()
    .from(captureAttempts)
    .where(eq(captureAttempts.playerId, playerId))
    .orderBy(asc(captureAttempts.id));
  const events = await t.db
    .select()
    .from(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, playerId))
    .orderBy(asc(playerProgressionEvents.id));
  const quests = await t.db
    .select()
    .from(playerDailyQuests)
    .where(eq(playerDailyQuests.playerId, playerId))
    .orderBy(asc(playerDailyQuests.id));
  const copies = await t.db
    .select()
    .from(playerWaifus)
    .where(eq(playerWaifus.playerId, playerId))
    .orderBy(asc(playerWaifus.id));
  const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
  const attemptIds = attempts.map((a) => a.id);
  return scrub({
    attempts: attempts.map((a) => ({
      attemptNumber: a.attemptNumber,
      computedChance: a.computedChance,
      roll: a.roll,
      success: a.success,
      guaranteed: a.guaranteed,
    })),
    events: events.map((e) => ({
      eventType: e.eventType,
      xpDelta: e.xpDelta,
      // Which attempt the event points at, rather than a run-specific id.
      attemptRef: e.refId == null ? null : attemptIds.indexOf(e.refId),
      metadata: e.metadata,
    })),
    quests: quests.map((q) => ({ type: q.type, progress: q.progress })),
    copies: copies.map((c) => ({ baseSp: c.baseSp, acquiredVia: c.acquiredVia, grantKey: c.grantKey })),
    player: { xp: player!.xp, level: player!.level },
    charms: Object.fromEntries(
      await Promise.all(charms.map(async (slug) => [slug, await owned(playerId, slug)] as const)),
    ),
    microdose: (await app.effects.getCaptureBonus(playerId))?.chargesRemaining ?? 0,
  });
}

describe('hunted captures are unchanged by the extraction', () => {
  it('failure, failure, final-attempt escape', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 3);
    const encounter = await createEncounter(playerId, COMMON);
    const { capture, logs } = captureWith(scriptedRng([0.9, 0.9, 0.9]));
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(summarise(await capture.attemptCapture(playerId, encounter.id, 'basic_charm', { now, expectedAttemptCount: i })));
    }
    expect({ results, logs: scrub(logs), ledger: await ledger(playerId, ['basic_charm']) }).toMatchSnapshot();
  });

  it('first-attempt success, then a duplicate of the same species', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 2);
    const { capture, logs } = captureWith(scriptedRng([0.1, 0.5, 0.2, 0.25]));
    const first = await capture.attemptCapture(playerId, (await createEncounter(playerId, COMMON)).id, 'basic_charm', now);
    const second = await capture.attemptCapture(playerId, (await createEncounter(playerId, COMMON)).id, 'basic_charm', now);
    expect(second.isDuplicate).toBe(true);
    expect({
      results: [summarise(first), summarise(second)],
      logs: scrub(logs),
      ledger: await ledger(playerId, ['basic_charm']),
    }).toMatchSnapshot();
  });

  it('a failure keeps the selection and the next attempt commits it', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'silk_charm', 2);
    const encounter = await createEncounter(playerId, RARE);
    const { capture, logs } = captureWith(scriptedRng([0.99, 0.01, 0.75]));
    await capture.selectCaptureItem(playerId, encounter.id, 'silk_charm', now);
    const results = [
      summarise(await capture.attemptCapture(playerId, encounter.id, null, now)),
      summarise(await capture.attemptCapture(playerId, encounter.id, null, now)),
    ];
    expect({ results, logs: scrub(logs), ledger: await ledger(playerId, ['silk_charm']) }).toMatchSnapshot();
  });

  it.each([
    ['basic_charm', COMMON],
    ['silk_charm', RARE],
    ['velvet_charm', RARE],
    ['prismatic_charm', RARE],
    ['fluffy_cuffs', RARE],
    ['shibari_rope', EPIC],
  ])('%s: chance, breakdown and consumption', async (charm, slug) => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, charm, 1);
    const encounter = await createEncounter(playerId, slug);
    const { capture, logs } = captureWith(scriptedRng([0.999]));
    const quote = await capture.quoteCapture(playerId, encounter.id, charm, now);
    const result = await capture.attemptCapture(playerId, encounter.id, charm, now);
    expect(result.attempt.computedChance).toBe(quote.chance);
    expect({
      quote: {
        chance: quote.chance,
        baselineChance: quote.baselineChance,
        eligible: quote.eligible,
        guaranteed: quote.guaranteed,
        itemCaptureBonus: quote.itemCaptureBonus,
      },
      result: summarise(result),
      logs: scrub(logs),
      ledger: await ledger(playerId, [charm]),
    }).toMatchSnapshot();
  });

  it('Microdose: one charge per attempt, in the chance and in the audit trail', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 2);
    await microdose(playerId, 2);
    const encounter = await createEncounter(playerId, COMMON);
    const { capture, logs } = captureWith(scriptedRng([0.99, 0.99]));
    const results = [
      summarise(await capture.attemptCapture(playerId, encounter.id, 'basic_charm', now)),
      summarise(await capture.attemptCapture(playerId, encounter.id, 'basic_charm', now)),
    ];
    expect({ results, logs: scrub(logs), ledger: await ledger(playerId, ['basic_charm']) }).toMatchSnapshot();
  });

  it('a guaranteed capture bypasses the roll and leaves Microdose untouched', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'mythic_contract', 1);
    await microdose(playerId, 3);
    const encounter = await createEncounter(playerId, RARE);
    // No `next()` is scripted: a guaranteed capture must not draw a chance roll.
    const { capture, logs } = captureWith(scriptedRng([]));
    const result = await capture.attemptCapture(playerId, encounter.id, 'mythic_contract', now);
    expect(result.outcome).toBe('success');
    expect({ result: summarise(result), logs: scrub(logs), ledger: await ledger(playerId, ['mythic_contract']) }).toMatchSnapshot();
  });

  it('Buddy affinity and a Buddy capture bonus, from the live Buddy', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 2);
    await setAffinity(RARE, 'dominant');
    await setAffinity(COMMON_OTHER, 'submissive');
    try {
      await withBuddyBonus(RARE, CAPTURE_BONUS, async () => {
        await equipBuddy(playerId, RARE);
        const encounter = await createEncounter(playerId, COMMON_OTHER);
        const { capture, logs } = captureWith(scriptedRng([0.99, 0.01, 0.4]));
        const quote = await capture.quoteCapture(playerId, encounter.id, 'basic_charm', now);
        const results = [
          await capture.attemptCapture(playerId, encounter.id, 'basic_charm', now),
          await capture.attemptCapture(playerId, encounter.id, 'basic_charm', now),
        ];
        expect(results[0]!.affinity.matchup).toBe('strong');
        expect(results[0]!.attempt.computedChance).toBe(quote.chance);
        expect({
          quote: {
            chance: quote.chance,
            baselineChance: quote.baselineChance,
            buddyAffinityModifier: quote.buddyAffinityModifier,
            buddyBonusPercent: quote.buddyBonusPercent,
            buddyBonus: quote.buddyBonus,
          },
          results: results.map(summarise),
          logs: scrub(logs),
          ledger: await ledger(playerId, ['basic_charm']),
        }).toMatchSnapshot();
      });
    } finally {
      await setAffinity(RARE, 'switch');
      await setAffinity(COMMON_OTHER, 'switch');
    }
  });

  it('refusals spend nothing: ineligible rarity, unowned charm, stale and concurrent presses', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 5);
    await grant(playerId, 'trophy_wife_charm', 1);
    const encounter = await createEncounter(playerId, COMMON);
    const { capture, logs } = captureWith(scriptedRng([0.99, 0.99, 0.99]));
    const refusals: string[] = [];
    const refused = async (attempt: Promise<unknown>): Promise<void> => {
      refusals.push(await attempt.then(() => 'resolved', (err: { code?: string }) => err.code ?? 'error'));
    };
    await refused(capture.attemptCapture(playerId, encounter.id, 'trophy_wife_charm', now));
    await refused(capture.attemptCapture(playerId, encounter.id, 'silk_charm', now));
    await refused(capture.attemptCapture(playerId, encounter.id, 'basic_charm', { now, expectedAttemptCount: 2 }));
    // A double-clicked button: both presses carry the same rendered count.
    const presses = await Promise.allSettled([
      capture.attemptCapture(playerId, encounter.id, 'basic_charm', { now, expectedAttemptCount: 0 }),
      capture.attemptCapture(playerId, encounter.id, 'basic_charm', { now, expectedAttemptCount: 0 }),
    ]);
    expect(presses.map((p) => p.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = presses.find((p) => p.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe('ENCOUNTER_STALE');
    expect({ refusals, logs: scrub(logs), ledger: await ledger(playerId, ['basic_charm', 'trophy_wife_charm']) }).toMatchSnapshot();
  });
});

/** Row counts and balances a rolled-back step must leave exactly as they were. */
async function footprint(playerId: number, charm: string): Promise<unknown> {
  const count = async (table: typeof captureAttempts | typeof playerWaifus | typeof playerProgressionEvents) => {
    const [row] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.playerId, playerId));
    return row!.n;
  };
  const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
  const quests = await t.db
    .select()
    .from(playerDailyQuests)
    .where(eq(playerDailyQuests.playerId, playerId))
    .orderBy(asc(playerDailyQuests.id));
  return {
    charm: await owned(playerId, charm),
    microdose: (await app.effects.getCaptureBonus(playerId))?.chargesRemaining ?? 0,
    attempts: await count(captureAttempts),
    copies: await count(playerWaifus),
    events: await count(playerProgressionEvents),
    xp: player!.xp,
    quests: quests.map((q) => q.progress),
  };
}

async function questProgress(playerId: number): Promise<Record<string, number>> {
  const rows = await t.db.select().from(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId));
  return Object.fromEntries(rows.map((q) => [q.type, q.progress]));
}

describe('quoteSpecies', () => {
  it('reads the live Buddy by default and matches the hunt quote term for term', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await setAffinity(RARE, 'dominant');
    await setAffinity(COMMON_OTHER, 'submissive');
    try {
      await withBuddyBonus(RARE, CAPTURE_BONUS, async () => {
        await equipBuddy(playerId, RARE);
        await microdose(playerId, 2);
        const encounter = await createEncounter(playerId, COMMON_OTHER);
        const { capture } = captureWith();
        const target = await speciesBySlug(COMMON_OTHER);
        for (const slug of ['basic_charm', 'silk_charm', 'fluffy_cuffs', 'mythic_contract', 'trophy_wife_charm', null]) {
          const item = slug ? await getItemBySlug(t.db, slug) : null;
          const { encounter: _row, ...hunt } = await capture.quoteCapture(playerId, encounter.id, slug, now);
          expect(await capture.quoteSpecies(t.db, playerId, target, item)).toEqual(hunt);
        }
      });
    } finally {
      await setAffinity(RARE, 'switch');
      await setAffinity(COMMON_OTHER, 'switch');
    }
  });

  it('a pinned Buddy override replaces the live Buddy without touching it', async () => {
    const now = new Date();
    const pinnedPlayer = await freshPlayer(now);
    const livePlayer = await freshPlayer(now);
    await setAffinity(RARE, 'dominant');
    await setAffinity(COMMON_OTHER, 'submissive');
    try {
      await withBuddyBonus(RARE, CAPTURE_BONUS, async () => {
        const target = await speciesBySlug(COMMON_OTHER);
        const charm = await getItemBySlug(t.db, 'basic_charm');
        const { capture } = captureWith();

        // What a hunt quotes when the bonus-bearing species *is* the Buddy.
        await equipBuddy(livePlayer, RARE);
        const asLive = await capture.quoteSpecies(t.db, livePlayer, target, charm);
        expect(asLive.buddyBonusPercent).toBe(20);
        expect(asLive.buddyAffinityModifier).toBeGreaterThan(0);

        // The other player's live Buddy is a neutral common; her pinned
        // fighter is the bonus-bearing species.
        const liveBuddyId = await equipBuddy(pinnedPlayer, COMMON);
        const pinnedCopy = await insertOwnedWaifu(t.db, { playerId: pinnedPlayer, speciesId: (await speciesBySlug(RARE)).id });
        const override = { waifuId: pinnedCopy.id, speciesSlug: RARE };

        const live = await capture.quoteSpecies(t.db, pinnedPlayer, target, charm);
        expect(live.buddyBonusPercent).toBe(0);
        expect(live.buddyAffinityModifier).toBe(0);

        const pinned = await capture.quoteSpecies(t.db, pinnedPlayer, target, charm, override);
        expect(pinned).toEqual(asLive);

        const none = await capture.quoteSpecies(t.db, pinnedPlayer, target, charm, null);
        expect(none.buddyBonusPercent).toBe(0);
        expect(none.buddyAffinityModifier).toBe(0);
        expect(none.buddyBonus).toBeNull();

        const [player] = await t.db.select().from(players).where(eq(players.id, pinnedPlayer));
        expect(player!.buddyWaifuId).toBe(liveBuddyId);
      });
    } finally {
      await setAffinity(RARE, 'switch');
      await setAffinity(COMMON_OTHER, 'switch');
    }
  });

  it('an override neither reads nor heals a dangling live Buddy pointer', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const staleId = await equipBuddy(playerId, COMMON);
    await t.db.update(playerWaifus).set({ releasedAt: now }).where(eq(playerWaifus.id, staleId));
    const { capture } = captureWith();
    const target = await speciesBySlug(COMMON_OTHER);

    await capture.quoteSpecies(t.db, playerId, target, null, { waifuId: staleId, speciesSlug: COMMON });
    const [pinnedRead] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(pinnedRead!.buddyWaifuId).toBe(staleId);

    // The live read keeps its existing self-heal.
    await capture.quoteSpecies(t.db, playerId, target, null);
    const [liveRead] = await t.db.select().from(players).where(eq(players.id, playerId));
    expect(liveRead!.buddyWaifuId).toBeNull();
  });

  it('a targeted pinned bonus applies only to species it matches', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const { capture } = captureWith();
    const override = { waifuId: 1, speciesSlug: RARE };
    await withBuddyBonus(RARE, { ...CAPTURE_BONUS, target: { type: 'rarity_min', value: 'SSR' } }, async () => {
      expect((await capture.quoteSpecies(t.db, playerId, await speciesBySlug(EPIC), null, override)).buddyBonusPercent).toBe(20);
      const miss = await capture.quoteSpecies(t.db, playerId, await speciesBySlug(COMMON), null, override);
      expect(miss.buddyBonusPercent).toBe(0);
      expect(miss.buddyBonus).toBeNull();
    });
  });
});

describe('resolveCaptureAttempt', () => {
  it('a supplied roll and RNG reproduce the hunted capture exactly, with no encounter rows', async () => {
    const now = new Date();
    const hunter = await freshPlayer(now);
    const delver = await freshPlayer(now);
    for (const id of [hunter, delver]) {
      await grant(id, 'silk_charm', 1);
      await microdose(id, 2);
    }
    const target = await speciesBySlug(RARE);
    const charm = await getItemBySlug(t.db, 'silk_charm');

    const hunted = captureWith(scriptedRng([0.2, 0.6]));
    const encounter = await createEncounter(hunter, RARE);
    const hunt = await hunted.capture.attemptCapture(hunter, encounter.id, 'silk_charm', now);

    // The service's own generator is empty: a supplied roll must not draw it.
    const shared = captureWith(scriptedRng([]));
    const resolved = await t.db.transaction((tx) =>
      shared.capture.resolveCaptureAttempt(tx, {
        playerId: delver,
        species: target,
        item: charm,
        finalAttempt: false,
        now,
        roll: 0.2,
        rng: scriptedRng([0.6]),
        provenance: { acquiredVia: 'dungeon_capture', grantKey: `test:${delver}:capture` },
        logContext: { runId: 7 },
      }),
    );

    expect(hunt.outcome).toBe('success');
    expect(resolved.outcome).toBe(hunt.outcome);
    // The audit column is a float; the exact chance is compared through the log below.
    expect(resolved.chance).toBeCloseTo(hunt.attempt.computedChance, 10);
    expect(resolved.chance).toBe(hunt.affinity.finalChance);
    expect(resolved.roll).toBe(hunt.attempt.roll);
    expect(resolved.newWaifu!.baseSp).toBe(hunt.newWaifu!.baseSp);
    expect(resolved.xpGranted).toBe(hunt.xpGranted);
    expect(resolved.isNewDex).toBe(hunt.isNewDex);
    expect(resolved.effect).toEqual(hunt.effect);
    expect(resolved.itemCaptureBonus).toBe(hunt.itemCaptureBonus);
    expect(scrub(resolved.affinity)).toEqual(scrub(hunt.affinity));
    expect(resolved.newWaifu).toMatchObject({ acquiredVia: 'dungeon_capture', grantKey: `test:${delver}:capture` });
    expect(hunt.newWaifu).toMatchObject({ acquiredVia: null, grantKey: null });

    // Same log line, less the encounter id and plus the caller's context.
    const { encounterId: _e, playerId: _p, ...huntLog } = hunted.logs[0]!.fields;
    const { runId, playerId: _q, ...sharedLog } = shared.logs[0]!.fields;
    expect(runId).toBe(7);
    expect(sharedLog).toEqual(huntLog);
    expect(shared.logs[0]!.message).toBe(hunted.logs[0]!.message);

    const print = await footprint(delver, 'silk_charm');
    expect(print).toMatchObject({ charm: 0, microdose: 1, attempts: 0, copies: 1 });
    expect(await questProgress(delver)).toEqual(await questProgress(hunter));
    const [rows] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(encounters)
      .where(eq(encounters.playerId, delver));
    expect(rows!.n).toBe(0);
  });

  it('a supplied roll decides failure, and the final attempt escapes', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 2);
    const target = await speciesBySlug(COMMON);
    const charm = await getItemBySlug(t.db, 'basic_charm');
    const { capture, logs } = captureWith(scriptedRng([]));
    const decisions: unknown[] = [];
    const attempt = (finalAttempt: boolean) =>
      t.db.transaction((tx) =>
        capture.resolveCaptureAttempt(tx, {
          playerId,
          species: target,
          item: charm,
          finalAttempt,
          now,
          roll: 0.5,
          recordAttempt: async (decision) => {
            decisions.push(decision);
            return null;
          },
        }),
      );
    const failed = await attempt(false);
    const escaped = await attempt(true);
    // N base 0.5 with a x1 charm: a roll of exactly the chance is a miss.
    expect(failed).toMatchObject({ outcome: 'failure', success: false, chance: 0.5, roll: 0.5, newWaifu: null });
    expect(escaped).toMatchObject({ outcome: 'escape', success: false });
    expect(failed.xpGranted).toBe(app.content.tables.progression.xp.captureFailed);
    expect(decisions).toEqual([
      { outcome: 'failure', success: false, guaranteed: false, chance: 0.5, roll: 0.5 },
      { outcome: 'escape', success: false, guaranteed: false, chance: 0.5, roll: 0.5 },
    ]);
    expect(logs.map((l) => l.message)).toEqual(['capture failed', 'capture escaped']);
    expect(await footprint(playerId, 'basic_charm')).toMatchObject({ charm: 0, copies: 0, attempts: 0 });
    expect(await questProgress(playerId)).toEqual({
      capture_attempts: 2,
      capture_success: 0,
      capture_success_rarity_at_least: 0,
    });
  });

  it('without a supplied roll it draws the chance roll then Base SP from one generator, as a hunt does', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    const target = await speciesBySlug(COMMON);
    const { capture } = captureWith(seededRng(42));
    const expected = seededRng(42);
    const roll = expected.next();
    const resolved = await t.db.transaction(async (tx) =>
      capture.resolveCaptureAttempt(tx, {
        playerId,
        species: target,
        item: await getItemBySlug(t.db, 'basic_charm'),
        finalAttempt: false,
        now,
      }),
    );
    expect(resolved.roll).toBe(roll);
    expect(resolved.success).toBe(roll < 0.5);
  });

  it('uses the pinned Buddy for affinity and Buddy Bonus, and reports the pinned copy', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    await setAffinity(RARE, 'dominant');
    await setAffinity(COMMON_OTHER, 'submissive');
    try {
      await withBuddyBonus(RARE, CAPTURE_BONUS, async () => {
        await equipBuddy(playerId, COMMON);
        const pinnedCopy = await insertOwnedWaifu(t.db, { playerId, speciesId: (await speciesBySlug(RARE)).id });
        const override = { waifuId: pinnedCopy.id, speciesSlug: RARE };
        const target = await speciesBySlug(COMMON_OTHER);
        const charm = await getItemBySlug(t.db, 'basic_charm');
        const { capture } = captureWith(scriptedRng([]));
        const quote = await capture.quoteSpecies(t.db, playerId, target, charm, override);
        const resolved = await t.db.transaction((tx) =>
          capture.resolveCaptureAttempt(tx, {
            playerId,
            species: target,
            item: charm,
            finalAttempt: false,
            now,
            roll: 0.99,
            buddyOverride: override,
          }),
        );
        expect(resolved.chance).toBe(quote.chance);
        expect(resolved.chance).toBeCloseTo((0.5 + 0.03) * 1.2, 10);
        expect(resolved.affinity).toMatchObject({ buddyWaifuId: pinnedCopy.id, matchup: 'strong' });
        expect(resolved.affinity.buddyBonus).toMatchObject({ effectId: 'capture_chance', value: 20 });
        expect(resolved.breakdown.buddyGlobalModifier).toBe(20);
      });
    } finally {
      await setAffinity(RARE, 'switch');
      await setAffinity(COMMON_OTHER, 'switch');
    }
  });

  it.each([
    ['a disabled charm', 'basic_charm', COMMON, { enabled: false }, 'ITEM_NOT_FOUND'],
    ['a non-capture item', 'basic_charm', COMMON, { category: 'gift' }, 'ITEM_NOT_USABLE'],
    ['a rarity-restricted charm', 'trophy_wife_charm', COMMON, {}, 'CAPTURE_ITEM_NOT_ELIGIBLE'],
  ])('refuses %s before spending anything', async (_label, charm, slug, patch, code) => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, charm, 1);
    await microdose(playerId, 2);
    const before = await footprint(playerId, charm);
    const { capture } = captureWith(scriptedRng([]));
    const item = { ...(await getItemBySlug(t.db, charm)), ...patch };
    await expect(
      t.db.transaction(async (tx) =>
        capture.resolveCaptureAttempt(tx, {
          playerId,
          species: await speciesBySlug(slug),
          item,
          finalAttempt: false,
          now,
          roll: 0,
        }),
      ),
    ).rejects.toMatchObject({ code });
    expect(await footprint(playerId, charm)).toEqual(before);
  });

  it.each([1, -0.1, Number.NaN])('refuses an out-of-range roll (%s) before spending anything', async (roll) => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    const before = await footprint(playerId, 'basic_charm');
    const { capture } = captureWith(scriptedRng([]));
    await expect(
      t.db.transaction(async (tx) =>
        capture.resolveCaptureAttempt(tx, {
          playerId,
          species: await speciesBySlug(COMMON),
          item: await getItemBySlug(t.db, 'basic_charm'),
          finalAttempt: false,
          now,
          roll,
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await footprint(playerId, 'basic_charm')).toEqual(before);
  });

  it('rolls everything back when the charm is not owned', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await microdose(playerId, 2);
    const before = await footprint(playerId, 'basic_charm');
    const { capture } = captureWith(scriptedRng([]));
    await expect(
      t.db.transaction(async (tx) =>
        capture.resolveCaptureAttempt(tx, {
          playerId,
          species: await speciesBySlug(COMMON),
          item: await getItemBySlug(t.db, 'basic_charm'),
          finalAttempt: false,
          now,
          roll: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientItemsError);
    expect(await footprint(playerId, 'basic_charm')).toEqual(before);
  });

  it('rolls everything back when the ownership write is refused (grant key already used)', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 2);
    await microdose(playerId, 3);
    const target = await speciesBySlug(COMMON);
    const charm = await getItemBySlug(t.db, 'basic_charm');
    const { capture } = captureWith(scriptedRng([]));
    const once = () =>
      t.db.transaction((tx) =>
        capture.resolveCaptureAttempt(tx, {
          playerId,
          species: target,
          item: charm,
          finalAttempt: false,
          now,
          roll: 0,
          rng: scriptedRng([0.5]),
          provenance: { acquiredVia: 'dungeon_capture', grantKey: `test:${playerId}:once` },
        }),
      );
    await once();
    const after = await footprint(playerId, 'basic_charm');
    expect(after).toMatchObject({ charm: 1, microdose: 2, copies: 1 });

    await expect(once()).rejects.toBeInstanceOf(CaptureGrantKeyConflictError);
    // The retry's charm, Microdose charge, XP and quest credit all unwound.
    expect(await footprint(playerId, 'basic_charm')).toEqual(after);
  });

  it('rolls everything back when the caller fails after the attempt resolved', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    await microdose(playerId, 2);
    const before = await footprint(playerId, 'basic_charm');
    const { capture } = captureWith(scriptedRng([]));
    await expect(
      t.db.transaction(async (tx) => {
        const resolved = await capture.resolveCaptureAttempt(tx, {
          playerId,
          species: await speciesBySlug(COMMON),
          item: await getItemBySlug(t.db, 'basic_charm'),
          finalAttempt: false,
          now,
          roll: 0,
          rng: scriptedRng([0.5]),
        });
        expect(resolved.newWaifu).not.toBeNull();
        throw new Error('the dungeon step failed to write its run row');
      }),
    ).rejects.toThrow('failed to write its run row');
    expect(await footprint(playerId, 'basic_charm')).toEqual(before);
  });

  it('a hunted capture rolls back whole when its audit write fails', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    await microdose(playerId, 2);
    const encounter = await createEncounter(playerId, COMMON);
    // An attempt row already at number 1 makes the hunt's own insert collide.
    await t.db.insert(captureAttempts).values({
      encounterId: encounter.id,
      playerId,
      attemptNumber: 1,
      itemId: (await getItemBySlug(t.db, 'basic_charm')).id,
      computedChance: 0.5,
      roll: 0.9,
      success: false,
      guaranteed: false,
    });
    const before = await footprint(playerId, 'basic_charm');
    const { capture } = captureWith(scriptedRng([0.1, 0.5]));
    await expect(capture.attemptCapture(playerId, encounter.id, 'basic_charm', now)).rejects.toThrow();
    expect(await footprint(playerId, 'basic_charm')).toEqual(before);
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(row).toMatchObject({ state: 'active', attemptCount: 0 });
  });
});

describe('grantSpeciesCopy', () => {
  it('grants one copy with provenance, and no charm, attempt or capture-quest credit', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    await grant(playerId, 'basic_charm', 1);
    await microdose(playerId, 2);
    const target = await speciesBySlug(RARE);
    const { capture, logs } = captureWith(scriptedRng([]));
    const key = `dungeon:test:${playerId}:rescue`;
    const granted = await t.db.transaction((tx) =>
      capture.grantSpeciesCopy(tx, {
        playerId,
        species: target,
        grantKey: key,
        acquiredVia: 'dungeon_rescue',
        rng: scriptedRng([0.5]),
      }),
    );
    const xp = app.content.tables.progression.xp;
    expect(granted).toMatchObject({ replayed: false, isDuplicate: false, isNewDex: true });
    expect(granted.waifu).toMatchObject({ playerId, speciesId: target.id, grantKey: key, acquiredVia: 'dungeon_rescue' });
    expect(granted.xpGranted).toBe((xp.captureSuccessByRarity as Record<string, number>)[target.rarity]! + xp.newDexEntry);

    expect(await footprint(playerId, 'basic_charm')).toMatchObject({ charm: 1, microdose: 2, attempts: 0, copies: 1 });
    expect(await questProgress(playerId)).toEqual({
      capture_attempts: 0,
      capture_success: 0,
      capture_success_rarity_at_least: 0,
    });
    const events = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, playerId));
    expect(events.map((e) => e.eventType)).toEqual(['species_granted']);
    expect(events[0]!.metadata).toMatchObject({ acquiredVia: 'dungeon_rescue', grantKey: key, waifuId: granted.waifu.id });
    expect(logs.map((l) => l.message)).toEqual(['species copy granted']);
  });

  it('is idempotent on its grant key: a retry returns the first copy and writes nothing', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const target = await speciesBySlug(COMMON);
    const { capture } = captureWith(scriptedRng([]));
    const key = `dungeon:test:${playerId}:retry`;
    const once = (rng: Rng) =>
      t.db.transaction((tx) =>
        capture.grantSpeciesCopy(tx, { playerId, species: target, grantKey: key, acquiredVia: 'dungeon_rescue', rng }),
      );
    const first = await once(scriptedRng([0.1]));
    const after = await footprint(playerId, 'basic_charm');
    const second = await once(scriptedRng([0.9]));
    expect(second.replayed).toBe(true);
    expect(second.waifu.id).toBe(first.waifu.id);
    // The copy keeps the Base SP it was first granted with.
    expect(second.waifu.baseSp).toBe(first.waifu.baseSp);
    expect(second).toMatchObject({ xpGranted: 0, levelUps: [], newAppearances: [] });
    expect(await footprint(playerId, 'basic_charm')).toEqual(after);
    expect(after).toMatchObject({ copies: 1, events: 1 });
  });

  it('two racing grants of one key create exactly one copy', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const target = await speciesBySlug(COMMON);
    const { capture } = captureWith(seededRng(7));
    const key = `dungeon:test:${playerId}:race`;
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        t.db.transaction((tx) =>
          capture.grantSpeciesCopy(tx, { playerId, species: target, grantKey: key, acquiredVia: 'dungeon_rescue' }),
        ),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.waifu.id)).size).toBe(1);
    expect(await footprint(playerId, 'basic_charm')).toMatchObject({ copies: 1, events: 1 });
  });

  it('distinct keys grant duplicates, and the second is not a new dex entry', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const target = await speciesBySlug(COMMON);
    const { capture } = captureWith(seededRng(3));
    const grantOnce = (key: string) =>
      t.db.transaction((tx) =>
        capture.grantSpeciesCopy(tx, { playerId, species: target, grantKey: key, acquiredVia: 'dungeon_rescue' }),
      );
    const first = await grantOnce(`dungeon:test:${playerId}:a`);
    const second = await grantOnce(`dungeon:test:${playerId}:b`);
    expect(second).toMatchObject({ replayed: false, isDuplicate: true, isNewDex: false });
    expect(first.xpGranted - second.xpGranted).toBe(app.content.tables.progression.xp.newDexEntry);
  });

  it('refuses a key that names another player or species, and blank provenance', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const other = await freshPlayer(now);
    const target = await speciesBySlug(COMMON);
    const { capture } = captureWith(seededRng(5));
    const key = `dungeon:test:${playerId}:mine`;
    const attempt = (input: { playerId: number; species: SpeciesRow; grantKey: string; acquiredVia: string }) =>
      t.db.transaction((tx) => capture.grantSpeciesCopy(tx, input));
    await attempt({ playerId, species: target, grantKey: key, acquiredVia: 'dungeon_rescue' });
    await expect(attempt({ playerId: other, species: target, grantKey: key, acquiredVia: 'dungeon_rescue' }))
      .rejects.toBeInstanceOf(CaptureGrantKeyConflictError);
    await expect(attempt({ playerId, species: await speciesBySlug(RARE), grantKey: key, acquiredVia: 'dungeon_rescue' }))
      .rejects.toBeInstanceOf(CaptureGrantKeyConflictError);
    await expect(attempt({ playerId, species: target, grantKey: ' ', acquiredVia: 'dungeon_rescue' }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(attempt({ playerId, species: target, grantKey: 'k', acquiredVia: '' }))
      .rejects.toBeInstanceOf(RangeError);
    expect(await footprint(other, 'basic_charm')).toMatchObject({ copies: 0, events: 0 });
  });

  it('can grant without XP', async () => {
    const now = new Date();
    const playerId = await freshPlayer(now);
    const { capture } = captureWith(seededRng(9));
    const granted = await t.db.transaction(async (tx) =>
      capture.grantSpeciesCopy(tx, {
        playerId,
        species: await speciesBySlug(COMMON),
        grantKey: `dungeon:test:${playerId}:noxp`,
        acquiredVia: 'dungeon_rescue',
        awardXp: false,
      }),
    );
    expect(granted.xpGranted).toBe(0);
    expect(await footprint(playerId, 'basic_charm')).toMatchObject({ copies: 1, events: 0, xp: 0 });
  });
});
