/**
 * Dungeon runs against a real database: the live effects adapter, the row
 * lock and step check, revision pinning, dependency snapshots and settlement.
 */
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  dungeonDailyUsage,
  dungeonRunEvents,
  dungeonRuns,
  items,
  playerCurrencies,
  playerEquipment,
  playerInventory,
  players,
  progressionCurrencyLedger,
} from '../../src/db/schema';
import type { DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonRunService';
import type { DungeonInput } from '../../src/modules/dungeons/engine/types';
import {
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  DungeonDailyLimitError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonUnavailableError,
  FeatureLockedError,
} from '../../src/shared/errors';
import { CURRENCY, STARTER, singleRoomDungeon, testDungeonInput } from '../helpers/dungeonFixtures';
import { GEAR_TABLE, LOOT_TABLE, createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  await w.publish();
});
afterAll(async () => {
  await w.cleanup();
});

let n = 0;
type Actions = NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>;
/** Publish a one-room dungeon under a fresh key and return the key. */
async function oneRoom(actions: Actions, patch: (d: DungeonDefinitionInput) => void = () => {}): Promise<string> {
  const key = `room_${++n}`;
  const definition = singleRoomDungeon(actions, (d) => {
    d.key = key;
    patch(d);
  });
  await w.publish(definition);
  return key;
}
const fight = (id: string, enemies: string[], extra: Record<string, unknown> = {}): Actions[number] => ({
  id,
  type: 'combat',
  waves: enemies.map((key) => ({ enemy: { key } })),
  ...extra,
});

/** Apply inputs in order, each naming the step the previous screen showed. */
async function play(playerId: number, view: DungeonRunView, inputs: DungeonInput[]): Promise<DungeonRunView> {
  let current = view;
  for (const input of inputs) {
    const result = await w.act(playerId, current, input);
    expect(result, JSON.stringify(input)).toMatchObject({ status: 'applied', refusal: null });
    current = result.run;
  }
  return current;
}
const waveRows = (runId: number) =>
  w.t.db.select().from(dungeonRunEvents).where(and(eq(dungeonRunEvents.runId, runId), eq(dungeonRunEvents.type, 'combat_wave_resolved')));

const MAIN_ROUTE: DungeonInput[] = [
  { type: 'advance' }, { type: 'advance' }, { type: 'advance' },
  { type: 'move', connectionId: 'c_main' }, { type: 'advance' }, { type: 'advance' },
  { type: 'move', connectionId: 'c_pump_bulk' }, { type: 'advance' },
  { type: 'move', connectionId: 'c_boss' }, { type: 'advance' }, { type: 'advance' },
];

describe('starting a run', () => {
  it('pins the published revision, snapshots the fighter and dependencies, and stands in the entrance', async () => {
    const { playerId, buddyId } = await w.player();
    const run = await w.runs.start(playerId, 'test_tunnels', { seed: 11 });
    expect(run).toMatchObject({
      status: 'active',
      step: 0,
      dungeon: { key: 'test_tunnels', name: 'Test Tunnels', revision: 1 },
      fighter: { waifuId: buddyId, ...STARTER },
      core: {
        hp: STARTER.maxHp,
        maxHp: STARTER.maxHp,
        phase: 'action',
        room: { id: 'gate', visits: 1, completed: false },
        action: { id: 'guards', type: 'combat', wave: { index: 0, count: 2, enemy: { key: 'grunt' } } },
        roomCount: 5,
      },
      enemy: { key: 'grunt', name: 'Grunt', hp: 150 },
      secured: [],
      settlement: null,
    });
    const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    expect(row).toMatchObject({ dungeonKey: 'test_tunnels', seed: 11, step: 0, status: 'active', currentHp: 370 });
    expect(Object.keys((row!.dependencySnapshot as { enemies: object }).enemies).sort()).toEqual(['grunt', 'overlord', 'sentinel', 'warden']);
    const history = await w.runs.history(run.id);
    expect(history.map((e) => [e.step, e.type])).toEqual([[0, 'run_started'], [0, 'room_entered']]);
    expect(history[0]!.payload).toMatchObject({ dungeonKey: 'test_tunnels', revision: 1, seed: 11, region: 'waifu-valley' });
  });

  it('allows one active run per player, even under a double click', async () => {
    const { playerId } = await w.player();
    const results = await Promise.allSettled([w.runs.start(playerId, 'test_tunnels'), w.runs.start(playerId, 'test_tunnels'), w.runs.start(playerId, 'test_tunnels')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonRunActiveError);
    // Only the run that started spent a daily attempt.
    const [usage] = await w.t.db.select().from(dungeonDailyUsage).where(eq(dungeonDailyUsage.playerId, playerId));
    expect(usage!.runsStarted).toBe(1);
  });

  it('refuses a locked player, a player without a Buddy or a full loadout, and spends nothing', async () => {
    const locked = await w.player({ unlocked: false });
    await expect(w.runs.start(locked.playerId, 'test_tunnels')).rejects.toBeInstanceOf(FeatureLockedError);
    const noBuddy = await w.player({ buddy: false });
    await expect(w.runs.start(noBuddy.playerId, 'test_tunnels')).rejects.toBeInstanceOf(CombatBuddyRequiredError);
    const noGear = await w.player({ starters: false });
    await expect(w.runs.start(noGear.playerId, 'test_tunnels')).rejects.toBeInstanceOf(CombatLoadoutIncompleteError);
    for (const { playerId } of [locked, noBuddy, noGear]) {
      expect(await w.t.db.select().from(dungeonDailyUsage).where(eq(dungeonDailyUsage.playerId, playerId))).toEqual([]);
      expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId))).toEqual([]);
    }
  });

  it('refuses a dungeon that is missing, unpublished, disabled or not available where the player stands', async () => {
    const { playerId } = await w.player();
    await expect(w.runs.start(playerId, 'nowhere')).rejects.toMatchObject({ reason: 'missing' });
    await w.content.create({ definition: testDungeonInput('draft_only') }, 'test');
    await expect(w.runs.start(playerId, 'draft_only')).rejects.toMatchObject({ reason: 'unpublished' });
    await w.publish(testDungeonInput('switched_off'));
    await w.content.setEnabled('switched_off', false, 'test');
    await expect(w.runs.start(playerId, 'switched_off')).rejects.toMatchObject({ reason: 'disabled' });
    const elsewhere = testDungeonInput('elsewhere');
    elsewhere.availableRegions = ['flaccid-foothills'];
    await w.publish(elsewhere);
    const err = await w.runs.start(playerId, 'elsewhere').catch((e) => e);
    expect(err).toBeInstanceOf(DungeonUnavailableError);
    expect(err).toMatchObject({ reason: 'region' });
    const home = await w.runs.home(playerId);
    expect(home.dungeons.map((d) => d.key)).toContain('test_tunnels');
    expect(home.dungeons.map((d) => d.key)).not.toEqual(expect.arrayContaining(['draft_only', 'switched_off', 'elsewhere']));
  });

  it('keeps an active run playable after the player travels away', async () => {
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, 'test_tunnels');
    await w.t.db.update(players).set({ currentRegion: 'flaccid-foothills' }).where(eq(players.id, playerId));
    expect((await w.act(playerId, run, { type: 'advance' })).status).toBe('applied');
    expect((await w.runs.home(playerId)).activeRun?.id).toBe(run.id);
  });

  it('spends the daily allowance only on a start that succeeds', async () => {
    await w.allowance.updateSettings({ dailyRunLimit: 1 }, 'test');
    try {
      const { playerId } = await w.player();
      const run = await w.runs.start(playerId, 'test_tunnels');
      await w.runs.act(playerId, run.id, { type: 'abandon' });
      await expect(w.runs.start(playerId, 'test_tunnels')).rejects.toBeInstanceOf(DungeonDailyLimitError);
      expect(await w.runs.dailyAllowance(playerId)).toMatchObject({ limit: 1, used: 1, remaining: 0 });
    } finally {
      await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
    }
  });
});

describe('playing a run', () => {
  it('plays the main route to the exit: HP carried, currency banked once, history complete', async () => {
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, 'test_tunnels', { seed: 3 });
    const end = await play(playerId, start, MAIN_ROUTE);
    expect(end).toMatchObject({
      status: 'completed',
      step: MAIN_ROUTE.length,
      core: { phase: 'ended', hp: 370 - 36 - 36 - 36 + 92 - 72 - 108, roomsCompleted: 4 },
      settlement: { outcome: 'completed', cause: 'exit_reached', roomId: 'den', earned: 12, retentionBasisPoints: 10_000, banked: 12, lost: 0, bankingSkipped: null, balanceAfter: 12 },
    });
    expect(end.completedAt).toBeInstanceOf(Date);
    expect(await w.balance(playerId)).toBe(12);
    const ledger = await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
    expect(ledger).toEqual([expect.objectContaining({ delta: 12, reason: 'dungeon_completion', requestKey: `dungeon_run:v1:${start.id}:settlement`, currencyKey: CURRENCY })]);

    const history = await w.runs.history(start.id);
    expect(history.filter((e) => e.type === 'combat_wave_resolved').map((e) => [e.step, e.roomId, e.actionId, e.payload.waveIndex])).toEqual([
      [1, 'gate', 'guards', 0],
      [2, 'gate', 'guards', 1],
      [5, 'pump_room', 'bruiser', 0],
      [8, 'bulkhead', 'sentry', 0],
      [10, 'den', 'overlord', 0],
    ]);
    expect(history.at(-2)).toMatchObject({ type: 'completion', step: MAIN_ROUTE.length });
    expect(history.at(-1)).toMatchObject({ type: 'currency_banked', payload: { amount: 12, balanceAfter: 12 } });
    // Finished: a new run may start.
    expect((await w.runs.start(playerId, 'test_tunnels')).status).toBe('active');
  });

  it('resumes between waves after a restart, from nothing but the row', async () => {
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, 'test_tunnels', { seed: 3 });
    const afterWave1 = (await w.act(playerId, start, { type: 'advance' })).run;
    expect(afterWave1.core).toMatchObject({ hp: 334, action: { id: 'guards', wave: { index: 1, count: 2 } } });

    // A brand-new service over the same database: no memory of the run.
    const restarted = w.restartedRuns();
    const resumed = await restarted.run(playerId, start.id);
    expect(resumed.step).toBe(1);
    expect(resumed.core).toEqual(afterWave1.core);
    expect(resumed.combatEvents).toEqual(afterWave1.combatEvents);
    expect((await restarted.home(playerId)).activeRun?.core.action?.wave?.index).toBe(1);

    const afterWave2 = await restarted.act(playerId, start.id, { type: 'advance', expectedStep: resumed.step });
    expect(afterWave2.run.core).toMatchObject({ hp: 298, action: { id: 'pay' } });
    expect((await waveRows(start.id)).map((r) => (r.payload as { waveIndex: number }).waveIndex)).toEqual([0, 1]);
  });

  it('reproduces a stored fight exactly from its recorded seed and HP', async () => {
    const real = await createDungeonWorld({ combatRules: null });
    try {
      await real.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
      await real.publish();
      const a = await real.player();
      const b = await real.player();
      const first = (await real.act(a.playerId, await real.runs.start(a.playerId, 'test_tunnels', { seed: 99 }), { type: 'advance' })).run;
      const second = (await real.act(b.playerId, await real.runs.start(b.playerId, 'test_tunnels', { seed: 99 }), { type: 'advance' })).run;
      // Same seed, same stats, same HP in: the same fight, roll for roll.
      const wave = (run: DungeonRunView) => run.core.recent.find((r) => r.kind === 'wave');
      expect(wave(second)).toEqual(wave(first));
      expect(second.core.hp).toBe(first.core.hp);
      expect(second.combatEvents!.map((e) => e.type)).toEqual(first.combatEvents!.map((e) => e.type));
      expect(first.core.hp).toBeLessThan(370);
      const other = (await real.act(a.playerId, first, { type: 'abandon' })).run;
      expect(other.status).toBe('abandoned');
    } finally {
      await real.cleanup();
    }
  });
});

describe('interaction safety', () => {
  it('refuses a stale interaction: no second fight, no second step, no change', async () => {
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, 'test_tunnels');
    const first = await w.act(playerId, start, { type: 'advance' });
    expect(first).toMatchObject({ status: 'applied', run: { step: 1, core: { hp: 334 } } });

    // The same Discord button again: it still names step 0.
    const again = await w.act(playerId, start, { type: 'advance' });
    expect(again).toMatchObject({ status: 'refused', refusal: 'stale', run: { step: 1, core: { hp: 334 } } });
    expect(again.run.core).toEqual(first.run.core);
    expect(await waveRows(start.id)).toHaveLength(1);
    const [row] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, start.id));
    expect(row).toMatchObject({ step: 1, currentHp: 334 });
  });

  it('lets exactly one of many concurrent submissions of the same step win', async () => {
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, 'test_tunnels');
    const results = await Promise.all(Array.from({ length: 6 }, () => w.act(playerId, start, { type: 'advance' })));
    expect(results.filter((r) => r.status === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'refused').map((r) => r.refusal)).toEqual(Array(5).fill('stale'));
    for (const r of results) expect(r.run).toMatchObject({ step: 1, core: { hp: 334 } });
    expect(await waveRows(start.id)).toHaveLength(1);
  });

  it('cannot move the cursor twice: racing two different moves takes one path', async () => {
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, 'test_tunnels');
    const fork = await play(playerId, start, [{ type: 'advance' }, { type: 'advance' }, { type: 'advance' }]);
    expect(fork.core.connections.map((c) => c.id)).toEqual(['c_main', 'c_side']);
    const [a, b] = await Promise.all([
      w.act(playerId, fork, { type: 'move', connectionId: 'c_main' }),
      w.act(playerId, fork, { type: 'move', connectionId: 'c_side' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'refused']);
    const taken = await w.runs.run(playerId, start.id);
    expect(taken.step).toBe(4);
    expect(['pump_room', 'locker_room']).toContain(taken.core.room.id);
    const moves = (await w.runs.history(start.id)).filter((e) => e.type === 'connection_taken');
    expect(moves).toHaveLength(1);
  });

  it('pays a reward exactly once under repeated and concurrent presses', async () => {
    const key = await oneRoom([
      { id: 'loot', type: 'reward', reward: { rewardTable: LOOT_TABLE, equipmentRewardTable: GEAR_TABLE, currency: { min: 3, max: 3 } } },
      { id: 'r', type: 'rest' },
    ]);
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, key);
    const [before] = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    const gearBefore = await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));

    const results = await Promise.all(Array.from({ length: 5 }, () => w.act(playerId, start, { type: 'advance' })));
    expect(results.filter((r) => r.status === 'applied')).toHaveLength(1);
    await w.act(playerId, start, { type: 'advance' });

    const run = await w.runs.run(playerId, start.id);
    expect(run).toMatchObject({ step: 1, core: { unbankedCurrency: 3, action: { id: 'r' } } });
    const claimKey = `run:${start.id}:hall:loot`;
    expect(run.secured).toEqual([
      expect.objectContaining({ kind: 'equipment', source: claimKey, step: 1, slot: 'attack', rarity: 'N', rewardIndex: 0 }),
      { kind: 'waifubux', source: claimKey, step: 1, amount: 11 },
      { kind: 'item', source: claimKey, step: 1, slug: 'sticky_joystick', quantity: 2 },
    ]);
    expect(run.latestSecured).toEqual(run.secured);

    const [after] = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    expect(after!.waifubux - before!.waifubux).toBe(11);
    const inventory = await w.t.db
      .select({ quantity: playerInventory.quantity })
      .from(playerInventory)
      .innerJoin(items, eq(items.id, playerInventory.itemId))
      .where(and(eq(playerInventory.playerId, playerId), eq(items.slug, 'sticky_joystick')));
    expect(inventory).toEqual([{ quantity: 2 }]);
    const gear = await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    expect(gear).toHaveLength(gearBefore.length + 1);
    const granted = await w.t.db.select().from(playerEquipment).where(like(playerEquipment.grantKey, `dungeon:${claimKey}:0%`));
    expect(granted).toHaveLength(1);
    expect((await w.runs.history(start.id)).filter((e) => e.type === 'rewards_granted')).toHaveLength(1);
  });

  it('answers another player’s run, and a run that does not exist, the same way', async () => {
    const owner = await w.player();
    const stranger = await w.player();
    const run = await w.runs.start(owner.playerId, 'test_tunnels');
    await expect(w.runs.act(stranger.playerId, run.id, { type: 'advance', expectedStep: 0 })).rejects.toBeInstanceOf(DungeonRunNotFoundError);
    await expect(w.runs.run(stranger.playerId, run.id)).rejects.toBeInstanceOf(DungeonRunNotFoundError);
    await expect(w.runs.act(owner.playerId, 999_999, { type: 'advance' })).rejects.toBeInstanceOf(DungeonRunNotFoundError);
    expect((await w.runs.run(owner.playerId, run.id)).step).toBe(0);
  });
});

describe('what a run is pinned to', () => {
  it('finishes on the revision it started with while new runs get the new one, and rollback only moves new runs', async () => {
    const key = `pinned_${++n}`;
    const v1 = singleRoomDungeon([fight('a', ['grunt']), fight('b', ['grunt'])], (d) => void (d.key = key));
    await w.publish(v1);
    const early = await w.player();
    const run1 = await w.runs.start(early.playerId, key);

    // Revision 2 is a different dungeon: one unbeatable fight.
    await w.republish(singleRoomDungeon([fight('doom', ['brute'])], (d) => void (d.key = key)));
    const midway = await w.runs.run(early.playerId, run1.id);
    expect(midway).toMatchObject({ dungeon: { revision: 1 }, core: { action: { id: 'a', wave: { enemy: { key: 'grunt' } } } } });

    const late = await w.player();
    const run2 = await w.runs.start(late.playerId, key);
    expect(run2).toMatchObject({ dungeon: { revision: 2 }, core: { action: { id: 'doom', wave: { enemy: { key: 'brute' } } } } });

    // Roll back: new runs are on revision 1 again; the revision-2 run is not touched.
    await w.content.rollback(key, { revision: 1 }, 'test');
    const third = await w.player();
    expect(await w.runs.start(third.playerId, key)).toMatchObject({ dungeon: { revision: 1 }, core: { action: { id: 'a' } } });
    expect(await w.runs.run(late.playerId, run2.id)).toMatchObject({ dungeon: { revision: 2 }, core: { action: { id: 'doom' } } });
    expect((await w.content.revisions(key))!.map((r) => [r.number, r.current, r.activeRuns])).toEqual([[2, false, 1], [1, true, 2]]);

    // The first run plays out revision 1 to the end.
    const done = await play(early.playerId, midway, [{ type: 'advance' }, { type: 'advance' }, { type: 'move', connectionId: 'c_out' }]);
    expect(done).toMatchObject({ status: 'completed', dungeon: { revision: 1 } });
    expect((await w.act(late.playerId, run2, { type: 'advance' })).run.status).toBe('defeated');
  });

  it('freezes enemy stats when the run starts: a balance edit reaches new runs only', async () => {
    const key = await oneRoom([fight('a', ['sentinel', 'sentinel'])]);
    const early = await w.player();
    const run = await w.runs.start(early.playerId, key);

    const current = (await w.enemies.get('sentinel'))!;
    await w.enemies.update(
      'sentinel',
      {
        enemy: {
          name: 'Sentinel Prime',
          description: current.description,
          enabled: current.enabled,
          attack: 100_000,
          defense: current.defense,
          hp: 1_000_000,
          tags: current.tags,
          artworkAssetId: null,
          spriteAssetId: null,
          spritePlacement: null,
        },
        expectedRevision: current.revision,
      },
      'balance-team',
    );
    try {
      // The run already under way still fights the Sentinel it was promised.
      const fought = await play(early.playerId, run, [{ type: 'advance' }, { type: 'advance' }]);
      expect(fought).toMatchObject({ status: 'active', core: { hp: 370 - 72, phase: 'connections' } });
      expect(fought.core.recent.find((r) => r.kind === 'wave')).toMatchObject({ wave: { enemyName: 'Sentinel', enemyMaxHp: 160 } });

      // A run started now gets the new stats without anything being republished.
      const late = await w.player();
      const fresh = await w.runs.start(late.playerId, key);
      expect(fresh.enemy).toMatchObject({ name: 'Sentinel Prime', hp: 1_000_000 });
      expect((await w.act(late.playerId, fresh, { type: 'advance' })).run.status).toBe('defeated');
    } finally {
      const edited = (await w.enemies.get('sentinel'))!;
      await w.enemies.update(
        'sentinel',
        { enemy: { name: 'Sentinel', description: edited.description, enabled: true, attack: 60, defense: 0, hp: 160, tags: edited.tags, artworkAssetId: null, spriteAssetId: null, spritePlacement: null }, expectedRevision: edited.revision },
        'balance-team',
      );
    }
  });

  it('freezes the fighter: changing gear mid-run does not change the run', async () => {
    const { playerId } = await w.player();
    const run = await w.runs.start(playerId, 'test_tunnels');
    await w.svc.equipment.unequip(playerId, { slot: 'attack' });
    const after = await w.act(playerId, run, { type: 'advance' });
    expect(after.run).toMatchObject({ fighter: STARTER, core: { hp: 334 } });
  });
});

describe('ending a run', () => {
  const paid = (extra: Actions = []): Actions => [{ id: 'pay', type: 'reward', reward: { currency: { min: 8, max: 8 } } }, ...extra];

  it.each([8, 9])('settles independently of prototype keys with historical amount %i, then retries once', async (historicalAmount) => {
    const key = await oneRoom(paid(), (d) => void (d.rooms[0]!.extraction = true));
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, key);
    const historicalKey = `dungeon_run:${start.id}:settlement`;
    await w.t.db.transaction((tx) => w.currencies.grant(tx, { playerId, currencyKey: CURRENCY, amount: historicalAmount, reason: 'dungeon_extraction', requestKey: historicalKey }));
    const [historical] = await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
    const ready = (await w.act(playerId, start, { type: 'advance' })).run;
    const endings = await Promise.all([w.act(playerId, ready, { type: 'extract' }), w.act(playerId, ready, { type: 'extract' })]);
    expect(endings.filter((r) => r.status === 'applied')).toHaveLength(1);
    expect(await w.balance(playerId)).toBe(historicalAmount + 8);
    const requestKey = `dungeon_run:v1:${start.id}:settlement`;
    const retry = await w.t.db.transaction((tx) => w.currencies.grant(tx, { playerId, currencyKey: CURRENCY, amount: 8, reason: 'dungeon_extraction', requestKey }));
    expect(retry).toMatchObject({ replayed: true, balance: historicalAmount + 8 });
    const ledger = await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.requestKey === historicalKey)).toEqual(historical);
    expect(ledger.find((r) => r.requestKey === requestKey)?.delta).toBe(8);
  });

  it('claims all reward types once through retreat, concurrent presses, restart and re-entry', async () => {
    const definition = singleRoomDungeon([], (d) => {
      d.key = `retreat_claim_${++n}`;
      d.rooms[0]!.extraction = true;
      d.rooms.push({ id: 'loot', actions: [{ id: 'pay', type: 'reward', reward: { rewardTable: LOOT_TABLE, equipmentRewardTable: GEAR_TABLE, currency: { min: 10, max: 10 } }, outcomes: { claimed: { type: 'retreat' } } }] });
      d.connections!.push({ id: 'to_loot', from: 'hall', to: 'loot' });
    });
    await w.publish(definition);
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, definition.key);
    const ready = (await w.act(playerId, start, { type: 'move', connectionId: 'to_loot' })).run;
    const [before] = await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId));
    const gearBefore = await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    const failure = vi.spyOn(w.app.inventory, 'addItem').mockRejectedValueOnce(new Error('test grant failure'));
    try {
      await expect(w.act(playerId, ready, { type: 'advance' })).rejects.toThrow('test grant failure');
    } finally {
      failure.mockRestore();
    }
    const [failed] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, start.id));
    expect(failed).toMatchObject({ step: ready.step, rewardClaims: {}, unbankedCurrency: 0 });
    expect((await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId)))[0]!.waifubux).toBe(before!.waifubux);
    const presses = await Promise.all(Array.from({ length: 4 }, () => w.act(playerId, ready, { type: 'advance' })));
    expect(presses.filter((r) => r.status === 'applied')).toHaveLength(1);
    const restarted = w.restartedRuns();
    let run = await restarted.run(playerId, start.id);
    expect(run.core).toMatchObject({ room: { id: 'hall' }, unbankedCurrency: 10 });
    for (let cycle = 0; cycle < 3; cycle++) {
      run = (await restarted.act(playerId, run.id, { type: 'move', connectionId: 'to_loot', expectedStep: run.step })).run;
      expect((await w.act(playerId, ready, { type: 'advance' })).refusal).toBe('stale');
      run = (await restarted.act(playerId, run.id, { type: 'advance', expectedStep: run.step })).run;
      expect(run.core).toMatchObject({ room: { id: 'hall' }, unbankedCurrency: 10 });
    }
    expect((await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId)))[0]!.waifubux).toBe(before!.waifubux + 11);
    const [joystick] = await w.t.db.select().from(items).where(eq(items.slug, 'sticky_joystick'));
    const [inventory] = await w.t.db.select().from(playerInventory).where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, joystick!.id)));
    expect(inventory!.quantity).toBe(2);
    expect(await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toHaveLength(gearBefore.length + 1);
    expect((await w.runs.history(run.id)).filter((e) => e.type === 'rewards_granted')).toHaveLength(1);
    const [stored] = await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    expect(Object.keys(stored!.rewardClaims)).toEqual([`run:${run.id}:loot:pay`]);
    const out = await w.act(playerId, run, { type: 'extract' });
    expect(out.run.settlement?.banked).toBe(10);
    expect(await w.balance(playerId)).toBe(10);
  });

  it('extracts from a finished extraction room, banking everything', async () => {
    const key = await oneRoom(paid(), (d) => void (d.rooms[0]!.extraction = true));
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, key);
    expect((await w.act(playerId, start, { type: 'extract' })).refusal).toBe('not_extractable');
    const done = (await w.act(playerId, start, { type: 'advance' })).run;
    expect(done.core).toMatchObject({ canExtract: true, unbankedCurrency: 8 });
    const out = await w.act(playerId, done, { type: 'extract' });
    expect(out.run).toMatchObject({ status: 'extracted', settlement: { outcome: 'extracted', cause: 'extraction', earned: 8, banked: 8, lost: 0, balanceAfter: 8 } });
    expect(await w.balance(playerId)).toBe(8);
    expect((await w.act(playerId, out.run, { type: 'advance' })).refusal).toBe('run_over');
  });

  it('keeps the retention share on defeat', async () => {
    const key = await oneRoom(paid([fight('doom', ['brute'])]));
    const { playerId } = await w.player();
    const end = await play(playerId, await w.runs.start(playerId, key), [{ type: 'advance' }, { type: 'advance' }]);
    expect(end).toMatchObject({ status: 'defeated', core: { hp: 0 }, settlement: { cause: 'hp_zero', earned: 8, retentionBasisPoints: 2500, banked: 2, lost: 6, balanceAfter: 2 } });
    expect(await w.balance(playerId)).toBe(2);
  });

  it('settles an abandon like a defeat, once, whatever step the button named', async () => {
    const key = await oneRoom(paid([fight('a', ['grunt'])]));
    const { playerId } = await w.player();
    const start = await w.runs.start(playerId, key);
    await w.act(playerId, start, { type: 'advance' });
    // Abandon carries no step: it is always allowed.
    const [a, b] = await Promise.all([w.runs.act(playerId, start.id, { type: 'abandon' }), w.runs.act(playerId, start.id, { type: 'abandon' })]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'refused']);
    expect(await w.runs.run(playerId, start.id)).toMatchObject({ status: 'abandoned', settlement: { cause: 'abandoned', earned: 8, banked: 2, lost: 6 } });
    expect(await w.balance(playerId)).toBe(2);
    expect(await w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId))).toHaveLength(1);
  });

  it('ends the run without banking when the currency was switched off under it, and says so', async () => {
    const key = await oneRoom(paid(), (d) => {
      d.rooms[0]!.extraction = true;
      d.settings = { progressionCurrency: null, defeatCurrencyRetentionBasisPoints: 2500 };
    });
    const { playerId } = await w.player();
    const done = await play(playerId, await w.runs.start(playerId, key), [{ type: 'advance' }, { type: 'extract' }]);
    expect(done).toMatchObject({ status: 'extracted', currency: null, settlement: { earned: 8, banked: 0, lost: 8, bankingSkipped: 'no_currency', balanceAfter: null } });
    expect(await w.balance(playerId)).toBe(0);
  });
});
