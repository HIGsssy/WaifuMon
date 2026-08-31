/**
 * Ephemeral gameplay UI (phase 2 of the Gameplay UX Redesign).
 *
 * These replace the Rev 4 "public session board" tests. The model they pin:
 *   - `/waifumon` and every gameplay screen answer *ephemerally* — nothing is
 *     written to the channel.
 *   - Button/select navigation uses `interaction.update()`, replacing the
 *     previous ephemeral in place rather than stacking messages.
 *   - Embeds carry no owner decoration (no "Hunter: @mention" line, no
 *     "only X can use these controls" footer) — ephemeral views are private
 *     by construction, so identity plumbing is redundant.
 *   - There is no session-ownership rejection any more: a foreign user
 *     cannot see, let alone click, someone else's ephemeral controls.
 *   - The daily "Today" summary tally and the SR+ rare-capture threshold are
 *     unchanged by the redesign.
 *   - PlayChannelGuard still runs before provisioning and before any handler.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import {
  handleDaily,
  handleInventory,
  handleMenu,
  handleProfile,
  handleShop,
  pickMainMenuFlavor,
} from '../../src/discord/commands/waifumon';
import { handleHunt } from '../../src/discord/commands/waifumonHunt';
import { rarityAtLeast } from '../../src/modules/capture/captureMath';
import { renderSummaryLines } from '../../src/modules/session/sessionService';
import { createDispatcher } from '../../src/discord/commandRegistry';
import {
  bootstrapApp,
  provisionPlayer,
  type App,
  createEventHarness,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { encounters, players, waifumonSessions } from '../../src/db/schema';
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
}

interface FakeChannel {
  id: string;
  send: ReturnType<typeof vi.fn>;
  messages: { edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}

function fakeChannel(id = CHANNEL_ID): FakeChannel {
  return {
    id,
    send: vi.fn(async () => ({ id: `m-${id}-${Math.random().toString(36).slice(2, 8)}` })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
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
  user: { id: string; displayName: string; username: string; globalName: string | null };
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

function fakeButton(
  userId = USER_ID,
  channel = fakeChannel(),
  opts: { username?: string; globalName?: string | null; memberNick?: string | null } = {},
): FakeCommand & { message: { id: string } } {
  const btn = fakeCommand(userId, channel, opts) as FakeCommand & { message: { id: string } };
  btn.isChatInputCommand = () => false;
  btn.isButton = () => true;
  btn.message = { id: 'm-ephemeral' };
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

/** Embed JSON out of whichever response spy the handler used. */
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
  return embed.toJSON() as ReturnType<typeof firstEmbedJson>;
}

describe('ephemeral gameplay — /waifumon never writes to the channel', () => {
  it('handleMenu on a slash command replies ephemerally and sends nothing publicly', async () => {
    const cmd = fakeCommand();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);

    expect(cmd.reply).toHaveBeenCalledOnce();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number; embeds?: unknown[] };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);
    expect(cmd.channel.send).not.toHaveBeenCalled();
    expect(cmd.channel.messages.edit).not.toHaveBeenCalled();
  });

  it('a second /waifumon is still ephemeral — no public message is ever created', async () => {
    const cmd = fakeCommand(USER_ID, fakeChannel(CHANNEL_ID));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, prov);

    expect(cmd.reply).toHaveBeenCalledOnce();
    expect(cmd.channel.send).not.toHaveBeenCalled();
    const session = await currentSession();
    // Gameplay records no message id — the column is Care-Mode-only now.
    expect(session?.profileMessageId ?? null).toBeNull();
  });

  it('hunt from a slash command answers ephemerally', async () => {
    await app.currency.setHuntEnergy(t.db, prov.playerId, app.content.tables.energy.baseMax);
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, prov.playerId));
    const cmd = fakeCommand();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, cmd as any, prov);

    expect(cmd.reply).toHaveBeenCalled();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(cmd.channel.send).not.toHaveBeenCalled();
  });
});

describe('ephemeral gameplay — button navigation updates in place', () => {
  it('menu → profile uses interaction.update, not a channel edit or send', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);

    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.reply).not.toHaveBeenCalled();
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
  });

  it('shop, inventory and daily buttons all update the same ephemeral in place', async () => {
    for (const handler of [handleShop, handleInventory, handleDaily]) {
      const btn = fakeButton();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(ctx, btn as any, prov);
      expect(btn.update).toHaveBeenCalledOnce();
      expect(btn.channel.send).not.toHaveBeenCalled();
      expect(btn.channel.messages.edit).not.toHaveBeenCalled();
    }
  });

  it('hunt from a button updates in place and never posts publicly', async () => {
    await app.currency.setHuntEnergy(t.db, prov.playerId, app.content.tables.energy.baseMax);
    await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, prov.playerId));
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, prov);

    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
  });
});

describe('ephemeral gameplay — no owner decoration', () => {
  it('the menu embed carries no hunter line, author label, or control-ownership footer', async () => {
    const p = await provisionPlayer(app, 'g-owner-1', 'u-owner-1');
    const cmd = fakeCommand('u-owner-1', fakeChannel('c-owner-1'), {
      memberNick: 'IanServerNick',
      username: 'ian',
      globalName: 'Ian Global',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, p);

    const embed = firstEmbedJson(cmd.reply);
    expect(embed.title).toBe('💖 Waifumon');
    expect(embed.author).toBeUndefined();
    expect(embed.description ?? '').not.toContain('Hunter:');
    expect(embed.description ?? '').not.toContain('<@u-owner-1>');
    expect(embed.footer?.text ?? '').not.toContain('can use these controls');
  });

  it('other screens (profile, inventory, shop) are equally undecorated', async () => {
    const p = await provisionPlayer(app, 'g-owner-1', 'u-owner-2');
    for (const handler of [handleProfile, handleInventory, handleShop]) {
      const cmd = fakeCommand('u-owner-2', fakeChannel('c-owner-2'), { memberNick: 'Nickie' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(ctx, cmd as any, p);
      const embed = firstEmbedJson(cmd.reply);
      expect(embed.author).toBeUndefined();
      expect(embed.footer?.text ?? '').not.toContain('can use these controls');
      expect(embed.description ?? '').not.toContain('**Hunter:**');
    }
  });

  it('the profile screen still names the player in its own title', async () => {
    const p = await provisionPlayer(app, 'g-owner-1', 'u-owner-3');
    const cmd = fakeCommand('u-owner-3', fakeChannel('c-owner-3'), { memberNick: 'Selene' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, cmd as any, p);
    expect(firstEmbedJson(cmd.reply).title).toContain('Selene');
  });
});

describe('ephemeral gameplay — encounters stay private', () => {
  it('an encounter is revealed ephemerally and writes nothing to the channel', async () => {
    const p = await provisionPlayer(app, GUILD_ID, 'u-capture-1');
    await app.currency.setHuntEnergy(t.db, p.playerId, app.content.tables.energy.baseMax);
    const cmd = fakeCommand('u-capture-1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, cmd as any, p);

    expect(cmd.channel.send).not.toHaveBeenCalled();
    // The encounter row exists, but nothing about it is public: the
    // public_message_id column that used to carry the edit-in-place capture
    // message was dropped in migration 0013.
    expect(cmd.reply).toHaveBeenCalled();
  });
});

describe('daily summary tally — unchanged by the redesign', () => {
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

  it('a hunt still increments the summary counter', async () => {
    const before = await currentSession();
    const beforeHunts = before ? app.session.readSummary(before).hunts : 0;

    await app.currency.setHuntEnergy(t.db, prov.playerId, app.content.tables.energy.baseMax);
    await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
    // Clear the per-player hunt cooldown left by the navigation tests above.
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, prov.playerId));
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, prov);

    const after = await currentSession();
    expect(app.session.readSummary(after!).hunts).toBe(beforeHunts + 1);
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

describe('dispatcher — no session-ownership gate remains', () => {
  it('a component click is routed straight to its handler (Discord already scopes ephemerals)', async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      lookupAllowlist: async () => null,
      provision: async (guildId, userId) => {
        const g = await app.guilds.ensureGuild(guildId);
        const p = await app.players.ensurePlayer(g.id, userId);
        return { guildDbId: g.id, playerId: p.id };
      },
      commandHandlers: {},
      componentHandlers: { 'menu:profile': handler },
      extractChannelInfo: () => ({
        isGuildChannel: true,
        channelId: CHANNEL_ID,
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
      message: { id: 'm-whatever' },
      guildId: GUILD_ID,
      user: { id: USER_ID },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(btn as any);

    expect(handler).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('PlayChannelGuard still runs first', () => {
  it('a click in a channel off the guild allowlist never creates a session row', async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createDispatcher({
      logger: t.logger,
      // Access control is retained: an allowlist that this channel is not on.
      lookupAllowlist: async () => ['some-allowed-channel'],
      provision: async () => ({ guildDbId: 999, playerId: 999 }),
      commandHandlers: { 'waifumon:menu': handler },
      componentHandlers: {},
      extractChannelInfo: () => ({
        isGuildChannel: true,
        channelId: 'c-off-allowlist',
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
      options: { getSubcommandGroup: () => null, getSubcommand: () => 'menu' },
      guildId: GUILD_ID,
      user: { id: USER_ID },
      reply,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatch(cmd as any);

    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    const [row] = await t.db
      .select()
      .from(waifumonSessions)
      .where(eq(waifumonSessions.channelId, 'c-off-allowlist'))
      .limit(1);
    expect(row).toBeUndefined();
  });
});

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
    expect((ctx.content.tables.uiFlavor?.mainMenu ?? []).length).toBeGreaterThan(0);
  });

  it('handleMenu renders one flavor line in the ephemeral description', async () => {
    const p = await provisionPlayer(app, 'g-owner-1', 'u-flavor-1');
    const cmd = fakeCommand('u-flavor-1', fakeChannel('c-flavor-1'), { memberNick: 'Flavius' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, cmd as any, p);

    const embed = firstEmbedJson(cmd.reply);
    const pool = ctx.content.tables.uiFlavor?.mainMenu ?? [];
    expect(pool.some((line) => embed.description?.includes(line))).toBe(true);
  });
});

describe('hunt validation failures keep navigation alive', () => {
  interface UpdatePayload {
    content?: string;
    embeds?: unknown[];
    components?: { toJSON(): { components: Array<{ custom_id?: string }> } }[];
  }
  function customIds(payload: UpdatePayload): string[] {
    return (payload.components ?? []).flatMap((row) =>
      row.toJSON().components.map((c) => c.custom_id ?? ''),
    );
  }

  it('insufficient energy shows the correct message with a Back button and does not consume energy', async () => {
    const p = await provisionPlayer(app, 'g-hunt-nav-1', 'u-hunt-nav-1');
    await app.currency.setHuntEnergy(t.db, p.playerId, 0);
    await t.db.delete(encounters).where(eq(encounters.playerId, p.playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, p.playerId));

    const btn = fakeButton('u-hunt-nav-1', fakeChannel('c-hunt-nav-1'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, p);

    expect(btn.update).toHaveBeenCalledOnce();
    const payload = btn.update.mock.calls[0]![0] as UpdatePayload;
    expect(payload.content).toContain("out of Hunt Energy");
    expect(customIds(payload)).toContain('wm|v1|menu|back');
    // No public post, no channel edit — dead-end recovery would have used those.
    expect(btn.channel.send).not.toHaveBeenCalled();
    expect(btn.channel.messages.edit).not.toHaveBeenCalled();
    // No state mutation: energy still zero, no encounter row created.
    expect((await app.currency.getBalances(p.playerId)).huntEnergy).toBe(0);
    const rows = await t.db.select().from(encounters).where(eq(encounters.playerId, p.playerId));
    expect(rows).toHaveLength(0);
  });

  it('hunt cooldown shows the correct message with a Back button and does not consume energy', async () => {
    const p = await provisionPlayer(app, 'g-hunt-nav-2', 'u-hunt-nav-2');
    const startingEnergy = app.content.tables.energy.baseMax;
    await app.currency.setHuntEnergy(t.db, p.playerId, startingEnergy);
    await t.db.delete(encounters).where(eq(encounters.playerId, p.playerId));
    // Cooldown is active when lastHuntAt is recent.
    await t.db.update(players).set({ lastHuntAt: new Date() }).where(eq(players.id, p.playerId));

    const btn = fakeButton('u-hunt-nav-2', fakeChannel('c-hunt-nav-2'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, p);

    expect(btn.update).toHaveBeenCalledOnce();
    const payload = btn.update.mock.calls[0]![0] as UpdatePayload;
    expect(payload.content).toContain('Slow down');
    expect(customIds(payload)).toContain('wm|v1|menu|back');
    expect(btn.channel.send).not.toHaveBeenCalled();
    // No state mutation.
    expect((await app.currency.getBalances(p.playerId)).huntEnergy).toBe(startingEnergy);
    const rows = await t.db.select().from(encounters).where(eq(encounters.playerId, p.playerId));
    expect(rows).toHaveLength(0);
  });

  it('pressing Back after a validation failure restores the main Waifumon menu via the shared handler', async () => {
    const p = await provisionPlayer(app, 'g-hunt-nav-3', 'u-hunt-nav-3');
    await app.currency.setHuntEnergy(t.db, p.playerId, 0);
    await t.db.delete(encounters).where(eq(encounters.playerId, p.playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, p.playerId));

    const failBtn = fakeButton('u-hunt-nav-3', fakeChannel('c-hunt-nav-3'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, failBtn as any, p);

    // The Back button published on the error screen is the shared menu:back
    // control. Clicking it is dispatched to handleMenu (see client.ts wiring).
    const backBtn = fakeButton('u-hunt-nav-3', fakeChannel('c-hunt-nav-3'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, backBtn as any, p);

    expect(backBtn.update).toHaveBeenCalledOnce();
    const payload = backBtn.update.mock.calls[0]![0] as { embeds: { toJSON: () => { title?: string } }[] };
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.title).toBe('💖 Waifumon');
    expect(backBtn.channel.send).not.toHaveBeenCalled();
  });

  it('a valid hunt still resolves without a Back button on the encounter reveal (unchanged behavior)', async () => {
    const p = await provisionPlayer(app, 'g-hunt-nav-4', 'u-hunt-nav-4');
    await app.currency.setHuntEnergy(t.db, p.playerId, app.content.tables.energy.baseMax);
    await t.db.delete(encounters).where(eq(encounters.playerId, p.playerId));
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, p.playerId));

    const btn = fakeButton('u-hunt-nav-4', fakeChannel('c-hunt-nav-4'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleHunt(ctx, btn as any, p);

    expect(btn.update).toHaveBeenCalledOnce();
    // Energy was actually spent — no validation short-circuit ran.
    expect((await app.currency.getBalances(p.playerId)).huntEnergy).toBeLessThan(
      app.content.tables.energy.baseMax,
    );
  });
});
