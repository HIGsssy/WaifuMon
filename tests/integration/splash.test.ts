/**
 * Daily launch splash tests.
 *
 * Verifies that the first `/waifumon` of the guild day paints a splash
 * screen onto the public session board, records the view, and — on
 * subsequent invocations that same day — routes directly to the main menu
 * without stacking a second embed. Also covers the Start Hunt button,
 * disabled-splash config, wrong-user rejection, expired-session rejection,
 * and text-only fallback when the configured image is missing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { MessageFlags } from 'discord.js';
import {
  buildSplashView,
  handleMenu,
  handleMenuStart,
} from '../../src/discord/commands/waifumon';
import { createDispatcher } from '../../src/discord/commandRegistry';
import { playerDailySplashViews, waifumonSessions } from '../../src/db/schema';
import { claimDateInTimezone } from '../../src/shared/time';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';

let t: TestDb;
let app: App;
let ctx: AppContext;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { splashEnabled: true });
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

function fakeChannel(id: string): FakeChannel {
  return {
    id,
    send: vi.fn(async () => ({ id: `m-${id}-${Math.random().toString(36).slice(2, 8)}` })),
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
  channel: FakeChannel;
  channelId: string;
  user: { id: string; username: string; globalName: string | null };
  member?: { displayName: string };
  guildId: string;
}

function fakeCommand(userId: string, guildId: string, channel: FakeChannel, nick = 'Splasher'): FakeCommand {
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
    user: { id: userId, username: 'hunter', globalName: null },
    member: { displayName: nick },
    guildId,
  };
}

function fakeButtonOnMessage(
  messageId: string,
  userId: string,
  guildId: string,
  channel: FakeChannel,
  nick = 'Splasher',
): FakeCommand & { message: { id: string } } {
  const btn = fakeCommand(userId, guildId, channel, nick) as unknown as FakeCommand & {
    message: { id: string };
  };
  btn.isChatInputCommand = () => false;
  btn.isButton = () => true;
  return Object.assign(btn, { message: { id: messageId } });
}

async function currentSession(playerId: number) {
  const [row] = await t.db
    .select()
    .from(waifumonSessions)
    .where(eq(waifumonSessions.playerId, playerId))
    .limit(1);
  return row;
}

async function splashRowCount(playerId: number, day: string) {
  const rows = await t.db
    .select()
    .from(playerDailySplashViews)
    .where(eq(playerDailySplashViews.playerId, playerId));
  return rows.filter((r) => String(r.splashDate).slice(0, 10) === day).length;
}

describe('daily launch splash — first /waifumon of the day', () => {
  it('renders the splash embed on the first launch and records the view', async () => {
    const prov = await provisionPlayer(app, 'g-splash-1', 'u-splash-1');
    const channel = fakeChannel('c-splash-1');
    const cmd = fakeCommand('u-splash-1', 'g-splash-1', channel);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);

    // A public message was sent (splash lives on the session board).
    expect(channel.send).toHaveBeenCalledOnce();
    const payload = channel.send.mock.calls[0]![0] as {
      embeds: { toJSON: () => { title?: string; description?: string } }[];
      components: unknown[];
    };
    const embed = payload.embeds[0]!.toJSON();
    // Splash title comes from config.
    expect(embed.title).toContain(app.content.tables.uiSplash!.title);
    // Splash body lines all appear in the description.
    for (const line of app.content.tables.uiSplash!.body as string[]) {
      expect(embed.description).toContain(line);
    }
    // Exactly one action row with a Start Hunt-style button.
    expect(payload.components).toHaveLength(1);

    // Splash view marker was recorded.
    const today = claimDateInTimezone(new Date(), 'UTC');
    expect(await splashRowCount(prov.playerId, today)).toBe(1);
  });

  it('the second /waifumon on the same day skips the splash and paints the main menu', async () => {
    const prov = await provisionPlayer(app, 'g-splash-2', 'u-splash-2');
    const channel = fakeChannel('c-splash-2');
    // First launch — splash renders.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-splash-2', 'g-splash-2', channel) as any, prov);
    // Second launch — same channel — should edit the same message into the menu.
    channel.send.mockClear();
    channel.messages.edit.mockClear();
    const cmd2 = fakeCommand('u-splash-2', 'g-splash-2', channel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd2 as any, prov);
    expect(channel.messages.edit).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    const editPayload = channel.messages.edit.mock.calls[0]![1] as {
      embeds: { toJSON: () => { title?: string } }[];
    };
    // Main menu title is "💖 Waifumon"; splash title is "🎴 Welcome to Waifumon".
    expect(editPayload.embeds[0]!.toJSON().title).toContain('Waifumon');
    expect(editPayload.embeds[0]!.toJSON().title).not.toContain(
      app.content.tables.uiSplash!.title,
    );
  });

  it('splash tracking is idempotent — repeated marks do not add duplicate rows', async () => {
    const prov = await provisionPlayer(app, 'g-splash-3', 'u-splash-3');
    const today = claimDateInTimezone(new Date(), 'UTC');
    const first = await app.session.markSplashShown(prov.playerId);
    const second = await app.session.markSplashShown(prov.playerId);
    const third = await app.session.markSplashShown(prov.playerId);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(await splashRowCount(prov.playerId, today)).toBe(1);
  });

  it('a new guild day renders the splash again', async () => {
    const prov = await provisionPlayer(app, 'g-splash-4', 'u-splash-4');
    // Mark today shown, then simulate "yesterday" by inserting the row for
    // a past date and clearing today's row (if any).
    const today = claimDateInTimezone(new Date(), 'UTC');
    // Force-mark yesterday only.
    const yesterday = claimDateInTimezone(new Date(Date.now() - 25 * 60 * 60 * 1000), 'UTC');
    await t.db.insert(playerDailySplashViews).values({
      playerId: prov.playerId,
      splashDate: yesterday,
    });
    // Today is not marked, so hasSeenSplashToday should be false.
    expect(await app.session.hasSeenSplashToday(prov.playerId)).toBe(false);
    // Trigger /waifumon — splash should render and mark today.
    const channel = fakeChannel('c-splash-4');
    const cmd = fakeCommand('u-splash-4', 'g-splash-4', channel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);
    expect(await splashRowCount(prov.playerId, today)).toBe(1);
    expect(await app.session.hasSeenSplashToday(prov.playerId)).toBe(true);
  });

  it('splash tracking uses the same claim-date timezone as daily claims', async () => {
    const prov = await provisionPlayer(app, 'g-splash-5', 'u-splash-5');
    const today = claimDateInTimezone(new Date(), 'UTC');
    await app.session.markSplashShown(prov.playerId);
    const [row] = await t.db
      .select()
      .from(playerDailySplashViews)
      .where(eq(playerDailySplashViews.playerId, prov.playerId));
    expect(String(row!.splashDate).slice(0, 10)).toBe(today);
  });

  it('splash decorates the board with owner identity', async () => {
    const prov = await provisionPlayer(app, 'g-splash-6', 'u-splash-6');
    const channel = fakeChannel('c-splash-6');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-splash-6', 'g-splash-6', channel, 'SplashOwner') as any, prov);
    const payload = channel.send.mock.calls[0]![0] as {
      embeds: { toJSON: () => { author?: { name?: string }; description?: string; footer?: { text?: string } } }[];
    };
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.author?.name).toContain('SplashOwner');
    expect(embed.description).toMatch(/\*\*Hunter:\*\*\s*<@u-splash-6>/);
    expect(embed.footer?.text).toMatch(/only.*can use these controls/i);
  });
});

describe('Start Hunt button — edits the same session message into the main menu', () => {
  it('press Start Hunt: same message id, no new send, splash → menu transition', async () => {
    const prov = await provisionPlayer(app, 'g-splash-start', 'u-splash-start');
    const channel = fakeChannel('c-splash-start');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-splash-start', 'g-splash-start', channel) as any, prov);
    const beforeSession = await currentSession(prov.playerId);
    const msgId = beforeSession!.messageId!;
    channel.send.mockClear();
    channel.messages.edit.mockClear();

    const btn = fakeButtonOnMessage(msgId, 'u-splash-start', 'g-splash-start', channel);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenuStart(ctx, btn as any, prov);

    // The button flow calls interaction.update — not channel.send.
    expect(btn.update).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.messages.edit).not.toHaveBeenCalled();
    const after = await currentSession(prov.playerId);
    // Same session message id — no new public message was created.
    expect(after?.messageId).toBe(msgId);

    // The updated embed is the main menu (not splash).
    const updatePayload = btn.update.mock.calls[0]![0] as {
      embeds: { toJSON: () => { title?: string } }[];
    };
    const title = updatePayload.embeds[0]!.toJSON().title!;
    expect(title).not.toContain(app.content.tables.uiSplash!.title);
  });
});

describe('disabled splash config — /waifumon goes directly to the main menu', () => {
  let app2: App;
  let ctx2: AppContext;
  let t2: TestDb;
  beforeAll(async () => {
    t2 = await createTestDb();
    app2 = await bootstrapApp(t2, { splashEnabled: false });
    ctx2 = {
      ...ctx,
      db: t2.db,
      logger: t2.logger,
      content: app2.content,
      services: {
        guilds: app2.guilds,
        players: app2.players,
        currency: app2.currency,
        inventory: app2.inventory,
        daily: app2.daily,
        shop: app2.shop,
        hunt: app2.hunt,
        capture: app2.capture,
        collection: app2.collection,
        care: app2.care,
        progression: app2.progression,
        quests: app2.quests,
        effects: app2.effects,
        itemUse: app2.itemUse,
        session: app2.session,
      },
    };
  });
  afterAll(async () => {
    await t2.cleanup();
  });

  it('renders the main menu on first /waifumon and does not record a splash view', async () => {
    const prov = await provisionPlayer(app2, 'g-splash-off', 'u-splash-off');
    const channel = fakeChannel('c-splash-off');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx2, fakeCommand('u-splash-off', 'g-splash-off', channel) as any, prov);
    const payload = channel.send.mock.calls[0]![0] as {
      embeds: { toJSON: () => { title?: string } }[];
    };
    const title = payload.embeds[0]!.toJSON().title!;
    // Main menu title.
    expect(title).toBe('💖 Waifumon');
    const today = claimDateInTimezone(new Date(), 'UTC');
    const rows = await t2.db
      .select()
      .from(playerDailySplashViews)
      .where(eq(playerDailySplashViews.playerId, prov.playerId));
    expect(rows.filter((r) => String(r.splashDate).slice(0, 10) === today)).toHaveLength(0);
  });
});

describe('buildSplashView — image fallback', () => {
  it('renders text-only when the configured image path is missing', () => {
    const splashCfg = app.content.tables.uiSplash!;
    // Force a bogus image path — the shipped default (`ui/splash.png`) does
    // not exist in the repo's assets/ folder, but be explicit here.
    const bogus = { ...splashCfg, imagePath: 'ui/definitely-missing.png' };
    const view = buildSplashView(ctx, bogus);
    expect(view.files).toHaveLength(0);
    const embedJson = view.embed.toJSON();
    // No image field when the attachment couldn't be attached.
    expect(embedJson.image).toBeUndefined();
    // Body text still rendered.
    for (const line of splashCfg.body as string[]) {
      expect(embedJson.description).toContain(line);
    }
  });

  it('renders text-only when imagePath is null (unconfigured)', () => {
    const splashCfg = app.content.tables.uiSplash!;
    const noImg = { ...splashCfg, imagePath: null };
    const view = buildSplashView(ctx, noImg);
    expect(view.files).toHaveLength(0);
    expect(view.embed.toJSON().image).toBeUndefined();
  });
});

describe('splash button — wrong-user + expired-session rejection use existing dispatcher paths', () => {
  it('foreign user pressing Start Hunt is denied ephemerally and no handler runs', async () => {
    // Own the session via a first splash render.
    const prov = await provisionPlayer(app, 'g-splash-wrong', 'u-splash-wrong');
    const channel = fakeChannel('c-splash-wrong');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-splash-wrong', 'g-splash-wrong', channel) as any, prov);
    const session = await currentSession(prov.playerId);
    const msgId = session!.messageId!;

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
      componentHandlers: { 'menu:start': handler },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: 'c-splash-wrong',
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
      customId: 'wm|v1|menu|start',
      message: { id: msgId },
      guildId: 'g-splash-wrong',
      user: { id: 'u-lurker' },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(btn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/session/i);
  });

  it('expired-session Start Hunt is rejected and does not mutate state', async () => {
    const prov = await provisionPlayer(app, 'g-splash-exp', 'u-splash-exp');
    const channel = fakeChannel('c-splash-exp');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, fakeCommand('u-splash-exp', 'g-splash-exp', channel) as any, prov);
    const session = await currentSession(prov.playerId);
    const msgId = session!.messageId!;
    // Age it past the timeout.
    const beyondMs = app.session.inactiveTimeoutMs + 60_000;
    const staleAt = new Date(Date.now() - beyondMs);
    await t.db
      .update(waifumonSessions)
      .set({ lastActivityAt: staleAt })
      .where(eq(waifumonSessions.id, session!.id));
    const beforeActivity = (await currentSession(prov.playerId))!.lastActivityAt;

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
              expired: app.session.isExpired(s),
            }
          : null;
      },
      commandHandlers: {},
      componentHandlers: { 'menu:start': handler },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        isNsfw: true,
        channelId: 'c-splash-exp',
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
      customId: 'wm|v1|menu|start',
      message: { id: msgId },
      guildId: 'g-splash-exp',
      user: { id: 'u-splash-exp' },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(btn as any);
    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const payload = (reply.mock.calls[0] as unknown as [{ content: string; flags?: number }])[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.content).toMatch(/expired/i);
    const afterActivity = (await currentSession(prov.playerId))!.lastActivityAt;
    expect((afterActivity as Date).getTime()).toBe((beforeActivity as Date).getTime());
  });
});
