/**
 * Text input puzzles live: the real Discord handlers, run service and
 * database. Opening and submitting the answer form, attempts that survive a
 * restart, duplicate, stale, foreign and post-abandon submissions, rewards
 * after a solve paid once, answer secrecy in what is stored, and puzzle
 * content through drafts, publication, rollback, export and import.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRunEvents, dungeonRuns } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => null),
  ownedCardImage: vi.fn(() => null),
}));

import { handleDungeonAct, handleDungeonPuzzleOpen, handleDungeonPuzzleSubmit, handleDungeonRun } from '../../src/discord/commands/waifumonDungeon';
import { RUN_NOT_FOUND, STALE_STEP_NOTICE, PUZZLE_ANSWER_FIELD } from '../../src/discord/dungeonPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { DungeonDefinitionSchema, type DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { buildDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { DungeonInvalidError } from '../../src/shared/errors';
import { CURRENCY, TEST_ENEMIES } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { silentLogger } from '../helpers/testDb';

interface ButtonJson { custom_id?: string; label?: string }
interface EmbedJson { description?: string; fields?: { name: string; value: string }[] }
interface Payload { content?: string; embeds?: { toJSON(): EmbedJson }[]; components?: { toJSON(): { components: ButtonJson[] } }[] }

const SECRET = '0042';
const GUESS = 'guess-7731';

let w: DungeonWorld;
let ctx: AppContext;
let n = 0;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  ctx = {
    config: { assetsDir: w.artworkDir },
    logger: silentLogger(),
    content: w.app.content,
    services: { dungeonRuns: w.runs, dungeonContent: w.content, dungeonAllowance: w.allowance, collection: w.app.collection },
  } as unknown as AppContext;
});
afterAll(async () => w?.cleanup());

function puzzleDungeonInput(over: Record<string, unknown> = {}): DungeonDefinitionInput {
  return {
    key: `puzzle_live_${++n}`,
    name: 'Keypad Vault',
    availableRegions: ['waifu-valley'],
    entranceRoomId: 'hall',
    settings: { progressionCurrency: CURRENCY },
    flags: [{ key: 'door_open', scope: 'run' }],
    rooms: [
      {
        id: 'hall',
        name: 'Security Hall',
        actions: [
          {
            id: 'keypad', type: 'text_puzzle', label: 'Security Door', prompt: 'Enter the four-digit code.',
            answers: [SECRET], incorrectText: 'Buzz.', solvedText: 'Click.', solvedFlag: 'door_open', ...over,
          },
          { id: 'cache', type: 'reward', reward: { currency: { min: 4, max: 4 } } },
        ],
      },
      { id: 'out', name: 'Out', kind: 'exit' },
    ],
    connections: [{ id: 'c_out', from: 'hall', to: 'out', requires: { type: 'flag', flag: 'door_open' }, lockedText: 'Sealed.' }],
  } as DungeonDefinitionInput;
}

// ── fake interactions ─────────────────────────────────────────────────────────

function component(extra: Record<string, unknown> = {}) {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => void painted.push(typeof body === 'string' ? { content: body } : (body as Payload)));
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint, ...extra };
  return { i, last: () => painted[painted.length - 1]!, painted };
}
/** A modal submission from the run screen's message, as Discord delivers one. */
function modalSubmit(answer: string) {
  const c = component({ isButton: () => false, isFromMessage: () => true, fields: { getTextInputValue: (id: string) => (id === PUZZLE_ANSWER_FIELD ? answer : '') } });
  const deferUpdate = vi.fn(async () => { c.i.deferred = true; });
  Object.assign(c.i, { deferUpdate });
  return { ...c, deferUpdate };
}
const buttonsOf = (p: Payload) => (p.components ?? []).flatMap((row) => row.toJSON().components);
const embedOf = (p: Payload) => p.embeds![0]!.toJSON();
const argsOf = (customId: string) => {
  const parsed = parseCustomId(customId);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not ours: ${customId}`);
  return parsed;
};
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;

async function screenOf(prov: Provisioned, runId: number): Promise<Payload> {
  const c = component();
  await handleDungeonRun(ctx, c.i as never, prov, [String(runId)]);
  return c.last();
}
/** Press Enter Answer on `screen`; returns the modal Discord was asked to show. */
async function openForm(prov: Provisioned, screen: Payload) {
  const enter = buttonsOf(screen).find((b) => b.label === 'Enter Answer');
  if (!enter) throw new Error(`no Enter Answer among ${buttonsOf(screen).map((b) => b.label).join(', ')}`);
  const parsed = argsOf(enter.custom_id!);
  expect(parsed.action).toBe('pz');
  const showModal = vi.fn(async () => {});
  await handleDungeonPuzzleOpen(ctx, { ...component().i, showModal } as never, prov, parsed.args);
  expect(showModal).toHaveBeenCalledTimes(1);
  return (showModal.mock.calls[0] as unknown as [{ toJSON(): { custom_id: string } }])[0].toJSON();
}
async function submit(prov: Provisioned, formId: string, answer: string): Promise<Payload> {
  const parsed = argsOf(formId);
  expect(parsed.action).toBe('pza');
  const m = modalSubmit(answer);
  await handleDungeonPuzzleSubmit(ctx, m.i as never, prov, parsed.args);
  expect(m.deferUpdate).toHaveBeenCalledTimes(1);
  return m.last();
}
async function atPuzzle(definition: DungeonDefinitionInput) {
  const { playerId } = await w.player();
  const prov = { playerId, guildDbId: 1 } as Provisioned;
  const run = await w.runs.start(playerId, definition.key, { seed: 3 });
  return { playerId, prov, runId: run.id, screen: await screenOf(prov, run.id) };
}

describe('the answer form on Discord', () => {
  it('opens a form for the current step and repaints the run with the result in place', async () => {
    const definition = puzzleDungeonInput({ maxAttempts: 3 });
    await w.publish(definition);
    const { prov, runId, screen } = await atPuzzle(definition);
    expect(embedOf(screen).description).toContain('Enter the four-digit code.');
    expect(embedOf(screen).description).toContain('**3** attempts left.');

    const form = await openForm(prov, screen);
    expect(argsOf(form.custom_id).args).toEqual([String(runId), String((await rowOf(runId)).step)]);
    const wrong = await submit(prov, form.custom_id, '42');
    expect(embedOf(wrong).fields).toContainEqual({ name: '❌ Incorrect', value: 'Buzz.\n**2** attempts left.' });
    expect(buttonsOf(wrong).some((b) => b.label === 'Enter Answer')).toBe(true);

    const right = await submit(prov, (await openForm(prov, wrong)).custom_id, `  ${SECRET} `);
    expect(embedOf(right).fields).toContainEqual({ name: '✅ Solved', value: 'Click.' });
    const row = await rowOf(runId);
    expect(row.flags).toEqual({ door_open: true });
    expect((row.cursor as { actionId: string | null }).actionId).toBe('cache');
  });

  it('keeps the attempt count across a restart and an expired screen', async () => {
    const definition = puzzleDungeonInput({ maxAttempts: 3, exhaustedText: 'Locked out.' });
    await w.publish(definition);
    const { playerId, prov, runId, screen } = await atPuzzle(definition);
    await submit(prov, (await openForm(prov, screen)).custom_id, '1');

    // A new process: nothing in memory, only the row.
    const restarted = w.restartedRuns();
    const resumed = await restarted.run(playerId, runId);
    expect(resumed.core.action!.puzzle).toEqual({ prompt: 'Enter the four-digit code.', attempts: 1, maxAttempts: 3, attemptsRemaining: 2 });
    const second = await restarted.act(playerId, runId, { type: 'answer', answer: '2', expectedStep: resumed.step });
    expect(second.run.core.action!.puzzle).toMatchObject({ attempts: 2, attemptsRemaining: 1 });

    // Resume from Discord and use the last attempt.
    const last = await submit(prov, (await openForm(prov, await screenOf(prov, runId))).custom_id, '3');
    expect(embedOf(last).fields).toContainEqual({ name: '🔒 Out of attempts', value: 'Locked out.' });
    const row = await rowOf(runId);
    expect((row.roomStates as Record<string, { puzzles: unknown }>).hall!.puzzles).toEqual({ keypad: { attempts: 3, status: 'exhausted', resolvedStep: 2 } });
    expect(row.flags).toEqual({});
  });

  it('treats a duplicate submission as stale and changes nothing', async () => {
    const definition = puzzleDungeonInput({ maxAttempts: 5 });
    await w.publish(definition);
    const { prov, runId, screen } = await atPuzzle(definition);
    const form = await openForm(prov, screen);
    await submit(prov, form.custom_id, 'nope');
    const before = await rowOf(runId);
    const again = await submit(prov, form.custom_id, 'nope');
    expect(again.content).toBe(STALE_STEP_NOTICE);
    const after = await rowOf(runId);
    expect(after.step).toBe(before.step);
    expect(after.roomStates).toEqual(before.roomStates);
    // And a correct answer on the stale form cannot sneak through either.
    expect((await submit(prov, form.custom_id, SECRET)).content).toBe(STALE_STEP_NOTICE);
    expect((await rowOf(runId)).flags).toEqual({});
  });

  it('pays what follows a solve once, however often the solve is resubmitted', async () => {
    const definition = puzzleDungeonInput();
    await w.publish(definition);
    const { playerId, prov, runId, screen } = await atPuzzle(definition);
    const form = await openForm(prov, screen);
    const solved = await submit(prov, form.custom_id, SECRET);
    await submit(prov, form.custom_id, SECRET);
    const open = buttonsOf(solved).find((b) => argsOf(b.custom_id!).action === 'act')!;
    const c = component();
    await handleDungeonAct(ctx, c.i as never, prov, argsOf(open.custom_id!).args);
    await handleDungeonAct(ctx, component().i as never, prov, argsOf(open.custom_id!).args);
    const row = await rowOf(runId);
    expect(Object.keys(row.rewardClaims as object)).toHaveLength(1);
    expect(row.unbankedCurrency).toBe(4);
    const view = await w.runs.run(playerId, runId);
    expect(view.core.connections).toEqual([expect.objectContaining({ id: 'c_out', open: true })]);
    const ended = await w.act(playerId, view, { type: 'move', connectionId: 'c_out' });
    expect(ended.run.status).toBe('completed');
    expect(await w.balance(playerId)).toBe(4);
  });

  it('refuses another player’s submission and any submission after the run is abandoned', async () => {
    const definition = puzzleDungeonInput();
    await w.publish(definition);
    const { playerId, prov, runId, screen } = await atPuzzle(definition);
    const form = await openForm(prov, screen);
    const stranger = { playerId: (await w.player()).playerId, guildDbId: 1 } as Provisioned;
    const before = await rowOf(runId);
    const foreign = await submit(stranger, form.custom_id, SECRET);
    expect(foreign.content).toBe(RUN_NOT_FOUND);
    expect(await rowOf(runId)).toEqual(before);

    const view = await w.runs.run(playerId, runId);
    await w.act(playerId, view, { type: 'abandon' });
    const late = await submit(prov, form.custom_id, SECRET);
    expect(late.content).toBe(STALE_STEP_NOTICE);
    // Even naming the current step, a finished run takes no answer.
    const ended = await w.runs.act(playerId, runId, { type: 'answer', answer: SECRET, expectedStep: (await rowOf(runId)).step });
    expect(ended).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect((await rowOf(runId)).flags).toEqual({});
  });

  it('stores neither the accepted answers nor what players typed', async () => {
    const definition = puzzleDungeonInput({ answers: ['opal-sunrise-91'] });
    await w.publish(definition);
    const { prov, runId, screen } = await atPuzzle(definition);
    await submit(prov, (await openForm(prov, screen)).custom_id, GUESS);
    const solved = await submit(prov, (await openForm(prov, await screenOf(prov, runId))).custom_id, 'Opal-Sunrise-91');
    expect(embedOf(solved).fields).toContainEqual({ name: '✅ Solved', value: 'Click.' });
    const stored = JSON.stringify([
      await rowOf(runId),
      await w.t.db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, runId)),
    ]);
    expect(stored).not.toContain(GUESS);
    expect(stored.toLowerCase()).not.toContain('opal-sunrise-91');
    const events = await w.t.db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, runId)).orderBy(asc(dungeonRunEvents.id));
    expect(events.filter((e) => e.actionId === 'keypad').map((e) => [e.type, e.payload.outcome])).toEqual([
      ['action_failed', 'incorrect'],
      ['action_completed', 'solved'],
    ]);
  });
});

describe('replays, races and finished runs', () => {
  it('cannot replay a solved puzzle’s form against the next puzzle', async () => {
    const definition = puzzleDungeonInput();
    definition.rooms[0]!.actions!.splice(1, 0, { id: 'keypad2', type: 'text_puzzle', prompt: 'Second lock.', answers: ['beta'] } as never);
    await w.publish(definition);
    const { playerId, prov, runId, screen } = await atPuzzle(definition);
    const first = await openForm(prov, screen);
    await submit(prov, first.custom_id, SECRET);
    const view = await w.runs.run(playerId, runId);
    expect(view.core.action!.id).toBe('keypad2');
    // The first form names the step the first puzzle was drawn for: it cannot answer the second.
    expect((await submit(prov, first.custom_id, 'beta')).content).toBe(STALE_STEP_NOTICE);
    const row = await rowOf(runId);
    expect((row.roomStates as Record<string, { puzzles: Record<string, unknown> }>).hall!.puzzles.keypad2).toBeUndefined();
    expect(row.step).toBe(view.step);
  });

  it('applies exactly one of two simultaneous submissions', async () => {
    const definition = puzzleDungeonInput();
    await w.publish(definition);
    const { prov, runId, screen } = await atPuzzle(definition);
    const form = await openForm(prov, screen);
    const before = (await rowOf(runId)).step;
    const results = await Promise.all([submit(prov, form.custom_id, SECRET), submit(prov, form.custom_id, SECRET)]);
    // One applied; the loser is told it was stale and shown the run as the winner left it.
    expect(results.filter((r) => r.content === STALE_STEP_NOTICE)).toHaveLength(1);
    expect(results.filter((r) => !r.content && embedOf(r).fields?.some((f) => f.name === '✅ Solved'))).toHaveLength(1);
    const row = await rowOf(runId);
    expect(row.step).toBe(before + 1);
    const solved = (await w.t.db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, runId)))
      .filter((e) => e.actionId === 'keypad' && e.type === 'action_completed');
    expect(solved).toHaveLength(1);
  });

  it('refuses old forms once the run is completed or extracted', async () => {
    const definition = puzzleDungeonInput();
    definition.rooms[0]!.extraction = true;
    await w.publish(definition);
    for (const ending of ['completed', 'extracted'] as const) {
      const { playerId, prov, runId, screen } = await atPuzzle(definition);
      const form = await openForm(prov, screen);
      await submit(prov, form.custom_id, SECRET);
      let view = await w.runs.run(playerId, runId);
      view = (await w.act(playerId, view, { type: 'advance' })).run;
      view = (await w.act(playerId, view, ending === 'completed' ? { type: 'move', connectionId: 'c_out' } : { type: 'extract' })).run;
      expect(view.status).toBe(ending);
      const before = await rowOf(runId);
      expect((await submit(prov, form.custom_id, SECRET)).content).toBe(STALE_STEP_NOTICE);
      expect(await rowOf(runId)).toEqual(before);
    }
  });

  it('answers a submission that is not attached to a message with its own private reply', async () => {
    const definition = puzzleDungeonInput();
    await w.publish(definition);
    const { prov, screen } = await atPuzzle(definition);
    const form = await openForm(prov, screen);
    const m = modalSubmit('nope');
    (m.i as unknown as { isFromMessage: () => boolean }).isFromMessage = () => false;
    await handleDungeonPuzzleSubmit(ctx, m.i as never, prov, argsOf(form.custom_id).args);
    expect(m.deferUpdate).not.toHaveBeenCalled();
    expect((m.i as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledTimes(1);
    expect(embedOf(m.last()).fields).toContainEqual({ name: '❌ Incorrect', value: 'Buzz.' });
  });

  it('leaves the door locked after an exhausted puzzle', async () => {
    const definition = puzzleDungeonInput({ maxAttempts: 1 });
    await w.publish(definition);
    const { playerId, prov, runId, screen } = await atPuzzle(definition);
    const out = await submit(prov, (await openForm(prov, screen)).custom_id, '9999');
    expect(embedOf(out).fields).toContainEqual({ name: '🔒 Out of attempts', value: 'Buzz.' });
    let view = await w.runs.run(playerId, runId);
    view = (await w.act(playerId, view, { type: 'advance' })).run;
    expect(view.core.connections).toEqual([expect.objectContaining({ id: 'c_out', open: false })]);
    expect((await w.act(playerId, view, { type: 'move', connectionId: 'c_out' })).refusal).toBe('locked');
  });
});

describe('puzzle content', () => {
  it('saves an unfinished puzzle as a draft but will not publish it', async () => {
    const definition = puzzleDungeonInput({ answers: [''], prompt: '' });
    const created = await w.content.create({ definition }, 'test');
    expect(created.draft.rooms[0]!.actions[0]).toMatchObject({ type: 'text_puzzle', answers: [''] });
    const error = await w.content.publish(definition.key, { expectedRevision: created.draftRevision }, 'test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DungeonInvalidError);
    expect((error as DungeonInvalidError).issues.map((i) => i.code)).toEqual(expect.arrayContaining(['puzzle_prompt_empty', 'puzzle_answer_empty']));
  });

  it('publishes, republishes and rolls back, and a run keeps the revision it started on', async () => {
    const definition = puzzleDungeonInput();
    await w.publish(definition);
    const { playerId: early } = await w.player();
    const pinned = await w.runs.start(early, definition.key, { seed: 1 });

    const changed = structuredClone(definition);
    (changed.rooms[0]!.actions![0] as { answers: string[] }).answers = ['7777'];
    const second = await w.republish(changed);
    expect(second.revision.number).toBe(2);
    expect((await w.content.revision(definition.key, 2))!.content.rooms[0]!.actions[0]).toMatchObject({ answers: ['7777'] });

    const { playerId: late } = await w.player();
    const onTwo = await w.runs.start(late, definition.key, { seed: 1 });
    expect((await w.runs.act(late, onTwo.id, { type: 'answer', answer: SECRET, expectedStep: onTwo.step })).run.core.action!.puzzle).toMatchObject({ attempts: 1 });
    // The run begun on revision 1 still takes revision 1's answer.
    expect((await w.runs.act(early, pinned.id, { type: 'answer', answer: SECRET, expectedStep: pinned.step })).run.core.action!.type).toBe('reward');

    const rolled = await w.content.rollback(definition.key, { revision: 1 }, 'test');
    expect(rolled.revision).toMatchObject({ number: 1, current: true });
    const { playerId: after } = await w.player();
    const onOne = await w.runs.start(after, definition.key, { seed: 1 });
    expect((await w.runs.act(after, onOne.id, { type: 'answer', answer: SECRET, expectedStep: onOne.step })).run.core.action!.type).toBe('reward');
  });

  it('round-trips a puzzle through import and export without losing a setting', async () => {
    const input = puzzleDungeonInput({
      answers: ['0042', 'Forty Two'], caseSensitive: true, trimWhitespace: false, maxAttempts: 4,
      exhaustedText: 'Locked out.', optional: true, outcomes: { exhausted: { type: 'room_complete' } },
    });
    const definition = DungeonDefinitionSchema.parse(input);
    const pkg = buildDungeonPackage({
      definition,
      enemies: new Map(TEST_ENEMIES.map((e) => [e.key, e])),
      source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null },
    });
    const plan = await w.content.planImport(pkg);
    expect(plan.validPackage).toBe(true);
    await w.content.applyImport({
      package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: plan.target!.expectedRevision,
      decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: false },
    }, 'admin');
    const imported = (await w.content.get(definition.key))!;
    expect(imported.draft.rooms[0]!.actions[0]).toEqual(definition.rooms[0]!.actions[0]);
    const exported = await w.content.exportPackage(definition.key, 'draft', 'test');
    expect(exported.contentHash).toBe(pkg.contentHash);
    expect(exported.dungeon.rooms[0]!.actions[0]).toEqual(definition.rooms[0]!.actions[0]);
  });
});
