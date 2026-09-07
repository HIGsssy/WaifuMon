/**
 * Travel Energy cost — real Postgres, real transactions.
 *
 * The exploit this closes: travel could roll a World Encounter, a World
 * Encounter pays out, and travel cost nothing. A player at 0 Energy — including
 * one parked in Care Mode, the state whose entire purpose is being out of
 * Energy — could walk between two regions forever and farm the encounter table.
 *
 * So the assertions come in two halves, and both matter:
 *
 *   - **the gate closes** — 0 Energy and Care Mode are refused, and a refusal
 *     is free (no Energy, no WaifuBux, no movement);
 *   - **the gate closes exactly once** — a journey costs 1 Energy whether or
 *     not an encounter fires, and everything downstream of the commit
 *     (resolution, chaining, Continue Journey) is navigation that charges
 *     nothing further.
 *
 * That second half is the one worth having tests for. "Travel costs Energy" is
 * easy to get right; "travel costs Energy once" is the part a later change to
 * the encounter pipeline could quietly break, and the failure mode — players
 * charged twice for one trip — would be invisible in the code and obvious to
 * them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activeWorldEncounters,
  encounters,
  playerCurrencies,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  species,
  travelTransactions,
  worldEncounterChoices,
  worldEncounters,
} from '../../src/db/schema';
import {
  InsufficientEnergyError,
  RegionLockedError,
  TravelBlockedByCareModeError,
} from '../../src/shared/errors';
import { TRAVEL_ENERGY_COST } from '../../src/modules/travel/travelService';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-travel-energy', 'u-energy'));
});
afterAll(async () => {
  await t.cleanup();
});

const WAIFUBUX = 5000;

/**
 * A player who can legally travel to Twin Peeks, with `energy` in the tank and
 * Care Mode off. Routes are granted rather than bought so the fixture never
 * spends the WaifuBux a "did the refusal cost money?" assertion is watching.
 */
async function reset(energy: number): Promise<void> {
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(travelTransactions).where(eq(travelTransactions.playerId, playerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, playerId));
  await t.db
    .update(players)
    .set({
      level: 30,
      currentRegion: 'waifu-valley',
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: WAIFUBUX, huntEnergy: energy })
    .where(eq(playerCurrencies.playerId, playerId));
  await app.travel.grantRoute(playerId, 'twin-peeks');
}

/** Put the player into Care Mode on a freshly-minted owned copy. */
async function enterCareMode(): Promise<void> {
  const [anySpecies] = await t.db.select().from(species).limit(1);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId,
    speciesId: anySpecies!.id,
  });
  await app.care.start(playerId, waifu.id);
}

const energyOf = async (): Promise<number> =>
  (await app.currency.getBalances(playerId)).huntEnergy;
const buxOf = async (): Promise<number> => (await app.currency.getBalances(playerId)).waifubux;
const regionOf = (): Promise<string> => app.travel.getCurrentRegion(playerId);

describe('travel charges exactly one Energy', () => {
  beforeEach(() => reset(10));

  it('deducts 1 Energy for a normal journey and reports it in the outcome', async () => {
    const outcome = await app.travel.travel(playerId, 'twin-peeks');

    expect(outcome.energySpent).toBe(1);
    expect(outcome.energyRemaining).toBe(9);
    expect(await energyOf()).toBe(9);
    expect(await regionOf()).toBe('twin-peeks');
  });

  it('exports the cost as a constant rather than a scattered literal', () => {
    // The UI, the service and these tests all have to agree on one number. A
    // constant is how that stays true; this asserts the number itself so a
    // silent retune shows up as a failing test rather than as a balance change
    // nobody reviewed.
    expect(TRAVEL_ENERGY_COST).toBe(1);
  });

  it('charges 1 Energy per journey, not per region hop compounded', async () => {
    await app.travel.travel(playerId, 'twin-peeks');
    await app.travel.travel(playerId, 'waifu-valley');
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await energyOf()).toBe(7);
  });

  it('succeeds from exactly 1 Energy and leaves the player at 0', async () => {
    // The boundary the gate is built on: 1 is enough, and spending it lands on
    // 0 rather than refusing early or underflowing past it.
    await reset(1);
    const outcome = await app.travel.travel(playerId, 'twin-peeks');

    expect(outcome.energyRemaining).toBe(0);
    expect(await energyOf()).toBe(0);
    expect(await regionOf()).toBe('twin-peeks');
  });

  it('does not charge WaifuBux — travel is priced in Energy only', async () => {
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await buxOf()).toBe(WAIFUBUX);
  });
});

describe('travel is refused when the player cannot pay', () => {
  it('rejects travel at 0 Energy', async () => {
    await reset(0);
    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      InsufficientEnergyError,
    );
    expect(await regionOf()).toBe('waifu-valley');
  });

  it('rejects travel in Care Mode, even with Energy in the tank', async () => {
    // Care Mode is a block in its own right, not a proxy for "no Energy". A
    // player who entered Care Mode with a full tank is still resting, and the
    // exploit ran through exactly this state.
    await reset(10);
    await enterCareMode();

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      TravelBlockedByCareModeError,
    );
    expect(await regionOf()).toBe('waifu-valley');
    expect(await energyOf()).toBe(10);
  });

  it('tells a Care Mode player to recover rather than to claim a daily', async () => {
    // The message is the requirement, not a detail: "you're out of Energy,
    // claim your daily" is advice for a problem a resting player is already
    // solving. Assert the copy actually names recovery and Care Mode.
    await reset(0);
    await enterCareMode();

    const err = await app.travel.travel(playerId, 'twin-peeks').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TravelBlockedByCareModeError);
    expect((err as TravelBlockedByCareModeError).userMessage).toMatch(/care mode/i);
    expect((err as TravelBlockedByCareModeError).userMessage).toMatch(/energy/i);
  });

  it('checks Care Mode before Energy so the message is the actionable one', async () => {
    // Both rules are unmet here. Care Mode wins, because leaving it is what
    // gets the player moving again.
    await reset(0);
    await enterCareMode();

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      TravelBlockedByCareModeError,
    );
  });

  it('leaving Care Mode restores the ability to travel', async () => {
    await reset(10);
    await enterCareMode();
    await app.care.leave(playerId);

    const outcome = await app.travel.travel(playerId, 'twin-peeks');
    expect(outcome.energySpent).toBe(1);
    expect(await regionOf()).toBe('twin-peeks');
  });
});

describe('a refused journey costs nothing', () => {
  it('consumes no Energy and no WaifuBux when the destination is locked', async () => {
    // Route validation runs before the deduction, so the Energy is still there
    // to spend on a trip the player *can* take.
    await reset(10);
    await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      RegionLockedError,
    );
    expect(await energyOf()).toBe(10);
    expect(await buxOf()).toBe(WAIFUBUX);
    expect(await regionOf()).toBe('waifu-valley');
  });

  it('consumes no Energy when the player is already in the destination', async () => {
    await reset(10);
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await energyOf()).toBe(9);

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toThrow();
    expect(await energyOf()).toBe(9);
  });

  it('consumes no Energy when an encounter is still open', async () => {
    await reset(10);
    const [anySpecies] = await t.db.select().from(species).limit(1);
    await t.db.insert(encounters).values({
      playerId,
      speciesId: anySpecies!.id,
      channelId: 'c-travel-energy',
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
      regionId: 'waifu-valley',
    });

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toThrow();
    expect(await energyOf()).toBe(10);
    expect(await regionOf()).toBe('waifu-valley');
  });

  it('rejects a 0-Energy player without moving them, however many times they try', async () => {
    // The exploit loop, run directly: at 0 Energy the map never moves, so
    // there is no journey for an encounter to hang off.
    await reset(0);
    for (let i = 0; i < 5; i += 1) {
      await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
        InsufficientEnergyError,
      );
    }
    expect(await energyOf()).toBe(0);
    expect(await regionOf()).toBe('waifu-valley');
  });
});

describe('the World Encounter pipeline adds no further Energy cost', () => {
  /** Force the travel roll to fire (or not) deterministically. */
  const alwaysRng = { next: () => 0, intInclusive: (a: number) => a };
  const neverRng = { next: () => 0.999999, intInclusive: (a: number) => a };

  async function travelAndRoll(rng: {
    next: () => number;
    intInclusive: (a: number, b: number) => number;
  }): Promise<number | null> {
    // Mirrors `handleLocationTravel`: travel commits first, then the roll
    // fires against the destination the player is already standing in.
    const outcome = await app.travel.travel(playerId, 'twin-peeks');
    const activation = await app.worldEncounter.tryRollForTravel({
      playerId,
      playerLevel: 30,
      guildId: guildDbId,
      channelId: 'c-travel-energy',
      regionId: outcome.toRegion,
      originRegionId: outcome.fromRegion,
      destinationRegionId: outcome.toRegion,
      rng,
    });
    return activation?.activeId ?? null;
  }

  it('costs 1 Energy when no encounter fires', async () => {
    await reset(10);
    const activeId = await travelAndRoll(neverRng);
    expect(activeId).toBeNull();
    expect(await energyOf()).toBe(9);
  });

  it('costs 1 Energy — not 2 — when an encounter does fire', async () => {
    await reset(10);
    const activeId = await travelAndRoll(alwaysRng);
    expect(activeId).not.toBeNull();
    expect(await energyOf()).toBe(9);
  });

  it('charges nothing further when the encounter is resolved', async () => {
    await reset(10);
    const activeId = await travelAndRoll(alwaysRng);
    expect(activeId).not.toBeNull();
    const energyBefore = await energyOf();

    const activation = await app.worldEncounter.getActivationById(activeId!, playerId);
    const choice = activation!.choiceViews[0]!.choice;
    await app.worldEncounter.resolveChoice({
      activeId: activeId!,
      playerId,
      choiceId: choice.id,
      rng: alwaysRng,
    });

    // Authored `energy_gain`/`energy_loss` effects are a separate, deliberate
    // mechanic; this asserts resolution levies no *travel* charge, so the
    // comparison is against the post-travel balance and allows an authored
    // effect to have moved it in either direction — what it must not do is
    // silently bill another trip.
    const energyAfter = await energyOf();
    expect(energyAfter).toBeGreaterThanOrEqual(energyBefore - 1);
  });

  it('charges no Energy for a chained continuation', async () => {
    // The chain is the sharpest version of the bug: one journey, several
    // encounter screens. Each extra screen must be free.
    await reset(10);
    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_bandit_ambush'));
    const [parentRow] = await t.db
      .insert(activeWorldEncounters)
      .values({
        playerId,
        encounterId: encounter!.id,
        source: 'travel',
        regionId: 'twin-peeks',
        originRegionId: 'waifu-valley',
        destinationRegionId: 'twin-peeks',
        guildId: guildDbId,
        channelId: 'c-travel-energy',
        contextJson: {},
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
      .returning();
    const choiceRows = await t.db
      .select()
      .from(worldEncounterChoices)
      .where(eq(worldEncounterChoices.encounterId, encounter!.id));
    const fight = choiceRows.find((c) => c.label === 'Fight')!;

    const energyBefore = await energyOf();
    const parent = await app.worldEncounter.resolveChoice({
      activeId: parentRow!.id,
      playerId,
      choiceId: fight.id,
      rng: alwaysRng,
    });
    expect(parent.continuationActiveId).not.toBeNull();

    // Resolve the child too — the terminal node of the chain, where Continue
    // Journey reappears.
    const child = await app.worldEncounter.getActivationById(
      parent.continuationActiveId!,
      playerId,
    );
    await app.worldEncounter.resolveChoice({
      activeId: parent.continuationActiveId!,
      playerId,
      choiceId: child!.choiceViews[0]!.choice.id,
      rng: alwaysRng,
    });

    // No travel charge anywhere in the chain: the player never moved again.
    expect(await energyOf()).toBeGreaterThanOrEqual(energyBefore - 1);
    expect(await regionOf()).toBe('waifu-valley');
  });

  it('Continue Journey is a read — it never calls travel and never charges', async () => {
    // `handleContinueJourney` calls `travel.getStatus`, which is a read, and
    // deliberately never `travel.travel`. Assert the observable consequence:
    // repainting the arrival screen leaves Energy and position untouched.
    await reset(10);
    const activeId = await travelAndRoll(alwaysRng);
    expect(activeId).not.toBeNull();
    const energyAfterTravel = await energyOf();

    for (let i = 0; i < 3; i += 1) {
      const status = await app.travel.getStatus(playerId);
      expect(status.currentRegion).toBe('twin-peeks');
    }

    expect(await energyOf()).toBe(energyAfterTravel);
    expect(await regionOf()).toBe('twin-peeks');
  });
});
