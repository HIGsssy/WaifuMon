/**
 * The pure dungeon engine, driven through the sandbox — the same
 * `stepDungeon` live gameplay calls, with effects recorded instead of applied.
 */
import { describe, expect, it } from 'vitest';
import type { DungeonDefinitionInput } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../../../src/modules/dungeons/engine/sandbox';
import { dungeonRngSource } from '../../../src/modules/dungeons/engine/seeds';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEngineContext, DungeonRunState } from '../../../src/modules/dungeons/engine/types';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import {
  FIXED_RULES,
  STARTER,
  TEST_FIGHTER,
  singleRoomDungeon,
  testDependencies,
  testDungeon,
  testSandbox,
} from '../../helpers/dungeonFixtures';

type Actions = NonNullable<DungeonDefinitionInput['rooms'][number]['actions']>;

const fight = (id: string, enemies: string[], extra: Record<string, unknown> = {}): Actions[number] => ({
  id,
  type: 'combat',
  waves: enemies.map((key) => ({ enemy: { key } })),
  ...extra,
});

function context(definition: ReturnType<typeof testDungeon>): DungeonEngineContext {
  return { definition, dependencies: testDependencies(), fighter: TEST_FIGHTER, runKey: 'unit', combatRules: FIXED_RULES };
}

describe('room sequences', () => {
  it('runs a room’s actions in order and completes the room after the last', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt']), { id: 'r', type: 'rest' }, fight('b', ['grunt'])]));
    expect(sandbox.view.action?.id).toBe('a');
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.action?.id).toBe('r');
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.action?.id).toBe('b');
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.phase).toBe('connections');
    expect(sandbox.view.room.completed).toBe(true);
    expect(sandbox.state.rooms.hall!.actions).toMatchObject({
      a: { status: 'completed', outcome: 'victory' },
      r: { status: 'completed', outcome: 'done' },
      b: { status: 'completed', outcome: 'victory' },
    });
  });

  it('jumps forward on an outcome, leaving the actions in between untouched', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([fight('a', ['grunt'], { outcomes: { victory: { type: 'action', actionId: 'c' } } }), fight('b', ['brute']), fight('c', ['grunt'])]),
    );
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.action?.id).toBe('c');
    expect(sandbox.state.rooms.hall!.actions.b).toBeUndefined();
  });

  it('completes the room early on `room_complete`, whatever follows', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([fight('a', ['grunt'], { outcomes: { victory: { type: 'room_complete' } } }), fight('never', ['brute'])]),
    );
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.phase).toBe('connections');
    expect(sandbox.view.room.completed).toBe(true);
    expect(sandbox.state.rooms.hall!.actions.never).toBeUndefined();
  });

  it('follows `next` for the success outcome only — never for a decline', async () => {
    const actions: Actions = [
      { id: 'r', type: 'rest', optional: true, next: { type: 'action', actionId: 'far' } },
      fight('near', ['grunt']),
      fight('far', ['grunt']),
    ];
    const took = testSandbox(singleRoomDungeon(actions));
    await took.input({ type: 'advance' });
    expect(took.view.action?.id).toBe('far');

    const declined = testSandbox(singleRoomDungeon(actions));
    await declined.input({ type: 'decline' });
    expect(declined.view.action?.id).toBe('near');
  });

  it('prefers outcome-specific routing over `next`', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([
        { id: 'r', type: 'rest', next: { type: 'action', actionId: 'b' }, outcomes: { done: { type: 'action', actionId: 'c' } } },
        fight('b', ['grunt']),
        fight('c', ['grunt']),
      ]),
    );
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.action?.id).toBe('c');
  });

  it('walks an explicit `leave` through its connection in the same step', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([fight('a', ['grunt']), { id: 'go', type: 'leave', connectionId: 'c_out' }, fight('never', ['brute'])]),
    );
    const step = await sandbox.input({ type: 'advance' });
    // Out is an exit room with no actions: entering it finishes the run.
    expect(step.view.status).toBe('completed');
    expect(sandbox.state.end).toMatchObject({ outcome: 'completed', cause: 'exit_reached', roomId: 'out' });
    expect(sandbox.state.step).toBe(1);
  });
});

describe('optional and conditional actions', () => {
  const actions: Actions = [
    { id: 'hidden', type: 'rest', when: { type: 'flag', flag: 'lever' } },
    { id: 'offered', type: 'rest', optional: true },
    { id: 'pull', type: 'set_flag', flag: 'lever' },
    { id: 'shown', type: 'rest', when: { type: 'flag', flag: 'lever' } },
    { id: 'door', type: 'gate', requires: { type: 'flag', flag: 'lever', equals: false }, outcomes: { blocked: { type: 'room_complete' } } },
  ];

  it('keeps the four ways an action ends apart, in state and in the log', async () => {
    const sandbox = testSandbox(singleRoomDungeon(actions));
    // `hidden` was skipped by its condition before the player saw anything.
    expect(sandbox.view.action?.id).toBe('offered');
    expect(sandbox.view.action?.optional).toBe(true);
    await sandbox.input({ type: 'decline' });
    // The flag is set without input; `shown` now passes its condition.
    expect(sandbox.view.action?.id).toBe('shown');
    expect(sandbox.view.flags).toEqual({ lever: true });
    await sandbox.input({ type: 'advance' });

    const records = sandbox.state.rooms.hall!.actions;
    expect(records.hidden).toMatchObject({ status: 'condition_skipped', outcome: null });
    expect(records.offered).toMatchObject({ status: 'declined', outcome: 'declined' });
    expect(records.pull).toMatchObject({ status: 'completed', outcome: 'done' });
    expect(records.shown).toMatchObject({ status: 'completed', outcome: 'done' });
    expect(records.door).toMatchObject({ status: 'failed', outcome: 'blocked' });

    const types = sandbox.log.filter((l) => l.roomId === 'hall' && l.actionId).map((l) => `${l.actionId}:${l.type}`);
    expect(types).toEqual(['hidden:action_skipped', 'offered:action_declined', 'pull:action_completed', 'shown:action_completed', 'door:action_failed']);
  });

  it('refuses to decline an action that is not optional', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt'])]));
    const step = await sandbox.input({ type: 'decline' });
    expect(step).toMatchObject({ status: 'refused', refusal: 'not_optional' });
    expect(sandbox.state.step).toBe(0);
  });

  it('refuses to decline a fight that has already begun', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt', 'grunt'], { optional: true })]));
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.action?.optional).toBe(false);
    expect(await sandbox.input({ type: 'decline' })).toMatchObject({ status: 'refused', refusal: 'not_optional' });
  });
});

describe('chained combat', () => {
  it('fights waves one per step, carrying HP, and has no three-wave limit', async () => {
    const waves = ['grunt', 'grunt', 'grunt', 'grunt', 'grunt', 'grunt'];
    const sandbox = testSandbox(singleRoomDungeon([fight('long', waves)]));
    const hp: number[] = [sandbox.view.hp];
    for (let i = 0; i < waves.length; i++) {
      expect(sandbox.view.action?.wave).toMatchObject({ index: i, count: waves.length });
      await sandbox.input({ type: 'advance' });
      hp.push(sandbox.view.hp);
    }
    // Each grunt costs the starter build exactly one 36-damage hit.
    expect(hp).toEqual([370, 334, 298, 262, 226, 190, 154]);
    expect(sandbox.view.phase).toBe('connections');
    expect(sandbox.state.step).toBe(waves.length);
    const record = sandbox.state.rooms.hall!.actions.long!;
    expect(record.detail).toMatchObject({ kind: 'combat', waveCount: 6 });
    expect(record.detail?.kind === 'combat' && record.detail.waves.map((w) => [w.hpBefore, w.hpAfter])).toEqual([
      [370, 334], [334, 298], [298, 262], [262, 226], [226, 190], [190, 154],
    ]);
  });

  it('carries HP across actions and a rest between them', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([fight('a', ['grunt', 'grunt']), { id: 'r', type: 'rest', healBasisPoints: 1000 }, fight('b', ['grunt'])]),
    );
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.hp).toBe(298);
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.hp).toBe(298 + 37); // 10% of 370, rounded toward zero
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.hp).toBe(298 + 37 - 36);
  });

  it('fights every wave in one step when the action advances automatically', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt', 'grunt', 'grunt'], { advance: 'auto' })]));
    const step = await sandbox.input({ type: 'advance' });
    expect(sandbox.state.step).toBe(1);
    expect(sandbox.view.hp).toBe(370 - 3 * 36);
    expect(step.log.filter((l) => l.type === 'combat_wave_resolved')).toHaveLength(3);
    expect(sandbox.view.recent.filter((r) => r.kind === 'wave')).toHaveLength(3);
  });

  it('gives every wave its own seed', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt', 'grunt', 'grunt']), fight('b', ['grunt'])]));
    await autoPlayDungeonSandbox(sandbox);
    const seeds = sandbox.log.filter((l) => l.type === 'combat_wave_resolved').map((l) => l.payload.combatSeed);
    expect(seeds).toHaveLength(4);
    expect(new Set(seeds).size).toBe(4);
  });

  it('ends the run as defeated on a loss, with the retention share kept', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([{ id: 'pay', type: 'reward', reward: { currency: { min: 8, max: 8 } } }, fight('a', ['grunt', 'brute'])]),
    );
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' });
    const step = await sandbox.input({ type: 'advance' });
    expect(step.view.status).toBe('defeated');
    expect(sandbox.state.end).toMatchObject({ outcome: 'defeated', cause: 'hp_zero', earned: 8, retentionBasisPoints: 2500, banked: 2, lost: 6 });
    expect(sandbox.state.rooms.hall!.actions.a).toMatchObject({ status: 'failed', outcome: 'defeat' });
    expect(sandbox.effects.at(-1)).toMatchObject({ type: 'settle_run', requestKey: expect.stringContaining(':settlement') });
  });

  it('treats a round-limit stalemate as a defeat', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['wall'])]));
    await sandbox.input({ type: 'advance' });
    expect(sandbox.state.end).toMatchObject({ outcome: 'defeated', cause: 'stalemate' });
    expect(sandbox.state.hp).toBeGreaterThan(0);
  });

  it('survives a defeat the author routed onward, at 1 HP', async () => {
    const sandbox = testSandbox(
      singleRoomDungeon([fight('a', ['brute'], { outcomes: { defeat: { type: 'action', actionId: 'after' } } }), { id: 'mid', type: 'rest' }, { id: 'after', type: 'rest' }]),
    );
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.status).toBe('active');
    expect(sandbox.view.hp).toBe(1);
    expect(sandbox.view.action?.id).toBe('after');
    expect(sandbox.state.rooms.hall!.actions.a).toMatchObject({ status: 'failed', outcome: 'defeat' });
  });
});

describe('determinism', () => {
  it('draws a pooled wave’s enemy from the seed, the same before and during the fight', async () => {
    const drawn = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const sandbox = testSandbox(testDungeon(), { seed });
      await sandbox.input({ type: 'advance' });
      const shown = sandbox.view.action!.wave!.enemy.key;
      await sandbox.input({ type: 'advance' });
      const fought = sandbox.state.rooms.gate!.actions.guards!.detail;
      expect(fought?.kind === 'combat' && fought.waves[1]!.enemyKey).toBe(shown);
      drawn.add(shown);
      // The same seed draws the same enemy again.
      const again = testSandbox(testDungeon(), { seed });
      await again.input({ type: 'advance' });
      expect(again.view.action!.wave!.enemy.key).toBe(shown);
    }
    // A 3:1 pool over forty seeds fields both.
    expect(drawn).toEqual(new Set(['grunt', 'sentinel']));
  });

  it('replays event for event from the same seed, with real damage variance', async () => {
    const play = async (seed: number) => {
      const sandbox = createDungeonSandbox({ definition: testDungeon(), dependencies: testDependencies(), fighter: { ...TEST_FIGHTER, attack: 400, maxHp: 4000 }, seed });
      await autoPlayDungeonSandbox(sandbox);
      return { state: sandbox.state, log: sandbox.log, combat: sandbox.combat };
    };
    const first = await play(77);
    const second = await play(77);
    expect(second.state).toEqual(first.state);
    expect(second.log).toEqual(first.log);
    expect(second.combat).toEqual(first.combat);
    expect(first.state.status).toBe('completed');
    const other = await play(78);
    expect(other.combat).not.toEqual(first.combat);
  });

  it('does not depend on what was drawn before: a wave fights the same whether or not the player rested first', async () => {
    const rested = testSandbox(singleRoomDungeon([{ id: 'r', type: 'rest', optional: true }, fight('a', ['grunt'])]), { combatRules: undefined });
    await rested.input({ type: 'advance' });
    await rested.input({ type: 'advance' });
    const skipped = testSandbox(singleRoomDungeon([{ id: 'r', type: 'rest', optional: true }, fight('a', ['grunt'])]), { combatRules: undefined });
    await skipped.input({ type: 'decline' });
    await skipped.input({ type: 'advance' });
    expect(skipped.combat).toEqual(rested.combat);
  });
});

describe('restarts and stale inputs', () => {
  it('resumes at the right wave from a state that was stored and read back', () => {
    const ctx = context(singleRoomDungeon([fight('a', ['grunt', 'grunt', 'grunt'])]));
    let state = startDungeonRun(ctx, 5).state;
    state = stepDungeon(state, { type: 'advance', expectedStep: 0 }, ctx).state;
    // A process restart: nothing survives but what a row would hold.
    const restored = JSON.parse(JSON.stringify(state)) as DungeonRunState;
    expect(restored.cursor).toMatchObject({ actionId: 'a', waveIndex: 1 });
    expect(describeDungeonRun(restored, ctx).action?.wave).toMatchObject({ index: 1, count: 3 });

    const resumed = stepDungeon(restored, { type: 'advance', expectedStep: 1 }, ctx);
    const uninterrupted = stepDungeon(state, { type: 'advance', expectedStep: 1 }, ctx);
    expect(resumed.state).toEqual(uninterrupted.state);
    expect(resumed.log).toEqual(uninterrupted.log);
    expect(resumed.state.hp).toBe(370 - 72);
    expect(resumed.state.cursor.waveIndex).toBe(2);
  });

  it('refuses an input issued for an earlier step and changes nothing', () => {
    const ctx = context(singleRoomDungeon([fight('a', ['grunt', 'grunt'])]));
    const start = startDungeonRun(ctx, 5).state;
    const once = stepDungeon(start, { type: 'advance', expectedStep: 0 }, ctx);
    expect(once.status).toBe('applied');
    // The same button pressed again: it still names step 0.
    const twice = stepDungeon(once.state, { type: 'advance', expectedStep: 0 }, ctx);
    expect(twice).toMatchObject({ status: 'refused', refusal: 'stale', effects: [], log: [], combat: [] });
    expect(twice.state).toBe(once.state);
    expect(twice.state.hp).toBe(334);
  });

  it('refuses every input once the run is over', async () => {
    const sandbox = testSandbox(singleRoomDungeon([fight('a', ['grunt'])]));
    await sandbox.input({ type: 'abandon' });
    expect(sandbox.view.status).toBe('abandoned');
    for (const type of ['advance', 'decline', 'extract', 'abandon'] as const) {
      expect(await sandbox.input({ type })).toMatchObject({ status: 'refused', refusal: 'run_over' });
    }
  });

  it('does not mutate the state it is given', () => {
    const ctx = context(singleRoomDungeon([fight('a', ['grunt'])]));
    const start = startDungeonRun(ctx, 5).state;
    const frozen = JSON.stringify(start);
    stepDungeon(start, { type: 'advance' }, ctx);
    expect(JSON.stringify(start)).toBe(frozen);
  });
});

describe('the map', () => {
  it('walks a cyclic map: out through a side room and back to a finished one', async () => {
    const sandbox = testSandbox(testDungeon());
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' }); // pay
    expect(sandbox.view.connections.map((c) => c.id)).toEqual(['c_main', 'c_side']);

    await sandbox.input({ type: 'move', connectionId: 'c_side' });
    expect(sandbox.view.room.id).toBe('locker_room');
    await sandbox.input({ type: 'decline' });
    // Back through the shortcut: the gate is finished, so its sequence does not run again.
    await sandbox.input({ type: 'move', connectionId: 'c_back' });
    expect(sandbox.view.room).toMatchObject({ id: 'gate', completed: true, visits: 2 });
    expect(sandbox.view.phase).toBe('connections');
    expect(sandbox.view.connections.find((c) => c.id === 'c_side')).toMatchObject({ toRoomCompleted: true });
    expect(sandbox.view.hp).toBe(298);
  });

  it('locks a connection until its condition holds, and refuses a move through it', async () => {
    const again = testSandbox(testDungeon());
    for (const input of [
      { type: 'advance' }, { type: 'advance' }, { type: 'advance' },
      { type: 'move', connectionId: 'c_side' }, { type: 'advance' },
      { type: 'move', connectionId: 'c_locker_bulk' },
      { type: 'advance' }, { type: 'advance' },
    ] as const) {
      expect((await again.input(input)).status).toBe('applied');
    }
    expect(again.view.room.id).toBe('bulkhead');
    // The keycard opened the vault (7) on top of the gate (2) and the locker (5).
    expect(again.view.unbankedCurrency).toBe(14);
    const boss = again.view.connections.find((c) => c.id === 'c_boss')!;
    expect(boss).toMatchObject({ open: false, lockedText: 'The bulkhead is sealed.' });
    expect(await again.input({ type: 'move', connectionId: 'c_boss' })).toMatchObject({ status: 'refused', refusal: 'locked' });

    // The alternate route doubles back for the valve, then the door opens.
    await again.input({ type: 'move', connectionId: 'c_bulk_pump' });
    await again.input({ type: 'advance' });
    await again.input({ type: 'decline' });
    expect(again.view.flags).toMatchObject({ valve_opened: true, found_keycard: true });
    await again.input({ type: 'move', connectionId: 'c_pump_bulk' });
    expect(again.view.connections.find((c) => c.id === 'c_boss')).toMatchObject({ open: true });
    expect((await again.input({ type: 'move', connectionId: 'c_boss' })).status).toBe('applied');
    expect(again.view.room.id).toBe('den');
  });

  it('skips the vault when the gate is blocked, by forward routing', async () => {
    const sandbox = testSandbox(testDungeon());
    for (const input of [
      { type: 'advance' }, { type: 'advance' }, { type: 'advance' },
      { type: 'move', connectionId: 'c_main' }, { type: 'advance' }, { type: 'decline' },
      { type: 'move', connectionId: 'c_pump_bulk' },
    ] as const) {
      await sandbox.input(input);
    }
    expect(sandbox.view.room.id).toBe('bulkhead');
    expect(sandbox.view.action?.id).toBe('sentry');
    expect(sandbox.view.recent).toContainEqual({ kind: 'gate', roomId: 'bulkhead', actionId: 'vault_door', passed: false, blockedText: 'The vault wants a keycard.' });
    expect(sandbox.state.rooms.bulkhead!.actions.vault).toBeUndefined();
  });

  it('turns the player back at an unrouted gate and asks again on return', async () => {
    const definition = testDungeon(undefined, (d) => {
      const bulkhead = d.rooms.find((r) => r.id === 'bulkhead')!;
      bulkhead.actions = [{ id: 'door', type: 'gate', requires: { type: 'flag', flag: 'found_keycard' }, blockedText: 'Sealed.' }, ...bulkhead.actions!.slice(1)];
    });
    const sandbox = testSandbox(definition);
    for (const input of [
      { type: 'advance' }, { type: 'advance' }, { type: 'advance' },
      { type: 'move', connectionId: 'c_main' }, { type: 'advance' }, { type: 'decline' },
      { type: 'move', connectionId: 'c_pump_bulk' },
    ] as const) {
      await sandbox.input(input);
    }
    // Blocked: back in the pump room, the bulkhead unfinished.
    expect(sandbox.view.room.id).toBe('pump_room');
    expect(sandbox.view.recent).toContainEqual({ kind: 'retreated', fromRoomId: 'bulkhead', toRoomId: 'pump_room' });
    expect(sandbox.state.rooms.bulkhead).toMatchObject({ completed: false, resumeAt: 'door', visits: 1 });
    expect(sandbox.state.rooms.bulkhead!.actions.door).toBeUndefined();
    expect(sandbox.log.map((l) => l.type)).toContain('room_retreated');
  });

  it('completes the dungeon at an exit room, banking everything', async () => {
    const sandbox = testSandbox(testDungeon());
    const result = await autoPlayDungeonSandbox(sandbox);
    expect(result.stoppedBy).toBe('ended');
    expect(sandbox.state.end).toMatchObject({
      outcome: 'completed',
      cause: 'exit_reached',
      roomId: 'den',
      earned: 12, // gate 2 + den 10; no keycard, so no vault
      retentionBasisPoints: 10_000,
      banked: 12,
      lost: 0,
    });
    expect(sandbox.state.unbankedCurrency).toBe(0);
    expect(sandbox.view.roomsCompleted).toBe(4);
    // 2 + 1 + 1 + 1 fights of 36/36/36/72/108 damage, one 92-HP rest.
    expect(sandbox.state.end!.finalHp).toBe(STARTER.maxHp - 36 - 36 - 36 + 92 - 72 - 108);
  });

  it('extracts only from a finished extraction room', async () => {
    const sandbox = testSandbox(testDungeon());
    expect(await sandbox.input({ type: 'extract' })).toMatchObject({ status: 'refused', refusal: 'not_extractable' });
    for (const input of [
      { type: 'advance' }, { type: 'advance' }, { type: 'advance' },
      { type: 'move', connectionId: 'c_main' }, { type: 'advance' }, { type: 'decline' },
      { type: 'move', connectionId: 'c_pump_bulk' },
    ] as const) {
      await sandbox.input(input);
    }
    // In the extraction room, but its fight is still pending.
    expect(sandbox.view.canExtract).toBe(false);
    expect(await sandbox.input({ type: 'extract' })).toMatchObject({ status: 'refused', refusal: 'not_extractable' });
    await sandbox.input({ type: 'advance' });
    expect(sandbox.view.canExtract).toBe(true);
    await sandbox.input({ type: 'extract' });
    expect(sandbox.state.end).toMatchObject({ outcome: 'extracted', cause: 'extraction', roomId: 'bulkhead', earned: 2, banked: 2, lost: 0 });
  });

  it('refuses a move while an action is pending, and to a connection the room does not have', async () => {
    const sandbox = testSandbox(testDungeon());
    expect(await sandbox.input({ type: 'move', connectionId: 'c_main' })).toMatchObject({ status: 'refused', refusal: 'action_pending' });
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' });
    await sandbox.input({ type: 'advance' });
    expect(await sandbox.input({ type: 'move', connectionId: 'c_boss' })).toMatchObject({ status: 'refused', refusal: 'not_available' });
  });
});

describe('the sandbox', () => {
  it('records effects and grants nothing', async () => {
    const sandbox = testSandbox(testDungeon());
    await autoPlayDungeonSandbox(sandbox);
    // Currency-only rewards produce no grant effect; the run's one effect is its settlement.
    expect(sandbox.effects.map((e) => e.type)).toEqual(['settle_run']);
    expect(sandbox.effects[0]).toMatchObject({ type: 'settle_run', currencyKey: 'ascension_currency', end: { banked: 12 } });
  });

  it('reports a run that can go nowhere as stuck', async () => {
    const definition = singleRoomDungeon([{ id: 'r', type: 'rest' }], (d) => {
      d.connections = [{ id: 'c_out', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'lever' } }];
    });
    const sandbox = testSandbox(definition);
    const result = await autoPlayDungeonSandbox(sandbox);
    expect(result.stoppedBy).toBe('stuck');
    expect(sandbox.view).toMatchObject({ phase: 'connections', stuck: true, canExtract: false });
  });

  it('uses the same rules as a hand-stepped run: sandbox and engine agree step for step', async () => {
    const definition = testDungeon();
    const ctx: DungeonEngineContext = { ...context(definition), runKey: 'sandbox-9' };
    const sandbox = testSandbox(definition, { seed: 9 });
    let state = startDungeonRun(ctx, 9, dungeonRngSource(9)).state;
    expect(sandbox.state).toEqual(state);
    for (let i = 0; i < 40 && state.status === 'active'; i++) {
      const view = describeDungeonRun(state, ctx);
      const input =
        view.phase === 'action'
          ? ({ type: 'advance' } as const)
          : ({ type: 'move', connectionId: (view.connections.find((c) => c.open && !c.toRoomCompleted) ?? view.connections.find((c) => c.open))!.id } as const);
      state = stepDungeon(state, { ...input, expectedStep: state.step }, ctx).state;
      await sandbox.input(input);
      expect(sandbox.state).toEqual(state);
    }
    expect(state.status).toBe('completed');
  });
});
