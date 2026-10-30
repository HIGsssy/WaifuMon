/**
 * Pre-release progression: Equipment onboarding → the Combat Trials
 * curriculum → Delve, against a real database.
 *
 * The curriculum (`COMBAT_TRIAL_CURRICULUM`) is the authoritative list; its
 * completion is read from the `first_clear` attempt rows. These tests fight
 * the real Trial service and the real dungeon run service over one database,
 * so the menu decisions (`entryVisible`), every entry path and the run-in-
 * progress exemptions are all checked against the same records.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { combatTrialAttempts, dungeonDefinitions, dungeonRuns, playerCurrencies, players } from '../../src/db/schema';
import {
  createCombatTrialService,
  type CombatTrialService,
} from '../../src/modules/combatTrials/combatTrialService';
import {
  COMBAT_TRIAL_CURRICULUM,
  createDelveAccess,
  readCurriculumProgress,
} from '../../src/modules/combatTrials/trialCurriculum';
import { createCombatEnemyCatalogue, CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import {
  createCombatTrialCatalogue,
  CombatTrialDefinitionSchema,
  type CombatTrialDefinition,
  type CombatTrialDefinitionInput,
} from '../../src/modules/combat/trialDefinitions';
import {
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  CombatTrialsCompletedError,
  DelveLockedError,
  DungeonRunActiveError,
  DungeonUnavailableError,
  FeatureLockedError,
} from '../../src/shared/errors';
import {
  handleCombatTrialFight,
  handleCombatTrialView,
  handleCombatTrialsHome,
} from '../../src/discord/commands/waifumonCombatTrials';
import { handleDungeonHome, handleDungeonStart, handleDungeonZone } from '../../src/discord/commands/waifumonDungeon';
import { TRIALS_COMPLETED } from '../../src/discord/combatTrialPresenter';
import { DELVE_LOCKED } from '../../src/discord/dungeonPresenter';
import type { AppContext, Provisioned } from '../../src/discord/types';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { Region } from '../../src/modules/locations/regions';
import { silentLogger } from '../helpers/testDb';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { recordTrialFirstClears } from '../helpers/trialFixtures';

let w: DungeonWorld;

const ENEMY = CombatEnemyDefinitionSchema.parse({ key: 'weakling', name: 'Weakling', attack: 1, defense: 0, hp: 10, enabled: true });
const trial = (over: Partial<CombatTrialDefinitionInput> & { key: string; order: number }) =>
  CombatTrialDefinitionSchema.parse({ name: `Trial ${over.key}`, description: 'A test.', enabled: true, enemyKey: ENEMY.key, ...over });
/** The curriculum, by its real keys, against an enemy any starter loadout beats. */
const CURRICULUM_TRIALS = COMBAT_TRIAL_CURRICULUM.map((key, i) =>
  trial({ key, order: (i + 1) * 10, firstClearRewards: { waifubux: 10 * (i + 1), items: [] }, tags: ['starter'] }),
);
const OPTIONAL = trial({ key: 't_optional', order: 100, tags: ['advanced'] });

/** What "content" says the Trials are. Tests swap it, as a reload would. */
let trialDefs: CombatTrialDefinition[] = CURRICULUM_TRIALS;
function buildTrials(): CombatTrialService {
  return createCombatTrialService({
    db: w.t.db,
    featureUnlocks: w.svc.featureUnlocks,
    combatStats: w.stats,
    currency: w.app.currency,
    inventory: w.app.inventory,
    getCatalogue: () => createCombatTrialCatalogue(trialDefs, createCombatEnemyCatalogue([ENEMY])),
  });
}
let trials: CombatTrialService;

let nonce = 0;
const key = () => `test:${++nonce}`;

const START_DUNGEON = 'delve_gate';
/** A published one-room dungeon in `regions`, ending in an extraction room. */
function oneRoom(dungeonKey: string, regions: Region[]): DungeonDefinitionInput {
  return singleRoomDungeon([{ id: 'pay', type: 'reward', reward: { currency: { min: 8, max: 8 } } }], (d) => {
    d.key = dungeonKey;
    d.name = dungeonKey;
    d.availableRegions = regions;
    d.rooms[0]!.extraction = true;
  });
}

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  trials = buildTrials();
  // waifu-valley (every player's start): one live dungeon.
  await w.publish(oneRoom(START_DUNGEON, ['waifu-valley']));
  // flaccid-foothills: a draft only, never published.
  await w.content.create({ definition: oneRoom('draft_only', ['flaccid-foothills']) }, 'test');
  // thirstlands: published, then disabled.
  await w.publish(oneRoom('switched_off', ['thirstlands']));
  await w.content.setEnabled('switched_off', false, 'test');
  // base-80085 and assteroid-belt share one dungeon. twin-peeks has none.
  await w.publish(oneRoom('two_regions', ['base-80085', 'assteroid-belt']));
});
afterAll(async () => {
  await w.cleanup();
});

/** A Stage B player: Equipment unlocked and geared, no Trial cleared yet. */
const freshPlayer = (o: Parameters<DungeonWorld['player']>[0] = {}) => w.player({ trials: false, ...o });
/** A Stage C player: the whole curriculum cleared. */
const graduate = (o: Parameters<DungeonWorld['player']>[0] = {}) => w.player({ trials: true, ...o });

async function moveTo(playerId: number, region: Region) {
  await w.t.db.update(players).set({ currentRegion: region }).where(eq(players.id, playerId));
}
const attempts = (playerId: number) =>
  w.t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.playerId, playerId)).orderBy(combatTrialAttempts.id);
const runsOf = (playerId: number) => w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId));
async function waifubux(playerId: number) {
  const [row] = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
  return row?.waifubux ?? 0;
}
async function clearCurriculum(playerId: number) {
  const outcomes = [];
  for (const k of COMBAT_TRIAL_CURRICULUM) outcomes.push(await trials.fight(playerId, k, key()));
  return outcomes;
}

/* ─────────────── Equipment onboarding and Combat Trials ─────────────── */

describe('Stage A — Equipment onboarding incomplete', () => {
  it('Trials and Delve are hidden and every entry is refused as locked', async () => {
    const { playerId } = await freshPlayer({ unlocked: false });
    expect(await trials.entryVisible(playerId)).toBe(false);
    expect(await w.runs.entryVisible(playerId)).toBe(false);
    await expect(trials.list(playerId)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(w.runs.home(playerId)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(w.runs.start(playerId, START_DUNGEON)).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await runsOf(playerId)).toEqual([]);
  });
});

describe('Stage B — onboarding complete, Trials unfinished', () => {
  it('no Trial cleared: Trials visible, Delve hidden even with a live dungeon here', async () => {
    const { playerId } = await freshPlayer();
    expect(await trials.entryVisible(playerId)).toBe(true);
    expect(await w.runs.entryVisible(playerId)).toBe(false);
    const list = await trials.list(playerId);
    expect(list.trials.map((t) => t.trial.key)).toEqual([...COMBAT_TRIAL_CURRICULUM]);
    expect(list.curriculum).toEqual({ required: 3, cleared: 0, complete: false });
  });

  it('some Trials cleared: progress counts, cleared Trials stay re-fightable for nothing, Delve stays locked', async () => {
    const { playerId } = await freshPlayer();
    const first = await trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[0]!, key());
    await trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[1]!, key());
    expect(first).toMatchObject({ canFightAgain: true, trialsOpen: true, completedCurriculum: false });
    expect((await trials.list(playerId)).curriculum).toEqual({ required: 3, cleared: 2, complete: false });

    // Existing replay contract, kept while the curriculum is in progress:
    // a cleared Trial can be fought again and pays nothing.
    const paid = await waifubux(playerId);
    const again = await trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[0]!, key());
    expect(again.attempt).toMatchObject({ result: 'player_victory', firstClear: false, rewards: null });
    expect(await waifubux(playerId)).toBe(paid);

    expect(await w.runs.entryVisible(playerId)).toBe(false);
    await expect(w.runs.start(playerId, START_DUNGEON)).rejects.toBeInstanceOf(DelveLockedError);
  });
});

describe('Stage C — the final Trial', () => {
  it('clearing it opens Delve, retires the Trials and announces the unlock once', async () => {
    const { playerId } = await freshPlayer();
    const [, , last] = await clearCurriculum(playerId);
    expect(last).toMatchObject({ replayed: false, canFightAgain: false, trialsOpen: false, completedCurriculum: true });
    expect(last!.attempt.firstClear).toBe(true);

    expect(await trials.entryVisible(playerId)).toBe(false);
    await expect(trials.list(playerId)).rejects.toBeInstanceOf(CombatTrialsCompletedError);
    expect(await w.runs.entryVisible(playerId)).toBe(true);
    const run = await w.runs.start(playerId, START_DUNGEON);
    expect(run.status).toBe('active');
  });

  it('a retried final Fight replays its result and pays nothing twice', async () => {
    const { playerId } = await freshPlayer();
    for (const k of COMBAT_TRIAL_CURRICULUM.slice(0, 2)) await trials.fight(playerId, k, key());
    const finalKey = key();
    const final = await trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[2]!, finalKey);
    const paid = await waifubux(playerId);
    const retried = await trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[2]!, finalKey);
    expect(retried).toMatchObject({ replayed: true, completedCurriculum: true, canFightAgain: false });
    expect(retried.attempt.id).toBe(final.attempt.id);
    expect(await waifubux(playerId)).toBe(paid);
  });

  it('concurrent Fights racing the final clear: one clears, the other is refused, one reward', async () => {
    const { playerId } = await freshPlayer();
    for (const k of COMBAT_TRIAL_CURRICULUM.slice(0, 2)) await trials.fight(playerId, k, key());
    const before = await waifubux(playerId);
    const results = await Promise.allSettled([
      trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[2]!, key()),
      trials.fight(playerId, COMBAT_TRIAL_CURRICULUM[2]!, key()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(CombatTrialsCompletedError);
    expect(await waifubux(playerId)).toBe(before + 30);
  });
});

describe('completed Trials stay closed', () => {
  it('stale open and Fight requests are refused and record nothing', async () => {
    const { playerId } = await freshPlayer();
    await clearCurriculum(playerId);
    const recorded = (await attempts(playerId)).length;
    for (const k of COMBAT_TRIAL_CURRICULUM) {
      await expect(trials.detail(playerId, k)).rejects.toBeInstanceOf(CombatTrialsCompletedError);
      await expect(trials.fight(playerId, k, key())).rejects.toBeInstanceOf(CombatTrialsCompletedError);
    }
    expect(await attempts(playerId)).toHaveLength(recorded);
  });

  it('stale Discord buttons land on the completed screen with no dead buttons', async () => {
    const { playerId } = await freshPlayer();
    await clearCurriculum(playerId);
    const ctx = { config: { assetsDir: w.artworkDir }, logger: silentLogger(), content: w.app.content, services: { combatTrials: trials } } as unknown as AppContext;
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const recorded = (await attempts(playerId)).length;
    for (const press of [
      (i: never) => handleCombatTrialsHome(ctx, i, prov, ['0']),
      (i: never) => handleCombatTrialView(ctx, i, prov, [COMBAT_TRIAL_CURRICULUM[0]!]),
      (i: never) => handleCombatTrialFight(ctx, i, prov, [COMBAT_TRIAL_CURRICULUM[2]!, 'abcdefgh']),
    ]) {
      const c = click();
      await press(c.i);
      expect(c.last().content).toBe(TRIALS_COMPLETED);
      expect(labels(c.last())).toEqual(['Back to Waifumon']);
    }
    expect(await attempts(playerId)).toHaveLength(recorded);
  });

  it('completion and rewards survive a restart: new services read the same records', async () => {
    const { playerId } = await freshPlayer();
    await clearCurriculum(playerId);
    const paid = await waifubux(playerId);
    const restartedTrials = buildTrials();
    const restartedRuns = w.restartedRuns();
    expect(await restartedTrials.entryVisible(playerId)).toBe(false);
    await expect(restartedTrials.fight(playerId, COMBAT_TRIAL_CURRICULUM[0]!, key())).rejects.toBeInstanceOf(CombatTrialsCompletedError);
    expect(await createDelveAccess({ db: w.t.db, featureUnlocks: w.svc.featureUnlocks }).isUnlocked(playerId)).toBe(true);
    expect(await restartedRuns.entryVisible(playerId)).toBe(true);
    // Exactly one first clear per Trial, and no second payout.
    const firsts = (await attempts(playerId)).filter((a) => a.firstClear).map((a) => a.trialKey);
    expect(firsts.sort()).toEqual([...COMBAT_TRIAL_CURRICULUM].sort());
    expect(await waifubux(playerId)).toBe(paid);
    expect(paid).toBe(10 + 20 + 30);
  });
});

describe('a stable unlock', () => {
  it('an optional Trial neither blocks Delve nor disappears with the curriculum', async () => {
    trialDefs = [...CURRICULUM_TRIALS, OPTIONAL];
    try {
      const { playerId } = await freshPlayer();
      await clearCurriculum(playerId);
      expect(await w.runs.entryVisible(playerId)).toBe(true);
      // The optional Trial is still offered, and is all that is offered.
      expect(await trials.entryVisible(playerId)).toBe(true);
      expect((await trials.list(playerId)).trials.map((t) => t.trial.key)).toEqual([OPTIONAL.key]);
      const optional = await trials.fight(playerId, OPTIONAL.key, key());
      expect(optional).toMatchObject({ canFightAgain: true, trialsOpen: true, completedCurriculum: false });
    } finally {
      trialDefs = CURRICULUM_TRIALS;
    }
  });

  it('the result of the final clear still offers All Trials when optional ones remain', async () => {
    trialDefs = [...CURRICULUM_TRIALS, OPTIONAL];
    try {
      const { playerId } = await freshPlayer();
      const [, , last] = await clearCurriculum(playerId);
      expect(last).toMatchObject({ canFightAgain: false, trialsOpen: true, completedCurriculum: true });
    } finally {
      trialDefs = CURRICULUM_TRIALS;
    }
  });

  it('Trials added to the catalogue later never revoke an earned unlock', async () => {
    const { playerId } = await freshPlayer();
    await clearCurriculum(playerId);
    trialDefs = [...CURRICULUM_TRIALS, trial({ key: 'trial_new_starter', order: 40, tags: ['starter'] })];
    try {
      expect(await w.runs.entryVisible(playerId)).toBe(true);
      expect((await readCurriculumProgress(w.t.db, playerId)).complete).toBe(true);
      expect((await w.runs.start(playerId, START_DUNGEON)).status).toBe('active');
    } finally {
      trialDefs = CURRICULUM_TRIALS;
    }
  });

  it('a curriculum Trial disabled in content still counts once cleared', async () => {
    const { playerId } = await graduate();
    trialDefs = CURRICULUM_TRIALS.map((t, i) => (i === 0 ? { ...t, enabled: false } : t));
    try {
      expect(await w.runs.entryVisible(playerId)).toBe(true);
    } finally {
      trialDefs = CURRICULUM_TRIALS;
    }
  });
});

/* ─────────────────────────── Delve visibility ─────────────────────────── */

describe('the Delve entry', () => {
  it('stays hidden in every region until the Trials are cleared', async () => {
    const { playerId } = await freshPlayer();
    for (const region of ['waifu-valley', 'base-80085', 'assteroid-belt'] as const) {
      await moveTo(playerId, region);
      expect(await w.runs.entryVisible(playerId), region).toBe(false);
    }
  });

  it.each([
    ['twin-peeks', false, 'no dungeon'],
    ['flaccid-foothills', false, 'a draft only'],
    ['thirstlands', false, 'published but disabled'],
    ['waifu-valley', true, 'an enabled, published dungeon'],
    ['base-80085', true, 'a dungeon shared with another region'],
    ['assteroid-belt', true, 'the same shared dungeon'],
  ] as const)('after the Trials, in %s: visible %s (%s)', async (region, visible, _why) => {
    const { playerId } = await graduate();
    await moveTo(playerId, region);
    expect(await w.runs.entryVisible(playerId)).toBe(visible);
  });

  it('follows the player as they travel', async () => {
    const { playerId } = await graduate();
    await moveTo(playerId, 'twin-peeks');
    expect(await w.runs.entryVisible(playerId)).toBe(false);
    await moveTo(playerId, 'base-80085');
    expect(await w.runs.entryVisible(playerId)).toBe(true);
    await moveTo(playerId, 'thirstlands');
    expect(await w.runs.entryVisible(playerId)).toBe(false);
  });

  it('a temporary personal restriction keeps the entry and its usual refusal', async () => {
    const noBuddy = await graduate({ buddy: false });
    expect(await w.runs.entryVisible(noBuddy.playerId)).toBe(true);
    expect((await w.runs.home(noBuddy.playerId)).blocker).toBe('no_buddy');
    await expect(w.runs.start(noBuddy.playerId, START_DUNGEON)).rejects.toBeInstanceOf(CombatBuddyRequiredError);

    const ungeared = await graduate({ starters: false });
    expect(await w.runs.entryVisible(ungeared.playerId)).toBe(true);
    await expect(w.runs.start(ungeared.playerId, START_DUNGEON)).rejects.toBeInstanceOf(CombatLoadoutIncompleteError);

    // An activity lock (a run already under way) is the existing refusal too.
    const busy = await graduate();
    await w.runs.start(busy.playerId, START_DUNGEON);
    await expect(w.runs.start(busy.playerId, START_DUNGEON)).rejects.toBeInstanceOf(DungeonRunActiveError);
    expect(await w.runs.entryVisible(busy.playerId)).toBe(true);
  });
});

/* ────────────────────────── Backend enforcement ────────────────────────── */

describe('starting a run', () => {
  it('a direct start, home or dungeon request before the Trials is refused and spends nothing', async () => {
    const { playerId } = await freshPlayer();
    const before = await w.allowance.status(playerId);
    await expect(w.runs.start(playerId, START_DUNGEON)).rejects.toBeInstanceOf(DelveLockedError);
    await expect(w.runs.home(playerId)).rejects.toBeInstanceOf(DelveLockedError);
    await expect(w.runs.dungeon(playerId, START_DUNGEON)).rejects.toBeInstanceOf(DelveLockedError);
    expect(await runsOf(playerId)).toEqual([]);
    expect((await w.allowance.status(playerId)).used).toBe(before.used);
  });

  it('a previously rendered Delve button cannot bypass the prerequisite', async () => {
    const { playerId } = await freshPlayer();
    const ctx = dungeonCtx();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    for (const press of [
      (i: never) => handleDungeonHome(ctx, i, prov),
      (i: never) => handleDungeonZone(ctx, i, prov, [START_DUNGEON]),
      (i: never) => handleDungeonStart(ctx, i, prov, [START_DUNGEON]),
    ]) {
      const c = click();
      await press(c.i);
      expect(c.last().content).toBe(DELVE_LOCKED);
      expect(labels(c.last())).toEqual(['Combat Trials', 'Back to Waifumon']);
    }
    expect(await runsOf(playerId)).toEqual([]);
  });

  it('disabling or unpublishing the dungeon after the menu was drawn prevents entry', async () => {
    const dungeonKey = 'closing_soon';
    await w.publish(oneRoom(dungeonKey, ['twin-peeks']));
    try {
      const { playerId } = await graduate();
      await moveTo(playerId, 'twin-peeks');
      expect(await w.runs.entryVisible(playerId)).toBe(true);
      expect((await w.runs.home(playerId)).dungeons.map((d) => d.key)).toEqual([dungeonKey]);

      await w.content.setEnabled(dungeonKey, false, 'test');
      expect(await w.runs.entryVisible(playerId)).toBe(false);
      await expect(w.runs.start(playerId, dungeonKey)).rejects.toMatchObject({ reason: 'disabled' });

      await w.content.setEnabled(dungeonKey, true, 'test');
      await w.t.db.update(dungeonDefinitions).set({ publishedRevisionId: null }).where(eq(dungeonDefinitions.dungeonKey, dungeonKey));
      expect(await w.runs.entryVisible(playerId)).toBe(false);
      await expect(w.runs.start(playerId, dungeonKey)).rejects.toMatchObject({ reason: 'unpublished' });
      expect(await runsOf(playerId)).toEqual([]);
    } finally {
      // Leave twin-peeks without a live dungeon for the other tests.
      await w.content.setEnabled(dungeonKey, false, 'test');
    }
  });

  it('region and publication checks still apply once Delve is unlocked', async () => {
    const { playerId } = await graduate();
    await moveTo(playerId, 'base-80085');
    await expect(w.runs.start(playerId, START_DUNGEON)).rejects.toMatchObject({ reason: 'region' });
    await expect(w.runs.start(playerId, 'draft_only')).rejects.toBeInstanceOf(DungeonUnavailableError);
    expect((await w.runs.start(playerId, 'two_regions')).status).toBe('active');
  });
});

describe('a run already under way', () => {
  /**
   * A player holding a run without the curriculum cleared — a run started
   * before this release. Simulated by removing the clear records after start.
   */
  async function legacyRunHolder() {
    const { playerId } = await graduate();
    const run = await w.runs.start(playerId, START_DUNGEON);
    await w.t.db
      .delete(combatTrialAttempts)
      .where(and(eq(combatTrialAttempts.playerId, playerId), inArray(combatTrialAttempts.trialKey, [...COMBAT_TRIAL_CURRICULUM])));
    expect((await readCurriculumProgress(w.t.db, playerId)).complete).toBe(false);
    return { playerId, run };
  }

  it('stays reachable, playable and extractable, including after a restart', async () => {
    const { playerId, run } = await legacyRunHolder();
    expect(await w.runs.entryVisible(playerId)).toBe(true);
    expect((await w.runs.home(playerId)).activeRun?.id).toBe(run.id);
    expect((await w.runs.dungeon(playerId, START_DUNGEON)).activeRunId).toBe(run.id);

    const restarted = w.restartedRuns();
    expect((await restarted.activeRun(playerId))?.id).toBe(run.id);
    const recovered = await restarted.run(playerId, run.id);
    const done = (await restarted.act(playerId, run.id, { type: 'advance', expectedStep: recovered.step })).run;
    const out = await restarted.act(playerId, run.id, { type: 'extract', expectedStep: done.step });
    expect(out.run).toMatchObject({ status: 'extracted', settlement: { outcome: 'extracted', banked: 8 } });

    // Settled: the next run is a new start, which needs the Trials again.
    await expect(w.runs.start(playerId, START_DUNGEON)).rejects.toBeInstanceOf(DelveLockedError);
    expect(await w.runs.entryVisible(playerId)).toBe(false);
  });

  it('can always be abandoned', async () => {
    const { playerId, run } = await legacyRunHolder();
    const out = await w.runs.act(playerId, run.id, { type: 'abandon', expectedStep: run.step });
    expect(out.run.status).toBe('abandoned');
  });
});

/* ───────────────────────────── helpers ───────────────────────────── */

interface Payload {
  content?: string;
  components?: { toJSON(): { components: { label?: string }[] } }[];
}
function click() {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(body as Payload);
  });
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint };
  return { i: i as never, last: () => painted[painted.length - 1]! };
}
function labels(p: Payload): (string | undefined)[] {
  return (p.components ?? []).flatMap((r) => r.toJSON().components.map((c) => c.label));
}
function dungeonCtx(): AppContext {
  return {
    config: { assetsDir: w.artworkDir },
    logger: silentLogger(),
    content: w.app.content,
    services: { dungeonRuns: w.runs, dungeonContent: w.content, dungeonAllowance: w.allowance, collection: w.app.collection },
  } as unknown as AppContext;
}
