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
import { EmbedBuilder, MessageFlags } from 'discord.js';
import {
  handleDaily,
  handleInventory,
  handleMenu,
  handleProfile,
  handleShop,
  pickMainMenuFlavor,
} from '../../src/discord/commands/waifumon';
import {
  handleEncounterCharm,
  handleHunt,
} from '../../src/discord/commands/waifumonHunt';
import { rarityAtLeast } from '../../src/modules/capture/captureMath';
import { renderSummaryLines } from '../../src/modules/session/sessionService';
import { createDispatcher } from '../../src/discord/commandRegistry';
import { bootstrapApp, provisionPlayer, type App, createEventHarness, type EventHarness } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { encounters, waifumonSessions } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;

const CHANNEL_ID = 'c-session-1';
const USER_ID = 'u-session-1';
const GUILD_ID = 'g-session-1';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
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
  user: {
    id: string;
    displayName: string;
    username: string;
    globalName: string | null;
  };
  member?: { displayName: string };
  guildId: string;
}

function fakeCommand(
  userId = USER_ID,
  channel = fakeChannel(),
  opts: { username?: string; globalName?: string | null; memberNick?: string | null } = {},
): FakeCommand {
  const username = opts.username ?? 'Hunter';
  const cmd: FakeCommand = {
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
    user: {
      id: userId,
      displayName: username,
      username,
      globalName: opts.globalName ?? null,
    },
    guildId: GUILD_ID,
  };
  if (opts.memberNick) cmd.member = { displayName: opts.memberNick };
  return cmd;
}

function fakeButtonOnMessage(
  messageId: string,
  userId = USER_ID,
  channel = fakeChannel(),
  opts: { username?: string; globalName?: string | null; memberNick?: string | null } = {},
): FakeCommand & { message: { id: string } } {
  const btn = fakeCommand(userId, channel, opts) as unknown as FakeCommand & {
    message: { id: string };
  };
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

// ─────────────────────────── owner identity + flavor ───────────────────────────

const OWNER_USER_ID = 'u-owner-1';
const OWNER_GUILD_ID = 'g-owner-1';
const OWNER_CHANNEL_ID = 'c-owner-1';

/** Extract the first embed rendered by a send/edit/update spy, as a JSON object. */
function firstEmbedJson(spy: ReturnType<typeof vi.fn>): {
  author?: { name?: string };
  title?: string;
  description?: string;
  footer?: { text?: string };
  fields?: { name: string; value: string }[];
} {
  const call = spy.mock.calls[0];
  if (!call) throw new Error('spy was not called');
  const payload = call[0] as { embeds: { toJSON: () => unknown }[] };
  const embed = payload.embeds[0];
  if (!embed) throw new Error('payload had no embeds');
  return embed.toJSON() as {
    author?: { name?: string };
    title?: string;
    description?: string;
    footer?: { text?: string };
    fields?: { name: string; value: string }[];
  };
}

describe('public session board — owner identity', () => {
  it('handleMenu decorates the session-board embed with owner label, hunter line, and control footer', async () => {
    // Fresh player so we own a brand-new session row.
    const prov3 = await provisionPlayer(app, OWNER_GUILD_ID, OWNER_USER_ID);
    const cmd = fakeCommand(OWNER_USER_ID, fakeChannel(OWNER_CHANNEL_ID), {
      memberNick: 'IanServerNick',
      username: 'ian',
      globalName: 'Ian Global',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov3);

    const embed = firstEmbedJson(cmd.channel.send);
    // Author line carries the guild display name (nickname wins).
    expect(embed.author?.name).toContain('IanServerNick');
    // "Hunter: <@id>" prefix in the description.
    expect(embed.description).toMatch(/\*\*Hunter:\*\*\s*<@u-owner-1>/);
    // Footer mentions the owner + how to start your own session.
    expect(embed.footer?.text).toContain('IanServerNick');
    expect(embed.footer?.text).toMatch(/only.*can use these controls/i);
    expect(embed.footer?.text).toMatch(/\/waifumon/);
  });

  it('stores the display name on the session row so foreign-click copy can name the owner', async () => {
    const [row] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.playerId, (await currentSessionForUser(OWNER_USER_ID))!.playerId))
      .limit(1);
    expect(row?.ownerDisplayName).toBe('IanServerNick');
  });

  it('falls back to globalName when no member is present, still decorating the board', async () => {
    const prov4 = await provisionPlayer(app, OWNER_GUILD_ID, 'u-owner-2');
    const cmd = fakeCommand('u-owner-2', fakeChannel('c-owner-2'), {
      username: 'iris',
      globalName: 'Iris Global',
      memberNick: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov4);
    const embed = firstEmbedJson(cmd.channel.send);
    expect(embed.author?.name).toContain('Iris Global');
    expect(embed.footer?.text).toContain('Iris Global');
  });

  it('falls back to username when no globalName is present', async () => {
    const prov5 = await provisionPlayer(app, OWNER_GUILD_ID, 'u-owner-3');
    const cmd = fakeCommand('u-owner-3', fakeChannel('c-owner-3'), {
      username: 'callie',
      globalName: null,
      memberNick: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov5);
    const embed = firstEmbedJson(cmd.channel.send);
    expect(embed.author?.name).toContain('callie');
    expect(embed.footer?.text).toContain('callie');
  });

  it('other session-board screens (profile, inventory, shop) also carry owner identity', async () => {
    const prov6 = await provisionPlayer(app, OWNER_GUILD_ID, 'u-owner-4');
    const channel = fakeChannel('c-owner-4');
    // Open the session first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-owner-4', channel, { memberNick: 'ScreenNick' }) as any, prov6);
    const [session] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.playerId, prov6.playerId))
      .limit(1);
    const msgId = session!.messageId!;
    for (const handler of [handleProfile, handleInventory, handleShop]) {
      const btn = fakeButtonOnMessage(msgId, 'u-owner-4', channel, { memberNick: 'ScreenNick' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(ctx, btn as any, prov6);
      const embed = firstEmbedJson(btn.update);
      expect(embed.author?.name).toContain('ScreenNick');
      expect(embed.footer?.text).toContain('ScreenNick');
      expect(embed.footer?.text).toMatch(/only.*can use these controls/i);
    }
  });
});

describe('wrong-user rejection copy — uses stored display name when present', () => {
  it('rejection names the owner by their cached display name', async () => {
    // Session for OWNER_USER_ID with owner display name already stored.
    const [session] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.playerId, (await currentSessionForUser(OWNER_USER_ID))!.playerId))
      .limit(1);
    expect(session?.ownerDisplayName).toBe('IanServerNick');

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
        return player
          ? {
              playerId: s.playerId,
              discordUserId: player.discordUserId,
              displayName: s.ownerDisplayName ?? null,
            }
          : null;
      },
      commandHandlers: {},
      componentHandlers: {
        'menu:profile': handler,
      },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: OWNER_CHANNEL_ID,
        parentChannelId: null,
      }),
    });

    const reply = vi.fn(async () => {});
    const foreignBtn = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      customId: 'wm|v1|menu|profile',
      message: { id: session!.messageId! },
      guildId: OWNER_GUILD_ID,
      user: { id: 'u-lurker' },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(foreignBtn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toContain('IanServerNick');
    // Still mentions the owner id somewhere for click-through.
    expect(payload.content).toContain(OWNER_USER_ID);
    expect(payload.content).toMatch(/\/waifumon/);
  });
});

async function currentSessionForUser(discordUserId: string) {
  const guildRow = await app.guilds.getByDiscordId(OWNER_GUILD_ID);
  if (!guildRow) return null;
  const playerId = await app.players.findPlayerId(OWNER_GUILD_ID, discordUserId);
  if (playerId == null) return null;
  const [row] = await t.db
    .select()
    .from(waifumonSessions)
    .where(eq(waifumonSessions.playerId, playerId))
    .limit(1);
  return row ? { ...row, playerId } : null;
}

// ─────────────────────────────── main-menu flavor ───────────────────────────────

describe('main menu flavor text', () => {
  it('pickMainMenuFlavor picks from the pool with a seeded RNG', () => {
    const pool = ['first', 'second', 'third'];
    expect(pickMainMenuFlavor(pool, () => 0)).toBe('first');
    expect(pickMainMenuFlavor(pool, () => 0.5)).toBe('second');
    expect(pickMainMenuFlavor(pool, () => 0.99)).toBe('third');
  });

  it('pickMainMenuFlavor returns a safe default when the pool is empty or undefined', () => {
    const empty = pickMainMenuFlavor([], () => 0);
    const missing = pickMainMenuFlavor(undefined, () => 0);
    expect(empty.length).toBeGreaterThan(0);
    expect(missing.length).toBeGreaterThan(0);
    expect(empty).toBe(missing);
  });

  it('shipped content includes a non-empty mainMenu flavor pool', () => {
    const pool = ctx.content.tables.uiFlavor?.mainMenu ?? [];
    expect(pool.length).toBeGreaterThan(0);
  });

  it('handleMenu renders one flavor line in the board description', async () => {
    const prov7 = await provisionPlayer(app, OWNER_GUILD_ID, 'u-flavor-1');
    const cmd = fakeCommand('u-flavor-1', fakeChannel('c-flavor-1'), {
      memberNick: 'Flavius',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov7);
    const embed = firstEmbedJson(cmd.channel.send);
    const pool = ctx.content.tables.uiFlavor?.mainMenu ?? [];
    // Exactly one of the shipped flavor lines must appear in the description
    // (the description begins with "**Hunter:** ..." from decoration, then
    // "_<flavor>_" from handleMenu, then the fixed menu body).
    const found = pool.some((line) => embed.description?.includes(line));
    expect(found).toBe(true);
  });
});

// ─────────────────────────── session inactivity timeout ───────────────────────────

const TIMEOUT_GUILD_ID = 'g-timeout-1';

/** Force a session row's last activity into the distant past. */
async function ageSession(sessionId: number, minutesAgo: number): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60 * 1000);
  await t.db
    .update(waifumonSessions)
    .set({ lastActivityAt: at })
    .where(eq(waifumonSessions.id, sessionId));
}

async function sessionForPlayer(playerId: number) {
  const [row] = await t.db
    .select()
    .from(waifumonSessions)
    .where(eq(waifumonSessions.playerId, playerId))
    .limit(1);
  return row;
}

describe('session inactivity timeout — config + isExpired', () => {
  it('tables.session.inactiveTimeoutMinutes is configured and positive', () => {
    const cfg = ctx.content.tables.session;
    expect(cfg).toBeDefined();
    expect(cfg?.inactiveTimeoutMinutes).toBeGreaterThan(0);
    // Service reflects the configured minutes.
    expect(app.session.inactiveTimeoutMs).toBe(
      (cfg?.inactiveTimeoutMinutes ?? 45) * 60 * 1000,
    );
  });

  it('isExpired is false when the session has no live public message', () => {
    const fake = {
      id: 0,
      guildId: 0,
      playerId: 0,
      channelId: 'x',
      messageId: null,
      currentScreen: 'menu',
      ownerDisplayName: null,
      summaryJson: {},
      summaryDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActivityAt: new Date(Date.now() - 60 * 60 * 1000),
    } as unknown as Parameters<typeof app.session.isExpired>[0];
    expect(app.session.isExpired(fake)).toBe(false);
  });

  it('isExpired flips to true past the inactivity budget', () => {
    const timeout = app.session.inactiveTimeoutMs;
    const fresh = {
      id: 1,
      messageId: 'm-1',
      lastActivityAt: new Date(Date.now() - Math.floor(timeout / 2)),
    } as unknown as Parameters<typeof app.session.isExpired>[0];
    const stale = {
      id: 2,
      messageId: 'm-2',
      lastActivityAt: new Date(Date.now() - timeout - 60_000),
    } as unknown as Parameters<typeof app.session.isExpired>[0];
    expect(app.session.isExpired(fresh)).toBe(false);
    expect(app.session.isExpired(stale)).toBe(true);
  });
});

describe('session inactivity timeout — /waifumon slash entry', () => {
  it('reuses an existing non-expired session (edits, no new send)', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-timeout-reuse');
    const ch = fakeChannel('c-timeout-reuse');
    // Open the board.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-reuse', ch, { memberNick: 'Ru' }) as any, p);
    const before = await sessionForPlayer(p.playerId);
    const originalId = before!.messageId!;
    ch.send.mockClear();
    ch.messages.edit.mockClear();
    // Re-open on same channel — should edit the existing message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-reuse', ch, { memberNick: 'Ru' }) as any, p);
    const after = await sessionForPlayer(p.playerId);
    expect(after?.messageId).toBe(originalId);
    expect(ch.messages.edit).toHaveBeenCalled();
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('retires an expired board and posts a fresh public message', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-timeout-expire');
    const ch = fakeChannel('c-timeout-expire');
    // First open — creates the board.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-expire', ch, { memberNick: 'Xy' }) as any, p);
    const before = await sessionForPlayer(p.playerId);
    const staleId = before!.messageId!;

    // Fast-forward the row past the timeout.
    const beyond = Math.ceil(app.session.inactiveTimeoutMs / 60_000) + 1;
    await ageSession(before!.id, beyond);

    ch.send.mockClear();
    ch.messages.edit.mockClear();

    // Second open — should finalize the old message and send a NEW one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-expire', ch, { memberNick: 'Xy' }) as any, p);

    // Old message got the "Session Ended" edit with disabled components.
    expect(ch.messages.edit).toHaveBeenCalled();
    const endedCall = ch.messages.edit.mock.calls[0];
    expect(endedCall![0]).toBe(staleId);
    const endedPayload = endedCall![1] as {
      embeds: { toJSON: () => { title?: string; description?: string } }[];
      components: unknown[];
    };
    expect(endedPayload.components).toEqual([]);
    const endedEmbed = endedPayload.embeds[0]!.toJSON();
    expect(endedEmbed.title).toMatch(/session ended/i);
    expect(endedEmbed.description).toMatch(/\/waifumon/);

    // A brand-new public message was sent.
    expect(ch.send).toHaveBeenCalledOnce();

    const after = await sessionForPlayer(p.playerId);
    expect(after?.messageId).not.toBe(staleId);
    expect(after?.messageId).toBeTruthy();
  });

  it('still creates a fresh board when the old message can no longer be edited', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-timeout-missing');
    const ch = fakeChannel('c-timeout-missing');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-missing', ch, { memberNick: 'Mi' }) as any, p);
    const before = await sessionForPlayer(p.playerId);
    const staleId = before!.messageId!;
    const beyond = Math.ceil(app.session.inactiveTimeoutMs / 60_000) + 1;
    await ageSession(before!.id, beyond);

    // Simulate the old message having been deleted.
    ch.messages.edit.mockImplementationOnce(async () => {
      const err = new Error('Unknown Message') as Error & { code?: number };
      err.code = 10008;
      // discord.js throws DiscordAPIError; our missing-message check hits on code 10008.
      const { DiscordAPIError } = await import('discord.js');
      throw new DiscordAPIError(
        { message: 'Unknown Message', code: 10008 } as never,
        10008,
        404,
        'PATCH',
        `/channels/${ch.id}/messages/${staleId}`,
        { files: [] },
      );
    });

    ch.send.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-missing', ch, { memberNick: 'Mi' }) as any, p);
    // Even though the edit failed, a new board is sent and the row updated.
    expect(ch.send).toHaveBeenCalledOnce();
    const after = await sessionForPlayer(p.playerId);
    expect(after?.messageId).not.toBe(staleId);
    expect(after?.messageId).toBeTruthy();
  });
});

describe('session inactivity timeout — expired button clicks are rejected', () => {
  it('owner clicking an expired-board button is rejected ephemerally with no handler invoked', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-timeout-btn-owner');
    const ch = fakeChannel('c-timeout-btn-owner');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-timeout-btn-owner', ch, { memberNick: 'Bo' }) as any, p);
    const session = await sessionForPlayer(p.playerId);
    const staleMsg = session!.messageId!;
    const beyond = Math.ceil(app.session.inactiveTimeoutMs / 60_000) + 1;
    await ageSession(session!.id, beyond);

    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async (guildId, userId) => {
        const g = await app.guilds.ensureGuild(guildId);
        const pl = await app.players.ensurePlayer(g.id, userId);
        return { guildDbId: g.id, playerId: pl.id };
      },
      lookupSessionOwner: async (mid) => {
        const s = await app.session.findByMessageId(mid);
        if (!s) return null;
        const player = await app.players.getById(s.playerId);
        return player
          ? {
              playerId: s.playerId,
              discordUserId: player.discordUserId,
              displayName: s.ownerDisplayName ?? null,
              expired: app.session.isExpired(s),
            }
          : null;
      },
      commandHandlers: {},
      componentHandlers: { 'menu:profile': handler },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: 'c-timeout-btn-owner',
        parentChannelId: null,
      }),
    });

    const reply = vi.fn(async () => {});
    const btn = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isRepliable: () => true,
      customId: 'wm|v1|menu|profile',
      message: { id: staleMsg },
      guildId: TIMEOUT_GUILD_ID,
      user: { id: 'u-timeout-btn-owner' },
      reply,
    };
    const beforeActivity = (await sessionForPlayer(p.playerId))!.lastActivityAt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(btn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/expired/i);
    expect(payload.content).toMatch(/\/waifumon/);
    // Rejected clicks do NOT refresh last_activity_at.
    const afterActivity = (await sessionForPlayer(p.playerId))!.lastActivityAt;
    expect((afterActivity as Date).getTime()).toBe((beforeActivity as Date).getTime());
  });
});

describe('session activity tracking — bump discipline', () => {
  it('owner successful interaction refreshes last_activity_at', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-bump-owner');
    const ch = fakeChannel('c-bump-owner');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-bump-owner', ch, { memberNick: 'Bp' }) as any, p);
    const before = await sessionForPlayer(p.playerId);
    // Age it 5 minutes into the past so the next interaction produces a
    // measurable bump.
    await ageSession(before!.id, 5);
    const beforeActivity = (await sessionForPlayer(p.playerId))!.lastActivityAt;
    const btn = fakeButtonOnMessage(before!.messageId!, 'u-bump-owner', ch, {
      memberNick: 'Bp',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, p);
    const afterActivity = (await sessionForPlayer(p.playerId))!.lastActivityAt;
    expect((afterActivity as Date).getTime()).toBeGreaterThan(
      (beforeActivity as Date).getTime(),
    );
  });

  it('wrong-user rejection does NOT refresh last_activity_at', async () => {
    const p = await provisionPlayer(app, TIMEOUT_GUILD_ID, 'u-bump-owner-2');
    const ch = fakeChannel('c-bump-owner-2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-bump-owner-2', ch, { memberNick: 'Bq' }) as any, p);
    const session = await sessionForPlayer(p.playerId);
    const messageId = session!.messageId!;
    const beforeActivity = session!.lastActivityAt;

    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async (guildId, userId) => {
        const g = await app.guilds.ensureGuild(guildId);
        const pl = await app.players.ensurePlayer(g.id, userId);
        return { guildDbId: g.id, playerId: pl.id };
      },
      lookupSessionOwner: async (mid) => {
        const s = await app.session.findByMessageId(mid);
        if (!s) return null;
        const player = await app.players.getById(s.playerId);
        return player
          ? {
              playerId: s.playerId,
              discordUserId: player.discordUserId,
              displayName: s.ownerDisplayName ?? null,
              expired: app.session.isExpired(s),
            }
          : null;
      },
      commandHandlers: {},
      componentHandlers: { 'menu:profile': handler },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: 'c-bump-owner-2',
        parentChannelId: null,
      }),
    });

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
      guildId: TIMEOUT_GUILD_ID,
      user: { id: 'u-random-lurker' },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(foreignBtn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const afterActivity = (await sessionForPlayer(p.playerId))!.lastActivityAt;
    expect((afterActivity as Date).getTime()).toBe((beforeActivity as Date).getTime());
  });
});

