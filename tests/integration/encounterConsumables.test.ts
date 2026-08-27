/**
 * Encounter-time use of persistent consumables — the Microdose fix.
 *
 * The bug: the encounter selector asked `item.category === 'capture'`, which
 * is a question about filing rather than behaviour, so Microdose — a
 * consumable whose entire effect is a capture bonus — never appeared on the
 * one screen where a player would reach for it.
 *
 * The invariant these tests defend: **availability follows behaviour**, and
 * activating a persistent buff is a purchase, not a move — it spends the item
 * immediately, leaves the encounter and its selected direct item alone, and
 * never resolves anything.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_BONUS_EFFECT,
  captureAttempts,
  encounters,
  playerActiveEffects,
  playerInventory,
  playerWaifus,
  players,
  species,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import {
  encounterItemKind,
  ENCOUNTER_USABLE_EFFECT_TYPES,
  isEncounterConsumable,
} from '../../src/modules/items/encounterUse';
import {
  handleEncounterCapture,
  handleEncounterPick,
  handleEncounterPickItem,
  parseEncounterItemValue,
} from '../../src/discord/commands/waifumonHunt';
import { createCollectionFilterTracker } from '../../src/discord/collectionFilterTracker';
import {
  EffectAlreadyAtMaxChargesError,
  EncounterStaleError,
  InsufficientItemsError,
  ItemNotUsableError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  bootstrapApp,
  createEventHarness,
  getItemBySlug,
  provisionPlayer,
  scriptedRng,
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
  prov = await provisionPlayer(app, 'g-enc-consumable', 'u-1');
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

const MICRODOSE_BONUS = 0.03;
const MICRODOSE_CHARGES = 5;

async function speciesOfRarity(rarity: string): Promise<SpeciesRow> {
  const [row] = await t.db
    .select()
    .from(species)
    .where(and(eq(species.rarity, rarity), eq(species.enabled, true)))
    .limit(1);
  if (!row) throw new Error(`no enabled ${rarity} species seeded`);
  return row;
}

async function createEncounter(rarity = 'UR'): Promise<EncounterRow> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, prov.playerId), eq(encounters.state, 'active')));
  const speciesRow = await speciesOfRarity(rarity);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId: prov.playerId,
      speciesId: speciesRow.id,
      channelId: 'c-1',
      state: 'active',
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return row!;
}

async function grant(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, prov.playerId, item.id, qty);
}

async function owned(slug: string): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(prov.playerId, item.id);
}

async function charges(): Promise<number> {
  return (await app.effects.getCaptureBonus(prov.playerId))?.chargesRemaining ?? 0;
}

function captureService(rng: Rng) {
  return createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    seductivePowerConfig: app.content.tables.seductivePower,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    itemUse: app.itemUse,
    appearance: app.appearance,
    logger: t.logger,
    rng,
  });
}

beforeEach(async () => {
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, prov.playerId));
  await t.db
    .delete(playerActiveEffects)
    .where(eq(playerActiveEffects.playerId, prov.playerId));
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, prov.playerId), eq(encounters.state, 'active')));
  await t.db
    .update(players)
    .set({ buddyWaifuId: null })
    .where(eq(players.id, prov.playerId));
  await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, prov.playerId));
  harness.reset();
});

// ─────────────────────────── availability rules ──────────────────────────

describe('what counts as encounter-usable', () => {
  it('is decided by effect, not by category', async () => {
    const microdose = await getItemBySlug(t.db, 'microdose');
    const drink = await getItemBySlug(t.db, 'energy_drink');
    const charm = await getItemBySlug(t.db, 'basic_charm');

    // The regression in one assertion: Microdose is not category `capture`,
    // and is nonetheless usable during an encounter.
    expect(microdose.category).not.toBe('capture');
    expect(isEncounterConsumable(microdose)).toBe(true);
    expect(encounterItemKind(microdose)).toBe('consumable');

    expect(encounterItemKind(charm)).toBe('direct');
    expect(encounterItemKind(drink)).toBeNull();
    expect(ENCOUNTER_USABLE_EFFECT_TYPES).toEqual(['capture_bonus_charges']);
  });

  it('offers an owned Microdose alongside the direct capture items', async () => {
    await grant('microdose', 2);
    await grant('basic_charm', 1);
    await grant('shibari_rope', 1);
    const encounter = await createEncounter('UR');

    const options = await app.capture.listEncounterItems(prov.playerId, encounter.id);
    const bySlug = new Map(options.map((o) => [o.item.slug, o]));

    expect(bySlug.get('microdose')?.kind).toBe('consumable');
    expect(bySlug.get('microdose')?.charges).toEqual({
      remaining: 0,
      max: MICRODOSE_CHARGES,
    });
    expect(bySlug.get('basic_charm')?.kind).toBe('direct');
    expect(bySlug.get('shibari_rope')?.kind).toBe('direct');
  });

  it('leaves unrelated consumables out', async () => {
    await grant('energy_drink', 3);
    await grant('quickie_coffee', 3);
    await grant('full_body_massage', 1);
    await grant('microdose', 1);
    const encounter = await createEncounter('N');

    const slugs = (await app.capture.listEncounterItems(prov.playerId, encounter.id)).map(
      (o) => o.item.slug,
    );
    expect(slugs).toContain('microdose');
    expect(slugs).not.toContain('energy_drink');
    expect(slugs).not.toContain('quickie_coffee');
    expect(slugs).not.toContain('full_body_massage');
  });

  it('omits Microdose the player does not own', async () => {
    await grant('basic_charm', 1);
    const encounter = await createEncounter('N');
    const slugs = (await app.capture.listEncounterItems(prov.playerId, encounter.id)).map(
      (o) => o.item.slug,
    );
    expect(slugs).not.toContain('microdose');
  });

  it('keeps rarity gating on the direct items unchanged', async () => {
    await grant('microdose', 1);
    await grant('fluffy_cuffs', 1);
    await grant('shibari_rope', 1);

    const low = await app.capture.listEncounterItems(
      prov.playerId,
      (await createEncounter('SR')).id,
    );
    expect(low.map((o) => o.item.slug)).toEqual(
      expect.arrayContaining(['fluffy_cuffs', 'microdose']),
    );
    expect(low.map((o) => o.item.slug)).not.toContain('shibari_rope');

    const high = await app.capture.listEncounterItems(
      prov.playerId,
      (await createEncounter('SSR')).id,
    );
    expect(high.map((o) => o.item.slug)).toEqual(
      expect.arrayContaining(['shibari_rope', 'microdose']),
    );
    expect(high.map((o) => o.item.slug)).not.toContain('fluffy_cuffs');
  });

  it('hides Microdose while the buff is already at full charges', async () => {
    await grant('microdose', 2);
    const encounter = await createEncounter('UR');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');
    expect(await charges()).toBe(MICRODOSE_CHARGES);

    // Refreshing 5 -> 5 would spend an item for nothing, so the encounter
    // neither offers it nor accepts it. (The inventory screen's refresh
    // behaviour is untouched — that is where topping a buff back up lives.)
    const slugs = (await app.capture.listEncounterItems(prov.playerId, encounter.id)).map(
      (o) => o.item.slug,
    );
    expect(slugs).not.toContain('microdose');
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose'),
    ).rejects.toBeInstanceOf(EffectAlreadyAtMaxChargesError);
    expect(await owned('microdose')).toBe(1);
  });

  it('offers Microdose again once a charge has been spent, labelled as a refresh', async () => {
    await grant('microdose', 2);
    await grant('basic_charm', 2);
    const encounter = await createEncounter('N');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    // Spend one charge with a real (failing) attempt.
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'basic_charm');
    await captureService(scriptedRng([0.999])).attemptCapture(prov.playerId, encounter.id, null);
    expect(await charges()).toBe(MICRODOSE_CHARGES - 1);

    const option = (await app.capture.listEncounterItems(prov.playerId, encounter.id)).find(
      (o) => o.item.slug === 'microdose',
    );
    expect(option?.charges).toEqual({ remaining: 4, max: MICRODOSE_CHARGES });
  });
});

// ───────────────────────────── activation ────────────────────────────────

describe('activating Microdose during an encounter', () => {
  it('consumes exactly one and grants the five-charge buff', async () => {
    await grant('microdose', 3);
    const encounter = await createEncounter('UR');

    const result = await app.capture.useEncounterConsumable(
      prov.playerId,
      encounter.id,
      'microdose',
    );
    expect(await owned('microdose')).toBe(2);
    expect(await charges()).toBe(MICRODOSE_CHARGES);
    expect(result.use.kind).toBe('capture_bonus_charges');
    if (result.use.kind !== 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.use.modifier).toBe(MICRODOSE_BONUS);
    expect(result.use.refreshed).toBe(false);
  });

  it('refreshes rather than stacking a second independent effect', async () => {
    await grant('microdose', 3);
    await grant('basic_charm', 2);
    const encounter = await createEncounter('N');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    // Burn a charge so a refresh is meaningful again.
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'basic_charm');
    await captureService(scriptedRng([0.999])).attemptCapture(prov.playerId, encounter.id, null);

    const again = await app.capture.useEncounterConsumable(
      prov.playerId,
      encounter.id,
      'microdose',
    );
    if (again.use.kind !== 'capture_bonus_charges') throw new Error('unreachable');
    expect(again.use.refreshed).toBe(true);
    expect(await charges()).toBe(MICRODOSE_CHARGES);

    // One row, not two — the non-stacking guarantee is a unique index.
    const rows = await t.db
      .select()
      .from(playerActiveEffects)
      .where(
        and(
          eq(playerActiveEffects.playerId, prov.playerId),
          eq(playerActiveEffects.effectType, CAPTURE_BONUS_EFFECT),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('does not select, replace, or disturb the direct capture item', async () => {
    await grant('microdose', 1);
    await grant('shibari_rope', 1);
    const encounter = await createEncounter('UR');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'shibari_rope');
    const rope = await getItemBySlug(t.db, 'shibari_rope');

    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    const [after] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(after!.selectedItemId).toBe(rope.id);
    expect(await owned('shibari_rope')).toBe(1);
  });

  it('does not resolve, finalize, or advance the encounter', async () => {
    await grant('microdose', 1);
    const encounter = await createEncounter('UR');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    const [after] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(after!.state).toBe('active');
    expect(after!.resolvedAt).toBeNull();
    expect(after!.attemptCount).toBe(0);
    expect(
      await t.db
        .select()
        .from(captureAttempts)
        .where(eq(captureAttempts.encounterId, encounter.id)),
    ).toHaveLength(0);
    // Still reachable as the player's live encounter.
    expect((await app.hunt.getActiveEncounter(prov.playerId))?.id).toBe(encounter.id);
  });

  it('refuses when the player owns none, leaving the encounter untouched', async () => {
    const encounter = await createEncounter('UR');
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose'),
    ).rejects.toBeInstanceOf(InsufficientItemsError);

    expect(await charges()).toBe(0);
    const [after] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(after!.state).toBe('active');
    expect(after!.attemptCount).toBe(0);
  });

  it('refuses to "use" a direct capture item through the consumable path', async () => {
    await grant('basic_charm', 1);
    const encounter = await createEncounter('N');
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'basic_charm'),
    ).rejects.toBeInstanceOf(ItemNotUsableError);
    expect(await owned('basic_charm')).toBe(1);
  });

  it('refuses an unrelated consumable, so energy cannot be burned mid-encounter', async () => {
    await grant('energy_drink', 1);
    const encounter = await createEncounter('N');
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'energy_drink'),
    ).rejects.toBeInstanceOf(ItemNotUsableError);
    expect(await owned('energy_drink')).toBe(1);
  });
});

// ──────────────────────────── idempotency ────────────────────────────────

describe('double clicks and stale interactions', () => {
  it('a repeated submission of the same rendered menu consumes one Microdose', async () => {
    await grant('microdose', 3);
    const encounter = await createEncounter('UR');

    // Both clicks were rendered while charges were 0.
    const outcomes = await Promise.allSettled([
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose', {
        expectedCharges: 0,
      }),
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose', {
        expectedCharges: 0,
      }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await owned('microdose')).toBe(2);
    expect(await charges()).toBe(MICRODOSE_CHARGES);
  });

  it('a stale charge token is refused outright', async () => {
    await grant('microdose', 2);
    const encounter = await createEncounter('UR');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose', {
      expectedCharges: 0,
    });
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose', {
        expectedCharges: 0,
      }),
    ).rejects.toBeInstanceOf(EncounterStaleError);
    expect(await owned('microdose')).toBe(1);
  });

  it('a stale attempt-count token is refused', async () => {
    await grant('microdose', 2);
    await grant('basic_charm', 2);
    const encounter = await createEncounter('N');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'basic_charm');
    await captureService(scriptedRng([0.999])).attemptCapture(prov.playerId, encounter.id, null);

    // Rendered before that attempt landed.
    await expect(
      app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose', {
        expectedAttemptCount: 0,
      }),
    ).rejects.toBeInstanceOf(EncounterStaleError);
    expect(await owned('microdose')).toBe(2);
  });

  it('changing the direct item does not consume another Microdose', async () => {
    await grant('microdose', 1);
    await grant('basic_charm', 1);
    await grant('silk_charm', 1);
    await grant('fluffy_cuffs', 1);
    const encounter = await createEncounter('SR');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'basic_charm');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'silk_charm');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'fluffy_cuffs');

    expect(await owned('microdose')).toBe(0);
    expect(await charges()).toBe(MICRODOSE_CHARGES);
  });
});

// ──────────────────────────── capture maths ──────────────────────────────

describe('chance calculation', () => {
  it('adds exactly 0.03 to the quote, and the quote refresh spends no charge', async () => {
    await grant('microdose', 1);
    const encounter = await createEncounter('UR');

    const before = await app.capture.quoteCapture(prov.playerId, encounter.id);
    const result = await app.capture.useEncounterConsumable(
      prov.playerId,
      encounter.id,
      'microdose',
    );
    expect(result.quoteAfter.chance - result.quoteBefore.chance).toBeCloseTo(
      MICRODOSE_BONUS,
      10,
    );
    expect(result.quoteBefore.chance).toBeCloseTo(before.chance, 10);
    expect(result.quoteAfter.captureBonusModifier).toBe(MICRODOSE_BONUS);

    // Re-quoting is a read: it must never burn a charge.
    for (let i = 0; i < 5; i++) {
      await app.capture.quoteCapture(prov.playerId, encounter.id);
    }
    expect(await charges()).toBe(MICRODOSE_CHARGES);
  });

  it('stacks with each applicable direct item', async () => {
    await grant('microdose', 1);
    await grant('shibari_rope', 1);
    await grant('basic_charm', 1);
    await grant('velvet_charm', 1);
    const encounter = await createEncounter('UR');

    const bare = await app.capture.quoteCapture(prov.playerId, encounter.id, null);
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    for (const slug of ['shibari_rope', 'basic_charm', 'velvet_charm']) {
      const withoutBuffBaseline = bare.chance;
      const quote = await app.capture.quoteCapture(prov.playerId, encounter.id, slug);
      expect(quote.captureBonusModifier, slug).toBe(MICRODOSE_BONUS);
      // The buff lifts the whole quote, on top of whatever the item does.
      expect(quote.baselineChance).toBeCloseTo(withoutBuffBaseline + MICRODOSE_BONUS, 10);
    }

    // Shibari Rope on UR: 0.06 base + 0.15 item + 0.03 buff = 0.24.
    const rope = await app.capture.quoteCapture(prov.playerId, encounter.id, 'shibari_rope');
    expect(rope.chance).toBeCloseTo(0.24, 10);
    expect(rope.itemCaptureBonus).toBe(0.15);
  });

  it('leaves the maximum-chance clamp and Mythic Contract untouched', async () => {
    await grant('microdose', 1);
    await grant('mythic_contract', 1);
    await grant('velvet_charm', 1);
    const encounter = await createEncounter('N');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');

    const mythic = await app.capture.quoteCapture(
      prov.playerId,
      encounter.id,
      'mythic_contract',
    );
    expect(mythic.guaranteed).toBe(true);
    expect(mythic.chance).toBe(1);

    // N base 0.5 x 2.25 + 0.03 is well past the cap, which still binds.
    const velvet = await app.capture.quoteCapture(prov.playerId, encounter.id, 'velvet_charm');
    expect(velvet.chance).toBe(app.content.tables.capture.maxChance);
  });

  it('spends a charge only when a capture attempt actually resolves', async () => {
    await grant('microdose', 1);
    await grant('basic_charm', 2);
    const encounter = await createEncounter('N');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'basic_charm');
    expect(await charges()).toBe(MICRODOSE_CHARGES);

    const result = await captureService(scriptedRng([0.999])).attemptCapture(
      prov.playerId,
      encounter.id,
      null,
    );
    expect(result.outcome).toBe('failure');
    expect(result.effect?.captureBonusModifier).toBe(MICRODOSE_BONUS);
    expect(await charges()).toBe(MICRODOSE_CHARGES - 1);
  });

  it('the displayed quote is the chance the committed attempt rolls against', async () => {
    await grant('microdose', 1);
    await grant('shibari_rope', 1);
    const encounter = await createEncounter('UR');
    await app.capture.useEncounterConsumable(prov.playerId, encounter.id, 'microdose');
    const quote = await app.capture.selectCaptureItem(
      prov.playerId,
      encounter.id,
      'shibari_rope',
    );

    // A roll a hair above the quoted chance must fail — which only holds if
    // the server used the number the screen showed.
    const result = await captureService(scriptedRng([quote.chance + 0.0001])).attemptCapture(
      prov.playerId,
      encounter.id,
      null,
    );
    expect(result.attempt.computedChance).toBeCloseTo(quote.chance, 10);
    expect(result.outcome).not.toBe('success');
  });
});

// ────────────────────────────── Discord flow ─────────────────────────────

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
    guildId: 'g-enc-consumable',
  };
}

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
function selectOptions(payload: any): Array<{ value: string; description: string }> {
  return (payload.components ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((row: any) => row.components ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => c.data.type === 3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((menu: any) => menu.options ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({
      value: o.data ? o.data.value : o.value,
      description: (o.data ? o.data.description : o.description) ?? '',
    }));
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

describe('encounter selector on Discord', () => {
  it('parses the value encoding for both item kinds', () => {
    expect(parseEncounterItemValue('d:basic_charm')).toEqual({
      kind: 'direct',
      slug: 'basic_charm',
    });
    expect(parseEncounterItemValue('u:microdose:0')).toEqual({
      kind: 'consumable',
      slug: 'microdose',
      expectedCharges: 0,
    });
    expect(parseEncounterItemValue('microdose')).toBeNull();
    expect(parseEncounterItemValue('u:microdose')).toBeNull();
  });

  it('lists Microdose in the menu and says it is spent immediately', async () => {
    await grant('microdose', 1);
    await grant('basic_charm', 1);
    const encounter = await createEncounter('UR');

    const i = fakeButton();
    await handleEncounterPick(ctx, i as never, prov, [String(encounter.id)]);
    const options = selectOptions(painted(i));

    const micro = options.find((o) => o.value.startsWith('u:microdose'));
    expect(micro).toBeDefined();
    expect(micro!.value).toBe('u:microdose:0');
    expect(micro!.description).toContain('Used now');
    // Direct items say the opposite, so the two are never confused.
    const charm = options.find((o) => o.value === 'd:basic_charm');
    expect(charm!.description).toContain('used on Capture');
  });

  it('activates from the menu, confirms, and keeps the player on the encounter', async () => {
    await grant('microdose', 2);
    const encounter = await createEncounter('UR');

    const i = fakeSelect(['u:microdose:0']);
    await handleEncounterPickItem(ctx, i as never, prov, [String(encounter.id), '0']);
    const text = embedText(painted(i));

    expect(text).toContain('Microdose used');
    expect(text).toContain('next **5 attempts**');
    // 6% -> 9% on a UR, straight from the authoritative quote.
    expect(text).toContain('6% → 9%');
    // Still the encounter screen, still her.
    expect(text).toContain('A wild');
    expect(await owned('microdose')).toBe(1);

    const [after] = await t.db.select().from(encounters).where(eq(encounters.id, encounter.id));
    expect(after!.state).toBe('active');
  });

  it('shows the combined chance when a direct item is already selected', async () => {
    await grant('microdose', 1);
    await grant('shibari_rope', 1);
    const encounter = await createEncounter('UR');
    await app.capture.selectCaptureItem(prov.playerId, encounter.id, 'shibari_rope');

    const i = fakeSelect(['u:microdose:0']);
    await handleEncounterPickItem(ctx, i as never, prov, [String(encounter.id), '0']);
    const text = embedText(painted(i));

    // The selected-item panel repaints from the same quote: 6% base, 21% with
    // the rope, 24% once the buff lands.
    expect(text).toContain('Shibari Rope selected');
    expect(text).toContain('24%');
  });

  it('a stale menu submission is refused and consumes nothing extra', async () => {
    await grant('microdose', 3);
    const encounter = await createEncounter('UR');

    await handleEncounterPickItem(ctx, fakeSelect(['u:microdose:0']) as never, prov, [
      String(encounter.id),
      '0',
    ]);
    expect(await owned('microdose')).toBe(2);

    const stale = fakeSelect(['u:microdose:0']);
    await handleEncounterPickItem(ctx, stale as never, prov, [String(encounter.id), '0']);
    expect(await owned('microdose')).toBe(2);
    expect(JSON.stringify(painted(stale))).toContain('out of date');
  });

  it('capture after activation still resolves one attempt and spends one charge', async () => {
    await grant('microdose', 1);
    await grant('basic_charm', 2);
    const encounter = await createEncounter('N');

    await handleEncounterPickItem(ctx, fakeSelect(['u:microdose:0']) as never, prov, [
      String(encounter.id),
      '0',
    ]);
    await handleEncounterPickItem(ctx, fakeSelect(['d:basic_charm']) as never, prov, [
      String(encounter.id),
      '0',
    ]);

    await handleEncounterCapture(ctx, fakeButton() as never, prov, [String(encounter.id), '0']);

    const attempts = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounter.id));
    expect(attempts).toHaveLength(1);
    expect(await owned('basic_charm')).toBe(1);
    expect(await charges()).toBe(MICRODOSE_CHARGES - 1);
  });
});
