/**
 * Dungeon events in the pure engine: selection, choices, SP checks, outcomes
 * and the sandbox. No database — live persistence arrives with Phase 3B2.
 */
import { describe, expect, it } from 'vitest';
import { DungeonDefinitionSchema, DungeonEventChoiceSchema, DungeonEventPoolSchema, eventPoolOf, type EventAction } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { conditionFacts } from '../../../src/modules/dungeons/engine/conditions';
import {
  EVENT_SP_NEUTRAL,
  EVENT_SP_SPREAD,
  eventCheckChance,
  rollEventCheck,
} from '../../../src/modules/dungeons/engine/eventChecks';
import { analyseEventPool, selectDungeonEvent } from '../../../src/modules/dungeons/engine/events';
import { resolveRewardBundle } from '../../../src/modules/dungeons/engine/lootResolver';
import { rewardResolverSnapshot } from '../../../src/modules/dungeons/engine/rewards';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../../../src/modules/dungeons/engine/sandbox';
import { dungeonRngSource } from '../../../src/modules/dungeons/engine/seeds';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEngineContext, DungeonInput, DungeonRunState } from '../../../src/modules/dungeons/engine/types';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import { DEFAULT_MAX_SP_MODIFIER, SP_NEUTRAL_REFERENCE, SP_REFERENCE_SPREAD } from '../../../src/modules/worldEncounters/checkResolver';
import { EVENT_FIGHTER, eventContext, eventDungeon, eventRewardSnapshot, eventSandboxOptions } from '../../helpers/dungeonEventFixtures';

const definition = eventDungeon();
const ctx = eventContext(definition);
const withKey = eventContext(definition, { inventory: { vault_key: 1 } });

/** Apply inputs in order, each for the step the run is at; every one must be accepted. */
function play(context: DungeonEngineContext, seed: number, ...inputs: DungeonInput[]) {
  let state = startDungeonRun(context, seed).state;
  let last = null as ReturnType<typeof stepDungeon> | null;
  for (const input of inputs) {
    last = stepDungeon(state, { ...input, expectedStep: state.step }, context);
    if (last.status !== 'applied') throw new Error(`refused ${input.type}: ${last.refusal}`);
    state = last.state;
  }
  return { state, last };
}
/** The first seed whose opening hall draw is `eventId` (null: nothing). */
function seedWhereHallDraws(eventId: string | null, context = ctx): number {
  for (let seed = 0; seed < 5000; seed++) {
    if (startDungeonRun(context, seed).state.events!['hall:find']!.eventId === eventId) return seed;
  }
  throw new Error(`no seed draws ${eventId}`);
}
/** A run standing in front of the Sealed Vault, with a quiet hall behind it. */
function atVault(context = ctx, seed = seedWhereHallDraws(null, context)): DungeonRunState {
  return play(context, seed, { type: 'move', connectionId: 'c_vault' }).state;
}
const choose = (state: DungeonRunState, choiceId: string, context = ctx) =>
  stepDungeon(state, { type: 'choose', choiceId, expectedStep: state.step }, context);
const vaultCheckSeed = (success: boolean, context = ctx): number => {
  for (let seed = 0; seed < 5000; seed++) {
    const start = startDungeonRun(context, seed).state;
    if (start.events!['hall:find']!.eventId !== null) continue;
    const check = rollEventCheck({ type: 'sp', baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 }, context.fighter.currentSp,
      { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' }, dungeonRngSource(seed));
    if (check.success === success) return seed;
  }
  throw new Error('no seed');
};

describe('event schemas', () => {
  it('takes exactly one of an outcome, or a check with success and failure', () => {
    const base = { id: 'c', label: 'Choice' };
    const outcome = { text: 'ok' };
    const check = { type: 'sp', baseChanceBasisPoints: 5000 };
    expect(DungeonEventChoiceSchema.safeParse({ ...base, outcome }).success).toBe(true);
    expect(DungeonEventChoiceSchema.parse({ ...base, check, success: outcome, failure: outcome }).check!.maxSpModifierBasisPoints).toBe(1500);
    for (const bad of [
      base,
      { ...base, outcome, check, success: outcome, failure: outcome },
      { ...base, check, success: outcome },
      { ...base, outcome, failure: outcome },
      { ...base, outcome, extra: true },
    ]) expect(DungeonEventChoiceSchema.safeParse(bad).success).toBe(false);
  });

  it('holds the bounds: five choices, six effects, two items, check ranges, weights', () => {
    const choice = (id: string) => ({ id, label: id, outcome: {} });
    const withEvent = (event: Record<string, unknown>) =>
      DungeonDefinitionSchema.safeParse({ ...eventDungeon(), events: [{ id: 'e', title: 'E', text: 'T', choices: [choice('a')], ...event }], eventPools: [], rooms: [{ id: 'hall', kind: 'exit' }], connections: [] }).success;
    expect(withEvent({})).toBe(true);
    expect(withEvent({ choices: ['a', 'b', 'c', 'd', 'e'].map(choice) })).toBe(true);
    expect(withEvent({ choices: ['a', 'b', 'c', 'd', 'e', 'f'].map(choice) })).toBe(false);
    expect(withEvent({ choices: [] })).toBe(false);
    expect(withEvent({ title: '' })).toBe(false);
    const effects = (n: number) => Array.from({ length: n }, () => ({ type: 'heal', basisPoints: 100 }));
    expect(withEvent({ choices: [{ id: 'a', label: 'a', outcome: { effects: effects(6) } }] })).toBe(true);
    expect(withEvent({ choices: [{ id: 'a', label: 'a', outcome: { effects: effects(7) } }] })).toBe(false);
    expect(withEvent({ choices: [{ id: 'a', label: 'a', outcome: { effects: [{ type: 'damage', basisPoints: 0 }] } }] })).toBe(false);
    expect(withEvent({ choices: [{ id: 'a', label: 'a', outcome: { then: { type: 'leave', connectionId: 'x' } } }] })).toBe(false);
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ item: `item_${i}` }));
    expect(withEvent({ choices: [{ id: 'a', label: 'a', items: items(2), outcome: {} }] })).toBe(true);
    expect(withEvent({ choices: [{ id: 'a', label: 'a', items: items(3), outcome: {} }] })).toBe(false);
    expect(withEvent({ choices: [{ id: 'a', label: 'a', items: [{ item: 'x', quantity: 100 }], outcome: {} }] })).toBe(false);
    for (const [check, ok] of [
      [{ type: 'sp', baseChanceBasisPoints: 10000, maxSpModifierBasisPoints: 5000 }, true],
      [{ type: 'sp', baseChanceBasisPoints: 10001 }, false],
      [{ type: 'sp', baseChanceBasisPoints: 5000, maxSpModifierBasisPoints: 5001 }, false],
      [{ type: 'attack', baseChanceBasisPoints: 5000 }, false],
    ] as const) expect(withEvent({ choices: [{ id: 'a', label: 'a', check, success: {}, failure: {} }] })).toBe(ok);
  });

  it('makes a pool entry exactly one of an event and Nothing, once per run by default', () => {
    const pool = (entries: unknown[]) => DungeonEventPoolSchema.safeParse({ id: 'p', name: 'P', entries });
    const parsed = pool([{ id: 'a', weight: 1, eventId: 'e' }, { id: 'b', weight: 1, nothing: true }]);
    expect(parsed.success && parsed.data.entries[0]).toMatchObject({ oncePerRun: true });
    expect(pool([{ id: 'a', weight: 1, eventId: 'e', nothing: true }]).success).toBe(false);
    expect(pool([{ id: 'a', weight: 1 }]).success).toBe(false);
    expect(pool([{ id: 'a', weight: 0, eventId: 'e' }]).success).toBe(false);
    expect(pool([{ id: 'a', weight: 1_000_001, eventId: 'e' }]).success).toBe(false);
    expect(pool([]).success).toBe(false);
    expect(pool(Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, weight: 1, nothing: true }))).success).toBe(false);
  });
});

describe('selection', () => {
  it('presents a specific event on arrival and stores it on the run', () => {
    const state = atVault();
    expect(state.events!['vault:door']).toEqual({ eventId: 'sealed_vault', status: 'offered', selectedStep: state.step - 1 });
    const view = describeDungeonRun(state, ctx);
    expect(view.phase).toBe('action');
    expect(view.action).toMatchObject({ id: 'door', type: 'event', event: { eventId: 'sealed_vault', title: 'The Sealed Vault' } });
    // `secret` is unavailable and hidden; the rest are listed in authored order.
    expect(view.action!.event!.choices.map((c) => c.id)).toEqual(['use_key', 'pick_lock', 'force', 'leave']);
  });

  it('rolls a pool once, at the start for the entrance, from its own stream', () => {
    const seed = seedWhereHallDraws('buried_crate');
    const started = startDungeonRun(ctx, seed);
    const instance = started.state.events!['hall:find']!;
    expect(instance).toMatchObject({ eventId: 'buried_crate', status: 'offered', selectedStep: 0, pool: { poolId: 'scrapheap_finds', entryId: 'e_crate', totalWeight: 100 } });
    expect(instance.pool!.roll).toBe(dungeonRngSource(seed).stream('event', 'hall', 'find', 'pool').intInclusive(0, 99));
    expect(instance.pool!.eligible).toEqual(['e_crate', 'e_drone', 'e_trader', 'e_nothing']);
    // The same arguments give the same run, every time.
    expect(startDungeonRun(ctx, seed)).toEqual(started);
  });

  it('draws in proportion to the weights', () => {
    const action = definition.rooms[0]!.actions[0] as EventAction;
    const counts: Record<string, number> = {};
    const runs = 10_000;
    for (let seed = 0; seed < runs; seed++) {
      const state = { ...startDungeonRun(ctx, seed).state, events: {} };
      const drawn = selectDungeonEvent(definition, action, { roomId: 'hall', actionId: 'find' }, state, conditionFacts(state), dungeonRngSource(seed));
      counts[String(drawn.eventId)] = (counts[String(drawn.eventId)] ?? 0) + 1;
    }
    for (const [eventId, share] of [['buried_crate', 0.3], ['sparking_drone', 0.2], ['scavenger_trader', 0.1], ['null', 0.4]] as const) {
      expect(Math.abs(counts[eventId]! / runs - share)).toBeLessThan(0.02);
    }
  });

  it('leaves a conditional entry out of the draw, and an event already seen', () => {
    const pool = eventPoolOf(definition, 'scrapheap_finds')!;
    const facts = (flags: Record<string, boolean>) => ({ flags, playerFlags: {}, rooms: {} });
    expect(analyseEventPool(pool, facts({})).entries.map((e) => [e.id, e.probability])).toEqual([['e_crate', 0.3], ['e_drone', 0.2], ['e_trader', 0.1], ['e_nothing', 0.4]]);
    const alarmed = analyseEventPool(pool, facts({ alarm_triggered: true }), new Set(['buried_crate']));
    expect(alarmed.entries.map((e) => [e.id, e.eligible, e.reason])).toEqual([
      ['e_crate', false, 'already_seen'], ['e_drone', true, null], ['e_trader', false, 'condition'], ['e_nothing', true, null],
    ]);
    expect(alarmed.totalWeight).toBe(60);
    expect(alarmed.entries[1]!.probability).toBeCloseTo(1 / 3);
    expect(alarmed.nothingProbability).toBeCloseTo(2 / 3);

    // In play: whatever the hall drew is never drawn again in the heap.
    for (let seed = 0; seed < 400; seed++) {
      let state = startDungeonRun(withKey, seed).state;
      const first = state.events!['hall:find']!.eventId;
      if (first === null || first === 'sparking_drone') continue;
      state = stepDungeon(state, { type: 'choose', choiceId: first === 'buried_crate' ? 'dig' : 'carry_on' }, withKey).state;
      state = stepDungeon(state, { type: 'move', connectionId: 'c_vault' }, withKey).state;
      state = stepDungeon(state, { type: 'choose', choiceId: 'use_key' }, withKey).state;
      state = stepDungeon(state, { type: 'advance' }, withKey).state;
      state = stepDungeon(state, { type: 'move', connectionId: 'c_heap' }, withKey).state;
      const second = state.events!['heap:find']!;
      expect(second.eventId).not.toBe(first);
      expect(second.pool!.eligible).not.toContain(first === 'buried_crate' ? 'e_crate' : 'e_trader');
    }
  });

  it('presents nothing when no entry is eligible, and says so only when the entry has a line', () => {
    const empty = eventDungeon((d) => {
      d.eventPools![0]!.entries = [{ id: 'only', weight: 1, eventId: 'scavenger_trader', when: { type: 'flag', flag: 'alarm_triggered' } }];
    });
    const started = startDungeonRun(eventContext(empty), 1);
    expect(started.state.events!['hall:find']).toMatchObject({ eventId: null, status: 'nothing', pool: { entryId: null, eligible: [], totalWeight: 0, roll: null } });
    expect(started.state.recent).toContainEqual({ kind: 'event_nothing', roomId: 'hall', actionId: 'find', text: '' });
    expect(started.state.rooms.hall).toMatchObject({ completed: true, actions: { find: { status: 'completed', outcome: 'nothing' } } });

    const quiet = startDungeonRun(ctx, seedWhereHallDraws(null));
    expect(quiet.state.recent).toContainEqual({ kind: 'event_nothing', roomId: 'hall', actionId: 'find', text: 'Nothing but rust.' });
    expect(describeDungeonRun(quiet.state, ctx).phase).toBe('connections');
  });

  it('never re-rolls: walking away and coming back offers the same event', () => {
    const seed = seedWhereHallDraws(null);
    const before = atVault(ctx, seed);
    const away = choose(before, 'leave');
    expect(away.status).toBe('applied');
    expect(away.effects).toEqual([]);
    expect(away.state.cursor).toMatchObject({ roomId: 'hall', actionId: null });
    expect(away.state.events!['vault:door']).toEqual(before.events!['vault:door']);
    expect(away.state.rooms.vault).toMatchObject({ completed: false, resumeAt: 'door' });
    expect(away.state.recent).toContainEqual(expect.objectContaining({ kind: 'event', choiceId: 'leave', walkedAway: true }));

    const back = stepDungeon(away.state, { type: 'move', connectionId: 'c_vault', expectedStep: away.state.step }, ctx);
    expect(back.state.events).toEqual(away.state.events);
    expect(describeDungeonRun(back.state, ctx).action!.event!.eventId).toBe('sealed_vault');

    // A pooled event too: the heap's draw is the same draw on return.
    const heapSeed = (() => {
      for (let s = 0; s < 5000; s++) {
        if (startDungeonRun(ctx, s).state.events!['hall:find']!.eventId !== null) continue;
        const at = play(ctx, s, { type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'force' }, { type: 'advance' }, { type: 'move', connectionId: 'c_heap' }).state;
        if (at.events!['heap:find']!.eventId === 'buried_crate') return s;
      }
      throw new Error('no seed');
    })();
    const heap = play(ctx, heapSeed, { type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'force' }, { type: 'advance' }, { type: 'move', connectionId: 'c_heap' }).state;
    const left = choose(heap, 'leave').state;
    expect(left.cursor.roomId).toBe('vault');
    const returned = stepDungeon(left, { type: 'move', connectionId: 'c_heap', expectedStep: left.step }, ctx).state;
    expect(returned.events!['heap:find']).toEqual(heap.events!['heap:find']);
  });
});

describe('choices', () => {
  it('judges availability on the run and the inventory it is handed', () => {
    const state = atVault();
    const choices = (context: DungeonEngineContext, s = state) => Object.fromEntries(describeDungeonRun(s, context).action!.event!.choices.map((c) => [c.id, c]));
    expect(choices(ctx).use_key).toMatchObject({ available: false, unavailableReason: 'items', unavailableText: 'You have no Vault Key.' });
    expect(choices(withKey).use_key).toMatchObject({ available: true, unavailableReason: null });
    expect(choices(ctx).secret).toBeUndefined();
    const alarmed = { ...state, flags: { alarm_triggered: true } };
    expect(choices(ctx, alarmed).secret).toMatchObject({ available: true });
  });

  it('tells a screen that a required item is spent on selecting, whatever a check does', () => {
    const state = atVault(withKey);
    const view = describeDungeonRun(state, withKey).action!.event!;
    expect(view.choices.find((c) => c.id === 'use_key')).toMatchObject({
      consumesOnSelect: true,
      items: [{ item: 'vault_key', quantity: 1, consume: true, owned: 1 }],
      check: null,
      walksAway: false,
    });
    expect(view.choices.find((c) => c.id === 'pick_lock')).toMatchObject({ consumesOnSelect: false, check: { chanceBasisPoints: 5500, sp: 200 } });
    expect(view.choices.find((c) => c.id === 'leave')).toMatchObject({ walksAway: true, consumesOnSelect: false });

    // A check that also costs an item: the item goes before the roll and on a failure too.
    const costly = eventDungeon((d) => {
      d.events![0]!.choices[1]!.items = [{ item: 'lockpick', quantity: 2, consume: true }];
    });
    const context = eventContext(costly, { inventory: { lockpick: 2 } });
    const failing = vaultCheckSeed(false, context);
    const failed = choose(atVault(context, failing), 'pick_lock', context);
    expect(failed.state.events!['vault:door']!.resolution).toMatchObject({ branch: 'failure' });
    expect(failed.effects).toEqual([{ type: 'consume_items', key: 'run:test:vault:door:consume', roomId: 'vault', actionId: 'door', items: [{ item: 'lockpick', quantity: 2 }] }]);
  });

  it('refuses what cannot be done and leaves the run untouched', () => {
    const state = atVault();
    const frozen = structuredClone(state);
    const refusal = (input: DungeonInput, context = ctx) => {
      const result = stepDungeon(state, { ...input, expectedStep: state.step }, context);
      expect(result.status).toBe('refused');
      expect(result.state).toBe(state);
      expect(result.effects).toEqual([]);
      expect(result.log).toEqual([]);
      return result.refusal;
    };
    expect(refusal({ type: 'advance' })).toBe('choice_required');
    expect(refusal({ type: 'decline' })).toBe('not_optional');
    expect(refusal({ type: 'choose', choiceId: 'nope' })).toBe('choice_unknown');
    expect(refusal({ type: 'choose', choiceId: 'use_key' })).toBe('choice_unavailable');
    expect(refusal({ type: 'choose', choiceId: 'secret' })).toBe('choice_unavailable');
    expect(refusal({ type: 'move', connectionId: 'c_heap' })).toBe('action_pending');
    expect(stepDungeon(state, { type: 'choose', choiceId: 'force', expectedStep: state.step + 1 }, ctx).refusal).toBe('stale');
    expect(state).toEqual(frozen);

    // A choice on something that is not an event, and with nothing pending.
    const quiet = startDungeonRun(ctx, seedWhereHallDraws(null)).state;
    expect(stepDungeon(quiet, { type: 'choose', choiceId: 'force' }, ctx).refusal).toBe('no_action');
    const resting = choose(state, 'force').state;
    expect(describeDungeonRun(resting, ctx).action!.type).toBe('rest');
    expect(stepDungeon(resting, { type: 'choose', choiceId: 'force' }, ctx).refusal).toBe('not_available');
  });

  it('resolves an event once: a repeated press is stale, and a fresh one has nothing to answer', () => {
    const state = atVault(withKey);
    const first = choose(state, 'use_key', withKey);
    expect(first.status).toBe('applied');
    // The retry Discord sends carries the old step.
    expect(choose(state, 'use_key', withKey).state).toEqual(first.state);
    const retry = stepDungeon(first.state, { type: 'choose', choiceId: 'use_key', expectedStep: state.step }, withKey);
    expect(retry).toMatchObject({ status: 'refused', refusal: 'stale', effects: [] });
    expect(stepDungeon(first.state, { type: 'choose', choiceId: 'force', expectedStep: first.state.step }, withKey).refusal).toBe('not_available');
    expect(first.state.events!['vault:door']).toMatchObject({ status: 'resolved', resolution: { choiceId: 'use_key', branch: 'outcome', step: state.step } });
  });

  it('does not offer walking away where there is nowhere to go back to', () => {
    const seed = seedWhereHallDraws('buried_crate');
    const state = startDungeonRun(ctx, seed).state;
    expect(state.cursor.cameFrom).toBeNull();
    const leave = describeDungeonRun(state, ctx).action!.event!.choices.find((c) => c.id === 'leave')!;
    expect(leave).toMatchObject({ available: false, unavailableReason: 'no_way_back' });
    expect(choose(state, 'leave').refusal).toBe('choice_unavailable');
    expect(choose(state, 'dig').status).toBe('applied');
  });
});

describe('SP checks', () => {
  const check = { type: 'sp' as const, baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 };

  it('uses the World Encounter curve without importing it', () => {
    expect(EVENT_SP_NEUTRAL).toBe(SP_NEUTRAL_REFERENCE);
    expect(EVENT_SP_SPREAD).toBe(SP_REFERENCE_SPREAD);
    expect(DungeonEventChoiceSchema.parse({ id: 'c', label: 'c', check: { type: 'sp', baseChanceBasisPoints: 1 }, success: {}, failure: {} }).check!.maxSpModifierBasisPoints)
      .toBe(Math.round(DEFAULT_MAX_SP_MODIFIER * 10_000));
  });

  it('moves the author’s chance by a bounded amount and is never certain', () => {
    expect(eventCheckChance(check, 200)).toBe(5500);
    expect(eventCheckChance(check, 350)).toBe(7000);
    expect(eventCheckChance(check, 9999)).toBe(7000);
    expect(eventCheckChance(check, 50)).toBe(4000);
    expect(eventCheckChance(check, 0)).toBe(4000);
    expect(eventCheckChance(check, 90)).toBe(4400);
    expect(eventCheckChance(check, 275)).toBe(6250);
    expect(eventCheckChance(check, undefined)).toBe(4000);
    expect(eventCheckChance({ ...check, baseChanceBasisPoints: 10_000 }, 350)).toBe(9500);
    expect(eventCheckChance({ ...check, baseChanceBasisPoints: 0 }, 50)).toBe(500);
    expect(eventCheckChance({ ...check, maxSpModifierBasisPoints: 0 }, 350)).toBe(5500);
  });

  it('rolls the same for the same run, action and choice, and close to the stated chance', () => {
    const place = { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' };
    const once = rollEventCheck(check, 200, place, dungeonRngSource(7));
    expect(rollEventCheck(check, 200, place, dungeonRngSource(7))).toEqual(once);
    expect(once).toEqual({ sp: 200, chanceBasisPoints: 5500, roll: once.roll, success: once.roll < 5500 });
    // Another choice of the same event rolls from another stream.
    expect(dungeonRngSource(7).seedOf('event', 'vault', 'door', 'check', 'pick_lock')).not.toBe(dungeonRngSource(7).seedOf('event', 'vault', 'door', 'check', 'other'));
    let wins = 0;
    for (let seed = 0; seed < 10_000; seed++) if (rollEventCheck(check, 200, place, dungeonRngSource(seed)).success) wins++;
    expect(Math.abs(wins / 10_000 - 0.55)).toBeLessThan(0.02);
  });

  it('reads the pinned SP of the run’s fighter and records what it rolled', () => {
    const strong = eventContext(definition, { fighter: { ...EVENT_FIGHTER, currentSp: 350 } });
    const seed = vaultCheckSeed(true);
    const result = choose(atVault(ctx, seed), 'pick_lock');
    const resolution = result.state.events!['vault:door']!.resolution!;
    expect(resolution).toMatchObject({ choiceId: 'pick_lock', branch: 'success', check: { sp: 200, chanceBasisPoints: 5500, success: true } });
    expect(choose(atVault(ctx, seed), 'pick_lock').state).toEqual(result.state);
    expect(describeDungeonRun(atVault(strong, seed), strong).action!.event!.choices.find((c) => c.id === 'pick_lock')!.check).toEqual({ chanceBasisPoints: 7000, sp: 350 });
    expect(choose(atVault(strong, seed), 'pick_lock', strong).state.events!['vault:door']!.resolution!.check).toMatchObject({ sp: 350, chanceBasisPoints: 7000, roll: resolution.check!.roll });
  });
});

describe('outcomes', () => {
  it('spends the item first, then sets flags and claims the rewards, in one step', () => {
    const state = atVault(withKey);
    const result = choose(state, 'use_key', withKey);
    expect(result.effects.map((e) => e.type)).toEqual(['consume_items', 'grant_rewards']);
    expect(result.effects[0]).toEqual({ type: 'consume_items', key: 'run:test:vault:door:consume', roomId: 'vault', actionId: 'door', items: [{ item: 'vault_key', quantity: 1 }] });
    expect(result.state.flags).toEqual({ vault_opened: true });
    expect(result.state.step).toBe(state.step + 1);

    // The Phase 2 resolver, claim key and at-risk rules, unchanged.
    const bundle = definition.events![0]!.choices[0]!.outcome!.rewards!;
    const plan = resolveRewardBundle(bundle, rewardResolverSnapshot(eventRewardSnapshot(definition)), state.seed, { roomId: 'vault', actionId: 'door' });
    expect(result.state.rewardClaims).toEqual({ 'run:test:vault:door': plan });
    expect(result.effects[1]).toMatchObject({ type: 'grant_rewards', claimKey: 'run:test:vault:door', plan });
    expect(plan.secured.items).toEqual([{ item: 'scrap_parts', quantity: 2 }]);
    expect(result.state.unbankedCurrency).toBe(5);
    expect(result.state.rooms.vault!.actions.door).toMatchObject({ status: 'completed', outcome: 'resolved', detail: { kind: 'event', eventId: 'sealed_vault', choiceId: 'use_key', branch: 'outcome', check: null } });
    expect(result.log.find((l) => l.type === 'action_completed' && l.actionId === 'door')!.payload).toMatchObject({ actionType: 'event', claimKey: 'run:test:vault:door', consumed: [{ item: 'vault_key', quantity: 1 }] });
  });

  it('lets a flag set by a choice open a later activity and a later path', () => {
    const opened = choose(atVault(), 'force').state;
    // The breather only exists once the vault is open.
    expect(describeDungeonRun(opened, ctx).action).toMatchObject({ id: 'breather', type: 'rest' });
    const jammedSeed = vaultCheckSeed(false);
    const jammed = choose(atVault(ctx, jammedSeed), 'pick_lock').state;
    expect(jammed.flags).toEqual({ alarm_triggered: true });
    expect(jammed.rooms.vault).toMatchObject({ completed: true, actions: { breather: { status: 'condition_skipped' } } });

    const lift = (state: DungeonRunState) => {
      let at = stepDungeon(state, { type: 'move', connectionId: 'c_heap' }, ctx).state;
      const offered = describeDungeonRun(at, ctx).action?.event;
      if (offered) at = stepDungeon(at, { type: 'choose', choiceId: offered.choices.find((c) => c.available && !c.walksAway)!.id }, ctx).state;
      return at.status === 'active' ? describeDungeonRun(at, ctx).connections.find((c) => c.id === 'c_lift') : null;
    };
    const afterOpen = lift(stepDungeon(opened, { type: 'advance' }, ctx).state);
    if (afterOpen) expect(afterOpen.open).toBe(true);
    const afterJam = lift(jammed);
    if (afterJam) expect(afterJam).toMatchObject({ open: false, lockedText: 'The lift has no power.' });
    expect(afterOpen ?? afterJam).not.toBeNull();
  });

  it('heals and hurts by a share of max HP, and never kills', () => {
    const state = atVault();
    const forced = choose(state, 'force');
    // 25% of 370, rounded toward zero.
    expect(forced.state.hp).toBe(370 - 92);
    expect(forced.state.recent).toContainEqual(expect.objectContaining({ kind: 'event', hpBefore: 370, hpAfter: 278, flags: [{ flag: 'vault_opened', value: true }], consumed: [] }));

    const hurt = { ...state, hp: 100 };
    const healed = choose({ ...hurt, seed: vaultCheckSeed(true) }, 'pick_lock');
    expect(healed.state.events!['vault:door']!.resolution!.branch).toBe('success');
    expect(healed.state.hp).toBe(137);
    expect(choose({ ...state, hp: 369, seed: vaultCheckSeed(true) }, 'pick_lock').state.hp).toBe(370);

    // 99% of max HP from 5 HP: the Buddy is left standing.
    const droneSeed = seedWhereHallDraws('sparking_drone');
    const frail = { ...startDungeonRun(ctx, droneSeed).state, hp: 5 };
    const salvaged = choose(frail, 'salvage');
    expect(salvaged.state.hp).toBe(1);
    expect(salvaged.state.status).toBe('active');
    expect(choose({ ...frail, hp: 1 }, 'salvage').state.hp).toBe(1);
  });

  it('follows the outcome’s own destination, else the event action’s routing', () => {
    const droneSeed = seedWhereHallDraws('sparking_drone');
    const ended = choose(startDungeonRun(ctx, droneSeed).state, 'shut_down');
    expect(ended.state).toMatchObject({ status: 'completed', end: { outcome: 'completed', cause: 'scripted' } });
    expect(ended.effects.map((e) => e.type)).toEqual(['settle_run']);

    const routed = eventDungeon((d) => {
      d.rooms[1]!.actions = [
        { id: 'door', type: 'event', source: { kind: 'event', eventId: 'sealed_vault' }, next: { type: 'room_complete' } },
        { id: 'never', type: 'rest' },
      ];
      d.events![0]!.choices[2]!.outcome!.then = { type: 'next' };
    });
    const routedCtx = eventContext(routed);
    // `force` says "next" itself, so the rest follows; `secret` leaves it to the action, which completes the room.
    expect(describeDungeonRun(choose(atVault(routedCtx), 'force', routedCtx).state, routedCtx).action).toMatchObject({ id: 'never' });
    const whispered = choose({ ...atVault(routedCtx), flags: { alarm_triggered: true } }, 'secret', routedCtx).state;
    expect(whispered.rooms.vault).toMatchObject({ completed: true });
    expect(whispered.rooms.vault!.actions.never).toBeUndefined();
  });

  it('does not touch a run without events: no event state is created', () => {
    const state = atVault();
    expect(Object.keys(state.events!)).toEqual(['hall:find', 'vault:door']);
    const plain = eventDungeon((d) => {
      delete d.events;
      delete d.eventPools;
      d.rooms = d.rooms.map((room) => ({ ...room, actions: [] }));
    });
    expect('events' in startDungeonRun(eventContext(plain, { rewards: null }), 1).state).toBe(false);
  });
});

describe('sandbox', () => {
  it('plays the same rules as the engine, with an assumed inventory and nothing spent', async () => {
    const seed = seedWhereHallDraws(null);
    const sandbox = createDungeonSandbox(eventSandboxOptions(definition, { seed, inventory: { vault_key: 1 } }));
    const live = eventContext(definition, { inventory: { vault_key: 1 }, runKey: `sandbox-${seed}` });
    let state = startDungeonRun(live, seed).state;
    expect(sandbox.state).toEqual(state);
    for (const input of [{ type: 'move', connectionId: 'c_vault' }, { type: 'choose', choiceId: 'use_key' }, { type: 'advance' }] as DungeonInput[]) {
      const expected = stepDungeon(state, { ...input, expectedStep: state.step }, live);
      const step = await sandbox.input(input);
      expect(step.status).toBe('applied');
      expect(step.effects).toEqual(expected.effects);
      expect(step.log).toEqual(expected.log);
      expect(sandbox.state).toEqual(expected.state);
      expect(step.view).toEqual(describeDungeonRun(expected.state, live));
      state = expected.state;
    }
    expect(sandbox.effects.map((e) => e.type)).toEqual(['consume_items', 'grant_rewards']);

    const without = createDungeonSandbox(eventSandboxOptions(definition, { seed }));
    await without.input({ type: 'move', connectionId: 'c_vault' });
    expect((await without.input({ type: 'choose', choiceId: 'use_key' })).refusal).toBe('choice_unavailable');
    expect((await without.input({ type: 'advance' })).refusal).toBe('choice_required');
  });

  it('auto-plays an event dungeon to its end, from any opening draw', async () => {
    for (const eventId of ['buried_crate', 'sparking_drone', 'scavenger_trader', null]) {
      const sandbox = createDungeonSandbox(eventSandboxOptions(definition, { seed: seedWhereHallDraws(eventId) }));
      const played = await autoPlayDungeonSandbox(sandbox);
      expect(played.stoppedBy).toBe('ended');
      expect(played.view.status).toBe('completed');
    }
  });
});
