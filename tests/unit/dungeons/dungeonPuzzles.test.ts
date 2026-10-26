/**
 * Text input puzzles in the pure engine, the validator, the package format and
 * the Discord presenter: matching rules, attempts, routing, flags, secrecy and
 * the answer form. The live service and the real handlers are covered by
 * `tests/integration/dungeonPuzzlesLive.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ButtonStyle, type ActionRowBuilder, type ButtonBuilder } from 'discord.js';
import {
  ANSWER_REQUIRED_NOTICE,
  PUZZLE_ANSWER_FIELD,
  actionNotice,
  buildPuzzleModal,
  buildRunScreen,
  dgId,
} from '../../../src/discord/dungeonPresenter';
import { parseCustomId } from '../../../src/discord/types';
import {
  DungeonDefinitionSchema,
  type DungeonDefinition,
  type DungeonDefinitionInput,
  type TextPuzzleAction,
} from '../../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonRunView } from '../../../src/modules/dungeons/dungeonRunService';
import { buildDungeonPackage, readDungeonPackage, serializeDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
import { puzzleAnswerMatches } from '../../../src/modules/dungeons/engine/puzzles';
import { autoPlayDungeonSandbox } from '../../../src/modules/dungeons/engine/sandbox';
import { startDungeonRun, stepDungeon } from '../../../src/modules/dungeons/engine/step';
import type { DungeonEngineContext, DungeonInput, DungeonRunState } from '../../../src/modules/dungeons/engine/types';
import { describeDungeonRun } from '../../../src/modules/dungeons/engine/view';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { FIXED_RULES, TEST_ENEMIES, TEST_FIGHTER, singleRoomDungeon, testDependencies, testSandbox } from '../../helpers/dungeonFixtures';

const SECRET = 'violet-lantern-0042';

type PuzzleInput = Partial<Omit<TextPuzzleAction, 'type'>> & { id?: string };
const puzzle = (over: PuzzleInput = {}) => ({
  id: 'door',
  type: 'text_puzzle' as const,
  label: 'Security Door',
  prompt: 'The keypad wants four digits.',
  answers: ['0042'],
  solvedText: 'The lock clunks open.',
  incorrectText: 'The keypad buzzes.',
  ...over,
});
/** Hall: the puzzle, then a 3-currency cache; one way out to the exit. */
function puzzleDungeon(over: PuzzleInput = {}, patch: (d: DungeonDefinitionInput) => void = () => {}): DungeonDefinition {
  return singleRoomDungeon([puzzle(over), { id: 'cache', type: 'reward', reward: { currency: { min: 3, max: 3 } } }], patch);
}
const ctxFor = (definition: DungeonDefinition): DungeonEngineContext => ({
  definition, dependencies: testDependencies(), fighter: TEST_FIGHTER, runKey: 'puzzle-run', combatRules: FIXED_RULES,
});
const start = (ctx: DungeonEngineContext) => startDungeonRun(ctx, 7).state;
const answer = (state: DungeonRunState, ctx: DungeonEngineContext, text: string, expectedStep = state.step) =>
  stepDungeon(state, { type: 'answer', answer: text, expectedStep }, ctx);
function applied(state: DungeonRunState, ctx: DungeonEngineContext, input: DungeonInput) {
  const result = stepDungeon(state, { expectedStep: state.step, ...input }, ctx);
  if (result.status !== 'applied') throw new Error(`refused ${input.type}: ${result.refusal}`);
  return result;
}

describe('answer matching', () => {
  const rules = (over: Partial<Pick<TextPuzzleAction, 'answers' | 'caseSensitive' | 'trimWhitespace'>> = {}) => ({
    answers: ['0042'], caseSensitive: false, trimWhitespace: true, ...over,
  });

  it('treats numeric codes as strings, keeping leading zeros', () => {
    expect(puzzleAnswerMatches(rules(), '0042')).toBe(true);
    expect(puzzleAnswerMatches(rules(), '42')).toBe(false);
    expect(puzzleAnswerMatches(rules(), '00042')).toBe(false);
    // The schema refuses a number where an answer belongs, so 0042 can never be stored as 42.
    expect(DungeonDefinitionSchema.safeParse({ ...puzzleDungeon(), rooms: [{ id: 'hall', actions: [puzzle({ answers: [42 as unknown as string] })] }] }).success).toBe(false);
  });

  it('ignores capitals unless the puzzle is case-sensitive', () => {
    expect(puzzleAnswerMatches(rules({ answers: ['Moonlight'] }), 'MOONLIGHT')).toBe(true);
    expect(puzzleAnswerMatches(rules({ answers: ['Moonlight'], caseSensitive: true }), 'MOONLIGHT')).toBe(false);
    expect(puzzleAnswerMatches(rules({ answers: ['Moonlight'], caseSensitive: true }), 'Moonlight')).toBe(true);
  });

  it('trims surrounding whitespace by default and never touches inner spaces or punctuation', () => {
    expect(puzzleAnswerMatches(rules({ answers: ['open sesame!'] }), '  open sesame!\t')).toBe(true);
    expect(puzzleAnswerMatches(rules({ answers: ['open sesame!'] }), 'opensesame!')).toBe(false);
    expect(puzzleAnswerMatches(rules({ answers: ['open sesame!'] }), 'open  sesame!')).toBe(false);
    expect(puzzleAnswerMatches(rules({ answers: ['open sesame!'] }), 'open sesame')).toBe(false);
    expect(puzzleAnswerMatches(rules({ answers: ['open sesame!'], trimWhitespace: false }), ' open sesame!')).toBe(false);
  });

  it('accepts any of several answers and never matches a blank one', () => {
    const several = rules({ answers: ['red', 'crimson', ''] });
    expect(puzzleAnswerMatches(several, 'Crimson')).toBe(true);
    expect(puzzleAnswerMatches(several, '')).toBe(false);
    expect(puzzleAnswerMatches(several, '   ')).toBe(false);
  });
});

describe('the puzzle in a run', () => {
  it('waits at the puzzle, refuses Continue and moving on, and continues the room once solved', () => {
    const ctx = ctxFor(puzzleDungeon());
    const state = start(ctx);
    expect(state.cursor.actionId).toBe('door');
    expect(stepDungeon(state, { type: 'advance', expectedStep: 0 }, ctx).refusal).toBe('answer_required');
    expect(stepDungeon(state, { type: 'move', connectionId: 'c_out', expectedStep: 0 }, ctx).refusal).toBe('action_pending');
    expect(stepDungeon(state, { type: 'decline', expectedStep: 0 }, ctx).refusal).toBe('not_optional');

    const solved = answer(state, ctx, '0042');
    expect(solved.status).toBe('applied');
    // The sequence carried on to the cache, which waits for its own button.
    expect(solved.state.cursor.actionId).toBe('cache');
    expect(solved.state.rooms.hall!.puzzles!.door).toMatchObject({ attempts: 1, status: 'solved', resolvedStep: 0 });
    expect(solved.state.rooms.hall!.actions.door).toMatchObject({ status: 'completed', outcome: 'solved' });
    expect(solved.state.recent).toEqual([
      { kind: 'puzzle', roomId: 'hall', actionId: 'door', result: 'solved', attempts: 1, maxAttempts: null, text: 'The lock clunks open.' },
    ]);
    const cache = applied(solved.state, ctx, { type: 'advance' });
    expect(cache.state.unbankedCurrency).toBe(3);
    expect(cache.state.cursor.actionId).toBeNull();
  });

  it('keeps an incorrect answer at the puzzle, as its own step, and allows unlimited retries by default', () => {
    const ctx = ctxFor(puzzleDungeon());
    let state = start(ctx);
    for (let n = 1; n <= 12; n++) {
      const wrong = answer(state, ctx, `wrong-${n}`);
      expect(wrong.status).toBe('applied');
      expect(wrong.state.step).toBe(state.step + 1);
      expect(wrong.state.cursor.actionId).toBe('door');
      expect(wrong.state.recent).toEqual([
        { kind: 'puzzle', roomId: 'hall', actionId: 'door', result: 'incorrect', attempts: n, maxAttempts: null, text: 'The keypad buzzes.' },
      ]);
      // No action record yet: the puzzle is unresolved.
      expect(wrong.state.rooms.hall!.actions.door).toBeUndefined();
      state = wrong.state;
    }
    expect(state.rooms.hall!.puzzles!.door).toEqual({ attempts: 12, status: 'open' });
    expect(describeDungeonRun(state, ctx).action!.puzzle).toEqual({
      prompt: 'The keypad wants four digits.', attempts: 12, maxAttempts: null, attemptsRemaining: null,
    });
    expect(answer(state, ctx, '0042').state.rooms.hall!.puzzles!.door!.status).toBe('solved');
  });

  it('exhausts a limited puzzle on the last wrong answer and, unrouted, carries on unsolved', () => {
    const ctx = ctxFor(puzzleDungeon({ maxAttempts: 2, exhaustedText: 'The keypad locks.', solvedFlag: 'lever' }));
    const first = answer(start(ctx), ctx, '1111');
    expect(first.state.cursor.actionId).toBe('door');
    expect(describeDungeonRun(first.state, ctx).action!.puzzle).toMatchObject({ attempts: 1, maxAttempts: 2, attemptsRemaining: 1 });
    const second = answer(first.state, ctx, '2222');
    expect(second.state.recent[0]).toEqual({
      kind: 'puzzle', roomId: 'hall', actionId: 'door', result: 'exhausted', attempts: 2, maxAttempts: 2, text: 'The keypad locks.',
    });
    expect(second.state.rooms.hall!.actions.door).toMatchObject({ status: 'failed', outcome: 'exhausted' });
    expect(second.state.flags.lever).toBeUndefined();
    expect(second.state.cursor.actionId).toBe('cache');
    expect(second.log.find((e) => e.actionId === 'door')).toMatchObject({ type: 'action_failed', payload: { outcome: 'exhausted', attempts: 2 } });
  });

  it('falls back to the incorrect-answer text when no exhausted text is written', () => {
    const ctx = ctxFor(puzzleDungeon({ maxAttempts: 1 }));
    expect(answer(start(ctx), ctx, 'no').state.recent[0]).toMatchObject({ result: 'exhausted', text: 'The keypad buzzes.' });
  });

  it('follows the authored exhausted and solved routes', () => {
    const doomed = ctxFor(puzzleDungeon({ maxAttempts: 1, outcomes: { exhausted: { type: 'end_run', outcome: 'defeated' } } }));
    const lost = answer(start(doomed), doomed, 'no');
    expect(lost.state.status).toBe('defeated');
    expect(lost.effects.map((e) => e.type)).toEqual(['settle_run']);

    const skipping = ctxFor(puzzleDungeon({ outcomes: { solved: { type: 'room_complete' } } }));
    const done = answer(start(skipping), skipping, '0042');
    expect(done.state.rooms.hall!.completed).toBe(true);
    expect(done.state.rooms.hall!.actions.cache).toBeUndefined();
  });

  it('lets an optional puzzle be skipped, leaving its flag unset', () => {
    const ctx = ctxFor(puzzleDungeon({ optional: true, solvedFlag: 'lever' }));
    const skipped = applied(start(ctx), ctx, { type: 'decline' });
    expect(skipped.state.rooms.hall!.actions.door).toMatchObject({ status: 'declined', outcome: 'declined' });
    expect(skipped.state.flags.lever).toBeUndefined();
    expect(skipped.state.cursor.actionId).toBe('cache');
  });

  it('sets its run flag when solved, which opens a locked way through an existing condition', () => {
    const definition = puzzleDungeon({ solvedFlag: 'lever' }, (d) => {
      d.connections = [{ id: 'c_out', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'lever' }, lockedText: 'Sealed.' }];
    });
    const ctx = ctxFor(definition);
    const solved = answer(start(ctx), ctx, '0042');
    expect(solved.state.flags.lever).toBe(true);
    const cleared = applied(solved.state, ctx, { type: 'advance' });
    expect(describeDungeonRun(cleared.state, ctx).connections).toEqual([expect.objectContaining({ id: 'c_out', open: true })]);
    expect(applied(cleared.state, ctx, { type: 'move', connectionId: 'c_out' }).state.status).toBe('completed');

    // Unsolved — exhausted — the way stays shut.
    const limited = ctxFor(puzzleDungeon({ solvedFlag: 'lever', maxAttempts: 1 }, (d) => {
      d.connections = [{ id: 'c_out', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'lever' } }];
    }));
    const failed = applied(answer(start(limited), limited, 'no').state, limited, { type: 'advance' });
    expect(describeDungeonRun(failed.state, limited).connections[0]).toMatchObject({ open: false });
    expect(stepDungeon(failed.state, { type: 'move', connectionId: 'c_out', expectedStep: failed.state.step }, limited).refusal).toBe('locked');
  });
});

describe('idempotency and staleness', () => {
  it('refuses a duplicate or stale submission without changing anything', () => {
    const ctx = ctxFor(puzzleDungeon({ maxAttempts: 3 }));
    const state = start(ctx);
    const wrong = answer(state, ctx, 'no', 0);
    // The same submission again names step 0, which the run has left.
    const duplicate = answer(wrong.state, ctx, 'no', 0);
    expect(duplicate).toMatchObject({ status: 'refused', refusal: 'stale', effects: [], log: [] });
    expect(duplicate.state).toBe(wrong.state);
    expect(wrong.state.rooms.hall!.puzzles!.door!.attempts).toBe(1);

    const solved = answer(wrong.state, ctx, '0042');
    expect(answer(solved.state, ctx, '0042', wrong.state.step).refusal).toBe('stale');
    // At the current step but past the puzzle: not something an answer can reach.
    expect(answer(solved.state, ctx, '0042').refusal).toBe('not_available');
  });

  it('cannot reach a puzzle the cursor is not on, nor answer once the run is over', () => {
    const ctx = ctxFor(puzzleDungeon());
    const solved = answer(start(ctx), ctx, '0042');
    const cleared = applied(solved.state, ctx, { type: 'advance' });
    expect(answer(cleared.state, ctx, '0042').refusal).toBe('no_action');
    const abandoned = applied(start(ctx), ctx, { type: 'abandon' });
    expect(answer(abandoned.state, ctx, '0042').refusal).toBe('run_over');
  });

  it('never applies success effects twice, even when routing returns the player to the room', () => {
    // Solve routes to `retreat`; returning re-reads the settled puzzle and applies nothing again.
    const definition = puzzleDungeon({ solvedFlag: 'lever', outcomes: { solved: { type: 'retreat' } } }, (d) => {
      d.entranceRoomId = 'lobby';
      d.rooms.unshift({ id: 'lobby', name: 'Lobby', actions: [] });
      d.connections!.push({ id: 'c_in', from: 'lobby', to: 'hall' }, { id: 'c_lobby_out', from: 'lobby', to: 'out' });
    });
    const ctx = ctxFor(definition);
    const atDoor = applied(start(ctx), ctx, { type: 'move', connectionId: 'c_in' });
    const solved = answer(atDoor.state, ctx, '0042');
    expect(solved.state.cursor.roomId).toBe('lobby');
    expect(solved.state.flags.lever).toBe(true);
    const back = applied(solved.state, ctx, { type: 'move', connectionId: 'c_in' });
    // Settled: the puzzle is not asked again, its result is not repeated and it routes as before.
    expect(back.state.cursor.roomId).toBe('lobby');
    expect(back.state.recent.some((e) => e.kind === 'puzzle')).toBe(false);
    expect(back.log.some((e) => e.actionId === 'door' && (e.type === 'action_completed' || e.type === 'action_failed'))).toBe(false);
    expect(back.state.rooms.hall!.puzzles!.door).toEqual(solved.state.rooms.hall!.puzzles!.door);
  });

  it('keeps spent attempts through a retreat and a JSON round trip, as the run row stores them', () => {
    const ctx = ctxFor(puzzleDungeon({ maxAttempts: 3 }));
    const once = answer(start(ctx), ctx, 'no');
    const stored = JSON.parse(JSON.stringify(once.state)) as DungeonRunState;
    const twice = answer(stored, ctx, 'no again');
    expect(twice.state.rooms.hall!.puzzles!.door).toEqual({ attempts: 2, status: 'open' });
    expect(twice.state.recent[0]).toMatchObject({ result: 'incorrect', attempts: 2 });
  });
});

describe('answer secrecy', () => {
  const definition = puzzleDungeon({ answers: [SECRET, 'second-secret-answer'] });
  const ctx = ctxFor(definition);

  it('keeps accepted answers out of the player view, the stored state and the log', () => {
    const state = start(ctx);
    const view = JSON.stringify(describeDungeonRun(state, ctx));
    expect(view).toContain('The keypad wants four digits.');
    expect(view).not.toContain(SECRET);
    expect(view).not.toContain('second-secret-answer');
    const wrong = answer(state, ctx, 'typed-guess-xyz');
    const solved = answer(wrong.state, ctx, SECRET);
    for (const result of [wrong, solved]) {
      const persisted = JSON.stringify({ state: result.state, log: result.log, effects: result.effects });
      expect(persisted).not.toContain(SECRET);
      expect(persisted).not.toContain('typed-guess-xyz');
      expect(JSON.stringify(describeDungeonRun(result.state, ctx))).not.toContain(SECRET);
    }
  });

  it('keeps accepted answers out of the Discord screen, its buttons and the answer form', () => {
    const state = answer(start(ctx), ctx, 'typed-guess-xyz').state;
    const screen = buildRunScreen(runView(state, ctx), { itemName: () => 'Item' });
    const modal = buildPuzzleModal(5, state.step).toJSON();
    const everything = JSON.stringify([screen.content, screen.embeds, (screen.components as ActionRowBuilder<ButtonBuilder>[]).map((r) => r.toJSON()), modal]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('second-secret-answer');
    expect(everything).not.toContain('typed-guess-xyz');
  });
});

describe('validation', () => {
  const issues = (over: PuzzleInput, patch?: (d: DungeonDefinitionInput) => void) =>
    validateDungeonDefinition(puzzleDungeon(over, patch)).issues.filter((i) => i.path.startsWith('rooms[0].actions[0]'));
  const codes = (over: PuzzleInput, patch?: (d: DungeonDefinitionInput) => void) => issues(over, patch).map((i) => `${i.severity}:${i.code}`);

  it('accepts a complete puzzle', () => {
    expect(codes({ maxAttempts: 3, solvedFlag: 'lever', outcomes: { exhausted: { type: 'retreat' } } })).toEqual(
      // The hall is the entrance, so a retreat has nowhere to go: an existing rule, still applied.
      ['error:retreat_from_entrance'],
    );
    expect(codes({ maxAttempts: 3, solvedFlag: 'lever' })).toEqual([]);
  });

  it('refuses to publish a puzzle with no prompt, no answers or a blank answer', () => {
    expect(codes({ prompt: '' })).toEqual(['error:puzzle_prompt_empty']);
    expect(codes({ answers: [] })).toEqual(['error:puzzle_no_answers']);
    expect(codes({ answers: ['0042', '   '] })).toEqual(['error:puzzle_answer_empty']);
    expect(issues({ answers: ['0042', ''] })[0]!.path).toBe('rooms[0].actions[0].answers[1]');
  });

  it('warns about answers that are the same once normalised', () => {
    expect(codes({ answers: ['Moon', ' moon '] })).toEqual(['warning:puzzle_answer_duplicate']);
    expect(codes({ answers: ['Moon', 'moon'], caseSensitive: true })).toEqual([]);
  });

  it('refuses impossible attempt limits as a schema problem a draft cannot even save', () => {
    for (const maxAttempts of [0, -1, 1.5, 101]) {
      const result = validateDungeonDefinition({ ...puzzleDungeon(), rooms: [{ id: 'hall', actions: [puzzle({ maxAttempts })] }, { id: 'out', kind: 'exit' }] });
      expect(result.definition).toBeNull();
      expect(result.issues[0]).toMatchObject({ code: 'schema', path: 'rooms[0].actions[0].maxAttempts' });
    }
  });

  it('flags routing and flags it cannot honour', () => {
    expect(codes({ outcomes: { exhausted: { type: 'next' } } })).toEqual(['warning:outcome_unreachable']);
    expect(codes({ outcomes: { wrong: { type: 'next' } } })).toEqual(['error:unknown_outcome']);
    expect(codes({ outcomes: { solved: { type: 'action', actionId: 'door' } } })).toEqual(['error:transition_backward']);
    expect(codes({ solvedFlag: 'nope' })).toEqual(['error:flag_undeclared']);
    expect(codes({ solvedFlag: 'remembered' }, (d) => d.flags!.push({ key: 'remembered', scope: 'player' }))).toEqual(['error:flag_scope_unsupported']);
  });

  it('counts the solved flag as set, so a condition reading it is not "never set"', () => {
    const definition = puzzleDungeon({ solvedFlag: 'lever' }, (d) => {
      d.connections = [{ id: 'c_out', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'lever' } }];
    });
    expect(validateDungeonDefinition(definition).issues.map((i) => i.code)).not.toContain('flag_never_set');
  });

  it('leaves older definitions exactly as they parsed before', () => {
    const legacy = singleRoomDungeon([{ id: 'nap', type: 'rest' }]);
    expect(legacy.rooms[0]!.actions[0]).not.toHaveProperty('answers');
    expect(validateDungeonDefinition(legacy).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('packages', () => {
  it('carries every puzzle setting through export and import unchanged', () => {
    const definition = puzzleDungeon({
      answers: ['0042', 'Forty Two '], caseSensitive: true, trimWhitespace: false, maxAttempts: 4,
      exhaustedText: 'Locked out.', solvedFlag: 'lever', optional: true, outcomes: { exhausted: { type: 'room_complete' } },
    });
    const pkg = buildDungeonPackage({
      definition,
      enemies: new Map(TEST_ENEMIES.map((e) => [e.key, e])),
      source: { environment: 'test', origin: 'draft', draftRevision: 1, publishedRevision: null },
    });
    const read = readDungeonPackage(JSON.parse(serializeDungeonPackage(pkg)));
    expect(read.ok).toBe(true);
    expect(read.package!.dungeon.rooms[0]!.actions[0]).toEqual(definition.rooms[0]!.actions[0]);
    expect(read.package!.contentHash).toBe(pkg.contentHash);
  });
});

describe('the sandbox', () => {
  it('plays through a puzzle with its first accepted answer', async () => {
    const sandbox = testSandbox(puzzleDungeon({ answers: ['', 'alpha', 'beta'] }));
    const played = await autoPlayDungeonSandbox(sandbox);
    expect(played.stoppedBy).toBe('ended');
    expect(sandbox.state.rooms.hall!.puzzles!.door).toMatchObject({ attempts: 1, status: 'solved' });
  });
});

// ── Discord ───────────────────────────────────────────────────────────────────

function runView(state: DungeonRunState, ctx: DungeonEngineContext): DungeonRunView {
  return {
    id: 5, status: state.status, step: state.step,
    dungeon: { key: ctx.definition.key, name: 'Rust Warrens', description: '', revision: 1, artwork: { assetId: null, artworkPath: null }, background: { assetId: null, artworkPath: null } },
    fighter: { waifuId: 1, name: TEST_FIGHTER.name, attack: 1, defense: 1, maxHp: TEST_FIGHTER.maxHp, formulaVersion: 1, speciesSlug: 'x', level: 1, currentSp: 1, gear: {} } as DungeonRunView['fighter'],
    core: describeDungeonRun(state, ctx),
    enemy: null, roomBackground: { assetId: null, artworkPath: null }, combatEvents: null, currency: null,
    defeatRetentionBasisPoints: 0, secured: [], latestSecured: [], settlement: null, startedAt: new Date(0), completedAt: null,
  };
}
const buttons = (screen: ReturnType<typeof buildRunScreen>) =>
  (screen.components as ActionRowBuilder<ButtonBuilder>[]).flatMap((r) => r.toJSON().components) as { custom_id?: string; label?: string; style?: number }[];
const embedOf = (screen: ReturnType<typeof buildRunScreen>) => (screen.embeds![0] as { toJSON(): { description?: string; fields?: { name: string; value: string }[] } }).toJSON();

describe('the Discord puzzle screen', () => {
  it('shows the prompt and attempts left, with Enter Answer naming only the run and the step', () => {
    const ctx = ctxFor(puzzleDungeon({ maxAttempts: 3 }));
    const state = answer(start(ctx), ctx, 'no').state;
    const screen = buildRunScreen(runView(state, ctx), { itemName: () => 'Item' });
    const embed = embedOf(screen);
    expect(embed.description).toContain('🧩 **Security Door**');
    expect(embed.description).toContain('The keypad wants four digits.');
    expect(embed.description).toContain('**2** attempts left.');
    expect(embed.fields).toContainEqual({ name: '❌ Incorrect', value: 'The keypad buzzes.\n**2** attempts left.' });
    const enter = buttons(screen).find((b) => b.label === 'Enter Answer')!;
    expect(enter.style).toBe(ButtonStyle.Primary);
    expect(enter.custom_id).toBe(dgId.puzzle(5, state.step));
    expect(parseCustomId(enter.custom_id!)).toEqual({ scope: 'dg', action: 'pz', args: ['5', String(state.step)] });
    // No plain Continue: the action is answered, not carried out.
    expect(buttons(screen).some((b) => b.custom_id?.includes('|act|'))).toBe(false);
  });

  it('offers Skip on an optional puzzle and says nothing about attempts when they are unlimited', () => {
    const ctx = ctxFor(puzzleDungeon({ optional: true }));
    const screen = buildRunScreen(runView(start(ctx), ctx), { itemName: () => 'Item' });
    expect(buttons(screen).map((b) => b.label)).toEqual(expect.arrayContaining(['Enter Answer', 'Skip']));
    expect(embedOf(screen).description).not.toContain('attempt');
  });

  it('builds a one-field answer form whose id carries the run and the step', () => {
    const modal = buildPuzzleModal(5, 9).toJSON();
    expect(modal.custom_id).toBe(dgId.puzzleSubmit(5, 9));
    expect(parseCustomId(modal.custom_id)).toEqual({ scope: 'dg', action: 'pza', args: ['5', '9'] });
    expect(modal.title.length).toBeLessThanOrEqual(45);
    const inputs = (modal.components as unknown as { components: unknown[] }[]).flatMap((row) => row.components) as { custom_id: string; label: string; max_length?: number; required?: boolean }[];
    expect(inputs).toEqual([expect.objectContaining({ custom_id: PUZZLE_ANSWER_FIELD, max_length: 100, required: true })]);
    expect(inputs[0]!.label.length).toBeLessThanOrEqual(45);
  });

  it('paints solved and exhausted results, with defaults when the author wrote none', () => {
    const solvedCtx = ctxFor(puzzleDungeon({ solvedText: '' }));
    const solved = answer(start(solvedCtx), solvedCtx, '0042').state;
    expect(embedOf(buildRunScreen(runView(solved, solvedCtx), { itemName: () => 'Item' })).fields).toContainEqual({ name: '✅ Solved', value: 'That’s right.' });
    const outCtx = ctxFor(puzzleDungeon({ maxAttempts: 1, exhaustedText: 'Locked out.' }));
    const out = answer(start(outCtx), outCtx, 'no').state;
    expect(embedOf(buildRunScreen(runView(out, outCtx), { itemName: () => 'Item' })).fields).toContainEqual({ name: '🔒 Out of attempts', value: 'Locked out.' });
  });

  it('explains a Continue pressed on a puzzle', () => {
    expect(actionNotice({ status: 'refused', refusal: 'answer_required' })).toBe(ANSWER_REQUIRED_NOTICE);
  });
});
