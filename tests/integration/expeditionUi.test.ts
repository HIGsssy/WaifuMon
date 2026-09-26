/**
 * Expeditions Phase 4 — the Discord screens.
 *
 * Drives the real handlers against a real database and asserts on what was
 * painted. The point is the *flow*: board → detail → confirm → deploy →
 * active → collect, plus the two destructive paths (recall) and the stale
 * presses that arrive out of order.
 *
 * One assertion runs across nearly every screen and is the reason several of
 * these tests exist at all: **no numeric chance may appear anywhere**. The
 * match quality is the whole contract with the player, and a percentage leaking into
 * one embed would quietly undo that everywhere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MessageFlags } from 'discord.js';
import {
  items,
  playerExpeditions,
  species as speciesTable,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionsConfigSchema,
  type ExpeditionRewardTable,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';
import {
  handleExpeditionActive,
  handleExpeditionBoard,
  handleExpeditionCancel,
  handleExpeditionCancelConfirm,
  handleExpeditionClaim,
  handleExpeditionDeploy,
  handleExpeditionMission,
  handleExpeditionPick,
  handleExpeditionView,
  handleExpeditions,
} from '../../src/discord/commands/waifumonExpeditions';
import { renderInspect } from '../../src/discord/commands/waifumonCollection';
import { handleMenu } from '../../src/discord/commands/waifumon';
import {
  bootstrapApp,
  createEventHarness,
  forceRegion,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { createGameEventBus } from '../../src/modules/events/gameEvents';
import { createActivityFeedService } from '../../src/modules/activity/activityFeedService';
import type { AppContext, Provisioned } from '../../src/discord/types';

let t: TestDb;
let app: App;
let harness: EventHarness;
let ctx: AppContext;
let demonSpecies: SpeciesRow;

// ───────────────────────────── harness ─────────────────────────────

function fakeChannel() {
  return { id: 'c-exp', isTextBased: () => true, send: vi.fn(async () => ({ id: 'm-1' })) };
}

function fakeButton(channel = fakeChannel()) {
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    channel,
    channelId: channel.id,
    user: { id: 'u-exp', displayName: 'Hunter' },
    guildId: 'g-exp-ui',
    message: { id: 'm-ephemeral' },
  };
}

/** A select-menu interaction carrying one chosen value. */
function fakeSelect(value: string) {
  return { ...fakeButton(), isButton: () => false, isStringSelectMenu: () => true, values: [value] };
}

/** The payload a handler painted, whichever method it used to paint it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function painted(interaction: any): any {
  const call =
    interaction.update.mock.calls[0] ??
    interaction.reply.mock.calls[0] ??
    interaction.editReply.mock.calls[0];
  if (!call) throw new Error('nothing was painted');
  return call[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function embedOf(payload: any) {
  const embed = payload?.embeds?.[0];
  return typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
}

/** Every piece of text a screen shows — title, description and every field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function screenText(payload: any): string {
  const json = embedOf(payload);
  const fields = (json?.fields ?? []).map(
    (f: { name: string; value: string }) => `${f.name}\n${f.value}`,
  );
  return [json?.title ?? '', json?.description ?? '', ...fields].join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function components(payload: any): { customId: string; label: string; disabled: boolean }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = payload?.components ?? [];
  return rows.flatMap((row) => {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (json.components ?? []).map((c: any) => ({
      customId: c.custom_id ?? '',
      label: c.label ?? '',
      disabled: c.disabled ?? false,
    }));
  });
}

/** Select-menu option values from a painted screen. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectOptions(payload: any): { label: string; description: string; value: string }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = payload?.components ?? [];
  return rows.flatMap((row) => {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (json.components ?? []).flatMap((c: any) => c.options ?? []);
  });
}

/**
 * Anything that reads as a success percentage.
 *
 * Deliberately broad — `40%`, `0.4`, `chance` — because the failure being
 * guarded against is a careless interpolation, and a narrow pattern would miss
 * exactly the careless case. Discord timestamps (`<t:1234:R>`) and plain
 * integers like level and currency are not decimals, so they do not trip it.
 */
function assertNoNumericOdds(text: string) {
  expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
  expect(text).not.toMatch(/0\.\d+/);
  expect(text.toLowerCase()).not.toContain('success chance');
  expect(text.toLowerCase()).not.toContain('exceptional chance');
}

// ───────────────────────────── content ─────────────────────────────

function definition(over: Record<string, unknown> = {}): RegionalExpedition {
  const { region = 'waifu-valley', ...rest } = over;
  return {
    ...ExpeditionDefinitionSchema.parse({
      key: 'supply_run',
      name: 'Desert Supply Run',
      description: 'The caravan needs a second pair of hands.',
      emoji: '🏜️',
      type: 'supply_run',
      durationMinutes: 360,
      recommendedLevel: 10,
      preferredAffinities: ['dominant'],
      preferredRaces: ['demon'],
      baseSuccessChance: 0.5,
      rewardTable: 'supply_success',
      exceptionalRewardTable: 'supply_bonus',
      failureRewardTable: 'supply_failure',
      rewardPreview: ['waifubux', 'salvage', 'rare_find'],
      ...rest,
    }),
    region: region as RegionalExpedition['region'],
  };
}

/**
 * One mission on every configured tier, with `over` applied to the 6h one.
 *
 * The board draws one mission per duration tier, so a region that appears on a
 * board at all has to cover the whole ladder — a single-mission region is a
 * content error now, not a minimal fixture. `supply_run` stays the 6h mission,
 * so every screen these tests drive still opens on the same mission.
 */
function completePool(over: Record<string, unknown> = {}): RegionalExpedition[] {
  // `region` is a property of the pool, not of one mission: moving the region
  // under test has to move the whole ladder, or the region left behind is the
  // incomplete one.
  const region = over.region;
  const sibling = (o: Record<string, unknown>) =>
    definition(region === undefined ? o : { ...o, region });
  return [
    sibling({ key: 'night_market', name: 'Night Market Errand', emoji: '🏮', durationMinutes: 60 }),
    sibling({ key: 'well_watch', name: 'Well Watch', emoji: '🪣', durationMinutes: 180 }),
    definition(over),
    sibling({ key: 'dune_vigil', name: 'Dune Vigil', emoji: '🌙', durationMinutes: 1080 }),
  ];
}

const TABLES: ExpeditionRewardTable[] = [
  ExpeditionRewardTableSchema.parse({
    id: 'supply_success',
    waifubux: { min: 200, max: 200 },
    waifuXp: 80,
    groups: [
      { id: 'salvage', entries: [{ itemId: 'ui_scrap', weight: 1, quantity: 2 }] },
    ],
  }),
  ExpeditionRewardTableSchema.parse({
    id: 'supply_bonus',
    waifubux: { min: 500, max: 500 },
    waifuXp: 40,
    groups: [{ id: 'rare', entries: [{ itemId: 'ui_relic', weight: 1, quantity: 1 }] }],
  }),
  ExpeditionRewardTableSchema.parse({
    id: 'supply_failure',
    waifubux: { min: 25, max: 25 },
    waifuXp: 5,
    groups: [{ id: 'scraps', entries: [{ itemId: 'ui_scrap', weight: 1, quantity: 1 }] }],
  }),
];

function installContent(
  expeditions: RegionalExpedition[] = completePool(),
  config: Record<string, unknown> = {},
) {
  app.content.expeditions = expeditions;
  app.content.expeditionRewards = TABLES;
  app.content.tables.expeditions = ExpeditionsConfigSchema.parse(config);
}

let seq = 0;
async function player(level = 12) {
  seq += 1;
  const prov = await provisionPlayer(app, 'g-exp-ui', `u-ui-${seq}`);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId: prov.playerId,
    speciesId: demonSpecies.id,
    level,
    nickname: `Lilith${seq}`,
  });
  return { prov: prov as Provisioned, waifuId: waifu.id };
}

async function timeTravel(id: number) {
  await t.db
    .update(playerExpeditions)
    .set({ completesAt: sql`now() - interval '1 minute'` })
    .where(eq(playerExpeditions.id, id));
}

async function forceOutcome(id: number, kind: 'success' | 'failure' | 'exceptional') {
  await t.db
    .update(playerExpeditions)
    .set({
      successChance: kind === 'failure' ? 0 : 1,
      exceptionalChance: kind === 'exceptional' ? 1 : 0,
    })
    .where(eq(playerExpeditions.id, id));
}

/** Deploy through the service, which is what the UI tests build on. */
async function deployed(level = 12) {
  const { prov, waifuId } = await player(level);
  const view = await app.expeditions.deploy(prov.playerId, 'supply_run', waifuId);
  return { prov, waifuId, view };
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  for (const slug of ['ui_scrap', 'ui_relic']) {
    await t.db
      .insert(items)
      .values({
        slug,
        name: slug === 'ui_scrap' ? 'Sunbleached Scrap' : 'Cracked Relic',
        category: 'salvage',
        sellValue: 25,
      })
      .onConflictDoNothing();
  }
  // Pinned by slug rather than "the first dominant species", so the chips the
  // detail screen renders are predictable: Royal Succubus is `dominant` and
  // resolves to race `demon`, which is exactly what the fixture mission
  // prefers — so a well-matched candidate shows two ticks.
  const [demon] = await t.db
    .select()
    .from(speciesTable)
    .where(eq(speciesTable.slug, 'royal_succubus'));
  if (!demon) throw new Error('fixture species royal_succubus is missing from content');
  demonSpecies = demon;

  ctx = {
    config: {
      assetsDir: process.cwd(),
      contentDir: process.cwd(),
      dailyTimezone: 'UTC',
      discordToken: 'x',
      discordClientId: 'x',
      discordGuildId: undefined,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
      adminWeb: { enabled: false, host: '127.0.0.1', port: 3111, token: '' },
      platformApi: { enabled: false, host: '127.0.0.1', port: 3120, token: '' },
    },
    logger: t.logger,
    db: t.db,
    content: app.content,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    services: {
      guilds: app.guilds,
      travel: app.travel,
      players: app.players,
      achievements: app.achievements,
      leaderboards: app.leaderboards,
      currency: app.currency,
      inventory: app.inventory,
      daily: app.daily,
      shop: app.shop,
      hunt: app.hunt,
      capture: app.capture,
      care: app.care,
      collection: app.collection,
      expeditions: app.expeditions,
      availability: app.availability,
      appearance: app.appearance,
      progression: app.progression,
      quests: app.quests,
      session: app.session,
      effects: app.effects,
      itemUse: app.itemUse,
      gifts: app.gifts,
    },
  } as unknown as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(() => {
  installContent();
});

// ───────────────────────────── tests ─────────────────────────────

describe('the main menu', () => {
  it('offers an Expeditions button', async () => {
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, btn as any, prov);
    const ids = components(painted(btn)).map((c) => c.customId);
    expect(ids).toContain('wm|v1|menu|expeditions');
  });
});

describe('board rendering', () => {
  it('lists the region\u2019s missions with duration, level, preferences and rewards', async () => {
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    const text = screenText(payload);

    expect(embedOf(payload).title).toContain('Expeditions');
    expect(text).toContain('Desert Supply Run');
    expect(text).toContain('6h');
    expect(text).toContain('Recommended Lv **10**');
    expect(text).toContain('Dominant');
    expect(text).toContain('Demon');
    // Broad preview categories, never the actual table contents.
    expect(text).toContain('WaifuBux');
    expect(text).toContain('Salvage');
    expect(text).not.toContain('Sunbleached Scrap');
    assertNoNumericOdds(text);

    expect(components(payload).map((c) => c.customId)).toContain(
      'wm|v1|exp|view|supply_run',
    );
  });

  it('counts the rotation down with a Discord relative timestamp, not a rendered string', async () => {
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    expect(screenText(painted(btn))).toMatch(/<t:\d+:R>/);
  });

  it('renders the missions shortest first: 1h → 3h → 6h → 18h', async () => {
    installContent([
      definition({ key: 'd_night', name: 'Night Dive', durationMinutes: 1080 }),
      definition({ key: 'a_quick', name: 'Quick Errand', durationMinutes: 60 }),
      definition({ key: 'c_mid', name: 'Mid Survey', durationMinutes: 360 }),
      definition({ key: 'b_short', name: 'Short Escort', durationMinutes: 180 }),
    ]);
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    const fields = (embedOf(payload).fields ?? []).map((f: { name: string }) => f.name);
    expect(fields.map((n: string) => n.replace(/^\S+ /, ''))).toEqual([
      'Quick Errand',
      'Short Escort',
      'Mid Survey',
      'Night Dive',
    ]);
    const text = screenText(payload);
    const at = (label: string) => text.indexOf(label);
    expect(at('⏱️ 1h ·')).toBeLessThan(at('⏱️ 3h ·'));
    expect(at('⏱️ 3h ·')).toBeLessThan(at('⏱️ 6h ·'));
    expect(at('⏱️ 6h ·')).toBeLessThan(at('⏱️ 18h ·'));
    // Buttons follow the same order.
    const views = components(payload)
      .map((c) => c.customId)
      .filter((id) => id.startsWith('wm|v1|exp|view|'));
    expect(views).toEqual([
      'wm|v1|exp|view|a_quick',
      'wm|v1|exp|view|b_short',
      'wm|v1|exp|view|c_mid',
      'wm|v1|exp|view|d_night',
    ]);
  });

  it('shows an empty state when nothing is on offer here', async () => {
    installContent(completePool({ region: 'thirstlands' }));
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const text = screenText(painted(btn));
    expect(text).toContain('Nobody around here is hiring');
    expect(components(painted(btn)).some((c) => c.customId.startsWith('wm|v1|exp|view'))).toBe(
      false,
    );
  });

  it('says so when the whole feature is switched off', async () => {
    installContent(completePool(), { enabled: false });
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    expect(screenText(painted(btn))).toContain('closed for now');
  });
});

describe('candidate selection', () => {
  it('shows the match quality and non-numeric chips for each candidate', async () => {
    const { prov } = await player(31);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const payload = painted(btn);
    const text = screenText(payload);

    // `PERFECT MATCH ★ Lilith1 — Lv.31` — dominant, demon, over-levelled.
    expect(text).toContain('PERFECT MATCH');
    expect(text).not.toMatch(/EXCELLENT|GOOD|FAIR|RISKY/);
    expect(text).toContain('Lv.31');
    // `Dominant ✓ • Demon ✓ • Lv 10+ ✓` — the explanation, with no numbers.
    expect(text).toContain('Dominant ✓');
    expect(text).toContain('Demon ✓');
    expect(text).toContain('Lv 10+ ✓');
    assertNoNumericOdds(text);
  });

  it('marks a badly under-levelled copy as working against the mission', async () => {
    const { prov } = await player(3);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const text = screenText(painted(btn));
    expect(text).toContain('Lv 10+ ⚠');
    // Affinity and race both met, level far short: not the top label.
    expect(text).toContain('WEAK MATCH');
  });

  it('marks a copy just short of the level as nearly there, and not a perfect match', async () => {
    const { prov } = await player(8);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const text = screenText(painted(btn));
    expect(text).toContain('Lv 10+ ~');
    expect(text).toContain('STRONG MATCH');
    expect(text).not.toContain('PERFECT MATCH');
  });

  it('marks a missed race with a cross rather than hiding it', async () => {
    installContent(completePool({ preferredRaces: ['angel'] }));
    const { prov } = await player(31);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const text = screenText(painted(btn));
    expect(text).toContain('Demon ✗');
    // Two of three: a strong match, never the top label.
    expect(text).toContain('STRONG MATCH');
    expect(text).not.toContain('PERFECT MATCH');
  });

  it('offers a select menu of deployable copies', async () => {
    const { prov, waifuId } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const payload = painted(btn);
    expect(components(payload).map((c) => c.customId)).toContain('wm|v1|exp|pick|supply_run');
    const options = selectOptions(payload);
    expect(options.map((o) => o.value)).toContain(String(waifuId));
    // The option label carries the match quality, so the dropdown itself is readable.
    expect(options[0]!.label).toMatch(/(PERFECT|STRONG|PARTIAL|WEAK|POOR) MATCH/);
  });

  it('greys out a copy who is busy and says why', async () => {
    const { prov, waifuId } = await player();
    await app.collection.setBuddy(prov.playerId, waifuId);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'supply_run');
    const payload = painted(btn);
    const text = screenText(payload);
    expect(text).toContain('Your active Buddy');
    // Nobody free means no select menu at all — Discord rejects an empty one.
    expect(components(payload).map((c) => c.customId)).not.toContain(
      'wm|v1|exp|pick|supply_run',
    );
    expect(text).toContain('Nobody is free to go');
  });

  it('falls back to the board for a mission that no longer exists', async () => {
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'ghost_mission');
    expect(screenText(painted(btn))).toContain('no longer listed');
  });
});

describe('deployment confirmation', () => {
  it('restates everything the player is committing to', async () => {
    const { prov, waifuId } = await player(31);
    const sel = fakeSelect(String(waifuId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionPick(ctx, sel as any, prov, 'supply_run');
    const payload = painted(sel);
    const text = screenText(payload);

    expect(text).toContain('Lilith');           // who
    expect(text).toMatch(/(PERFECT|STRONG|PARTIAL|WEAK|POOR) MATCH/); // match quality
    expect(text).toContain('6h');               // duration
    expect(text).toMatch(/<t:\d+:R>/);          // relative completion
    expect(text).toContain('Dominant');         // preferred affinity
    expect(text).toContain('Demon');            // preferred race
    expect(text).toContain('WaifuBux');         // broad reward preview
    assertNoNumericOdds(text);

    const ids = components(payload).map((c) => c.customId);
    expect(ids).toContain(`wm|v1|exp|deploy|supply_run|${waifuId}`);
    // And a way out that is not "commit".
    expect(ids).toContain('wm|v1|exp|view|supply_run');
  });

  it('refuses to confirm a copy who became unavailable since the menu was drawn', async () => {
    const { prov, waifuId } = await player();
    await app.collection.setBuddy(prov.playerId, waifuId);
    const sel = fakeSelect(String(waifuId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionPick(ctx, sel as any, prov, 'supply_run');
    expect(screenText(painted(sel))).toContain('not available any more');
  });
});

describe('deployment', () => {
  it('sends her out and lands on the active screen', async () => {
    const { prov, waifuId } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(ctx, btn as any, prov, 'supply_run', String(waifuId));
    const text = screenText(painted(btn));
    expect(text).toContain('sets out');
    expect(text).toContain('Lilith');
    expect(text).toMatch(/<t:\d+:R>/);

    const active = await app.expeditions.getActive(prov.playerId);
    expect(active).toHaveLength(1);
    expect(active[0]?.waifuId).toBe(waifuId);
  });
});

describe('activity log — Expedition deployed', () => {
  const deployLines = () => harness.lines.filter((l) => l.text.startsWith('🧭'));

  /** Press Deploy, as the confirmation button does. */
  async function press(prov: Provisioned, key: string, waifuId: number | string, context = ctx) {
    const btn = fakeButton();
    // A real Discord display name, so the log's identity goes through the same
    // resolver every other narrated line uses.
    Object.assign(btn.user, { globalName: 'Hunter' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(context, btn as any, prov, key, String(waifuId));
    return btn;
  }

  async function rowsFor(playerId: number) {
    return t.db.select().from(playerExpeditions).where(eq(playerExpeditions.playerId, playerId));
  }

  beforeEach(() => {
    harness.reset();
  });

  it('narrates a successful deployment exactly once, to the Waifumon Log', async () => {
    const { prov, waifuId } = await player();
    await press(prov, 'supply_run', waifuId);

    expect(harness.ofKind('EXPEDITION_DEPLOYED')).toHaveLength(1);
    // Player: the Discord display name. WaifuMon: nickname, else species.
    // Mission: its player-facing name. Duration: 360 minutes, in words.
    expect(deployLines()).toEqual([
      {
        channelId: 'c-waifumon-log',
        text: `🧭 Hunter has sent Lilith${seq} on Desert Supply Run for 6 hours.`,
        visibility: 'normal',
      },
    ]);
    const text = deployLines()[0]!.text;
    expect(text).not.toContain('supply_run');
    expect(text).not.toContain('supply_success');
    assertNoNumericOdds(text);
  });

  it('formats the duration of the mission actually deployed', async () => {
    const { prov, waifuId } = await player();
    await press(prov, 'night_market', waifuId);
    expect(deployLines().map((l) => l.text)).toEqual([
      `🧭 Hunter has sent Lilith${seq} on Night Market Errand for 1 hour.`,
    ]);
  });

  it('logs nothing when the region is already occupied', async () => {
    const { prov } = await deployed();
    const second = await insertOwnedWaifu(t.db, {
      playerId: prov.playerId,
      speciesId: demonSpecies.id,
      level: 12,
    });
    harness.reset();

    const btn = await press(prov, 'well_watch', second.id);
    expect(screenText(painted(btn))).toContain('⚠️');
    expect(harness.ofKind('EXPEDITION_DEPLOYED')).toHaveLength(0);
    expect(deployLines()).toHaveLength(0);
  });

  it('logs nothing when the WaifuMon is unavailable (already away)', async () => {
    const { prov, waifuId } = await deployed();
    const peeks = completePool({ region: 'twin-peeks' }).map((d) => ({
      ...d,
      key: `peeks_${d.key}`,
    }));
    installContent([...completePool(), ...peeks]);
    await forceRegion(t.db, prov.playerId, 'twin-peeks');
    harness.reset();

    // Twin Peeks is free, but she is still out in Waifu Valley.
    const btn = await press(prov, 'peeks_supply_run', waifuId);
    expect(screenText(painted(btn))).toContain('⚠️');
    expect(deployLines()).toHaveLength(0);
    expect((await rowsFor(prov.playerId)).filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('logs nothing on validation failure — unknown mission, wrong region, bad id', async () => {
    const { prov, waifuId } = await player();
    await press(prov, 'no_such_mission', waifuId);
    await press(prov, 'supply_run', 'not-a-number');
    await forceRegion(t.db, prov.playerId, 'twin-peeks');
    await press(prov, 'supply_run', waifuId);

    expect(harness.ofKind('EXPEDITION_DEPLOYED')).toHaveLength(0);
    expect(deployLines()).toHaveLength(0);
    expect(await rowsFor(prov.playerId)).toHaveLength(0);
  });

  it('logs only the winner of a race for one region', async () => {
    const { prov, waifuId } = await player();
    const rival = await insertOwnedWaifu(t.db, {
      playerId: prov.playerId,
      speciesId: demonSpecies.id,
      level: 12,
      nickname: 'Rival',
    });
    await Promise.all([
      press(prov, 'supply_run', waifuId),
      press(prov, 'well_watch', rival.id),
    ]);

    const active = (await rowsFor(prov.playerId)).filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(harness.ofKind('EXPEDITION_DEPLOYED')).toHaveLength(1);
    expect(deployLines()).toHaveLength(1);
    // And it names the copy that actually went.
    const winner = active[0]!.waifuId === waifuId ? `Lilith${seq}` : 'Rival';
    expect(deployLines()[0]!.text).toContain(`has sent ${winner} on`);
  });

  it('still narrates a committed deployment when the confirmation screen fails to paint', async () => {
    const { prov, waifuId } = await player();
    const btn = fakeButton();
    Object.assign(btn.user, { globalName: 'Hunter' });
    const broken = vi.fn(async () => {
      throw new Error('Discord rejected the interaction update');
    });
    btn.update = broken;
    btn.reply = broken;
    btn.editReply = broken;

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleExpeditionDeploy(ctx, btn as any, prov, 'supply_run', String(waifuId)),
    ).rejects.toThrow('Discord rejected the interaction update');

    expect(broken).toHaveBeenCalled();
    expect(harness.ofKind('EXPEDITION_DEPLOYED')).toHaveLength(1);
    expect(deployLines().map((l) => l.text)).toEqual([
      `🧭 Hunter has sent Lilith${seq} on Desert Supply Run for 6 hours.`,
    ]);
    const active = await app.expeditions.getActive(prov.playerId);
    expect(active).toHaveLength(1);
    expect(active[0]?.waifuId).toBe(waifuId);
    expect(active[0]?.status).toBe('active');
  });

  it('a Waifumon Log failure neither fails nor undoes the deployment', async () => {
    const { prov, waifuId } = await player();
    const bus = createGameEventBus({ logger: t.logger });
    createActivityFeedService({
      logger: t.logger,
      richEmbedMinRarity: app.content.tables.capture.announceMinRarity,
      resolveChannel: async () => 'c-waifumon-log',
      post: async () => {
        throw new Error('Discord is down');
      },
    }).subscribe(bus);
    // A subscriber that throws outright, too — the bus must isolate it.
    bus.subscribe(() => {
      throw new Error('subscriber exploded');
    });

    const btn = await press(prov, 'supply_run', waifuId, { ...ctx, events: bus });
    expect(screenText(painted(btn))).toContain('sets out');
    const active = await app.expeditions.getActive(prov.playerId);
    expect(active).toHaveLength(1);
    expect(active[0]?.waifuId).toBe(waifuId);
  });
});

describe('the active screen', () => {
  it('is what Expeditions opens on while a mission is running', async () => {
    const { prov } = await deployed();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    const text = screenText(payload);

    // The active mission, not the board.
    expect(text).toContain('Desert Supply Run');
    expect(text).toContain('is out on this job');
    expect(text).toMatch(/<t:\d+:R>/);
    assertNoNumericOdds(text);

    const buttons = components(payload);
    const collect = buttons.find((b) => b.customId.startsWith('wm|v1|exp|claim'));
    expect(collect?.disabled).toBe(true);
    expect(buttons.map((b) => b.customId)).toContain('wm|v1|exp|board');
  });

  it('enables Collect once she is back', async () => {
    const { prov, view } = await deployed();
    await timeTravel(view.id);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    expect(screenText(payload)).toContain('She is back');
    const collect = components(payload).find((b) => b.customId.startsWith('wm|v1|exp|claim'));
    expect(collect?.disabled).toBe(false);
  });

  it('offers Recall only while she is still out', async () => {
    const { prov, view } = await deployed();
    const before = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, before as any, prov);
    expect(components(painted(before)).some((b) => b.customId.startsWith('wm|v1|exp|cancel'))).toBe(
      true,
    );

    await timeTravel(view.id);
    const after = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, after as any, prov);
    // A resolved mission has a payout waiting — there is nothing to abandon.
    expect(components(painted(after)).some((b) => b.customId.startsWith('wm|v1|exp|cancel'))).toBe(
      false,
    );
  });

  it('still reaches the board while a mission is running, and says why it is shut', async () => {
    const { prov } = await deployed();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionBoard(ctx, btn as any, prov);
    const payload = painted(btn);
    const text = screenText(payload);
    // The listings are all still there — a busy region hides nothing.
    expect(text).toContain('Desert Supply Run');
    expect(text).toContain('Night Market Errand');
    // But it says, in words, that this region is taken and by whom.
    expect(text).toContain('already working this region');
    // …and every mission button is greyed out rather than missing.
    const missionButtons = components(payload).filter((b) =>
      b.customId.startsWith('wm|v1|exp|view'),
    );
    expect(missionButtons).toHaveLength(4);
    expect(missionButtons.every((b) => b.disabled)).toBe(true);
  });
});

/**
 * Multiple regions on screen.
 *
 * Every assertion here is about a thing the one-mission UI could not express:
 * a roll-call of regions, a board that refuses *this* region without refusing
 * the others, and a claim that frees one region and leaves the rest alone.
 */
describe('several regions at once', () => {
  /** Two missions running: Waifu Valley and Twin Peeks. */
  async function twoRegions() {
    // Distinct keys per region: a content key is global, so a second region
    // reusing `supply_run` would simply shadow the first one.
    const peeksPool = completePool({ region: 'twin-peeks' }).map((d) => ({
      ...d,
      key: `peeks_${d.key}`,
    }));
    installContent([...completePool(), ...peeksPool]);
    const { prov, waifuId } = await player();
    const second = await insertOwnedWaifu(t.db, {
      playerId: prov.playerId,
      speciesId: demonSpecies.id,
      level: 12,
      nickname: 'Morrigan',
    });
    const valley = await app.expeditions.deploy(prov.playerId, 'supply_run', waifuId);
    await forceRegion(t.db, prov.playerId, 'twin-peeks');
    const peeks = await app.expeditions.deploy(prov.playerId, 'peeks_supply_run', second.id);
    return { prov, waifuId, peeksWaifuId: second.id, valley, peeks };
  }

  it('opens on a roll-call of every region working', async () => {
    const { prov } = await twoRegions();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    const text = screenText(payload);

    expect(text).toContain('Your Expeditions');
    expect(text).toContain('**2** regions working');
    // Region, mission and deployed WaifuMon, for both.
    expect(text).toContain('Waifu Valley');
    expect(text).toContain('Twin Peeks');
    expect(text).toContain('Morrigan');
    expect(text).toContain('Desert Supply Run');
    // Duration state, rendered by Discord rather than by us.
    expect(text).toMatch(/<t:\d+:R>/);
    expect(text).toContain('One expedition per region');
    assertNoNumericOdds(text);

    // One button per region, and they name the region.
    const missionButtons = components(payload).filter((b) =>
      b.customId.startsWith('wm|v1|exp|mission'),
    );
    expect(missionButtons).toHaveLength(2);
    expect(missionButtons.map((b) => b.label).sort()).toEqual(['Twin Peeks', 'Waifu Valley']);
    // Well inside Discord's five-row limit.
    expect(payload.components.length).toBeLessThanOrEqual(5);
  });

  it('marks a finished mission as collectable on the roll-call', async () => {
    const { prov, valley } = await twoRegions();
    await timeTravel(valley.id);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, btn as any, prov);
    const payload = painted(btn);
    expect(screenText(payload)).toContain('1** ready to collect');
    const collectable = components(payload).find((b) => b.label.includes('collect'));
    expect(collectable?.customId).toBe(`wm|v1|exp|mission|${valley.id}`);
  });

  it('opens one mission from the roll-call, and offers the way back', async () => {
    const { prov, valley } = await twoRegions();
    const btn = fakeButton();
    await handleExpeditionMission(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx, btn as any, prov, String(valley.id),
    );
    const payload = painted(btn);
    expect(screenText(payload)).toContain('Waifu Valley');
    expect(screenText(payload)).toContain('is out on this job');
    expect(components(payload).map((b) => b.customId)).toContain('wm|v1|exp|active');
  });

  it('shows the busy region on the board and lets the free one deploy', async () => {
    const { prov, valley } = await twoRegions();
    // Travel home, where a mission is already running.
    await forceRegion(t.db, prov.playerId, 'waifu-valley');

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionBoard(ctx, btn as any, prov);
    const payload = painted(btn);
    const text = screenText(payload);

    expect(text).toContain('Expeditions — Waifu Valley');
    expect(text).toContain('already working this region');
    // The other region is named, and named as information rather than a block.
    expect(text).toContain('Also out');
    expect(text).toContain('Twin Peeks');
    expect(
      components(payload)
        .filter((b) => b.customId.startsWith('wm|v1|exp|view'))
        .every((b) => b.disabled),
    ).toBe(true);
    // A direct route to the WaifuMon holding this region.
    expect(components(payload).map((b) => b.customId)).toContain(
      `wm|v1|exp|mission|${valley.id}`,
    );
    assertNoNumericOdds(text);
  });

  it('refuses to open a mission detail in a region already deployed', async () => {
    const { prov } = await twoRegions();
    await forceRegion(t.db, prov.playerId, 'waifu-valley');

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, btn as any, prov, 'night_market');
    const text = screenText(painted(btn));
    // Bounced back to the board rather than offered a menu that can only fail.
    expect(text).toContain('already working this region');
    expect(selectOptions(painted(btn))).toHaveLength(0);
  });

  it('still offers a deployment in a region that is free', async () => {
    const { prov, waifuId } = await twoRegions();
    // Cancel Twin Peeks so the region the player is standing in opens back up.
    const [peeks] = (await app.expeditions.getActive(prov.playerId)).filter(
      (v) => v.region === 'twin-peeks',
    );
    await app.expeditions.cancel(prov.playerId, peeks!.id);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionBoard(ctx, btn as any, prov);
    const payload = painted(btn);
    expect(screenText(payload)).not.toContain('already working this region');
    // Waifu Valley is still running, and says so without blocking anything.
    expect(screenText(payload)).toContain('Also out');
    expect(
      components(payload)
        .filter((b) => b.customId.startsWith('wm|v1|exp|view'))
        .every((b) => b.disabled),
    ).toBe(false);
    // The copy in Waifu Valley is not on offer here.
    const detail = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, detail as any, prov, 'supply_run');
    expect(selectOptions(painted(detail)).map((o) => o.value)).not.toContain(String(waifuId));
  });

  it('collects one region and leaves the other running', async () => {
    const { prov, valley, peeks } = await twoRegions();
    await timeTravel(valley.id);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, btn as any, prov, String(valley.id));
    const text = screenText(painted(btn));
    expect(text).toContain('Desert Supply Run');
    expect(painted(btn).embeds[0].toJSON().footer.text).toContain('Waifu Valley is free again');

    // The other mission is untouched, and is now the only one running.
    const active = await app.expeditions.getActive(prov.playerId);
    expect(active.map((v) => v.id)).toEqual([peeks.id]);
    expect(active[0]?.status).toBe('active');
  });
});

describe('the result screen', () => {
  async function collect(outcome: 'success' | 'failure' | 'exceptional') {
    const { prov, view } = await deployed();
    await forceOutcome(view.id, outcome);
    await timeTravel(view.id);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, btn as any, prov, String(view.id));
    return { prov, view, payload: painted(btn) };
  }

  it('shows a normal success as one reward list', async () => {
    const { payload } = await collect('success');
    const json = embedOf(payload);
    const text = screenText(payload);

    expect(json.title).toContain('Success');
    expect(json.title).not.toContain('Exceptional');
    expect(text).toContain('200');
    expect(text).toContain('Sunbleached Scrap');
    // No split blocks on an ordinary success — nothing extra happened.
    const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
    expect(fieldNames).toContain('Rewards');
    expect(fieldNames).not.toContain('🌟 Exceptional Bonus');
    assertNoNumericOdds(text);
  });

  /**
   * The headline presentation rule: an Exceptional result must show what
   * excelling *added*, not a single list the player cannot decompose.
   */
  it('splits an exceptional success into Normal Rewards and Exceptional Bonus', async () => {
    const { payload } = await collect('exceptional');
    const json = embedOf(payload);
    const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);

    expect(json.title).toContain('Exceptional');
    expect(fieldNames).toContain('Normal Rewards');
    expect(fieldNames).toContain('🌟 Exceptional Bonus');

    const normal = (json.fields ?? []).find((f: { name: string }) => f.name === 'Normal Rewards');
    const bonus = (json.fields ?? []).find(
      (f: { name: string }) => f.name === '🌟 Exceptional Bonus',
    );
    // The ordinary payout stays what an ordinary success would have paid...
    expect(normal.value).toContain('200');
    expect(normal.value).toContain('Sunbleached Scrap');
    // ...and the bonus is visibly separate and additive.
    expect(bonus.value).toContain('500');
    expect(bonus.value).toContain('Cracked Relic');
    expect(normal.value).not.toContain('Cracked Relic');
  });

  it('shows a failure as a consolation, not as nothing', async () => {
    const { prov, payload } = await collect('failure');
    const json = embedOf(payload);
    const text = screenText(payload);

    expect(json.title).toContain('Setback');
    expect(text).toContain('not come back empty-handed');
    const fieldNames = (json.fields ?? []).map((f: { name: string }) => f.name);
    expect(fieldNames).toContain('Brought home anyway');
    expect(text).toContain('25');
    expect(text).toContain('Sunbleached Scrap');

    // And the consolation really was paid.
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBeGreaterThanOrEqual(25);
  });

  it('credits the inventory and balance it reports', async () => {
    const { prov, payload } = await collect('success');
    expect(screenText(payload)).toContain('Sunbleached Scrap');
    const inventory = await app.inventory.getInventory(prov.playerId);
    expect(inventory.find((e) => e.item.slug === 'ui_scrap')?.quantity).toBe(2);
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBe(200);
  });

  it('offers a way straight back to the board', async () => {
    const { payload } = await collect('success');
    expect(components(payload).map((c) => c.customId)).toContain('wm|v1|exp|board');
  });
});

describe('cancellation', () => {
  it('asks first, and states all four consequences', async () => {
    const { prov, view } = await deployed();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancel(ctx, btn as any, prov, String(view.id));
    const payload = painted(btn);
    const text = screenText(payload);

    expect(text).toContain('Returns her immediately');
    expect(text).toContain('no rewards');
    expect(text).toContain('no XP');
    expect(text).toContain('Cannot be undone');

    // Nothing has been written yet.
    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, view.id));
    expect(row!.status).toBe('active');

    // Two buttons, and the destructive one is not the first.
    const buttons = components(payload);
    expect(buttons[0]!.customId).toBe('wm|v1|exp|active');
    expect(buttons[1]!.customId).toBe(`wm|v1|exp|cancel_confirm|${view.id}`);
  });

  it('backing out changes nothing and returns to the active screen', async () => {
    const { prov, view } = await deployed();
    const cancel = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancel(ctx, cancel as any, prov, String(view.id));

    const back = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionActive(ctx, back as any, prov);
    expect(screenText(painted(back))).toContain('is out on this job');

    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, view.id));
    expect(row!.status).toBe('active');
    expect(row!.cancelledAt).toBeNull();
  });

  it('confirming recalls her, pays nothing and returns to the board', async () => {
    const { prov, waifuId, view } = await deployed();
    const before = await app.currency.getBalances(prov.playerId);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancelConfirm(ctx, btn as any, prov, String(view.id));
    const text = screenText(painted(btn));
    expect(text).toContain('was recalled');
    expect(text).toContain('no rewards');
    // Back on the board, with the region open again.
    expect(text).not.toContain('already working this region');
    expect(
      components(painted(btn))
        .filter((b) => b.customId.startsWith('wm|v1|exp|view'))
        .every((b) => b.disabled),
    ).toBe(false);

    expect(await app.currency.getBalances(prov.playerId)).toEqual(before);
    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, view.id));
    expect(row!.status).toBe('cancelled');
    expect(row!.outcome).toBeNull();
    expect(row!.rewards).toBeNull();

    // And she is free immediately.
    expect(await app.availability.reasonsFor(t.db, prov.playerId, waifuId)).not.toContain(
      'on_expedition',
    );
  });

  it('refuses to open the confirmation once she is already back', async () => {
    const { prov, view } = await deployed();
    await timeTravel(view.id);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancel(ctx, btn as any, prov, String(view.id));
    expect(screenText(painted(btn))).toContain('collect instead');
  });
});

describe('stale interactions', () => {
  it('a stale Deploy repaints the board instead of erroring', async () => {
    const { prov, waifuId } = await deployed();
    // The copy is already out; this is the old confirmation button.
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(ctx, btn as any, prov, 'supply_run', String(waifuId));
    const text = screenText(painted(btn));
    expect(text).toContain('⚠️');
    expect(btn.update).toHaveBeenCalledOnce();

    // Still exactly one mission — nothing was duplicated.
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, prov.playerId));
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('a stale Deploy for an expedition that has been removed repaints cleanly', async () => {
    const { prov, waifuId } = await player();
    installContent([]);
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(ctx, btn as any, prov, 'supply_run', String(waifuId));
    expect(screenText(painted(btn))).toContain('⚠️');
  });

  it('a double-clicked Collect pays once and explains the second press', async () => {
    const { prov, view } = await deployed();
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);

    const first = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, first as any, prov, String(view.id));
    expect(embedOf(painted(first)).title).toContain('Success');

    const second = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, second as any, prov, String(view.id));
    expect(screenText(painted(second))).toContain('⚠️');

    // Paid exactly once.
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBe(200);
  });

  it('a stale Collect for a mission that no longer exists repaints cleanly', async () => {
    const { prov } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, btn as any, prov, '999999');
    expect(screenText(painted(btn))).toContain('⚠️');
  });

  it('a double-clicked Recall cancels once and explains the second press', async () => {
    const { prov, view } = await deployed();
    const first = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancelConfirm(ctx, first as any, prov, String(view.id));
    expect(screenText(painted(first))).toContain('was recalled');

    const second = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancelConfirm(ctx, second as any, prov, String(view.id));
    const text = screenText(painted(second));
    expect(text).toContain('⚠️');
    // The row moved once, not twice.
    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, view.id));
    expect(row!.status).toBe('cancelled');
  });

  it('a Recall confirmation pressed after she finished does not abandon the payout', async () => {
    const { prov, view } = await deployed();
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);
    // Resolving it first is what a real "she came back while you hesitated"
    // looks like: the player opened the confirmation, then the screen moved on.
    await app.expeditions.getActive(prov.playerId);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionCancelConfirm(ctx, btn as any, prov, String(view.id));
    expect(screenText(painted(btn))).toContain('⚠️');

    const [row] = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.id, view.id));
    expect(row!.status).toBe('resolved');
    // The rewards are still there to collect.
    const result = await app.expeditions.claim(prov.playerId, view.id);
    expect(result.rewards.waifubux).toBe(200);
  });

  it('a stale pick for a removed expedition repaints the board', async () => {
    const { prov, waifuId } = await player();
    installContent([]);
    const sel = fakeSelect(String(waifuId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionPick(ctx, sel as any, prov, 'supply_run');
    expect(screenText(painted(sel))).toContain('no longer listed');
  });
});

describe('On Expedition in Inspect', () => {
  it('says where she is, in the title and the body', async () => {
    const { prov, waifuId } = await deployed();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await renderInspect(ctx, btn as any, prov, waifuId);
    const payload = painted(btn);
    const json = embedOf(payload);

    expect(json.title).toContain('On Expedition');
    expect(json.description).toContain('out on a job');
  });

  it('explains that Release is unavailable because she is away', async () => {
    const { prov, waifuId } = await deployed();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await renderInspect(ctx, btn as any, prov, waifuId);
    const payload = painted(btn);
    expect(embedOf(payload).description).toContain('away on an expedition');
    const release = components(payload).find((c) => c.customId.startsWith('wm|v1|waifu|release'));
    expect(release?.disabled).toBe(true);
  });

  it('says nothing about expeditions for a copy who is at home', async () => {
    const { prov, waifuId } = await player();
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await renderInspect(ctx, btn as any, prov, waifuId);
    const json = embedOf(painted(btn));
    expect(json.title).not.toContain('On Expedition');
    expect(json.description).not.toContain('out on a job');
  });

  it('drops the badge once she is collected', async () => {
    const { prov, waifuId, view } = await deployed();
    await timeTravel(view.id);
    await app.expeditions.claim(prov.playerId, view.id);

    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await renderInspect(ctx, btn as any, prov, waifuId);
    expect(embedOf(painted(btn)).title).not.toContain('On Expedition');
  });
});

describe('odds never leak into Discord output', () => {
  /**
   * The sweep. Every screen in the flow, checked with one rule — because the
   * failure being guarded against is a careless interpolation on whichever
   * screen nobody thought to check.
   */
  it('shows no percentage or decimal chance on any screen in the flow', async () => {
    const { prov, waifuId } = await player(31);
    const texts: string[] = [];

    const board = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditions(ctx, board as any, prov);
    texts.push(screenText(painted(board)));

    const detail = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionView(ctx, detail as any, prov, 'supply_run');
    texts.push(screenText(painted(detail)));
    // Select-menu labels and descriptions are player-visible text too.
    texts.push(
      selectOptions(painted(detail))
        .map((o) => `${o.label} ${o.description}`)
        .join('\n'),
    );

    const confirm = fakeSelect(String(waifuId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionPick(ctx, confirm as any, prov, 'supply_run');
    texts.push(screenText(painted(confirm)));

    const deploy = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(ctx, deploy as any, prov, 'supply_run', String(waifuId));
    texts.push(screenText(painted(deploy)));

    const [active] = await app.expeditions.getActive(prov.playerId);
    await forceOutcome(active!.id, 'exceptional');
    await timeTravel(active!.id);

    const cancelScreen = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionActive(ctx, cancelScreen as any, prov);
    texts.push(screenText(painted(cancelScreen)));

    const claim = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionClaim(ctx, claim as any, prov, String(active!.id));
    texts.push(screenText(painted(claim)));

    for (const text of texts) assertNoNumericOdds(text);
  });

  it('never serializes the persisted chances onto a view', async () => {
    const { view } = await deployed();
    expect(view).not.toHaveProperty('successChance');
    expect(view).not.toHaveProperty('exceptionalChance');
    expect(view).not.toHaveProperty('resolutionRoll');
    expect(JSON.stringify(view)).not.toContain('Chance');
  });
});

describe('every screen answers ephemerally', () => {
  it('never posts to the channel', async () => {
    const channel = fakeChannel();
    const { prov, waifuId } = await player();
    const btn = { ...fakeButton(channel), channel };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleExpeditionDeploy(ctx, btn as any, prov, 'supply_run', String(waifuId));
    expect(channel.send).not.toHaveBeenCalled();
    expect(btn.update).toHaveBeenCalledOnce();
    void MessageFlags.Ephemeral;
  });
});
