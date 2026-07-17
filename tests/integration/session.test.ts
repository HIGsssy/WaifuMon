/**
 * Session-board tests (Rev 4 UI model).
 *
 * These verify the "one public session message per player per channel" model:
 *   - /waifumon posts a public message and stores its id on the session row.
 *   - subsequent buttons on that message edit it in place (no new message).
 *   - N/R captures do not fire a separate rare announcement.
 *   - SR+ captures do fire exactly one separate rare announcement.
 *   - wrong-user clicks are rejected ephemerally without mutating state.
 *   - the daily summary tracks hunts/captures/escapes.
 *   - PlayChannelGuard still blocks before any session row is created.
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
import {
  handleEncounterCharm,
  handleHunt,
} from '../../src/discord/commands/waifumonHunt';
import { rarityAtLeast } from '../../src/modules/capture/captureMath';
import { renderSummaryLines } from '../../src/modules/session/sessionService';
import { createDispatcher } from '../../src/discord/commandRegistry';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { encounters, waifumonSessions } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

let t: TestDb;
let app: App;
let prov: Provisioned;
let ctx: AppContext;

const CHANNEL_ID = 'c-session-1';
const USER_ID = 'u-session-1';
const GUILD_ID = 'g-session-1';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  prov = await provisionPlayer(app, GUILD_ID, USER_ID);
  ctx = buildCtx();
});
afterAll(async () => {
  await t.cleanup();
});

function buildCtx(): AppContext {
  return {
    config: {
      assetsDir: process.cwd(),
      contentDir: process.cwd(),
      dailyTimezone: 'UTC',
      discordToken: 'x',
      discordClientId: 'x',
      discordGuildId: undefined,
      databaseUrl: 'postgres://x',
      logLevel: 'info',
    },
    logger: t.logger,
    db: t.db,
    content: app.content,
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
      progression: app.progression,
      session: app.session,
    },
  };
}

interface FakeChannel {
  id: string;
  send: ReturnType<typeof vi.fn>;
  messages: { edit: ReturnType<typeof vi.fn> };
}

function fakeChannel(id = CHANNEL_ID): FakeChannel {
  return {
    id,
    send: vi.fn(async (_body: unknown) => ({ id: `m-${id}-${Math.random().toString(36).slice(2, 8)}` })),
    messages: { edit: vi.fn(async () => undefined) },
  };
}

interface FakeCommand {
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
  deferReply: ReturnType<typeof vi.fn>;
  channel: FakeChannel;
  channelId: string;
  user: { id: string; displayName: string };
  guildId: string;
}

function fakeCommand(userId = USER_ID, channel = fakeChannel()): FakeCommand {
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
    channel,
    channelId: channel.id,
    user: { id: userId, displayName: 'Hunter' },
    guildId: GUILD_ID,
  };
}

function fakeButtonOnMessage(
  messageId: string,
  userId = USER_ID,
  channel = fakeChannel(),
): FakeCommand & { message: { id: string } } {
  const btn = fakeCommand(userId, channel) as unknown as FakeCommand & { message: { id: string } };
  btn.isChatInputCommand = () => false;
  btn.isButton = () => true;
  btn.message = { id: messageId };
  return btn;
}

async function currentSession() {
  const [row] = await t.db
    .select()
    .from(waifumonSessions)
    .where(eq(waifumonSessions.playerId, prov.playerId))
    .limit(1);
  return row;
}

describe('session board — /waifumon posts a public message', () => {
  it('handleMenu on a fresh slash command channel.sends the board and stores message_id', async () => {
    const cmd = fakeCommand();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);
    expect(cmd.channel.send).toHaveBeenCalledOnce();
    // The command itself is acknowledged ephemerally (no public reply).
    expect(cmd.reply).toHaveBeenCalledOnce();
    const replyPayload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(replyPayload.flags).toBe(MessageFlags.Ephemeral);
    const session = await currentSession();
    expect(session?.messageId).toBeTruthy();
    expect(session?.channelId).toBe(CHANNEL_ID);
    expect(session?.playerId).toBe(prov.playerId);
  });

  it('a second /waifumon in the same channel edits the existing message instead of sending a new one', async () => {
    const before = await currentSession();
    const priorMessageId = before?.messageId;
    const cmd = fakeCommand(USER_ID, fakeChannel(CHANNEL_ID));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);
    expect(cmd.channel.messages.edit).toHaveBeenCalledOnce();
    expect(cmd.channel.send).not.toHaveBeenCalled();
    const after = await currentSession();
    expect(after?.messageId).toBe(priorMessageId);
  });
});

describe('session board — buttons on the board edit it in place', () => {
  it('menu → profile button updates the same message (interaction.update, no new send)', async () => {
    const session = await currentSession();
    const messageId = session!.messageId!;
    const btn = fakeButtonOnMessage(messageId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
  });

  it('shop, inventory, daily buttons all update the session message in place', async () => {
    const session = await currentSession();
    const messageId = session!.messageId!;
    for (const handler of [handleShop, handleInventory, handleDaily]) {
      const btn = fakeButtonOnMessage(messageId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(ctx, btn as any, prov);
      expect(btn.update).toHaveBeenCalledOnce();
      expect(btn.channel.send).not.toHaveBeenCalled();
    }
  });
});

describe('session summary — daily activity tracked and rendered', () => {
  it('renderSummaryLines produces a concise "Today" block', () => {
    const lines = renderSummaryLines({
      hunts: 3,
      caught: 2,
      escaped: 1,
      srPlus: 1,
      levelUps: 0,
      caughtNames: ['Alley Catgirl', 'Café Maid'],
      escapedNames: ['Crimson Oni Bride'],
      notableFinds: [{ kind: 'waifubux', label: '+50 WB' }],
      buddyXp: 0,
      buddyAffection: 0,
    });
    expect(lines[0]).toContain('3 hunts');
    expect(lines[0]).toContain('2 caught');
    expect(lines[0]).toContain('1 escaped');
    expect(lines[0]).toContain('1 SR+');
    expect(lines.some((l) => l.includes('Alley Catgirl'))).toBe(true);
    expect(lines.some((l) => l.includes('Crimson Oni Bride'))).toBe(true);
  });

  it('a hunt updates the summary counter', async () => {
    const before = await currentSession();
    const beforeSummary = app.session.readSummary(before!);
    const beforeHunts = beforeSummary.hunts;

    // Grant energy directly so the hunt succeeds without a daily claim.
    await app.currency.setHuntEnergy(t.db, prov.playerId, app.content.tables.energy.baseMax);
    const session = await currentSession();
    const messageId = session!.messageId!;
    const btn = fakeButtonOnMessage(messageId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, prov);
    const after = await currentSession();
    const afterSummary = app.session.readSummary(after!);
    expect(afterSummary.hunts).toBe(beforeHunts + 1);
  });
});

describe('capture announcements — SR+ only', () => {
  it.each([
    ['N', false],
    ['R', false],
    ['SR', true],
    ['SSR', true],
    ['UR', true],
    ['LR', true],
  ] as const)('rarity %s → shipped config announces = %s', (rarity, expected) => {
    const config = app.content.tables.capture;
    expect(rarityAtLeast(rarity, config.announceMinRarity)).toBe(expected);
  });
});

describe('session-owner check — dispatcher rejects foreign clicks', () => {
  it('another user clicking the session controls is denied ephemerally without invoking the handler', async () => {
    const session = await currentSession();
    const messageId = session!.messageId!;

    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async (guildId, userId) => {
        const g = await app.guilds.ensureGuild(guildId);
        const p = await app.players.ensurePlayer(g.id, userId);
        return { guildDbId: g.id, playerId: p.id };
      },
      lookupSessionOwner: async (mid) => {
        const s = await app.session.findByMessageId(mid);
        if (!s) return null;
        const player = await app.players.getById(s.playerId);
        return player ? { playerId: s.playerId, discordUserId: player.discordUserId } : null;
      },
      commandHandlers: {},
      componentHandlers: {
        'menu:profile': handler,
      },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: CHANNEL_ID,
        parentChannelId: null,
      }),
    });

    // Simulate a foreign user clicking Profile on the session message.
    const reply = vi.fn(async () => {});
    const foreignBtn = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      customId: 'wm|v1|menu|profile',
      message: { id: messageId },
      guildId: GUILD_ID,
      user: { id: 'u-foreigner' },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(foreignBtn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/session/i);
    expect(payload.content).toMatch(USER_ID);
  });

  it('clicks on a message with no session get a "run /waifumon" ephemeral', async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async (guildId, userId) => {
        const g = await app.guilds.ensureGuild(guildId);
        const p = await app.players.ensurePlayer(g.id, userId);
        return { guildDbId: g.id, playerId: p.id };
      },
      lookupSessionOwner: async () => null,
      commandHandlers: {},
      componentHandlers: {
        'menu:profile': handler,
      },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: CHANNEL_ID,
        parentChannelId: null,
      }),
    });

    const reply = vi.fn(async () => {});
    const orphanBtn = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      customId: 'wm|v1|menu|profile',
      message: { id: 'm-orphan' },
      guildId: GUILD_ID,
      user: { id: USER_ID },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(orphanBtn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/no longer active|run.*waifumon/i);
  });
});

describe('PlayChannelGuard still runs first', () => {
  it('a click in a non-NSFW channel never creates a session row', async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async () => ({ guildDbId: 999, playerId: 999 }),
      lookupSessionOwner: async () => null,
      commandHandlers: { 'waifumon:menu': handler },
      componentHandlers: {},
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: false,
        channelId: 'c-not-nsfw',
        parentChannelId: null,
      }),
    });
    const reply = vi.fn(async () => {});
    const cmd = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      commandName: 'waifumon',
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => 'menu',
      },
      guildId: GUILD_ID,
      user: { id: USER_ID },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(cmd as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    // And critically — no session row was created for a blocked channel.
    const [row] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.channelId, 'c-not-nsfw'))
      .limit(1);
    expect(row).toBeUndefined();
  });
});

describe('capture flow — no per-attempt public message', () => {
  it('encounter card is painted onto the session board, not sent separately', async () => {
    // Fresh player to keep summary tidy for this test.
    const prov2 = await provisionPlayer(app, GUILD_ID, 'u-capture-1');
    await app.currency.setHuntEnergy(t.db, prov2.playerId, app.content.tables.energy.baseMax);
    // Open a session for prov2 first.
    const cmd = fakeCommand('u-capture-1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov2);
    // Now do a hunt via the menu button.
    const [sessRow] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.playerId, prov2.playerId))
      .limit(1);
    const msgId = sessRow!.messageId!;
    const btn = fakeButtonOnMessage(msgId, 'u-capture-1', cmd.channel);
    // Reset send spy: we only care that the hunt click itself doesn't fire
    // a *new* public message. (The initial /waifumon menu already sent one.)
    cmd.channel.send.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, prov2);
    // Whether it was an encounter or a non-encounter, no new public message
    // may have been sent — everything painted onto the existing board.
    expect(btn.channel.send).not.toHaveBeenCalled();
    // Encounters (if any) do NOT populate encounters.publicMessageId anymore;
    // the session board is the single public surface.
    const [active] = await t.db
      .select()
      .from(encounters)
      .where(eq(encounters.playerId, prov2.playerId))
      .limit(1);
    if (active) {
      expect(active.publicMessageId).toBeNull();
    }
  });
});
