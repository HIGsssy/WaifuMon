/**
 * Trainer Profile lifecycle (phase 3 of the Gameplay UX Redesign).
 *
 * The Trainer Profile is the only message Waifumon posts to the play channel
 * on a player's behalf. These run the real Discord handlers against a real
 * Postgres and a real event bus, with only the Discord channel faked, and pin
 * the create / edit / remove contract:
 *
 *   create — `channel.send`, previous profile deleted first, id stored.
 *   edit   — `channel.messages.edit(id, …)`, never a send, id unchanged.
 *   remove — `channel.messages.delete(id)` and the column cleared.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encounters,
  playerCurrencies,
  playerWaifus,
  players,
  species,
  waifumonSessions,
} from '../../src/db/schema';
import { handleCareLeave, handleCareStart, handleMenu } from '../../src/discord/commands/waifumon';
import { handleHunt } from '../../src/discord/commands/waifumonHunt';
import {
  createTrainerProfileService,
  type ProfileChannel,
  type TrainerProfileService,
} from '../../src/discord/trainerProfile';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import { buildGameEvent, gameEvent } from '../../src/modules/events/gameEvents';
import type { GameEventDescriptor, GameEventSource } from '../../src/modules/events/gameEvents';
import {
  bootstrapApp,
  createEventHarness,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let ctx: AppContext;
let prov: Provisioned;
let profile: TrainerProfileService;

const GUILD_ID = 'g-profile';
const USER_ID = 'u-profile';
const CHANNEL_ID = 'c-profile';
const PLAYER_NAME = 'Whistler';

/** Fake play channel recording every send / edit / delete in call order. */
interface FakeProfileChannel extends ProfileChannel {
  send: ReturnType<typeof vi.fn>;
  messages: {
    edit: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  /** Interleaved log so ordering assertions are exact. */
  calls: string[];
}

let channel: FakeProfileChannel;
let nextMessageId = 0;

function makeChannel(): FakeProfileChannel {
  const calls: string[] = [];
  const ch = {
    id: CHANNEL_ID,
    calls,
    send: vi.fn(async () => {
      const id = `m-profile-${++nextMessageId}`;
      calls.push(`send:${id}`);
      return { id };
    }),
    messages: {
      edit: vi.fn(async (messageId: string) => {
        calls.push(`edit:${messageId}`);
        return undefined;
      }),
      delete: vi.fn(async (messageId: string) => {
        calls.push(`delete:${messageId}`);
        return undefined;
      }),
    },
  } as unknown as FakeProfileChannel;
  return ch;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, GUILD_ID, USER_ID);
  channel = makeChannel();
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
  };
  profile = createTrainerProfileService({
    logger: t.logger,
    services: ctx.services,
    // Always hand back the live fake so a test can swap its behaviour.
    resolveChannel: async (id) => (id === CHANNEL_ID ? channel : null),
  });
  profile.subscribe(harness.bus);
});
afterAll(async () => {
  await t.cleanup();
});

function fakeInteraction(): PlayerInteraction {
  return {
    isChatInputCommand: () => true,
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
    deferReply: vi.fn(async () => {}),
    channel: { id: CHANNEL_ID, send: vi.fn(), messages: { edit: vi.fn() } },
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID, username: PLAYER_NAME, globalName: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SOURCE = (): GameEventSource => ({
  guildId: GUILD_ID,
  guildDbId: prov.guildDbId,
  playerId: prov.playerId,
  playerName: PLAYER_NAME,
  playerMention: `<@${USER_ID}>`,
  channelId: CHANNEL_ID,
});

/** Push one event straight at the subscriber (bypassing the handlers). */
async function emit(descriptor: GameEventDescriptor): Promise<void> {
  await profile.handle(buildGameEvent(descriptor, SOURCE()));
}

async function storedProfileId(): Promise<string | null> {
  return app.session.getProfileMessageId(prov.playerId, CHANNEL_ID);
}

async function makeOwnedWaifu(): Promise<number> {
  const [row] = await t.db.select().from(species).where(eq(species.enabled, true)).limit(1);
  const waifu = await insertOwnedWaifu(t.db, { playerId: prov.playerId, speciesId: row!.id, level: 1, xp: 0, affection: 0 });
  return waifu!.id;
}

let waifuId: number;

beforeEach(async () => {
  // Reset Discord + player state between tests.
  channel = makeChannel();
  await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
  await t.db
    .update(players)
    .set({
      lastHuntAt: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
      buddyWaifuId: null,
    })
    .where(eq(players.id, prov.playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  await t.db
    .update(waifumonSessions)
    .set({ profileMessageId: null })
    .where(eq(waifumonSessions.playerId, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, prov.playerId));

  waifuId = await makeOwnedWaifu();
  await t.db
    .update(players)
    .set({ buddyWaifuId: waifuId })
    .where(eq(players.id, prov.playerId));
  harness.huntSessions.close(prov.playerId);
  harness.reset();
});

describe('create — entering Care Mode', () => {
  it('posts the profile at the channel bottom and stores the message id', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);

    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.messages.edit).not.toHaveBeenCalled();
    const sentId = (await channel.send.mock.results[0]!.value).id as string;
    expect(await storedProfileId()).toBe(sentId);
  });

  it('renders the trainer, buddy, collection and activity blocks', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);

    const payload = channel.send.mock.calls[0]![0] as {
      embeds: { toJSON: () => { title?: string; fields?: { name: string; value: string }[]; footer?: { text?: string } } }[];
    };
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBe(`🌸 ${PLAYER_NAME}'s Trainer Profile`);
    const names = (embed.fields ?? []).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(['👤 Trainer', '⭐ Buddy', '🎒 Collection', '💗 Activity']),
    );
    expect(embed.footer?.text).toMatch(/^Trainer since /);
    const activity = (embed.fields ?? []).find((f) => f.name === '💗 Activity')!;
    expect(activity.value).toContain('Currently caring for');
    expect(activity.value).toContain('Next tick in');
  });

  it('the profile carries no interactive components — it is informational only', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const payload = channel.send.mock.calls[0]![0] as { components?: unknown[] };
    expect(payload.components ?? []).toHaveLength(0);
  });

  it('deletes the previous profile before posting a new one', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const firstId = await storedProfileId();
    channel.calls.length = 0;

    // A synthetic re-create (the future refresh hook takes this path too).
    await emit(gameEvent('TRAINER_PROFILE_REFRESH_REQUESTED', {}));

    expect(channel.calls[0]).toBe(`delete:${firstId}`);
    expect(channel.calls[1]).toMatch(/^send:/);
    expect(await storedProfileId()).not.toBe(firstId);
  });
});

describe('edit — value changes refresh in place', () => {
  it('CARE_TICK_APPLIED edits the stored message and never sends a new one', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const messageId = await storedProfileId();
    channel.send.mockClear();

    await emit(
      gameEvent('CARE_TICK_APPLIED', {
        waifuId,
        buddyName: 'Luna',
        ticksProcessed: 1,
        energyGained: 1,
        waifuXpGained: 2,
        affectionGained: 1,
      }),
    );

    expect(channel.messages.edit).toHaveBeenCalledOnce();
    expect(channel.messages.edit.mock.calls[0]![0]).toBe(messageId);
    expect(channel.send).not.toHaveBeenCalled();
    expect(await storedProfileId()).toBe(messageId);
  });

  it.each([
    ['BUDDY_LEVEL_UP', () => gameEvent('BUDDY_LEVEL_UP', { waifuId, buddyName: 'Luna', level: 2 })],
    [
      'AFFECTION_MILESTONE',
      () =>
        gameEvent('AFFECTION_MILESTONE', {
          waifuId,
          buddyName: 'Luna',
          affection: 10,
          stage: 'Acquainted',
        }),
    ],
    ['PLAYER_LEVEL_UP', () => gameEvent('PLAYER_LEVEL_UP', { level: 3, rewardLabels: [] })],
    [
      'COLLECTION_COMPLETED',
      () => gameEvent('COLLECTION_COMPLETED', { distinctSpecies: 1, totalSpecies: 1 }),
    ],
  ])('%s while in Care Mode edits in place', async (_label, build) => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const messageId = await storedProfileId();
    channel.send.mockClear();
    channel.messages.edit.mockClear();

    await emit(build());

    expect(channel.messages.edit).toHaveBeenCalledOnce();
    expect(channel.messages.edit.mock.calls[0]![0]).toBe(messageId);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('falls back to a fresh post when the stored message was deleted by hand (10008)', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const staleId = await storedProfileId();
    channel.send.mockClear();
    // discord.js throws a DiscordAPIError; the subscriber only inspects `code`.
    const unknownMessage = Object.assign(
      Object.create((await import('discord.js')).DiscordAPIError.prototype),
      { code: 10008, message: 'Unknown Message' },
    );
    channel.messages.edit.mockRejectedValueOnce(unknownMessage);

    await emit(gameEvent('PLAYER_LEVEL_UP', { level: 4, rewardLabels: [] }));

    expect(channel.send).toHaveBeenCalledOnce();
    const newId = await storedProfileId();
    expect(newId).not.toBe(staleId);
    expect(newId).toBeTruthy();
  });

  it('ignores edit-triggering events fired outside Care Mode', async () => {
    // Never entered Care Mode — nothing is stored, so nothing to refresh.
    expect(await storedProfileId()).toBeNull();

    await emit(gameEvent('PLAYER_LEVEL_UP', { level: 2, rewardLabels: [] }));

    expect(channel.messages.edit).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });
});

describe('create — changing the care target while active', () => {
  it('deletes the old profile and posts a new one at the bottom, in that order', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const firstId = await storedProfileId();
    const second = await makeOwnedWaifu();
    channel.calls.length = 0;
    harness.reset();

    // Re-target: `handleCareStart` with an explicit id while already caring.
    await handleCareStart(ctx, fakeInteraction(), prov, second);

    expect(harness.ofKind('CARE_BUDDY_CHANGED')).toHaveLength(1);
    expect(channel.calls).toEqual([`delete:${firstId}`, expect.stringMatching(/^send:/)]);
    const newId = await storedProfileId();
    expect(newId).not.toBe(firstId);
  });
});

describe('remove — leaving Care Mode', () => {
  it('deletes the profile and clears the stored id on a voluntary leave', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const messageId = await storedProfileId();
    channel.calls.length = 0;
    channel.send.mockClear();

    await handleCareLeave(ctx, fakeInteraction(), prov);

    expect(channel.messages.delete).toHaveBeenCalledWith(messageId);
    expect(channel.send).not.toHaveBeenCalled();
    expect(await storedProfileId()).toBeNull();
  });

  it('takes the profile down when a hunt ends Care Mode', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const messageId = await storedProfileId();
    channel.calls.length = 0;

    await handleHunt(ctx, fakeInteraction(), prov);

    expect(channel.messages.delete).toHaveBeenCalledWith(messageId);
    expect(await storedProfileId()).toBeNull();
  });

  it('takes the profile down when the care target is released underneath (auto-stop)', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    const messageId = await storedProfileId();
    channel.calls.length = 0;
    harness.reset();

    // Soft-release the waifu the player is caring for; the next lazy tick
    // self-heals Care Mode and the profile must follow it down.
    await t.db
      .update(playerWaifus)
      .set({ releasedAt: new Date() })
      .where(eq(playerWaifus.id, waifuId));

    await handleMenu(ctx, fakeInteraction(), prov);

    const left = harness.ofKind('PLAYER_LEFT_CARE');
    expect(left).toHaveLength(1);
    expect(left[0]!.payload.reason).toBe('auto_stop');
    expect(channel.messages.delete).toHaveBeenCalledWith(messageId);
    expect(await storedProfileId()).toBeNull();
  });

  it('clears the pointer even when the delete fails, so no stale message is edited', async () => {
    await handleCareStart(ctx, fakeInteraction(), prov);
    channel.messages.delete.mockRejectedValueOnce(new Error('missing permissions'));

    await handleCareLeave(ctx, fakeInteraction(), prov);

    expect(await storedProfileId()).toBeNull();
  });
});

describe('subscriber isolation', () => {
  it('a Discord failure in the profile never fails the gameplay call', async () => {
    channel.send.mockRejectedValue(new Error('channel is on fire'));

    await expect(handleCareStart(ctx, fakeInteraction(), prov)).resolves.toBeUndefined();
    // Care Mode itself committed regardless of the failed post.
    expect((await app.care.getState(prov.playerId)).active).toBe(true);
  });

  it('does nothing when the play channel cannot be resolved', async () => {
    const orphan = createTrainerProfileService({
      logger: t.logger,
      services: ctx.services,
      resolveChannel: async () => null,
    });
    await expect(
      orphan.handle(buildGameEvent(gameEvent('PLAYER_ENTERED_CARE', { waifuId, buddyName: 'Luna' }), SOURCE())),
    ).resolves.toBeUndefined();
    expect(await storedProfileId()).toBeNull();
  });
});
