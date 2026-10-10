/**
 * Delve on Discord: the home, the dungeon screen, Start Run, the run screen
 * (fights and their waves, optional actions, the ways on, locked ways),
 * extraction, abandoning, what a stale or double-clicked button paints, the
 * locked view, malformed custom ids, Discord's component limits, and resuming
 * a run after a restart — driven through the real handlers and presenter
 * against the real services and database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRunEvents, dungeonRuns } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy.webp' }),
    url: 'attachment://waifumon-buddy.webp',
  })),
}));

import {
  handleDungeonAbandon,
  handleDungeonAbandonConfirm,
  handleDungeonAct,
  handleDungeonExtract,
  handleDungeonExtractConfirm,
  handleDungeonHome,
  handleDungeonMove,
  handleDungeonRun,
  handleDungeonStart,
  handleDungeonZone,
} from '../../src/discord/commands/waifumonDungeon';
import {
  DUNGEON_TITLE,
  EQUIPMENT_NOTE,
  LOCKED_DUNGEONS,
  RUN_NOT_FOUND,
  RUN_OVER_NOTICE,
  STALE_STEP_NOTICE,
  dgId,
} from '../../src/discord/dungeonPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { createDungeonAllowanceService } from '../../src/modules/dungeons/dungeonAllowanceService';
import { createDungeonContentService } from '../../src/modules/dungeons/dungeonContentService';
import { createDungeonRunService } from '../../src/modules/dungeons/dungeonRunService';
import { dungeonEnemyReferences } from '../../src/modules/enemies/enemyReferences';
import { createEnemyCatalogueService } from '../../src/modules/enemies/enemyService';
import { shippedCombatEnemies } from '../../src/modules/enemies/enemyStore';
import { createCombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { createProgressionCurrencyService } from '../../src/modules/progressionCurrency/progressionCurrencyService';
import { FIXED_RULES, TEST_ENEMIES, singleRoomDungeon, testDungeonInput } from '../helpers/dungeonFixtures';
import { TEST_DAILY_TIMEZONE, createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { buildEquipmentServices } from '../helpers/equipmentFixtures';
import { silentLogger } from '../helpers/testDb';

interface ButtonJson {
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  emoji?: { name?: string };
}
interface EmbedJson {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
  image?: { url: string };
  thumbnail?: { url: string };
}
interface Payload {
  content?: string;
  embeds?: { toJSON(): EmbedJson }[];
  components?: { toJSON(): { components: ButtonJson[] } }[];
  files?: unknown[];
}
type Handler = (ctx: AppContext, i: never, prov: Provisioned, args: string[]) => Promise<unknown>;

const MAIN = 'dc_main';
const HUB = 'dc_hub';
const MALFORMED = 'That button is malformed — re-open Delve from /waifumon.';
/** Discord's limits: a custom id, the buttons of one row, the rows of one message. */
const MAX_CUSTOM_ID = 100;
const MAX_ROW_BUTTONS = 5;
const MAX_ROWS = 5;
/** What the starter build loses to a grunt or a sentinel under the fixed rules (`dungeonFixtures`). */
const WAVE_DAMAGE = 36;
const MAX_HP = 370;
/** Seven ways out of one room, each with an id as long as a connection id may be. */
const HUB_WAYS = Array.from({ length: 7 }, (_, n) => `way_${n + 1}_${'x'.repeat(40 - `way_${n + 1}_`.length)}`);

let w: DungeonWorld;
let ctx: AppContext;
/** Every screen any test painted, for the component-limit check at the end. */
const everyScreen: Payload[] = [];
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-discord-assets-'));

beforeAll(async () => {
  w = await createDungeonWorld();
  const main = testDungeonInput(MAIN);
  main.name = 'Rust Warrens';
  main.description = 'Pipes, mostly.';
  await w.publish(main);
  await w.publish(
    singleRoomDungeon([{ id: 'pull', type: 'set_flag', flag: 'lever' }], (d) => {
      d.key = HUB;
      d.name = 'Seven Doors';
      d.rooms = [d.rooms[0]!, ...HUB_WAYS.map((_, n) => ({ id: `out_${n + 1}`, name: `Out ${n + 1}`, kind: 'exit' as const }))];
      d.connections = HUB_WAYS.map((id, n) => ({ id, from: 'hall', to: `out_${n + 1}` }));
    }),
  );
  ctx = {
    config: { assetsDir },
    logger: silentLogger(),
    content: w.app.content,
    services: { dungeonRuns: w.runs, dungeonContent: w.content, dungeonAllowance: w.allowance, collection: w.app.collection },
  } as unknown as AppContext;
});
afterAll(async () => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  await w?.cleanup();
});

function click() {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    const payload = typeof body === 'string' ? { content: body } : (body as Payload);
    painted.push(payload);
    everyScreen.push(payload);
  });
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint };
  return { i: i as never, last: () => painted[painted.length - 1]! };
}
const embedOf = (p: Payload) => p.embeds![0]!.toJSON();
const rowsOf = (p: Payload) => (p.components ?? []).map((row) => row.toJSON().components);
const buttonsOf = (p: Payload) => rowsOf(p).flat();
const labelsOf = (p: Payload) => buttonsOf(p).map((b) => b.label);
const fieldOf = (p: Payload, name: string | RegExp) =>
  embedOf(p).fields?.find((f) => (typeof name === 'string' ? f.name === name : name.test(f.name)));
const textOf = (p: Payload) => {
  const e = p.embeds?.[0]?.toJSON() ?? {};
  return [p.content, e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
/** What a screen shows, without the attachment objects: comparable across two paints. */
const shapeOf = (p: Payload) => ({ content: p.content, embeds: (p.embeds ?? []).map((e) => e.toJSON()), rows: rowsOf(p) });
const partsOf = (id: string) => {
  const parsed = parseCustomId(id);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not a wm id: ${id}`);
  return parsed;
};
const argsOf = (id: string) => partsOf(id).args;
/** `dg|act|12|0|a` — a custom id without the prefix and version every wm id carries. */
const routeOf = (button: ButtonJson) => {
  const { scope, action, args } = partsOf(button.custom_id!);
  return [scope, action, ...args].join('|');
};
const buttonOf = (screen: Payload, label: string | RegExp): ButtonJson => {
  const button = buttonsOf(screen).find((b) => (typeof label === 'string' ? b.label === label : label.test(b.label ?? '')));
  if (!button) throw new Error(`no button ${String(label)} among ${labelsOf(screen).join(', ')}`);
  return button;
};
const HANDLERS: Readonly<Record<string, Handler>> = {
  zone: handleDungeonZone,
  start: handleDungeonStart,
  run: handleDungeonRun,
  act: handleDungeonAct,
  mv: handleDungeonMove,
  exq: handleDungeonExtractConfirm,
  ex: handleDungeonExtract,
  abq: handleDungeonAbandonConfirm,
  ab: handleDungeonAbandon,
};
/** Click one button, routed by its own custom id the way `client.ts` routes it. */
async function clickButton(prov: Provisioned, button: ButtonJson, on: AppContext = ctx): Promise<Payload> {
  const { scope, action, args } = partsOf(button.custom_id!);
  expect(scope).toBe('dg');
  const c = click();
  if (action === 'home') await handleDungeonHome(on, c.i, prov);
  else await HANDLERS[action]!(on, c.i, prov, args);
  return c.last();
}
const press = (prov: Provisioned, screen: Payload, label: string | RegExp) => clickButton(prov, buttonOf(screen, label));
async function call(handler: Handler, prov: Provisioned, args: string[], on: AppContext = ctx): Promise<Payload> {
  const c = click();
  await handler(on, c.i, prov, args);
  return c.last();
}
async function home(prov: Provisioned): Promise<Payload> {
  const c = click();
  await handleDungeonHome(ctx, c.i, prov);
  return c.last();
}
async function newPlayer(opts: Parameters<DungeonWorld['player']>[0] = {}) {
  const { playerId } = await w.player(opts);
  return { playerId, prov: { playerId, guildDbId: 1 } as Provisioned };
}
/** A fresh player on the first screen of a run. */
async function begin(dungeonKey = MAIN) {
  const { playerId, prov } = await newPlayer();
  const screen = await call(handleDungeonStart, prov, [dungeonKey]);
  const run = (await w.runs.activeRun(playerId))!;
  return { playerId, prov, screen, runId: run.id };
}
const runRow = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
const eventsOf = (runId: number, type: (typeof dungeonRunEvents.$inferSelect)['type']) =>
  w.t.db
    .select()
    .from(dungeonRunEvents)
    .where(and(eq(dungeonRunEvents.runId, runId), eq(dungeonRunEvents.type, type)));
const allEvents = (runId: number) =>
  w.t.db.select().from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, runId)).orderBy(dungeonRunEvents.id);
/** The button that carries out the pending action: the one `dg|act|…|a` on the screen. */
const advanceButton = (screen: Payload) => buttonsOf(screen).find((b) => /^dg\|act\|\d+\|\d+\|a$/.test(routeOf(b)));
const moveButtons = (screen: Payload) => buttonsOf(screen).filter((b) => routeOf(b).startsWith('dg|mv|'));
/** Carry out pending actions until the room offers its ways on (or the run ends). */
async function clearRoom(prov: Provisioned, screen: Payload): Promise<Payload> {
  let current = screen;
  for (let guard = 0; guard < 20; guard++) {
    const next = advanceButton(current);
    if (!next) return current;
    current = await clickButton(prov, next);
  }
  throw new Error(`the room never finished: ${labelsOf(current).join(', ')}`);
}
/** gate → locker room → bulkhead, every room cleared: the extraction point, with the boss door still sealed. */
async function reachBulkhead() {
  const started = await begin();
  const gate = await clearRoom(started.prov, started.screen);
  const locker = await clearRoom(started.prov, await press(started.prov, gate, 'Side door'));
  const bulkhead = await clearRoom(started.prov, await press(started.prov, locker, '→ Bulkhead'));
  return { ...started, screen: bulkhead };
}

/* ───────────────────────── home and dungeon screen ───────────────────────── */

describe('the home', () => {
  it('lists the published dungeons with a button each', async () => {
    const { prov } = await newPlayer();
    const screen = await home(prov);
    expect(embedOf(screen).title).toBe(DUNGEON_TITLE);
    expect(embedOf(screen).description).toContain('Current location: **Waifu Valley**');
    const card = fieldOf(screen, 'Rust Warrens')!;
    expect(card.value).toContain('_Pipes, mostly._');
    expect(card.value).toContain('**5** rooms · ends in a boss');
    expect(card.value).toContain('you hold **0 Ascension Tokens**');
    expect(buttonOf(screen, 'Rust Warrens').custom_id).toBe(dgId.zone(MAIN));
    expect(routeOf(buttonOf(screen, 'Rust Warrens'))).toBe(`dg|zone|${MAIN}`);
    expect(routeOf(buttonOf(screen, 'Seven Doors'))).toBe(`dg|zone|${HUB}`);
    expect(labelsOf(screen)).toContain('Back to Waifumon');
  });

  it('does not list a dungeon that was never published, or one that is disabled', async () => {
    const draft = testDungeonInput('dc_draft');
    draft.name = 'Still A Draft';
    await w.content.create({ definition: draft }, 'test');
    const off = testDungeonInput('dc_off');
    off.name = 'Switched Off';
    await w.publish(off);
    await w.content.setEnabled('dc_off', false, 'test');

    const { prov } = await newPlayer();
    const screen = await home(prov);
    expect(labelsOf(screen)).not.toContain('Still A Draft');
    expect(labelsOf(screen)).not.toContain('Switched Off');
    expect(textOf(screen)).not.toMatch(/Still A Draft|Switched Off/);
    expect(labelsOf(screen)).toEqual(expect.arrayContaining(['Rust Warrens', 'Seven Doors']));
  });

  it('shows the active run with Resume and Abandon instead of the dungeons', async () => {
    const { prov, runId } = await begin();
    const screen = await home(prov);
    expect(embedOf(screen).description).toContain('You have a run in progress in **Rust Warrens**.');
    expect(fieldOf(screen, 'Where')!.value).toBe('Gate — 0 / 5 rooms cleared');
    expect(fieldOf(screen, 'Nebula Nurse')!.value).toContain(`HP **${MAX_HP} / ${MAX_HP}**`);
    expect(fieldOf(screen, 'Unbanked Ascension Tokens')!.value).toBe('0 Ascension Tokens');
    expect(fieldOf(screen, 'Secured')!.value).toBe('Nothing yet.');
    expect(labelsOf(screen)).toEqual(['Resume', 'Abandon', 'Back to Waifumon']);
    expect(routeOf(buttonOf(screen, 'Resume'))).toBe(`dg|run|${runId}`);
    expect(routeOf(buttonOf(screen, 'Abandon'))).toBe(`dg|abq|${runId}`);

    const resumed = await press(prov, screen, 'Resume');
    expect(embedOf(resumed).title).toBe('Rust Warrens — Gate');
  });
});

describe('the dungeon screen', () => {
  it('shows the Buddy, the rules of the run and Start Run — and starts nothing', async () => {
    const { playerId, prov } = await newPlayer();
    const screen = await press(prov, await home(prov), 'Rust Warrens');
    expect(embedOf(screen).title).toBe('Rust Warrens');
    expect(fieldOf(screen, 'Your Buddy — Nebula Nurse')!.value).toContain('ATK 83 · DEF 65 · HP 370');
    expect(fieldOf(screen, 'The run')!.value).toContain('**5** rooms, ending in a boss');
    expect(fieldOf(screen, 'The run')!.value).toContain('If you fall, you keep 25%.');
    expect(fieldOf(screen, 'Locked in')!.value).toBe(EQUIPMENT_NOTE);
    expect(buttonsOf(screen)[0]).toMatchObject({ label: 'Start Run', custom_id: dgId.start(MAIN) });
    expect(routeOf(buttonsOf(screen)[0]!)).toBe(`dg|start|${MAIN}`);
    expect(buttonsOf(screen)[0]!.disabled).toBeFalsy();
    expect(embedOf(screen).thumbnail?.url).toBe('attachment://waifumon-buddy.webp');
    expect(await w.runs.activeRun(playerId)).toBeNull();
  });

  it('disables Start Run and points at the fix when the loadout is incomplete', async () => {
    const { playerId, prov } = await newPlayer({ starters: false });
    const screen = await call(handleDungeonZone, prov, [MAIN]);
    expect(buttonsOf(screen)[0]).toMatchObject({ label: 'Start Run', disabled: true });
    expect(labelsOf(screen)).toContain('Equipment');
    expect(textOf(screen)).toContain('Can’t start yet');
    // A forged Start click is refused by the service and lands back here.
    const forged = await call(handleDungeonStart, prov, [MAIN]);
    expect(forged.content).toBe('Equip Attack, Defense and Health gear before fighting.');
    expect(embedOf(forged).title).toBe('Rust Warrens');
    expect(await w.runs.activeRun(playerId)).toBeNull();
  });
});

/* ───────────────────────── fights and stale buttons ───────────────────────── */

describe('a fight', () => {
  it('Start Run shows the first fight, with a Fight button drawn for step 0', async () => {
    const { prov } = await newPlayer();
    const detail = await call(handleDungeonZone, prov, [MAIN]);
    const screen = await press(prov, detail, 'Start Run');
    const run = (await w.runs.activeRun(prov.playerId))!;

    expect(embedOf(screen).title).toBe('Rust Warrens — Gate');
    expect(embedOf(screen).description).toContain('**Fight**');
    expect(embedOf(screen).description).toContain('**Grunt**');
    expect(embedOf(screen).description).toContain('ATK 60 · DEF 0 · HP 150');
    expect(embedOf(screen).description).toContain('Wave 1 of 2');
    expect(fieldOf(screen, 'Nebula Nurse')!.value).toContain(`HP **${MAX_HP} / ${MAX_HP}**`);
    expect(fieldOf(screen, 'Rooms cleared')!.value).toBe('0 / 5');
    expect(labelsOf(screen)).toEqual(['Fight', 'Abandon', 'Back to Waifumon']);
    const fight = buttonOf(screen, 'Fight');
    expect(fight.custom_id).toBe(dgId.advance(run.id, 0));
    expect(routeOf(fight)).toBe(`dg|act|${run.id}|0|a`);
    expect(fight.emoji?.name).toBe('⚔️');
    // A fight is not optional: there is nothing to skip.
    expect(labelsOf(screen)).not.toContain('Skip');
    expect(await runRow(run.id)).toMatchObject({ status: 'active', step: 0, currentHp: MAX_HP });
  });

  it('pressing Fight advances one wave, and the next screen’s button is a next-wave button drawn for step 1', async () => {
    const { prov, screen, runId } = await begin();
    const after = await press(prov, screen, 'Fight');

    expect(after.content).toBe('');
    const wave = fieldOf(after, '🏆 Victory — Grunt (wave 1 of 2)')!;
    expect(wave.value).toContain(`Your HP: ${MAX_HP} → **${MAX_HP - WAVE_DAMAGE}** / ${MAX_HP}`);
    expect(fieldOf(after, 'Nebula Nurse')!.value).toContain(`HP **${MAX_HP - WAVE_DAMAGE} / ${MAX_HP}**`);
    expect(embedOf(after).description).toContain('Wave 2 of 2');
    expect(await runRow(runId)).toMatchObject({ status: 'active', step: 1, currentHp: MAX_HP - WAVE_DAMAGE });

    // Wave 2 reads as the next wave, not as a fresh fight — and names step 1.
    expect(labelsOf(after)).toEqual(['Next wave', 'Abandon', 'Back to Waifumon']);
    const next = buttonOf(after, 'Next wave');
    expect(next.custom_id).toBe(dgId.advance(runId, 1));
    expect(routeOf(next)).toBe(`dg|act|${runId}|1|a`);
    expect(labelsOf(after)).not.toContain('Fight');
    expect(await eventsOf(runId, 'combat_wave_resolved')).toHaveLength(1);
  });

  it('pressing the same, now stale, step-0 button again changes nothing and says so', async () => {
    const { prov, screen, runId } = await begin();
    const stale = buttonOf(screen, 'Fight');
    expect(routeOf(stale)).toBe(`dg|act|${runId}|0|a`);
    const fresh = await clickButton(prov, stale);
    const before = await runRow(runId);
    expect(before).toMatchObject({ step: 1, currentHp: MAX_HP - WAVE_DAMAGE });

    // The double click, a Discord retry, or the button on an older message.
    for (let again = 0; again < 2; again++) {
      const repainted = await clickButton(prov, stale);
      expect(repainted.content).toBe(STALE_STEP_NOTICE);
      // The run as it now stands: same HP, same step, the same next-wave button.
      expect(fieldOf(repainted, 'Nebula Nurse')!.value).toContain(`HP **${MAX_HP - WAVE_DAMAGE} / ${MAX_HP}**`);
      expect(routeOf(buttonOf(repainted, 'Next wave'))).toBe(`dg|act|${runId}|1|a`);
      expect(shapeOf(repainted).rows).toEqual(shapeOf(fresh).rows);
    }
    const after = await runRow(runId);
    expect(after).toMatchObject({ status: 'active', step: 1, currentHp: MAX_HP - WAVE_DAMAGE });
    expect(after).toEqual(before);
    // One fight was fought, once.
    expect(await eventsOf(runId, 'combat_wave_resolved')).toHaveLength(1);

    // A stale decline is refused the same way.
    const declined = await call(handleDungeonAct, prov, [String(runId), '0', 'd']);
    expect(declined.content).toBe(STALE_STEP_NOTICE);
    expect(await runRow(runId)).toEqual(before);
  });

  it('the second wave finishes the fight; the room then pays and offers its ways on', async () => {
    const { prov, screen, runId } = await begin();
    const second = await press(prov, await press(prov, screen, 'Fight'), 'Next wave');
    expect(fieldOf(second, /^🏆 Victory — (Grunt|Sentinel) \(wave 2 of 2\)$/)!.value).toContain(
      `Your HP: ${MAX_HP - WAVE_DAMAGE} → **${MAX_HP - 2 * WAVE_DAMAGE}** / ${MAX_HP}`,
    );
    expect(await eventsOf(runId, 'combat_wave_resolved')).toHaveLength(2);

    const done = await clearRoom(prov, second);
    expect(advanceButton(done)).toBeUndefined();
    expect(fieldOf(done, 'Unbanked Ascension Tokens')!.value).toBe('2 Ascension Tokens');
    expect(fieldOf(done, 'Rooms cleared')!.value).toBe('1 / 5');
    expect(embedOf(done).description).toContain('**Where to?**');
    expect((await runRow(runId)).currentHp).toBe(MAX_HP - 2 * WAVE_DAMAGE);
  });
});

/* ───────────────────────── ways on ───────────────────────── */

describe('the ways on', () => {
  it('offers one button per open connection, each naming the run, the step and the connection', async () => {
    const { prov, screen, runId } = await begin();
    const gate = await clearRoom(prov, screen);
    const { step } = await runRow(runId);

    const ways = moveButtons(gate);
    expect(ways.map((b) => [b.label, routeOf(b), b.disabled ?? false])).toEqual([
      ['→ Pump Room', `dg|mv|${runId}|${step}|c_main`, false],
      ['Side door', `dg|mv|${runId}|${step}|c_side`, false],
    ]);
    expect(ways.map((b) => b.custom_id)).toEqual([dgId.move(runId, step, 'c_main'), dgId.move(runId, step, 'c_side')]);
    // The gate is no extraction point: there is nothing to extract from.
    expect(labelsOf(gate)).toEqual(['→ Pump Room', 'Side door', 'Abandon', 'Back to Waifumon']);
  });

  it('moving takes the connection into the next room, and an optional action can be skipped', async () => {
    const { prov, screen, runId } = await begin();
    const gate = await clearRoom(prov, screen);
    const before = await runRow(runId);

    const locker = await press(prov, gate, 'Side door');
    expect(locker.content).toBe('');
    expect(embedOf(locker).title).toBe('Rust Warrens — Locker Room');
    const after = await runRow(runId);
    expect(after.step).toBe(before.step + 1);
    expect(after.cursor).toMatchObject({ roomId: 'locker_room', cameFrom: 'gate' });
    expect(await eventsOf(runId, 'connection_taken')).toHaveLength(1);

    // The locker is optional: Open, or Skip — both drawn for this step.
    expect(labelsOf(locker)).toEqual(['Open', 'Skip', 'Abandon', 'Back to Waifumon']);
    expect(routeOf(buttonOf(locker, 'Open'))).toBe(`dg|act|${runId}|${after.step}|a`);
    expect(routeOf(buttonOf(locker, 'Skip'))).toBe(`dg|act|${runId}|${after.step}|d`);
    const skipped = await clearRoom(prov, await press(prov, locker, 'Skip'));
    expect(fieldOf(skipped, 'Unbanked Ascension Tokens')!.value).toBe('2 Ascension Tokens');

    // The way back to the gate reads as a way back; the way on as a way on.
    expect(moveButtons(skipped).map((b) => [b.label, b.emoji?.name ?? null])).toEqual([
      ['→ Gate', '↩️'],
      ['→ Bulkhead', null],
    ]);

    // The button that brought us here is stale now: nothing moves.
    const stale = await clickButton(prov, buttonOf(gate, 'Side door'));
    expect(stale.content).toBe(STALE_STEP_NOTICE);
    expect(embedOf(stale).title).toBe('Rust Warrens — Locker Room');
    expect(await eventsOf(runId, 'connection_taken')).toHaveLength(1);
  });

  it('renders a locked connection disabled, with its reason, beside the open ones', async () => {
    const { prov, screen, runId } = await reachBulkhead();
    const { step } = await runRow(runId);
    expect(embedOf(screen).title).toBe('Rust Warrens — Bulkhead');

    const ways = moveButtons(screen);
    expect(ways.map((b) => [b.label, routeOf(b), b.disabled ?? false, b.emoji?.name ?? null])).toEqual([
      ['Back to the pumps', `dg|mv|${runId}|${step}|c_bulk_pump`, false, null],
      ['→ The Den', `dg|mv|${runId}|${step}|c_boss`, true, '🔒'],
    ]);
    expect(fieldOf(screen, '🔒 Locked')!.value).toBe('**→ The Den** — The bulkhead is sealed.');

    // A forged click on the locked way is refused by the service: the player stays put.
    const forged = await call(handleDungeonMove, prov, [String(runId), String(step), 'c_boss']);
    expect(forged.content).toBe('That way is locked.');
    expect(embedOf(forged).title).toBe('Rust Warrens — Bulkhead');
    expect(await runRow(runId)).toMatchObject({ step, status: 'active' });
    expect((await runRow(runId)).cursor).toMatchObject({ roomId: 'bulkhead' });
  });

  it('opening the valve unlocks the boss door', async () => {
    const { prov, screen } = await reachBulkhead();
    const pumps = await clearRoom(prov, await press(prov, screen, 'Back to the pumps'));
    const back = await press(prov, pumps, '→ Bulkhead');
    const den = buttonOf(back, '→ The Den');
    expect(den.disabled ?? false).toBe(false);
    expect(fieldOf(back, '🔒 Locked')).toBeUndefined();
    const boss = await clickButton(prov, den);
    expect(embedOf(boss).title).toBe('Rust Warrens — The Den');
    expect(embedOf(boss).description).toContain('**Overlord**');
    expect(buttonOf(boss, 'Fight').emoji?.name).toBe('👑');
  });
});

/* ───────────────────────── extraction and abandoning ───────────────────────── */

describe('extraction', () => {
  it('asks first, then ends the run and banks everything', async () => {
    const { playerId, prov, screen, runId } = await reachBulkhead();
    // Gate 2, the locker's 5 and the vault's 7.
    expect(fieldOf(screen, 'Unbanked Ascension Tokens')!.value).toBe('14 Ascension Tokens');
    expect(fieldOf(screen, '🚪 Extraction point')!.value).toBe('You can leave here and bank all 14 Ascension Tokens.');
    expect(routeOf(buttonOf(screen, 'Extract'))).toBe(`dg|exq|${runId}`);
    const before = await runRow(runId);

    // The confirmation changes nothing, and its Extract button carries the step it was drawn for.
    const confirm = await press(prov, screen, 'Extract');
    expect(embedOf(confirm).title).toBe('🚪 Extract from Rust Warrens?');
    expect(embedOf(confirm).description).toContain('bank all **14 Ascension Tokens**');
    expect(labelsOf(confirm)).toEqual(['Extract', 'Keep Going']);
    expect(routeOf(buttonOf(confirm, 'Extract'))).toBe(`dg|ex|${runId}|${before.step}`);
    expect(routeOf(buttonOf(confirm, 'Keep Going'))).toBe(`dg|run|${runId}`);
    expect(await runRow(runId)).toEqual(before);
    expect(await w.balance(playerId)).toBe(0);

    // Keep Going is the run as it stands.
    const kept = await press(prov, confirm, 'Keep Going');
    expect(shapeOf(kept)).toEqual(shapeOf(screen));

    const done = await press(prov, confirm, 'Extract');
    expect(done.content).toBe('');
    expect(embedOf(done).title).toBe('🚪 Extracted — Rust Warrens');
    const result = fieldOf(done, 'Result')!.value;
    expect(result).toContain('Rooms cleared: **3 / 5**');
    expect(result).toContain('Earned: 14 Ascension Tokens');
    expect(result).toContain('Banked: **14 Ascension Tokens** — all of it');
    expect(result).toContain('You now hold 14 Ascension Tokens.');
    expect(labelsOf(done)).toEqual(['Delve Again', 'Back to Waifumon']);
    expect(routeOf(buttonOf(done, 'Delve Again'))).toBe('dg|home');

    const ended = await runRow(runId);
    expect(ended).toMatchObject({ status: 'extracted', unbankedCurrency: 0 });
    expect(ended.completedAt).not.toBeNull();
    expect(await w.balance(playerId)).toBe(14);
    expect(await w.runs.activeRun(playerId)).toBeNull();
    expect(await eventsOf(runId, 'extraction')).toHaveLength(1);

    // A second click on Extract banks nothing more.
    const again = await clickButton(prov, buttonOf(confirm, 'Extract'));
    expect(again.content).toBe(STALE_STEP_NOTICE);
    expect(embedOf(again).title).toBe('🚪 Extracted — Rust Warrens');
    expect(await w.balance(playerId)).toBe(14);
    expect(await eventsOf(runId, 'extraction')).toHaveLength(1);
    expect(await eventsOf(runId, 'currency_banked')).toHaveLength(1);
  });

  it('is not offered, and is refused when forged, away from an extraction point', async () => {
    const { playerId, prov, screen, runId } = await begin();
    const gate = await clearRoom(prov, screen);
    expect(labelsOf(gate)).not.toContain('Extract');
    const { step } = await runRow(runId);

    const asked = await call(handleDungeonExtractConfirm, prov, [String(runId)]);
    expect(asked.content).toBe('You can’t extract from here.');
    expect(embedOf(asked).title).toBe('Rust Warrens — Gate');
    const forged = await call(handleDungeonExtract, prov, [String(runId), String(step)]);
    expect(forged.content).toBe('You can’t extract from here.');
    expect(await runRow(runId)).toMatchObject({ status: 'active', step, unbankedCurrency: 2 });
    expect(await w.balance(playerId)).toBe(0);
  });
});

describe('abandoning', () => {
  it('asks first, then ends the run as abandoned and keeps the defeat share', async () => {
    const { playerId, prov, screen, runId } = await reachBulkhead();
    const before = await runRow(runId);
    expect(routeOf(buttonOf(screen, 'Abandon'))).toBe(`dg|abq|${runId}`);

    const confirm = await press(prov, screen, 'Abandon');
    expect(embedOf(confirm).title).toBe('🏳️ Abandon Rust Warrens?');
    expect(embedOf(confirm).description).toContain('you keep 25% of your **14 Ascension Tokens** unbanked');
    expect(embedOf(confirm).description).toContain('You are on an extraction point');
    expect(labelsOf(confirm)).toEqual(['Abandon Run', 'Back to Run']);
    expect(routeOf(buttonOf(confirm, 'Abandon Run'))).toBe(`dg|ab|${runId}`);
    expect(routeOf(buttonOf(confirm, 'Back to Run'))).toBe(`dg|run|${runId}`);
    expect(await runRow(runId)).toEqual(before);
    expect(shapeOf(await press(prov, confirm, 'Back to Run'))).toEqual(shapeOf(screen));

    const done = await press(prov, confirm, 'Abandon Run');
    expect(embedOf(done).title).toBe('🏳️ Run Abandoned — Rust Warrens');
    // A quarter of 14, rounded down.
    expect(fieldOf(done, 'Result')!.value).toContain('Kept (25%): **3 Ascension Tokens** · Lost: 11 Ascension Tokens');
    expect(labelsOf(done)).toEqual(['Delve Again', 'Back to Waifumon']);
    expect(await runRow(runId)).toMatchObject({ status: 'abandoned', unbankedCurrency: 0 });
    expect(await w.balance(playerId)).toBe(3);
    expect(await w.runs.activeRun(playerId)).toBeNull();

    // A second click finds the run already over and pays nothing more.
    const again = await clickButton(prov, buttonOf(confirm, 'Abandon Run'));
    expect(again.content).toBe(RUN_OVER_NOTICE);
    expect(embedOf(again).title).toBe('🏳️ Run Abandoned — Rust Warrens');
    expect(await w.balance(playerId)).toBe(3);
    expect(await eventsOf(runId, 'abandon')).toHaveLength(1);
    // …and so does asking to abandon it again.
    const asked = await call(handleDungeonAbandonConfirm, prov, [String(runId)]);
    expect(asked.content).toBe(RUN_OVER_NOTICE);
  });

  it('can be done from the very first screen, with nothing earned', async () => {
    const { playerId, prov, screen, runId } = await begin();
    const done = await press(prov, await press(prov, screen, 'Abandon'), 'Abandon Run');
    expect(embedOf(done).title).toBe('🏳️ Run Abandoned — Rust Warrens');
    expect(await runRow(runId)).toMatchObject({ status: 'abandoned' });
    expect(await w.balance(playerId)).toBe(0);
    // The home is the dungeons again.
    expect(labelsOf(await home(prov))).toContain('Rust Warrens');
  });
});

/* ───────────────────────── refusals ───────────────────────── */

describe('malformed custom ids', () => {
  it('get the malformed message, on every route, and touch nothing', async () => {
    const { prov, runId } = await begin();
    const before = await runRow(runId);
    const events = await allEvents(runId);
    const id = String(runId);
    const cases: [string, Handler, string[]][] = [
      ['act: no arguments', handleDungeonAct, []],
      ['act: run id is not a number', handleDungeonAct, ['abc', '0', 'a']],
      ['act: run id is zero', handleDungeonAct, ['0', '0', 'a']],
      ['act: run id is negative', handleDungeonAct, [`-${id}`, '0', 'a']],
      ['act: step is not a number', handleDungeonAct, [id, 'x', 'a']],
      ['act: step is negative', handleDungeonAct, [id, '-1', 'a']],
      ['act: step is missing', handleDungeonAct, [id]],
      ['act: code is missing', handleDungeonAct, [id, '0']],
      ['act: unknown code', handleDungeonAct, [id, '0', 'x']],
      ['act: a trailing argument', handleDungeonAct, [id, '0', 'a', 'extra']],
      ['mv: connection is missing', handleDungeonMove, [id, '0']],
      ['mv: connection id has a space', handleDungeonMove, [id, '0', 'Bad Id']],
      ['mv: connection id is upper case', handleDungeonMove, [id, '0', 'C_MAIN']],
      ['mv: connection id is too long', handleDungeonMove, [id, '0', 'c'.repeat(41)]],
      ['mv: a trailing argument', handleDungeonMove, [id, '0', 'c_main', 'extra']],
      ['ex: step is missing', handleDungeonExtract, [id]],
      ['ex: a trailing argument', handleDungeonExtract, [id, '0', 'extra']],
      ['exq: run id is missing', handleDungeonExtractConfirm, []],
      ['exq: a trailing argument', handleDungeonExtractConfirm, [id, '0']],
      ['abq: run id is not a number', handleDungeonAbandonConfirm, ['run']],
      ['ab: run id is missing', handleDungeonAbandon, []],
      ['ab: a trailing argument', handleDungeonAbandon, [id, '0']],
      ['run: run id has a decimal', handleDungeonRun, ['1.5']],
      ['run: a trailing argument', handleDungeonRun, [id, '0']],
      ['zone: key is missing', handleDungeonZone, []],
      ['zone: key has a space', handleDungeonZone, ['Not A Key']],
      ['zone: a trailing argument', handleDungeonZone, [MAIN, 'extra']],
      ['start: key is upper case', handleDungeonStart, ['DC_MAIN']],
      ['start: key is a path', handleDungeonStart, ['../dc_main']],
    ];
    for (const [name, handler, args] of cases) {
      const painted = await call(handler, prov, args);
      expect(painted.content, name).toBe(MALFORMED);
      // A bare refusal: no screen, no buttons.
      expect(painted.embeds ?? [], name).toEqual([]);
      expect(buttonsOf(painted), name).toEqual([]);
    }
    expect(await runRow(runId)).toEqual(before);
    expect(await allEvents(runId)).toEqual(events);
    expect(await eventsOf(runId, 'combat_wave_resolved')).toEqual([]);
  });

  it('a well-formed id for a run that is not the player’s is "not found", over the home', async () => {
    const mine = await begin();
    const other = await newPlayer();
    for (const [handler, args] of [
      [handleDungeonRun, [String(mine.runId)]],
      [handleDungeonAct, [String(mine.runId), '0', 'a']],
      [handleDungeonAbandon, [String(mine.runId)]],
      [handleDungeonRun, ['999999']],
    ] as [Handler, string[]][]) {
      const painted = await call(handler, other.prov, args);
      expect(painted.content).toBe(RUN_NOT_FOUND);
      expect(embedOf(painted).title).toBe(DUNGEON_TITLE);
    }
    expect(await runRow(mine.runId)).toMatchObject({ status: 'active', step: 0, currentHp: MAX_HP });
  });
});

describe('a player without the Equipment unlock', () => {
  it('gets the locked view on every route, and no run', async () => {
    const mine = await begin();
    const { playerId, prov } = await newPlayer({ unlocked: false });
    const id = String(mine.runId);
    const routes: [string, () => Promise<Payload>][] = [
      ['home', () => home(prov)],
      ['zone', () => call(handleDungeonZone, prov, [MAIN])],
      ['start', () => call(handleDungeonStart, prov, [MAIN])],
      ['run', () => call(handleDungeonRun, prov, [id])],
      ['act', () => call(handleDungeonAct, prov, [id, '0', 'a'])],
      ['mv', () => call(handleDungeonMove, prov, [id, '0', 'c_main'])],
      ['exq', () => call(handleDungeonExtractConfirm, prov, [id])],
      ['ex', () => call(handleDungeonExtract, prov, [id, '0'])],
      ['abq', () => call(handleDungeonAbandonConfirm, prov, [id])],
      ['ab', () => call(handleDungeonAbandon, prov, [id])],
    ];
    for (const [name, go] of routes) {
      const painted = await go();
      expect(painted.content, name).toBe(LOCKED_DUNGEONS);
      expect(painted.embeds, name).toEqual([]);
      expect(labelsOf(painted), name).toEqual(['Back to Waifumon']);
    }
    expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId))).toEqual([]);
    expect(await runRow(mine.runId)).toMatchObject({ status: 'active', step: 0 });
  });
});

/* ───────────────────────── restart ───────────────────────── */

describe('after a restart', () => {
  /** What a process start builds: every service new, over the same database. */
  function restart(): AppContext {
    const svc = buildEquipmentServices(w.t.db, {});
    const shipped = shippedCombatEnemies(TEST_ENEMIES);
    const enemies = createEnemyCatalogueService({ db: w.t.db, getShipped: () => shipped, assets: w.assets, referenceSources: [dungeonEnemyReferences] });
    const content = createDungeonContentService({
      db: w.t.db,
      enemies,
      getRegions: () => w.app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
      environment: 'test',
    });
    const allowance = createDungeonAllowanceService({ db: w.t.db, timezone: TEST_DAILY_TIMEZONE, now: () => w.clock.now });
    const runs = createDungeonRunService({
      db: w.t.db,
      content,
      enemies,
      allowance,
      combatRules: FIXED_RULES,
      featureUnlocks: svc.featureUnlocks,
      combatStats: createCombatStatsService({
        db: w.t.db,
        resolveActiveBuddy: (tx, playerId) => w.app.collection.resolveActiveBuddy(tx, playerId),
        getMaxLevel: () => w.app.content.tables.waifuProgression.maxLevel,
        getAffixes: svc.getAffixes,
      }),
      currencies: createProgressionCurrencyService(w.t.db),
      currency: w.app.currency,
      inventory: w.app.inventory,
      equipmentRewards: createEquipmentRewardService({ equipment: svc.equipment, getAffixes: svc.getAffixes, featureUnlocks: svc.featureUnlocks }),
    });
    expect(runs).not.toBe(w.runs);
    return {
      config: { assetsDir },
      logger: silentLogger(),
      content: w.app.content,
      services: { dungeonRuns: runs, dungeonContent: content, dungeonAllowance: allowance, collection: w.app.collection },
    } as unknown as AppContext;
  }

  it('dg|run|<id> shows the same screen, mid-fight, and the run carries on from there', async () => {
    const { prov, screen, runId } = await begin();
    await press(prov, screen, 'Fight');
    const before = await call(handleDungeonRun, prov, [String(runId)]);
    expect(routeOf(buttonOf(before, 'Next wave'))).toBe(`dg|act|${runId}|1|a`);
    const stored = await runRow(runId);

    const restarted = restart();
    const after = await call(handleDungeonRun, prov, [String(runId)], restarted);
    expect(shapeOf(after)).toEqual(shapeOf(before));
    expect(await runRow(runId)).toEqual(stored);

    // The step-0 button from before the restart is still stale…
    const stale = await clickButton(prov, buttonOf(screen, 'Fight'), restarted);
    expect(stale.content).toBe(STALE_STEP_NOTICE);
    expect(await runRow(runId)).toEqual(stored);
    // …and the current one still works, with the same fight it would have had.
    const fought = await clickButton(prov, buttonOf(after, 'Next wave'), restarted);
    expect(fieldOf(fought, 'Nebula Nurse')!.value).toContain(`HP **${MAX_HP - 2 * WAVE_DAMAGE} / ${MAX_HP}**`);
    expect(await runRow(runId)).toMatchObject({ step: 2, currentHp: MAX_HP - 2 * WAVE_DAMAGE });
    expect(await eventsOf(runId, 'combat_wave_resolved')).toHaveLength(2);
  });

  it('a run at its ways on, and one that has ended, both read the same', async () => {
    const live = await reachBulkhead();
    const liveBefore = await call(handleDungeonRun, live.prov, [String(live.runId)]);
    const over = await reachBulkhead();
    await press(over.prov, await press(over.prov, over.screen, 'Extract'), 'Extract');
    const overBefore = await call(handleDungeonRun, over.prov, [String(over.runId)]);
    expect(embedOf(overBefore).title).toBe('🚪 Extracted — Rust Warrens');

    const restarted = restart();
    expect(shapeOf(await call(handleDungeonRun, live.prov, [String(live.runId)], restarted))).toEqual(shapeOf(liveBefore));
    expect(shapeOf(await call(handleDungeonRun, over.prov, [String(over.runId)], restarted))).toEqual(shapeOf(overBefore));
    // The home finds the run again, too.
    const c = click();
    await handleDungeonHome(restarted, c.i, live.prov);
    expect(routeOf(buttonOf(c.last(), 'Resume'))).toBe(`dg|run|${live.runId}`);
  });
});

/* ───────────────────────── Discord's limits ───────────────────────── */

describe('component limits', () => {
  it('a room with more ways out than one row holds wraps them, five to a row', async () => {
    const { prov, screen, runId } = await begin(HUB);
    const hub = await clearRoom(prov, screen);
    const { step } = await runRow(runId);
    const ways = moveButtons(hub);
    expect(ways.map(routeOf)).toEqual(HUB_WAYS.map((id) => `dg|mv|${runId}|${step}|${id}`));
    expect(rowsOf(hub).map((row) => row.length)).toEqual([5, 2, 2]);
    // The longest id a connection may have still fits, and still routes.
    expect(Math.max(...ways.map((b) => b.custom_id!.length))).toBeLessThanOrEqual(MAX_CUSTOM_ID);
    const out = await clickButton(prov, ways[6]!);
    expect(embedOf(out).title).toBe('👑 Dungeon Complete — Seven Doors');
    expect(await runRow(runId)).toMatchObject({ status: 'completed' });
  });

  it('every custom id on every screen painted above fits, and no message is over-full', () => {
    // Every kind of screen was painted by the tests above; this is the roll-call.
    const routes = new Set<string>();
    let checked = 0;
    for (const screen of everyScreen) {
      const rows = rowsOf(screen);
      expect(rows.length, textOf(screen)).toBeLessThanOrEqual(MAX_ROWS);
      for (const row of rows) {
        expect(row.length, labelsOf(screen).join(', ')).toBeGreaterThan(0);
        expect(row.length, labelsOf(screen).join(', ')).toBeLessThanOrEqual(MAX_ROW_BUTTONS);
        for (const button of row) {
          expect(typeof button.custom_id, button.label).toBe('string');
          expect(button.custom_id!.length, button.custom_id).toBeLessThanOrEqual(MAX_CUSTOM_ID);
          expect(button.label!.length, button.label).toBeLessThanOrEqual(80);
          const { scope, action } = partsOf(button.custom_id!);
          routes.add(`${scope}|${action}`);
          checked += 1;
        }
      }
      // No two buttons of one message share an id: Discord refuses the message.
      const ids = buttonsOf(screen).map((b) => b.custom_id);
      expect(new Set(ids).size, ids.join(', ')).toBe(ids.length);
    }
    expect(checked).toBeGreaterThan(100);
    // All ten dungeon routes were drawn at least once.
    expect([...routes].filter((r) => r.startsWith('dg|')).sort()).toEqual(
      ['dg|ab', 'dg|abq', 'dg|act', 'dg|ex', 'dg|exq', 'dg|home', 'dg|mv', 'dg|run', 'dg|start', 'dg|zone'].sort(),
    );
  });
});
