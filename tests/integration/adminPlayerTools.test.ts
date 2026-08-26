/**
 * `/waifumon-admin player …` — live-testing helpers, real Postgres.
 *
 * This is support tooling that moves balances, so the tests weight the refusal
 * paths as heavily as the happy ones: a non-admin must get nothing, a bad
 * target must get nothing, an over-cap amount must get nothing, and every
 * reply must be ephemeral so a balance change is never broadcast.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  ADMIN_ACTION_EVENT,
  ADMIN_MAX_CHARM_GRANT,
  ADMIN_MAX_ESSENCE_GRANT,
  handleAdminPlayerCharms,
  handleAdminPlayerEnergy,
  handleAdminPlayerEssence,
} from '../../src/discord/commands/waifumonAdminPlayer';
import {
  items,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  players,
} from '../../src/db/schema';
import type { AppContext } from '../../src/discord/types';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let ctx: AppContext;
let targetPlayerId: number;

const GUILD = 'g-admin-tools';
const ADMIN_ID = 'u-admin';
const TARGET_ID = 'u-target';

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId: targetPlayerId } = await provisionPlayer(app, GUILD, TARGET_ID));
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
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db
    .update(playerCurrencies)
    .set({ essence: 100, waifubux: 0, huntEnergy: 3 })
    .where(eq(playerCurrencies.playerId, targetPlayerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, targetPlayerId));
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, targetPlayerId));
});

// ───────────────────────────── fake interactions ─────────────────────────────

interface FakeOptions {
  user?: { id: string; bot?: boolean };
  amount?: number | null;
  charm?: string;
}

function fakeCommand(opts: FakeOptions & { admin?: boolean; inGuild?: boolean } = {}) {
  const admin = opts.admin ?? true;
  return {
    inGuild: () => opts.inGuild ?? true,
    guildId: GUILD,
    channelId: 'c-1',
    user: { id: ADMIN_ID, username: 'Admin' },
    memberPermissions: {
      has: (flag: bigint) => admin && flag === PermissionFlagsBits.ManageGuild,
    },
    options: {
      getUser: (_name: string, _required?: boolean) =>
        opts.user === undefined ? { id: TARGET_ID, bot: false } : opts.user,
      getInteger: (_name: string, required?: boolean) => {
        if (opts.amount === undefined) return required ? 1 : null;
        return opts.amount;
      },
      getString: (_name: string, _required?: boolean) => opts.charm ?? 'basic_charm',
    },
    reply: vi.fn(async () => {}),
  };
}

function replyOf(i: ReturnType<typeof fakeCommand>): any {
  const calls = i.reply.mock.calls as unknown as any[][];
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0];
}

async function balances() {
  const [row] = await t.db
    .select()
    .from(playerCurrencies)
    .where(eq(playerCurrencies.playerId, targetPlayerId));
  return row!;
}

async function auditRows() {
  return t.db
    .select()
    .from(playerProgressionEvents)
    .where(
      and(
        eq(playerProgressionEvents.playerId, targetPlayerId),
        eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT),
      ),
    )
    .orderBy(desc(playerProgressionEvents.id));
}

async function charmItemId(slug = 'basic_charm'): Promise<number> {
  const [row] = await t.db.select().from(items).where(eq(items.slug, slug));
  return row!.id;
}

describe('permission gate', () => {
  it.each([
    ['energy', handleAdminPlayerEnergy],
    ['essence', handleAdminPlayerEssence],
    ['charms', handleAdminPlayerCharms],
  ])('rejects a non-admin on %s and changes nothing', async (_name, handler) => {
    const before = await balances();
    const i = fakeCommand({ admin: false, amount: 500 });

    await handler(ctx, i as never);

    expect(replyOf(i).content).toContain('Manage Server');
    expect(await balances()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects use outside a guild', async () => {
    const i = fakeCommand({ inGuild: false });
    await handleAdminPlayerEssence(ctx, i as never);
    expect(replyOf(i).content).toContain('inside a server');
  });
});

describe('target validation', () => {
  it('refuses a bot target', async () => {
    const i = fakeCommand({ user: { id: 'u-bot', bot: true }, amount: 10 });
    await handleAdminPlayerEssence(ctx, i as never);

    expect(replyOf(i).content).toContain('Bots do not have');
    expect(await auditRows()).toHaveLength(0);
  });

  it('never falls back to the invoking admin', async () => {
    // The admin has no account here; the command targets someone else, and the
    // admin's own balance must be untouched either way.
    const i = fakeCommand({ amount: 50 });
    await handleAdminPlayerEssence(ctx, i as never);

    const [adminRow] = await t.db
      .select()
      .from(players)
      .where(and(eq(players.discordUserId, ADMIN_ID)));
    expect(adminRow).toBeUndefined();
    expect((await balances()).essence).toBe(150);
  });

  it('provisions a target who has never played', async () => {
    const fresh = 'u-never-played';
    const i = fakeCommand({ user: { id: fresh, bot: false }, amount: 25 });

    await handleAdminPlayerEssence(ctx, i as never);

    const created = await app.players.findPlayerId(GUILD, fresh);
    expect(created).not.toBeNull();
    expect(replyOf(i).content).toContain(`<@${fresh}>`);
  });
});

describe('amount validation', () => {
  it.each([0, -5, 1.5])('rejects essence amount %s', async (amount) => {
    const i = fakeCommand({ amount });
    await handleAdminPlayerEssence(ctx, i as never);

    expect(replyOf(i).content).toContain('1 or more');
    expect((await balances()).essence).toBe(100);
  });

  it('rejects essence above the per-command cap', async () => {
    const i = fakeCommand({ amount: ADMIN_MAX_ESSENCE_GRANT + 1 });
    await handleAdminPlayerEssence(ctx, i as never);

    expect(replyOf(i).content).toContain(String(ADMIN_MAX_ESSENCE_GRANT));
    expect((await balances()).essence).toBe(100);
  });

  it('rejects charms above the per-command cap', async () => {
    const i = fakeCommand({ amount: ADMIN_MAX_CHARM_GRANT + 1 });
    await handleAdminPlayerCharms(ctx, i as never);

    expect(replyOf(i).content).toContain(String(ADMIN_MAX_CHARM_GRANT));
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects a charm slug that is not grantable', async () => {
    const i = fakeCommand({ charm: 'energy_drink', amount: 5 });
    await handleAdminPlayerCharms(ctx, i as never);

    expect(replyOf(i).content).toContain('not a grantable charm');
    expect(await auditRows()).toHaveLength(0);
  });

  it('accepts exactly the cap', async () => {
    const i = fakeCommand({ amount: ADMIN_MAX_ESSENCE_GRANT });
    await handleAdminPlayerEssence(ctx, i as never);

    expect((await balances()).essence).toBe(100 + ADMIN_MAX_ESSENCE_GRANT);
  });
});

describe('essence grant', () => {
  it('adds essence and reports before/after', async () => {
    const i = fakeCommand({ amount: 250 });
    await handleAdminPlayerEssence(ctx, i as never);

    expect((await balances()).essence).toBe(350);
    const { content } = replyOf(i);
    expect(content).toContain(`<@${TARGET_ID}>`);
    expect(content).toContain('250 Essence');
    expect(content).toContain('100');
    expect(content).toContain('350');
  });

  it('writes an audit row naming the admin', async () => {
    const i = fakeCommand({ amount: 40 });
    await handleAdminPlayerEssence(ctx, i as never);

    const [row] = await auditRows();
    expect(row!.metadata).toMatchObject({
      action: 'grant_essence',
      adminDiscordId: ADMIN_ID,
      targetDiscordId: TARGET_ID,
      before: 100,
      after: 140,
      amount: 40,
    });
    expect(row!.xpDelta).toBe(0);
  });
});

describe('charm grant', () => {
  it('adds charms and reports before/after', async () => {
    const i = fakeCommand({ charm: 'silk_charm', amount: 7 });
    await handleAdminPlayerCharms(ctx, i as never);

    const itemId = await charmItemId('silk_charm');
    expect(await app.inventory.getQuantity(targetPlayerId, itemId)).toBe(7);
    const { content } = replyOf(i);
    expect(content).toContain(`<@${TARGET_ID}>`);
    expect(content).toContain('7 ×');
  });

  it('stacks onto an existing quantity', async () => {
    const first = fakeCommand({ amount: 3 });
    await handleAdminPlayerCharms(ctx, first as never);
    const second = fakeCommand({ amount: 4 });
    await handleAdminPlayerCharms(ctx, second as never);

    expect(await app.inventory.getQuantity(targetPlayerId, await charmItemId())).toBe(7);
    expect(replyOf(second).content).toContain('**3** → **7**');
  });
});

describe('energy set / reset', () => {
  it('defaults to the player’s configured maximum', async () => {
    const i = fakeCommand({ amount: null });
    await handleAdminPlayerEnergy(ctx, i as never);

    const [player] = await t.db.select().from(players).where(eq(players.id, targetPlayerId));
    const max = app.progression.computeMaxEnergy(player!.level);
    expect((await balances()).huntEnergy).toBe(max);
    expect(replyOf(i).content).toContain('Energy reset');
  });

  it('sets an explicit value', async () => {
    const i = fakeCommand({ amount: 5 });
    await handleAdminPlayerEnergy(ctx, i as never);

    expect((await balances()).huntEnergy).toBe(5);
    const { content } = replyOf(i);
    expect(content).toContain('Energy set');
    expect(content).toContain('**3** → **5**');
  });

  it('allows zero — draining is a legitimate test setup', async () => {
    const i = fakeCommand({ amount: 0 });
    await handleAdminPlayerEnergy(ctx, i as never);
    expect((await balances()).huntEnergy).toBe(0);
  });

  it('refuses to exceed the configured maximum', async () => {
    const [player] = await t.db.select().from(players).where(eq(players.id, targetPlayerId));
    const max = app.progression.computeMaxEnergy(player!.level);

    const i = fakeCommand({ amount: max + 1 });
    await handleAdminPlayerEnergy(ctx, i as never);

    expect(replyOf(i).content).toContain(String(max));
    expect((await balances()).huntEnergy).toBe(3);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('response hygiene', () => {
  it.each([
    ['energy', handleAdminPlayerEnergy],
    ['essence', handleAdminPlayerEssence],
    ['charms', handleAdminPlayerCharms],
  ])('%s replies ephemerally on success', async (_name, handler) => {
    const i = fakeCommand({ amount: 2 });
    await handler(ctx, i as never);
    expect(replyOf(i).flags).toBe(MessageFlags.Ephemeral);
  });

  it.each([
    ['energy', handleAdminPlayerEnergy],
    ['essence', handleAdminPlayerEssence],
    ['charms', handleAdminPlayerCharms],
  ])('%s replies ephemerally on refusal', async (_name, handler) => {
    const i = fakeCommand({ admin: false, amount: 2 });
    await handler(ctx, i as never);
    expect(replyOf(i).flags).toBe(MessageFlags.Ephemeral);
  });
});
