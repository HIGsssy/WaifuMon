/**
 * Dungeons on Discord: the main-menu entry, the home, the zone screen, Start
 * Run, the node and result screens, branch buttons, extraction, defeat,
 * completion, abandon, the configured currency name, artwork fallback, and
 * what a stale or double-clicked button paints — driven through the real
 * handlers and presenter against the real service and database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { players } from '../../src/db/schema';

vi.mock('../../src/discord/assets/attachRenderedCard', () => ({
  ownedArtworkImage: vi.fn(() => ({
    file: new AttachmentBuilder(Buffer.from('buddy'), { name: 'waifumon-buddy.webp' }),
    url: 'attachment://waifumon-buddy.webp',
  })),
}));

import {
  dungeonLegendLine,
  menuComponents,
} from '../../src/discord/commands/waifumon';
import {
  handleDungeonAbandon,
  handleDungeonAbandonConfirm,
  handleDungeonEnter,
  handleDungeonExtract,
  handleDungeonExtractConfirm,
  handleDungeonHome,
  handleDungeonResolve,
  handleDungeonRun,
  handleDungeonStart,
  handleDungeonZone,
} from '../../src/discord/commands/waifumonDungeon';
import {
  NO_ZONES,
  DAILY_LIMIT_NOTICE,
  DELVE_CLOSED_NOTICE,
  DUNGEON_TITLE,
  EQUIPMENT_NOTE,
  LOCKED_DUNGEONS,
  REPLAYED_NOTICE,
  RUN_ACTIVE_NOTICE,
  RUN_NOT_FOUND,
  RUN_OVER_NOTICE,
  STALE_NOTICE,
  ZONE_UNAVAILABLE,
  dgId,
} from '../../src/discord/dungeonPresenter';
import { parseCustomId, type AppContext, type Provisioned } from '../../src/discord/types';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonPlayService';
import type { EquipmentEntryState } from '../../src/modules/onboarding/onboardingState';
import { CURRENCY, atCompleted, createDungeonWorld, walk, type DungeonWorld } from '../helpers/dungeonPlayFixtures';
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

const MAIN = 'dc_main';
const DOOMED = 'dc_doomed';
const BARE = 'dc_bare';

let w: DungeonWorld;
let ctx: AppContext;
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-assets-'));

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.zone(MAIN, (z) => {
    z.name = 'Rust Warrens';
    z.description = 'Pipes, mostly.';
    z.artworkPath = 'dungeons/zones/dc_main.webp';
    z.backgroundArtworkPath = 'dungeons/backgrounds/dc_main.webp';
  });
  await w.zone(DOOMED, (z) => {
    z.name = 'Dead End';
    z.pools.boss = [{ id: 'brute', enemyKey: 'brute', weight: 10 }];
    // No zone artwork on disk: only the background is deployed.
    z.artworkPath = 'dungeons/zones/dc_doomed.webp';
    z.backgroundArtworkPath = 'dungeons/backgrounds/dc_doomed.webp';
  });
  await w.zone(BARE, (z) => {
    z.name = 'Bare Rock';
    z.pools.combat = [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }];
  });
  for (const file of ['combat/enemies/grunt.webp', 'dungeons/zones/dc_main.webp', 'dungeons/backgrounds/dc_doomed.webp']) {
    fs.mkdirSync(path.join(assetsDir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, file), 'webp');
  }
  ctx = {
    config: { assetsDir },
    logger: silentLogger(),
    content: w.content.current,
    services: { dungeonPlay: w.play, collection: w.app.collection },
  } as unknown as AppContext;
});
afterAll(async () => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
  await w?.cleanup();
});

function click() {
  const painted: Payload[] = [];
  const paint = vi.fn(async (body: unknown) => {
    painted.push(typeof body === 'string' ? { content: body } : (body as Payload));
  });
  const i = { replied: false, deferred: false, isButton: () => true, isStringSelectMenu: () => false, update: paint, reply: paint, editReply: paint, followUp: paint };
  return { i: i as never, last: () => painted[painted.length - 1]! };
}
const embedOf = (p: Payload) => p.embeds![0]!.toJSON();
const buttonsOf = (p: Payload) => (p.components ?? []).flatMap((row) => row.toJSON().components);
const labelsOf = (p: Payload) => buttonsOf(p).map((b) => b.label);
const fieldOf = (p: Payload, name: string | RegExp) =>
  embedOf(p).fields?.find((f) => (typeof name === 'string' ? f.name === name : name.test(f.name)));
const textOf = (p: Payload) => {
  const e = embedOf(p);
  return [p.content, e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
};
const argsOf = (id: string) => {
  const parsed = parseCustomId(id);
  if (!parsed || parsed === 'unknown_version') throw new Error(`not a wm id: ${id}`);
  return parsed.args;
};
/** Click the button with `label` on `screen` through `handler`. */
async function press(
  prov: Provisioned,
  screen: Payload,
  label: string | RegExp,
  handler: (ctx: AppContext, i: never, prov: Provisioned, args: string[]) => Promise<unknown>,
): Promise<Payload> {
  const button = buttonsOf(screen).find((b) => (typeof label === 'string' ? b.label === label : label.test(b.label ?? '')));
  if (!button) throw new Error(`no button ${String(label)} among ${labelsOf(screen).join(', ')}`);
  const c = click();
  await handler(ctx, c.i, prov, argsOf(button.custom_id!));
  return c.last();
}
async function paint(prov: Provisioned, run: Pick<DungeonRunView, 'id'>): Promise<Payload> {
  const c = click();
  await handleDungeonRun(ctx, c.i, prov, [String(run.id)]);
  return c.last();
}
async function begin(zoneKey = MAIN, seed?: number) {
  const { playerId } = await w.player();
  const prov = { playerId, guildDbId: 1 } as Provisioned;
  const run = await w.play.start(playerId, zoneKey, seed !== undefined ? { seed } : {});
  return { playerId, prov, run };
}

/* ───────────────────────── main menu ───────────────────────── */

describe('main-menu entry', () => {
  const care = { active: false, enabled: true, currentEnergy: 5 } as never;
  const menu = (entry: EquipmentEntryState, dungeons = true, careState = care) =>
    menuComponents(careState, true, entry, true, dungeons).map((row) => row.toJSON().components as ButtonJson[]);

  it('offers ⛏️ Delve once Equipment is unlocked', () => {
    const button = menu('available').flat().find((b) => b.custom_id === dgId.home());
    expect(button).toMatchObject({ label: 'Delve', emoji: { name: '⛏️' } });
    expect(dungeonLegendLine('available', true)).toContain('Delve');
  });

  it.each(['hidden', 'begin', 'resume'] as const)('is absent without the unlock (%s)', (entry) => {
    expect(menu(entry).flat().some((b) => b.custom_id?.includes('|dg|'))).toBe(false);
    expect(dungeonLegendLine(entry, true)).toBe('');
  });

  it('is absent when the service is not wired, and defaults off for older callers', () => {
    expect(menu('available', false).flat().some((b) => b.custom_id?.includes('|dg|'))).toBe(false);
    const older = menuComponents(care, true, 'available', true).flatMap((r) => r.toJSON().components as ButtonJson[]);
    expect(older.some((b) => b.custom_id?.includes('|dg|'))).toBe(false);
  });

  it('spills onto a fourth row rather than overfill the third', () => {
    const rows = menu('available', true, { active: true, enabled: true, currentEnergy: 5 } as never);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(5);
    expect(rows[3]!.map((b) => b.custom_id)).toEqual([dgId.home()]);
    // With room to spare it stays on the third.
    expect(menu('available')).toHaveLength(3);
  });
});

/* ───────────────────────── home and zone ───────────────────────── */

describe('the home', () => {
  it('lists the open zones with a button each, the depth range and the balance', async () => {
    const { playerId } = await w.player();
    const c = click();
    await handleDungeonHome(ctx, c.i, { playerId, guildDbId: 1 } as Provisioned);
    const screen = c.last();
    expect(embedOf(screen).title).toBe(DUNGEON_TITLE);
    const zone = fieldOf(screen, 'Rust Warrens')!;
    expect(zone.value).toContain('Pipes, mostly.');
    expect(zone.value).toMatch(/Depth: \*\*\d+–\d+\*\* nodes · ends in a boss/);
    expect(zone.value).toContain('you hold **0 Ascension Tokens**');
    expect(buttonsOf(screen).find((b) => b.label === 'Rust Warrens')!.custom_id).toBe(dgId.zone(MAIN));
    expect(labelsOf(screen)).toContain('Back to Waifumon');
  });

  it('shows the locked screen to a player without Equipment, on every route', async () => {
    const { playerId } = await w.player({ unlocked: false });
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    for (const go of [
      (c: ReturnType<typeof click>) => handleDungeonHome(ctx, c.i, prov),
      (c: ReturnType<typeof click>) => handleDungeonZone(ctx, c.i, prov, [MAIN]),
      (c: ReturnType<typeof click>) => handleDungeonStart(ctx, c.i, prov, [MAIN]),
      (c: ReturnType<typeof click>) => handleDungeonResolve(ctx, c.i, prov, ['1', 'n1']),
    ]) {
      const c = click();
      await go(c);
      expect(c.last().content).toBe(LOCKED_DUNGEONS);
    }
  });

  it('shows the active run with Resume and Abandon instead of the zones', async () => {
    const { prov, run } = await begin();
    const c = click();
    await handleDungeonHome(ctx, c.i, prov);
    const screen = c.last();
    expect(embedOf(screen).description).toContain('Rust Warrens');
    expect(fieldOf(screen, 'Where')!.value).toMatch(/^Depth 1 \/ \d+ — /);
    expect(fieldOf(screen, 'Nebula Nurse')!.value).toContain('HP **370 / 370**');
    expect(fieldOf(screen, 'Unbanked Ascension Tokens')!.value).toBe('0 Ascension Tokens');
    expect(fieldOf(screen, 'Secured')!.value).toBe('Nothing yet.');
    expect(labelsOf(screen)).toEqual(['Resume', 'Abandon', 'Back to Waifumon']);
    expect(buttonsOf(screen)[0]!.custom_id).toBe(dgId.run(run.id));

    const resumed = await press(prov, screen, 'Resume', handleDungeonRun);
    expect(embedOf(resumed).title).toMatch(/^Rust Warrens — Depth 1 \/ \d+$/);
  });
});

describe('the zone screen', () => {
  it('shows the Buddy, the rules of the run and Start Run', async () => {
    const { playerId } = await w.player();
    const c = click();
    await handleDungeonZone(ctx, c.i, { playerId, guildDbId: 1 } as Provisioned, [MAIN]);
    const screen = c.last();
    expect(embedOf(screen).title).toBe('Rust Warrens');
    expect(fieldOf(screen, 'Your Buddy — Nebula Nurse')!.value).toContain('ATK 83 · DEF 65 · HP 370');
    expect(fieldOf(screen, 'The run')!.value).toContain('If you fall, you keep 25%.');
    expect(fieldOf(screen, 'Locked in')!.value).toBe(EQUIPMENT_NOTE);
    expect(buttonsOf(screen)[0]).toMatchObject({ label: 'Start Run', custom_id: dgId.start(MAIN) });
    expect(buttonsOf(screen)[0]!.disabled).toBeFalsy();
    expect(embedOf(screen).image?.url).toBe('attachment://dungeon-dc-main.webp');
    expect(embedOf(screen).thumbnail?.url).toBe('attachment://waifumon-buddy.webp');
  });

  it('disables Start Run and points at the fix when the loadout is incomplete', async () => {
    const { playerId } = await w.player({ starters: false });
    const c = click();
    await handleDungeonZone(ctx, c.i, { playerId, guildDbId: 1 } as Provisioned, [MAIN]);
    const screen = c.last();
    expect(buttonsOf(screen)[0]).toMatchObject({ label: 'Start Run', disabled: true });
    expect(labelsOf(screen)).toContain('Equipment');
    expect(textOf(screen)).toContain('Can’t start yet');
    // A forged Start click is refused by the service and lands back here.
    const forged = click();
    await handleDungeonStart(ctx, forged.i, { playerId, guildDbId: 1 } as Provisioned, [MAIN]);
    expect(forged.last().content).toBe('Equip Attack, Defense and Health gear before fighting.');
    expect(await w.play.activeRun(playerId)).toBeNull();
  });

  it('answers an unknown zone with the home, and a malformed key with a refusal', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const c = click();
    await handleDungeonStart(ctx, c.i, prov, ['no_such_zone']);
    expect(c.last().content).toBe(ZONE_UNAVAILABLE);
    expect(embedOf(c.last()).title).toBe(DUNGEON_TITLE);
    const bad = click();
    await handleDungeonZone(ctx, bad.i, prov, ['Not A Key']);
    expect(bad.last().content).toContain('malformed');
  });
});

/* ───────────────────────── daily runs ───────────────────────── */

describe('daily runs', () => {
  const home = async (prov: Provisioned) => {
    const c = click();
    await handleDungeonHome(ctx, c.i, prov);
    return c.last();
  };
  const zoneScreen = async (prov: Provisioned, zoneKey = MAIN) => {
    const c = click();
    await handleDungeonZone(ctx, c.i, prov, [zoneKey]);
    return c.last();
  };
  const spend = async (playerId: number, runs: number) => {
    for (let i = 0; i < runs; i++) {
      const run = await w.play.start(playerId, MAIN);
      await w.play.abandon(playerId, run.id);
    }
  };
  const fresh = async () => {
    const { playerId } = await w.player();
    return { playerId, prov: { playerId, guildDbId: 1 } as Provisioned };
  };

  it('shows the allowance on the home and counts it down as runs are started', async () => {
    const { playerId, prov } = await fresh();
    expect(embedOf(await home(prov)).description).toMatch(/^Current location: \*\*Waifu Valley\*\*\nDaily Runs: \*\*3 \/ 3\*\* remaining\n/);
    await spend(playerId, 1);
    expect(embedOf(await home(prov)).description).toContain('Daily Runs: **2 / 3** remaining');
    expect(fieldOf(await zoneScreen(prov), 'Daily runs')!.value).toContain('Daily Runs: **2 / 3** remaining');
    expect(fieldOf(await zoneScreen(prov), 'Daily runs')!.value).toContain('Shared across every dungeon');
    // The other zone shows the same, shared allowance.
    expect(fieldOf(await zoneScreen(prov, DOOMED), 'Daily runs')!.value).toContain('Daily Runs: **2 / 3** remaining');
  });

  it('shows the configured limit, never a written 3', async () => {
    const { playerId, prov } = await fresh();
    await w.allowance.updateSettings({ dailyRunLimit: 7 });
    try {
      await spend(playerId, 2);
      const screen = await home(prov);
      expect(embedOf(screen).description).toContain('Daily Runs: **5 / 7** remaining');
      expect(textOf(screen)).not.toMatch(/\/ 3\b/);
    } finally {
      await w.allowance.updateSettings({ dailyRunLimit: 3 });
    }
  });

  it('with none left and no run: says so, disables Start Run, and refuses a forged Start', async () => {
    const { playerId, prov } = await fresh();
    await spend(playerId, 3);
    const screen = await home(prov);
    expect(embedOf(screen).description).toContain('Daily Runs: **0 / 3** remaining');
    const spent = fieldOf(screen, '⏳ No runs left today')!;
    expect(spent.value).toContain(DAILY_LIMIT_NOTICE);
    // When they come back, as a Discord timestamp of the next reset.
    expect(spent.value).toMatch(/<t:\d+:R>/);
    // The zones are still listed (to look at), but a zone cannot be started.
    const zone = await press(prov, screen, 'Rust Warrens', handleDungeonZone);
    expect(buttonsOf(zone)[0]).toMatchObject({ label: 'Start Run', disabled: true });
    expect(fieldOf(zone, '⏳ No runs left today')!.value).toContain(DAILY_LIMIT_NOTICE);
    expect(fieldOf(zone, 'Daily runs')).toBeUndefined();

    // A stale or forged Start click reaches the service, which refuses it.
    const forged = click();
    await handleDungeonStart(ctx, forged.i, prov, [MAIN]);
    expect(forged.last().content).toBe('You’ve used all of today’s Delve runs. They come back at the daily reset.');
    expect(embedOf(forged.last()).title).toBe(DUNGEON_TITLE);
    expect(embedOf(forged.last()).description).toContain('Daily Runs: **0 / 3** remaining');
    expect(await w.play.activeRun(playerId)).toBeNull();
    expect((await w.allowance.status(playerId)).used).toBe(3);
  });

  it('with none left and a run in progress: Resume and Abandon still work', async () => {
    const { playerId, prov } = await fresh();
    await spend(playerId, 2);
    const run = await w.play.start(playerId, MAIN);
    const screen = await home(prov);
    expect(embedOf(screen).description).toContain('Daily Runs: **0 / 3** remaining');
    expect(embedOf(screen).description).toContain('this one is still yours to finish');
    expect(labelsOf(screen)).toEqual(['Resume', 'Abandon', 'Back to Waifumon']);
    for (const b of buttonsOf(screen)) expect(b.disabled).toBeFalsy();
    const resumed = await press(prov, screen, 'Resume', handleDungeonRun);
    expect(embedOf(resumed).title).toMatch(/^Rust Warrens — Depth 1 \//);
    // The zone screen offers Resume, not a disabled Start.
    const zone = await zoneScreen(prov);
    expect(buttonsOf(zone)[0]).toMatchObject({ label: 'Resume Run', custom_id: dgId.run(run.id) });
    expect(buttonsOf(zone)[0]!.disabled).toBeFalsy();
    // The run plays on through the buttons.
    const c = click();
    await handleDungeonResolve(ctx, c.i, prov, [String(run.id), run.node.id]);
    expect((await w.play.run(playerId, run.id)).nodeStatus).toBe('completed');
    expect((await w.allowance.status(playerId)).used).toBe(3);
  });

  it('a double-clicked Start Run uses one daily run', async () => {
    const { playerId, prov } = await fresh();
    const zone = await zoneScreen(prov);
    const [a, b] = [click(), click()];
    await Promise.all([handleDungeonStart(ctx, a.i, prov, [MAIN]), handleDungeonStart(ctx, b.i, prov, [MAIN])]);
    // Both clicks land on the same run screen; one of them with the "already in a dungeon" notice.
    expect(embedOf(a.last()).title).toBe(embedOf(b.last()).title);
    expect([a.last().content, b.last().content].filter((t) => t === RUN_ACTIVE_NOTICE)).toHaveLength(1);
    expect(await w.allowance.status(playerId)).toMatchObject({ used: 1, remaining: 2 });
    expect(buttonsOf(zone)[0]!.label).toBe('Start Run');
  });

  it('says Delve is closed when the limit is 0', async () => {
    const { prov } = await fresh();
    await w.allowance.updateSettings({ dailyRunLimit: 0 });
    try {
      const screen = await home(prov);
      expect(embedOf(screen).description).toContain('Daily Runs: **0 / 0** remaining');
      expect(fieldOf(screen, '⏳ No runs left today')!.value).toBe(DELVE_CLOSED_NOTICE);
      const forged = click();
      await handleDungeonStart(ctx, forged.i, prov, [MAIN]);
      expect(forged.last().content).toBe(DELVE_CLOSED_NOTICE);
    } finally {
      await w.allowance.updateSettings({ dailyRunLimit: 3 });
    }
  });
});

/* ───────────────────────── a run ───────────────────────── */

describe('Start Run and the node screen', () => {
  it('starts the run and shows the first node with the snapshotted Buddy', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat');
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const run = await w.play.start(playerId, MAIN, { seed });
    const screen = await paint(prov, run);

    expect(embedOf(screen).title).toBe(`Rust Warrens — Depth 1 / ${run.depthCount}`);
    expect(embedOf(screen).description).toBe('⚔️ **Fight**\n**Grunt**\nATK 60 · DEF 0 · HP 150');
    expect(fieldOf(screen, 'Nebula Nurse')!.value).toBe('HP **370 / 370**\nATK 83 · DEF 65');
    expect(fieldOf(screen, 'Unbanked Ascension Tokens')!.value).toBe('0 Ascension Tokens');
    expect(labelsOf(screen)).toEqual(['Fight', 'Abandon', 'Back to Waifumon']);
    expect(buttonsOf(screen)[0]!.custom_id).toBe(dgId.resolve(run.id, run.node.id));
    // Enemy artwork wins over the zone's for a fight; the Buddy is the thumbnail.
    expect(embedOf(screen).image?.url).toBe('attachment://dungeon-grunt.webp');
    expect(embedOf(screen).thumbnail?.url).toBe('attachment://waifumon-buddy.webp');
    expect(screen.files).toHaveLength(2);
    // No Gear Score anywhere.
    expect(textOf(screen)).not.toMatch(/gear score/i);
  });

  it('Start Run from the zone screen paints the run, and a second click resumes it', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const zone = click();
    await handleDungeonZone(ctx, zone.i, prov, [MAIN]);
    const started = await press(prov, zone.last(), 'Start Run', handleDungeonStart);
    expect(embedOf(started).title).toMatch(/^Rust Warrens — Depth 1 \//);
    const active = (await w.play.activeRun(playerId))!;

    const again = await press(prov, zone.last(), 'Start Run', handleDungeonStart);
    expect(again.content).toBe(RUN_ACTIVE_NOTICE);
    expect(embedOf(again).title).toBe(embedOf(started).title);
    expect((await w.play.activeRun(playerId))!.id).toBe(active.id);
  });
});

describe('combat', () => {
  it('shows a compact result and the way on, and replays a double-click', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat' && g.nodes.filter((n) => n.depth === 2).length === 1);
    const { prov, run } = await begin(MAIN, seed);
    const node = await paint(prov, run);
    const result = await press(prov, node, 'Fight', handleDungeonResolve);

    expect(result.content).toBe('');
    expect(embedOf(result).description).toBe('⚔️ Fight — Grunt');
    const fight = fieldOf(result, '🏆 Victory — Grunt')!;
    expect(fight.value).toBe('Your HP: 370 → **334** / 370\nGrunt: 0 / 150\nRounds: 2');
    const summary = fieldOf(result, 'Combat summary')!.value.split('\n');
    expect(summary.length).toBeLessThanOrEqual(7);
    expect(summary.at(-1)).toBe('💥 Grunt is defeated.');
    expect(fieldOf(result, 'Rewards')!.value).toBe('+2 Ascension Tokens _(unbanked)_');
    expect(fieldOf(result, 'Unbanked Ascension Tokens')!.value).toBe('2 Ascension Tokens');
    expect(fieldOf(result, 'Nebula Nurse')!.value).toContain('HP **334 / 370**');
    const [onward] = buttonsOf(result);
    expect(onward!.label).toMatch(/^Continue — /);
    expect(onward!.custom_id).toBe(dgId.enter(run.id, (await w.play.run(prov.playerId, run.id)).next[0]!.id));

    const twice = await press(prov, node, 'Fight', handleDungeonResolve);
    expect(twice.content).toBe(REPLAYED_NOTICE);
    expect(fieldOf(twice, '🏆 Victory — Grunt')!.value).toBe(fight.value);
    expect((await w.play.run(prov.playerId, run.id)).unbankedCurrency).toBe(2);

    const next = await press(prov, result, /^Continue — /, handleDungeonEnter);
    expect(embedOf(next).title).toBe(`Rust Warrens — Depth 2 / ${run.depthCount}`);
    expect(next.content).toBe('');
  });

  it('offers a button per branch at a fork, and refuses the road not taken', async () => {
    const { playerId, prov, run } = await begin();
    const atFork = await walk(w.play, playerId, run, { stopAt: (v) => v.next.length > 1 });
    const screen = await paint(prov, run);
    const paths = buttonsOf(screen).filter((b) => b.custom_id?.includes('|enter|'));
    expect(paths.map((b) => b.custom_id)).toEqual(atFork.next.map((n) => dgId.enter(run.id, n.id)));
    for (const b of paths) expect(b.label).not.toMatch(/^Continue/);
    expect(fieldOf(screen, 'Path ahead')!.value.split('\n')).toHaveLength(2);

    const taken = await press(prov, screen, paths[0]!.label!, handleDungeonEnter);
    expect(embedOf(taken).title).toContain(`Depth ${atFork.depth + 1}`);
    const other = click();
    await handleDungeonEnter(ctx, other.i, prov, argsOf(paths[1]!.custom_id!));
    expect(other.last().content).toBe(STALE_NOTICE);
    expect((await w.play.run(playerId, run.id)).node.id).toBe(atFork.next[0]!.id);
  });
});

describe('rest, reward and extraction', () => {
  it('shows the rest result and offers Extract beside the way on', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat' && g.nodes[1]!.type === 'rest' && g.nodes[1]!.extraction);
    const { playerId, prov, run } = await begin(MAIN, seed);
    const first = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    await w.play.enterNode(playerId, run.id, first.next[0]!.id);
    const node = await paint(prov, run);
    expect(embedOf(node).description).toBe('🔥 **Rest**\nA quiet corner. Resting restores **30%** of max HP.');
    expect(fieldOf(node, '🚪 Extraction point')!.value).toBe('You can leave from here once this node is done.');
    expect(labelsOf(node)).not.toContain('Extract');

    const rested = await press(prov, node, 'Rest', handleDungeonResolve);
    expect(fieldOf(rested, '🔥 Rested')!.value).toBe('HP 334 → **370** / 370 (+36)');
    expect(fieldOf(rested, '🚪 Extraction point')!.value).toBe('You can leave here and bank all 2 Ascension Tokens.');
    expect(labelsOf(rested)).toContain('Extract');

    const confirm = await press(prov, rested, 'Extract', handleDungeonExtractConfirm);
    expect(embedOf(confirm).title).toBe('🚪 Extract from Rust Warrens?');
    expect(embedOf(confirm).description).toContain('bank all **2 Ascension Tokens**');
    expect(labelsOf(confirm)).toEqual(['Extract', 'Keep Going']);
    // Asking changes nothing.
    expect((await w.play.run(playerId, run.id)).status).toBe('active');
    expect(embedOf(await press(prov, confirm, 'Keep Going', handleDungeonRun)).title).toMatch(/^Rust Warrens — Depth 2/);

    const out = await press(prov, confirm, 'Extract', handleDungeonExtract);
    expect(embedOf(out).title).toBe('🚪 Extracted — Rust Warrens');
    const result = fieldOf(out, 'Result')!.value;
    expect(result).toContain(`Depth reached: **2 / ${run.depthCount}**`);
    expect(result).toContain('Banked: **2 Ascension Tokens** — all of it');
    expect(result).toContain('You now hold 2 Ascension Tokens.');
    expect(labelsOf(out)).toEqual(['Delve Again', 'Back to Waifumon']);

    const twice = await press(prov, confirm, 'Extract', handleDungeonExtract);
    expect(twice.content).toBe(REPLAYED_NOTICE);
    expect(await w.balance(playerId)).toBe(2);
    // A leftover Continue from before is told the run is over.
    const stale = await press(prov, rested, /^(Continue — |Fight|Event|Cache)/, handleDungeonEnter);
    expect(stale.content).toBe(RUN_OVER_NOTICE);
  });

  it('shows what a cache paid, with the gear marked secured', async () => {
    // The cache must be somewhere to walk *to*, so not the very first node.
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type !== 'reward');
    const { playerId, prov, run } = await begin(MAIN, seed);
    const before = await walk(w.play, playerId, run, { stopAt: (v) => v.next.some((n) => n.type === 'reward') });
    await w.play.enterNode(playerId, run.id, before.next.find((n) => n.type === 'reward')!.id);
    const node = await paint(prov, run);
    expect(embedOf(node).description).toBe('🎁 **Cache**\nA sealed cache.');

    const opened = await press(prov, node, 'Open', handleDungeonResolve);
    const lines = fieldOf(opened, 'Rewards')!.value.split('\n');
    expect(lines[0]).toBe('+5 Ascension Tokens _(unbanked)_');
    expect(lines[1]).toMatch(/^.+ \*\*.+\*\* \(N\) — secured$/);
    expect(lines.slice(2)).toEqual(['+11 WaifuBux', '+2 Sticky Joystick']);
    const secured = fieldOf(opened, 'Secured')!.value;
    expect(secured).toContain('11 WaifuBux');
    expect(secured).toContain('2 Sticky Joystick');
  });

  it('refuses the extraction prompt where there is nothing to extract from', async () => {
    const { prov, run } = await begin();
    const c = click();
    await handleDungeonExtractConfirm(ctx, c.i, prov, [String(run.id), run.node.id]);
    expect(c.last().content).toBe('You can’t extract from here.');
    expect(embedOf(c.last()).title).toMatch(/^Rust Warrens — Depth 1/);
  });
});

describe('the end of a run', () => {
  it('shows a completion with the bonus and everything banked', async () => {
    const { playerId, prov, run } = await begin();
    const atBoss = await walk(w.play, playerId, run, { stopAt: (v) => v.next.some((n) => n.boss) });
    await w.play.enterNode(playerId, run.id, atBoss.next[0]!.id);
    const node = await paint(prov, run);
    expect(embedOf(node).description).toBe('👑 **Boss**\n**Overlord**\nATK 60 · DEF 0 · HP 300');

    const done = await press(prov, node, 'Fight', handleDungeonResolve);
    const earned = atBoss.unbankedCurrency + 10;
    expect(embedOf(done).title).toBe('👑 Dungeon Complete — Rust Warrens');
    expect(fieldOf(done, '🏆 Victory — Overlord')).toBeDefined();
    const result = fieldOf(done, 'Result')!.value;
    expect(result).toContain(`Depth reached: **${run.depthCount} / ${run.depthCount}**`);
    expect(result).toContain(`Earned: ${earned} Ascension Tokens`);
    expect(result).toContain('Completion bonus: +7 Ascension Tokens');
    expect(result).toContain(`Banked: **${earned + 7} Ascension Tokens** — all of it`);
    expect(fieldOf(done, 'Secured — yours to keep')).toBeDefined();
    // Nothing to click Extract on: the run is simply over.
    expect(labelsOf(done)).toEqual(['Delve Again', 'Back to Waifumon']);
  });

  it('shows a defeat with what was kept, what was lost and what stays secured', async () => {
    const { playerId, prov, run } = await begin(DOOMED);
    const atBoss = await walk(w.play, playerId, run, { stopAt: (v) => v.next.some((n) => n.boss) });
    await w.play.enterNode(playerId, run.id, atBoss.next[0]!.id);
    const lost = await press(prov, await paint(prov, run), 'Fight', handleDungeonResolve);

    const earned = atBoss.unbankedCurrency;
    const kept = Math.trunc(earned / 4);
    expect(embedOf(lost).title).toBe('💀 Defeated — Dead End');
    expect(fieldOf(lost, '💀 Defeat — Brute')!.value).toContain('→ **0** / 370');
    const result = fieldOf(lost, 'Result')!.value;
    expect(result).toContain(`Depth reached: **${run.depthCount} / ${run.depthCount}**`);
    expect(result).toContain(`Earned: ${earned} Ascension Tokens`);
    expect(result).toContain(`Kept (25%): **${kept} Ascension Token${kept === 1 ? '' : 's'}** · Lost: ${earned - kept} Ascension Token`);
    expect(fieldOf(lost, 'Secured — yours to keep')!.value).toMatch(/\(N\)/);
    expect(labelsOf(lost)).toEqual(['Delve Again', 'Back to Waifumon']);
    // The zone's own artwork is not deployed, so the background stands in.
    expect(embedOf(lost).image?.url).toBe('attachment://dungeon-dc-doomed.webp');
  });

  it('asks before abandoning, then settles like a defeat', async () => {
    const { playerId, prov, run } = await begin();
    const mid = await walk(w.play, playerId, run, { stopAt: atCompleted('reward') });
    const screen = await paint(prov, run);
    const confirm = await press(prov, screen, 'Abandon', handleDungeonAbandonConfirm);
    expect(embedOf(confirm).title).toBe('🏳️ Abandon Rust Warrens?');
    expect(embedOf(confirm).description).toContain(`you keep 25% of your **${mid.unbankedCurrency} Ascension Tokens**`);
    expect(labelsOf(confirm)).toEqual(['Abandon Run', 'Back to Run']);
    expect((await w.play.run(playerId, run.id)).status).toBe('active');

    const gone = await press(prov, confirm, 'Abandon Run', handleDungeonAbandon);
    expect(embedOf(gone).title).toBe('🏳️ Run Abandoned — Rust Warrens');
    expect(fieldOf(gone, 'Result')!.value).toContain('Kept (25%)');
    expect(await w.balance(playerId)).toBe(Math.trunc(mid.unbankedCurrency / 4));

    const twice = await press(prov, confirm, 'Abandon Run', handleDungeonAbandon);
    expect(twice.content).toBe(REPLAYED_NOTICE);
    // The old run screen's buttons now answer with the ending.
    const stale = await press(prov, screen, /^(Continue — |Fight|Event|Rest|Boss)/, handleDungeonEnter);
    expect(stale.content).toBe(RUN_OVER_NOTICE);
    // And the home is back to the zones.
    const home = click();
    await handleDungeonHome(ctx, home.i, prov);
    expect(labelsOf(home.last())).toContain('Rust Warrens');
  });
});

/* ───────────────────────── display rules ───────────────────────── */

describe('the progression currency', () => {
  it('is always shown under its configured name and icon', async () => {
    const { playerId, prov, run } = await begin();
    await w.play.resolveNode(playerId, run.id, run.node.id);
    const meta = (await w.currencies.get(CURRENCY))!;
    const renamed = (await w.currencies.updateMetadata(
      CURRENCY,
      { metadata: { singularName: 'Gleam', pluralName: 'Gleams', description: '', icon: '💠', enabled: true }, expectedRevision: meta.revision },
      'admin',
    ))!;
    try {
      const screens: Payload[] = [await paint(prov, run)];
      const home = click();
      await handleDungeonHome(ctx, home.i, prov);
      screens.push(home.last());
      const confirm = click();
      await handleDungeonAbandonConfirm(ctx, confirm.i, prov, [String(run.id)]);
      screens.push(confirm.last());
      const gone = click();
      await handleDungeonAbandon(ctx, gone.i, prov, [String(run.id)]);
      screens.push(gone.last());
      const fresh = await w.player();
      const zone = click();
      await handleDungeonZone(ctx, zone.i, { playerId: fresh.playerId, guildDbId: 1 } as Provisioned, [MAIN]);
      screens.push(zone.last());

      for (const screen of screens) {
        expect(textOf(screen)).toMatch(/💠 (\d+ )?Gleams?/);
        expect(textOf(screen)).not.toMatch(/Ascension/i);
      }
      expect(fieldOf(screens[0]!, 'Unbanked 💠 Gleams')).toBeDefined();
      expect(await w.balance(playerId)).toBeGreaterThanOrEqual(0);
    } finally {
      await w.currencies.updateMetadata(
        CURRENCY,
        { metadata: { singularName: meta.singularName, pluralName: meta.pluralName, description: meta.description, icon: meta.icon, enabled: true }, expectedRevision: renamed.revision },
        'admin',
      );
    }
  });
});

describe('artwork', () => {
  it('falls back from event art to the zone, and to nothing when no file is deployed', async () => {
    // An event with no artwork of its own shows the zone's.
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'event');
    const onEvent = await begin(MAIN, seed);
    expect(embedOf(await paint(onEvent.prov, onEvent.run)).image?.url).toBe('attachment://dungeon-dc-main.webp');

    // A zone with no artwork, fighting an enemy with none: text only, Buddy thumbnail intact.
    const bareSeed = await w.seedFor(BARE, (g) => g.nodes[0]!.type === 'combat');
    const bare = await begin(BARE, bareSeed);
    const screen = await paint(bare.prov, bare.run);
    expect(embedOf(screen).image).toBeUndefined();
    expect(embedOf(screen).thumbnail?.url).toBe('attachment://waifumon-buddy.webp');
    expect(screen.files).toHaveLength(1);
  });
});

describe('artwork precedence', () => {
  /** The large image of a screen, as the attachment name. */
  const imageOf = (p: Payload) => embedOf(p).image?.url;
  const ART = 'dc_art';
  const BACKGROUND_ONLY = DOOMED;
  beforeAll(async () => {
    // A zone with both images deployed, and an event that has artwork of its own.
    await w.zone(ART, (z) => {
      z.name = 'Gallery';
      z.artworkPath = 'dungeons/zones/dc_art.webp';
      z.backgroundArtworkPath = 'dungeons/backgrounds/dc_art.webp';
      z.pools.event = [{ id: 'shrine', eventKey: 'shrine', weight: 10 }];
    });
    for (const file of ['dungeons/zones/dc_art.webp', 'dungeons/backgrounds/dc_art.webp', 'dungeons/events/shrine.webp']) {
      fs.mkdirSync(path.join(assetsDir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(assetsDir, file), 'webp');
    }
  });
  const onFirst = async (zoneKey: string, type: string) => {
    const seed = await w.seedFor(zoneKey, (g) => g.nodes[0]!.type === type);
    const started = await begin(zoneKey, seed);
    return paint(started.prov, started.run);
  };

  it('combat: the enemy’s artwork, then the zone’s, then the background, then text', async () => {
    // Grunt has artwork deployed: it wins over the zone's.
    expect(imageOf(await onFirst(ART, 'combat'))).toBe('attachment://dungeon-grunt.webp');
    // Sentinel has none: the zone artwork.
    await w.zone('dc_art_sentinel', (z) => {
      z.artworkPath = 'dungeons/zones/dc_art.webp';
      z.backgroundArtworkPath = 'dungeons/backgrounds/dc_art.webp';
      z.pools.combat = [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }];
    });
    expect(imageOf(await onFirst('dc_art_sentinel', 'combat'))).toBe('attachment://dungeon-dc-art.webp');
    // Zone artwork not deployed: the background. (DOOMED ships only its background file.)
    await w.zone('dc_bg_sentinel', (z) => {
      z.artworkPath = 'dungeons/zones/not_deployed.webp';
      z.backgroundArtworkPath = 'dungeons/backgrounds/dc_doomed.webp';
      z.pools.combat = [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }];
    });
    expect(imageOf(await onFirst('dc_bg_sentinel', 'combat'))).toBe('attachment://dungeon-dc-doomed.webp');
    // Nothing deployed at all: text only.
    expect(imageOf(await onFirst(BARE, 'combat'))).toBeUndefined();
  });

  it('event: the event’s own artwork first, then the zone’s — never an enemy’s', async () => {
    const original = w.content.current;
    try {
      // With artwork of its own, the event shows it.
      w.content.current = {
        ...original,
        dungeonEvents: original.dungeonEvents!.map((e) => (e.key === 'shrine' ? { ...e, artworkPath: 'dungeons/events/shrine.webp' } : e)),
      };
      expect(imageOf(await onFirst(ART, 'event'))).toBe('attachment://dungeon-shrine.webp');
    } finally {
      w.content.current = original;
    }
    // Without, the zone artwork.
    expect(imageOf(await onFirst(ART, 'event'))).toBe('attachment://dungeon-dc-art.webp');
  });

  it('rest and reward: the zone’s artwork, then the background', async () => {
    for (const type of ['rest', 'reward']) {
      const typed = await w.seedFor(ART, (g) => g.nodes[1]?.type === type && g.nodes.filter((n) => n.depth === 2).length === 1);
      const next = await begin(ART, typed);
      const first = await w.play.resolveNode(next.playerId, next.run.id, next.run.node.id);
      const entered = await w.play.enterNode(next.playerId, next.run.id, first.run.next[0]!.id);
      expect(entered.run.node.type).toBe(type);
      expect(imageOf(await paint(next.prov, entered.run)), type).toBe('attachment://dungeon-dc-art.webp');
    }
  });

  it('the Delve home and the zone screen: zone artwork, then background, then text', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const zone = async (key: string) => {
      const c = click();
      await handleDungeonZone(ctx, c.i, prov, [key]);
      return c.last();
    };
    expect(imageOf(await zone(ART))).toBe('attachment://dungeon-dc-art.webp');
    expect(imageOf(await zone(BACKGROUND_ONLY))).toBe('attachment://dungeon-dc-doomed.webp');
    expect(imageOf(await zone(BARE))).toBeUndefined();
    // The home shows the first listed zone that has artwork deployed, and attaches it.
    const home = click();
    await handleDungeonHome(ctx, home.i, prov);
    expect(imageOf(home.last())).toMatch(/^attachment:\/\/dungeon-dc-(main|art|doomed)\.webp$/);
    expect(home.last().files).toHaveLength(1);
  });

  it('an active run shows the artwork its zone had when it started, not a later edit', async () => {
    const key = 'dc_art_snapshot';
    await w.zone(key, (z) => {
      z.artworkPath = 'dungeons/zones/dc_art.webp';
      z.pools.combat = [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }];
    });
    const seed = await w.seedFor(key, (g) => g.nodes[0]!.type === 'combat');
    const started = await begin(key, seed);
    const current = (await w.zones.get(key))!;
    await w.zones.update(key, { zone: { ...current.zone, artworkPath: 'dungeons/zones/dc_main.webp' }, expectedRevision: current.revision }, 'admin');
    // The run: its snapshot. A new look at the zone: the edit.
    expect(imageOf(await paint(started.prov, started.run))).toBe('attachment://dungeon-dc-art.webp');
    const fresh = await w.player();
    const c = click();
    await handleDungeonZone(ctx, c.i, { playerId: fresh.playerId, guildDbId: 1 } as Provisioned, [key]);
    expect(imageOf(c.last())).toBe('attachment://dungeon-dc-main.webp');
  });
});

describe('regions', () => {
  const HILLS = 'dc_hills';
  beforeAll(async () => {
    await w.zone(HILLS, (z) => {
      z.name = 'Hill Works';
      z.availableRegions = ['flaccid-foothills'];
    });
  });
  const moveTo = (playerId: number, region: string) =>
    w.t.db.update(players).set({ currentRegion: region }).where(eq(players.id, playerId));
  const home = async (prov: Provisioned) => {
    const c = click();
    await handleDungeonHome(ctx, c.i, prov);
    return c.last();
  };

  it('names the current location and lists only the Delves open there', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    const valley = await home(prov);
    expect(embedOf(valley).description).toContain('Current location: **Waifu Valley**');
    expect(fieldOf(valley, 'Available Delves')!.value).toBe('Open in Waifu Valley:');
    // Valley zones are listed (the screen shows the first five); the Foothills one is not among them.
    expect(labelsOf(valley).length).toBeGreaterThan(1);
    expect(labelsOf(valley)).not.toContain('Hill Works');
    expect(fieldOf(valley, 'Hill Works')).toBeUndefined();

    await moveTo(playerId, 'flaccid-foothills');
    const hills = await home(prov);
    expect(embedOf(hills).description).toContain('Current location: **Flaccid Foothills**');
    expect(labelsOf(hills)).toEqual(['Hill Works', 'Back to Waifumon']);
    expect(fieldOf(hills, 'Rust Warrens')).toBeUndefined();
  });

  it('says so when no Delve is available in the region, with no zone buttons and no disabled clutter', async () => {
    const { playerId } = await w.player();
    await moveTo(playerId, 'twin-peeks');
    const screen = await home({ playerId, guildDbId: 1 } as Provisioned);
    expect(embedOf(screen).description).toContain('Current location: **Twin Peeks**');
    expect(embedOf(screen).description).toContain(NO_ZONES);
    expect(NO_ZONES).toBe('There are no Delves available in this region.');
    expect(labelsOf(screen)).toEqual(['Back to Waifumon']);
    expect(fieldOf(screen, 'Available Delves')).toBeUndefined();
  });

  it('refuses a stale or forged Start and zone button from the wrong region, and lands on the home', async () => {
    const { playerId } = await w.player();
    const prov = { playerId, guildDbId: 1 } as Provisioned;
    for (const handler of [handleDungeonStart, handleDungeonZone]) {
      const c = click();
      await handler(ctx, c.i, prov, [HILLS]);
      expect(c.last().content).toBe('That Delve isn’t available in Waifu Valley.');
      expect(embedOf(c.last()).title).toBe(DUNGEON_TITLE);
    }
    expect(await w.play.activeRun(playerId)).toBeNull();
    expect((await w.allowance.status(playerId)).used).toBe(0);
  });

  it('keeps Resume working after the player travels away from where the run started', async () => {
    const { playerId, prov, run } = await begin(MAIN);
    await moveTo(playerId, 'twin-peeks');
    const screen = await home(prov);
    expect(labelsOf(screen)).toEqual(['Resume', 'Abandon', 'Back to Waifumon']);
    const resumed = await press(prov, screen, 'Resume', handleDungeonRun);
    expect(embedOf(resumed).title).toMatch(/^Rust Warrens — Depth 1 \//);
    const c = click();
    await handleDungeonResolve(ctx, c.i, prov, [String(run.id), run.node.id]);
    expect((await w.play.run(playerId, run.id)).nodeStatus).toBe('completed');
  });
});

describe('bad buttons', () => {
  it('answers a forged or foreign run id without touching anything', async () => {
    const mine = await begin();
    const other = await begin();
    const c = click();
    await handleDungeonResolve(ctx, c.i, mine.prov, [String(other.run.id), other.run.node.id]);
    expect(c.last().content).toBe(RUN_NOT_FOUND);
    expect((await w.play.run(other.playerId, other.run.id)).nodeStatus).toBe('entered');

    for (const args of [['abc', 'n1'], ['1'], ['1', 'x1'], []]) {
      const bad = click();
      await handleDungeonResolve(ctx, bad.i, mine.prov, args);
      expect(bad.last().content).toContain('malformed');
    }
  });
});
