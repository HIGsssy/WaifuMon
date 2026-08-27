/**
 * Care Mode entry sweeps the player's tracked ephemerals.
 *
 * Entering Care Mode posts the Trainer Profile, which becomes the thing the
 * player is meant to look at. Everything Waifumon stacked above it — the
 * collection card, an inspect screen, unlock toasts, confirmations — is then
 * clutter, so entry is the moment to clear what we can still reach.
 *
 * What is asserted here is deliberately bounded by what Discord permits: only
 * handles this process still holds, still inside the 15-minute interaction
 * token window. Public messages (the Trainer Profile, the Waifumon Log) have
 * no interaction token and are never touched.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';
import { handleCareStart } from '../../src/discord/commands/waifumon';
import { createTrainerProfileService } from '../../src/discord/trainerProfile';
import {
  INTERACTION_TOKEN_LIFETIME_MS,
  createEphemeralRegistry,
  registerEphemeral,
} from '../../src/discord/ephemeralCleanup';
import { playerWaifus, species } from '../../src/db/schema';
import type { AppContext, PlayerInteraction, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const GUILD_ID = 'g-care-sweep';
const USER_ID = 'u-1';
const CHANNEL_ID = 'c-play';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;
let channel: { id: string; send: ReturnType<typeof vi.fn>; messages: Record<string, any> };
let nextMessageId = 0;

function makeChannel() {
  return {
    id: CHANNEL_ID,
    send: vi.fn(async () => ({ id: `m-profile-${++nextMessageId}` })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
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
    ephemerals: createEphemeralRegistry(),
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
  } as unknown as AppContext;

  // A real Trainer Profile subscriber, so `getProfileMessageId` is populated
  // exactly as it is in production — that is the gate the sweep waits on.
  createTrainerProfileService({
    logger: t.logger,
    services: ctx.services,
    resolveChannel: async (id: string) => (id === CHANNEL_ID ? (channel as never) : null),
  }).subscribe(harness.bus);
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await app.care.leave(prov.playerId).catch(() => undefined);
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  harness.reset();
  channel.send.mockClear();
  channel.messages.delete.mockClear();
  channel.messages.edit.mockClear();
  // Clear the stored profile pointer, or a previous test's id would satisfy
  // the "was the profile posted?" gate on its own.
  await app.session.setProfileMessageId(prov.guildDbId, prov.playerId, CHANNEL_ID, null);
  // Fresh registry per test so handle counts are unambiguous.
  (ctx as { ephemerals: ReturnType<typeof createEphemeralRegistry> }).ephemerals =
    createEphemeralRegistry();
});

async function grantBuddy(): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, 'neko_barista'));
  const row = await insertOwnedWaifu(t.db, { playerId: prov.playerId, speciesId: sp!.id, level: 5 });
  await app.collection.setBuddy(prov.playerId, row!.id);
  return row!.id;
}

/** A tracked ephemeral from some earlier interaction. */
function trackPrior(label: string, opts: { now?: number; fail?: unknown } = {}) {
  const interaction = {
    id: `i-${label}`,
    deleteReply: vi.fn(async () => {
      if (opts.fail) throw opts.fail;
      return undefined;
    }),
  };
  registerEphemeral(ctx, interaction, {
    playerId: prov.playerId,
    label,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return interaction;
}

function careInteraction(): PlayerInteraction {
  return {
    id: 'i-care',
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => ({ id: 'm-care-note' })),
    deferUpdate: vi.fn(async () => {}),
    deleteReply: vi.fn(async () => undefined),
    options: { getString: () => null },
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    user: { id: USER_ID, username: 'Hunter' },
    member: { displayName: 'Whistler' },
  } as unknown as PlayerInteraction;
}

async function enterCare(interaction = careInteraction()): Promise<PlayerInteraction> {
  await handleCareStart(ctx, interaction, prov);
  return interaction;
}

describe('care entry sweeps tracked ephemerals', () => {
  it('deletes a tracked confirmation', async () => {
    await grantBuddy();
    const confirmation = trackPrior('nickname-set');

    await enterCare();

    expect(confirmation.deleteReply).toHaveBeenCalledTimes(1);
    expect((await app.care.getState(prov.playerId)).active).toBe(true);
  });

  it('deletes every tracked unlock toast follow-up', async () => {
    await grantBuddy();
    const toasts = [
      trackPrior('appearance-unlock-toast'),
      trackPrior('appearance-unlock-toast'),
      trackPrior('appearance-unlock-overflow'),
    ];

    await enterCare();

    for (const toast of toasts) expect(toast.deleteReply).toHaveBeenCalledTimes(1);
  });

  it('deletes the tracked collection and inspect screens', async () => {
    await grantBuddy();
    const list = trackPrior('collection-list');
    const card = trackPrior('inspect-card');

    await enterCare();

    expect(list.deleteReply).toHaveBeenCalledTimes(1);
    expect(card.deleteReply).toHaveBeenCalledTimes(1);
    expect(ctx.ephemerals!.size(prov.playerId)).toBe(0);
  });

  it('spares the care interaction’s own messages', async () => {
    await grantBuddy();
    // Something registered under the *current* interaction id, as the care
    // flow's own menu repaint would be.
    const own = trackPrior('care-menu');
    Object.defineProperty(own, 'id', { value: 'i-care' });
    ctx.ephemerals!.take(prov.playerId); // clear, then re-register with the right id
    registerEphemeral(ctx, { id: 'i-care', deleteReply: own.deleteReply }, {
      playerId: prov.playerId,
      label: 'care-menu',
    });
    const prior = trackPrior('collection-list');

    await enterCare();

    expect(prior.deleteReply).toHaveBeenCalledTimes(1);
    expect(own.deleteReply).not.toHaveBeenCalled();
  });
});

describe('what survives', () => {
  it('leaves the newly posted Trainer Profile alone', async () => {
    await grantBuddy();
    trackPrior('collection-list');

    await enterCare();

    // Posted once, and the message the player is now looking at is still there
    // — it is a channel message, so no ephemeral sweep can reach it.
    expect(channel.send).toHaveBeenCalledTimes(1);
    const profileId = await app.session.getProfileMessageId(prov.playerId, CHANNEL_ID);
    expect(profileId).not.toBeNull();
    const deletedIds = (channel.messages.delete.mock.calls as unknown as any[][]).map(
      (c) => c[0],
    );
    expect(deletedIds).not.toContain(profileId);
  });

  it('leaves public Waifumon Log lines alone', async () => {
    await grantBuddy();
    trackPrior('collection-list');

    await enterCare();

    // The care-entry narration is a channel post and is unaffected by a sweep
    // that can only reach interaction responses.
    expect(harness.lines.length).toBeGreaterThan(0);
    expect(harness.ofKind('PLAYER_ENTERED_CARE')).toHaveLength(1);
  });
});

describe('best-effort behaviour', () => {
  it('ignores and discards expired handles without attempting a delete', async () => {
    await grantBuddy();
    const stale = trackPrior('collection-list', {
      now: Date.now() - INTERACTION_TOKEN_LIFETIME_MS - 1,
    });

    await enterCare();

    expect(stale.deleteReply).not.toHaveBeenCalled();
    expect(ctx.ephemerals!.size(prov.playerId)).toBe(0);
  });

  it('ignores Unknown Message', async () => {
    await grantBuddy();
    const gone = trackPrior('inspect-card', {
      fail: new DiscordAPIError({ code: 10008, message: 'gone' }, 10008, 404, 'DELETE', 'u', {}),
    });

    await enterCare();

    expect(gone.deleteReply).toHaveBeenCalledTimes(1);
    expect((await app.care.getState(prov.playerId)).active).toBe(true);
  });

  it('a failing delete does not stop care mode or the other deletes', async () => {
    await grantBuddy();
    const broken = trackPrior('inspect-card', { fail: new Error('discord down') });
    const fine = trackPrior('collection-list');

    await enterCare();

    expect(broken.deleteReply).toHaveBeenCalledTimes(1);
    expect(fine.deleteReply).toHaveBeenCalledTimes(1);
    expect((await app.care.getState(prov.playerId)).active).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('does not sweep when the Trainer Profile could not be posted', async () => {
    await grantBuddy();
    channel.send.mockRejectedValueOnce(new Error('missing permissions') as never);
    const prior = trackPrior('collection-list');

    await enterCare();

    // No profile on screen means the player would be left with nothing, so the
    // clutter stays. Care Mode itself still started.
    expect(prior.deleteReply).not.toHaveBeenCalled();
    expect((await app.care.getState(prov.playerId)).active).toBe(true);
  });
});
