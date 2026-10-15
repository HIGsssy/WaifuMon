import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dungeonRuns,
  dungeonSpeciesAcquisitions,
  playerDailyQuests,
  playerWaifus,
  species,
} from '../../src/db/schema';
import { dungeonRunSceneArtwork } from '../../src/discord/dungeonArtwork';
import type { AppContext } from '../../src/discord/types';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import { describeSpeciesAuthoring } from '../../src/modules/dungeons/engine/speciesAuthoring';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import type { DungeonInput, DungeonRunState } from '../../src/modules/dungeons/engine/types';
import { createSceneSpriteService } from '../../src/modules/dungeons/sceneSprites/sceneSpriteService';
import {
  COMMON,
  RARE,
  FINITE,
  UNLIMITED,
  CHARM,
  CONTRACT,
  attemptRoll,
  captureLifecycleDungeon,
  findSeed,
  installExclusiveSpecies,
  namedEncounter,
  poolRoll,
  weightedDungeon,
} from '../helpers/dungeonCaptureFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { getItemBySlug } from '../helpers/fixtures';
import { BLUE, GREEN, RED, solidImage, transparentSprite } from '../helpers/imageFixtures';

let w: DungeonWorld;
beforeAll(async () => {
  w = await createDungeonWorld();
  await w.t.db.update(species).set({ affinity: 'switch' });
  await installExclusiveSpecies(w);
});
afterAll(async () => {
  await w?.cleanup();
});
const act = (playerId: number, run: DungeonRunView, input: DungeonInput) =>
  w.act(playerId, run, input);
const rowOf = async (id: number) =>
  (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, id)))[0]!;
const give = async (playerId: number, slug: string, quantity: number) =>
  w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, slug)).id, quantity);
const held = async (playerId: number, slug: string) =>
  w.app.inventory.getQuantity(playerId, (await getItemBySlug(w.t.db, slug)).id);
const ledger = (playerId: number) =>
  w.t.db
    .select()
    .from(dungeonSpeciesAcquisitions)
    .where(eq(dungeonSpeciesAcquisitions.playerId, playerId));
const offered = (run: DungeonRunView) => {
  if (!run.core.action?.encounter) throw new Error(`no encounter in run ${run.id}`);
  return run.core.action.encounter;
};
async function quests(playerId: number) {
  await w.t.db.insert(playerDailyQuests).values(
    ['capture_attempts', 'capture_success'].map((type) => ({
      playerId,
      questDate: new Date().toISOString().slice(0, 10),
      questSlug: `p4d2_${type}`,
      titleSnapshot: type,
      descriptionSnapshot: type,
      type,
      target: 99,
      progress: 0,
      rewardsJson: {},
    })),
  );
}
/** Exact rows, including run timestamps, economy, dex, appearance unlocks and quest audit. */
async function playerState(playerId: number) {
  const result: Record<string, unknown> = {};
  for (const table of [
    'players',
    'player_inventory',
    'player_active_effects',
    'player_waifus',
    'player_progression_events',
    'player_daily_quests',
    'dungeon_species_acquisitions',
    'dungeon_runs',
    'dungeon_run_events',
    'player_currencies',
  ]) {
    const column = table === 'players' ? 'id' : 'player_id';
    result[table] = (
      await w.t.pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM "${table}" t WHERE "${column}"=$1`,
        [playerId],
      )
    ).rows[0].rows;
  }
  return result;
}

describe('integrated creator → real gameplay lifecycle', () => {
  it.each(['complete', 'extract'] as const)(
    'repairs, captures, fights the boss, rescues, takes treasure and %ss once',
    async (end) => {
      const d = captureLifecycleDungeon(`p4d2_${end}`);
      w.speciesAccess.set(FINITE, [
        ...(w.speciesAccess.get(FINITE) ?? []),
        { dungeon: d.key, directRescue: true, perPlayerLimit: 1 },
      ]);
      const created = await w.content.create({ definition: namedEncounter(d.key) }, 'creator');
      const saved = await w.content.saveDraft(
        d.key,
        { expectedRevision: created.draftRevision, definition: d },
        'creator',
      );
      expect((await w.content.validate(d)).issues.filter((i) => i.severity === 'error')).toEqual(
        [],
      );
      const publication = await w.content.publish(
        d.key,
        { expectedRevision: saved.draftRevision },
        'creator',
      );
      await w.content.setEnabled(d.key, true, 'creator');
      expect((await w.content.get(d.key))!.draft).toEqual(d);
      const { playerId, buddyId } = await w.player();
      await quests(playerId);
      await give(playerId, CHARM, 2);
      await give(playerId, CONTRACT, 1);
      await w.app.effects.grantCaptureBonus(w.t.db, playerId, {
        sourceItemSlug: 'microdose',
        modifier: 0.1,
        charges: 1,
      });
      const seed = findSeed((s) => poolRoll(s, 10) < 4 && attemptRoll(s) < 0.1);
      let run = await w.runs.start(playerId, d.key, { seed });
      expect(run.fighter.waifuId).toBe(buddyId);
      run = (await act(playerId, run, { type: 'choose', choiceId: 'repair' })).run;
      expect(run.core.flags).toMatchObject({ signal_on: true });
      expect(offered(run)).toMatchObject({ species: COMMON, available: true, selectedItem: null });
      const quote = offered(run).items.find((i) => i.item === CHARM)!;
      expect(quote.chance).toBeGreaterThan(0.1);
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      expect(await held(playerId, CHARM)).toBe(2);
      const stale = run;
      const caught = await act(playerId, run, { type: 'capture' });
      expect(caught.encounterReceipts).toMatchObject([
        {
          success: true,
          chance: quote.chance,
          roll: attemptRoll(seed),
          microdose: { chargesRemaining: 0 },
        },
      ]);
      run = caught.run;
      expect(run.core.flags).toMatchObject({ caught: true });
      expect(run.core.recent).toContainEqual(expect.objectContaining({ text: 'She trusts you.' }));
      expect(run.core.action!.id).toBe('repair_rescue');
      expect(
        ((await rowOf(run.id)).roomStates as DungeonRunState['rooms']).hall!.actions.decoy,
      ).toBeUndefined();
      expect(await held(playerId, CHARM)).toBe(1);
      expect(await w.app.effects.getCaptureBonus(playerId)).toBeNull();
      const committed = await playerState(playerId);
      expect((await act(playerId, stale, { type: 'capture' })).refusal).toBe('stale');
      expect(await playerState(playerId)).toEqual(committed);
      expect((await w.restartedRuns().run(playerId, run.id)).core.action).toEqual(run.core.action);
      run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
      const rescued = await act(playerId, run, { type: 'capture' });
      expect(rescued.encounterReceipts).toMatchObject([
        { success: true, mode: 'rescue', acquired: { speciesSlug: RARE } },
      ]);
      run = (await act(playerId, rescued.run, { type: 'move', connectionId: 'to_boss' })).run;
      expect(run.enemy).not.toBeNull();
      expect(run.core.flags.warden_down).toBeUndefined();
      while (run.core.action?.type === 'boss')
        run = (await act(playerId, run, { type: 'advance' })).run;
      expect(run.core.flags.warden_down).toBe(true);
      expect(
        ((await rowOf(run.id)).roomStates as DungeonRunState['rooms']).boss_room!.completed,
      ).toBe(true);
      run = (await act(playerId, run, { type: 'move', connectionId: 'to_cell' })).run;
      expect(offered(run)).toMatchObject({
        species: FINITE,
        mode: 'direct',
        items: [],
        available: true,
      });
      const freed = await act(playerId, run, { type: 'rescue' });
      expect(freed.encounterReceipts).toMatchObject([
        { type: 'rescue_grant', replayed: false, acquired: { speciesSlug: FINITE } },
      ]);
      run = (await act(playerId, freed.run, { type: 'advance' })).run;
      expect(run.core.unbankedCurrency).toBe(7);
      const terminal = await act(
        playerId,
        run,
        end === 'extract' ? { type: 'extract' } : { type: 'move', connectionId: 'to_exit' },
      );
      expect(terminal.run.status).toBe(end === 'extract' ? 'extracted' : 'completed');
      expect(terminal.run.settlement).toMatchObject({ earned: 7, banked: 7, lost: 0 });
      expect(await w.balance(playerId)).toBe(7);
      expect((await ledger(playerId)).map((r) => r.mode).sort()).toEqual([
        'capture',
        'rescue_capture',
        'rescue_direct',
      ]);
      const acquired = await w.t.db
        .select()
        .from(playerWaifus)
        .where(eq(playerWaifus.playerId, playerId));
      expect(acquired).toHaveLength(4); // pinned Buddy plus three grants
      expect(acquired.filter((c) => c.grantKey?.startsWith(`dungeon:${run.id}:`))).toHaveLength(3);
      expect(
        (
          await w.t.db
            .select()
            .from(playerDailyQuests)
            .where(eq(playerDailyQuests.playerId, playerId))
        ).map((q) => q.progress),
      ).toEqual([2, 2]);
      expect(await held(playerId, CONTRACT)).toBe(0);
      const history = await w.runs.history(run.id);
      expect(history.filter((e) => e.type === 'waifu_acquired')).toHaveLength(3);
      expect(history.filter((e) => e.type === 'capture_attempted')).toHaveLength(2);
      expect(history.some((e) => e.type === 'combat_wave_resolved')).toBe(true);
      expect((await rowOf(run.id)).revisionId).toBe(publication.revision.revisionId);
      const finalState = await playerState(playerId);
      expect((await act(playerId, terminal.run, { type: 'extract' })).refusal).toBe('run_over');
      expect(await playerState(playerId)).toEqual(finalState);
    },
  );

  it('does not unlock a repair rescue after event refusal; failed capture and declined direct rescue grant nothing', async () => {
    const d = captureLifecycleDungeon('p4d2_refusal');
    w.speciesAccess.set(FINITE, [{ dungeon: d.key, directRescue: true, perPlayerLimit: 1 }]);
    const meet = d.rooms[0]!.actions[1]!;
    if (meet.type !== 'wild_encounter') throw new Error('fixture');
    meet.capture.maxAttempts = 1;
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CHARM, 1);
    const seed = findSeed((s) => poolRoll(s, 8) < 4 && attemptRoll(s) > 0.9);
    let run = await w.runs.start(playerId, d.key, { seed });
    run = (await act(playerId, run, { type: 'choose', choiceId: 'refuse' })).run;
    run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
    const failed = await act(playerId, run, { type: 'capture' });
    expect(failed.encounterReceipts).toMatchObject([
      { success: false, outcome: 'escape', acquired: null },
    ]);
    run = failed.run;
    // Failed wild follows normal sequence; the decoy treasure requires its own press.
    run = (await act(playerId, run, { type: 'advance' })).run;
    expect((await rowOf(run.id)).encounterStates['hall:repair_rescue']).toBeUndefined();
    expect(await ledger(playerId)).toEqual([]);
    run = (await act(playerId, run, { type: 'move', connectionId: 'to_boss' })).run;
    while (run.core.action?.type === 'boss')
      run = (await act(playerId, run, { type: 'advance' })).run;
    run = (await act(playerId, run, { type: 'move', connectionId: 'to_cell' })).run;
    run = (await act(playerId, run, { type: 'leave_encounter' })).run;
    expect(await ledger(playerId)).toEqual([]);
    expect(
      await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId)),
    ).toHaveLength(1);
  });
});

describe('weighted selection, revision pinning and live availability', () => {
  it('matches server odds and exact weighted intervals; resumes without reroll and excludes once-per-run species', async () => {
    const d = weightedDungeon('p4d2_weighted');
    await w.publish(d);
    const insight = describeSpeciesAuthoring(d, await w.content.speciesCatalogue(d.key))
      .speciesPools[0]!.scenario;
    expect(insight.totalWeight).toBe(8);
    expect(insight.entries.map((e) => e.probability)).toEqual([4 / 8, 3 / 8, 0, 1 / 8]);
    for (const [lower, upper, slug] of [
      [0, 4, COMMON],
      [4, 7, RARE],
      [7, 8, null],
    ] as const) {
      const { playerId } = await w.player();
      const seed = findSeed((s) => poolRoll(s, 8) >= lower && poolRoll(s, 8) < upper);
      let run = await w.runs.start(playerId, d.key, { seed });
      const selected = (await rowOf(run.id)).encounterStates['hall:meet'];
      expect(selected).toMatchObject({
        species: slug,
        pool: { totalWeight: 8, roll: poolRoll(seed, 8), eligible: ['common', 'rare', 'nothing'] },
      });
      await w.restartedRuns().activeRun(playerId);
      expect((await rowOf(run.id)).encounterStates['hall:meet']).toEqual(selected);
      if (slug) run = (await act(playerId, run, { type: 'leave_encounter' })).run;
      else
        expect(run.core.recent).toContainEqual(
          expect.objectContaining({ text: 'Only rust and silence.', outcome: 'nothing' }),
        );
      const next = (await rowOf(run.id)).encounterStates['hall:again'] as {
        pool: { eligible: string[]; totalWeight: number };
      };
      expect(next.pool.eligible).toEqual(
        slug === COMMON
          ? ['rare', 'nothing']
          : slug === RARE
            ? ['common', 'nothing']
            : ['common', 'rare', 'nothing'],
      );
      expect(await ledger(playerId)).toEqual([]);
      expect((await rowOf(run.id)).encounterStates['hall:meet']).toEqual(
        slug ? expect.objectContaining({ species: slug, status: 'left' }) : selected,
      );
    }
  });

  it('pins old weights through republish and restart, keeps disabled weights, and reports historical active-run drift separately', async () => {
    const d = weightedDungeon('p4d2_pinned');
    await w.publish(d);
    const { playerId } = await w.player();
    const seed = findSeed((s) => poolRoll(s, 8) < 4);
    const old = await w.runs.start(playerId, d.key, { seed });
    const before = await rowOf(old.id);
    const changed = structuredClone(d);
    changed.speciesPools![0]!.entries = [
      { id: 'rare', species: RARE, weight: 1, oncePerRun: false },
    ];
    await w.republish(changed);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.slug, COMMON));
    try {
      expect(
        (await w.content.speciesDependencyStatus(d.key))!.map((s) => ({
          current: s.current,
          active: s.activeRuns,
          differs: s.differs,
        })),
      ).toEqual([
        { current: true, active: 0, differs: false },
        { current: false, active: 1, differs: true },
      ]);
      const current = await w.restartedRuns().run(playerId, old.id);
      expect(offered(current)).toMatchObject({ species: COMMON, available: false });
      expect((await rowOf(old.id)).encounterStates).toEqual(before.encounterStates);
      const odds = describeSpeciesAuthoring(d, await w.content.speciesCatalogue(d.key))
        .speciesPools[0]!.scenario;
      expect(odds.entries.map((e) => e.probability)).toEqual([4 / 8, 3 / 8, 0, 1 / 8]);
      expect(odds.unavailableProbability).toBe(4 / 8);
      const dismissed = await act(playerId, current, { type: 'dismiss_encounter' });
      expect(dismissed.encounterReceipts).toBeUndefined();
      expect((await rowOf(old.id)).encounterStates['hall:meet']).toMatchObject({
        status: 'unavailable',
        species: COMMON,
      });
      expect((await rowOf(old.id)).revisionId).toBe(before.revisionId);
      const fresh = await w.player();
      expect(offered(await w.runs.start(fresh.playerId, d.key, { seed })).species).toBe(RARE);
      expect(await ledger(playerId)).toEqual([]);
    } finally {
      await w.t.db.update(species).set({ enabled: true }).where(eq(species.slug, COMMON));
    }
  });
});

describe('explicit per-dungeon ledger scope', () => {
  it('rechecks a finite limit reached earlier in the same run without spending the next charm', async () => {
    const d = namedEncounter('p4d2_midrun_limit', FINITE);
    d.rooms[0]!.actions.push({ ...structuredClone(d.rooms[0]!.actions[0]!), id: 'second' });
    w.speciesAccess.set(FINITE, [{ dungeon: d.key, perPlayerLimit: 1 }]);
    await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 2);
    let run = await w.runs.start(playerId, d.key);
    run = (await act(playerId, run, { type: 'select_item', item: CONTRACT })).run;
    run = (await act(playerId, run, { type: 'capture' })).run;
    expect(run.core.action!.id).toBe('second');
    expect(offered(run)).toMatchObject({ available: false, unavailableReason: 'player_limit' });
    const blocked = await act(playerId, run, { type: 'capture' });
    expect(blocked.encounterReceipts).toBeUndefined();
    expect((await rowOf(run.id)).encounterStates['hall:second']).toMatchObject({
      status: 'unavailable',
      attempts: [],
    });
    expect(await held(playerId, CONTRACT)).toBe(1);
    expect(await ledger(playerId)).toHaveLength(1);
  });

  it('allows the same limited exclusive once in EACH authorized dungeon; unlimited and other players are independent', async () => {
    const a = namedEncounter('p4d2_limit_a', FINITE),
      b = namedEncounter('p4d2_limit_b', FINITE),
      open = namedEncounter('p4d2_open', UNLIMITED);
    w.speciesAccess.set(
      FINITE,
      [a, b].map((d) => ({ dungeon: d.key, perPlayerLimit: 1 })),
    );
    w.speciesAccess.set(UNLIMITED, [{ dungeon: open.key, perPlayerLimit: 'unlimited' }]);
    for (const d of [a, b, open]) await w.publish(d);
    const { playerId } = await w.player();
    await give(playerId, CONTRACT, 5);
    const captureAndExtract = async (id: number, key: string, available: boolean) => {
      w.clock.now = new Date(w.clock.now.getTime() + 86_400_000);
      let run = await w.runs.start(id, key);
      if (available) {
        expect(offered(run).available).toBe(true);
        run = (await act(id, run, { type: 'select_item', item: CONTRACT })).run;
        expect((await act(id, run, { type: 'dismiss_encounter' })).refusal).toBe(
          'encounter_available',
        );
        run = (await act(id, run, { type: 'capture' })).run;
      } else
        expect((await rowOf(run.id)).encounterStates['hall:meet']).toMatchObject({
          status: 'unavailable',
          unavailableReason: 'player_limit',
        });
      expect((await act(id, run, { type: 'extract' })).run.status).toBe('extracted');
    };
    await captureAndExtract(playerId, a.key, true);
    await captureAndExtract(playerId, a.key, false);
    await captureAndExtract(playerId, b.key, true);
    await captureAndExtract(playerId, open.key, true);
    await captureAndExtract(playerId, open.key, true);
    expect((await ledger(playerId)).map((r) => r.dungeonKey).sort()).toEqual(
      [a.key, b.key, open.key, open.key].sort(),
    );
    const other = await w.player();
    await give(other.playerId, CONTRACT, 1);
    await captureAndExtract(other.playerId, a.key, true);
    expect(await held(playerId, CONTRACT)).toBe(1);
  });
});

it('fails a repair-unlocked capture rescue without ownership, then refuses a direct rescue whose central authorization was revoked', async () => {
  const d = captureLifecycleDungeon('p4d2_rescue_failure');
  const rescue = d.rooms[0]!.actions.find((a) => a.id === 'repair_rescue')!;
  if (rescue.type !== 'rescue') throw new Error('fixture');
  rescue.capture!.maxAttempts = 1;
  w.speciesAccess.set(FINITE, [{ dungeon: d.key, directRescue: true, perPlayerLimit: 1 }]);
  await w.publish(d);
  const { playerId } = await w.player();
  let run = await w.runs.start(playerId, d.key);
  run = (await act(playerId, run, { type: 'choose', choiceId: 'repair' })).run;
  if (run.core.action?.type === 'wild_encounter')
    run = (await act(playerId, run, { type: 'leave_encounter' })).run;
  run = (await act(playerId, run, { type: 'advance' })).run;
  expect(run.core.action!.id).toBe('repair_rescue');
  expect((await act(playerId, run, { type: 'select_item', item: CHARM })).refusal).toBe(
    'capture_item_unavailable',
  );
  expect((await act(playerId, run, { type: 'capture' })).refusal).toBe('capture_item_required');
  // The seed is persisted before the run is started; select a deterministic failed rescue roll.
  await act(playerId, run, { type: 'abandon' });
  const seed = findSeed((s) => {
    // Same place-keyed stream as production, for the rescue rather than the wild activity.
    return (
      dungeonRngSource(s).stream('encounter', 'hall', 'repair_rescue', 'attempt', 1).next() > 0.99
    );
  });
  await give(playerId, CHARM, 1);
  run = await w.runs.start(playerId, d.key, { seed });
  run = (await act(playerId, run, { type: 'choose', choiceId: 'repair' })).run;
  if (run.core.action?.type === 'wild_encounter')
    run = (await act(playerId, run, { type: 'leave_encounter' })).run;
  run = (await act(playerId, run, { type: 'advance' })).run;
  run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
  const failed = await act(playerId, run, { type: 'capture' });
  expect(failed.encounterReceipts).toMatchObject([
    { mode: 'rescue', success: false, outcome: 'escape', acquired: null },
  ]);
  run = (await act(playerId, failed.run, { type: 'move', connectionId: 'to_boss' })).run;
  while (run.core.action?.type === 'boss')
    run = (await act(playerId, run, { type: 'advance' })).run;
  run = (await act(playerId, run, { type: 'move', connectionId: 'to_cell' })).run;
  expect(offered(run).available).toBe(true);
  w.speciesAccess.set(FINITE, [{ dungeon: d.key, directRescue: false, perPlayerLimit: 1 }]);
  const refused = await act(playerId, run, { type: 'rescue' });
  expect(refused.encounterReceipts).toBeUndefined();
  expect((await rowOf(run.id)).encounterStates['cell:free']).toMatchObject({
    status: 'unavailable',
  });
  expect(await ledger(playerId)).toEqual([]);
  expect(
    await w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId)),
  ).toHaveLength(1);
});

describe('real SQL rollback at each ownership boundary', () => {
  it.each(['player_waifus', 'dungeon_species_acquisitions', 'dungeon_run_events'] as const)(
    'rolls back %s failure, then concurrent retries commit the same ordinary roll once',
    async (table) => {
      const d = namedEncounter(`p4d2_rollback_${table}`);
      await w.publish(d);
      const { playerId } = await w.player();
      await quests(playerId);
      await give(playerId, CHARM, 2);
      await w.app.effects.grantCaptureBonus(w.t.db, playerId, {
        sourceItemSlug: 'microdose',
        modifier: 0.1,
        charges: 1,
      });
      const seed = findSeed((s) => attemptRoll(s) < 0.1);
      let run = await w.runs.start(playerId, d.key, { seed });
      run = (await act(playerId, run, { type: 'select_item', item: CHARM })).run;
      const before = await playerState(playerId);
      await w.t.pool.query(
        "CREATE FUNCTION p4d2_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'p4d2 forced rollback'; END $$",
      );
      await w.t.pool.query(
        `CREATE TRIGGER p4d2_reject BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION p4d2_reject()`,
      );
      try {
        await expect(act(playerId, run, { type: 'capture' })).rejects.toThrow(
          /p4d2 forced rollback/,
        );
        expect(await playerState(playerId)).toEqual(before);
      } finally {
        await w.t.pool.query(`DROP TRIGGER p4d2_reject ON ${table}`);
        await w.t.pool.query('DROP FUNCTION p4d2_reject()');
      }
      const retries = await Promise.all(
        [w.runs, w.restartedRuns()].map((s) =>
          s.act(playerId, run.id, { type: 'capture', expectedStep: run.step }),
        ),
      );
      expect(retries.map((r) => r.status).sort()).toEqual(['applied', 'refused']);
      expect(retries.find((r) => r.status === 'refused')!.refusal).toBe('stale');
      expect(retries.find((r) => r.status === 'applied')!.encounterReceipts).toMatchObject([
        { roll: attemptRoll(seed), success: true },
      ]);
      expect(await held(playerId, CHARM)).toBe(1);
      expect(await w.app.effects.getCaptureBonus(playerId)).toBeNull();
      expect(await ledger(playerId)).toHaveLength(1);
      expect(
        (
          await w.t.db
            .select()
            .from(playerDailyQuests)
            .where(eq(playerDailyQuests.playerId, playerId))
        ).map((q) => q.progress),
      ).toEqual([1, 1]);
      expect(
        (await w.runs.history(run.id)).filter((e) => e.type === 'waifu_acquired'),
      ).toHaveLength(1);
    },
  );
});

it('composes real encounter/Buddy/environment and enemy scenes; refuses sprite-bearing export with an explanation', async () => {
  const asset = await w.assets.upload(
    { bytes: await transparentSprite(100, 100, GREEN), category: 'dungeon_scene_sprite' },
    'creator',
  );
  const sprites = createSceneSpriteService({ db: w.t.db, assets: w.assets });
  await sprites.create('p4d2_debris', { name: 'Debris', assetId: asset.id }, 'creator');
  const d = captureLifecycleDungeon('p4d2_visual');
  w.speciesAccess.set(FINITE, [{ dungeon: d.key, directRescue: true, perPlayerLimit: 1 }]);
  fs.mkdirSync(path.join(w.artworkDir, 'dungeons'), { recursive: true });
  fs.writeFileSync(path.join(w.artworkDir, 'dungeons/room.png'), await solidImage(1200, 675, BLUE));
  d.rooms[0]!.background = { kind: 'shipped', path: 'dungeons/room.png' };
  d.rooms[0]!.sceneSprites = [{ id: 'debris', spriteKey: 'p4d2_debris' }];
  d.rooms[1]!.background = d.rooms[0]!.background;
  d.rooms[1]!.sceneSprites = [{ id: 'boss_debris', spriteKey: 'p4d2_debris' }];
  const enemyAsset = await w.assets.upload(
    { bytes: await transparentSprite(100, 100, RED), category: 'enemy_sprite' },
    'creator',
  );
  const enemy = (await w.enemies.get('warden'))!;
  await w.enemies.update(
    'warden',
    {
      expectedRevision: enemy.revision,
      enemy: {
        name: enemy.name,
        enabled: enemy.enabled,
        attack: enemy.attack,
        defense: enemy.defense,
        hp: enemy.hp,
        spriteAssetId: enemyAsset.id,
      },
    },
    'creator',
  );
  await w.publish(d);
  const { playerId } = await w.player();
  const seed = findSeed((s) => poolRoll(s, 10) < 4);
  let run = await w.runs.start(playerId, d.key, { seed });
  run = (await act(playerId, run, { type: 'choose', choiceId: 'repair' })).run;
  expect(run.encounterActor?.speciesSlug).toBe(COMMON);
  expect(run.sceneSprites).toHaveLength(1);
  for (const slug of [COMMON, run.fighter.speciesSlug]) {
    const dir = path.join(w.artworkDir, 'waifumon', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${slug}_sprite.webp`),
      await transparentSprite(100, 100, RED, 'webp'),
    );
  }
  const ctx = {
    config: { assetsDir: w.artworkDir },
    content: w.app.content,
    services: { artworkAssets: w.assets, sceneComposition: w.scenes },
    logger: { warn: () => {} },
  } as unknown as AppContext;
  expect((await dungeonRunSceneArtwork(ctx, run))?.url).toMatch(/dungeon-scene/);
  await expect(w.content.exportPackage(d.key, 'published', 'creator')).rejects.toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: 'schema',
        message:
          'Packages with Scene Sprites are temporarily unavailable until sprite dependencies can be bundled safely. Remove placements from a copy to export it.',
      }),
    ]),
  });
  run = (await act(playerId, run, { type: 'leave_encounter' })).run;
  run = (await act(playerId, run, { type: 'advance' })).run;
  run = (await act(playerId, run, { type: 'leave_encounter' })).run;
  run = (await act(playerId, run, { type: 'move', connectionId: 'to_boss' })).run;
  expect(run.enemy).not.toBeNull();
  expect(run.encounterActor).toBeUndefined();
  expect(run.sceneSprites).toHaveLength(1);
  expect((await dungeonRunSceneArtwork(ctx, run))?.url).toMatch(/dungeon-scene/);
});
