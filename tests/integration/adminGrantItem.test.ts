/**
 * `/waifumon-admin player grant-item` — the production item-grant tool, real
 * Postgres.
 *
 * It mutates a live player's inventory, so the refusals are tested as hard as
 * the grant: a non-admin, an unregistered target, an unknown / disabled /
 * equipment item, a bad quantity and a capped key item must each change
 * nothing and write no audit row; and every answer must be ephemeral.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  ADMIN_ACTION_EVENT,
  ADMIN_MAX_ITEM_GRANT,
  handleAdminGrantItemAutocomplete,
  handleAdminPlayerGrantItem,
} from '../../src/discord/commands/waifumonAdminPlayer';
import {
  AdminItemGrantError,
  grantItemToPlayer,
} from '../../src/modules/admin/adminItemGrantService';
import { items, playerInventory, playerProgressionEvents, players } from '../../src/db/schema';
import type { AppContext } from '../../src/discord/types';
import type { InventoryService } from '../../src/modules/inventory/inventoryService';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let ctx: AppContext;
let targetPlayerId: number;

const GUILD = 'g-grant-item';
const ADMIN_ID = 'u-admin';
const TARGET_ID = 'u-target';
const INTERACTION_ID = 'interaction-1';

function buildCtx(overrides: { inventory?: InventoryService } = {}): AppContext {
  return {
    logger: t.logger,
    db: t.db,
    content: app.content,
    services: {
      guilds: app.guilds,
      players: app.players,
      inventory: overrides.inventory ?? app.inventory,
    },
  } as unknown as AppContext;
}

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId: targetPlayerId } = await provisionPlayer(app, GUILD, TARGET_ID));
  ctx = buildCtx();
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, targetPlayerId));
  await t.db
    .delete(playerProgressionEvents)
    .where(eq(playerProgressionEvents.playerId, targetPlayerId));
});

// ───────────────────────────── fake interactions ─────────────────────────────

interface FakeOptions {
  admin?: boolean;
  inGuild?: boolean;
  user?: { id: string; bot?: boolean };
  item?: string;
  /** `undefined` = option omitted (Discord sends nothing, so the default applies). */
  quantity?: number;
}

function fakeCommand(opts: FakeOptions = {}) {
  const admin = opts.admin ?? true;
  return {
    id: INTERACTION_ID,
    inGuild: () => opts.inGuild ?? true,
    guildId: GUILD,
    channelId: 'c-1',
    user: { id: ADMIN_ID, username: 'Admin' },
    memberPermissions: {
      has: (flag: bigint) => admin && flag === PermissionFlagsBits.ManageGuild,
    },
    options: {
      getUser: () => opts.user ?? { id: TARGET_ID, bot: false },
      getInteger: () => opts.quantity ?? null,
      getString: () => opts.item ?? 'energy_drink',
    },
    reply: vi.fn(async (_payload: unknown) => {}),
    deferReply: vi.fn(async (_payload: unknown) => {}),
    editReply: vi.fn(async (_payload: unknown) => {}),
  };
}
type FakeCommand = ReturnType<typeof fakeCommand>;

/** The one message the admin saw, whichever way it was delivered. */
function answerOf(i: FakeCommand): string {
  const edits = i.editReply.mock.calls;
  const replies = i.reply.mock.calls;
  expect(edits.length + replies.length).toBe(1);
  return ((edits[0] ?? replies[0])![0] as { content: string }).content;
}

/** Nothing this command says is ever visible to the channel. */
function expectEphemeral(i: FakeCommand): void {
  for (const call of [...i.reply.mock.calls, ...i.deferReply.mock.calls]) {
    expect((call[0] as { flags: number }).flags).toBe(MessageFlags.Ephemeral);
  }
  // An edit only ever lands on the ephemeral deferral.
  if (i.editReply.mock.calls.length > 0) expect(i.deferReply).toHaveBeenCalledTimes(1);
}

function fakeAutocomplete(value: string, opts: { admin?: boolean; focused?: string } = {}) {
  const admin = opts.admin ?? true;
  return {
    guildId: GUILD,
    user: { id: ADMIN_ID },
    memberPermissions: {
      has: (flag: bigint) => admin && flag === PermissionFlagsBits.ManageGuild,
    },
    options: { getFocused: () => ({ name: opts.focused ?? 'item', value }) },
    respond: vi.fn(async (_choices: { name: string; value: string }[]) => {}),
  };
}

async function quantityOf(slug: string, playerId = targetPlayerId): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(playerId, item.id);
}

async function auditRows(playerId = targetPlayerId) {
  return t.db
    .select()
    .from(playerProgressionEvents)
    .where(
      and(
        eq(playerProgressionEvents.playerId, playerId),
        eq(playerProgressionEvents.eventType, ADMIN_ACTION_EVENT),
      ),
    )
    .orderBy(desc(playerProgressionEvents.id));
}

async function inventoryRowCount(): Promise<number> {
  const rows = await t.db
    .select()
    .from(playerInventory)
    .where(eq(playerInventory.playerId, targetPlayerId));
  return rows.length;
}

async function expectNothingChanged(): Promise<void> {
  expect(await inventoryRowCount()).toBe(0);
  expect(await auditRows()).toHaveLength(0);
}

// ─────────────────────────────────── tests ───────────────────────────────────

describe('authorization', () => {
  it('lets a Manage Server admin grant', async () => {
    const i = fakeCommand({ quantity: 2 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('energy_drink')).toBe(2);
    expectEphemeral(i);
  });

  it('refuses a member without Manage Server and changes nothing', async () => {
    const i = fakeCommand({ admin: false, quantity: 5 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('Manage Server');
    expectEphemeral(i);
    expect(i.deferReply).not.toHaveBeenCalled();
    await expectNothingChanged();
  });

  it('refuses use outside a guild', async () => {
    const i = fakeCommand({ inGuild: false });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('inside a server');
    await expectNothingChanged();
  });
});

describe('player resolution', () => {
  it('grants to the named player, never the invoking admin', async () => {
    const { playerId: adminPlayerId } = await provisionPlayer(app, GUILD, ADMIN_ID);
    const i = fakeCommand({ quantity: 3 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('energy_drink')).toBe(3);
    expect(await quantityOf('energy_drink', adminPlayerId)).toBe(0);
    expect(await auditRows(adminPlayerId)).toHaveLength(0);
  });

  it('refuses a target with no Waifumon account and does not create one', async () => {
    const fresh = 'u-never-played';
    const i = fakeCommand({ user: { id: fresh, bot: false } });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('has not started Waifumon');
    expect(answerOf(i)).toContain(`<@${fresh}>`);
    expectEphemeral(i);
    expect(await app.players.findPlayerId(GUILD, fresh)).toBeNull();
    const rows = await t.db.select().from(players).where(eq(players.discordUserId, fresh));
    expect(rows).toHaveLength(0);
  });

  it('does not treat an account in another server as this one', async () => {
    await provisionPlayer(app, 'g-other-server', 'u-elsewhere');
    const i = fakeCommand({ user: { id: 'u-elsewhere', bot: false } });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('has not started Waifumon');
  });

  it('refuses a bot target', async () => {
    const i = fakeCommand({ user: { id: 'u-bot', bot: true } });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('Bots do not have');
    await expectNothingChanged();
  });
});

describe('item lookup', () => {
  it.each(['energy_drink', 'basic_charm', 'sticky_joystick', 'quantum_stabilizer'])(
    'grants %s through the shared inventory path',
    async (slug) => {
      const i = fakeCommand({ item: slug, quantity: 2 });
      await handleAdminPlayerGrantItem(ctx, i as never);
      expect(await quantityOf(slug)).toBe(2);
    },
  );

  it('refuses an unknown key', async () => {
    const i = fakeCommand({ item: 'definitely_not_an_item' });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('not in the current item catalogue');
    expectEphemeral(i);
    await expectNothingChanged();
  });

  it('refuses a disabled item', async () => {
    await t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'microdose'));
    try {
      const i = fakeCommand({ item: 'microdose' });
      await handleAdminPlayerGrantItem(ctx, i as never);

      expect(answerOf(i)).toContain('disabled');
      await expectNothingChanged();
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'microdose'));
    }
  });

  it('refuses the reserved equipment category', async () => {
    await t.db.insert(items).values({
      slug: 'test_reserved_sword',
      name: 'Reserved Sword',
      category: 'equipment',
    });
    try {
      const i = fakeCommand({ item: 'test_reserved_sword' });
      await handleAdminPlayerGrantItem(ctx, i as never);

      expect(answerOf(i)).toContain('cannot be granted here');
      await expectNothingChanged();
    } finally {
      await t.db.delete(items).where(eq(items.slug, 'test_reserved_sword'));
    }
  });
});

describe('autocomplete', () => {
  const choicesOf = (i: ReturnType<typeof fakeAutocomplete>) => i.respond.mock.calls[0]![0];

  it('finds an item by display name and submits its key', async () => {
    const i = fakeAutocomplete('Energy Dr');
    await handleAdminGrantItemAutocomplete(ctx, i as never);

    const choices = choicesOf(i);
    expect(choices[0]).toEqual({ name: 'Energy Drink · consumable', value: 'energy_drink' });
  });

  it('finds an item by internal key', async () => {
    const i = fakeAutocomplete('transporter_bea');
    await handleAdminGrantItemAutocomplete(ctx, i as never);

    expect(choicesOf(i).map((c) => c.value)).toContain('transporter_beacon');
  });

  it('never returns more than 25 results, each a real catalogue key', async () => {
    const i = fakeAutocomplete('');
    await handleAdminGrantItemAutocomplete(ctx, i as never);

    const choices = choicesOf(i);
    expect(choices).toHaveLength(25);
    const slugs = new Set(app.content.items.map((item) => item.slug));
    for (const choice of choices) {
      expect(slugs.has(choice.value)).toBe(true);
      expect(choice.name.length).toBeLessThanOrEqual(100);
    }
  });

  it('answers a non-admin with nothing', async () => {
    const i = fakeAutocomplete('energy', { admin: false });
    await handleAdminGrantItemAutocomplete(ctx, i as never);
    expect(choicesOf(i)).toEqual([]);
  });

  it('answers nothing for an unmatched query', async () => {
    const i = fakeAutocomplete('zzzz-no-such-item');
    await handleAdminGrantItemAutocomplete(ctx, i as never);
    expect(choicesOf(i)).toEqual([]);
  });
});

describe('quantity', () => {
  it('defaults to 1 when omitted', async () => {
    const i = fakeCommand();
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('energy_drink')).toBe(1);
    expect(answerOf(i)).toContain('Granted 1 × Energy Drink');
  });

  it('grants an explicit quantity', async () => {
    const i = fakeCommand({ quantity: 12 });
    await handleAdminPlayerGrantItem(ctx, i as never);
    expect(await quantityOf('energy_drink')).toBe(12);
  });

  it.each([0, -3, 1.5, Number.NaN])('refuses quantity %s', async (quantity) => {
    const i = fakeCommand({ quantity });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('1 or more');
    expectEphemeral(i);
    await expectNothingChanged();
  });

  it('accepts exactly the per-command maximum', async () => {
    const i = fakeCommand({ quantity: ADMIN_MAX_ITEM_GRANT });
    await handleAdminPlayerGrantItem(ctx, i as never);
    expect(await quantityOf('energy_drink')).toBe(ADMIN_MAX_ITEM_GRANT);
  });

  it('refuses one over the maximum', async () => {
    const i = fakeCommand({ quantity: ADMIN_MAX_ITEM_GRANT + 1 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain(`capped at **${ADMIN_MAX_ITEM_GRANT}**`);
    await expectNothingChanged();
  });

  it('enforces the same bounds in the service, not only in the command', async () => {
    const deps = { db: t.db, inventory: app.inventory, logger: t.logger };
    const actor = { adminDiscordId: ADMIN_ID, targetDiscordId: TARGET_ID, guildId: GUILD };
    for (const quantity of [0, -1, 2.5, ADMIN_MAX_ITEM_GRANT + 1]) {
      await expect(
        grantItemToPlayer(deps, {
          playerId: targetPlayerId,
          itemSlug: 'energy_drink',
          quantity,
          actor,
        }),
      ).rejects.toBeInstanceOf(AdminItemGrantError);
    }
    await expectNothingChanged();
  });

  it('refuses an unknown player id in the service', async () => {
    await expect(
      grantItemToPlayer(
        { db: t.db, inventory: app.inventory, logger: t.logger },
        {
          playerId: 9_999_999,
          itemSlug: 'energy_drink',
          quantity: 1,
          actor: { adminDiscordId: ADMIN_ID, targetDiscordId: 'x', guildId: GUILD },
        },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_GRANT_PLAYER_NOT_FOUND' });
  });
});

describe('inventory mutation', () => {
  it('makes a previously unowned item owned', async () => {
    expect(await quantityOf('silk_charm')).toBe(0);
    const i = fakeCommand({ item: 'silk_charm', quantity: 4 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('silk_charm')).toBe(4);
    expect(answerOf(i)).toContain('**0** → **4** (+4)');
  });

  it('adds to an existing quantity and reports the new balance', async () => {
    const item = await getItemBySlug(t.db, 'energy_drink');
    await app.inventory.addItem(t.db, targetPlayerId, item.id, 7);

    const i = fakeCommand({ quantity: 5 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('energy_drink')).toBe(12);
    const answer = answerOf(i);
    expect(answer).toContain('Granted 5 × Energy Drink');
    expect(answer).toContain(`<@${TARGET_ID}>`);
    expect(answer).toContain('**7** → **12** (+5)');
    // Nothing internal: the key and database ids stay out of what the admin reads.
    expect(answer).not.toContain('energy_drink');
    expect(answer).not.toMatch(/player ?id|item ?id/i);
  });

  it('rolls the grant back when anything after it fails', async () => {
    // The real upsert runs, then the transaction dies before it can commit.
    const failing: InventoryService = {
      ...app.inventory,
      async addItem(tx, playerId, itemId, quantity) {
        await app.inventory.addItem(tx, playerId, itemId, quantity);
        throw new Error('connection reset: relation "player_inventory" at 10.0.0.5');
      },
    };
    const error = vi.spyOn(t.logger, 'error').mockImplementation(() => {});
    try {
      const i = fakeCommand({ quantity: 9 });
      await handleAdminPlayerGrantItem(buildCtx({ inventory: failing }), i as never);

      const answer = answerOf(i);
      expect(answer).toBe('Something went wrong — nothing was granted.');
      expect(answer).not.toContain('player_inventory');
      expectEphemeral(i);
      await expectNothingChanged();

      // …and the failure is investigable server-side.
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0]).toMatchObject({
        action: 'grant_item',
        result: 'failed',
        adminDiscordId: ADMIN_ID,
        targetDiscordId: TARGET_ID,
        itemSlug: 'energy_drink',
        amount: 9,
      });
    } finally {
      error.mockRestore();
    }
  });

  it('grants nothing when the interaction can no longer be acknowledged', async () => {
    const i = fakeCommand({ quantity: 3 });
    i.deferReply.mockRejectedValueOnce(new Error('Unknown interaction'));

    await expect(handleAdminPlayerGrantItem(ctx, i as never)).rejects.toThrow('Unknown interaction');
    await expectNothingChanged();
  });
});

describe('key items', () => {
  it('grants a single-copy key item once, as an ordinary inventory row', async () => {
    const i = fakeCommand({ item: 'transporter_beacon' });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(await quantityOf('transporter_beacon')).toBe(1);
    expect(await inventoryRowCount()).toBe(1);
    expect(answerOf(i)).toContain('**0** → **1** (+1)');
  });

  it('refuses a second copy and leaves the first alone', async () => {
    await handleAdminPlayerGrantItem(ctx, fakeCommand({ item: 'transporter_beacon' }) as never);

    const again = fakeCommand({ item: 'transporter_beacon' });
    await handleAdminPlayerGrantItem(ctx, again as never);

    const answer = answerOf(again);
    expect(answer).toContain('limited to **1** per player');
    expect(answer).toContain('already hold **1**');
    expectEphemeral(again);
    expect(await quantityOf('transporter_beacon')).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('refuses a quantity above the item’s ownership limit', async () => {
    const i = fakeCommand({ item: 'transporter_beacon', quantity: 2 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    expect(answerOf(i)).toContain('limited to **1** per player');
    await expectNothingChanged();
  });

  it('stacks an uncapped key component like any other item', async () => {
    const i = fakeCommand({ item: 'quantum_stabilizer', quantity: 3 });
    await handleAdminPlayerGrantItem(ctx, i as never);
    expect(await quantityOf('quantum_stabilizer')).toBe(3);
  });
});

describe('audit trail', () => {
  it('records who granted what to whom, with before and after', async () => {
    const item = await getItemBySlug(t.db, 'energy_drink');
    await app.inventory.addItem(t.db, targetPlayerId, item.id, 2);

    const i = fakeCommand({ quantity: 6 });
    await handleAdminPlayerGrantItem(ctx, i as never);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.xpDelta).toBe(0);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.metadata).toEqual({
      action: 'grant_item',
      adminDiscordId: ADMIN_ID,
      targetDiscordId: TARGET_ID,
      guildId: GUILD,
      before: 2,
      after: 8,
      amount: 6,
      itemSlug: 'energy_drink',
      itemId: item.id,
      itemCategory: 'consumable',
      interactionId: INTERACTION_ID,
    });
  });

  it('emits a structured server log line for the grant', async () => {
    const warn = vi.spyOn(t.logger, 'warn').mockImplementation(() => {});
    try {
      await handleAdminPlayerGrantItem(ctx, fakeCommand({ quantity: 2 }) as never);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({
        tag: 'admin/player-action',
        action: 'grant_item',
        result: 'granted',
        adminDiscordId: ADMIN_ID,
        targetDiscordId: TARGET_ID,
        itemSlug: 'energy_drink',
        amount: 2,
        before: 0,
        after: 2,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a refusal but writes no audit row for it', async () => {
    const warn = vi.spyOn(t.logger, 'warn').mockImplementation(() => {});
    try {
      await handleAdminPlayerGrantItem(ctx, fakeCommand({ item: 'nope' }) as never);
      expect(warn.mock.calls[0]![0]).toMatchObject({
        action: 'grant_item',
        result: 'refused',
        code: 'ADMIN_GRANT_ITEM_NOT_FOUND',
        itemSlug: 'nope',
      });
      expect(await auditRows()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
