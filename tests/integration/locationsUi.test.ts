/**
 * Locations screens — routing, destination-state rendering, and the
 * confirmation gate.
 *
 * Everything is asserted through the *painted payload* rather than through the
 * service, because the whole risk this feature carries at the UI layer is a
 * screen that offers an action the service will refuse (or hides one it would
 * allow). The states under test are the settled contract: hidden / ineligible
 * / purchasable / unlocked / current.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encounters, playerCurrencies, players, species } from '../../src/db/schema';
import { handleMenu } from '../../src/discord/commands/waifumon';
import {
  handleLocationBuy,
  handleLocationConfirm,
  handleLocationDetail,
  handleLocationShop,
  handleLocationTravel,
  handleLocationsHome,
} from '../../src/discord/commands/waifumonLocations';
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
let ctx: AppContext;
let prov: Provisioned;
let harness: EventHarness;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-loc-ui', 'u-loc-ui');
  ctx = {
    config: {} as AppContext['config'],
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
});
afterAll(async () => {
  await t.cleanup();
});

function fakeButton() {
  const channel = { id: 'c-loc', send: vi.fn(), messages: { edit: vi.fn() } };
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
    user: { id: 'u-loc-ui', displayName: 'Hunter' },
    guildId: 'g-loc-ui',
    message: { id: 'm-loc' },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function painted(btn: ReturnType<typeof fakeButton>): any {
  const calls = [...btn.update.mock.calls, ...btn.reply.mock.calls] as any[][];
  return calls[0]?.[0];
}

function buttonsOf(payload: any): { customId: string; label: string; disabled: boolean }[] {
  return (payload?.components ?? []).flatMap((row: any) => {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return (json.components ?? []).map((c: any) => ({
      customId: c.custom_id ?? '',
      label: c.label ?? '',
      disabled: c.disabled ?? false,
    }));
  });
}

function embedOf(payload: any): { title?: string; description?: string } {
  const embed = payload?.embeds?.[0];
  const json = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  return { title: json?.title, description: json?.description };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function resetPlayer(opts: { level?: number; waifubux?: number } = {}): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, prov.playerId));
  await app.travel.revokeRoute(prov.playerId, 'twin-peeks');
  await app.travel.revokePass(prov.playerId, 'caravan_pass');
  await t.db
    .update(players)
    .set({ level: opts.level ?? 20, currentRegion: 'waifu-valley' })
    .where(eq(players.id, prov.playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 5000 })
    .where(eq(playerCurrencies.playerId, prov.playerId));
}

beforeEach(() => resetPlayer());

describe('menu routing', () => {
  it('puts a Locations button on the main menu', async () => {
    const btn = fakeButton();
    await handleMenu(ctx, btn as never, prov);
    const buttons = buttonsOf(painted(btn));
    expect(buttons.map((b) => b.customId)).toContain('wm|v1|loc|home');
  });

  it('paints Locations in place rather than stacking a new message', async () => {
    const btn = fakeButton();
    await handleLocationsHome(ctx, btn as never, prov);
    expect(btn.update).toHaveBeenCalledOnce();
    expect(btn.channel.send).not.toHaveBeenCalled();
  });
});

describe('locations home', () => {
  it('marks the current region and offers one button per destination', async () => {
    const btn = fakeButton();
    await handleLocationsHome(ctx, btn as never, prov);
    const payload = painted(btn);
    expect(embedOf(payload).title).toBe('🗺️ Locations');
    expect(embedOf(payload).description).toContain('You are in **Waifu Valley**');
    expect(embedOf(payload).description).toContain('*you are here*');
    const ids = buttonsOf(payload).map((b) => b.customId);
    expect(ids).toContain('wm|v1|loc|detail|waifu-valley');
    expect(ids).toContain('wm|v1|loc|detail|twin-peeks');
    // Released packs show up here with no UI change of their own — the list is
    // one button per enabled destination, and the Foothills are now one.
    expect(ids).toContain('wm|v1|loc|detail|flaccid-foothills');
  });

  it('warns on the list when an encounter is blocking travel', async () => {
    const [anySpecies] = await t.db.select().from(species).limit(1);
    await t.db.insert(encounters).values({
      playerId: prov.playerId,
      speciesId: anySpecies!.id,
      channelId: 'c-loc',
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const btn = fakeButton();
    await handleLocationsHome(ctx, btn as never, prov);
    expect(embedOf(painted(btn)).description).toMatch(/before travelling/);
  });
});

describe('destination states', () => {
  it('current location is marked and its travel action is disabled', async () => {
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'waifu-valley');
    const payload = painted(btn);
    expect(embedOf(payload).description).toContain('You are here');
    const travel = buttonsOf(payload).find((b) => b.customId === 'wm|v1|loc|travel|waifu-valley');
    expect(travel).toBeDefined();
    expect(travel!.disabled).toBe(true);
  });

  it('eligible + locked shows the price and a buy action, not travel', async () => {
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    const ids = buttonsOf(payload).map((b) => b.customId);
    expect(ids).toContain('wm|v1|loc|confirm|twin-peeks');
    expect(ids).not.toContain('wm|v1|loc|travel|twin-peeks');
    expect(embedOf(payload).description).toContain('1000');
  });

  it('ineligible shows the requirement and offers no action at all', async () => {
    await resetPlayer({ level: 10 });
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    expect(embedOf(payload).description).toMatch(/Trainer Level 15 \(you are 10\)/);
    const ids = buttonsOf(payload).map((b) => b.customId);
    expect(ids).not.toContain('wm|v1|loc|confirm|twin-peeks');
    expect(ids).not.toContain('wm|v1|loc|travel|twin-peeks');
  });

  it('unlocked offers travel and no buy action', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'twin-peeks');
    const ids = buttonsOf(painted(btn)).map((b) => b.customId);
    expect(ids).toContain('wm|v1|loc|travel|twin-peeks');
    expect(ids).not.toContain('wm|v1|loc|confirm|twin-peeks');
  });

  it('disables travel while an encounter is open, rather than hiding it', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const [anySpecies] = await t.db.select().from(species).limit(1);
    await t.db.insert(encounters).values({
      playerId: prov.playerId,
      speciesId: anySpecies!.id,
      channelId: 'c-loc',
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'twin-peeks');
    const travel = buttonsOf(painted(btn)).find(
      (b) => b.customId === 'wm|v1|loc|travel|twin-peeks',
    );
    expect(travel!.disabled).toBe(true);
  });

  it('reports a region no longer on the map as stale', async () => {
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'atlantis');
    expect(painted(btn).content).toMatch(/no longer on the map/);
  });
});

describe('purchase requires confirmation', () => {
  it('the buy button opens a confirmation screen and spends nothing', async () => {
    const before = (await app.currency.getBalances(prov.playerId)).waifubux;
    const btn = fakeButton();
    await handleLocationConfirm(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    expect(embedOf(payload).title).toBe('🎫 Confirm purchase');
    const ids = buttonsOf(payload).map((b) => b.customId);
    expect(ids).toEqual(['wm|v1|loc|buy|twin-peeks', 'wm|v1|loc|detail|twin-peeks']);
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBe(before);
  });

  it('confirming spends and unlocks, and lands back on the destination', async () => {
    const before = (await app.currency.getBalances(prov.playerId)).waifubux;
    const btn = fakeButton();
    await handleLocationBuy(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    expect(embedOf(payload).description).toMatch(/Bought the \*\*Caravan Pass\*\*/);
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBe(before - 1000);
    expect(buttonsOf(payload).map((b) => b.customId)).toContain('wm|v1|loc|travel|twin-peeks');
  });

  it('a stale confirm for an already-owned destination falls back to the detail screen', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const btn = fakeButton();
    await handleLocationConfirm(ctx, btn as never, prov, 'twin-peeks');
    expect(embedOf(painted(btn)).title).not.toBe('🎫 Confirm purchase');
  });

  it('a refused purchase reports the reason in place and charges nothing', async () => {
    await resetPlayer({ waifubux: 10 });
    const btn = fakeButton();
    await handleLocationBuy(ctx, btn as never, prov, 'twin-peeks');
    expect(embedOf(painted(btn)).description).toMatch(/⚠️/);
    expect((await app.currency.getBalances(prov.playerId)).waifubux).toBe(10);
  });
});

describe('travel result', () => {
  it('lands on the Locations list with the arrival line and a new "you are here"', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const btn = fakeButton();
    await handleLocationTravel(ctx, btn as never, prov, 'twin-peeks');
    const description = embedOf(painted(btn)).description ?? '';
    expect(description).toMatch(/arrive in \*\*Twin Peeks\*\*/);
    expect(description).toContain('You are in **Twin Peeks**');
  });

  it('reports a blocked trip without moving the player', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const [anySpecies] = await t.db.select().from(species).limit(1);
    await t.db.insert(encounters).values({
      playerId: prov.playerId,
      speciesId: anySpecies!.id,
      channelId: 'c-loc',
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const btn = fakeButton();
    await handleLocationTravel(ctx, btn as never, prov, 'twin-peeks');
    expect(embedOf(painted(btn)).description).toMatch(/still waiting on you/);
    expect(await app.travel.getCurrentRegion(prov.playerId)).toBe('waifu-valley');
  });
});

describe('regional shop', () => {
  it('renders the region shelf and routes buys through the ordinary shop handler', async () => {
    await app.travel.grantRoute(prov.playerId, 'twin-peeks');
    const btn = fakeButton();
    await handleLocationShop(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    expect(embedOf(payload).title).toBe('🛍️ Twin Peeks Shop');
    // Twin Peeks stocks the region-exclusive Shibari Rope.
    expect(embedOf(payload).description).toContain('Shibari Rope');
    const customIds = buttonsOf(payload).map((b) => b.customId);
    expect(customIds).toContain('wm|v1|shop|buy|shibari_rope');
    expect(customIds).toContain('wm|v1|loc|detail|twin-peeks');
  });
});

describe('region banner', () => {
  it('locations home degrades cleanly when no banner file resolves', async () => {
    const btn = fakeButton();
    await handleLocationsHome(ctx, btn as never, prov);
    const payload = painted(btn);
    // No assetsDir wired in this ctx, so the banner path in shipped content
    // does not resolve to a file - the paint still succeeds and simply
    // ships no attachment.
    expect((payload.files ?? []).length).toBe(0);
    expect(embedOf(payload).title).toBe('🗺️ Locations');
  });

  it('destination detail degrades cleanly when no banner file resolves', async () => {
    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, 'twin-peeks');
    const payload = painted(btn);
    expect((payload.files ?? []).length).toBe(0);
    expect(embedOf(payload).title).toContain('Twin Peeks');
  });
});
