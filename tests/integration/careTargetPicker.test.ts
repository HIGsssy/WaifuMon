/**
 * Care Mode target picker — real Postgres, real handlers, fake Discord.
 *
 * The old picker was one select menu holding the first 25 owned copies, so
 * anything past that was unreachable. These tests pin the paged, searchable
 * replacement: every screen stays within Discord's 25-option limit, a copy
 * beyond the first 25 can be reached by paging or by search, duplicates go
 * through the copy selector, and released copies never show up.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCareChangeOpen,
  handleCareChangePick,
  handleCareTargetPick,
} from '../../src/discord/commands/waifumon';
import {
  handleCareTargetFilterSubmit,
  handleCareTargetPage,
} from '../../src/discord/commands/waifumonCareTarget';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import { playerWaifus, players, species, type PlayerWaifuRow } from '../../src/db/schema';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  insertOwnedWaifu,
  insertOwnedWaifus,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-care-picker', 'u-1');
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
    collectionFilters: createCollectionFilterTracker(),
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
      collection: app.collection,
      appearance: app.appearance,
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      effects: app.effects,
      itemUse: app.itemUse,
      gifts: app.gifts,
      session: app.session,
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db
    .update(players)
    .set({
      buddyWaifuId: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, prov.playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  harness.reset();
});

/** One copy each of the first `n` species, by id. */
async function grantDistinct(n: number): Promise<PlayerWaifuRow[]> {
  const all = await t.db.select().from(species).orderBy(asc(species.id)).limit(n);
  expect(all.length).toBe(n);
  return insertOwnedWaifus(
    t.db,
    all.map((sp) => ({ playerId: prov.playerId, speciesId: sp.id, level: 1 })),
  );
}

async function grantCopies(slug: string, levels: number[]): Promise<PlayerWaifuRow[]> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
  const rows: PlayerWaifuRow[] = [];
  for (const level of levels) {
    rows.push(await insertOwnedWaifu(t.db, { playerId: prov.playerId, speciesId: sp!.id, level }));
  }
  return rows;
}

async function careTargetId(): Promise<number | null> {
  const state = await app.care.getState(prov.playerId);
  return state.active ? (state.target?.waifu.id ?? null) : null;
}

// ───────────────────────────── fake interactions ─────────────────────────────

function baseInteraction() {
  return {
    id: 'i-1',
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-care-picker',
  };
}

const fakeButton = () => ({ ...baseInteraction(), isButton: () => true, message: { id: 'm-1' } });
const fakeSelect = (values: string[]) => ({
  ...baseInteraction(),
  isStringSelectMenu: () => true,
  values,
  message: { id: 'm-1' },
});
const fakeModal = (fields: Record<string, string>) => ({
  ...baseInteraction(),
  isModalSubmit: () => true,
  fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
});

type Fake = ReturnType<typeof baseInteraction>;

/** The first payload a handler painted (the picker screen itself). */
function painted(interaction: Fake): any {
  for (const method of [interaction.update, interaction.reply, interaction.editReply]) {
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

/** Every text content the handler sent, across all response methods. */
function contents(interaction: Fake): string[] {
  return [interaction.update, interaction.reply, interaction.editReply, interaction.followUp]
    .flatMap((m) => m.mock.calls as unknown as unknown[][])
    .map((call) => String((call[0] as { content?: string }).content ?? ''));
}

function components(payload: any): any[] {
  return (payload.components ?? []).flatMap((row: any) => row.components ?? []);
}

function selectById(payload: any, action: string): any | undefined {
  return components(payload).find(
    (c: any) => c.data.type === 3 && String(c.data.custom_id).includes(`|care|${action}`),
  );
}

function buttonByLabel(payload: any, label: string): any | undefined {
  return components(payload).find((c: any) => c.data.type === 2 && c.data.label === label);
}

async function openPicker(): Promise<any> {
  const i = fakeButton();
  await handleCareChangeOpen(ctx, i as never, prov);
  return painted(i);
}

function everySelectWithinLimit(payload: any): void {
  for (const c of components(payload).filter((c: any) => c.data.type === 3)) {
    expect(c.options.length).toBeLessThanOrEqual(25);
  }
}

// ─────────────────────────────────── tests ───────────────────────────────────

describe('Care target picker — large collections', () => {
  it('pages past the first 25 and selects a Waifumon only reachable there', async () => {
    const owned = await grantDistinct(30);
    const ownedIds = new Set(owned.map((w) => w.id));

    let screen = await openPicker();
    everySelectWithinLimit(screen);
    expect(screen.embeds[0].data.description).toMatch(/Page 1\/3/);
    expect(buttonByLabel(screen, 'Next ▶').data.disabled).toBe(false);

    // Walk to the last page; everything seen must be owned and within limits.
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const i = fakeButton();
      await handleCareTargetPage(ctx, i as never, prov, [String(page)]);
      screen = painted(i);
      everySelectWithinLimit(screen);
      for (const opt of selectById(screen, 'target_pick').options) seen.add(opt.data.value);
    }
    expect(seen.size).toBe(30);
    expect(buttonByLabel(screen, 'Next ▶').data.disabled).toBe(true);

    // The last option on page 3 is the 30th in list order — beyond any 25-cap.
    const last = selectById(screen, 'target_pick').options.at(-1).data.value as string;
    const pickedId = Number(last.split(':')[1]);
    expect(last.startsWith('single:')).toBe(true);
    expect(ownedIds.has(pickedId)).toBe(true);

    await handleCareTargetPick(ctx, fakeSelect([last]) as never, prov);
    expect(await careTargetId()).toBe(pickedId);
    expect(harness.ofKind('PLAYER_ENTERED_CARE')).toHaveLength(1);
  });

  it('search finds and selects a Waifumon the old 25-option menu could not show', async () => {
    const owned = await grantDistinct(30);
    // Exactly what the old picker filled its single menu with.
    const firstTwentyFive = new Set(
      (await app.collection.searchByName(prov.playerId, '', 25)).map((e) => e.waifu.id),
    );
    const hiddenRow = owned.find((w) => !firstTwentyFive.has(w.id))!;
    expect(hiddenRow).toBeDefined();
    const hidden = await app.collection.getOwned(prov.playerId, hiddenRow.id);

    await openPicker();
    const modal = fakeModal({ name: hidden.species.name });
    await handleCareTargetFilterSubmit(ctx, modal as never, prov);
    const screen = painted(modal);
    const values = selectById(screen, 'target_pick').options.map((o: any) => o.data.value);
    expect(values).toContain(`single:${hidden.waifu.id}`);

    await handleCareTargetPick(ctx, fakeSelect([`single:${hidden.waifu.id}`]) as never, prov);
    expect(await careTargetId()).toBe(hidden.waifu.id);
  });

  it('re-opening the picker starts over on page 1 with no search', async () => {
    await grantDistinct(30);
    await openPicker();
    await handleCareTargetFilterSubmit(ctx, fakeModal({ name: 'zzz-no-match' }) as never, prov);
    const screen = await openPicker();
    expect(screen.embeds[0].data.description).toMatch(/No filters/);
    expect(screen.embeds[0].data.description).toMatch(/Page 1\//);
  });
});

describe('Care target picker — duplicates and released copies', () => {
  it('a duplicated species opens the copy selector and cares for the exact copy', async () => {
    const copies = await grantCopies('neko_barista', [5, 12, 30]);
    const screen = await openPicker();
    const [group] = selectById(screen, 'target_pick').options;
    expect(group.data.value).toMatch(/^dup:\d+$/);

    const pickGroup = fakeSelect([group.data.value]);
    await handleCareTargetPick(ctx, pickGroup as never, prov);
    const copyScreen = painted(pickGroup);
    const copySelect = selectById(copyScreen, 'change_pick');
    expect(copySelect.options.map((o: any) => Number(o.data.value)).sort()).toEqual(
      copies.map((c) => c.id).sort(),
    );
    // Nothing is set until a specific copy is chosen.
    expect(await careTargetId()).toBeNull();

    const middle = copies[1]!;
    await handleCareChangePick(ctx, fakeSelect([String(middle.id)]) as never, prov);
    expect(await careTargetId()).toBe(middle.id);
  });

  it('released copies never appear and cannot be picked', async () => {
    const [kept, released] = await grantCopies('neko_barista', [5, 40]);
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, released!.id));

    const screen = await openPicker();
    const values = selectById(screen, 'target_pick').options.map((o: any) => o.data.value);
    // One surviving copy → picked outright, and the released one is absent.
    expect(values).toEqual([`single:${kept!.id}`]);
    expect(screen.embeds[0].data.description).not.toMatch(/Lv 40/);

    // A stale select still carrying the released id is refused.
    const stale = fakeSelect([String(released!.id)]);
    await handleCareChangePick(ctx, stale as never, prov);
    expect(await careTargetId()).toBeNull();
    expect(contents(stale).join('\n')).toMatch(/\S/);
  });
});

describe('Care target picker — applying the pick', () => {
  it('switches an active care target and announces the change', async () => {
    const [a, b] = await grantDistinct(2);
    await app.care.start(prov.playerId, a!.id);
    harness.reset();

    await handleCareTargetPick(ctx, fakeSelect([`single:${b!.id}`]) as never, prov);
    expect(await careTargetId()).toBe(b!.id);
    expect(harness.ofKind('CARE_BUDDY_CHANGED')).toHaveLength(1);
  });

  it('re-picking the current target is a no-op', async () => {
    const [a] = await grantDistinct(2);
    await app.care.start(prov.playerId, a!.id);
    const before = await t.db.select().from(players).where(eq(players.id, prov.playerId));
    harness.reset();

    const i = fakeSelect([`single:${a!.id}`]);
    await handleCareTargetPick(ctx, i as never, prov);

    const after = await t.db.select().from(players).where(eq(players.id, prov.playerId));
    expect(await careTargetId()).toBe(a!.id);
    expect(after[0]!.careModeLastTickAt).toEqual(before[0]!.careModeLastTickAt);
    expect(harness.ofKind('CARE_BUDDY_CHANGED')).toHaveLength(0);
    expect(harness.ofKind('PLAYER_ENTERED_CARE')).toHaveLength(0);
    expect(contents(i).join('\n')).toMatch(/Already caring for/);
  });

  it('marks the current target in the list', async () => {
    const [a] = await grantDistinct(3);
    await app.care.start(prov.playerId, a!.id);
    const screen = await openPicker();
    expect(screen.embeds[0].data.description).toMatch(/💗 caring/);
  });
});

describe('Care target picker — small collections', () => {
  it('shows a single page with every copy and picks straight from it', async () => {
    const owned = await grantDistinct(3);
    const screen = await openPicker();
    const values = selectById(screen, 'target_pick').options.map((o: any) => o.data.value);
    expect(values.sort()).toEqual(owned.map((w) => `single:${w.id}`).sort());
    expect(buttonByLabel(screen, '◀ Prev').data.disabled).toBe(true);
    expect(buttonByLabel(screen, 'Next ▶').data.disabled).toBe(true);

    await handleCareTargetPick(ctx, fakeSelect([`single:${owned[2]!.id}`]) as never, prov);
    expect(await careTargetId()).toBe(owned[2]!.id);
  });

  it('with nothing owned, says so instead of painting an empty menu', async () => {
    const i = fakeButton();
    await handleCareChangeOpen(ctx, i as never, prov);
    expect(contents(i).join('\n')).toMatch(/No Waifumon/);
  });
});
