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
  handleShopConvert,
  handleShopExchange,
} from '../../src/discord/commands/waifumon';
import { bootstrapApp, provisionPlayer, type App, createEventHarness, type EventHarness } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { items, waifumonSessions } from '../../src/db/schema';
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
    // Gameplay records no message id — the column is Care-Mode-only now.
    const session = await currentSession();
    expect(session?.profileMessageId ?? null).toBeNull();
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

// Pull the button custom ids / labels / disabled flags out of whatever payload
// a handler last painted, whether it replied or updated in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paintedButtons(payload: any): { customId: string; label: string; disabled: boolean }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = payload?.components ?? [];
  return rows.flatMap((row) => {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (json.components ?? []).map((c: any) => ({
      customId: c.custom_id ?? '',
      label: c.label ?? '',
      disabled: c.disabled ?? false,
    }));
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paintedEmbed(payload: any): { title?: string; fieldCount: number } {
  const embed = payload?.embeds?.[0];
  const json = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  return { title: json?.title, fieldCount: json?.fields?.length ?? 0 };
}

async function ownedOf(playerId: number, slug: string): Promise<number> {
  const [item] = await t.db.select().from(items).where(eq(items.slug, slug));
  return app.inventory.getQuantity(playerId, item!.id);
}

async function grantCharm(playerId: number, slug: string, quantity: number): Promise<void> {
  const [item] = await t.db.select().from(items).where(eq(items.slug, slug));
  await app.inventory.addItem(t.db, playerId, item!.id, quantity);
}

describe('charm exchange: shop sub-menu navigation and conversion', () => {
  it('the main Shop shows one Charm Exchange button and no individual conversion buttons', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShop(ctx, btn as any, prov);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);

    const exchange = buttons.filter((b) => b.customId === 'wm|v1|shop|exchange');
    expect(exchange).toHaveLength(1);
    expect(exchange[0]!.label).toContain('Charm Exchange');

    // The recipe buttons never leak onto the main Shop screen.
    expect(buttons.some((b) => b.customId.startsWith('wm|v1|shop|convert'))).toBe(false);
  });

  it('pressing Charm Exchange opens the exchange screen with the three recipes', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopExchange(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();

    const payload = btn.update.mock.calls[0]![0];
    expect(paintedEmbed(payload).title).toBe('✨ Charm Exchange');
    // One embed field per recipe.
    expect(paintedEmbed(payload).fieldCount).toBe(3);

    const buttons = paintedButtons(payload);
    for (const id of ['basic_silk', 'silk_velvet', 'velvet_prismatic']) {
      expect(buttons.some((b) => b.customId === `wm|v1|shop|convert|${id}|one`)).toBe(true);
      expect(buttons.some((b) => b.customId === `wm|v1|shop|convert|${id}|max`)).toBe(true);
    }
  });

  it('disables the conversion buttons for a recipe the player cannot afford', async () => {
    const fresh = await provisionPlayer(app, 'g-ui-nav', 'u-exch-empty');
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopExchange(ctx, btn as any, fresh);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);
    const basicButtons = buttons.filter((b) => b.customId.startsWith('wm|v1|shop|convert|basic_silk'));
    expect(basicButtons).toHaveLength(2);
    expect(basicButtons.every((b) => b.disabled)).toBe(true);
  });

  it('Convert Max re-renders the Charm Exchange screen with updated quantities and a confirmation', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-exch-convert');
    await grantCharm(player.playerId, 'basic_charm', 47);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopConvert(ctx, btn as any, player, 'basic_silk', 'max');
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();

    const payload = btn.update.mock.calls[0]![0];
    // Stayed on the exchange screen.
    expect(paintedEmbed(payload).title).toBe('✨ Charm Exchange');
    const embedJson = payload.embeds[0].toJSON();
    expect(embedJson.description as string).toContain(
      'Converted 40 Basic Charms into 4 Silk Charms',
    );
    // 40 consumed of 47 → 7 left; 4 silk granted (shown in the recipe rows).
    const fieldText = (embedJson.fields ?? []).map((f: { value: string }) => f.value).join('\n');
    expect(fieldText).toContain('You have: 7 Basic Charms');

    expect(await ownedOf(player.playerId, 'silk_charm')).toBe(4);
  });

  it('a failed conversion (double click) keeps the player on the exchange with an error', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-exch-fail');
    // No charms granted — the conversion cannot succeed.
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopConvert(ctx, btn as any, player, 'basic_silk', 'one');
    expect(btn.update).toHaveBeenCalledOnce();

    const payload = btn.update.mock.calls[0]![0];
    expect(paintedEmbed(payload).title).toBe('✨ Charm Exchange');
    expect(payload.embeds[0].toJSON().description as string).toContain('more');
  });

  it('Back on the exchange screen routes to the Shop screen, not the main menu', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopExchange(ctx, btn as any, prov);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);
    // menu:shop is dispatched to handleShop — the Shop screen, not the menu.
    const back = buttons.find((b) => b.label.includes('Back'));
    expect(back?.customId).toBe('wm|v1|menu|shop');
  });
});
