/**
 * The Discord surfaces for both halves of this feature — real handlers, real
 * Postgres, fake interactions.
 *
 * Two things are being pinned down here:
 *   1. A waiting gift is *discoverable* without a DM and without a timer —
 *      inspect leads, the collection list and the main menu carry markers.
 *   2. The encounter screen never does capture math of its own: the number it
 *      prints is the number the capture service quotes.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCollection,
  handleInspectCommand,
} from '../../src/discord/commands/waifumonCollection';
import { handleMenu } from '../../src/discord/commands/waifumon';
import { handleGiftClaim } from '../../src/discord/commands/waifumonGifts';
import {
  handleEncounterCapture,
  handleEncounterPick,
  handleEncounterPickItem,
} from '../../src/discord/commands/waifumonHunt';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import {
  affectionGifts,
  captureAttempts,
  encounters,
  playerInventory,
  playerWaifus,
  players,
  species,
} from '../../src/db/schema';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  getItemBySlug,
  insertOwnedWaifu,
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

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  harness = createEventHarness(app, t.logger);
  prov = await provisionPlayer(app, 'g-gift-ui', 'u-1');
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
  await t.db.delete(affectionGifts).where(eq(affectionGifts.playerId, prov.playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, prov.playerId));
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(eq(encounters.playerId, prov.playerId));
  await t.db
    .update(players)
    .set({ buddyWaifuId: null })
    .where(eq(players.id, prov.playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  ctx.collectionFilters!.reset(prov.playerId);
  harness.reset();
});

// ───────────────────────────── fake interactions ─────────────────────────────

function baseInteraction() {
  return {
    isChatInputCommand: () => false,
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
    showModal: vi.fn(async () => {}),
    channelId: 'c-1',
    user: { id: 'u-1', displayName: 'Hunter' },
    guildId: 'g-gift-ui',
    options: { getString: (): string | null => null },
  };
}

const fakeCommand = (name?: string) => ({
  ...baseInteraction(),
  isChatInputCommand: () => true,
  options: { getString: (): string | null => name ?? null },
});
const fakeButton = () => ({ ...baseInteraction(), isButton: () => true, message: { id: 'm-1' } });
const fakeSelect = (values: string[]) => ({
  ...baseInteraction(),
  isStringSelectMenu: () => true,
  message: { id: 'm-1' },
  values,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function painted(interaction: ReturnType<typeof baseInteraction>): any {
  for (const method of [interaction.editReply, interaction.update, interaction.reply]) {
    const calls = method.mock.calls as unknown as unknown[][];
    if (calls.length > 0) return calls.at(-1)![0];
  }
  throw new Error('handler painted nothing');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function components(payload: any, type: number): any[] {
  return (payload.components ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((row: any) => row.components ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => c.data.type === type);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buttons = (payload: any) => components(payload, 2);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selects = (payload: any) => components(payload, 3);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function labels(payload: any): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buttons(payload).map((b: any) => String(b.data.label ?? ''));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function embedText(payload: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embed = payload.embeds?.[0]?.data ?? {};
  const fields = (embed.fields ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((f: any) => `${f.name}\n${f.value}`)
    .join('\n');
  return [embed.title ?? '', embed.description ?? '', fields].join('\n');
}

// ───────────────────────────────── fixtures ─────────────────────────────────

async function grantWaifu(nickname: string | null = null): Promise<number> {
  const [sp] = await t.db.select().from(species).limit(1);
  const row = await insertOwnedWaifu(t.db, { playerId: prov.playerId, speciesId: sp!.id, nickname });
  return row!.id;
}

async function giveGift(waifuId: number, itemSlug = 'quickie_coffee'): Promise<void> {
  await t.db.insert(affectionGifts).values({
    playerId: prov.playerId,
    waifuId,
    itemSlug,
    quantity: 1,
    affectionAtGeneration: 900,
    tierAtGeneration: 'low',
    source: 'random',
    resetDate: '2026-08-26',
  });
}

async function activeEncounter(rarity: string): Promise<number> {
  const [sp] = await t.db
    .select()
    .from(species)
    .where(eq(species.rarity, rarity))
    .limit(1);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId: prov.playerId,
      speciesId: sp!.id,
      channelId: 'c-1',
      state: 'active',
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!.id;
}

async function grantItem(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, prov.playerId, item.id, qty);
}

// ─────────────────────────────── gift surfaces ──────────────────────────────

describe('inspect', () => {
  it('leads with the teaser and offers Accept Gift', async () => {
    const waifuId = await grantWaifu('Luna');
    await giveGift(waifuId);

    const i = fakeCommand(String(waifuId));
    await handleInspectCommand(ctx, i as never, prov);
    const payload = painted(i);

    expect(embedText(payload)).toContain('🎁 **Gift waiting**');
    expect(embedText(payload)).toContain('Luna seems unusually excited to see you.');
    expect(embedText(payload)).toContain('She may have something for you.');
    expect(labels(payload)).toContain('Accept Gift');
  });

  it('shows no gift controls when nothing is waiting', async () => {
    const waifuId = await grantWaifu('Luna');
    const i = fakeCommand(String(waifuId));
    await handleInspectCommand(ctx, i as never, prov);
    const payload = painted(i);
    expect(embedText(payload)).not.toContain('Gift waiting');
    expect(labels(payload)).not.toContain('Accept Gift');
  });
});

describe('Accept Gift', () => {
  it('reveals the item and its description, and grants it once', async () => {
    const waifuId = await grantWaifu('Luna');
    await giveGift(waifuId);

    const i = fakeButton();
    await handleGiftClaim(ctx, i as never, prov, [String(waifuId)]);
    const text = embedText(painted(i));
    expect(text).toContain('A gift from Luna');
    expect(text).toContain('Quickie Coffee');
    expect(text).toContain('A fast, hot fix to keep you pushing forward.');

    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(prov.playerId, item.id)).toBe(1);

    // A second click explains itself rather than granting again.
    const again = fakeButton();
    await handleGiftClaim(ctx, again as never, prov, [String(waifuId)]);
    expect(await app.inventory.getQuantity(prov.playerId, item.id)).toBe(1);
  });

  it('emits the claim event after the write commits', async () => {
    const waifuId = await grantWaifu('Luna');
    await giveGift(waifuId);
    await handleGiftClaim(ctx, fakeButton() as never, prov, [String(waifuId)]);
    const claimed = harness.ofKind('WAIFU_GIFT_CLAIMED');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.payload).toMatchObject({
      waifuId,
      waifuName: 'Luna',
      itemSlug: 'quickie_coffee',
      quantity: 1,
    });
  });
});

describe('other surfaces', () => {
  it('marks the species row in the collection list', async () => {
    const waifuId = await grantWaifu('Luna');
    await giveGift(waifuId);
    const i = fakeCommand();
    await handleCollection(ctx, i as never, prov);
    expect(painted(i).embeds[0].data.description).toContain('🎁');
  });

  it('reminds on the main menu without naming the item', async () => {
    const waifuId = await grantWaifu('Luna');
    await giveGift(waifuId);
    const i = fakeCommand();
    await handleMenu(ctx, i as never, prov);
    const text = embedText(painted(i));
    expect(text).toContain('Gift waiting');
    expect(text).toContain('Luna');
    expect(text).not.toContain('Quickie Coffee');
  });

  it('leaves the menu unchanged when nothing is waiting', async () => {
    await grantWaifu('Luna');
    const i = fakeCommand();
    await handleMenu(ctx, i as never, prov);
    expect(embedText(painted(i))).not.toContain('Gift waiting');
  });
});

// ──────────────────────── encounter item selection ──────────────────────────

describe('encounter controls', () => {
  it('starts with Capture disabled and Use Item offered', async () => {
    await grantItem('basic_charm', 2);
    const encounterId = await activeEncounter('SR');

    const i = fakeButton();
    await handleEncounterPick(ctx, i as never, prov, [String(encounterId)]);
    const payload = painted(i);

    const capture = buttons(payload).find((b) =>
      String(b.data.label).startsWith('Capture'),
    );
    expect(capture?.data.disabled).toBe(true);
    expect(labels(payload)).toContain('Use Item');
    expect(labels(payload)).toContain('Let Her Go');
  });

  it('offers only owned, rarity-eligible items in the selector', async () => {
    await grantItem('basic_charm', 1);
    await grantItem('fluffy_cuffs', 1);
    await grantItem('shibari_rope', 1);
    await grantItem('energy_drink', 1);
    const encounterId = await activeEncounter('SR');

    const i = fakeButton();
    await handleEncounterPick(ctx, i as never, prov, [String(encounterId)]);
    const menu = selects(painted(i))[0];
    const values = menu.options.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (o: any) => (o.data ? o.data.value : o.value),
    );
    expect(values).toContain('basic_charm');
    expect(values).toContain('fluffy_cuffs');
    expect(values).not.toContain('shibari_rope');
    expect(values).not.toContain('energy_drink');
  });

  it('selecting shows the before → after chance and swaps to Change Item', async () => {
    await grantItem('shibari_rope', 1);
    const encounterId = await activeEncounter('UR');

    const i = fakeSelect(['shibari_rope']);
    await handleEncounterPickItem(ctx, i as never, prov, [String(encounterId)]);
    const payload = painted(i);
    const text = embedText(payload);

    // The quoted numbers are the service's; assert against them rather than
    // re-deriving the arithmetic here.
    const quote = await app.capture.quoteCapture(prov.playerId, encounterId);
    expect(quote.item?.slug).toBe('shibari_rope');
    expect(text).toContain('Shibari Rope selected');
    expect(text).toContain(`${Math.round(quote.baselineChance * 1000) / 10}%`);
    expect(text).toContain(`${Math.round(quote.chance * 1000) / 10}%`);
    expect(labels(payload)).toContain('Change Item');
    expect(
      buttons(payload).find((b) => String(b.data.label).startsWith('Capture'))?.data.disabled,
    ).toBe(false);

    // Nothing consumed by selecting.
    const rope = await getItemBySlug(t.db, 'shibari_rope');
    expect(await app.inventory.getQuantity(prov.playerId, rope.id)).toBe(1);
  });

  it('shows Guaranteed for the Mythic Contract instead of a percentage', async () => {
    await grantItem('mythic_contract', 1);
    const encounterId = await activeEncounter('LR');
    const i = fakeSelect(['mythic_contract']);
    await handleEncounterPickItem(ctx, i as never, prov, [String(encounterId)]);
    const text = embedText(painted(i));
    expect(text).toContain('Mythic Contract selected');
    expect(text).toContain('Guaranteed');
  });

  it('refuses an ineligible pick and consumes nothing', async () => {
    await grantItem('fluffy_cuffs', 1);
    const encounterId = await activeEncounter('SSR');
    const i = fakeSelect(['fluffy_cuffs']);
    await handleEncounterPickItem(ctx, i as never, prov, [String(encounterId)]);
    expect(JSON.stringify(painted(i))).toContain("won't work on a SSR");
    const cuffs = await getItemBySlug(t.db, 'fluffy_cuffs');
    expect(await app.inventory.getQuantity(prov.playerId, cuffs.id)).toBe(1);
  });

  it('capture commits the persisted selection and consumes exactly one', async () => {
    await grantItem('mythic_contract', 2);
    const encounterId = await activeEncounter('SR');
    await handleEncounterPickItem(ctx, fakeSelect(['mythic_contract']) as never, prov, [
      String(encounterId),
    ]);

    const i = fakeButton();
    await handleEncounterCapture(ctx, i as never, prov, [String(encounterId), '0']);
    expect(embedText(painted(i))).toContain('You captured');

    const contract = await getItemBySlug(t.db, 'mythic_contract');
    expect(await app.inventory.getQuantity(prov.playerId, contract.id)).toBe(1);
  });

  it('a repeated click on the same stale button consumes nothing extra', async () => {
    await grantItem('basic_charm', 3);
    const encounterId = await activeEncounter('SR');
    await handleEncounterPickItem(ctx, fakeSelect(['basic_charm']) as never, prov, [
      String(encounterId),
    ]);
    const charm = await getItemBySlug(t.db, 'basic_charm');

    await handleEncounterCapture(ctx, fakeButton() as never, prov, [String(encounterId), '0']);
    const afterFirst = await app.inventory.getQuantity(prov.playerId, charm.id);

    // Same button, same rendered attempt count — the second click is stale.
    // Which refusal the player sees depends on whether the first attempt
    // landed (this handler runs the real, unseeded RNG): a success resolves
    // the encounter, a failure only advances it. Both are correct, and both
    // must leave the inventory and the attempt log untouched — that is the
    // property under test. The exact `EncounterStaleError` path is pinned
    // deterministically in `captureItems.test.ts`.
    const second = fakeButton();
    await handleEncounterCapture(ctx, second as never, prov, [String(encounterId), '0']);
    expect(await app.inventory.getQuantity(prov.playerId, charm.id)).toBe(afterFirst);
    expect(JSON.stringify(painted(second))).toMatch(/out of date|already resolved/i);

    const attempts = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounterId));
    expect(attempts).toHaveLength(1);
  });
});
