/**
 * Phase 4C1 — dungeon encounters on Discord, through the real handlers,
 * presenter, run service, capture service and database: the offered screen,
 * charm selection and the quoted odds, capture attempts and their results,
 * direct rescues, unavailable and Nothing outcomes, stale and duplicate
 * presses, resuming, post-commit notifications and Discord's limits.
 *
 * The engine and the transaction are covered in dungeonEncountersLive.test.ts;
 * this file only asks what the player sees and what is sent, and when.
 */
import { AttachmentBuilder } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dungeonRuns, playerActiveEffects, playerInventory, players, playerWaifus, species } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/discord/assets/attachRenderedCard')>()),
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy.webp' }),
    url: 'attachment://waifumon-buddy.webp',
  })),
  ownedCardImage: vi.fn(async () => ({
    file: new AttachmentBuilder(Buffer.from('card'), { name: 'waifumon-card.webp' }),
    url: 'attachment://waifumon-card.webp',
  })),
  renderOwnedCardAttachment: vi.fn(async () => null),
}));

import {
  handleDungeonCapture,
  handleDungeonCharm,
  handleDungeonEncounterGone,
  handleDungeonLeaveEncounter,
  handleDungeonRescue,
  handleDungeonRun,
  handleDungeonAct,
  handleDungeonMove,
} from '../../src/discord/commands/waifumonDungeon';
import {
  CAPTURE_ITEM_REQUIRED_NOTICE,
  CHARM_SPENT_PER_ATTEMPT,
  ENCOUNTER_STILL_HERE_NOTICE,
  NO_USABLE_CHARM,
  STALE_STEP_NOTICE,
  dgId,
} from '../../src/discord/dungeonPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import type { DungeonDefinition } from '../../src/modules/dungeons/content/dungeonDefinition';
import type { DungeonRunService } from '../../src/modules/dungeons/dungeonRunService';
import { dungeonRngSource } from '../../src/modules/dungeons/engine/seeds';
import { DungeonStepContendedError } from '../../src/shared/errors';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
import { createEventHarness, getItemBySlug, insertOwnedWaifu, type EventHarness } from '../helpers/fixtures';
import { silentLogger } from '../helpers/testDb';

interface ComponentJson {
  type?: number;
  custom_id?: string;
  label?: string;
  disabled?: boolean;
  placeholder?: string;
  options?: { label: string; value: string; description?: string; default?: boolean }[];
}
interface EmbedJson { title?: string; description?: string; fields?: { name: string; value: string }[]; image?: { url: string }; thumbnail?: { url: string } }
interface Payload { content?: string; embeds?: { toJSON(): EmbedJson }[]; components?: { toJSON(): { components: ComponentJson[] } }[]; files?: { name?: string }[] }
type Handler = (ctx: AppContext, i: never, prov: Provisioned, args: string[]) => Promise<unknown>;

const COMMON = 'neko_barista'; // N
const OTHER = 'gym_oni'; // N
const RARE = 'neon_kitsune'; // SR: announced
const CHARM = 'basic_charm';
const SILK = 'silk_charm';
const CONTRACT = 'mythic_contract'; // guaranteed
const ROOM = 'hall';
const ACTION = 'meet';
const SELECT = 3;

let w: DungeonWorld;
let ctx: AppContext;
let harness: EventHarness;
let keySeq = 0;
const everyScreen: Payload[] = [];
/** Every public message the announce channel was sent. */
const announced: { content?: string; embeds?: { toJSON(): EmbedJson }[] }[] = [];

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.allowance.updateSettings({ dailyRunLimit: 50 }, 'test');
  // Neutral matchups everywhere, so no case depends on what the corpus ships.
  await w.t.db.update(species).set({ affinity: 'switch' });
  harness = createEventHarness(w.app);
  ctx = {
    config: { assetsDir: w.artworkDir },
    logger: silentLogger(),
    content: w.app.content,
    events: harness.bus,
    services: {
      dungeonRuns: w.runs,
      dungeonContent: w.content,
      dungeonAllowance: w.allowance,
      collection: w.app.collection,
      session: w.app.session,
      guilds: w.app.guilds,
      appearance: w.app.appearance,
    },
  } as unknown as AppContext;
});
afterAll(async () => {
  await w?.cleanup();
});

function interaction(values?: string[]) {
  const painted: Payload[] = [];
  const followUps: unknown[] = [];
  const paint = vi.fn(async (body: unknown) => {
    const payload = typeof body === 'string' ? { content: body } : (body as Payload);
    painted.push(payload);
    everyScreen.push(payload);
  });
  const i = {
    replied: false,
    deferred: false,
    isButton: () => values === undefined,
    isStringSelectMenu: () => values !== undefined,
    ...(values ? { values } : {}),
    update: paint,
    reply: paint,
    editReply: paint,
    followUp: vi.fn(async (body: unknown) => {
      followUps.push(body);
      return { id: 'toast' };
    }),
    guildId: 'g-encounter-discord',
    channelId: 'c-play',
    user: { id: 'u-encounter', username: 'tester' },
    client: { channels: { fetch: async () => ({ send: async (message: (typeof announced)[number]) => { announced.push(message); } }) } },
  };
  return { i: i as never, last: () => painted[painted.length - 1]!, followUps };
}
async function call(handler: Handler, prov: Provisioned, args: string[], values?: string[]): Promise<Payload> {
  const c = interaction(values);
  await handler(ctx, c.i, prov, args);
  return c.last();
}
const embedOf = (p: Payload) => p.embeds![0]!.toJSON();
const componentsOf = (p: Payload) => (p.components ?? []).flatMap((row) => row.toJSON().components);
const buttonsOf = (p: Payload) => componentsOf(p).filter((c) => c.type !== SELECT);
const menuOf = (p: Payload) => componentsOf(p).find((c) => c.type === SELECT);
const fieldOf = (p: Payload, name: RegExp) => embedOf(p).fields?.find((f) => name.test(f.name));
const partsOf = (component: ComponentJson) => {
  const parsed = parseCustomId(component.custom_id!);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not a wm id: ${component.custom_id}`);
  return parsed;
};
const buttonOf = (p: Payload, label: RegExp) => {
  const found = buttonsOf(p).find((b) => label.test(b.label ?? ''));
  if (!found) throw new Error(`no button ${String(label)} among ${buttonsOf(p).map((b) => b.label).join(', ')}`);
  return found;
};
const HANDLERS: Record<string, Handler> = {
  cap: handleDungeonCapture,
  res: handleDungeonRescue,
  cl: handleDungeonLeaveEncounter,
  cu: handleDungeonEncounterGone,
  run: handleDungeonRun,
  act: handleDungeonAct,
  mv: handleDungeonMove,
};
const press = (prov: Provisioned, screen: Payload, label: RegExp) => {
  const { action, args } = partsOf(buttonOf(screen, label));
  return call(HANDLERS[action]!, prov, args);
};
/** Choose a charm from the screen's menu, as Discord sends the selection. */
const choose = (prov: Provisioned, screen: Payload, item: string) => call(handleDungeonCharm as Handler, prov, partsOf(menuOf(screen)!).args, [item]);

async function held(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(w.t.db, slug);
  const [row] = await w.t.db.select({ quantity: playerInventory.quantity }).from(playerInventory)
    .where(and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, item.id)));
  return row?.quantity ?? 0;
}
const give = async (playerId: number, slug: string, quantity: number) =>
  w.app.inventory.addItem(w.t.db, playerId, (await getItemBySlug(w.t.db, slug)).id, quantity);
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
const copiesOf = (playerId: number) => w.t.db.select().from(playerWaifus).where(eq(playerWaifus.playerId, playerId));
const speciesId = async (slug: string) => (await w.t.db.select({ id: species.id }).from(species).where(eq(species.slug, slug)))[0]!.id;

/** A one-room dungeon whose hall offers the encounter, then (with the lever pulled) a nap. */
async function publish(action: Record<string, unknown>, patch: (d: Record<string, unknown>) => void = () => {}): Promise<DungeonDefinition> {
  const key = `enc_dc_${++keySeq}`;
  const definition = singleRoomDungeon(
    [
      { id: ACTION, ...action } as never,
      { id: 'nap', type: 'rest', label: 'Nap', healBasisPoints: 1000, when: { type: 'flag', flag: 'lever' } } as never,
    ],
    (input) => {
      input.key = key;
      patch(input as unknown as Record<string, unknown>);
    },
  );
  await w.publish(definition);
  return definition;
}
const wild = (slug: string, capture: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  type: 'wild_encounter',
  source: { kind: 'species', species: slug },
  intro: 'A figure steps out of the steam.',
  capture,
  ...over,
});
const direct = (slug: string, over: Record<string, unknown> = {}) => ({
  type: 'rescue',
  mode: 'direct',
  source: { kind: 'species', species: slug },
  intro: 'She is chained to the wall.',
  ...over,
});

/** Species content opting her in to a direct rescue from the next dungeon `publish` makes, once per player. */
const allowRescue = (slug: string) => w.speciesAccess.set(slug, [{ dungeon: `enc_dc_${keySeq + 1}`, directRescue: true, perPlayerLimit: 1 }]);

const attemptRoll = (seed: number, n: number) => dungeonRngSource(seed).stream('encounter', ROOM, ACTION, 'attempt', n).next();
function seedWhere(want: (roll: number) => boolean, attempts = 3): number {
  for (let seed = 1; seed < 200_000; seed += 1) if (Array.from({ length: attempts }, (_, n) => n + 1).every((n) => want(attemptRoll(seed, n)))) return seed;
  throw new Error('no seed found');
}
/** Every capture attempt misses: no clamped chance reaches 0.95. */
const MISSES = () => seedWhere((roll) => roll >= 0.95);
/** The first attempt lands whatever the charm: under the 0.02 floor. */
const HITS = () => seedWhere((roll) => roll < 0.02, 1);

/** A player standing on the offered encounter, with the screen they see. */
async function atEncounter(definition: DungeonDefinition, opts: { seed?: number; charms?: Record<string, number> } = {}) {
  const { playerId } = await w.player();
  const [{ guildDbId }] = await w.t.db.select({ guildDbId: players.guildId }).from(players).where(eq(players.id, playerId)) as [{ guildDbId: number }];
  const prov = { playerId, guildDbId } as Provisioned;
  for (const [slug, quantity] of Object.entries(opts.charms ?? {})) await give(playerId, slug, quantity);
  const start = await w.runs.start(playerId, definition.key, opts.seed === undefined ? {} : { seed: opts.seed });
  const screen = await call(handleDungeonRun, prov, [String(start.id)]);
  return { playerId, prov, runId: start.id, screen };
}

describe('the offered encounter', () => {
  it('shows her name, rarity and introduction, the attempts left, the cost, and only owned, usable charms with the service’s quote', async () => {
    const definition = await publish(wild(RARE, {}, { label: 'Steam Vent' }));
    const { screen, runId, playerId } = await atEncounter(definition, { charms: { [CHARM]: 2, [SILK]: 1 } });
    const embed = embedOf(screen);
    expect(embed.description).toContain('**Steam Vent**');
    expect(embed.description).toContain('**Neon Kitsune** · SR');
    expect(embed.description).toContain('A figure steps out of the steam.');
    const capture = fieldOf(screen, /🎯 Capture/)!.value;
    expect(capture).toContain('Attempts left: **3**');
    expect(capture).toContain(`**${CHARM_SPENT_PER_ATTEMPT}**`);
    expect(capture).toContain('Choose a charm below');

    // The menu lists exactly what the service quoted, in its words — no Discord-side odds.
    const offered = (await w.runs.run(playerId, runId)).core.action!.encounter!;
    const menu = menuOf(screen)!;
    expect(menu.placeholder).toBe('Choose a capture charm…');
    expect(menu.options!.map((o) => o.value)).toEqual(offered.items.map((i) => i.item));
    expect(menu.options!.map((o) => o.label)).toEqual(['Basic Charm ×2', 'Silk Charm ×1']);
    for (const option of menu.options!) {
      const quoted = offered.items.find((i) => i.item === option.value)!;
      expect(option.description).toBe(`Capture chance: ${Math.round(quoted.chance * 1000) / 10}% · used on Capture`.replace(/\.0%/, '%'));
      expect(option.default).toBe(false);
    }
    const step = (await rowOf(runId)).step;
    expect(partsOf(menu).args).toEqual([String(runId), String(step)]);
    // Capture waits for a charm; the charm is never in a button id.
    expect(buttonOf(screen, /^Capture$/)).toMatchObject({ disabled: true, custom_id: dgId.capture(runId, step) });
    expect(buttonOf(screen, /Leave her/).custom_id).toBe(dgId.leaveEncounter(runId, step));
    expect(buttonsOf(screen).some((b) => b.custom_id!.includes(CHARM))).toBe(false);
    expect(buttonsOf(screen).map((b) => b.label)).toEqual(expect.arrayContaining(['Abandon', 'Back to Waifumon']));
    // No internal ids, slugs or rolls on the screen.
    const text = JSON.stringify(embed);
    for (const leak of [RARE, CHARM, 'grant', 'seed', 'roll']) expect(text).not.toContain(leak);
  });

  it('with no usable charm says why and offers only Leave', async () => {
    const definition = await publish(wild(COMMON, { allowedItems: [SILK] }));
    const { screen } = await atEncounter(definition, { charms: { [CHARM]: 3 } });
    expect(fieldOf(screen, /🎯 Capture/)!.value).toContain(NO_USABLE_CHARM);
    expect(menuOf(screen)).toBeUndefined();
    expect(buttonsOf(screen).filter((b) => ['cap', 'cl', 'res', 'cu'].includes(partsOf(b).action)).map((b) => b.label)).toEqual(['Leave her']);
  });

  it('a guaranteed charm is offered only where the encounter allows one, and says so', async () => {
    const allowed = await atEncounter(await publish(wild(COMMON)), { charms: { [CONTRACT]: 1 } });
    expect(menuOf(allowed.screen)!.options).toEqual([expect.objectContaining({ value: CONTRACT, description: 'Guaranteed capture · used on Capture' })]);
    const refused = await atEncounter(await publish(wild(COMMON, { allowGuaranteedItems: false })), { charms: { [CONTRACT]: 1 } });
    expect(menuOf(refused.screen)).toBeUndefined();
  });
});

describe('choosing a charm', () => {
  it('stores the choice on the run, spends nothing, and enables Capture for it', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1, [SILK]: 1 } });
    const before = await rowOf(runId);
    const chosen = await choose(prov, screen, SILK);
    expect(chosen.content).toBe('');
    const after = await rowOf(runId);
    expect(after.step).toBe(before.step + 1);
    expect((after.encounterStates as Record<string, { selectedItem?: string }>)[`${ROOM}:${ACTION}`]!.selectedItem).toBe(SILK);
    expect(await held(playerId, SILK)).toBe(1);
    expect(menuOf(chosen)!.options!.find((o) => o.default)?.value).toBe(SILK);
    expect(fieldOf(chosen, /🎯 Capture/)!.value).toMatch(/Charm: \*\*Silk Charm\*\* — \*\*\d+(\.\d)?% capture chance\*\*/);
    expect(buttonOf(chosen, /Capture — Silk Charm/).disabled).toBeFalsy();
    // The menu from the first screen is now stale: reopening it cannot change the step it acts on.
    const again = await choose(prov, screen, CHARM);
    expect(again.content).toBe(STALE_STEP_NOTICE);
    expect(await rowOf(runId)).toEqual(after);
  });

  it('refuses a forged Capture before any charm is chosen, and a forged menu value', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    const before = await rowOf(runId);
    const forced = await call(handleDungeonCapture as Handler, prov, partsOf(buttonOf(screen, /^Capture$/)).args);
    expect(forced.content).toBe(CAPTURE_ITEM_REQUIRED_NOTICE);
    expect(await rowOf(runId)).toEqual(before);
    expect((await call(handleDungeonCharm as Handler, prov, partsOf(menuOf(screen)!).args, ['Not A Slug!'])).content).toMatch(/malformed/);
    expect((await call(handleDungeonCharm as Handler, prov, partsOf(menuOf(screen)!).args, [SILK])).content).toMatch(/can’t be used on her right now/);
    expect(await rowOf(runId)).toEqual(before);
  });
});

describe('capture attempts', () => {
  it('a missed attempt keeps her here, says so, and shows the charms and odds left', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId } = await atEncounter(definition, { seed: MISSES(), charms: { [CHARM]: 2 } });
    const missed = await press(prov, await choose(prov, screen, CHARM), /Capture — Basic Charm/);
    const told = fieldOf(missed, /😤 Neko Barista broke free/)!.value;
    expect(told).toMatch(/Used \*\*Basic Charm\*\* — \d+(\.\d)?% chance\./);
    expect(told).toContain('She is still here — **2** attempts left.');
    expect(told).toContain('+2 XP');
    expect(fieldOf(missed, /🎯 Capture/)!.value).toContain('Attempts left: **2**');
    expect(menuOf(missed)!.options).toEqual([expect.objectContaining({ value: CHARM, label: 'Basic Charm ×1', default: true })]);
    expect(buttonOf(missed, /Capture — Basic Charm/).disabled).toBeFalsy();
    expect(await held(playerId, CHARM)).toBe(1);
    expect(missed.content).toBe('');
    // Not the end of anything: no escape, no Continue.
    expect(embedOf(missed).fields!.some((f) => /escaped/.test(f.name))).toBe(false);
    expect(harness.ofKind('PLAYER_CAPTURE_FAILED').filter((e) => e.playerId === playerId)).toEqual([]);
  });

  it('a different charm can be chosen for the next attempt', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId } = await atEncounter(definition, { seed: MISSES(), charms: { [CHARM]: 1, [SILK]: 1 } });
    const missed = await press(prov, await choose(prov, screen, CHARM), /Capture — Basic Charm/);
    // The spent charm is gone from the menu; the other is offered with its own quote.
    expect(menuOf(missed)!.options!.map((o) => o.value)).toEqual([SILK]);
    expect(buttonOf(missed, /^Capture$/).disabled).toBe(true);
    const second = await press(prov, await choose(prov, missed, SILK), /Capture — Silk Charm/);
    expect(fieldOf(second, /broke free/)!.value).toContain('Used **Silk Charm**');
    expect(fieldOf(second, /broke free/)!.value).toContain('**1** attempt left.');
    expect(await held(playerId, SILK)).toBe(0);
  });

  it('the last miss: she escapes, the run moves on, and the escape is narrated once', async () => {
    const definition = await publish(wild(COMMON, { maxAttempts: 1 }, { results: { escaped: { text: 'She vanishes into the vents.' } } }));
    const { screen, prov, playerId } = await atEncounter(definition, { seed: MISSES(), charms: { [CHARM]: 1 } });
    const gone = await press(prov, await choose(prov, screen, CHARM), /Capture — Basic Charm/);
    const told = fieldOf(gone, /💨 Neko Barista escaped/)!.value;
    expect(told).toContain('She vanishes into the vents.');
    expect(told).toContain('Used **Basic Charm**');
    // No encounter controls; the normal way on (no lever pulled: no nap, straight to the exit).
    expect(menuOf(gone)).toBeUndefined();
    expect(buttonsOf(gone).some((b) => ['cap', 'cl', 'res', 'cu'].includes(partsOf(b).action))).toBe(false);
    expect(buttonOf(gone, /Out/)).toBeDefined();
    expect(harness.ofKind('PLAYER_CAPTURE_FAILED').filter((e) => e.playerId === playerId)).toHaveLength(1);
  });

  it('a capture: her card, the result in the author’s words, new-dex and XP, the routing her flags open — and one announcement', async () => {
    const definition = await publish(wild(RARE, {}, { results: { captured: { text: 'She takes your hand.', flags: [{ flag: 'lever', value: true }] } } }));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { seed: HITS(), charms: { [CHARM]: 1 } });
    const sent = announced.length;
    const chosen = await choose(prov, screen, CHARM);
    const caught = await press(prov, chosen, /Capture — Basic Charm/);
    const told = fieldOf(caught, /💖 You captured Neon Kitsune \(SR\)!/)!.value;
    expect(told).toContain('She takes your hand.');
    expect(told).toContain('✨ New to your collection!');
    expect(told).toMatch(/\+\d+ XP \(incl\. new dex\)/);
    expect(embedOf(caught).image?.url).toBe('attachment://waifumon-card.webp');
    // Her flag opened the nap: the run carries on to it.
    expect(buttonOf(caught, /^Nap$/)).toBeDefined();
    const copies = await copiesOf(playerId);
    expect(copies.filter((c) => c.acquiredVia === 'dungeon_capture')).toHaveLength(1);
    // Post-commit: one rare announcement, one feed event, a session entry.
    expect(announced.length).toBe(sent + 1);
    expect(announced.at(-1)!.embeds![0]!.toJSON().title).toBe('🌟 Neon Kitsune captured! (SR)');
    expect(harness.ofKind('PLAYER_CAPTURE_SUCCESS').filter((e) => e.playerId === playerId)).toHaveLength(1);

    // A double click, a Discord retry, and resuming the run: the same result, nothing sent again.
    const again = await press(prov, chosen, /Capture — Basic Charm/);
    expect(again.content).toBe(STALE_STEP_NOTICE);
    const resumed = await call(handleDungeonRun, prov, [String(runId)]);
    expect(fieldOf(resumed, /💖 You captured Neon Kitsune/)!.value).toContain('She takes your hand.');
    // A repaint has no receipt: it never invents the charm, the XP or the card.
    expect(fieldOf(resumed, /💖 You captured/)!.value).not.toContain('XP');
    expect(embedOf(resumed).image?.url).not.toBe('attachment://waifumon-card.webp');
    expect(announced.length).toBe(sent + 1);
    expect(harness.ofKind('PLAYER_CAPTURE_SUCCESS').filter((e) => e.playerId === playerId)).toHaveLength(1);
    expect((await copiesOf(playerId)).filter((c) => c.acquiredVia === 'dungeon_capture')).toHaveLength(1);
  });

  it('toasts the appearances a new copy unlocked, once, after the result — never on a repeated press', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov } = await atEncounter(definition, { charms: { [CONTRACT]: 1 } });
    const chosen = await choose(prov, screen, CONTRACT);
    // The service reports what the capture service returned; stand in a day-one unlock.
    const real = w.runs;
    const withUnlock: DungeonRunService = {
      ...real,
      act: async (...args) => {
        const result = await real.act(...args);
        return result.encounterReceipts
          ? { ...result, encounterReceipts: result.encounterReceipts.map((r) => ({ ...r, newAppearances: [{
            waifuId: r.acquired!.waifuId, speciesSlug: COMMON, appearanceId: 'festival', name: 'Festival Look',
            assetId: { slug: COMMON, variant: 'festival' }, cosmeticRarity: 'rare', unlockLabel: 'Caught in a dungeon', source: 'capture',
          } as never] })) }
          : result;
      },
    };
    (ctx.services as { dungeonRuns: DungeonRunService }).dungeonRuns = withUnlock;
    try {
      const first = interaction();
      await handleDungeonCapture(ctx, first.i, prov, partsOf(buttonOf(chosen, /Capture — Mythic Contract/)).args);
      expect(first.followUps).toHaveLength(1);
      expect(JSON.stringify(first.followUps[0])).toContain('Festival Look');
      const again = interaction();
      await handleDungeonCapture(ctx, again.i, prov, partsOf(buttonOf(chosen, /Capture — Mythic Contract/)).args);
      expect(again.last().content).toBe(STALE_STEP_NOTICE);
      expect(again.followUps).toEqual([]);
    } finally {
      (ctx.services as { dungeonRuns: DungeonRunService }).dungeonRuns = real;
    }
  });

  it('a duplicate offers the usual Keep / Convert prompt', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId } = await atEncounter(definition, { charms: { [CONTRACT]: 1 } });
    await insertOwnedWaifu(w.t.db, { playerId, speciesId: await speciesId(COMMON) });
    const caught = await press(prov, await choose(prov, screen, CONTRACT), /Capture — Mythic Contract/);
    const told = fieldOf(caught, /💖 You captured Neko Barista/)!.value;
    expect(told).toContain('You already have her — this one is a duplicate.');
    expect(told).toContain('guaranteed capture');
    const dup = buttonsOf(caught).filter((b) => partsOf(b).scope === 'dup');
    expect(dup.map((b) => partsOf(b).action)).toEqual(['keep', 'convert']);
    // Not announced: an N capture is below the rare threshold.
    expect(announced.some((m) => m.embeds?.[0]?.toJSON().title?.includes('Neko Barista'))).toBe(false);
  });

  it('leaving resolves her as left, with the author’s text, spending nothing', async () => {
    const definition = await publish(wild(COMMON, {}, { results: { left: { text: 'You back away slowly.' } } }));
    const { screen, prov, playerId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    const chosen = await choose(prov, screen, CHARM);
    const left = await press(prov, chosen, /Leave her/);
    expect(fieldOf(left, /👋 You left Neko Barista/)!.value).toBe('You back away slowly.');
    expect(await held(playerId, CHARM)).toBe(1);
    expect(menuOf(left)).toBeUndefined();
    // Stale: the Capture from the chosen screen no longer works and spends nothing.
    expect((await press(prov, chosen, /Capture — Basic Charm/)).content).toBe(STALE_STEP_NOTICE);
    expect(await held(playerId, CHARM)).toBe(1);
  });
});

describe('direct rescue', () => {
  it('offers Rescue and Leave, never a charm or a chance, and grants her with XP and the author’s text', async () => {
    allowRescue(OTHER);
    const definition = await publish(direct(OTHER, { results: { rescued: { text: 'The chains fall away.' } } }));
    try {
      const { screen, prov, playerId } = await atEncounter(definition, { charms: { [CHARM]: 5 } });
      expect(menuOf(screen)).toBeUndefined();
      expect(fieldOf(screen, /🎯 Capture/)).toBeUndefined();
      expect(fieldOf(screen, /🔓 Rescue/)!.value).toBe('No charm and no roll: free her and she joins your collection.');
      expect(JSON.stringify(embedOf(screen))).not.toMatch(/chance|charm used|Capture/i);
      expect(buttonsOf(screen).filter((b) => ['res', 'cl'].includes(partsOf(b).action)).map((b) => b.label)).toEqual(['Rescue her', 'Leave her']);
      const sent = announced.length;
      const freed = await press(prov, screen, /Rescue her/);
      const told = fieldOf(freed, /🔓 You rescued Gym Oni \(N\)!/)!.value;
      expect(told).toContain('The chains fall away.');
      expect(told).toMatch(/\+\d+ XP/);
      expect(told).not.toContain('Used');
      expect(embedOf(freed).image?.url).toBe('attachment://waifumon-card.webp');
      expect(await held(playerId, CHARM)).toBe(5);
      expect((await copiesOf(playerId)).filter((c) => c.acquiredVia === 'dungeon_rescue')).toHaveLength(1);
      // A rescue is not a capture: no capture announcement or capture event.
      expect(announced.length).toBe(sent);
      expect(harness.ofKind('PLAYER_CAPTURE_SUCCESS').filter((e) => e.playerId === playerId)).toEqual([]);
      expect((await press(prov, screen, /Rescue her/)).content).toBe(STALE_STEP_NOTICE);
      expect((await copiesOf(playerId)).filter((c) => c.acquiredVia === 'dungeon_rescue')).toHaveLength(1);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('declining leaves her where she is and grants nothing', async () => {
    allowRescue(OTHER);
    const definition = await publish(direct(OTHER));
    try {
      const { screen, prov, playerId } = await atEncounter(definition);
      const left = await press(prov, screen, /Leave her/);
      expect(fieldOf(left, /👋 You left Gym Oni/)!.value).toBe('You move on without her.');
      expect((await copiesOf(playerId)).filter((c) => c.acquiredVia === 'dungeon_rescue')).toEqual([]);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('once the limit is reached, a later run says she can’t join you — and why — without implying she did', async () => {
    allowRescue(OTHER);
    const definition = await publish(direct(OTHER, { results: { unavailable: { text: 'The cell is empty.' } } }));
    try {
      const first = await atEncounter(definition);
      await press(first.prov, first.screen, /Rescue her/);
      await w.runs.act(first.playerId, first.runId, { type: 'abandon' });
      const next = await w.runs.start(first.playerId, definition.key);
      const screen = await call(handleDungeonRun, first.prov, [String(next.id)]);
      const told = fieldOf(screen, /🚫 Gym Oni can’t join you/)!.value;
      expect(told).toContain('You’ve already taken as many of her from this dungeon as you can.');
      expect(told).toContain('The cell is empty.');
      expect(told).not.toMatch(/rescued|captured|XP/);
      expect(buttonsOf(screen).some((b) => partsOf(b).action === 'res')).toBe(false);
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });
});

describe('unavailable and Nothing', () => {
  /** Everything an acquisition could touch, to prove Continue touched none of it. */
  async function sideEffects(playerId: number) {
    const [player] = await w.t.db.select({ xp: players.xp, level: players.level }).from(players).where(eq(players.id, playerId));
    return {
      charms: await held(playerId, CHARM),
      effects: await w.t.db.select().from(playerActiveEffects).where(eq(playerActiveEffects.playerId, playerId)),
      player,
      copies: (await copiesOf(playerId)).length,
      announced: announced.length,
      events: harness.events.filter((e) => e.playerId === playerId).length,
    };
  }
  const continueButton = (screen: Payload) => {
    const button = buttonOf(screen, /^Continue$/);
    // The dedicated dismissal — never Capture or Rescue under another label.
    expect(partsOf(button).action).toBe('cu');
    return button;
  };

  it('a wild WaifuMon who became unobtainable: Continue resolves her unavailable down the authored route, touching nothing', async () => {
    const definition = await publish(wild(OTHER, {}, { results: { unavailable: { text: 'She is gone.', flags: [{ flag: 'lever', value: true }] } } }));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    await choose(prov, screen, CHARM);
    await w.app.effects.grantCaptureBonus(w.t.db, playerId, { sourceItemSlug: 'microdose', modifier: 0.1, charges: 2 });
    const id = await speciesId(OTHER);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.id, id));
    try {
      const shown = await call(handleDungeonRun, prov, [String(runId)]);
      expect(fieldOf(shown, /🚫 She can’t join you/)!.value).toContain('She can’t be found any more.');
      expect(menuOf(shown)).toBeUndefined();
      const before = await sideEffects(playerId);
      const c = interaction();
      await handleDungeonEncounterGone(ctx, c.i, prov, partsOf(continueButton(shown)).args);
      const resolved = c.last();
      expect(fieldOf(resolved, /🚫 Gym Oni can’t join you/)!.value).toContain('She is gone.');
      // Her result flag pulled the lever: the run follows the authored route to the nap.
      expect(buttonOf(resolved, /^Nap$/)).toBeDefined();
      expect(await sideEffects(playerId)).toEqual(before);
      expect(c.followUps).toEqual([]);
      const row = await rowOf(runId);
      expect(row.encounterStates).toMatchObject({ [`${ROOM}:${ACTION}`]: { species: OTHER, status: 'unavailable', unavailableReason: 'disabled', attempts: [] } });
      const types = (await w.runs.history(runId)).map((e) => e.type);
      expect(types.filter((t) => t === 'encounter_selected')).toHaveLength(1);
      expect(types).not.toContain('capture_attempted');
      expect(types).not.toContain('waifu_acquired');
      // Pressed again — a double click or a retry: stale, nothing changes, nothing is sent.
      const again = await press(prov, shown, /^Continue$/);
      expect(again.content).toBe(STALE_STEP_NOTICE);
      expect(await rowOf(runId)).toEqual(row);
      expect(await sideEffects(playerId)).toEqual(before);
    } finally {
      await w.t.db.update(species).set({ enabled: true }).where(eq(species.id, id));
    }
  });

  it('a wild WaifuMon obtainable again by the click: Continue is refused, spends nothing and leaves her offered', async () => {
    const definition = await publish(wild(OTHER));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    await choose(prov, screen, CHARM);
    const id = await speciesId(OTHER);
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.id, id));
    const shown = await call(handleDungeonRun, prov, [String(runId)]);
    await w.t.db.update(species).set({ enabled: true }).where(eq(species.id, id));
    const before = await sideEffects(playerId);
    const row = await rowOf(runId);
    continueButton(shown);
    const after = await press(prov, shown, /^Continue$/);
    expect(after.content).toBe(ENCOUNTER_STILL_HERE_NOTICE);
    expect(await rowOf(runId)).toEqual(row);
    expect(await sideEffects(playerId)).toEqual(before);
    // Repainted open, with the charm she had chosen still chosen.
    expect(buttonOf(after, /Capture — Basic Charm/).disabled).toBeFalsy();
  });

  it('a direct rescue never grants through Continue, whichever way eligibility moves between render and click', async () => {
    allowRescue(OTHER);
    const definition = await publish(direct(OTHER, { results: { unavailable: { text: 'The cell is empty.' } } }));
    const access = w.speciesAccess.get(OTHER)!;
    try {
      const { screen, prov, playerId, runId } = await atEncounter(definition);
      expect(buttonOf(screen, /Rescue her/)).toBeDefined();
      // Rescue authorisation withdrawn: the screen offers only Continue.
      w.speciesAccess.delete(OTHER);
      const shown = await call(handleDungeonRun, prov, [String(runId)]);
      expect(fieldOf(shown, /🚫 She can’t join you/)!.value).toContain('She can’t be rescued here.');
      expect(buttonsOf(shown).some((b) => partsOf(b).action === 'res')).toBe(false);
      const before = await sideEffects(playerId);
      // Restored before the click: Continue is refused; no copy, no XP, nothing sent.
      w.speciesAccess.set(OTHER, access);
      const row = await rowOf(runId);
      continueButton(shown);
      const refused = await press(prov, shown, /^Continue$/);
      expect(refused.content).toBe(ENCOUNTER_STILL_HERE_NOTICE);
      expect(await rowOf(runId)).toEqual(row);
      expect(await sideEffects(playerId)).toEqual(before);
      expect(buttonOf(refused, /Rescue her/)).toBeDefined();
      // Withdrawn again before the next click: resolved unavailable, still no copy.
      w.speciesAccess.delete(OTHER);
      const again = await call(handleDungeonRun, prov, [String(runId)]);
      continueButton(again);
      const resolved = await press(prov, again, /^Continue$/);
      expect(fieldOf(resolved, /🚫 Gym Oni can’t join you/)!.value).toContain('The cell is empty.');
      expect(await sideEffects(playerId)).toEqual(before);
      expect((await copiesOf(playerId)).filter((c) => c.acquiredVia === 'dungeon_rescue')).toEqual([]);
      expect((await w.runs.history(runId)).map((e) => e.type)).not.toContain('waifu_acquired');
    } finally {
      w.speciesAccess.delete(OTHER);
    }
  });

  it('a pool that draws nobody shows the author’s line and moves on', async () => {
    const definition = await publish(
      { type: 'wild_encounter', source: { kind: 'pool', poolId: 'empty' }, intro: 'Something rustles.', capture: {} },
      // Her entry needs the lever, which is never pulled: only Nothing can be drawn.
      (d) => { d.speciesPools = [{ id: 'empty', name: 'Empty', entries: [
        { id: 'her', weight: 1, species: COMMON, when: { type: 'flag', flag: 'lever' } },
        { id: 'no', weight: 1, nothing: true, text: 'Only the wind.' },
      ] }]; },
    );
    const { screen } = await atEncounter(definition);
    expect(embedOf(screen).description).toContain('_Only the wind._');
    expect(menuOf(screen)).toBeUndefined();
    expect(buttonOf(screen, /Out/)).toBeDefined();
  });
});

describe('refusals and rollbacks', () => {
  it('a charm spent elsewhere after it was chosen: the menu drops it and Capture is refused with nothing spent', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    const chosen = await choose(prov, screen, CHARM);
    await w.app.inventory.consumeItem(w.t.db, playerId, (await getItemBySlug(w.t.db, CHARM)).id, 1);
    const before = await rowOf(runId);
    const refused = await press(prov, chosen, /Capture — Basic Charm/);
    expect(refused.content).toMatch(/can’t be used on her right now\. Nothing was spent/);
    expect(await rowOf(runId)).toEqual(before);
    expect(fieldOf(refused, /🎯 Capture/)!.value).toContain(NO_USABLE_CHARM);
  });

  it('a charm that vanishes inside the step rolls everything back, says nothing was used, and sends nothing', async () => {
    const definition = await publish(wild(RARE));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { seed: HITS(), charms: { [CHARM]: 1 } });
    const chosen = await choose(prov, screen, CHARM);
    const before = await rowOf(runId);
    const real = w.app.inventory.consumeItem.bind(w.app.inventory);
    const spy = vi.spyOn(w.app.inventory, 'consumeItem').mockImplementationOnce(async (tx, player, itemId, quantity) => {
      await real(w.t.db, player, itemId, quantity);
      return real(tx, player, itemId, quantity);
    });
    const sent = announced.length;
    const events = harness.events.length;
    const c = interaction();
    await handleDungeonCapture(ctx, c.i, prov, partsOf(buttonOf(chosen, /Capture — Basic Charm/)).args);
    spy.mockRestore();
    expect(c.last().content).toMatch(/Nothing was used/);
    expect(await rowOf(runId)).toEqual(before);
    expect((await copiesOf(playerId)).filter((x) => x.acquiredVia === 'dungeon_capture')).toEqual([]);
    expect(announced.length).toBe(sent);
    expect(harness.events.length).toBe(events);
    expect(c.followUps).toEqual([]);
  });

  it('retryable contention says to try again without claiming a charm was spent', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    const chosen = await choose(prov, screen, CHARM);
    const contended: DungeonRunService = { ...w.runs, act: async () => { throw new DungeonStepContendedError(runId); } };
    const real = ctx.services.dungeonRuns;
    (ctx.services as { dungeonRuns: DungeonRunService }).dungeonRuns = contended;
    try {
      const painted = await press(prov, chosen, /Capture — Basic Charm/);
      expect(painted.content).toBe("You're doing a lot at once! Nothing was used. Please try that again.");
      expect(buttonOf(painted, /Capture — Basic Charm/).disabled).toBeFalsy();
    } finally {
      (ctx.services as { dungeonRuns: DungeonRunService | undefined }).dungeonRuns = real;
    }
    expect(await held(playerId, CHARM)).toBe(1);
  });

  it('a run that is over answers an encounter button with how it ended', async () => {
    const definition = await publish(wild(COMMON));
    const { screen, prov, playerId, runId } = await atEncounter(definition, { charms: { [CHARM]: 1 } });
    await w.runs.act(playerId, runId, { type: 'abandon' });
    const painted = await press(prov, screen, /Leave her/);
    expect(painted.content).toMatch(/earlier moment|run is over/);
    expect(embedOf(painted).title).toMatch(/Run Abandoned/);
  });
});

describe('Discord limits', () => {
  it('keeps a long-named, crowded charm menu inside Discord’s limits', async () => {
    const definition = await publish(wild(COMMON, {}, { label: 'L'.repeat(80), intro: 'I'.repeat(600) }), (d) => {
      (d.rooms as { description?: string }[])[0]!.description = 'R'.repeat(600);
    });
    const { screen } = await atEncounter(definition, { charms: { [CHARM]: 999, [SILK]: 999, [CONTRACT]: 999 } });
    const menu = menuOf(screen)!;
    expect(menu.options!.length).toBeLessThanOrEqual(25);
    for (const option of menu.options!) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect(option.description!.length).toBeLessThanOrEqual(100);
      expect(option.value.length).toBeLessThanOrEqual(100);
    }
    expect(dgId.charm(Number.MAX_SAFE_INTEGER, 9_999_999).length).toBeLessThanOrEqual(100);
    expect(dgId.encounterGone(Number.MAX_SAFE_INTEGER, 9_999_999).length).toBeLessThanOrEqual(100);
    expect(fieldOf(screen, /🎯 Capture/)!.value).toContain(CHARM_SPENT_PER_ATTEMPT);
  });

  it('never painted a screen outside Discord’s limits', () => {
    expect(everyScreen.length).toBeGreaterThan(30);
    for (const screen of everyScreen) {
      const rows = (screen.components ?? []).map((row) => row.toJSON().components);
      expect(rows.length).toBeLessThanOrEqual(5);
      for (const row of rows) {
        expect(row.length).toBeGreaterThan(0);
        const menus = row.filter((c) => c.type === SELECT);
        // A select menu fills its row on its own.
        if (menus.length) expect(row).toHaveLength(1);
        else expect(row.length).toBeLessThanOrEqual(5);
        for (const component of row) {
          expect(component.custom_id!.length).toBeLessThanOrEqual(100);
          if (component.label !== undefined) expect(component.label.length).toBeLessThanOrEqual(80);
        }
      }
      expect(new Set(rows.flat().map((c) => c.custom_id)).size).toBe(rows.flat().length);
      for (const embed of screen.embeds ?? []) {
        const e = embed.toJSON();
        const size = [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].reduce((sum, part) => sum + (part?.length ?? 0), 0);
        expect(size).toBeLessThanOrEqual(6000);
        expect((e.description ?? '').length).toBeLessThanOrEqual(4096);
        for (const field of e.fields ?? []) {
          expect(field.name.length).toBeLessThanOrEqual(256);
          expect(field.value.length).toBeLessThanOrEqual(1024);
        }
        expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
      }
    }
  });
});
