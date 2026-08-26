/**
 * Which surfaces actually get scheduled for cleanup — the wiring, not the
 * helper.
 *
 * The risk this guards is asymmetric: failing to clean up leaves clutter, but
 * cleaning up the wrong thing deletes the screen a player is mid-way through
 * using. So the negative cases (active collection/inspect UI, public log
 * posts) matter more here than the positive ones.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCollection,
  handleCollectionPickGroup,
  handleWaifuInvest,
} from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import {
  EPHEMERAL_CONFIRM_TTL_MS,
  EPHEMERAL_UNLOCK_TOAST_TTL_MS,
} from '../../src/discord/ephemeralCleanup';
import { playerCurrencies, playerWaifus, species } from '../../src/db/schema';
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
let costPer: number;
let xpPer: number;

const SLUG = 'alley_catgirl';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-cleanup', 'u-1');
  const cfg = app.content.tables.waifuProgression;
  costPer = cfg.essenceInvestment.essenceCost;
  xpPer = cfg.essenceInvestment.xpGranted;
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
      gifts: app.gifts,
      session: app.session,
    },
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ essence: costPer * 500 })
    .where(eq(playerCurrencies.playerId, prov.playerId));
  harness.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += app.collection.waifuXpToNext(l);
  return total;
}

async function grantAt(level: number, xpOffset = 0): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, SLUG));
  const [row] = await t.db
    .insert(playerWaifus)
    .values({ playerId: prov.playerId, speciesId: sp!.id, level, xp: xpForLevel(level) + xpOffset })
    .returning();
  return row!.id;
}

/** One application short of level 10 — the first authored milestone. */
const justBeforeFirstUnlock = () => grantAt(9, xpForLevel(10) - xpForLevel(9) - xpPer);

function fakeInteraction(kind: 'command' | 'button' | 'select', values: string[] = []) {
  const state = { replied: false, deferred: false };
  return {
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isModalSubmit: () => false,
    values,
    reply: vi.fn(async () => {
      state.replied = true;
    }),
    editReply: vi.fn(async () => {
      state.replied = true;
    }),
    update: vi.fn(async () => {
      state.replied = true;
    }),
    followUp: vi.fn(async () => ({ id: `m-follow-${Math.random()}` })),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => {}),
    message: { id: 'm-1' },
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-cleanup',
  };
}

/** Let every scheduled cleanup fire. */
async function runAllCleanup(): Promise<void> {
  await vi.advanceTimersByTimeAsync(EPHEMERAL_UNLOCK_TOAST_TTL_MS + 1000);
}

describe('appearance unlock toasts', () => {
  it('are scheduled for cleanup, one delete per toast', async () => {
    const waifuId = await justBeforeFirstUnlock();
    const i = fakeInteraction('button');

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    const followUps = i.followUp.mock.calls.length;
    expect(followUps).toBeGreaterThan(0);
    expect(i.deleteReply).not.toHaveBeenCalled();

    await runAllCleanup();
    // Level-up note + unlock toast: every follow-up this flow made is cleaned.
    expect(i.deleteReply.mock.calls.length).toBe(followUps);
  });

  it('survive past the confirmation window — the buttons stay usable', async () => {
    const waifuId = await justBeforeFirstUnlock();
    const i = fakeInteraction('button');

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    // At the confirm TTL the level note is gone but the toast is not.
    await vi.advanceTimersByTimeAsync(EPHEMERAL_CONFIRM_TTL_MS + 1000);
    const afterConfirmWindow = i.deleteReply.mock.calls.length;
    await runAllCleanup();

    expect(afterConfirmWindow).toBe(1);
    expect(i.deleteReply.mock.calls.length).toBe(2);
  });

  it('schedule cleanup for every toast in a multi-unlock batch', async () => {
    // Landing on 30 reports 10, 20 and 30 — three toasts plus the level note.
    const waifuId = await grantAt(29, xpForLevel(30) - xpForLevel(29) - xpPer * 5);
    const i = fakeInteraction('button');

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '5']);
    const followUps = i.followUp.mock.calls.length;
    expect(followUps).toBe(4);

    await runAllCleanup();
    expect(i.deleteReply.mock.calls.length).toBe(4);
  });
});

describe('active UI is never deleted', () => {
  it('leaves the collection list alone', async () => {
    await grantAt(5);
    const i = fakeInteraction('command');

    await handleCollection(ctx, i as never, prov);
    await runAllCleanup();

    expect(i.reply).toHaveBeenCalled();
    expect(i.deleteReply).not.toHaveBeenCalled();
  });

  it('leaves the inspect card alone', async () => {
    const waifuId = await grantAt(5);
    const i = fakeInteraction('select', [`single:${waifuId}`]);

    await handleCollectionPickGroup(ctx, i as never, prov);
    await runAllCleanup();

    expect(i.update).toHaveBeenCalled();
    expect(i.deleteReply).not.toHaveBeenCalled();
  });

  it('leaves the inspect card up after an Essence spend that unlocks nothing', async () => {
    // The card is repainted via update(); only the follow-up note is transient.
    const waifuId = await grantAt(1, xpForLevel(2) - xpPer);
    const i = fakeInteraction('button');

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    await runAllCleanup();

    // Exactly one delete — the level-up note. The card itself was painted with
    // editReply/update and is never targeted.
    expect(i.deleteReply.mock.calls.length).toBe(1);
    expect(i.deleteReply).toHaveBeenCalledWith(expect.stringContaining('m-follow-'));
  });
});

describe('public Waifumon Log', () => {
  it('is posted through the channel, never scheduled for interaction cleanup', async () => {
    const waifuId = await justBeforeFirstUnlock();
    const i = fakeInteraction('button');

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    const publicLines = harness.lines.filter((l) => l.text.includes('unlocked a new look'));
    expect(publicLines).toHaveLength(1);

    await runAllCleanup();

    // Log posts survive: they are channel messages with no interaction token,
    // and every delete this flow issued targeted an ephemeral follow-up id.
    expect(harness.lines).toHaveLength(publicLines.length);
    for (const call of i.deleteReply.mock.calls as unknown as any[][]) {
      expect(String(call[0])).toContain('m-follow-');
    }
  });
});

describe('failures never reach gameplay', () => {
  it('a delete that throws does not surface to the player', async () => {
    const waifuId = await justBeforeFirstUnlock();
    const i = fakeInteraction('button');
    i.deleteReply.mockRejectedValue(new Error('discord is down') as never);

    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    await runAllCleanup();

    // The spend still landed and the screens were painted.
    const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
    expect(row!.level).toBeGreaterThanOrEqual(10);
    expect(i.deleteReply).toHaveBeenCalled();
  });
});
