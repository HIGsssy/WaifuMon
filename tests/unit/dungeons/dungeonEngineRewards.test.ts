import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DungeonDefinition, DungeonDefinitionInput } from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  DUNGEON_REWARD_LIMITS, DungeonLootTableBodySchema, DungeonRewardBundleSchema,
  type DungeonRewardBundle, type DungeonRewardGrant,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  readDungeonRewardSnapshot, resolveDungeonRewardDependencies,
} from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonEngineContentError } from '../../../src/modules/dungeons/engine/combat';
import * as lootResolver from '../../../src/modules/dungeons/engine/lootResolver';
import { addAtRiskCurrency, isDungeonRewardPlanV2, rewardResolverSnapshot } from '../../../src/modules/dungeons/engine/rewards';
import { applyDungeonEffects, createDungeonSandbox, sandboxEffectsPort } from '../../../src/modules/dungeons/engine/sandbox';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEngineContext, DungeonInput, DungeonRunState } from '../../../src/modules/dungeons/engine/types';
import { eligibleRewardDefinitions } from '../../../src/modules/equipment/rewardSelector';
import { ExpeditionRewardTableSchema } from '../../../src/modules/content/schemas';
import { FIXED_RULES, TEST_FIGHTER, singleRoomDungeon, testDependencies } from '../../helpers/dungeonFixtures';
import legacyVectors from './fixtures/legacyEngineRewards.v1.json';

afterEach(() => vi.restoreAllMocks());
type Actions = NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>;
const bundle = (over: Partial<DungeonRewardBundle> = {}) => DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [], ...over });
const currency = (key: 'shards' | 'waifubux' | 'essence', amount: number): DungeonRewardGrant => ({
  type: 'currency', currency: key, amount: { min: amount, max: amount },
});
const SELECTOR = { slot: 'attack' as const, rarity: 'R' as const };
const FULL = bundle({ guaranteed: [
  { id: 'shards', grant: currency('shards', 45) },
  { id: 'bux', grant: currency('waifubux', 501) },
  { id: 'essence', grant: currency('essence', 7) },
  { id: 'bond', grant: { type: 'affection', amount: { min: 3, max: 3 } } },
  { id: 'item', grant: { type: 'item', item: 'sticky_joystick', quantity: { min: 2, max: 2 } } },
  { id: 'gear', grant: { type: 'equipment', selector: SELECTOR } },
] });
const MONEY = bundle({ guaranteed: FULL.guaranteed.slice(0, 2) });
const combat = (type: 'combat' | 'boss', enemies = ['grunt'], over: Record<string, unknown> = {}): Actions[number] => ({
  id: 'fight', type, waves: enemies.map((key) => ({ enemy: { key } })), rewards: FULL, ...over,
});
const treasure = (rewards = FULL, id = 'pay'): Actions[number] => ({ id, type: 'reward', rewards });
const definition = (actions: Actions = [treasure()], patch: (d: DungeonDefinitionInput) => void = () => {}) =>
  singleRoomDungeon(actions, (d) => { d.rooms[0]!.extraction = true; d.settings!.defeatCurrencyRetentionBasisPoints = 5000; patch(d); });
const gear = [{ key: 'old_gear', name: 'Old Gear', slot: 'attack' as const, rarity: 'R' as const, enabled: true }];
function context(d: DungeonDefinition): DungeonEngineContext {
  const { snapshot } = resolveDungeonRewardDependencies(d, {
    items: new Map([['sticky_joystick', { name: 'Joystick', category: 'material', enabled: true, maxOwned: null }]]),
    resolveEquipmentSelector: (selector) => eligibleRewardDefinitions(selector, gear),
  });
  return { definition: d, rewards: snapshot, dependencies: testDependencies(), fighter: TEST_FIGHTER, runKey: 't9', combatRules: FIXED_RULES };
}
function driver(ctx: DungeonEngineContext, seed = 42) {
  let state = startDungeonRun(ctx, seed).state;
  return {
    get state() { return state; },
    restore: (restored: DungeonRunState) => { state = restored; },
    apply(input: DungeonInput = { type: 'advance' }) {
      const result = stepDungeon(state, { expectedStep: state.step, ...input }, ctx);
      if (result.status === 'applied') state = result.state;
      return result;
    },
  };
}
function planOf(state: DungeonRunState, key = 'run:t9:hall:pay') {
  const plan = state.rewardClaims[key]!;
  if (!isDungeonRewardPlanV2(plan)) throw new Error('expected v2 plan');
  return plan;
}

describe('v2 activity claims', () => {
  it.each(['combat', 'boss'] as const)('%s pays one-wave victory before routing to completion', (type) => {
    const ctx = context(definition([combat(type, ['grunt'], { outcomes: { victory: { type: 'end_run', outcome: 'completed' } } })]));
    const run = driver(ctx);
    const result = run.apply();
    const plan = planOf(run.state, 'run:t9:hall:fight');
    expect(plan).toEqual(lootResolver.resolveRewardBundle(FULL, rewardResolverSnapshot(ctx.rewards!), 42, { roomId: 'hall', actionId: 'fight' }));
    expect(result.effects.map((e) => e.type)).toEqual(['grant_rewards', 'settle_run']);
    expect(run.state.end).toMatchObject({ earned: 45, banked: 45, waifubux: { earned: 501, banked: 501, lost: 0 } });
    expect(result.log.find((e) => e.type === 'action_completed')!.payload).toMatchObject({ claimKey: 'run:t9:hall:fight', plan, alreadyClaimed: false });
  });

  it.each(['combat', 'boss'] as const)('%s confirm waves pay only after the final victory', (type) => {
    const run = driver(context(definition([combat(type, ['grunt', 'grunt', 'grunt'], { advance: 'confirm' })])));
    for (let i = 0; i < 2; i++) {
      expect(run.apply().effects).toEqual([]);
      expect(run.state.rewardClaims).toEqual({});
      expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([0, 0]);
      expect(run.state.cursor.waveIndex).toBe(i + 1);
    }
    expect(run.apply().effects).toHaveLength(1);
    expect(Object.keys(run.state.rewardClaims)).toEqual(['run:t9:hall:fight']);
    expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([45, 501]);
  });

  it.each(['combat', 'boss'] as const)('%s auto and confirm modes produce the identical reward plan', (type) => {
    const confirm = driver(context(definition([combat(type, ['grunt', 'grunt'], { advance: 'confirm' })])));
    const auto = driver(context(definition([combat(type, ['grunt', 'grunt'], { advance: 'auto' })])));
    confirm.apply();
    confirm.apply();
    const result = auto.apply();
    expect(result.combat).toHaveLength(2);
    expect(auto.state.rewardClaims).toEqual(confirm.state.rewardClaims);
    expect(auto.state.hp).toBe(confirm.state.hp);
    expect(result.effects).toHaveLength(1);
  });

  it.each(['brute', 'wall'])('%s defeat/stalemate after a won wave pays nothing', (enemy) => {
    const ctx = context(definition([combat('boss', ['grunt', enemy], { advance: 'auto' })]));
    ctx.combatRules = { ...FIXED_RULES, maxRounds: 5 };
    const run = driver(ctx);
    const result = run.apply();
    expect(result.combat).toHaveLength(2);
    expect(run.state.status).toBe('defeated');
    expect(run.state.rewardClaims).toEqual({});
    expect(result.effects.every((e) => e.type !== 'grant_rewards')).toBe(true);
    expect(run.state.end).toMatchObject({ earned: 0, waifubux: { earned: 0, banked: 0, lost: 0 } });
  });

  it('declines, condition skips and abandoning between waves never claim', () => {
    const optional = driver(context(definition([combat('combat', ['grunt'], { optional: true })])));
    optional.apply({ type: 'decline' });
    expect(optional.state.rewardClaims).toEqual({});
    const skipped = driver(context(definition([combat('boss', ['grunt'], { when: { type: 'flag', flag: 'lever' } })])));
    expect(skipped.state.rewardClaims).toEqual({});
    const unfinished = driver(context(definition([combat('combat', ['grunt', 'grunt'])])));
    unfinished.apply();
    expect(unfinished.apply({ type: 'abandon' }).effects.every((e) => e.type !== 'grant_rewards')).toBe(true);
    expect(unfinished.state.rewardClaims).toEqual({});
  });

  it('a defeat routed onward pays nothing; a later Treasure may still claim', () => {
    const ctx = context(definition([combat('combat', ['brute'], { outcomes: { defeat: { type: 'next' } } }), treasure(MONEY)]));
    const run = driver(ctx);
    expect(run.apply().effects).toEqual([]);
    expect(run.state.rewardClaims).toEqual({});
    expect(run.state.status).toBe('active');
    expect(run.state.hp).toBe(1);
    run.apply();
    expect(Object.keys(run.state.rewardClaims)).toEqual(['run:t9:hall:pay']);
  });

  it('Treasure claims v2 and keeps both currencies unbanked', () => {
    const ctx = context(definition());
    const run = driver(ctx);
    const result = run.apply();
    const plan = planOf(run.state);
    expect(plan.snapshotHash).toBe(ctx.rewards!.hash);
    expect(plan.atRisk).toEqual({ shards: 45, waifubux: 501 });
    expect(plan.secured).toMatchObject({ essence: 7, affection: 3, items: [{ item: 'sticky_joystick', quantity: 2 }] });
    expect(result.effects).toEqual([{ type: 'grant_rewards', claimKey: 'run:t9:hall:pay', roomId: 'hall', actionId: 'pay', plan }]);
    expect(result.state.recent).toContainEqual({ kind: 'reward', roomId: 'hall', actionId: 'pay', claimKey: 'run:t9:hall:pay', plan });
    expect(run.state.status).toBe('active');
  });

  it('currency-only plans accumulate without emitting immediate grants', () => {
    const run = driver(context(definition([treasure(MONEY, 'first'), treasure(MONEY, 'second')])));
    expect(run.apply().effects).toEqual([]);
    expect(run.apply().effects).toEqual([]);
    expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([90, 1002]);
    expect(Object.keys(run.state.rewardClaims)).toHaveLength(2);
  });

  it.each(['empty', 'miss', 'nothing'] as const)('records %s outcomes and does not reroll an existing claim', (kind) => {
    const rewards = kind === 'miss' ? bundle({ chances: [{ id: 'miss', chanceBasisPoints: 1, grant: currency('shards', 5) }] })
      : kind === 'nothing' ? bundle({ tables: [{ id: 'none', table: 'nothing', draws: 1 }] }) : bundle();
    const d = definition([treasure(rewards)]);
    const ctx = context(d);
    if (kind === 'nothing') ctx.rewards = resolveDungeonRewardDependencies(d, {
      lootTables: new Map([['nothing', { name: 'Nothing', archivedAt: null, body: { guaranteed: [], chances: [], pools: [{ id: 'pool', name: 'Empty', draws: 1, entries: [{ id: 'none', weight: 1, nothing: true }] }] } }]]),
    }).snapshot;
    const run = driver(ctx);
    expect(run.apply().effects).toEqual([]);
    const original = structuredClone(planOf(run.state));
    expect(original.atRisk).toEqual({ shards: 0, waifubux: 0 });
    const restored = JSON.parse(JSON.stringify(run.state)) as DungeonRunState;
    restored.cursor.actionId = 'pay';
    restored.rooms.hall!.completed = false;
    restored.rooms.hall!.actions = {};
    run.restore(restored);
    const resolver = vi.spyOn(lootResolver, 'resolveRewardBundle');
    ctx.rewards = null;
    expect(run.apply().effects).toEqual([]);
    expect(planOf(run.state)).toEqual(original);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['combat', 'boss'] as const)('%s victory retreat/re-entry cannot duplicate a claimed payout', (type) => {
    const d = definition([], (input) => {
      input.rooms.push({ id: 'fight_room', actions: [combat(type, ['grunt'], { outcomes: { victory: { type: 'retreat' } } })] });
      input.connections!.push({ id: 'to_fight', from: 'hall', to: 'fight_room' });
    });
    const ctx = context(d);
    const run = driver(ctx);
    run.apply({ type: 'move', connectionId: 'to_fight' });
    const beforeVictory = run.state;
    const victory = run.apply();
    const expected = planOf(run.state, 'run:t9:fight_room:fight');
    expect(victory.effects).toHaveLength(1);
    expect(run.state.cursor.roomId).toBe('hall');
    expect(run.state.rooms.fight_room!.actions.fight).toBeUndefined();
    expect(stepDungeon(beforeVictory, { type: 'advance', expectedStep: beforeVictory.step }, ctx)).toEqual(victory);
    run.restore(JSON.parse(JSON.stringify(run.state)) as DungeonRunState);
    const roll = vi.spyOn(lootResolver, 'resolveRewardBundle');
    for (let visit = 0; visit < 3; visit++) {
      run.apply({ type: 'move', connectionId: 'to_fight' });
      expect(run.apply().effects).toEqual([]);
      expect(run.state.cursor.roomId).toBe('hall');
    }
    expect(roll).not.toHaveBeenCalled();
    expect(planOf(run.state, 'run:t9:fight_room:fight')).toEqual(expected);
    expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([45, 501]);
  });

  it('stale and repeated actions change nothing; retry/replay retains the deterministic plan and equipment seeds', () => {
    const ctx = context(definition());
    const before = startDungeonRun(ctx, 42).state;
    const input = { type: 'advance', expectedStep: 0 } as const;
    const first = stepDungeon(before, input, ctx);
    expect(stepDungeon(JSON.parse(JSON.stringify(before)), input, ctx)).toEqual(first);
    expect(stepDungeon(first.state, input, ctx)).toMatchObject({ status: 'refused', refusal: 'stale', state: first.state, effects: [] });
    expect(stepDungeon(first.state, { type: 'advance', expectedStep: 1 }, ctx).refusal).toBe('no_action');
    expect(before.rewardClaims).toEqual({});
    expect(planOf(first.state).secured.equipment[0]!.rollSeed).toBeTypeOf('number');
  });

  it('uses verified T6 tables/candidate identities rather than the mutable catalogue', () => {
    const rewards = bundle({ tables: [{ id: 'hoard', table: 'hoard', draws: 1 }] });
    const body = DungeonLootTableBodySchema.parse({ guaranteed: [
      { id: 'shards', grant: currency('shards', 7) }, { id: 'gear', grant: { type: 'equipment', selector: SELECTOR } },
    ], chances: [], pools: [] });
    const liveGear = [...gear];
    const catalog = new Map([['hoard', { name: 'Pinned Hoard', archivedAt: null, body, revision: 3 }]]);
    const d = definition([treasure(rewards)]);
    const snapshot = resolveDungeonRewardDependencies(d, { lootTables: catalog, resolveEquipmentSelector: (selector) => eligibleRewardDefinitions(selector, liveGear) }).snapshot!;
    expect(readDungeonRewardSnapshot(snapshot)).toEqual(snapshot);
    body.guaranteed[0]!.grant = currency('shards', 99);
    liveGear.push({ ...gear[0]!, key: 'new_gear' });
    catalog.clear();
    const ctx = { ...context(d), rewards: snapshot };
    const run = driver(ctx);
    run.apply();
    expect(planOf(run.state).atRisk.shards).toBe(7);
    expect(planOf(run.state).secured.equipment[0]!.definitionKey).toBe('old_gear');
    expect(planOf(run.state).snapshotHash).toBe(snapshot.hash);
  });

  it('missing/unsupported pinned snapshots fail atomically instead of falling back to live or legacy rewards', () => {
    const ctx = context(definition());
    const before = startDungeonRun(ctx, 42).state;
    expect(() => stepDungeon(before, { type: 'advance' }, { ...ctx, rewards: null })).toThrow(DungeonEngineContentError);
    expect(() => stepDungeon(before, { type: 'advance' }, {
      ...ctx, rewards: { ...ctx.rewards!, resolverVersion: 2 } as unknown as NonNullable<DungeonEngineContext['rewards']>,
    })).toThrow('requires its pinned reward snapshot');
    expect(before.rewardClaims).toEqual({});
  });
});

describe('two at-risk currencies and settlement', () => {
  it.each(['extracted', 'completed'] as const)('%s banks all currencies and preserves settlement identity', (outcome) => {
    const run = driver(context(definition([treasure(MONEY)])));
    run.apply();
    const result = run.apply(outcome === 'extracted' ? { type: 'extract' } : { type: 'move', connectionId: 'c_out' });
    expect(run.state.end).toMatchObject({ outcome, earned: 45, banked: 45, lost: 0, retentionBasisPoints: 10_000, waifubux: { earned: 501, banked: 501, lost: 0 } });
    expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([0, 0]);
    expect(result.effects[0]).toMatchObject({ type: 'settle_run', requestKey: 'dungeon_run:v1:t9:settlement' });
    expect(run.apply({ type: 'abandon' }).refusal).toBe('run_over');
  });

  it.each(['brute', 'wall'])('%s loss retains each currency independently with approved rounding', (enemy) => {
    const ctx = context(definition([treasure(MONEY), combat('combat', [enemy])]));
    ctx.combatRules = { ...FIXED_RULES, maxRounds: 5 };
    const run = driver(ctx);
    run.apply();
    run.apply();
    expect(run.state.end).toMatchObject({ outcome: 'defeated', earned: 45, banked: 22, lost: 23, retentionBasisPoints: 5000, waifubux: { earned: 501, banked: 250, lost: 251 } });
    expect(Object.keys(run.state.rewardClaims)).toEqual(['run:t9:hall:pay']);
  });

  it.each([[undefined, 5000, 22, 250], [0, 0, 0, 0], [2500, 2500, 11, 125]])(
    'abandon setting %s selects retention %i', (setting, retention, shards, bux) => {
      const d = definition([treasure(MONEY)], (input) => {
        if (setting !== undefined) input.settings!.abandonCurrencyRetentionBasisPoints = setting;
      });
      const run = driver(context(d));
      run.apply();
      run.apply({ type: 'abandon' });
      expect(run.state.end).toMatchObject({ outcome: 'abandoned', retentionBasisPoints: retention, banked: shards, lost: 45 - shards, waifubux: { earned: 501, banked: bux, lost: 501 - bux } });
    },
  );

  it('scripted defeat uses defeat retention for both currencies', () => {
    const run = driver(context(definition([treasure(MONEY), {
      id: 'end', type: 'rest', outcomes: { done: { type: 'end_run', outcome: 'defeated' } },
    }])));
    run.apply();
    run.apply();
    expect(run.state.end).toMatchObject({ outcome: 'defeated', cause: 'scripted', banked: 22, waifubux: { banked: 250, lost: 251 } });
  });

  it('disconnect/restart alone does not settle or change totals', () => {
    const ctx = context(definition([treasure(MONEY)]));
    const run = driver(ctx);
    expect(run.apply().effects).toEqual([]);
    const resumed = JSON.parse(JSON.stringify(run.state)) as DungeonRunState;
    expect(resumed).toEqual(run.state);
    expect(resumed.status).toBe('active');
    expect(resumed.end).toBeNull();
    expect([resumed.unbankedCurrency, resumed.unbankedWaifubux]).toEqual([45, 501]);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, DUNGEON_REWARD_LIMITS.atRiskCurrencyPerDungeon + 1])('rejects invalid or out-of-bound total %s', (total) => {
    expect(() => addAtRiskCurrency(total)).toThrow(DungeonEngineContentError);
    const run = driver(context(definition([treasure(MONEY)])));
    const before = structuredClone(run.state);
    before.unbankedWaifubux = total;
    expect(() => stepDungeon(before, { type: 'advance' }, context(definition([treasure(MONEY)])))).toThrow(DungeonEngineContentError);
    expect(before.rewardClaims).toEqual({});
  });

  it('accepts the exact approved limit and rejects cumulative overflow before committing a claim', () => {
    const max = DUNGEON_REWARD_LIMITS.atRiskCurrencyPerDungeon;
    expect(addAtRiskCurrency(max)).toBe(max);
    expect(() => addAtRiskCurrency(max, 1)).toThrow(DungeonEngineContentError);
    for (const key of ['unbankedCurrency', 'unbankedWaifubux'] as const) {
      const ctx = context(definition([treasure(MONEY)]));
      const state = startDungeonRun(ctx, 42).state;
      state[key] = max;
      expect(() => stepDungeon(state, { type: 'advance' }, ctx)).toThrow(DungeonEngineContentError);
      expect(state.rewardClaims).toEqual({});
    }
  });

  it('historical engine state without WaifuBux still settles legacy currency without injecting an end block', () => {
    const d = definition([{ id: 'old', type: 'reward', reward: { currency: { min: 45, max: 45 } } }]);
    const ctx = context(d);
    const run = driver(ctx);
    delete run.state.unbankedWaifubux;
    run.apply();
    run.apply({ type: 'abandon' });
    expect(run.state.end).toMatchObject({ earned: 45, banked: 22, lost: 23 });
    expect(Object.hasOwn(run.state.end!, 'waifubux')).toBe(false);
  });
});

describe('sandbox and legacy compatibility', () => {
  it('sandbox records v2 plans, independent at-risk totals and settlement without real grants', async () => {
    const ctx = context(definition());
    const sandbox = createDungeonSandbox({ ...ctx, seed: 42 });
    const claimed = await sandbox.input({ type: 'advance' });
    expect(sandbox.view).toMatchObject({ unbankedCurrency: 45, unbankedWaifubux: 501 });
    expect(sandbox.effects).toEqual(claimed.effects);
    const port = sandboxEffectsPort();
    const receipts = await applyDungeonEffects(port, claimed.effects);
    expect(receipts[0]).toMatchObject({ type: 'grant_rewards', waifubux: 0, equipment: [], plan: planOf(sandbox.state, 'run:sandbox-42:hall:pay') });
    expect(port.recorded).toEqual(claimed.effects);
    await sandbox.input({ type: 'abandon' });
    expect(sandbox.effects.map((e) => e.type)).toEqual(['grant_rewards', 'settle_run']);
    expect(sandbox.state.end).toMatchObject({ banked: 22, waifubux: { banked: 250 } });
  });

  it.each(legacyVectors)('legacy plans/effects/history/settlement match the pre-T9 vector at seed $seed', (vector) => {
    const d = definition([{ id: 'treasure', type: 'reward', reward: { currency: { min: 3, max: 17 }, rewardTable: 'legacy_loot' } }]);
    const ctx = { ...context(d), runKey: 'legacy-vector' };
    ctx.dependencies.rewardTables.legacy_loot = {
      table: ExpeditionRewardTableSchema.parse({ id: 'legacy_loot', enabled: true, waifubux: { min: 11, max: 27 }, groups: [{ id: 'items', enabled: true, rolls: 1, chanceBasisPoints: 10000, entries: [{ itemId: 'sticky_joystick', weight: 1, quantity: 2, enabled: true }] }] }),
      equipmentPools: {},
    };
    const run = driver(ctx, vector.seed);
    const claim = run.apply();
    const extraction = run.apply({ type: 'extract' });
    const actual = {
      seed: vector.seed, plan: claim.state.rewardClaims['run:legacy-vector:hall:treasure'], effects: claim.effects,
      recent: claim.state.recent, claimLog: claim.log, end: extraction.state.end, settlement: extraction.effects,
    };
    expect(JSON.stringify(actual)).toBe(JSON.stringify(vector));
  });

  it('mixed legacy and v2 rewards keep legacy WaifuBux secured and only v2 WaifuBux at risk', () => {
    const d = definition([{ id: 'old', type: 'reward', reward: { currency: { min: 5, max: 5 }, rewardTable: 'legacy' } }, treasure(MONEY)]);
    const ctx = context(d);
    ctx.dependencies.rewardTables.legacy = { table: ExpeditionRewardTableSchema.parse({ id: 'legacy', enabled: true, waifubux: { min: 9, max: 9 }, groups: [] }), equipmentPools: {} };
    const run = driver(ctx);
    expect(run.apply().effects[0]).toMatchObject({ type: 'grant_rewards', plan: { currency: 5, waifubux: 9 } });
    expect(run.state.unbankedWaifubux).toBe(0);
    expect(run.apply().effects).toEqual([]);
    expect([run.state.unbankedCurrency, run.state.unbankedWaifubux]).toEqual([50, 501]);
    run.apply({ type: 'abandon' });
    expect(run.state.end).toMatchObject({ banked: 25, waifubux: { banked: 250, lost: 251 } });
  });
});
