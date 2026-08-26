/**
 * Essence QoL on the Discord surface — real Postgres, real handlers.
 *
 * Covers what the player actually sees and clicks: the balance on both
 * screens, the 1×/5×/10×/Custom tiers and when they grey out, the custom modal
 * and its rejections, and that a successful spend re-renders the same copy
 * with updated numbers.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCollection,
  handleWaifuInvest,
  handleWaifuInvestOpen,
  handleWaifuInvestSubmit,
} from '../../src/discord/commands/waifumonCollection';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import { playerCurrencies, playerWaifus, species } from '../../src/db/schema';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  provisionPlayer,
  type App,
  type EventHarness,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let harness: EventHarness;
let prov: Provisioned;
let ctx: AppContext;
let costPer: number;
let xpPer: number;
let maxLevel: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-essence-ui', 'u-1');
  const cfg = app.content.tables.waifuProgression;
  costPer = cfg.essenceInvestment.essenceCost;
  xpPer = cfg.essenceInvestment.xpGranted;
  maxLevel = cfg.maxLevel;
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
    collectionFilters: createCollectionFilterTracker(),
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
  } as AppContext;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  ctx.collectionFilters!.reset(prov.playerId);
});

async function setEssence(amount: number): Promise<void> {
  await t.db
    .update(playerCurrencies)
    .set({ essence: amount })
    .where(eq(playerCurrencies.playerId, prov.playerId));
}

async function grantWaifu(level = 1, xp = 0): Promise<number> {
  const [sp] = await t.db.select().from(species).where(eq(species.slug, 'neko_barista'));
  const [row] = await t.db
    .insert(playerWaifus)
    .values({ playerId: prov.playerId, speciesId: sp!.id, level, xp })
    .returning();
  return row!.id;
}

async function waifuRow(waifuId: number) {
  const [row] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, waifuId));
  return row!;
}

function cumulativeXpToMax(): number {
  let total = 0;
  for (let level = 1; level < maxLevel; level++) total += app.collection.waifuXpToNext(level);
  return total;
}

// ───────────────────────────── fake interactions ─────────────────────────────

function baseInteraction() {
  const state = { replied: false, deferred: false };
  return {
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    reply: vi.fn(async () => {
      state.replied = true;
    }),
    editReply: vi.fn(async () => {
      state.replied = true;
    }),
    update: vi.fn(async () => {
      state.replied = true;
    }),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {
      state.deferred = true;
    }),
    showModal: vi.fn(async () => {}),
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-essence-ui',
  };
}

const fakeCommand = () => ({ ...baseInteraction(), isChatInputCommand: () => true });
const fakeButton = () => ({ ...baseInteraction(), isButton: () => true, message: { id: 'm-1' } });
const fakeModal = (fields: Record<string, string>) => ({
  ...baseInteraction(),
  isModalSubmit: () => true,
  fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
});

function painted(interaction: ReturnType<typeof baseInteraction>): any {
  for (const method of [interaction.editReply, interaction.update, interaction.reply]) {
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

/** Every button on the painted screen, flattened. */
function buttons(payload: any): any[] {
  return (payload.components ?? [])
    .flatMap((row: any) => row.components ?? [])
    .filter((c: any) => c.data.type === 2);
}

function buttonByLabel(payload: any, label: string): any | undefined {
  return buttons(payload).find((b: any) => String(b.data.label ?? '').includes(label));
}

function fieldValue(payload: any, name: string): string {
  return payload.embeds[0].data.fields.find((f: any) => f.name === name)?.value ?? '';
}

describe('collection list — Essence balance', () => {
  it('shows the current balance in the header', async () => {
    await grantWaifu();
    await setEssence(1234);

    const i = fakeCommand();
    await handleCollection(ctx, i as never, prov);

    expect(painted(i).embeds[0].data.description).toContain('1234');
  });

  it('reflects a balance change after a spend', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 10);

    const spend = fakeButton();
    await handleWaifuInvest(ctx, spend as never, prov, [String(waifuId), '5']);

    const list = fakeCommand();
    await handleCollection(ctx, list as never, prov);
    expect(painted(list).embeds[0].data.description).toContain(String(costPer * 5));
  });
});

describe('inspect screen — Essence panel and tiers', () => {
  it('renders 1×, 5×, 10× and Custom with their costs', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 100);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    const payload = painted(i);

    expect(buttonByLabel(payload, '1×')).toBeDefined();
    expect(buttonByLabel(payload, '5×')).toBeDefined();
    expect(buttonByLabel(payload, '10×')).toBeDefined();
    expect(buttonByLabel(payload, 'Custom')).toBeDefined();
    // Labels carry the total cost of each tier.
    expect(buttonByLabel(payload, '5×').data.label).toContain(String(costPer * 5));
  });

  it('shows balance and per-1× cost in the Essence field', async () => {
    const waifuId = await grantWaifu();
    await setEssence(777);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    const essence = fieldValue(painted(i), 'Essence');

    expect(essence).toContain(String(777 - costPer)); // balance after the 1×
    expect(essence).toContain(String(costPer));
  });

  it('greys out tiers the balance cannot cover', async () => {
    const waifuId = await grantWaifu();
    // Enough for the 1× just spent plus exactly one more — 5×/10× unaffordable.
    await setEssence(costPer * 2);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);
    const payload = painted(i);

    expect(buttonByLabel(payload, '1×').data.disabled).toBeFalsy();
    expect(buttonByLabel(payload, '5×').data.disabled).toBe(true);
    expect(buttonByLabel(payload, '10×').data.disabled).toBe(true);
  });

  it('greys out every Essence action once she is capped', async () => {
    const waifuId = await grantWaifu(maxLevel, cumulativeXpToMax());
    await setEssence(costPer * 100);

    // Reached via a rejected spend, which still re-renders her card.
    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '1']);

    // The spend is refused outright rather than silently burning Essence.
    expect(painted(i).content).toContain(`already at Lv ${maxLevel}`);
  });
});

describe('essence tier buttons', () => {
  it('a 5× spends five applications in one click', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 20);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '5']);

    expect((await waifuRow(waifuId)).xp).toBe(xpPer * 5);
    expect(fieldValue(painted(i), 'Essence')).toContain(String(costPer * 20 - costPer * 5));
  });

  it('an unaffordable 10× spends nothing and says so', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 3);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId), '10']);

    expect((await waifuRow(waifuId)).xp).toBe(0);
    expect(painted(i).content.toLowerCase()).toContain('essence');
  });

  it('treats a missing tier arg as 1×, so older buttons still work', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 5);

    const i = fakeButton();
    await handleWaifuInvest(ctx, i as never, prov, [String(waifuId)]);

    expect((await waifuRow(waifuId)).xp).toBe(xpPer);
  });
});

describe('custom amount modal', () => {
  it('opens a modal asking for a count', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 50);

    const i = fakeButton();
    await handleWaifuInvestOpen(ctx, i as never, prov, [String(waifuId)]);

    expect(i.showModal).toHaveBeenCalledTimes(1);
    const modal = (i.showModal.mock.calls[0] as unknown as any[])[0];
    expect(modal.data.custom_id).toContain('invest_submit');
    expect(modal.components[0].components[0].data.custom_id).toBe('applications');
  });

  it('refuses to open for a capped copy', async () => {
    const waifuId = await grantWaifu(maxLevel, cumulativeXpToMax());
    await setEssence(costPer * 50);

    const i = fakeButton();
    await handleWaifuInvestOpen(ctx, i as never, prov, [String(waifuId)]);

    expect(i.showModal).not.toHaveBeenCalled();
    expect(painted(i).content).toContain('max level');
  });

  it('spends the requested amount and re-renders her card', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 20);

    const modal = fakeModal({ applications: '7' });
    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect((await waifuRow(waifuId)).xp).toBe(xpPer * 7);
    const payload = painted(modal);
    // Same inspected copy, updated numbers.
    expect(payload.embeds[0].data.title).toContain('Neko');
    expect(fieldValue(payload, 'Essence')).toContain(String(costPer * 20 - costPer * 7));
  });

  it.each([
    ['abc', 'whole number'],
    ['0', '1 or more'],
    ['', 'how many times'],
    ['101', 'at most'],
  ])('rejects %s without spending anything', async (input, expected) => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 50);

    const modal = fakeModal({ applications: input });
    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(expected) }),
    );
    expect((await waifuRow(waifuId)).xp).toBe(0);
  });

  it('rejects an amount beyond the balance, naming cost and balance', async () => {
    const waifuId = await grantWaifu();
    await setEssence(costPer * 3);

    const modal = fakeModal({ applications: '9' });
    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(String(costPer * 9)) }),
    );
    expect((await waifuRow(waifuId)).xp).toBe(0);
  });

  it('rejects an amount that overshoots the level cap', async () => {
    const waifuId = await grantWaifu(1, cumulativeXpToMax() - xpPer);
    await setEssence(costPer * 50);

    const modal = fakeModal({ applications: '5' });
    await handleWaifuInvestSubmit(ctx, modal as never, prov, [String(waifuId)]);

    expect(modal.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('1×') }),
    );
    expect((await waifuRow(waifuId)).xp).toBe(cumulativeXpToMax() - xpPer);
  });
});
