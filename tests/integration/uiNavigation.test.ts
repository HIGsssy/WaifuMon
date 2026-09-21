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
  handleShopSell,
  handleShopSellQuantity,
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
      travel: app.travel,
      players: app.players,
      achievements: app.achievements,
      leaderboards: app.leaderboards,
      currency: app.currency,
      inventory: app.inventory,
      daily: app.daily,
      shop: app.shop,
      hunt: app.hunt,
      capture: app.capture,
      collection: app.collection,
      expeditions: app.expeditions,
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

describe('sell items: shop sub-menu navigation and sales', () => {
  /** Phase 2 ships no salvage content, so these tests author their own. */
  let sellSeq = 0;
  async function seedSalvage(overrides: Record<string, unknown> = {}) {
    sellSeq += 1;
    const [row] = await t.db
      .insert(items)
      .values({
        slug: `ui_salvage_${sellSeq}`,
        name: `Scrap ${sellSeq}`,
        category: 'salvage',
        sellValue: 40,
        emoji: '📦',
        ...overrides,
      })
      .returning();
    return row!;
  }

  it('the main Shop shows one Sell Items button and no individual stack buttons', async () => {
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShop(ctx, btn as any, prov);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);

    const sell = buttons.filter((b) => b.customId === 'wm|v1|shop|sell');
    expect(sell).toHaveLength(1);
    expect(sell[0]!.label).toContain('Sell Items');

    // The per-stack buttons never leak onto the main Shop screen.
    expect(buttons.some((b) => b.customId.startsWith('wm|v1|shop|sellqty'))).toBe(false);
  });

  it('shows an empty state when the player holds nothing worth selling', async () => {
    const empty = await provisionPlayer(app, 'g-ui-nav', 'u-sell-empty');
    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSell(ctx, btn as any, empty);

    const payload = btn.update.mock.calls[0]![0];
    expect(paintedEmbed(payload).title).toBe('🪙 Sell Items');
    expect(payload.embeds[0].toJSON().description as string).toContain(
      'Nothing here anyone would pay for',
    );
    // Only the Back row — nothing to press.
    const buttons = paintedButtons(payload);
    expect(buttons.every((b) => b.customId === 'wm|v1|menu|shop')).toBe(true);
  });

  it('lists a sellable stack with parseable Sell 1 / 5 / All custom ids', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-list');
    const scrap = await seedSalvage({ sellValue: 30 });
    await app.inventory.addItem(t.db, player.playerId, scrap.id, 6);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSell(ctx, btn as any, player);
    const payload = btn.update.mock.calls[0]![0];

    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain(scrap.name);
    expect(description).toContain('30');
    // The stack total, so the player can see the size of the pile.
    expect(description).toContain('180');

    const buttons = paintedButtons(payload);
    for (const amount of ['1', '5', 'all']) {
      expect(
        buttons.some((b) => b.customId === `wm|v1|shop|sellqty|${scrap.slug}|${amount}`),
      ).toBe(true);
    }
  });

  it('disables Sell 5 on a stack of fewer than five', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-small');
    const scrap = await seedSalvage();
    await app.inventory.addItem(t.db, player.playerId, scrap.id, 2);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSell(ctx, btn as any, player);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);

    const five = buttons.find((b) => b.customId === `wm|v1|shop|sellqty|${scrap.slug}|5`);
    const one = buttons.find((b) => b.customId === `wm|v1|shop|sellqty|${scrap.slug}|1`);
    expect(five?.disabled).toBe(true);
    expect(one?.disabled).toBe(false);
  });

  it('a sale refreshes the sell screen in place with a confirmation', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-one');
    const scrap = await seedSalvage({ sellValue: 50 });
    await app.inventory.addItem(t.db, player.playerId, scrap.id, 3);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSellQuantity(ctx, btn as any, player, scrap.slug, '1');
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();

    const payload = btn.update.mock.calls[0]![0];
    // Stayed on the sell screen.
    expect(paintedEmbed(payload).title).toBe('🪙 Sell Items');
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain('Sold');
    expect(description).toContain('50');

    expect(await app.inventory.getQuantity(player.playerId, scrap.id)).toBe(2);
    expect((await app.currency.getBalances(player.playerId)).waifubux).toBe(50);
  });

  // "All" means the stack the player was looking at, resolved fresh at click
  // time rather than trusted from the custom id.
  it('Sell All empties exactly one stack and leaves the others alone', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-all');
    const target = await seedSalvage({ sellValue: 20 });
    const other = await seedSalvage({ sellValue: 20 });
    await app.inventory.addItem(t.db, player.playerId, target.id, 5);
    await app.inventory.addItem(t.db, player.playerId, other.id, 5);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSellQuantity(ctx, btn as any, player, target.slug, 'all');

    expect(await app.inventory.getQuantity(player.playerId, target.id)).toBe(0);
    expect(await app.inventory.getQuantity(player.playerId, other.id)).toBe(5);
    expect((await app.currency.getBalances(player.playerId)).waifubux).toBe(100);
  });

  it('a double-clicked Sell All reports the refusal and pays out once', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-double');
    const scrap = await seedSalvage({ sellValue: 75 });
    await app.inventory.addItem(t.db, player.playerId, scrap.id, 2);

    const first = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSellQuantity(ctx, first as any, player, scrap.slug, 'all');
    const second = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSellQuantity(ctx, second as any, player, scrap.slug, 'all');

    // Second click stays on the screen and explains itself rather than throwing.
    const payload = second.update.mock.calls[0]![0];
    expect(paintedEmbed(payload).title).toBe('🪙 Sell Items');
    expect(payload.embeds[0].toJSON().description as string).toContain('⚠️');
    expect((await app.currency.getBalances(player.playerId)).waifubux).toBe(150);
  });

  // A custom id outlives the message that painted it; an unsellable item
  // reached this way must be refused by the service, not by the screen.
  it('refuses a stale button for an item that is not sellable', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-stale');
    const junk = await seedSalvage({ category: 'material', sellValue: null });
    await app.inventory.addItem(t.db, player.playerId, junk.id, 4);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSellQuantity(ctx, btn as any, player, junk.slug, '1');

    const payload = btn.update.mock.calls[0]![0];
    expect(payload.embeds[0].toJSON().description as string).toContain('⚠️');
    expect(await app.inventory.getQuantity(player.playerId, junk.id)).toBe(4);
    expect((await app.currency.getBalances(player.playerId)).waifubux).toBe(0);
  });

  it('Back on the sell screen routes to the Shop screen, not the main menu', async () => {
    const player = await provisionPlayer(app, 'g-ui-nav', 'u-sell-back');
    const scrap = await seedSalvage();
    await app.inventory.addItem(t.db, player.playerId, scrap.id, 1);

    const btn = fakeButtonOn('m-ephemeral');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShopSell(ctx, btn as any, player);
    const buttons = paintedButtons(btn.update.mock.calls[0]![0]);
    const back = buttons.find((b) => b.label.includes('Back'));
    expect(back?.customId).toBe('wm|v1|menu|shop');
  });
});
