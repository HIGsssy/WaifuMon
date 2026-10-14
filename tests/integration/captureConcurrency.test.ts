/**
 * Phase 4B2C — hunts, hunted captures and dungeon captures for one player, at
 * once, against real PostgreSQL.
 *
 * The three paths write the same player's charms, effects, copies, XP and
 * quests. Each takes that player's row before any of them (a hunt and a
 * dungeon capture after `player_currencies`), so they queue rather than hold
 * each other's later locks. Every race here is repeated, and asserts three
 * things: nothing was rejected as a deadlock victim, no dungeon step had to be
 * retried, and the books balance — one charm per attempt, one copy per grant.
 */
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dungeonRuns,
  dungeonSpeciesAcquisitions,
  encounters,
  captureAttempts,
  playerCurrencies,
  playerInventory,
  players,
  playerWaifus,
  species,
} from '../../src/db/schema';
import type { DungeonDefinition } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonActionResult, DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import type { DungeonInput } from '../../src/modules/dungeons/engine/types';
import {
  ActiveEncounterError,
  DungeonCaptureItemUnavailableError,
  InsufficientItemsError,
  isDeadlockError,
} from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug } from '../helpers/fixtures';

const COMMON = 'neko_barista'; // N
const OTHER = 'gym_oni'; // N
const CHARM = 'basic_charm';
const CONTRACT = 'mythic_contract'; // guaranteed
const ROOM = 'hall';
const ACTION = 'meet';
const CHANNEL = 'chan-race';

let w: DungeonWorld;
let keySeq = 0;
/** Every time the run service reported a step rolled back as a deadlock victim. */
const stepDeadlocks: unknown[] = [];

beforeAll(async () => {
  w = await createDungeonWorld({
    logger: {
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (fields: unknown) => {
        if ((fields as { tag?: string })?.tag === 'dungeons/step-deadlock') stepDeadlocks.push(fields);
      },
    } as never,
  });
  await w.t.db.update(species).set({ affinity: 'switch' });
});
afterAll(async () => {
  await w.cleanup();
});
beforeEach(() => {
  stepDeadlocks.length = 0;
});

type Input = DungeonInput extends infer I ? (I extends unknown ? Omit<I, 'expectedStep'> : never) : never;
const act = (playerId: number, run: DungeonRunView, input: Input): Promise<DungeonActionResult> =>
  w.act(playerId, run, input as DungeonInput);

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
const copiesOf = async (playerId: number, slug: string) => {
  const [row] = await w.t.db.select().from(species).where(eq(species.slug, slug));
  return w.t.db.select().from(playerWaifus).where(and(eq(playerWaifus.playerId, playerId), eq(playerWaifus.speciesId, row!.id)));
};
const ledger = (playerId: number) =>
  w.t.db.select().from(dungeonSpeciesAcquisitions).where(eq(dungeonSpeciesAcquisitions.playerId, playerId)).orderBy(asc(dungeonSpeciesAcquisitions.id));
const huntedAttempts = (playerId: number) => w.t.db.select().from(captureAttempts).where(eq(captureAttempts.playerId, playerId));
const dungeonAttempts = async (runId: number) => {
  const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId));
  return ((row!.encounterStates as Record<string, { attempts: unknown[] }>)[`${ROOM}:${ACTION}`]?.attempts ?? []).length;
};

async function publish(
  actions: Record<string, unknown>[],
  patch: (input: Parameters<Parameters<typeof singleRoomDungeon>[1] & object>[0]) => void = () => {},
): Promise<DungeonDefinition> {
  const key = `race_${++keySeq}`;
  const definition = singleRoomDungeon(actions as never, (input) => {
    input.key = key;
    patch(input);
  });
  await w.publish(definition);
  return definition;
}
const wild = (slug: string, capture: Record<string, unknown> = {}) => ({
  id: ACTION, type: 'wild_encounter', source: { kind: 'species', species: slug }, intro: 'She appears.', capture,
});
const rescue = (slug: string) => ({ id: ACTION, type: 'rescue', mode: 'direct', source: { kind: 'species', species: slug }, intro: 'Free her.' });

/** A run seed whose first three capture rolls all miss the given chance. */
function missingSeed(chance: number): number {
  for (let seed = 1; seed < 100_000; seed += 1) {
    if ([1, 2, 3].every((n) => dungeonRngSource(seed).stream('encounter', ROOM, ACTION, 'attempt', n).next() >= chance)) return seed;
  }
  throw new Error('no seed found');
}
async function charmChance(playerId: number): Promise<number> {
  const [row] = await w.t.db.select().from(species).where(eq(species.slug, COMMON));
  return (await w.app.capture.quoteSpecies(w.t.db, playerId, row!, await getItemBySlug(w.t.db, CHARM))).chance;
}

const nextDay = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
};
/** A hunt may start: energy, no cooldown, and no encounter in the way. */
async function readyToHunt(playerId: number): Promise<void> {
  await w.t.db.update(encounters).set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  await w.t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
  await w.t.db.update(playerCurrencies).set({ huntEnergy: 25 }).where(eq(playerCurrencies.playerId, playerId));
}
async function spawn(playerId: number, ref: string) {
  await w.t.db.update(encounters).set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const made = await w.app.wildEncounters.createWildEncounter({
    playerId, channelId: CHANNEL, regionId: 'waifu-valley', playerLevel: 1, speciesSlug: OTHER, origin: { kind: 'quest', ref },
  });
  if (made.status !== 'created') throw new Error(`spawn was ${made.status}`);
  return made.encounter;
}

/** No path lost to a deadlock, and no dungeon step had to be run twice. */
function expectNoDeadlock(settled: PromiseSettledResult<unknown>[]): void {
  for (const result of settled) {
    if (result.status === 'rejected') expect(isDeadlockError(result.reason), String(result.reason)).toBe(false);
  }
  expect(stepDeadlocks).toEqual([]);
}
function value(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
const stepOf = (result: PromiseSettledResult<unknown>) => value(result) as DungeonActionResult;

describe('hunt versus hunted capture (#0111)', () => {
  it('never deadlocks: the hunt and the capture queue on the player row', async () => {
    const { playerId } = await w.player();
    await give(playerId, CHARM, 40);
    let captures = 0;
    let hunts = 0;
    for (let i = 0; i < 20; i += 1) {
      await readyToHunt(playerId);
      const encounter = await spawn(playerId, `hunt-vs-capture-${i}`);
      const before = await held(playerId, CHARM);
      // Alternate who is issued first, so both interleavings are exercised.
      const capture = () => w.app.capture.attemptCapture(playerId, encounter.id, CHARM);
      const hunt = () => w.app.hunt.hunt(playerId, CHANNEL);
      const settled = await Promise.allSettled(i % 2 === 0 ? [capture(), hunt()] : [hunt(), capture()]);
      expectNoDeadlock(settled);
      const [c, h] = i % 2 === 0 ? settled : [settled[1]!, settled[0]!];
      // The capture always resolves; the hunt runs, or is refused by the encounter still standing.
      value(c!);
      captures += 1;
      if (h!.status === 'fulfilled') hunts += 1;
      else expect(h!.reason).toBeInstanceOf(ActiveEncounterError);
      // One charm for the one attempt; a hunt may add charms of its own, never remove one.
      expect(await held(playerId, CHARM)).toBeGreaterThanOrEqual(before - 1);
    }
    expect(captures).toBe(20);
    expect((await huntedAttempts(playerId)).length).toBe(20);
    expect(hunts).toBeGreaterThan(0);
  });
});

describe('hunt versus dungeon capture', () => {
  it('never deadlocks across failed attempts', async () => {
    const definition = await publish([wild(COMMON)]);
    const { playerId } = await w.player();
    await give(playerId, CHARM, 40);
    const seed = missingSeed(await charmChance(playerId));
    let races = 0;
    for (let day = 0; day < 4; day += 1) {
      nextDay();
      let run = await w.runs.start(playerId, definition.key, { seed });
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      while (run.core.action?.encounter) {
        await readyToHunt(playerId);
        const settled = await Promise.allSettled([w.app.hunt.hunt(playerId, CHANNEL), act(playerId, run, { type: 'capture' })]);
        expectNoDeadlock(settled);
        value(settled[0]!);
        const step = stepOf(settled[1]!);
        expect(step.status).toBe('applied');
        races += 1;
        run = step.run;
      }
      expect(await dungeonAttempts(run.id)).toBe(3);
      if (run.status === 'active') await act(playerId, run, { type: 'abandon' });
    }
    expect(races).toBe(12);
  });

  it('never deadlocks when the capture ends and settles the run in the same step', async () => {
    // The encounter is the last thing in an exit room, so a capture completes
    // the run: settlement and its banking ride in the capture step.
    const definition = await publish([wild(COMMON)], (input) => {
      input.rooms = [{ id: ROOM, name: 'Hall', kind: 'exit', actions: input.rooms[0]!.actions }];
      input.connections = [];
    });
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 12);
    let races = 0;
    for (let day = 0; day < 4; day += 1) {
      nextDay();
      for (let n = 0; n < 3; n += 1) {
        let run = await w.runs.start(playerId, definition.key);
        run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
        await readyToHunt(playerId);
        const settled = await Promise.allSettled([w.app.hunt.hunt(playerId, CHANNEL), act(playerId, run, { type: 'capture' })]);
        expectNoDeadlock(settled);
        value(settled[0]!);
        const step = stepOf(settled[1]!);
        expect(step.status).toBe('applied');
        expect(step.run.status).toBe('completed');
        races += 1;
      }
    }
    expect(races).toBe(12);
    expect(await ledger(playerId)).toHaveLength(12);
    expect(await held(playerId, CONTRACT)).toBe(0);
  });

  it('takes the currency row before the player row, as a hunt does', async () => {
    // A settlement can bank WaifuBux, and a hunt holds `player_currencies`
    // before `players`. Had the step taken the player row first, a hunt queued
    // behind it would hold the one row the step still needs.
    const definition = await publish([wild(COMMON)]);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 1);
    nextDay();
    let run = await w.runs.start(playerId, definition.key);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    const rival = await w.t.pool.connect();
    try {
      await rival.query('begin');
      await rival.query('select 1 from player_currencies where player_id = $1 for update', [playerId]);
      const step = act(playerId, run, { type: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The step is queued on the currency row and holds no player lock yet.
      await rival.query('select 1 from players where id = $1 for update nowait', [playerId]);
      await rival.query('commit');
      expect((await step).status).toBe('applied');
      expect(stepDeadlocks).toEqual([]);
    } finally {
      rival.release();
    }
  });
});

describe('hunted capture versus dungeon capture', () => {
  it('never deadlocks on the same charm: both commit, each spending exactly one', async () => {
    const definition = await publish([wild(COMMON)]);
    const { playerId } = await w.player();
    await give(playerId, CHARM, 60);
    const seed = missingSeed(await charmChance(playerId));
    let races = 0;
    for (let day = 0; day < 5; day += 1) {
      nextDay();
      let run = await w.runs.start(playerId, definition.key, { seed });
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      while (run.core.action?.encounter) {
        const encounter = await spawn(playerId, `capture-vs-dungeon-${day}-${run.step}`);
        const before = await held(playerId, CHARM);
        const capture = () => w.app.capture.attemptCapture(playerId, encounter.id, CHARM);
        const step = () => act(playerId, run, { type: 'capture' });
        const flip = races % 2 === 1;
        const settled = await Promise.allSettled(flip ? [step(), capture()] : [capture(), step()]);
        expectNoDeadlock(settled);
        const [c, s] = flip ? [settled[1]!, settled[0]!] : settled;
        value(c!);
        expect(stepOf(s!).status).toBe('applied');
        expect(await held(playerId, CHARM)).toBe(before - 2);
        races += 1;
        run = stepOf(s!).run;
      }
      expect(await dungeonAttempts(run.id)).toBe(3);
      if (run.status === 'active') await act(playerId, run, { type: 'abandon' });
    }
    expect(races).toBe(15);
    expect((await huntedAttempts(playerId)).length).toBe(15);
  });

  it('never deadlocks with a Microdose both attempts spend a charge of', async () => {
    const definition = await publish([wild(COMMON)]);
    const { playerId } = await w.player();
    await give(playerId, CHARM, 20);
    const base = await charmChance(playerId);
    const seed = missingSeed(base + 0.1);
    nextDay();
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    let races = 0;
    while (run.core.action?.encounter) {
      await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 2 });
      const encounter = await spawn(playerId, `microdose-${run.step}`);
      const settled = await Promise.allSettled([
        w.app.capture.attemptCapture(playerId, encounter.id, CHARM),
        act(playerId, run, { type: 'capture' }),
      ]);
      // The dungeon step may find its quote stale — the hunted capture spent
      // a charge under it — and roll back; that is a refusal, not a deadlock.
      expectNoDeadlock(settled);
      value(settled[0]!);
      const step = settled[1]!;
      if (step.status === 'fulfilled') {
        expect(step.value.status).toBe('applied');
        expect((await w.app.effects.getCaptureBonus(playerId)) ?? null).toBeNull();
        run = step.value.run;
        races += 1;
      } else {
        expect((step.reason as { code?: string }).code).toBe('DUNGEON_CAPTURE_QUOTE_CHANGED');
        // Rolled back whole: the retry is quoted afresh, and lands.
        expect((await w.app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(1);
        run = await w.runs.run(playerId, run.id);
      }
    }
    expect(races).toBe(3);
  });
});

describe('concurrent inventory consumption', () => {
  it('one last charm is spent once, by whichever capture reaches it first', async () => {
    const definition = await publish([wild(COMMON, { maxAttempts: 1 })]);
    const { playerId } = await w.player();
    let dungeonWon = 0;
    for (let i = 0; i < 12; i += 1) {
      if (i % 3 === 0) nextDay();
      await w.t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
      await give(playerId, CHARM, 2);
      let run = await w.runs.start(playerId, definition.key, { seed: missingSeed(await charmChance(playerId)) });
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      const encounter = await spawn(playerId, `last-charm-${i}`);
      // Down to one, after the dungeon selected it and the hunted encounter exists.
      await w.app.inventory.consumeItem(w.t.db, playerId, (await getItemBySlug(w.t.db, CHARM)).id, 1);
      const huntedBefore = (await huntedAttempts(playerId)).length;
      const settled = await Promise.allSettled([
        w.app.capture.attemptCapture(playerId, encounter.id, CHARM),
        act(playerId, run, { type: 'capture' }),
      ]);
      expectNoDeadlock(settled);
      const [hunted, step] = settled;
      const huntedSpent = hunted!.status === 'fulfilled';
      const dungeonSpent = step!.status === 'fulfilled' && step!.value.status === 'applied';
      // Exactly one of them got the charm; the other was refused cleanly.
      expect([huntedSpent, dungeonSpent].filter(Boolean)).toHaveLength(1);
      if (!huntedSpent) expect((hunted as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientItemsError);
      if (!dungeonSpent) {
        if (step!.status === 'fulfilled') expect(step!.value.refusal).toBe('capture_item_unavailable');
        else expect(step!.reason).toBeInstanceOf(DungeonCaptureItemUnavailableError);
      } else dungeonWon += 1;
      expect(await held(playerId, CHARM)).toBe(0);
      expect((await huntedAttempts(playerId)).length - huntedBefore).toBe(huntedSpent ? 1 : 0);
      expect(await dungeonAttempts(run.id)).toBe(dungeonSpent ? 1 : 0);
      const current = await w.runs.run(playerId, run.id);
      if (current.status === 'active') await act(playerId, current, { type: 'abandon' });
    }
    expect(dungeonWon).toBeGreaterThanOrEqual(0);
  });
});

describe('simultaneous dungeon presses', () => {
  it('two capture presses on one step resolve once, under a limit of one, every time', async () => {
    w.speciesAccess.set(COMMON, [{ dungeon: `race_${keySeq + 1}`, perPlayerLimit: 1 }]);
    try {
      const definition = await publish([wild(COMMON)]);
      for (let i = 0; i < 8; i += 1) {
        const { playerId } = await w.player();
        await give(playerId, CONTRACT, 2);
        let run = await w.runs.start(playerId, definition.key);
        run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
        const other = w.restartedRuns();
        const press = (runs = w.runs) => runs.act(playerId, run.id, { type: 'capture', expectedStep: run.step });
        const settled = await Promise.allSettled([press(), press(other), press()]);
        expectNoDeadlock(settled);
        const results = settled.map((r) => stepOf(r));
        expect(results.map((r) => r.status).sort()).toEqual(['applied', 'refused', 'refused']);
        expect(results.filter((r) => r.refusal === 'stale')).toHaveLength(2);
        expect(await held(playerId, CONTRACT)).toBe(1);
        expect(await copiesOf(playerId, COMMON)).toHaveLength(1);
        expect(await ledger(playerId)).toHaveLength(1);
      }
    } finally {
      w.speciesAccess.delete(COMMON);
    }
  });

  it('two rescue presses grant one copy and one ledger row, every time', async () => {
    w.speciesAccess.set(OTHER, [{ dungeon: `race_${keySeq + 1}`, directRescue: true, perPlayerLimit: 1 }]);
    try {
      const definition = await publish([rescue(OTHER)]);
      for (let i = 0; i < 8; i += 1) {
        const { playerId } = await w.player();
        const run = await w.runs.start(playerId, definition.key);
        const other = w.restartedRuns();
        const press = (runs = w.runs) => runs.act(playerId, run.id, { type: 'rescue', expectedStep: run.step });
        const settled = await Promise.allSettled([press(), press(other), press()]);
        expectNoDeadlock(settled);
        const results = settled.map((r) => stepOf(r));
        expect(results.filter((r) => r.status === 'applied')).toHaveLength(1);
        expect(await copiesOf(playerId, OTHER)).toHaveLength(1);
        const rows = await ledger(playerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ mode: 'rescue_direct', grantKey: `dungeon:${run.id}:${ROOM}:${ACTION}` });
      }
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });
});

describe('a step chosen as a deadlock victim', () => {
  it('is rolled back whole and run again: one attempt, one charm, the same roll', async () => {
    const definition = await publish([wild(COMMON)]);
    const { playerId } = await w.player();
    await give(playerId, CHARM, 3);
    const seed = missingSeed(await charmChance(playerId));
    nextDay();
    let run = await w.runs.start(playerId, definition.key, { seed });
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    const charm = await getItemBySlug(w.t.db, CHARM);

    // A transaction of the kind the three ordered paths never open: it holds
    // the charm row, then asks for the player row. The step holds the player
    // row and asks for the charm row. Postgres must abort one.
    const rival = await w.t.pool.connect();
    try {
      await rival.query('begin');
      await rival.query('select 1 from player_inventory where player_id = $1 and item_id = $2 for update', [playerId, charm.id]);
      const step = act(playerId, run, { type: 'capture' });
      // Let the step take its player locks and block on the charm.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rivalLock = rival.query('select 1 from players where id = $1 for update', [playerId])
        .then(() => 'granted' as const, (err: unknown) => (isDeadlockError(err) ? ('victim' as const) : Promise.reject(err)));
      const rivalOutcome = await rivalLock;
      await rival.query(rivalOutcome === 'granted' ? 'commit' : 'rollback');
      const result = await step;

      expect(result.status).toBe('applied');
      // Whichever side Postgres aborted, the step landed exactly once.
      expect(stepDeadlocks.length).toBe(rivalOutcome === 'granted' ? 1 : 0);
      expect(await held(playerId, CHARM)).toBe(2);
      expect(await dungeonAttempts(run.id)).toBe(1);
      expect(result.encounterReceipts![0]).toMatchObject({
        success: false,
        roll: dungeonRngSource(seed).stream('encounter', ROOM, ACTION, 'attempt', 1).next(),
      });
    } finally {
      rival.release();
    }
  });
});
