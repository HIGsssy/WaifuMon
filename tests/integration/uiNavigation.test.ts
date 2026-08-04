/**
 * Handler navigation tests (ephemeral UI model).
 *
 * Slash commands reply ephemerally; component clicks call
 * `interaction.update()` so the player's private view is replaced in place
 * rather than stacking follow-ups. Nothing on this path touches the channel.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  handleDaily,
  handleInventory,
  handleMenu,
  handleProfile,
  handleShop,
} from '../../src/discord/commands/waifumon';
import { bootstrapApp, provisionPlayer, type App, createEventHarness, type EventHarness } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { waifumonSessions } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-ui-nav', 'u-1');
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
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      effects: app.effects,
      itemUse: app.itemUse,
      session: app.session,
    },
  };
});
afterAll(async () => {
  await t.cleanup();
});

interface FakeChannel {
  id: string;
  send: ReturnType<typeof vi.fn>;
  messages: { edit: ReturnType<typeof vi.fn> };
}

function fakeChannel(id = 'c-1'): FakeChannel {
  return {
    id,
    send: vi.fn(async () => ({ id: `m-${id}` })),
    messages: { edit: vi.fn(async () => undefined) },
  };
}

interface FakeInteraction {
  isChatInputCommand: () => boolean;
  isButton: () => boolean;
  isStringSelectMenu: () => boolean;
  isModalSubmit: () => boolean;
  replied: boolean;
  deferred: boolean;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  deferUpdate: ReturnType<typeof vi.fn>;
  channel: FakeChannel;
  channelId: string;
  user: { id: string; displayName: string };
  guildId: string;
  message?: { id: string };
}

function fakeButtonOn(messageId: string, channel = fakeChannel()): FakeInteraction {
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
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-ui-nav',
    message: { id: messageId },
  };
}

function fakeCommand(channel = fakeChannel()): FakeInteraction {
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
    channel,
    channelId: channel.id,
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-ui-nav',
  };
}

async function currentSession() {
  const [row] = await t.db
    .select()
    .from(waifumonSessions)
    .where(eq(waifumonSessions.playerId, prov.playerId))
    .limit(1);
  return row;
}

describe('ephemeral navigation: slash replies privately, buttons update in place', () => {
  it('slash /waifumon menu replies ephemerally and never touches the channel', async () => {
    const cmd = fakeCommand();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);
    expect(cmd.reply).toHaveBeenCalledOnce();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(cmd.channel.send).not.toHaveBeenCalled();
    expect(cmd.channel.messages.edit).not.toHaveBeenCalled();
    // No board id is recorded — the session row is only a daily tally now.
    const session = await currentSession();
    expect(session?.messageId ?? null).toBeNull();
  });

  it('profile button on the session message updates the ephemeral view (no new send, no follow-up)', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.reply).not.toHaveBeenCalled();
    expect(btn.followUp).not.toHaveBeenCalled();
  });

  it('inventory button updates the ephemeral view in place', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleInventory(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
  });

  it('shop button updates the ephemeral view in place', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShop(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
  });

  it('daily claim button updates the ephemeral view in place', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleDaily(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
  });

  it('menu back button repaints the menu without stacking', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
  });
});
