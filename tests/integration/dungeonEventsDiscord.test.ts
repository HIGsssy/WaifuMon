/**
 * Dungeon events on Discord, through the real handlers, presenter, services
 * and database: the event screen and its choices, the explicit item-cost
 * wording, what a result paints, stale and duplicate presses, an item that
 * has gone, the picture an event shows, and Discord's limits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRuns, items, playerInventory } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy.webp' }),
    url: 'attachment://waifumon-buddy.webp',
  })),
}));

import { handleDungeonAbandonConfirm, handleDungeonAct, handleDungeonChoose, handleDungeonMove, handleDungeonRun } from '../../src/discord/commands/waifumonDungeon';
import {
  CHOICE_REQUIRED_NOTICE,
  CHOICE_UNAVAILABLE_NOTICE,
  CONSUMED_EVEN_IF_CHECK_FAILS,
  CONSUMED_WHEN_SELECTED,
  STALE_STEP_NOTICE,
  dgId,
} from '../../src/discord/dungeonPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import { DungeonDefinitionSchema, type DungeonDefinition, type DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { rollEventCheck } from '../../src/modules/dungeons/engine/eventChecks';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import { startDungeonRun } from '../../src/modules/dungeons/engine/step';
import { VAULT_HOARD, eventContext, eventDungeonInput } from '../helpers/dungeonEventFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { silentLogger } from '../helpers/testDb';

interface ButtonJson { custom_id?: string; label?: string; disabled?: boolean; style?: number; emoji?: { name?: string } }
interface EmbedJson { title?: string; description?: string; fields?: { name: string; value: string }[]; image?: { url: string }; thumbnail?: { url: string } }
interface Payload { content?: string; embeds?: { toJSON(): EmbedJson }[]; components?: { toJSON(): { components: ButtonJson[] } }[]; files?: { name?: string }[] }
type Handler = (ctx: AppContext, i: never, prov: Provisioned, args: string[]) => Promise<unknown>;

const MAX_CUSTOM_ID = 100;
const MAX_ROW_BUTTONS = 5;
const MAX_ROWS = 5;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 4096;
const MAX_EMBED = 6000;
const SP = 185;
const LOCK = { type: 'sp' as const, baseChanceBasisPoints: 5500, maxSpModifierBasisPoints: 1500 };

let w: DungeonWorld;
let ctx: AppContext;
let itemIds: Record<string, number> = {};
let n = 0;
const everyScreen: Payload[] = [];
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-event-assets-'));

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  const rows = await w.t.db.insert(items).values([
    { slug: 'vault_key', name: 'Vault Key', category: 'material', enabled: true },
    { slug: 'scrap_parts', name: 'Scrap Parts', category: 'material', enabled: true },
  ]).returning();
  itemIds = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  await createDungeonLootTableService({ db: w.t.db }).create({ key: 'vault_hoard', name: 'Vault hoard', body: VAULT_HOARD }, 'test');
  for (const file of ['dungeons/events/sealed_vault.webp', 'dungeons/backgrounds/vault_room.webp', 'dungeons/backgrounds/halls.webp', 'dungeons/zones/halls.webp']) {
    fs.mkdirSync(path.dirname(path.join(assetsDir, file)), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, file), Buffer.from('RIFF0000WEBPVP8 '));
  }
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
async function call(handler: Handler, prov: Provisioned, args: string[]): Promise<Payload> {
  const c = click();
  await handler(ctx, c.i, prov, args);
  return c.last();
}
const embedOf = (p: Payload) => p.embeds![0]!.toJSON();
const buttonsOf = (p: Payload) => (p.components ?? []).flatMap((row) => row.toJSON().components);
const fieldOf = (p: Payload, name: RegExp) => embedOf(p).fields?.find((f) => name.test(f.name));
/** A choice's own field on the event screen: `▸ Label` when it can be picked, `🚫 Label` when it cannot. */
const choiceField = (p: Payload, label: string) => embedOf(p).fields?.find((f) => f.name === `▸ ${label}` || f.name === `🚫 ${label}`);
const partsOf = (button: ButtonJson) => {
  const parsed = parseCustomId(button.custom_id!);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not a wm id: ${button.custom_id}`);
  return parsed;
};
const choiceButtons = (p: Payload) => buttonsOf(p).filter((b) => partsOf(b).action === 'ev');
const buttonOf = (p: Payload, label: RegExp) => {
  const found = buttonsOf(p).find((b) => label.test(b.label ?? ''));
  if (!found) throw new Error(`no button ${String(label)} among ${buttonsOf(p).map((b) => b.label).join(', ')}`);
  return found;
};
const HANDLERS: Record<string, Handler> = { ev: handleDungeonChoose, mv: handleDungeonMove, act: handleDungeonAct, run: handleDungeonRun, abq: handleDungeonAbandonConfirm };
const press = (prov: Provisioned, screen: Payload, label: RegExp) => {
  const { action, args } = partsOf(buttonOf(screen, label));
  return call(HANDLERS[action]!, prov, args);
};
const held = async (playerId: number, slug: string) =>
  (await w.t.db.select().from(playerInventory).where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, itemIds[slug]!))))[0]?.quantity ?? 0;
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;

async function publish(patch: (d: DungeonDefinitionInput) => void = () => {}): Promise<DungeonDefinition> {
  const input = eventDungeonInput(`ev_dc_${++n}`);
  patch(input);
  await w.publish(input);
  return DungeonDefinitionSchema.parse(input);
}
function seedFor(definition: DungeonDefinition, hall: string | null, accept: (seed: number) => boolean = () => true): number {
  const pure = eventContext(definition, { rewards: null });
  for (let seed = 0; seed < 5000; seed++) {
    if (startDungeonRun(pure, seed).state.events!['hall:find']!.eventId === hall && accept(seed)) return seed;
  }
  throw new Error('no seed');
}
const lockSucceeds = (seed: number) => rollEventCheck(LOCK, SP, { roomId: 'vault', actionId: 'door', choiceId: 'pick_lock' }, dungeonRngSource(seed)).success;
/** A player looking at the Sealed Vault screen. */
async function atVault(definition: DungeonDefinition, opts: { keys?: number; accept?: (seed: number) => boolean } = {}) {
  const { playerId } = await w.player();
  const prov = { playerId, guildDbId: 1 } as Provisioned;
  if (opts.keys) await w.app.inventory.addItem(w.t.db, playerId, itemIds.vault_key!, opts.keys);
  const start = await w.runs.start(playerId, definition.key, { seed: seedFor(definition, null, opts.accept) });
  const hall = await call(handleDungeonRun, prov, [String(start.id)]);
  const screen = await press(prov, hall, /Vault Door/);
  return { playerId, prov, runId: start.id, screen };
}

describe('the event screen', () => {
  it('shows the title, the narrative and one button per choice, with Abandon and the menu kept', async () => {
    const definition = await publish();
    const { screen, runId } = await atVault(definition, { keys: 1 });
    const embed = embedOf(screen);
    expect(embed.description).toContain('**The Sealed Vault**');
    expect(embed.description).toContain('A blast door fills the corridor.');
    // The hidden, unavailable choice is not listed; the rest are, in authored order.
    expect(choiceButtons(screen).map((b) => b.label)).toEqual(['Use the Vault Key', 'Work the lock (53.5%)', 'Force it', 'Leave it']);
    expect(choiceButtons(screen).every((b) => !b.disabled)).toBe(true);
    expect(choiceField(screen, 'Whisper the code')).toBeUndefined();
    expect(['Use the Vault Key', 'Work the lock', 'Force it', 'Leave it'].map((label) => choiceField(screen, label)?.name)).toEqual([
      '▸ Use the Vault Key', '▸ Work the lock', '▸ Force it', '▸ Leave it',
    ]);
    const row = await rowOf(runId);
    expect(choiceButtons(screen).map((b) => partsOf(b).args)).toEqual(
      ['use_key', 'pick_lock', 'force', 'leave'].map((choiceId) => [String(runId), String(row.step), choiceId]),
    );
    expect(buttonsOf(screen).map((b) => b.label)).toEqual(expect.arrayContaining(['Abandon', 'Delve menu']));
    // No single "carry out" button: an event is answered with a choice.
    expect(buttonsOf(screen).some((b) => partsOf(b).action === 'act')).toBe(false);
  });

  it('states the exact success chance and that an item is consumed when selected', async () => {
    const definition = await publish((d) => {
      d.events![0]!.choices[1]!.items = [{ item: 'vault_key', quantity: 1, consume: true }];
      d.events![0]!.choices[2]!.items = [{ item: 'scrap_parts', quantity: 2, consume: false }];
    });
    const { screen } = await atVault(definition, { keys: 1 });
    const block = (label: string) => choiceField(screen, label)!.value;
    // No check: spent on selecting.
    expect(block('Use the Vault Key')).toContain('Needs 1× Vault Key (you have 1).');
    expect(block('Use the Vault Key')).toContain(CONSUMED_WHEN_SELECTED);
    expect(block('Use the Vault Key')).not.toContain('even if');
    // With a check: said in full, with the exact chance.
    expect(block('Work the lock')).toContain('Consumed when selected, even if the check fails.');
    expect(CONSUMED_EVEN_IF_CHECK_FAILS).toBe('Consumed when selected, even if the check fails.');
    expect(block('Work the lock')).toContain('Success chance: **53.5%**');
    // Held but not spent: no consumption line.
    expect(block('Force it')).toContain('Needs 2× Scrap Parts (you have 0).');
    expect(block('Force it')).not.toContain('Consumed');
  });

  it('shows an unavailable choice disabled, with why', async () => {
    const definition = await publish();
    const { screen, prov, runId } = await atVault(definition);
    const key = buttonOf(screen, /Use the Vault Key/);
    expect(key).toMatchObject({ disabled: true, emoji: { name: '🚫' } });
    const told = choiceField(screen, 'Use the Vault Key')!;
    expect(told.name).toBe('🚫 Use the Vault Key');
    expect(told.value).toContain('You have no Vault Key.');
    expect(told.value).toContain('(you have 0)');
    // Discord would not send a disabled press; a forged one is refused and changes nothing.
    const before = await rowOf(runId);
    const refused = await call(handleDungeonChoose, prov, partsOf(key).args);
    expect(refused.content).toBe(CHOICE_UNAVAILABLE_NOTICE);
    expect(await rowOf(runId)).toEqual(before);
    // An old "advance" button aimed at an event asks for a choice instead.
    expect((await call(handleDungeonAct, prov, [String(runId), String(before.step), 'a'])).content).toBe(CHOICE_REQUIRED_NOTICE);
    expect((await call(handleDungeonChoose, prov, [String(runId), String(before.step), 'Not An Id'])).content).toMatch(/malformed/);
  });

  it('does not offer walking away at the entrance', async () => {
    const definition = await publish();
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const start = await w.runs.start(playerId, definition.key, { seed: seedFor(definition, 'buried_crate') });
    const screen = await call(handleDungeonRun, prov, [String(start.id)]);
    expect(buttonOf(screen, /Come back later/)).toMatchObject({ disabled: true });
    expect(choiceField(screen, 'Come back later')!.value).toContain('There is nowhere to go back to.');
    expect(buttonOf(screen, /Dig it out/).disabled).toBeFalsy();
  });
});

describe('answering an event', () => {
  it('paints the result: the choice, the item used, the committed rewards and the next thing to do', async () => {
    const definition = await publish();
    const { screen, prov, playerId } = await atVault(definition, { keys: 1 });
    const result = await press(prov, screen, /Use the Vault Key/);
    const told = fieldOf(result, /The Sealed Vault — Use the Vault Key/)!;
    expect(told.value).toContain('The door rolls aside.');
    expect(told.value).toContain('Used 1× Vault Key');
    expect(fieldOf(result, /At Risk earned/)!.value).toMatch(/\+.*5/);
    expect(fieldOf(result, /Kept this step/)!.value).toContain('Scrap Parts');
    expect(await held(playerId, 'vault_key')).toBe(0);
    // The run carries on to the activity the choice unlocked.
    expect(buttonsOf(result).some((b) => partsOf(b).action === 'act')).toBe(true);
    expect(choiceButtons(result)).toEqual([]);
  });

  it('shows a check’s outcome with its chance, and the HP an outcome cost or restored', async () => {
    const definition = await publish();
    const won = await atVault(definition, { accept: lockSucceeds });
    const success = await press(won.prov, won.screen, /Work the lock/);
    expect(fieldOf(success, /Work the lock/)!.value).toMatch(/✅ \*\*Success\*\* — 53\.5% chance\nIt opens\./);

    const lost = await atVault(definition, { accept: (seed) => !lockSucceeds(seed) });
    const failure = await press(lost.prov, lost.screen, /Work the lock/);
    expect(fieldOf(failure, /⚠️ The Sealed Vault — Work the lock/)!.value).toMatch(/❌ \*\*Failed\*\* — 53\.5% chance\nThe mechanism jams\./);

    const forced = await atVault(definition);
    const hurt = await press(forced.prov, forced.screen, /Force it/);
    const row = await rowOf(forced.runId);
    const max = (row.fighter as { maxHp: number }).maxHp;
    expect(fieldOf(hurt, /Force it/)!.value).toContain(`HP ${max} → **${row.currentHp}** / ${max} (−${max - row.currentHp})`);
    expect(row.currentHp).toBe(max - Math.trunc(max * 0.25));
  });

  it('repaints where the run is for a stale or repeated press, without doing anything twice', async () => {
    const definition = await publish();
    const { screen, prov, playerId, runId } = await atVault(definition, { keys: 2 });
    const first = await press(prov, screen, /Use the Vault Key/);
    const after = await rowOf(runId);
    // The same button again, as a double click or a Discord retry sends it.
    const again = await press(prov, screen, /Use the Vault Key/);
    expect(again.content).toBe(STALE_STEP_NOTICE);
    expect(embedOf(again).fields).toEqual(embedOf(first).fields);
    expect(await rowOf(runId)).toEqual(after);
    expect(await held(playerId, 'vault_key')).toBe(1);
    expect(await held(playerId, 'scrap_parts')).toBe(2);
    // A different choice from the old screen is stale too.
    expect((await press(prov, screen, /Force it/)).content).toBe(STALE_STEP_NOTICE);
  });

  it('says the item is gone and leaves the event open when it was spent elsewhere mid-press', async () => {
    const definition = await publish();
    const { screen, prov, playerId, runId } = await atVault(definition, { keys: 1 });
    const before = await rowOf(runId);
    const real = w.app.inventory.consumeItem.bind(w.app.inventory);
    const spy = vi.spyOn(w.app.inventory, 'consumeItem').mockImplementationOnce(async (tx, player, itemId, quantity) => {
      await real(w.t.db, player, itemId, quantity);
      return real(tx, player, itemId, quantity);
    });
    const painted = await press(prov, screen, /Use the Vault Key/);
    spy.mockRestore();
    expect(painted.content).toMatch(/You no longer have what that choice needs\. Nothing was used and nothing changed\./);
    expect(await rowOf(runId)).toEqual(before);
    expect(await held(playerId, 'scrap_parts')).toBe(0);
    // The same event, repainted, with that choice now locked and the others live.
    expect(embedOf(painted).description).toContain('**The Sealed Vault**');
    expect(buttonOf(painted, /Use the Vault Key/).disabled).toBe(true);
    expect((await press(prov, painted, /Force it/)).content).toBe('');
  });

  it('walks away and comes back to the same event', async () => {
    const definition = await publish();
    const { screen, prov } = await atVault(definition);
    const away = await press(prov, screen, /Leave it/);
    expect(embedOf(away).description).toContain('You step back.');
    expect(embedOf(away).description).toContain('You turn back to');
    const back = await press(prov, away, /Vault Door/);
    expect(choiceButtons(back).map((b) => b.label)).toEqual(choiceButtons(screen).map((b) => b.label));
  });
});

describe('event artwork', () => {
  const sceneOf = (p: Payload) => embedOf(p).image?.url ?? null;
  it('shows the event’s own picture, then the room’s, then the dungeon’s, and never composes the Buddy into it', async () => {
    const withArt = (art: { event?: boolean; room?: boolean; background?: boolean; zone?: boolean }) => (d: DungeonDefinitionInput) => {
      if (art.event) d.events![0]!.artwork = { kind: 'shipped', path: 'dungeons/events/sealed_vault.webp' };
      if (art.room) d.rooms[1]!.background = { kind: 'shipped', path: 'dungeons/backgrounds/vault_room.webp' };
      if (art.background) d.background = { kind: 'shipped', path: 'dungeons/backgrounds/halls.webp' };
      if (art.zone) d.artwork = { kind: 'shipped', path: 'dungeons/zones/halls.webp' };
    };
    const shown = async (art: Parameters<typeof withArt>[0]) => sceneOf((await atVault(await publish(withArt(art)))).screen);
    expect(await shown({ event: true, room: true, background: true, zone: true })).toBe('attachment://dungeon-sealed-vault.webp');
    expect(await shown({ room: true, background: true, zone: true })).toBe('attachment://dungeon-vault-room.webp');
    expect(await shown({ background: true, zone: true })).toBe('attachment://dungeon-halls.webp');
    expect(await shown({ zone: true })).toBe('attachment://dungeon-halls.webp');
    expect(await shown({})).toBeNull();

    // The picture is the file as uploaded: one scene attachment, and the Buddy only as the usual thumbnail.
    const { screen } = await atVault(await publish(withArt({ event: true })));
    expect(embedOf(screen).thumbnail?.url).toBe('attachment://waifumon-buddy.webp');
    expect((screen.files ?? []).map((f) => f.name)).toEqual(['dungeon-sealed-vault.webp', 'waifumon-buddy.webp']);
  });
});

describe('Discord limits', () => {
  it('keeps the longest possible event inside the embed and button limits', async () => {
    const id = (prefix: string) => `${prefix}_${'x'.repeat(40 - prefix.length - 1)}`;
    const definition = await publish((d) => {
      d.events![0] = {
        id: 'sealed_vault',
        title: 'T'.repeat(80),
        text: 'N'.repeat(1500),
        choices: Array.from({ length: 5 }, (_, c) => ({
          id: id(`c${c}`),
          label: 'L'.repeat(60),
          description: 'D'.repeat(200),
          unavailableText: 'U'.repeat(120),
          ...(c < 4 ? { items: [{ item: 'vault_key', quantity: 99, consume: true }, { item: 'scrap_parts', quantity: 99, consume: true }] } : {}),
          ...(c > 0 && c < 4
            ? { check: { type: 'sp' as const, baseChanceBasisPoints: 3333, maxSpModifierBasisPoints: 1234 }, success: { text: 'S'.repeat(800) }, failure: { text: 'F'.repeat(800) } }
            : { outcome: { text: 'O'.repeat(800) } }),
        })),
      };
      d.rooms[1]!.description = 'R'.repeat(600);
    });
    const { screen, prov } = await atVault(definition);
    expect(choiceButtons(screen)).toHaveLength(5);
    expect(embedOf(screen).description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    // A full embed gives up narrative, never a choice: all five are listed, each with its cost stated in full.
    const told = embedOf(screen).fields!.filter((f) => f.name.startsWith('🚫') || f.name.startsWith('▸'));
    expect(told).toHaveLength(5);
    expect(told.filter((f) => f.value.includes(CONSUMED_EVEN_IF_CHECK_FAILS))).toHaveLength(3);
    expect(told.filter((f) => f.value.includes(`**${CONSUMED_WHEN_SELECTED}**`))).toHaveLength(1);
    expect(told.every((f) => !f.value.endsWith('…'))).toBe(true);
    const open = buttonsOf(screen).filter((b) => partsOf(b).action === 'ev' && !b.disabled);
    expect(open).toHaveLength(1);
    const result = await call(handleDungeonChoose, prov, partsOf(open[0]!).args);
    expect(fieldOf(result, /T+ — L+/)!.value.length).toBeLessThanOrEqual(1024);
    expect(dgId.choose(Number.MAX_SAFE_INTEGER, 9_999_999, id('c0')).length).toBeLessThanOrEqual(MAX_CUSTOM_ID);
  });

  it('never painted a screen outside Discord’s limits', () => {
    expect(everyScreen.length).toBeGreaterThan(20);
    for (const screen of everyScreen) {
      const rows = (screen.components ?? []).map((row) => row.toJSON().components);
      expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
      for (const row of rows) {
        expect(row.length).toBeGreaterThan(0);
        expect(row.length).toBeLessThanOrEqual(MAX_ROW_BUTTONS);
        for (const button of row) {
          expect(button.custom_id!.length).toBeLessThanOrEqual(MAX_CUSTOM_ID);
          expect(button.label!.length).toBeLessThanOrEqual(MAX_LABEL);
        }
      }
      expect(new Set(rows.flat().map((b) => b.custom_id)).size).toBe(rows.flat().length);
      for (const embed of screen.embeds ?? []) {
        const e = embed.toJSON();
        const size = [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].reduce((sum, part) => sum + (part?.length ?? 0), 0);
        expect(size).toBeLessThanOrEqual(MAX_EMBED);
        expect((e.description ?? '').length).toBeLessThanOrEqual(MAX_DESCRIPTION);
        for (const field of e.fields ?? []) {
          expect(field.name.length).toBeLessThanOrEqual(256);
          expect(field.value.length).toBeLessThanOrEqual(1024);
        }
        expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
      }
    }
  });
});
