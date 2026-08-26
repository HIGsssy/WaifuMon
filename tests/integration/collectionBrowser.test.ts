/**
 * Grouped collection browser — real Postgres, real handlers, fake Discord.
 *
 * Covers the service-side grouping semantics (level filter before grouping,
 * minCopies after) and the Discord screens built on top: the filter modal
 * round-trip, sort, the duplicate copy picker, and the zero-result state that
 * must never emit an empty select menu.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCollection,
  handleCollectionFilterClear,
  handleCollectionFilterSubmit,
  handleCollectionPickCopy,
  handleCollectionPickGroup,
  handleCollectionSort,
} from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import { playerWaifus, species, type PlayerWaifuRow } from '../../src/db/schema';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
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
  prov = await provisionPlayer(app, 'g-col-browser', 'u-1');
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
      players: app.players,
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
      session: app.session,
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  ctx.collectionFilters!.reset(prov.playerId);
});

/** Insert owned copies at explicit levels so filters have something to bite. */
async function grant(
  slug: string,
  levels: number[],
  opts: { favorite?: boolean } = {},
): Promise<PlayerWaifuRow[]> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
  if (!sp) throw new Error(`missing species ${slug}`);
  const rows: PlayerWaifuRow[] = [];
  for (const level of levels) {
    const [row] = await t.db
      .insert(playerWaifus)
      .values({
        playerId: prov.playerId,
        speciesId: sp.id,
        level,
        ...(opts.favorite ? { isFavorite: true } : {}),
      })
      .returning();
    rows.push(row!);
  }
  return rows;
}

async function speciesIdOf(slug: string): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, slug));
  return sp!.id;
}

// ───────────────────────────── fake interactions ─────────────────────────────

function baseInteraction() {
  return {
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
    guildId: 'g-col-browser',
  };
}

const fakeCommand = () => ({ ...baseInteraction(), isChatInputCommand: () => true });
const fakeButton = () => ({
  ...baseInteraction(),
  isButton: () => true,
  message: { id: 'm-1' },
});
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

/** The payload a handler painted, whichever Discord method it reached for. */
function painted(interaction: ReturnType<typeof baseInteraction>): any {
  for (const method of [interaction.update, interaction.reply, interaction.editReply]) {
    // The fakes are declared arg-less, so widen before reading the payload.
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

const describeOf = (payload: any): string => payload.embeds[0].data.description as string;

/** Every select menu on the painted screen. */
function selectMenus(payload: any): any[] {
  return (payload.components ?? [])
    .flatMap((row: any) => row.components ?? [])
    .filter((c: any) => c.data.type === 3);
}

function selectByPrefix(payload: any, action: string): any | undefined {
  return selectMenus(payload).find((c: any) =>
    String(c.data.custom_id).includes(`|col|${action}`),
  );
}

describe('grouped collection screen', () => {
  it('collapses duplicates into one line per species', async () => {
    await grant('neko_barista', [4, 12, 30]);
    await grant('gym_oni', [7]);

    const i = fakeCommand();
    await handleCollection(ctx, i as never, prov);
    const body = describeOf(painted(i));

    // One line per species, with the copy count and the highest level.
    expect(body).toMatch(/×3/);
    expect(body).toMatch(/Lv 30/);
    expect(body.split('\n').filter((l) => l.startsWith('`0')).length).toBe(2);
  });

  it('offers a single-copy group as a direct inspect and a duplicate group as a picker', async () => {
    const [solo] = await grant('gym_oni', [5]);
    await grant('neko_barista', [4, 30]);
    const nekoId = await speciesIdOf('neko_barista');

    const i = fakeCommand();
    await handleCollection(ctx, i as never, prov);
    const values = selectByPrefix(painted(i), 'pick_group').options.map(
      (o: any) => o.data.value,
    );

    expect(values).toContain(`single:${solo!.id}`);
    expect(values).toContain(`dup:${nekoId}`);
  });
});

describe('filters', () => {
  it('applies the level filter to copies before grouping', async () => {
    await grant('neko_barista', [4, 12, 30]);

    const modal = fakeModal({ min_level: '10' });
    await handleCollectionFilterSubmit(ctx, modal as never, prov);
    const body = describeOf(painted(modal));

    // Sakura-style example: 3 owned, 2 match, so the group reads ×2.
    expect(body).toMatch(/×2/);
    expect(body).toContain('Lv 10+');
  });

  it('applies minCopies to the matching count, not the owned count', async () => {
    await grant('neko_barista', [4, 6, 30]);

    const modal = fakeModal({ min_level: '10', min_copies: '2' });
    await handleCollectionFilterSubmit(ctx, modal as never, prov);
    const payload = painted(modal);

    expect(describeOf(payload)).toContain('No Waifumon match these filters');
    // ADJ-5: an empty result must not render an empty group select.
    expect(selectByPrefix(payload, 'pick_group')).toBeUndefined();
    // The sort menu is static and still safe to show.
    expect(selectByPrefix(payload, 'sort')).toBeDefined();
  });

  it('matches names case-insensitively on a partial string', async () => {
    await grant('neko_barista', [5]);
    await grant('gym_oni', [5]);

    const modal = fakeModal({ name: 'NEKO' });
    await handleCollectionFilterSubmit(ctx, modal as never, prov);
    const body = describeOf(painted(modal));

    expect(body.toLowerCase()).toContain('neko');
    expect(body.split('\n').filter((l) => l.startsWith('`0')).length).toBe(1);
  });

  it('rejects an inverted level range and leaves filters untouched', async () => {
    await grant('neko_barista', [5]);

    const modal = fakeModal({ min_level: '30', max_level: '10' });
    await handleCollectionFilterSubmit(ctx, modal as never, prov);

    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Min level') }),
    );
    expect(ctx.collectionFilters!.get(prov.playerId).minLevel).toBeNull();
  });

  it('clears filters back to the full collection', async () => {
    await grant('neko_barista', [4]);
    await handleCollectionFilterSubmit(ctx, fakeModal({ min_level: '40' }) as never, prov);
    expect(ctx.collectionFilters!.get(prov.playerId).minLevel).toBe(40);

    const clear = fakeButton();
    await handleCollectionFilterClear(ctx, clear as never, prov);

    expect(ctx.collectionFilters!.get(prov.playerId).minLevel).toBeNull();
    expect(describeOf(painted(clear))).toMatch(/Lv 4/);
  });

  it('survives navigation — filters persist across a re-render', async () => {
    await grant('neko_barista', [4, 30]);
    await handleCollectionFilterSubmit(ctx, fakeModal({ min_level: '10' }) as never, prov);

    const again = fakeCommand();
    await handleCollection(ctx, again as never, prov);
    expect(describeOf(painted(again))).toContain('Lv 10+');
  });
});

describe('sort', () => {
  it('re-orders groups and resets to page 1', async () => {
    await grant('neko_barista', [5, 5, 5]); // 3 copies
    await grant('gym_oni', [50]); // 1 copy, higher level

    const byLevel = fakeSelect(['level_desc']);
    await handleCollectionSort(ctx, byLevel as never, prov);
    const levelFirst = describeOf(painted(byLevel)).split('\n').filter((l) => l.startsWith('`0'))[0]!;
    expect(levelFirst).toMatch(/Lv 50/);

    const byCopies = fakeSelect(['copies_desc']);
    await handleCollectionSort(ctx, byCopies as never, prov);
    const copiesFirst = describeOf(painted(byCopies)).split('\n').filter((l) => l.startsWith('`0'))[0]!;
    expect(copiesFirst).toMatch(/×3/);

    expect(ctx.collectionFilters!.get(prov.playerId).page).toBe(1);
  });

  it('ignores an unknown sort value rather than throwing', async () => {
    await grant('neko_barista', [5]);
    const bogus = fakeSelect(['by_vibes']);
    await handleCollectionSort(ctx, bogus as never, prov);
    expect(ctx.collectionFilters!.get(prov.playerId).sortBy).toBe('name_asc');
  });
});

describe('duplicate copy selector', () => {
  it('lists each copy with its own id and level', async () => {
    const rows = await grant('neko_barista', [4, 30]);
    const speciesId = await speciesIdOf('neko_barista');

    const pick = fakeSelect([`dup:${speciesId}`]);
    await handleCollectionPickGroup(ctx, pick as never, prov);
    const payload = painted(pick);

    const body = describeOf(payload);
    for (const row of rows) expect(body).toContain(`#${row.id}`);

    const values = selectByPrefix(payload, 'pick_copy').options.map((o: any) => o.data.value);
    expect(values).toEqual(rows.map((r) => String(r.id)));
  });

  it('honours the active level filter, matching the group count', async () => {
    const rows = await grant('neko_barista', [4, 12, 30]);
    const speciesId = await speciesIdOf('neko_barista');
    await handleCollectionFilterSubmit(ctx, fakeModal({ min_level: '10' }) as never, prov);

    const pick = fakeSelect([`dup:${speciesId}`]);
    await handleCollectionPickGroup(ctx, pick as never, prov);
    const body = describeOf(painted(pick));

    expect(body).not.toContain(`#${rows[0]!.id}`); // the Lv 4 copy
    expect(body).toContain(`#${rows[1]!.id}`);
    expect(body).toContain(`#${rows[2]!.id}`);
  });

  it('picking a copy opens that exact copy in inspect', async () => {
    const rows = await grant('neko_barista', [4, 30]);
    const target = rows[1]!;

    const pick = fakeSelect([String(target.id)]);
    await handleCollectionPickCopy(ctx, pick as never, prov);
    const payload = painted(pick);

    expect(payload.embeds[0].data.fields.find((f: any) => f.name === 'Level').value).toContain(
      '30',
    );
  });

  it('a single-copy group goes straight to inspect', async () => {
    const [solo] = await grant('gym_oni', [9]);

    const pick = fakeSelect([`single:${solo!.id}`]);
    await handleCollectionPickGroup(ctx, pick as never, prov);
    const payload = painted(pick);

    expect(payload.embeds[0].data.fields.find((f: any) => f.name === 'Level').value).toContain(
      '9',
    );
  });

  it('handles a group whose copies all vanished', async () => {
    const speciesId = await speciesIdOf('neko_barista');
    const pick = fakeSelect([`dup:${speciesId}`]);
    await handleCollectionPickGroup(ctx, pick as never, prov);

    const payload = painted(pick);
    expect(payload.content).toContain('No copies of that Waifumon');
    expect(selectMenus(payload)).toHaveLength(0);
  });
});

describe('empty collection', () => {
  it('shows the starter hint, not a filter hint, and no select menu', async () => {
    const i = fakeCommand();
    await handleCollection(ctx, i as never, prov);
    const payload = painted(i);

    expect(describeOf(payload)).toContain('No Waifumon yet');
    expect(selectByPrefix(payload, 'pick_group')).toBeUndefined();
  });
});
