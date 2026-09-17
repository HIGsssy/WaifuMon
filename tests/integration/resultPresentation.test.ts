/**
 * Result Presentation against real Postgres.
 *
 *   - the table refuses rows the runtime could not honour;
 *   - the service validates writes, serves only enabled variants, caches, and
 *     survives a broken read;
 *   - **presentation never touches gameplay randomness**: a "nothing found"
 *     hunt draws once, and a seeded hunt sequence is identical whether
 *     variants exist, are reweighted, or are disabled;
 *   - Let Her Go only releases — no capture attempt, no consumable charge, no
 *     item, no currency — for hunted and spawned encounters alike;
 *   - a hunt whose turn a World Encounter takes reports its reward once,
 *     under "Along the way", and grants it once.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeWorldEncounters,
  captureAttempts,
  encounters,
  items,
  playerCurrencies,
  players,
  resultPresentationVariants,
  worldEncounterCooldowns,
  worldEncounterSettings,
} from '../../src/db/schema';
import { handleEncounterRelease, handleHunt } from '../../src/discord/commands/waifumonHunt';
import type { AppContext, Provisioned } from '../../src/discord/types';
import { createHuntService, type HuntResult } from '../../src/modules/hunt/huntService';
import {
  RESULT_PRESENTATION_KEYS,
  type ResultPresentationKey,
} from '../../src/modules/resultPresentation/keys';
import { createResultPresentationService } from '../../src/modules/resultPresentation/resultPresentationService';
import { ResultPresentationValidationError } from '../../src/modules/resultPresentation/validation';
import { seededRng, type Rng } from '../../src/shared/random';
import type { Db } from '../../src/db/client';
import {
  bootstrapApp,
  createEventHarness,
  getItemBySlug,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db.delete(resultPresentationVariants);
});

function huntServiceWith(rng: Rng) {
  return createHuntService({
    db: t.db,
    currency: app.currency,
    essenceAward: app.essenceAward,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    buddyBonus: app.buddyBonus,
    logger: t.logger,
    rng,
  });
}

/** Wraps an Rng and counts every draw. */
function counting(inner: Rng): Rng & { draws: number } {
  const rng = {
    draws: 0,
    next: () => {
      rng.draws++;
      return inner.next();
    },
    intInclusive: (min: number, max: number) => {
      rng.draws++;
      return inner.intInclusive(min, max);
    },
  };
  return rng;
}

async function resetPlayer(playerId: number): Promise<void> {
  await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: 200, waifubux: 0, essence: 0 })
    .where(eq(playerCurrencies.playerId, playerId));
}

describe('table constraints', () => {
  const insert = (values: Partial<typeof resultPresentationVariants.$inferInsert>) =>
    t.db.insert(resultPresentationVariants).values({
      presentationKey: 'hunt.item_find',
      ...values,
    } as typeof resultPresentationVariants.$inferInsert);

  it('accepts a well-formed row for every key', async () => {
    for (const presentationKey of RESULT_PRESENTATION_KEYS) {
      await expect(insert({ presentationKey, flavorText: 'ok' })).resolves.toBeDefined();
    }
  });

  it.each([
    ['an unknown key', { presentationKey: 'hunt.jackpot' }],
    ['weight 0', { weight: 0 }],
    ['a negative weight', { weight: -3 }],
    ['an unknown artwork mode', { artworkMode: 'banner' }],
    ['encountered artwork on a hunt key', { artworkMode: 'encountered' }],
    ['custom artwork without a path', { artworkMode: 'custom' }],
    ['blank flavor text', { flavorText: '   ' }],
    ['over-long flavor text', { flavorText: 'x'.repeat(501) }],
  ])('refuses %s', async (_label, values) => {
    await expect(insert(values as never)).rejects.toBeTruthy();
  });

  it('accepts encountered artwork for a release', async () => {
    await expect(
      insert({ presentationKey: 'encounter.released', artworkMode: 'encountered' }),
    ).resolves.toBeDefined();
  });
});

describe('ResultPresentationService', () => {
  const service = () =>
    createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0, rng: seededRng(1) });

  it('validates and stores a variant, normalising its text', async () => {
    const svc = service();
    const stored = await svc.createVariant({
      presentationKey: 'hunt.nothing_found',
      flavorText: '  The trail goes cold.\r\n',
      weight: 3,
    });
    expect(stored).toMatchObject({
      presentationKey: 'hunt.nothing_found',
      flavorText: 'The trail goes cold.',
      weight: 3,
      enabled: true,
      artworkMode: 'none',
      artworkPath: null,
    });
    await expect(
      svc.createVariant({ presentationKey: 'hunt.item_find', artworkMode: 'encountered' }),
    ).rejects.toBeInstanceOf(ResultPresentationValidationError);
    await expect(
      svc.createVariant({
        presentationKey: 'hunt.item_find',
        artworkMode: 'custom',
        artworkPath: '../escape.png',
      }),
    ).rejects.toBeInstanceOf(ResultPresentationValidationError);
  });

  it('serves only enabled variants for the requested key', async () => {
    const svc = service();
    const on = await svc.createVariant({ presentationKey: 'hunt.item_find', flavorText: 'on' });
    await svc.createVariant({ presentationKey: 'hunt.item_find', flavorText: 'off', enabled: false });
    await svc.createVariant({ presentationKey: 'hunt.essence_find', flavorText: 'other' });

    const variants = await svc.getEnabledVariants('hunt.item_find');
    expect(variants.map((v) => v.id)).toEqual([on.id]);
    expect((await svc.resolve('hunt.item_find')).variantId).toBe(on.id);
  });

  it('falls back to the built-in presentation with no enabled variant', async () => {
    const resolved = await service().resolve('hunt.nothing_found', {
      fallbackFlavorLines: app.content.tables.hunt.flavor,
    });
    expect(resolved.usedFallback).toBe(true);
    expect(app.content.tables.hunt.flavor).toContain(resolved.flavorText);
  });

  it('caches reads, and sees its own writes immediately', async () => {
    const svc = createResultPresentationService({
      db: t.db,
      logger: t.logger,
      ttlMs: 60_000,
      rng: seededRng(1),
    });
    expect(await svc.getEnabledVariants('hunt.item_find')).toEqual([]);

    // A write from elsewhere is not seen until the cache expires…
    await t.db
      .insert(resultPresentationVariants)
      .values({ presentationKey: 'hunt.item_find', flavorText: 'external' });
    expect(await svc.getEnabledVariants('hunt.item_find')).toEqual([]);
    svc.invalidate();
    expect(await svc.getEnabledVariants('hunt.item_find')).toHaveLength(1);

    // …but this process's own write refreshes it.
    await svc.createVariant({ presentationKey: 'hunt.item_find', flavorText: 'mine' });
    expect(await svc.getEnabledVariants('hunt.item_find')).toHaveLength(2);
  });

  it('resolves to the built-in presentation when the table cannot be read', async () => {
    const warn = vi.fn();
    const broken = {
      select: () => {
        throw new Error('relation does not exist');
      },
    } as unknown as Db;
    const svc = createResultPresentationService({
      db: broken,
      logger: { ...t.logger, warn } as never,
      ttlMs: 0,
      rng: seededRng(1),
    });
    const resolved = await svc.resolve('encounter.released', { fallbackFlavorLines: ['bye'] });
    expect(resolved).toMatchObject({ usedFallback: true, flavorText: 'bye', artworkMode: 'encountered' });
    expect(warn).toHaveBeenCalled();
  });
});

describe('gameplay RNG isolation', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-rp-rng', 'u-rp-rng'));
  });
  beforeEach(() => resetPlayer(playerId));

  it('a "nothing found" hunt draws exactly once from the gameplay RNG', async () => {
    const rng = counting(scriptedRng([0.999]));
    const result = await huntServiceWith(rng).hunt(playerId, 'c-rng');
    expect(result.kind).toBe('flavor');
    expect(rng.draws).toBe(1);
    expect(result).not.toHaveProperty('text');
  });

  it('a missing item still degrades to "nothing found" without an extra draw', async () => {
    const silk = await getItemBySlug(t.db, 'silk_charm');
    await t.db.update(items).set({ enabled: false }).where(eq(items.id, silk.id));
    try {
      // 0.78 → item_find in the shipped table; 0.99 → silk_charm in its sub-table.
      const rng = counting(scriptedRng([0.78, 0.99]));
      const result = await huntServiceWith(rng).hunt(playerId, 'c-rng');
      expect(result.kind).toBe('flavor');
      expect(rng.draws).toBe(2);
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.id, silk.id));
    }
  });

  /**
   * One seeded hunt session, presenting every result the way the Discord
   * handler does (with a *separate* presentation RNG), and returning only
   * what gameplay decided.
   */
  async function session(seed: number, presentationSeed: number) {
    await resetPlayer(playerId);
    const hunts = huntServiceWith(seededRng(seed));
    const presentation = createResultPresentationService({
      db: t.db,
      logger: t.logger,
      ttlMs: 0,
      rng: seededRng(presentationSeed),
    });
    const outcomes: unknown[] = [];
    const start = Date.parse('2026-09-01T00:00:00Z');
    for (let n = 0; n < 60; n++) {
      const now = new Date(start + n * 60_000);
      const result: HuntResult = await hunts.hunt(playerId, 'c-rng', now);
      if (result.kind === 'encounter') {
        outcomes.push({ kind: result.kind, species: result.species.id });
        await app.hunt.letHerGo(playerId, result.encounter.id, now);
        await presentation.resolve('encounter.released', { fallbackFlavorLines: ['bye'] });
        continue;
      }
      const key: ResultPresentationKey =
        result.kind === 'flavor' ? 'hunt.nothing_found' : `hunt.${result.kind}`;
      await presentation.resolve(key, { fallbackFlavorLines: app.content.tables.hunt.flavor });
      outcomes.push({
        kind: result.kind,
        energy: result.energyRemaining,
        ...(result.kind === 'waifubux_find' || result.kind === 'essence_find'
          ? { amount: result.amount, balance: result.balanceAfter }
          : {}),
        ...(result.kind === 'item_find' || result.kind === 'rare_item_find'
          ? { item: result.item.slug, quantity: result.quantity }
          : {}),
      });
    }
    return outcomes;
  }

  it('gives identical gameplay whether variants exist, are reweighted or disabled', async () => {
    const baseline = await session(2024, 1);
    // The sequence is only meaningful if it covers several outcome kinds.
    const kinds = new Set(baseline.map((o) => (o as { kind: string }).kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);

    const svc = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    for (const presentationKey of RESULT_PRESENTATION_KEYS) {
      for (let w = 1; w <= 3; w++) {
        await svc.createVariant({ presentationKey, weight: w * 7, flavorText: `${presentationKey} #${w}` });
      }
    }
    expect(await session(2024, 99)).toEqual(baseline);

    await t.db.update(resultPresentationVariants).set({ weight: 1000 });
    expect(await session(2024, 5)).toEqual(baseline);

    await t.db.update(resultPresentationVariants).set({ enabled: false });
    expect(await session(2024, 1)).toEqual(baseline);
  });
});

describe('Let Her Go only releases', () => {
  let playerId: number;
  let guildDbId: number;
  const channelId = 'c-release';

  beforeAll(async () => {
    ({ playerId, guildDbId } = await provisionPlayer(app, 'g-rp-release', 'u-rp-release'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    await t.db
      .delete(activeWorldEncounters)
      .where(eq(activeWorldEncounters.playerId, playerId));
  });

  function releaseCtx(): AppContext {
    return {
      config: { assetsDir: process.cwd() },
      logger: t.logger,
      db: t.db,
      content: app.content,
      services: {
        hunt: app.hunt,
        appearance: app.appearance,
        resultPresentation: createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 }),
      },
    } as unknown as AppContext;
  }

  function buttonInteraction() {
    const update = vi.fn(async (_body: unknown) => {});
    return {
      update,
      interaction: {
        channelId,
        replied: false,
        deferred: false,
        user: { id: 'u-rp-release' },
        isButton: () => true,
        isStringSelectMenu: () => false,
        update,
      },
    };
  }

  async function snapshot() {
    const balances = await app.currency.getBalances(playerId);
    const basic = await getItemBySlug(t.db, 'basic_charm');
    return {
      waifubux: balances.waifubux,
      essence: balances.essence,
      energy: balances.huntEnergy,
      basicCharms: await app.inventory.getQuantity(playerId, basic.id),
      charges: (await app.effects.getCaptureBonus(playerId))?.chargesRemaining ?? null,
    };
  }

  async function expectReleasedCleanly(encounterId: number, before: Awaited<ReturnType<typeof snapshot>>) {
    const [row] = await t.db.select().from(encounters).where(eq(encounters.id, encounterId));
    expect(row!.state).toBe('released');
    expect(row!.resolvedAt).not.toBeNull();
    const attempts = await t.db
      .select()
      .from(captureAttempts)
      .where(eq(captureAttempts.encounterId, encounterId));
    expect(attempts).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  }

  async function prepareInventory(encounterId: number) {
    const basic = await getItemBySlug(t.db, 'basic_charm');
    const microdose = await getItemBySlug(t.db, 'microdose');
    await app.inventory.addItem(t.db, playerId, basic.id, 2);
    await app.inventory.addItem(t.db, playerId, microdose.id, 1);
    await app.itemUse.use(playerId, 'microdose');
    // A selected charm is spent only on Capture — releasing must not spend it.
    await app.capture.selectCaptureItem(playerId, encounterId, 'basic_charm');
  }

  it('for a hunted encounter, through the Discord handler', async () => {
    const hunted = await huntServiceWith(scriptedRng([0.0, 0.0, 0.0])).hunt(playerId, channelId);
    if (hunted.kind !== 'encounter') throw new Error(`expected an encounter, got ${hunted.kind}`);
    await prepareInventory(hunted.encounter.id);
    const before = await snapshot();

    const { interaction, update } = buttonInteraction();
    await handleEncounterRelease(
      releaseCtx(),
      interaction as never,
      { playerId, guildDbId } as unknown as Provisioned,
      [String(hunted.encounter.id)],
    );

    await expectReleasedCleanly(hunted.encounter.id, before);
    const body = JSON.stringify(update.mock.calls[0]![0]);
    expect(body).toContain(`You let ${hunted.species.name} go`);
    expect(body).toContain('You let her slip back into the neon~');
  });

  it('for a Waifumon spawned by a World Encounter', async () => {
    const spawn = await app.wildEncounters.createWildEncounter({
      playerId,
      channelId,
      speciesSlug: 'alley_catgirl',
      regionId: 'waifu-valley',
      origin: { kind: 'world_encounter', ref: `rp-${Date.now()}` },
    });
    if (spawn.status !== 'created') throw new Error(`spawn ${spawn.status}`);
    await prepareInventory(spawn.encounter.id);
    const before = await snapshot();

    const { interaction, update } = buttonInteraction();
    await handleEncounterRelease(
      releaseCtx(),
      interaction as never,
      { playerId, guildDbId } as unknown as Provisioned,
      [String(spawn.encounter.id)],
    );

    await expectReleasedCleanly(spawn.encounter.id, before);
    expect(JSON.stringify(update.mock.calls[0]![0])).toContain(`You let ${spawn.species.name} go`);
  });
});

describe('a World Encounter takes the hunt’s turn', () => {
  let playerId: number;
  let guildDbId: number;

  beforeAll(async () => {
    ({ playerId, guildDbId } = await provisionPlayer(app, 'g-rp-we', 'u-rp-we'));
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
    await t.db.delete(worldEncounterCooldowns).where(eq(worldEncounterCooldowns.playerId, playerId));
    await t.db.delete(worldEncounterSettings);
    app.worldEncounterSettings.invalidate();
    await app.worldEncounterSettings.update({ huntChance: 1, forceTrigger: true }, null);
  });
  afterAll(async () => {
    await t.db.delete(worldEncounterSettings);
    app.worldEncounterSettings.invalidate();
  });

  it('shows the granted WaifuBux under "Along the way" and grants them once', async () => {
    // 0.85 → waifubux_find in the shipped table, then the amount draw.
    const hunts = huntServiceWith(scriptedRng([0.85, 0.5]));
    const harness = createEventHarness(app, t.logger);
    const presentation = createResultPresentationService({ db: t.db, logger: t.logger, ttlMs: 0 });
    await presentation.createVariant({
      presentationKey: 'hunt.waifubux_find',
      flavorText: 'Should not be shown here.',
      artworkMode: 'custom',
      artworkPath: 'placeholder.png',
    });
    const ctx = {
      config: { assetsDir: `${process.cwd()}/assets` },
      logger: t.logger,
      db: t.db,
      content: app.content,
      events: harness.bus,
      huntSessions: harness.huntSessions,
      services: {
        hunt: hunts,
        session: app.session,
        travel: app.travel,
        worldEncounter: app.worldEncounter,
        worldEncounterSettings: app.worldEncounterSettings,
        resultPresentation: presentation,
      },
    } as unknown as AppContext;
    const update = vi.fn(async (_body: unknown) => {});
    const interaction = {
      channelId: 'c-we',
      replied: false,
      deferred: false,
      user: { id: 'u-rp-we' },
      guildId: null,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => false,
      update,
    };

    const before = await app.currency.getBalances(playerId);
    await handleHunt(ctx, interaction as never, { playerId, guildDbId } as unknown as Provisioned);
    const after = await app.currency.getBalances(playerId);
    const granted = after.waifubux - before.waifubux;
    expect(granted).toBeGreaterThanOrEqual(app.content.tables.hunt.waifubuxFind.min);
    expect(granted).toBeLessThanOrEqual(app.content.tables.hunt.waifubuxFind.max);

    // One screen: the encounter, carrying the reward it interrupted.
    expect(update).toHaveBeenCalledTimes(1);
    const body = update.mock.calls[0]![0] as { embeds: unknown[]; files: unknown[] };
    const embed = JSON.parse(JSON.stringify(body.embeds[0])) as {
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.fields).toContainEqual(
      expect.objectContaining({ name: 'Along the way', value: `💰 +${granted} WaifuBux` }),
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain('Should not be shown here.');
    expect(text).not.toContain('WaifuBux Found');
    // The find's custom artwork never joins the encounter's own.
    const names = (body.files ?? []).map((f) => (f as { name: string | null }).name);
    expect(names.filter((n) => n?.startsWith('result_'))).toEqual([]);

    const [pending] = await t.db
      .select()
      .from(activeWorldEncounters)
      .where(and(eq(activeWorldEncounters.playerId, playerId)));
    expect(pending).toBeDefined();
  });
});
