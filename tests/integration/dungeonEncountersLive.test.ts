/**
 * Phase 4B2B — live dungeon captures and rescues, against real PostgreSQL.
 *
 * The pure engine is covered in tests/unit/dungeons/dungeonEncounters.test.ts
 * and the capture extraction in captureExtraction.test.ts. This file is the
 * join: a published dungeon whose encounter spends a real charm, rolls the
 * hunt's own formula against the run's pinned Buddy, and writes ownership,
 * XP, quests, the acquisition ledger, run state and history in one
 * transaction — or none of them.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dungeonRunEvents,
  dungeonRuns,
  dungeonSpeciesAcquisitions,
  encounters,
  playerActiveEffects,
  playerCurrencies,
  playerDailyQuests,
  playerInventory,
  playerProgressionEvents,
  players,
  playerWaifus,
  regionEncounterPools,
  species,
  type SpeciesRow,
} from '../../src/db/schema';
import type { BuddyBonus } from '../../src/modules/buddyBonus/buddyBonusEffects';
import { computeCaptureChance } from '../../src/modules/capture/captureMath';
import type { DungeonDefinition } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonActionResult, DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import type { DungeonInput } from '../../src/modules/dungeons/engine/types';
import { rollBaseSeductivePower } from '../../src/modules/power/seductivePower';
import { CaptureGrantKeyConflictError, DungeonInvalidError } from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug, insertOwnedWaifu } from '../helpers/fixtures';

const COMMON = 'neko_barista'; // N
const OTHER = 'gym_oni'; // N
const RARE = 'neon_kitsune'; // SR
const CHARM = 'basic_charm';
const CONTRACT = 'mythic_contract'; // guaranteed
const ROOM = 'hall';
const ACTION = 'meet';

let w: DungeonWorld;
let keySeq = 0;

beforeAll(async () => {
  w = await createDungeonWorld();
  // Neutral matchups everywhere, so no case depends on what the corpus ships.
  await w.t.db.update(species).set({ affinity: 'switch' });
});
afterAll(async () => {
  await w.cleanup();
});

type Input = DungeonInput extends infer I ? (I extends unknown ? Omit<I, 'expectedStep'> : never) : never;
const act = (playerId: number, run: DungeonRunView, input: Input): Promise<DungeonActionResult> =>
  w.act(playerId, run, input as DungeonInput);

async function speciesRow(slug: string): Promise<SpeciesRow> {
  const [row] = await w.t.db.select().from(species).where(eq(species.slug, slug));
  if (!row) throw new Error(`missing seeded species ${slug}`);
  return row;
}

async function give(playerId: number, slug: string, quantity: number): Promise<void> {
  await w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, slug)).id, quantity);
}

async function held(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(w.t.db, slug);
  const [row] = await w.t.db
    .select({ quantity: playerInventory.quantity })
    .from(playerInventory)
    .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, item.id)));
  return row?.quantity ?? 0;
}

const copies = (playerId: number) =>
  w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId)).orderBy(asc(playerWaifus.id));
const ledger = (playerId: number) =>
  w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.playerId, playerId)).orderBy(asc(dungeonSpeciesAcquisitions.id));
const xpEvents = (playerId: number) =>
  w.t.db.select().from(playerProgressionEvents).where(eq(playerProgressionEvents.playerId, playerId)).orderBy(asc(playerProgressionEvents.id));
const history = async (runId: number) => (await w.runs.history(runId)).map((e) => e.type);

/** A one-room dungeon whose hall holds the given encounter, published under a fresh key. */
async function publishEncounter(action: Record<string, unknown>, patch: (d: Record<string, unknown>) => void = () => {}): Promise<DungeonDefinition> {
  const key = `enc_${++keySeq}`;
  const definition = singleRoomDungeon([{ id: ACTION, ...action } as never], (input) => {
    input.key = key;
    patch(input as unknown as Record<string, unknown>);
  });
  await w.publish(definition);
  return definition;
}

const wild = (speciesSlug: string, capture: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  type: 'wild_encounter',
  source: { kind: 'species', species: speciesSlug },
  intro: 'She appears.',
  capture,
  ...over,
});

/** The engine's own place-keyed draws for this test dungeon's one encounter. */
const attemptRoll = (seed: number, n: number) => dungeonRngSource(seed).stream('encounter', ROOM, ACTION, 'attempt', n).next();
const spRoll = (seed: number) => dungeonRngSource(seed).stream('encounter', ROOM, ACTION, 'sp').next();
/** A run seed whose first three capture rolls all satisfy `want`. */
function seedWhere(want: (roll: number) => boolean): number {
  for (let seed = 1; seed < 100_000; seed += 1) if ([1, 2, 3].every((n) => want(attemptRoll(seed, n)))) return seed;
  throw new Error('no seed found');
}
const expectedBaseSp = (rarity: string, seed: number) =>
  rollBaseSeductivePower(
    rarity,
    { intInclusive: (min, max) => Math.floor(spRoll(seed) * (max - min + 1)) + min },
    w.app.content.tables.seductivePower.rangesByRarity,
  );

const offered = (run: DungeonRunView) => {
  const encounter = run.core.action?.encounter;
  if (!encounter) throw new Error(`run ${run.id} is not standing on an offered encounter`);
  return encounter;
};
const instance = async (runId: number) => {
  const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId));
  return (row!.encounterStates as Record<string, { status: string; unavailableReason?: string; attempts: { n: number; item: string; chance: number; roll: number; success: boolean }[] }>)[`${ROOM}:${ACTION}`]!;
};

async function holdQuests(playerId: number): Promise<void> {
  const questDate = new Date().toISOString().slice(0, 10);
  await w.t.db.insert(playerDailyQuests).values(
    [
      { type: 'capture_attempts', rarityAtLeast: null },
      { type: 'capture_success', rarityAtLeast: null },
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
}
const questProgress = async (playerId: number) =>
  Object.fromEntries(
    (await w.t.db.select().from(playerDailyQuests).where(eq(playerDailyQuests.playerId, playerId))).map((q) => [q.type, q.progress]),
  );

/** Everything a capture step may write, for all-or-nothing comparisons. */
async function worldOf(playerId: number, runId: number) {
  const [run] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId));
  const [player] = await w.t.db.select({ xp: players.xp, level: players.level }).from(players).where(eq(players.id, playerId));
  return {
    run: { ...run, updatedAt: null },
    player,
    inventory: await w.t.db.select().from(playerInventory).where(eq(playerInventory.playerId, playerId)).orderBy(asc(playerInventory.itemId)),
    effects: await w.t.db.select().from(playerActiveEffects).where(eq(playerActiveEffects.playerId, playerId)),
    copies: await copies(playerId),
    ledger: await ledger(playerId),
    xp: await xpEvents(playerId),
    quests: await questProgress(playerId),
    history: await history(runId),
  };
}

async function withBuddyBonus<T>(slug: string, bonus: BuddyBonus, body: () => Promise<T>): Promise<T> {
  const entry = w.app.content.species.find((s) => s.slug === slug);
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

/** The species of the Buddy every `w.player()` is given. */
async function buddySlug(playerId: number): Promise<string> {
  const [row] = await w.t.db
    .select({ slug: species.slug })
    .from(players)
    .innerJoin(playerWaifus, eq(players.buddyWaifuId, playerWaifus.id))
    .innerJoin(species, eq(playerWaifus.speciesId, species.id))
    .where(eq(players.id, playerId));
  return row!.slug;
}

describe('migration 0068', () => {
  it('adds encounter_states, the three history types and the acquisition ledger', async () => {
    const column = await w.t.db.execute(sql`
      select column_default, is_nullable from information_schema.columns
      where table_name = 'dungeon_runs' and column_name = 'encounter_states'`);
    expect(column.rows).toEqual([{ column_default: "'{}'::jsonb", is_nullable: 'NO' }]);
    const check = await w.t.db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'dungeon_run_events_type_check' and conrelid = 'dungeon_run_events'::regclass`);
    const def = String((check.rows[0] as { def: string }).def);
    for (const type of ['encounter_selected', 'capture_attempted', 'waifu_acquired', 'items_consumed', 'run_started']) expect(def).toContain(`'${type}'`);
    const indexes = await w.t.db.execute(sql`select indexname from pg_indexes where tablename = 'dungeon_species_acquisitions' order by 1`);
    expect(indexes.rows.map((r) => (r as { indexname: string }).indexname)).toEqual([
      'dungeon_species_acquisitions_grant_key_uq',
      'dungeon_species_acquisitions_pkey',
      'dungeon_species_acquisitions_player_dungeon_species_idx',
      'dungeon_species_acquisitions_waifu_uq',
    ]);
  });
});

describe('publication and species policy', () => {
  const issuesOf = async (action: Record<string, unknown>) => {
    try {
      await publishEncounter(action);
      return [];
    } catch (err) {
      if (!(err instanceof DungeonInvalidError)) throw err;
      return err.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    }
  };

  it('publishes an ordinary species and still refuses to export it', async () => {
    const definition = await publishEncounter(wild(COMMON));
    expect(await w.content.revisions(definition.key)).toHaveLength(1);
    await expect(w.content.exportPackage(definition.key, 'published', 'test')).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringMatching(/package v4/) })],
    });
  });

  it('refuses unknown and disabled species', async () => {
    expect(await issuesOf(wild('no_such_species'))).toEqual(['species_missing']);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, OTHER));
    try {
      expect(await issuesOf(wild(OTHER))).toEqual(['species_disabled']);
    } finally {
      await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, OTHER));
    }
  });

  it.each(['region_exclusive', 'dungeon_exclusive'])('offers a %s species only from a dungeon her content lists', async (tag) => {
    const row = await speciesRow(OTHER);
    await w.t.db.update(species).set({ tags: [tag] }).where(eq(species.id, row.id));
    try {
      expect(await issuesOf(wild(OTHER))).toEqual(['species_not_permitted']);
      w.speciesAccess.set(OTHER, [{ dungeon: `enc_${keySeq + 1}` }]);
      expect(await issuesOf(wild(OTHER))).toEqual([]);
      // Listed for that dungeon only.
      expect(await issuesOf(wild(OTHER))).toEqual(['species_not_permitted']);
    } finally {
      w.speciesAccess.delete(OTHER);
      await w.t.db.update(species).set({ tags: row.tags }).where(eq(species.id, row.id));
    }
  });

  it('requires explicit authorization and a finite limit for a direct rescue', async () => {
    const rescue = { type: 'rescue', mode: 'direct', source: { kind: 'species', species: OTHER }, intro: 'Free her.', when: { type: 'flag', flag: 'lever' } };
    expect(await issuesOf(rescue)).toEqual(['rescue_direct_not_permitted']);
    try {
      w.speciesAccess.set(OTHER, [{ dungeon: `enc_${keySeq + 1}`, directRescue: true, perPlayerLimit: 'unlimited' }]);
      expect(await issuesOf(rescue)).toEqual(['rescue_direct_limit_missing']);
      w.speciesAccess.set(OTHER, [{ dungeon: `enc_${keySeq + 1}`, directRescue: true, perPlayerLimit: 1 }]);
      expect(await issuesOf(rescue)).toEqual([]);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('refuses an encounter no permitted charm could capture', async () => {
    // A rope for SSR and above, against an N species.
    expect(await issuesOf(wild(COMMON, { allowedItems: ['shibari_rope'] }))).toEqual(['capture_no_usable_item']);
  });

  it('rolls back to an encounter revision under the same policy', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const first = (await w.content.revisions(definition.key))![0]!;
    await w.republish({ ...definition, name: 'Renamed' });
    const rolled = await w.content.rollback(definition.key, { revision: 1 }, 'test');
    expect(rolled.revision.contentHash).toBe(first.contentHash);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, COMMON));
    try {
      await expect(w.content.rollback(definition.key, { revision: 2 }, 'test')).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'species_disabled' })]),
      });
    } finally {
      await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, COMMON));
    }
  });
});

describe('a real capture', () => {
  it('captures with a guaranteed item: charm, copy, XP, quests, ledger and history commit together', async () => {
    const definition = await publishEncounter(wild(RARE));
    const { playerId } = await w.player();
    await holdQuests(playerId);
    await give(playerId, CONTRACT, 2);
    const seed = 4242;
    let run = await w.runs.start(playerId, definition.key, { seed });
    expect(offered(run)).toMatchObject({ species: RARE, rarity: 'SR', available: true, attemptsLeft: 3, selectedItem: null });
    expect(offered(run).items).toEqual([{ item: CONTRACT, owned: 2, guaranteed: true, chance: 1 }]);

    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    expect(await held(playerId, CONTRACT)).toBe(2);
    const result = await act(playerId, run, { type: 'capture' });
    expect(result.status).toBe('applied');
    expect(await held(playerId, CONTRACT)).toBe(1);

    const rare = await speciesRow(RARE);
    const [copy] = (await copies(playerId)).filter((c) => c.speciesId === rare.id);
    expect(copy).toMatchObject({
      acquiredVia: 'dungeon_capture',
      grantKey: `dungeon:${run.id}:${ROOM}:${ACTION}`,
      baseSp: expectedBaseSp('SR', seed),
    });
    expect(await ledger(playerId)).toEqual([
      expect.objectContaining({
        speciesId: rare.id, dungeonKey: definition.key, runId: run.id, roomId: ROOM, actionId: ACTION,
        mode: 'capture', waifuId: copy!.id, grantKey: copy!.grantKey,
      }),
    ]);
    expect(result.encounterReceipts).toEqual([
      expect.objectContaining({
        type: 'capture_attempt', simulated: false, success: true, outcome: 'success', guaranteed: true, item: CONTRACT,
        acquired: expect.objectContaining({ waifuId: copy!.id, speciesSlug: RARE, isNewDex: true, isDuplicate: false }),
      }),
    ]);
    const xp = await xpEvents(playerId);
    expect(xp.map((e) => e.eventType)).toEqual(['capture_success', 'new_dex_entry']);
    expect(xp[0]!.metadata).toMatchObject({ acquiredVia: 'dungeon_capture', grantKey: copy!.grantKey, speciesSlug: RARE });
    expect(await questProgress(playerId)).toEqual({ capture_attempts: 1, capture_success: 1 });
    expect(await instance(run.id)).toMatchObject({ status: 'captured', attempts: [{ n: 1, item: CONTRACT, success: true }] });
    const types = await history(run.id);
    expect(types.filter((t) => ['encounter_selected', 'capture_attempted', 'waifu_acquired'].includes(t))).toEqual([
      'encounter_selected', 'capture_attempted', 'waifu_acquired',
    ]);
    // No hunted encounter exists: nothing here counts as a hunt.
    expect(await w.t.db.select().from(encounters).where(eq(encounters.playerId, playerId))).toEqual([]);
  });

  it('fails, stays open, then escapes: one charm and one recorded attempt per press', async () => {
    const definition = await publishEncounter(wild(COMMON, { maxAttempts: 2 }));
    const { playerId } = await w.player();
    await holdQuests(playerId);
    await give(playerId, CHARM, 5);
    const quote = await w.app.capture.quoteSpecies(w.t.db, playerId, await speciesRow(COMMON), await getItemBySlug(w.t.db, CHARM));
    const seed = seedWhere((roll) => roll >= quote.chance);
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;

    const first = await act(playerId, run, { type: 'capture' });
    expect(first.encounterReceipts).toEqual([expect.objectContaining({ success: false, outcome: 'failure', acquired: null, roll: attemptRoll(seed, 1) })]);
    expect(await held(playerId, CHARM)).toBe(4);
    expect(offered(first.run)).toMatchObject({ attemptsLeft: 1, selectedItem: CHARM });

    const second = await act(playerId, first.run, { type: 'capture' });
    expect(second.encounterReceipts).toEqual([expect.objectContaining({ success: false, outcome: 'escape', roll: attemptRoll(seed, 2) })]);
    expect(await held(playerId, CHARM)).toBe(3);
    expect(second.run.core.action?.encounter ?? null).toBeNull();
    expect(await instance(run.id)).toMatchObject({ status: 'escaped', attempts: [{ n: 1, success: false }, { n: 2, success: false }] });
    expect((await copies(playerId)).length).toBe(1); // the Buddy only
    expect(await ledger(playerId)).toEqual([]);
    expect((await xpEvents(playerId)).map((e) => e.eventType)).toEqual(['capture_failed', 'capture_failed']);
    expect(await questProgress(playerId)).toEqual({ capture_attempts: 2, capture_success: 0 });
    expect((await history(run.id)).filter((t) => t === 'capture_attempted')).toHaveLength(2);
    // A resolved encounter takes no further input.
    expect((await act(playerId, second.run, { type: 'capture' })).status).toBe('refused');
    expect(await held(playerId, CHARM)).toBe(3);
  });

  it('leaving spends nothing', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 1);
    const run = await w.runs.start(playerId, definition.key);
    const left = await act(playerId, run, { type: 'leave_encounter' });
    expect(left.status).toBe('applied');
    expect(left.encounterReceipts).toBeUndefined();
    expect(await held(playerId, CHARM)).toBe(1);
    expect((await instance(run.id)).status).toBe('left');
  });
});

describe('odds, charms and Microdose', () => {
  it('quotes the hunt formula, offers only rarity-eligible charms, and rolls against the quote it showed', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    for (const slug of [CHARM, 'silk_charm', 'fluffy_cuffs', 'shibari_rope']) await give(playerId, slug, 1);
    const common = await speciesRow(COMMON);
    let run = await w.runs.start(playerId, definition.key);
    const fighter = run.fighter;
    const items = Object.fromEntries(offered(run).items.map((i) => [i.item, i.chance]));
    // The rope is SSR-and-above only, so an N encounter never offers it.
    expect(Object.keys(items).sort()).toEqual([CHARM, 'fluffy_cuffs', 'silk_charm']);
    for (const slug of Object.keys(items)) {
      const item = await getItemBySlug(w.t.db, slug);
      const pinned = await w.app.capture.quoteSpecies(w.t.db, playerId, common, item, { waifuId: fighter.waifuId, speciesSlug: fighter.speciesSlug, pinned: fighter.captureBuddy });
      expect(items[slug]).toBe(pinned.chance);
      // The formula itself, term by term, with this Buddy's contributions.
      expect(items[slug]).toBe(computeCaptureChance({
        guaranteed: false, baseCaptureRate: common.baseCaptureRate, rarity: 'N', captureModifier: item.captureModifier,
        config: w.app.content.tables.capture, buddyAffinityModifier: pinned.buddyAffinityModifier, captureBonusModifier: 0,
        buddyBonusPercent: pinned.buddyBonusPercent, itemCaptureBonus: item.captureBonus ?? 0,
      }));
    }
    expect((await act(playerId, run, { type: 'select_item', item: 'shibari_rope' })).refusal).toBe('capture_item_unavailable');
    expect((await act(playerId, run, { type: 'capture' })).refusal).toBe('capture_item_required');
    run = (await act(playerId, run, { type: 'select_item', item: 'silk_charm' })).run;
    const result = await act(playerId, run, { type: 'capture' });
    const [attempt] = (await instance(run.id)).attempts;
    expect(attempt!.chance).toBe(items.silk_charm);
    expect(result.encounterReceipts![0]).toMatchObject({ chance: items.silk_charm, roll: attempt!.roll, success: attempt!.success });
    expect(await held(playerId, 'silk_charm')).toBe(0);
  });

  it('honours an encounter restricted to named charms and closed to guaranteed items', async () => {
    const definition = await publishEncounter(wild(COMMON, { allowedItems: [CHARM, CONTRACT], allowGuaranteedItems: false }));
    const { playerId } = await w.player();
    for (const slug of [CHARM, 'silk_charm', CONTRACT]) await give(playerId, slug, 1);
    const run = await w.runs.start(playerId, definition.key);
    expect(offered(run).items.map((i) => i.item)).toEqual([CHARM]);
    expect((await act(playerId, run, { type: 'select_item', item: CONTRACT })).refusal).toBe('capture_item_unavailable');
  });

  it('spends a Microdose charge per ordinary attempt, none on a guaranteed one, and quotes with it', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 3);
    await give(playerId, CONTRACT, 1);
    const plain = (await w.app.capture.quoteSpecies(w.t.db, playerId, await speciesRow(COMMON), await getItemBySlug(w.t.db, CHARM))).chance;
    await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 1 });
    const boosted = plain + 0.1;
    const seed = seedWhere((roll) => roll >= boosted);
    let run = await w.runs.start(playerId, definition.key, { seed });
    expect(offered(run).items.find((i) => i.item === CHARM)!.chance).toBeCloseTo(boosted, 10);
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;

    const first = await act(playerId, run, { type: 'capture' });
    expect(first.encounterReceipts![0]).toMatchObject({ success: false, microdose: { sourceItemSlug: 'microdose', chargesRemaining: 0 } });
    expect((await instance(run.id)).attempts[0]!.chance).toBeCloseTo(boosted, 10);
    // The charge is gone, so the next quote is the plain one again.
    expect(offered(first.run).items.find((i) => i.item === CHARM)!.chance).toBeCloseTo(plain, 10);
    expect(await w.app.effects.getCaptureBonus(playerId)).toBeNull();

    await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 2 });
    run = (await act(playerId, first.run, { type: 'select_item', item: CONTRACT })).run;
    const second = await act(playerId, run, { type: 'capture' });
    expect(second.encounterReceipts![0]).toMatchObject({ success: true, guaranteed: true, microdose: null });
    expect((await w.app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(2);
  });

  it('a quote inside a transaction sees a Microdose charge that transaction already spent', async () => {
    const { playerId } = await w.player();
    const common = await speciesRow(COMMON);
    const charm = await getItemBySlug(w.t.db, CHARM);
    await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 1 });
    const before = (await w.app.capture.quoteSpecies(w.t.db, playerId, common, charm)).captureBonusModifier;
    expect(before).toBeCloseTo(0.1, 10);
    await w.t.db.transaction(async (tx) => {
      await w.app.effects.consumeCaptureCharge(tx, playerId);
      expect((await w.app.capture.quoteSpecies(tx, playerId, common, charm)).captureBonusModifier).toBe(0);
      // Uncommitted, so a reader outside the transaction still sees the charge.
      expect((await w.app.capture.quoteSpecies(w.t.db, playerId, common, charm)).captureBonusModifier).toBeCloseTo(0.1, 10);
    });
  });
});

describe('the pinned Buddy', () => {
  const CAPTURE_BONUS: BuddyBonus = { name: 'Lure', flavorText: 'Display only.', effectId: 'capture_chance', value: 40 };
  const XP_BONUS: BuddyBonus = { name: 'Tutor', flavorText: 'Display only.', effectId: 'player_xp_gain', value: 50 };

  /** Give the player a second copy of another species and make her the live Buddy. */
  async function swapLiveBuddy(playerId: number): Promise<number> {
    const other = await speciesRow(OTHER);
    const copy = await insertOwnedWaifu(w.t.db, { playerId, speciesId: other.id, level: 1, baseSp: 50 });
    await w.t.db.update(players).set({ buddyWaifuId: copy.id }).where(eq(players.id, playerId));
    return copy.id;
  }

  it('freezes her capture bonus at start: swapping Buddy or retuning content mid-run changes no odds', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 2);
    const slug = await buddySlug(playerId);
    const charm = await getItemBySlug(w.t.db, CHARM);
    const common = await speciesRow(COMMON);
    const run = await withBuddyBonus(slug, CAPTURE_BONUS, () => w.runs.start(playerId, definition.key));
    expect(run.fighter.captureBuddy).toEqual({ affinity: 'switch', rarity: expect.any(String), bonus: CAPTURE_BONUS });
    const frozen = offered(run).items[0]!.chance;
    const none = (await w.app.capture.quoteSpecies(w.t.db, playerId, common, charm, null)).chance;
    expect(frozen).toBeCloseTo(Math.min(none * 1.4, w.app.content.tables.capture.maxChance), 10);

    // The bonus was retuned away when `withBuddyBonus` returned, the live Buddy
    // is now someone else, and the pinned species' affinity is edited.
    await swapLiveBuddy(playerId);
    await w.t.db.update(species).set({ affinity: 'dominant' }).where(eq(species.slug, slug));
    try {
      const again = await w.runs.run(playerId, run.id);
      expect(offered(again).items[0]!.chance).toBe(frozen);
      const selected = (await act(playerId, again, { type: 'select_item', item: CHARM })).run;
      await act(playerId, selected, { type: 'capture' });
      expect((await instance(run.id)).attempts[0]!.chance).toBe(frozen);
      // A hunt-style quote still reads the live Buddy, who has no bonus.
      expect((await w.app.capture.quoteSpecies(w.t.db, playerId, common, charm)).buddyBonusPercent).toBe(0);
    } finally {
      await w.t.db.update(species).set({ affinity: 'switch' }).where(eq(species.slug, slug));
    }
  });

  it("pays dungeon capture XP with the pinned Buddy's XP bonus, while a hunt keeps reading the live Buddy", async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 1);
    const slug = await buddySlug(playerId);
    const base = (w.app.content.tables.progression.xp.captureSuccessByRarity as Record<string, number>).N! + w.app.content.tables.progression.xp.newDexEntry;
    let run = await withBuddyBonus(slug, XP_BONUS, () => w.runs.start(playerId, definition.key));
    await swapLiveBuddy(playerId);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    const result = await act(playerId, run, { type: 'capture' });
    expect(result.encounterReceipts![0]!.xpGranted).toBe(Math.round(base * 1.5));
    const [event] = await xpEvents(playerId);
    expect(event).toMatchObject({ eventType: 'capture_success', xpDelta: Math.round(base * 1.5) });
    expect(event!.metadata).toMatchObject({ buddyBonusPercent: 50, baseXpDelta: base });

    // The same grant path with no override is the hunt's: live Buddy, no bonus.
    const live = await w.t.db.transaction((tx) => w.app.progression.grantXp(tx, playerId, { eventType: 'probe', xpDelta: 100 }));
    expect(live.xpDelta).toBe(100);
    // And with the live Buddy carrying the bonus, the hunt path is boosted.
    const boosted = await withBuddyBonus(OTHER, XP_BONUS, () =>
      w.t.db.transaction((tx) => w.app.progression.grantXp(tx, playerId, { eventType: 'probe', xpDelta: 100 })));
    expect(boosted.xpDelta).toBe(150);
  });

  it('a run started before the capture snapshot reads the pinned species, never the live Buddy', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 1);
    const slug = await buddySlug(playerId);
    const run = await w.runs.start(playerId, definition.key);
    // As a run written by an older build: no `captureBuddy` on the fighter.
    await w.t.db.execute(sql`update dungeon_runs set fighter = fighter - 'captureBuddy' where id = ${run.id}`);
    await swapLiveBuddy(playerId);
    const common = await speciesRow(COMMON);
    const charm = await getItemBySlug(w.t.db, CHARM);
    const none = (await w.app.capture.quoteSpecies(w.t.db, playerId, common, charm, null)).chance;
    // The live Buddy's species carries a bonus; the pinned species carries another.
    await withBuddyBonus(OTHER, { ...CAPTURE_BONUS, value: 90 }, () =>
      withBuddyBonus(slug, CAPTURE_BONUS, async () => {
        const view = await w.runs.run(playerId, run.id);
        expect(view.fighter.captureBuddy).toBeUndefined();
        expect(offered(view).items[0]!.chance).toBeCloseTo(Math.min(none * 1.4, w.app.content.tables.capture.maxChance), 10);
      }));
  });
});

describe('direct rescue and acquisition limits', () => {
  const rescue = (speciesSlug: string) => ({
    type: 'rescue', mode: 'direct', source: { kind: 'species', species: speciesSlug }, intro: 'Free her.', results: { unavailable: { text: 'The cell is empty.' } },
  });

  it('grants a rescued copy with no charm, and a second run finds the finite limit reached', async () => {
    w.speciesAccess.set(OTHER, [{ dungeon: `enc_${keySeq + 1}`, directRescue: true, perPlayerLimit: 1 }]);
    try {
      const definition = await publishEncounter(rescue(OTHER));
      const { playerId } = await w.player();
      await holdQuests(playerId);
      await give(playerId, CHARM, 1);
      const seed = 99;
      const run = await w.runs.start(playerId, definition.key, { seed });
      expect(offered(run)).toMatchObject({ mode: 'direct', available: true, items: [] });
      expect((await act(playerId, run, { type: 'capture' })).refusal).toBe('not_available');
      const result = await act(playerId, run, { type: 'rescue' });
      const other = await speciesRow(OTHER);
      const [copy] = (await copies(playerId)).filter((c) => c.speciesId === other.id);
      expect(copy).toMatchObject({ acquiredVia: 'dungeon_rescue', grantKey: `dungeon:${run.id}:${ROOM}:${ACTION}`, baseSp: expectedBaseSp(other.rarity, seed) });
      expect(result.encounterReceipts).toEqual([expect.objectContaining({ type: 'rescue_grant', replayed: false, acquired: expect.objectContaining({ waifuId: copy!.id }) })]);
      expect(await ledger(playerId)).toEqual([expect.objectContaining({ mode: 'rescue_direct', waifuId: copy!.id, grantKey: copy!.grantKey })]);
      expect(await held(playerId, CHARM)).toBe(1);
      expect((await xpEvents(playerId)).map((e) => e.eventType)).toEqual(['species_granted']);
      // A rescue is not a capture: no capture quest moves.
      expect(await questProgress(playerId)).toEqual({ capture_attempts: 0, capture_success: 0 });
      // The same press again is a stale step.
      expect((await act(playerId, run, { type: 'rescue' })).refusal).toBe('stale');

      await act(playerId, result.run, { type: 'abandon' });
      const second = await w.runs.start(playerId, definition.key);
      // Resolved on arrival, with nothing to press and nothing granted.
      expect(second.core.action?.encounter ?? null).toBeNull();
      expect(await instance(second.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit' });
      expect((await copies(playerId)).filter((c) => c.speciesId === other.id)).toHaveLength(1);
      expect(await ledger(playerId)).toHaveLength(1);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('a rescue whose grant key already made its copy replays it: no second copy, no second ledger row', async () => {
    w.speciesAccess.set(OTHER, [{ dungeon: `enc_${keySeq + 1}`, directRescue: true, perPlayerLimit: 5 }]);
    try {
      const definition = await publishEncounter(rescue(OTHER));
      const { playerId } = await w.player();
      const run = await w.runs.start(playerId, definition.key);
      const [before] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
      await act(playerId, run, { type: 'rescue' });
      // Wind the run row back to before the rescue, as if only its write had been lost.
      await w.t.db.update(dungeonRuns).set({
        step: before!.step, cursor: before!.cursor, roomStates: before!.roomStates, encounterStates: before!.encounterStates,
        recent: before!.recent, flags: before!.flags, status: 'active', completedAt: null, settlement: null,
      }).where(eq(dungeonRuns.id, run.id));
      const replay = await act(playerId, run, { type: 'rescue' });
      expect(replay.encounterReceipts).toEqual([expect.objectContaining({ replayed: true, xpGranted: 0 })]);
      const other = await speciesRow(OTHER);
      expect((await copies(playerId)).filter((c) => c.speciesId === other.id)).toHaveLength(1);
      expect(await ledger(playerId)).toHaveLength(1);
      expect((await xpEvents(playerId)).filter((e) => e.eventType === 'species_granted')).toHaveLength(1);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('a capture whose grant key already exists is refused whole: the charm is not spent twice', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 2);
    let run = await w.runs.start(playerId, definition.key);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    const [before] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    await act(playerId, run, { type: 'capture' });
    await w.t.db.update(dungeonRuns).set({
      step: before!.step, cursor: before!.cursor, roomStates: before!.roomStates, encounterStates: before!.encounterStates,
      recent: before!.recent, flags: before!.flags, status: 'active', completedAt: null, settlement: null,
    }).where(eq(dungeonRuns.id, run.id));
    const world = await worldOf(playerId, run.id);
    await expect(act(playerId, run, { type: 'capture' })).rejects.toBeInstanceOf(CaptureGrantKeyConflictError);
    expect(await worldOf(playerId, run.id)).toEqual(world);
    expect(await held(playerId, CONTRACT)).toBe(1);
    // The ledger's own key refuses a second row for the same grant, whoever writes it.
    const [row] = await ledger(playerId);
    const buddy = (await copies(playerId))[0]!;
    await expect(w.t.db.insert(dungeonSpeciesAcquisitions).values({
      playerId, speciesId: row!.speciesId, dungeonKey: row!.dungeonKey, runId: row!.runId, roomId: row!.roomId,
      actionId: row!.actionId, mode: row!.mode, waifuId: buddy.id, grantKey: row!.grantKey,
    })).rejects.toThrow();
    // And the copy's own key is unique on player_waifus.
    await expect(w.t.db.insert(playerWaifus).values({ playerId, speciesId: row!.speciesId, baseSp: 1, grantKey: row!.grantKey })).rejects.toThrow();
  });

  it('enforces a finite capture limit across runs and leaves an unlimited species alone', async () => {
    const limited = `enc_${keySeq + 1}`;
    w.speciesAccess.set(COMMON, [{ dungeon: limited, perPlayerLimit: 1 }]);
    w.speciesAccess.set(RARE, [{ dungeon: `enc_${keySeq + 2}`, perPlayerLimit: 'unlimited' }]);
    try {
      const finite = await publishEncounter(wild(COMMON));
      const open = await publishEncounter(wild(RARE));
      const { playerId } = await w.player();
      await give(playerId, CONTRACT, 4);
      const capture = async (key: string) => {
        let run = await w.runs.start(playerId, key);
        if (!run.core.action?.encounter) return run;
        run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
        return (await act(playerId, run, { type: 'capture' })).run;
      };
      const end = (run: DungeonRunView) => (run.status === 'active' ? act(playerId, run, { type: 'abandon' }) : null);

      await end(await capture(finite.key));
      const blocked = await capture(finite.key);
      expect(await instance(blocked.id)).toMatchObject({ status: 'unavailable', unavailableReason: 'player_limit', attempts: [] });
      expect(await held(playerId, CONTRACT)).toBe(3);
      await end(blocked);

      w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
      await end(await capture(open.key));
      await end(await capture(open.key));
      const rows = await ledger(playerId);
      expect(rows.map((r) => r.dungeonKey)).toEqual([finite.key, open.key, open.key]);
      expect(await held(playerId, CONTRACT)).toBe(1);
      // Another player's limit is their own.
      const { playerId: someoneElse } = await w.player();
      await give(someoneElse, CONTRACT, 1);
      let theirs = await w.runs.start(someoneElse, finite.key);
      expect(offered(theirs).available).toBe(true);
      theirs = (await act(someoneElse, theirs, { type: 'select_item', item: CONTRACT })).run;
      expect((await act(someoneElse, theirs, { type: 'capture' })).encounterReceipts![0]).toMatchObject({ success: true });
    } finally {
      w.speciesAccess.delete(COMMON);
      w.speciesAccess.delete(RARE);
    }
  });
});

describe('live refusal', () => {
  it.each([
    ['disabled', (id: number) => w.t.db.update(species).set({ enabled: false }).where(eq(species.id, id)), 'disabled'],
    ['restricted', (id: number) => w.t.db.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.id, id)), 'not_permitted'],
  ] as const)('a species %s between offer and attempt resolves unavailable without spending the charm', async (_name, change, reason) => {
    const definition = await publishEncounter(wild(OTHER));
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 1);
    const row = await speciesRow(OTHER);
    let run = await w.runs.start(playerId, definition.key);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    await change(row.id);
    try {
      const result = await act(playerId, run, { type: 'capture' });
      expect(result.status).toBe('applied');
      expect(result.encounterReceipts).toBeUndefined();
      expect(await instance(run.id)).toMatchObject({ status: 'unavailable', unavailableReason: reason, attempts: [] });
      expect(await held(playerId, CONTRACT)).toBe(1);
      expect(await ledger(playerId)).toEqual([]);
      // New runs find the same thing on arrival.
      await act(playerId, result.run, { type: 'abandon' });
      const next = await w.runs.start(playerId, definition.key);
      expect(await instance(next.id)).toMatchObject({ status: 'unavailable', unavailableReason: reason });
    } finally {
      await w.t.db.update(species).set({ enabled: true, tags: row.tags }).where(eq(species.id, row.id));
    }
  });

  it('a charm gone or made ineligible since it was selected is refused with nothing spent', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 1);
    await give(playerId, 'silk_charm', 1);
    let run = await w.runs.start(playerId, definition.key);
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    const charm = await getItemBySlug(w.t.db, CHARM);
    await w.app.inventory.consumeItem(w.t.db, playerId, charm.id, 1);
    expect((await act(playerId, run, { type: 'capture' })).refusal).toBe('capture_item_unavailable');

    run = (await act(playerId, run, { type: 'select_item', item: 'silk_charm' })).run;
    const silk = await getItemBySlug(w.t.db, 'silk_charm');
    await w.t.db.execute(sql`update items set capture_rarities = '["UR"]'::jsonb where id = ${silk.id}`);
    try {
      expect((await act(playerId, run, { type: 'capture' })).refusal).toBe('capture_item_unavailable');
      expect(await held(playerId, 'silk_charm')).toBe(1);
      expect((await instance(run.id)).attempts).toEqual([]);
    } finally {
      await w.t.db.execute(sql`update items set capture_rarities = null where id = ${silk.id}`);
    }
  });
});

describe('rollback and concurrency', () => {
  it('a failure on the last write rolls the whole step back, and the retry draws the same roll and Base SP', async () => {
    const definition = await publishEncounter(wild(RARE));
    const { playerId } = await w.player();
    await holdQuests(playerId);
    await give(playerId, CONTRACT, 1);
    await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 2 });
    const seed = 777;
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    const before = await worldOf(playerId, run.id);

    // The history insert is the last statement of a step. Make it fail.
    await w.t.db.execute(sql`
      create function fail_waifu_acquired() returns trigger language plpgsql as $$
      begin
        if new.type = 'waifu_acquired' then raise exception 'forced late failure'; end if;
        return new;
      end $$`);
    await w.t.db.execute(sql`create trigger fail_waifu_acquired before insert on dungeon_run_events for each row execute function fail_waifu_acquired()`);
    try {
      await expect(act(playerId, run, { type: 'capture' })).rejects.toThrow(/forced late failure/);
    } finally {
      await w.t.db.execute(sql`drop trigger fail_waifu_acquired on dungeon_run_events`);
      await w.t.db.execute(sql`drop function fail_waifu_acquired()`);
    }
    // Charm, copy, XP, quests, ledger, run state and history: none of it happened.
    expect(await worldOf(playerId, run.id)).toEqual(before);

    const retry = await act(playerId, run, { type: 'capture' });
    expect(retry.encounterReceipts![0]).toMatchObject({ success: true });
    const rare = await speciesRow(RARE);
    const [copy] = (await copies(playerId)).filter((c) => c.speciesId === rare.id);
    expect(copy!.baseSp).toBe(expectedBaseSp('SR', seed));
    expect((await instance(run.id)).attempts).toEqual([expect.objectContaining({ n: 1, roll: attemptRoll(seed, 1) })]);
    expect(await held(playerId, CONTRACT)).toBe(0);
    expect(await ledger(playerId)).toHaveLength(1);
  });

  it('an ordinary failed attempt is retried deterministically after a rollback too', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 2);
    const quote = await w.app.capture.quoteSpecies(w.t.db, playerId, await speciesRow(COMMON), await getItemBySlug(w.t.db, CHARM));
    const seed = seedWhere((roll) => roll >= quote.chance);
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    await w.t.db.execute(sql`
      create function fail_attempt() returns trigger language plpgsql as $$
      begin
        if new.type = 'capture_attempted' then raise exception 'forced late failure'; end if;
        return new;
      end $$`);
    await w.t.db.execute(sql`create trigger fail_attempt before insert on dungeon_run_events for each row execute function fail_attempt()`);
    try {
      await expect(act(playerId, run, { type: 'capture' })).rejects.toThrow(/forced late failure/);
    } finally {
      await w.t.db.execute(sql`drop trigger fail_attempt on dungeon_run_events`);
      await w.t.db.execute(sql`drop function fail_attempt()`);
    }
    expect(await held(playerId, CHARM)).toBe(2);
    expect((await instance(run.id)).attempts).toEqual([]);
    const retry = await act(playerId, run, { type: 'capture' });
    expect(retry.encounterReceipts![0]).toMatchObject({ success: false, roll: attemptRoll(seed, 1) });
    expect(await held(playerId, CHARM)).toBe(1);
    expect((await instance(run.id)).attempts).toHaveLength(1);
  });

  it('concurrent duplicate presses resolve once: one charm, one attempt, one copy', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 3);
    let run = await w.runs.start(playerId, definition.key);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    const restarted = w.restartedRuns();
    const press = (runs = w.runs) => runs.act(playerId, run.id, { type: 'capture', expectedStep: run.step });
    const results = await Promise.all([press(), press(restarted), press(), press(restarted)]);
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'refused', 'refused', 'refused']);
    expect(results.filter((r) => r.refusal === 'stale')).toHaveLength(3);
    expect(await held(playerId, CONTRACT)).toBe(2);
    const common = await speciesRow(COMMON);
    expect((await copies(playerId)).filter((c) => c.speciesId === common.id)).toHaveLength(1);
    expect(await ledger(playerId)).toHaveLength(1);
    expect((await instance(run.id)).attempts).toHaveLength(1);
    expect((await history(run.id)).filter((t) => t === 'waifu_acquired')).toHaveLength(1);
  });

  it('dungeon captures racing ordinary hunts for the same player never deadlock or lose a write', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 30);
    const quote = await w.app.capture.quoteSpecies(w.t.db, playerId, await speciesRow(COMMON), await getItemBySlug(w.t.db, CHARM));
    const seed = seedWhere((roll) => roll >= quote.chance);
    let races = 0;
    let hunts = 0;
    for (let day = 0; day < 3; day += 1) {
      w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
      let run = await w.runs.start(playerId, definition.key, { seed });
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      // Three failing attempts per run: each one races a real hunt.
      while (run.core.action?.encounter) {
        await w.t.db.delete(encounters).where(eq(encounters.playerId, playerId));
        await w.t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
        await w.t.db.update(playerCurrencies).set({ huntEnergy: 25 }).where(eq(playerCurrencies.playerId, playerId));
        const [hunt, step] = await Promise.allSettled([
          w.app.hunt.hunt(playerId, 'chan-race'),
          act(playerId, run, { type: 'capture' }),
        ]);
        if (hunt.status === 'rejected') throw hunt.reason;
        if (step.status === 'rejected') throw step.reason;
        expect(step.value.status).toBe('applied');
        hunts += 1;
        races += 1;
        run = step.value.run;
      }
      if (run.status === 'active') await act(playerId, run, { type: 'abandon' });
    }
    expect(races).toBe(9);
    expect(hunts).toBe(9);
    // Every attempt spent exactly one charm, whatever the hunts dropped alongside.
    expect((await xpEvents(playerId)).filter((e) => e.eventType === 'capture_failed')).toHaveLength(9);
  });

  it('a dungeon capture racing a hunted capture for the same player keeps both consistent', async () => {
    const definition = await publishEncounter(wild(COMMON));
    const { playerId } = await w.player();
    await give(playerId, CHARM, 20);
    const quote = await w.app.capture.quoteSpecies(w.t.db, playerId, await speciesRow(COMMON), await getItemBySlug(w.t.db, CHARM));
    const seed = seedWhere((roll) => roll >= quote.chance);
    w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    let dungeonAttempts = 0;
    let hunted = 0;
    while (run.core.action?.encounter) {
      // Close whatever the last hunted capture left open, so the next spawn is not blocked.
      await w.t.db.update(encounters).set({ state: 'expired', resolvedAt: new Date() })
        .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
      const spawn = await w.app.wildEncounters.createWildEncounter({
        playerId, channelId: 'chan-race', regionId: 'waifu-valley', playerLevel: 1,
        speciesSlug: OTHER, origin: { kind: 'quest', ref: `race-${run.step}` },
      });
      if (spawn.status !== 'created') throw new Error(`spawn was ${spawn.status}`);
      const before = await held(playerId, CHARM);
      const [capture, step] = await Promise.allSettled([
        w.app.capture.attemptCapture(playerId, spawn.encounter.id, CHARM),
        act(playerId, run, { type: 'capture' }),
      ]);
      // Both paths take the player row before the charm row, so they queue on
      // it and both commit (tests/integration/captureConcurrency.test.ts).
      if (capture.status === 'rejected') throw capture.reason;
      if (step.status === 'rejected') throw step.reason;
      expect(step.value.status).toBe('applied');
      dungeonAttempts += 1;
      hunted += 1;
      // Whichever way the hunted capture went, a charm left only with an attempt.
      expect(await held(playerId, CHARM)).toBe(before - 2);
      run = step.value.run;
    }
    expect(dungeonAttempts).toBe(3);
    expect((await instance(run.id)).attempts).toHaveLength(3);
    expect(hunted).toBe(3);
  });
});

describe('exclusive species stay out of the wild', () => {
  /** Run `body` in a transaction that is always rolled back, so catalogue edits never leak. */
  async function scratch(body: (tx: Parameters<Parameters<typeof w.t.db.transaction>[0]>[0]) => Promise<void>): Promise<void> {
    const rollback = new Error('rollback');
    await w.t.db.transaction(async (tx) => {
      await body(tx);
      throw rollback;
    }).catch((err) => {
      if (err !== rollback) throw err;
    });
  }

  it('no hunt tier reaches a dungeon-exclusive species: pools, global fallback or emergency', async () => {
    const { playerId } = await w.player();
    const exclusive = await speciesRow(COMMON);
    await scratch(async (tx) => {
      await tx.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.id, exclusive.id));
      // Still listed in a pool, as a stale row would be.
      for (let i = 0; i < 300; i += 1) {
        const picked = await w.app.hunt.pickSpeciesForSpawn(tx, playerId, 1, 'waifu-valley');
        expect(picked?.slug).not.toBe(COMMON);
      }
      // No pools at all: the region-blind fallbacks.
      await tx.delete(regionEncounterPools);
      for (let i = 0; i < 100; i += 1) {
        const picked = await w.app.hunt.pickSpeciesForSpawn(tx, playerId, 1, 'waifu-valley');
        expect(picked).not.toBeNull();
        expect(picked!.slug).not.toBe(COMMON);
      }
      // Nobody else left: the emergency finds no one rather than her.
      await tx.update(species).set({ enabled: false }).where(sql`${species.id} <> ${exclusive.id}`);
      expect(await w.app.hunt.pickSpeciesForSpawn(tx, playerId, 1, 'waifu-valley')).toBeNull();
    });
  });

  it('a scripted spawn cannot name her, and an ordinary one still works', async () => {
    const { playerId } = await w.player();
    const exclusive = await speciesRow(COMMON);
    const spawn = (speciesSlug: string, ref: string) =>
      w.app.wildEncounters.createWildEncounter({
        playerId, channelId: 'c-1', regionId: 'waifu-valley', playerLevel: 1, speciesSlug, origin: { kind: 'quest', ref },
      });
    await w.t.db.update(species).set({ tags: ['dungeon_exclusive'] }).where(eq(species.id, exclusive.id));
    try {
      expect(await spawn(COMMON, 'excl-1')).toEqual({ status: 'unavailable', reason: 'unknown_species' });
      expect(await w.t.db.select().from(encounters).where(eq(encounters.playerId, playerId))).toEqual([]);
      expect((await spawn(OTHER, 'excl-2')).status).toBe('created');
    } finally {
      await w.t.db.update(species).set({ tags: exclusive.tags }).where(eq(species.id, exclusive.id));
    }
  });
});

describe('runs without encounters', () => {
  it('store no encounter state and play exactly as before', async () => {
    const published = await w.publish();
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, published.dungeon.key);
    const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    expect(row!.encounterStates).toEqual({});
    expect(run.fighter.captureBuddy).toBeDefined();
    const next = await act(playerId, run, { type: 'advance' });
    expect(next.status).toBe('applied');
    expect(next.encounterReceipts).toBeUndefined();
    const events = await w.t.db.select({ type: dungeonRunEvents.type }).from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, run.id));
    expect(events.some((e) => ['encounter_selected', 'capture_attempted', 'waifu_acquired'].includes(e.type))).toBe(false);
  });
});
