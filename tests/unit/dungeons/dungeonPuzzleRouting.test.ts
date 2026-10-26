/**
 * The keypad scenario end to end in the pure engine: a clue room naming the
 * code, a security terminal with a required puzzle, and a vault whose door
 * reads the puzzle's flag. Mandatory, optional and exhausted puzzles are told
 * apart here, along with every way a player might try to get past one.
 */
import { describe, expect, it } from 'vitest';
import { DungeonDefinitionSchema, type DungeonDefinition, type DungeonDefinitionInput } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEngineContext, DungeonInput, DungeonRunState } from '../../../src/modules/dungeons/engine/types';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { FIXED_RULES, TEST_FIGHTER, testDependencies } from '../../helpers/dungeonFixtures';

const FLAG = 'security_door_unlocked';

function keypadInput(terminal: Record<string, unknown> = {}, patch: (d: DungeonDefinitionInput) => void = () => {}): DungeonDefinitionInput {
  const input: DungeonDefinitionInput = {
    key: 'keypad_vault',
    name: 'Keypad Vault',
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'clue',
    flags: [{ key: FLAG, scope: 'run', description: 'Security door unlocked' }],
    rooms: [
      { id: 'clue', name: 'Break Room', description: 'Someone scratched 0042 into the table.', actions: [] },
      {
        id: 'terminal',
        name: 'Security Terminal',
        actions: [{
          id: 'keypad', type: 'text_puzzle', label: 'Security Terminal', prompt: 'ENTER ACCESS CODE',
          answers: ['0042'], solvedText: 'ACCESS GRANTED', incorrectText: 'ACCESS DENIED', solvedFlag: FLAG, ...terminal,
        }],
      },
      { id: 'vault', name: 'Locked Vault', kind: 'exit', actions: [] },
    ],
    connections: [
      { id: 'c_to_terminal', from: 'clue', to: 'terminal' },
      { id: 'c_back', from: 'terminal', to: 'clue' },
      { id: 'c_vault', from: 'terminal', to: 'vault', requires: { type: 'flag', flag: FLAG }, lockedText: 'The vault door is sealed.' },
    ],
  } as DungeonDefinitionInput;
  patch(input);
  return input;
}
const keypad = (terminal?: Record<string, unknown>, patch?: (d: DungeonDefinitionInput) => void): DungeonDefinition =>
  DungeonDefinitionSchema.parse(keypadInput(terminal, patch));
const ctxFor = (definition: DungeonDefinition): DungeonEngineContext => ({
  definition, dependencies: testDependencies(), fighter: TEST_FIGHTER, runKey: 'keypad-run', combatRules: FIXED_RULES,
});
function step(state: DungeonRunState, ctx: DungeonEngineContext, input: DungeonInput) {
  return stepDungeon(state, { expectedStep: state.step, ...input }, ctx);
}
function ok(state: DungeonRunState, ctx: DungeonEngineContext, input: DungeonInput): DungeonRunState {
  const result = step(state, ctx, input);
  if (result.status !== 'applied') throw new Error(`refused ${input.type}: ${result.refusal}`);
  return result.state;
}
/** A run standing at the terminal's keypad. */
function atTerminal(ctx: DungeonEngineContext): DungeonRunState {
  return ok(startDungeonRun(ctx, 11).state, ctx, { type: 'move', connectionId: 'c_to_terminal' });
}
const vaultDoor = (state: DungeonRunState, ctx: DungeonEngineContext) =>
  describeDungeonRun(state, ctx).connections.find((c) => c.id === 'c_vault');

describe('the keypad scenario', () => {
  const definition = keypad();
  const ctx = ctxFor(definition);

  it('validates cleanly and shows the clue to the player', () => {
    expect(validateDungeonDefinition(definition).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(describeDungeonRun(startDungeonRun(ctx, 11).state, ctx).room.description).toContain('0042');
  });

  it('rejects 42 and 9999, accepts 0042, sets the flag and only then opens the vault', () => {
    let state = atTerminal(ctx);
    expect(describeDungeonRun(state, ctx).phase).toBe('action');
    for (const wrong of ['42', '9999']) {
      const result = step(state, ctx, { type: 'answer', answer: wrong });
      expect(result.status).toBe('applied');
      expect(result.state.recent[0]).toMatchObject({ kind: 'puzzle', result: 'incorrect', text: 'ACCESS DENIED' });
      expect(result.state.cursor.actionId).toBe('keypad');
      expect(result.state.flags[FLAG]).toBeUndefined();
      state = result.state;
    }
    expect(state.rooms.terminal!.puzzles!.keypad).toEqual({ attempts: 2, status: 'open' });
    state = ok(state, ctx, { type: 'answer', answer: '0042' });
    expect(state.recent[0]).toMatchObject({ result: 'solved', text: 'ACCESS GRANTED' });
    expect(state.flags[FLAG]).toBe(true);
    expect(vaultDoor(state, ctx)).toMatchObject({ open: true });
    expect(ok(state, ctx, { type: 'move', connectionId: 'c_vault' }).status).toBe('completed');
  });

  it('cannot be got past by any other interaction while the required puzzle is open', () => {
    const state = atTerminal(ctx);
    const refusals: Record<string, string | null> = {};
    const attempts: DungeonInput[] = [
      { type: 'move', connectionId: 'c_vault' },
      { type: 'move', connectionId: 'c_back' },
      { type: 'advance' },
      { type: 'decline' },
      { type: 'choose', choiceId: 'anything' },
      { type: 'capture' },
      { type: 'rescue' },
      { type: 'leave_encounter' },
      { type: 'dismiss_encounter' },
      { type: 'select_item', item: 'charm' },
      { type: 'extract' },
    ];
    for (const input of attempts) {
      const result = step(state, ctx, input);
      expect(result.status, input.type).toBe('refused');
      expect(result.state).toBe(state);
      refusals[input.type === 'move' ? `move:${input.connectionId}` : input.type] = result.refusal;
    }
    expect(refusals).toEqual({
      'move:c_vault': 'action_pending', 'move:c_back': 'action_pending', advance: 'answer_required', decline: 'not_optional',
      choose: 'not_available', capture: 'encounter_not_offered', rescue: 'encounter_not_offered', leave_encounter: 'encounter_not_offered',
      dismiss_encounter: 'encounter_not_offered', select_item: 'encounter_not_offered', extract: 'not_extractable',
    });
    // A stale answer — even the right one — changes nothing either.
    const wrong = ok(state, ctx, { type: 'answer', answer: '42' });
    expect(stepDungeon(wrong, { type: 'answer', answer: '0042', expectedStep: state.step }, ctx).refusal).toBe('stale');
    expect(vaultDoor(wrong, ctx)).toBeUndefined();
  });

  it('keeps puzzle progress across a resumed run and a return trip', () => {
    // Resuming: the stored row is all there is.
    const tried = JSON.parse(JSON.stringify(ok(atTerminal(ctx), ctx, { type: 'answer', answer: '42' }))) as DungeonRunState;
    expect(describeDungeonRun(tried, ctx).action!.puzzle).toMatchObject({ attempts: 1 });
    // Solved, out to the clue room and back: still open, flag intact, the keypad not asked again.
    let state = ok(tried, ctx, { type: 'answer', answer: '0042' });
    state = ok(state, ctx, { type: 'move', connectionId: 'c_back' });
    state = ok(state, ctx, { type: 'move', connectionId: 'c_to_terminal' });
    expect(describeDungeonRun(state, ctx).phase).toBe('connections');
    expect(state.flags[FLAG]).toBe(true);
    expect(vaultDoor(state, ctx)).toMatchObject({ open: true });
    expect(state.rooms.terminal!.puzzles!.keypad).toMatchObject({ attempts: 2, status: 'solved' });
  });
});

describe('mandatory, optional and exhausted puzzles', () => {
  it('lets an optional puzzle be skipped, leaving the vault shut and the way back open', () => {
    const ctx = ctxFor(keypad({ optional: true, maxAttempts: 3 }));
    const state = ok(atTerminal(ctx), ctx, { type: 'decline' });
    expect(state.rooms.terminal!.actions.keypad).toMatchObject({ status: 'declined' });
    expect(state.flags[FLAG]).toBeUndefined();
    expect(vaultDoor(state, ctx)).toMatchObject({ open: false });
    expect(describeDungeonRun(state, ctx).connections.find((c) => c.id === 'c_back')).toMatchObject({ open: true });
  });

  it('follows the configured exhausted outcome of an optional three-attempt puzzle', () => {
    const ctx = ctxFor(keypad({ optional: true, maxAttempts: 3, exhaustedText: 'LOCKOUT', outcomes: { exhausted: { type: 'end_run', outcome: 'defeated' } } }));
    let state = atTerminal(ctx);
    state = ok(state, ctx, { type: 'answer', answer: '1' });
    state = ok(state, ctx, { type: 'answer', answer: '2' });
    expect(describeDungeonRun(state, ctx).action!.puzzle).toMatchObject({ attempts: 2, attemptsRemaining: 1 });
    // Still skippable mid-way: the player can stop guessing.
    expect(step(state, ctx, { type: 'decline' }).status).toBe('applied');
    const out = step(state, ctx, { type: 'answer', answer: '3' });
    expect(out.state.recent[0]).toMatchObject({ result: 'exhausted', attempts: 3, text: 'LOCKOUT' });
    expect(out.state.status).toBe('defeated');
    expect(out.state.flags[FLAG]).toBeUndefined();
  });

  it('carries an exhausted puzzle on unsolved by default: the vault stays shut, the way back stays open', () => {
    const ctx = ctxFor(keypad({ maxAttempts: 3 }));
    let state = atTerminal(ctx);
    for (const guess of ['1', '2', '3']) state = ok(state, ctx, { type: 'answer', answer: guess });
    expect(state.rooms.terminal).toMatchObject({ completed: true, actions: { keypad: { status: 'failed', outcome: 'exhausted' } } });
    expect(state.flags[FLAG]).toBeUndefined();
    expect(vaultDoor(state, ctx)).toMatchObject({ open: false });
    expect(step(state, ctx, { type: 'move', connectionId: 'c_vault' }).refusal).toBe('locked');
    // Coming back does not offer the keypad again or reset its attempts.
    state = ok(state, ctx, { type: 'move', connectionId: 'c_back' });
    state = ok(state, ctx, { type: 'move', connectionId: 'c_to_terminal' });
    expect(describeDungeonRun(state, ctx).phase).toBe('connections');
    expect(state.rooms.terminal!.puzzles!.keypad).toMatchObject({ attempts: 3, status: 'exhausted' });
  });

  it('strands the player at a dead end only when the author removes every other way out — an authoring choice the screen reports', () => {
    // The same dead end any lock produces (a failed event check, a flag never set): the
    // run says it is stuck and offers Abandon. The validator, as for every lock, treats
    // the path as openable; the editor says that exhausting carries on unsolved.
    const definition = keypad({ maxAttempts: 1 }, (d) => { d.connections = d.connections!.filter((c) => c.id !== 'c_back'); });
    const ctx = ctxFor(definition);
    const out = ok(atTerminal(ctx), ctx, { type: 'answer', answer: 'no' });
    expect(describeDungeonRun(out, ctx)).toMatchObject({ phase: 'connections', stuck: true });
    expect(step(out, ctx, { type: 'abandon' }).state.status).toBe('abandoned');
  });

  it('opens the vault through an explicit "go through the path" route only with the existing validator warning', () => {
    // The one authored bypass of a locked path predates puzzles and is already flagged.
    const definition = keypad({ outcomes: { exhausted: { type: 'leave', connectionId: 'c_vault' } }, maxAttempts: 1 });
    expect(validateDungeonDefinition(definition).issues.map((i) => `${i.severity}:${i.code}`)).toContain('warning:transition_locked_connection');
  });
});
