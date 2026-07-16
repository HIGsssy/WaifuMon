/**
 * Handler navigation tests: menu → sub-screen updates the same ephemeral
 * message (button uses `.update()`), and slash-command entry replies fresh
 * with the Ephemeral flag. Also verifies sub-screens carry a Back button.
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
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';
import type { AppContext, Provisioned } from '../../src/discord/types';

let t: TestDb;
let app: App;
let prov: Provisioned;
let ctx: AppContext;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  const provisioned = await provisionPlayer(app, 'g-ui-nav', 'u-1');
  prov = provisioned;
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
    },
  };
});
afterAll(async () => {
  await t.cleanup();
});

interface RecordedInteraction {
  isButton: () => boolean;
  replied: boolean;
  deferred: boolean;
  reply: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  user: { id: string; displayName: string };
  channelId: string;
}

function fakeButton(): RecordedInteraction {
  return {
    isButton: () => true,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    user: { id: 'u-1', displayName: 'Hunter' },
    channelId: 'c-1',
  };
}

function fakeCommand(): RecordedInteraction {
  return {
    isButton: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    user: { id: 'u-1', displayName: 'Hunter' },
    channelId: 'c-1',
  };
}

function hasBackButton(payload: unknown): boolean {
  const rows = (payload as { components?: Array<{ toJSON: () => unknown }> }).components ?? [];
  for (const row of rows) {
    const json = row.toJSON() as { components: Array<{ custom_id: string }> };
    if (json.components.some((c) => c.custom_id === 'wm|v1|menu|back')) return true;
  }
  return false;
}

describe('menu navigation — buttons update in place, commands reply fresh', () => {
  it('menu button → profile calls update() (not reply/followUp)', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.reply).not.toHaveBeenCalled();
    expect(btn.editReply).not.toHaveBeenCalled();
  });

  it('/waifumon profile replies ephemerally on first touch', async () => {
    const cmd = fakeCommand();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, cmd as any, prov);
    expect(cmd.reply).toHaveBeenCalledOnce();
    const payload = cmd.reply.mock.calls[0]![0] as { flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  });

  it('profile screen carries a Back button', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleProfile(ctx, btn as any, prov);
    expect(hasBackButton(btn.update.mock.calls[0]![0])).toBe(true);
  });

  it('inventory: button updates in place with a Back button', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleInventory(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(hasBackButton(btn.update.mock.calls[0]![0])).toBe(true);
  });

  it('shop: button updates in place with a Back button', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleShop(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(hasBackButton(btn.update.mock.calls[0]![0])).toBe(true);
  });

  it('daily claim: button updates in place with a Back button', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleDaily(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(hasBackButton(btn.update.mock.calls[0]![0])).toBe(true);
  });

  it('main menu button (Back) shows the menu with no Back-button row', async () => {
    const btn = fakeButton();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleMenu(ctx, btn as any, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    // Menu itself does not include a Back row (it is the root screen).
    expect(hasBackButton(btn.update.mock.calls[0]![0])).toBe(false);
  });
});
