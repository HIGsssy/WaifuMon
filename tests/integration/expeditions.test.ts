/**
 * Expeditions Phase 3 — the engine, against a real database.
 *
 * No Discord code exists for this feature yet, which is the point: everything
 * below drives the service directly, so the domain is proven before a single
 * button is drawn.
 *
 * The claims worth the most scrutiny, and the ones most of this file is about:
 *
 *   - a mission resolves **exactly once**, however many times it is read;
 *   - rewards are granted **exactly once**, however many times Collect is hit;
 *   - a bot restart mid-flight is ordinary, not recovery;
 *   - a content deploy cannot change what an in-flight mission pays;
 *   - a deployed copy cannot be released, made Buddy, cared for, or sent again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  items,
  playerCurrencies,
  playerExpeditions,
  players,
  playerUnlockedRoutes,
  playerWaifus,
  species as speciesTable,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  ExpeditionAlreadyClaimedError,
  ExpeditionNotCancellableError,
  ExpeditionNotCompleteError,
  ExpeditionNotFoundError,
  ExpeditionRegionBusyError,
  ExpeditionsDisabledError,
  ExpeditionWrongRegionError,
  WaifuReleaseBlockedError,
  WaifuUnavailableError,
} from '../../src/shared/errors';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionsConfigSchema,
  MATCH_QUALITIES,
  type ExpeditionRewardTable,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';
import { createExpeditionService } from '../../src/modules/expeditions/expeditionService';
import {
  createCoreAvailabilityProvider,
  createWaifuAvailabilityService,
} from '../../src/modules/collection/waifuAvailability';
import { raceResolverFromContent } from '../../src/modules/encounters/speciesSelection';
import {
  bootstrapApp,
  forceRegion,
  insertOwnedWaifu,
  loadShippedContent,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let demonSpecies: SpeciesRow;

/** Items the reward tables below name. Phase 5 authors the real ones. */
async function seedRewardItems() {
  for (const slug of ['exp_scrap', 'exp_relic', 'exp_map']) {
    await t.db
      .insert(items)
      .values({ slug, name: slug, category: 'salvage', sellValue: 10 })
      .onConflictDoNothing();
  }
}

function definition(over: Record<string, unknown> = {}): RegionalExpedition {
  const { region = 'waifu-valley', ...rest } = over;
  return {
    ...ExpeditionDefinitionSchema.parse({
      key: 'test_run',
      name: 'Test Run',
      description: 'A test.',
      type: 'supply_run',
      durationMinutes: 360,
      recommendedLevel: 10,
      baseSuccessChance: 0.5,
      rewardTable: 'test_success',
      exceptionalRewardTable: 'test_bonus',
      failureRewardTable: 'test_failure',
      ...rest,
    }),
    region: region as RegionalExpedition['region'],
  };
}

/**
 * One mission on every configured tier, with `over` applied to the 6h one.
 *
 * The board draws one mission per duration tier, so a region that appears on a
 * board at all has to cover the whole ladder — a single-mission region is a
 * content error now, not a minimal fixture. `test_run` stays the 6h mission so
 * every deployment test still names it.
 */
function completePool(over: Record<string, unknown> = {}): RegionalExpedition[] {
  return [
    definition({ key: 'test_run_quick', durationMinutes: 60 }),
    definition({ key: 'test_run_short', durationMinutes: 180 }),
    definition(over),
    definition({ key: 'test_run_night', durationMinutes: 1080 }),
  ];
}

/** The keys `completePool` puts on a board, in display order. */
const POOL_KEYS = ['test_run_quick', 'test_run_short', 'test_run', 'test_run_night'];

/** The configured ladder, which every participating region must cover. */
const TIERS = [60, 180, 360, 1080];

/**
 * A full ladder for one region, keyed `<prefix>_<minutes>`.
 *
 * Regional concurrency is only testable against more than one region, and a
 * region that appears on a board at all has to cover every duration tier — so
 * "a second region" means four missions, not one.
 */
function poolFor(region: string, prefix: string): RegionalExpedition[] {
  return TIERS.map((minutes) =>
    definition({ key: `${prefix}_${minutes}`, region, durationMinutes: minutes }),
  );
}

/** Waifu Valley and Twin Peeks, both fully authored. */
function twoRegionPool(): RegionalExpedition[] {
  return [...completePool(), ...poolFor('twin-peeks', 'peeks')];
}

function rewardTable(over: Record<string, unknown> = {}): ExpeditionRewardTable {
  return ExpeditionRewardTableSchema.parse({
    id: 'test_success',
    waifubux: { min: 200, max: 200 },
    essence: { min: 2, max: 2 },
    waifuXp: 80,
    groups: [
      {
        id: 'salvage',
        chanceBasisPoints: 10000,
        entries: [{ itemId: 'exp_scrap', weight: 1, quantity: 2 }],
      },
    ],
    ...over,
  });
}

/**
 * Install expedition content on the live snapshot.
 *
 * `bootstrapApp` wires the service with `getContent: () => content`, the same
 * closure production uses, so editing the snapshot in place is exactly what an
 * admin content reload looks like from the service's side.
 */
function installContent(
  expeditions: RegionalExpedition[],
  tables: ExpeditionRewardTable[],
  config: Record<string, unknown> = {},
) {
  app.content.expeditions = expeditions;
  app.content.expeditionRewards = tables;
  // Rebuilt from the schema defaults every time rather than merged into
  // whatever the previous test left behind: a merge lets one test's
  // `buddyDeployable` leak into the next, which is the kind of failure that
  // shows up as an unrelated assertion three tests later.
  app.content.tables.expeditions = ExpeditionsConfigSchema.parse(config);
}

const DEFAULT_TABLES = [
  rewardTable(),
  rewardTable({
    id: 'test_bonus',
    waifubux: { min: 500, max: 500 },
    essence: { min: 3, max: 3 },
    waifuXp: 40,
    groups: [
      {
        id: 'rare',
        chanceBasisPoints: 10000,
        entries: [{ itemId: 'exp_map', weight: 1, quantity: 1 }],
      },
    ],
  }),
  rewardTable({
    id: 'test_failure',
    waifubux: { min: 25, max: 25 },
    essence: undefined,
    waifuXp: 10,
    groups: [],
  }),
];

let userSeq = 0;
/** A player with one deployable level-10 demon copy. */
async function playerWithWaifu(level = 10) {
  userSeq += 1;
  const { playerId } = await provisionPlayer(app, 'g-exp', `u-exp-${userSeq}`);
  const waifu = await insertOwnedWaifu(t.db, {
    playerId,
    speciesId: demonSpecies.id,
    level,
  });
  return { playerId, waifuId: waifu.id };
}

/** Move a mission's finish line into the past, as if time had passed. */
async function timeTravel(expeditionId: number) {
  await t.db
    .update(playerExpeditions)
    .set({ completesAt: sql`now() - interval '1 minute'` })
    .where(eq(playerExpeditions.id, expeditionId));
}

/** Force a mission's outcome by pinning the chance it is resolved against. */
async function forceOutcome(expeditionId: number, kind: 'success' | 'failure' | 'exceptional') {
  await t.db
    .update(playerExpeditions)
    .set({
      successChance: kind === 'failure' ? 0 : 1,
      exceptionalChance: kind === 'exceptional' ? 1 : 0,
    })
    .where(eq(playerExpeditions.id, expeditionId));
}

const rowOf = async (id: number) => {
  const [row] = await t.db
    .select()
    .from(playerExpeditions)
    .where(eq(playerExpeditions.id, id));
  return row!;
};

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  await seedRewardItems();
  const [demon] = await t.db
    .select()
    .from(speciesTable)
    .where(eq(speciesTable.affinity, 'dominant'))
    .limit(1);
  demonSpecies = demon!;
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(() => {
  installContent(completePool(), DEFAULT_TABLES, { enabled: true });
});

describe('the board', () => {
  it('shows the region’s missions and a rotation deadline', async () => {
    const { playerId } = await playerWithWaifu();
    const board = await app.expeditions.getBoard(playerId);
    expect(board.regionId).toBe('waifu-valley');
    expect(board.entries.map((e) => e.definition.key)).toEqual(POOL_KEYS);
    expect(board.rotatesAt.getTime()).toBeGreaterThan(Date.now());
    expect(board.regionMission).toBeNull();
    expect(board.elsewhere).toEqual([]);
    expect(board.canDeploy).toBe(true);
  });

  // Selection is the hash sort; presentation is shortest first. Playtesting
  // saw 2h → 12h → 6h before this.
  it('lists the selected missions shortest first', async () => {
    installContent(
      [
        definition({ key: 'night_run', durationMinutes: 1080 }),
        definition({ key: 'mid_run', durationMinutes: 360 }),
        definition({ key: 'quick_run', durationMinutes: 60 }),
        definition({ key: 'short_run', durationMinutes: 180 }),
      ],
      DEFAULT_TABLES,
    );
    const { playerId } = await playerWithWaifu();
    const board = await app.expeditions.getBoard(playerId);
    expect(board.entries.map((e) => e.definition.key)).toEqual([
      'quick_run',
      'short_run',
      'mid_run',
      'night_run',
    ]);
    // Reading it again gives the same board.
    const again = await app.expeditions.getBoard(playerId);
    expect(again.entries.map((e) => e.definition.key)).toEqual(
      board.entries.map((e) => e.definition.key),
    );
  });

  it('is empty, not broken, when the region has no expedition content', async () => {
    installContent([definition({ region: 'thirstlands' })], DEFAULT_TABLES);
    const { playerId } = await playerWithWaifu();
    const board = await app.expeditions.getBoard(playerId);
    expect(board.entries).toEqual([]);
    expect(board.enabled).toBe(true);
  });

  it('reports this region as taken while a mission is running in it', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const board = await app.expeditions.getBoard(playerId);
    expect(board.canDeploy).toBe(false);
    expect(board.regionMission?.waifuId).toBe(waifuId);
    expect(board.regionMission?.region).toBe('waifu-valley');
    // Nothing anywhere else, and the missions on offer are unchanged: a busy
    // region hides no listings, it only refuses deployments.
    expect(board.elsewhere).toEqual([]);
    expect(board.entries.map((e) => e.definition.key)).toEqual(POOL_KEYS);
  });
});

describe('deploying', () => {
  it('starts a mission with a match quality, a finish line and a snapshot', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);

    expect(view.status).toBe('active');
    expect(view.slotIndex).toBe(1);
    expect(view.waifuId).toBe(waifuId);
    expect(view.name).toBe('Test Run');
    expect(MATCH_QUALITIES).toContain(view.match);
    expect(view.secondsRemaining).toBeGreaterThan(0);

    const row = await rowOf(view.id);
    expect(row.resolutionPlan).not.toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.rewards).toBeNull();
    // The persisted label is the match quality the player saw, never a band.
    expect(row.suitabilityBand).toBe(view.match);
    // The finish line is set by the database's clock, not Node's.
    expect(row.completesAt.getTime() - row.startedAt.getTime()).toBeCloseTo(360 * 60 * 1000, -4);
  });

  it('refuses an unknown expedition key', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(app.expeditions.deploy(playerId, 'nope', waifuId)).rejects.toBeInstanceOf(
      ExpeditionNotFoundError,
    );
  });

  it('refuses a disabled expedition', async () => {
    installContent([definition({ enabled: false })], DEFAULT_TABLES);
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(app.expeditions.deploy(playerId, 'test_run', waifuId)).rejects.toBeInstanceOf(
      ExpeditionNotFoundError,
    );
  });

  it('refuses every deployment while the feature is switched off', async () => {
    installContent([definition()], DEFAULT_TABLES, { enabled: false });
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(app.expeditions.deploy(playerId, 'test_run', waifuId)).rejects.toBeInstanceOf(
      ExpeditionsDisabledError,
    );
  });

  it('refuses a second mission in a region that already has one', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await expect(
      app.expeditions.deploy(playerId, 'test_run', second.id),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);
    // Not even a different mission in the same region.
    await expect(
      app.expeditions.deploy(playerId, 'test_run_quick', second.id),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);
  });

  it('refuses a copy already out on a mission', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    // Availability is checked before the region is, so this is the *copy*
    // being refused rather than the region — which is the distinction that
    // matters the moment a second region exists. See the regional-concurrency
    // suite for the same copy refused across regions.
    await expect(
      app.expeditions.deploy(playerId, 'test_run', waifuId),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });

  it('refuses the active Buddy', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.collection.setBuddy(playerId, waifuId);
    await expect(
      app.expeditions.deploy(playerId, 'test_run', waifuId),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });

  it('allows the Buddy when content says she is deployable', async () => {
    installContent([definition()], DEFAULT_TABLES, { buddyDeployable: true });
    const { playerId, waifuId } = await playerWithWaifu();
    await app.collection.setBuddy(playerId, waifuId);
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    expect(view.status).toBe('active');
  });

  it('refuses a copy the player does not own', async () => {
    const { playerId } = await playerWithWaifu();
    const other = await playerWithWaifu();
    await expect(
      app.expeditions.deploy(playerId, 'test_run', other.waifuId),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });

  /**
   * The unique index, not the service-side count, is what makes this safe.
   * Two simultaneous Deploys must produce one mission.
   */
  it('creates exactly one mission when Deploy is double-clicked', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const attempts = await Promise.allSettled([
      app.expeditions.deploy(playerId, 'test_run', waifuId),
      app.expeditions.deploy(playerId, 'test_run', waifuId),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it('writes slot 1 for every mission — the region is the key now', async () => {
    installContent(twoRegionPool(), DEFAULT_TABLES);
    const { playerId, waifuId } = await playerWithWaifu();
    const b = await insertOwnedWaifu(t.db, { playerId, speciesId: demonSpecies.id, level: 10 });
    const first = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const second = await app.expeditions.deploy(playerId, 'peeks_360', b.id);
    expect(first.slotIndex).toBe(1);
    expect(second.slotIndex).toBe(1);
  });
});

describe('candidates', () => {
  it('grades every owned copy and flags the ones that cannot go', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const buddy = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await app.collection.setBuddy(playerId, buddy.id);

    const candidates = await app.expeditions.getCandidates(playerId, 'test_run');
    const free = candidates.find((c) => c.waifuId === waifuId);
    const blocked = candidates.find((c) => c.waifuId === buddy.id);
    expect(free?.unavailableReasons).toEqual([]);
    expect(blocked?.unavailableReasons).toContain('buddy');
    // Deployable copies sort ahead of blocked ones.
    expect(candidates[0]?.waifuId).toBe(waifuId);
    for (const c of candidates) expect(MATCH_QUALITIES).toContain(c.match.quality);
  });

  /**
   * Ordered by what the player reads, not by the hidden chance alone. The
   * caregiver copy has the better odds of the two (0.70 vs 0.66) but meets
   * one requirement of two; the level-8 dominant copy meets affinity and is
   * nearly ready, so she is the stronger match and is listed first.
   */
  it('orders candidates by match quality, then hidden chance, then level, then id', async () => {
    installContent(
      [definition({ preferredAffinities: ['dominant'], preferredRaces: [], recommendedLevel: 10 })],
      DEFAULT_TABLES,
    );
    const [caregiver] = await t.db
      .select()
      .from(speciesTable)
      .where(eq(speciesTable.affinity, 'caregiver'))
      .limit(1);
    const { playerId } = await playerWithWaifu(3); // dominant, badly under-levelled
    const add = async (speciesId: number, level: number) =>
      (await insertOwnedWaifu(t.db, { playerId, speciesId, level })).id;
    const partial = await add(caregiver!.id, 30);
    const strong = await add(demonSpecies.id, 8);
    const perfectA = await add(demonSpecies.id, 10);
    const perfectB = await add(demonSpecies.id, 10);

    const candidates = await app.expeditions.getCandidates(playerId, 'test_run');
    expect(candidates.map((c) => c.match.quality)).toEqual([
      'PERFECT_MATCH',
      'PERFECT_MATCH',
      'STRONG_MATCH',
      'PARTIAL_MATCH',
      'POOR_MATCH',
    ]);
    // Identical twins break on id, oldest first.
    expect(candidates.slice(0, 4).map((c) => c.waifuId)).toEqual([perfectA, perfectB, strong, partial]);
    const byId = new Map(candidates.map((c) => [c.waifuId, c]));
    expect(byId.get(partial)!.successChance).toBeGreaterThan(byId.get(strong)!.successChance);
  });

  it('refuses to list candidates for an unknown mission', async () => {
    const { playerId } = await playerWithWaifu();
    await expect(app.expeditions.getCandidates(playerId, 'nope')).rejects.toBeInstanceOf(
      ExpeditionNotFoundError,
    );
  });
});

describe('resolution', () => {
  it('leaves a mission alone until its finish line passes', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const [active] = await app.expeditions.getActive(playerId);
    expect(active?.status).toBe('active');
    expect(active?.isDue).toBe(false);
    expect((await rowOf(view.id)).resolvedAt).toBeNull();
  });

  it('resolves on the first read after the finish line', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.outcome).not.toBeNull();
    expect(resolved?.rewards).not.toBeNull();
  });

  /**
   * The idempotency claim, tested directly. Five reads, one resolution: the
   * timestamp and the payout must not move after the first.
   */
  it('resolves exactly once however many times it is read', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);

    const first = await app.expeditions.getActive(playerId);
    const firstRow = await rowOf(view.id);
    for (let i = 0; i < 4; i += 1) await app.expeditions.getActive(playerId);
    const afterRow = await rowOf(view.id);

    expect(afterRow.resolvedAt?.getTime()).toBe(firstRow.resolvedAt?.getTime());
    expect(afterRow.outcome).toBe(firstRow.outcome);
    expect(afterRow.rewards).toEqual(firstRow.rewards);
    expect(afterRow.resolutionRoll).toBe(firstRow.resolutionRoll);
    expect(first[0]?.rewards).toEqual(afterRow.rewards);
  });

  it('resolves once under concurrent reads', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);

    await Promise.all(
      Array.from({ length: 5 }, () => app.expeditions.getActive(playerId)),
    );
    const row = await rowOf(view.id);
    expect(row.status).toBe('resolved');
    expect(row.outcome).not.toBeNull();
  });

  it('clears the snapshot once the payout is fixed', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);
    await app.expeditions.getActive(playerId);

    const row = await rowOf(view.id);
    const plan = row.resolutionPlan as {
      definition: { name: string };
      successTable: unknown;
      bonusTable: unknown;
      failureTable: unknown;
    };
    // The tables go — nothing can roll them again.
    expect(plan.successTable).toBeNull();
    expect(plan.bonusTable).toBeNull();
    expect(plan.failureTable).toBeNull();
    // The display block stays, so a finished mission can still name itself
    // even after content deletes the definition.
    expect(plan.definition.name).toBe('Test Run');
    // The audit trail survives too: the payload still names its sources.
    const rewards = row.rewards as { sources: { tableId: string }[] };
    expect(rewards.sources.length).toBeGreaterThan(0);
  });

  it('pays the failure table on a failure', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'failure');
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.outcome).toBe('failure');
    expect(resolved?.rewards?.waifubux).toBe(25);
    expect(resolved?.rewards?.items).toEqual([]);
  });

  it('pays the success table on a success', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.outcome).toBe('success');
    expect(resolved?.rewards?.waifubux).toBe(200);
    expect(resolved?.rewards?.items).toEqual([{ slug: 'exp_scrap', quantity: 2 }]);
  });

  /** The headline rule, end to end through the database. */
  it('pays success PLUS bonus on an exceptional success', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'exceptional');
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.outcome).toBe('exceptional');
    // 200 from success + 500 from bonus.
    expect(resolved?.rewards?.waifubux).toBe(700);
    expect(resolved?.rewards?.essence).toBe(5);
    expect(resolved?.rewards?.waifuXp).toBe(120);
    expect(resolved?.rewards?.items.map((i) => i.slug).sort()).toEqual(['exp_map', 'exp_scrap']);
  });
});

describe('claiming', () => {
  async function resolvedMission(outcome: 'success' | 'failure' | 'exceptional' = 'success') {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, outcome);
    await timeTravel(view.id);
    await app.expeditions.getActive(playerId);
    return { playerId, waifuId, expeditionId: view.id };
  }

  it('grants currency, essence, XP and items in one go', async () => {
    const { playerId, waifuId, expeditionId } = await resolvedMission('success');
    const before = await app.currency.getBalances(playerId);

    const result = await app.expeditions.claim(playerId, expeditionId);

    expect(result.outcome).toBe('success');
    expect(result.waifubuxAfter).toBe(before.waifubux + 200);
    // Essence goes through the shared award path, so the Buddy Bonus applies.
    expect(result.essenceGranted).toBeGreaterThanOrEqual(2);
    expect(result.itemsGranted).toEqual([
      { slug: 'exp_scrap', name: 'exp_scrap', quantity: 2 },
    ]);

    const inventory = await app.inventory.getInventory(playerId);
    expect(inventory.find((e) => e.item.slug === 'exp_scrap')?.quantity).toBe(2);

    const owned = await app.collection.listOwned(playerId);
    const copy = owned.entries.find((e) => e.waifu.id === waifuId);
    expect(copy?.waifu.xp ?? 0).toBeGreaterThan(0);
  });

  it('marks the mission claimed and frees the region', async () => {
    const { playerId, expeditionId } = await resolvedMission();
    await app.expeditions.claim(playerId, expeditionId);

    const row = await rowOf(expeditionId);
    expect(row.status).toBe('claimed');
    expect(row.claimedAt).not.toBeNull();
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
    expect((await app.expeditions.getBoard(playerId)).canDeploy).toBe(true);
  });

  it('refuses a second claim', async () => {
    const { playerId, expeditionId } = await resolvedMission();
    await app.expeditions.claim(playerId, expeditionId);
    await expect(app.expeditions.claim(playerId, expeditionId)).rejects.toBeInstanceOf(
      ExpeditionAlreadyClaimedError,
    );
  });

  /**
   * The one operation that must never double-pay, tested the way it would
   * actually fail: two Collects arriving together.
   */
  it('pays exactly once when Collect is double-clicked', async () => {
    const { playerId, expeditionId } = await resolvedMission('success');
    const before = await app.currency.getBalances(playerId);

    const attempts = await Promise.allSettled([
      app.expeditions.claim(playerId, expeditionId),
      app.expeditions.claim(playerId, expeditionId),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    const after = await app.currency.getBalances(playerId);
    expect(after.waifubux).toBe(before.waifubux + 200);
    const inventory = await app.inventory.getInventory(playerId);
    expect(inventory.find((e) => e.item.slug === 'exp_scrap')?.quantity).toBe(2);
  });

  it('resolves and claims in one press when the mission is already due', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);
    // No intervening read — Collect does the resolving itself.
    const result = await app.expeditions.claim(playerId, view.id);
    expect(result.outcome).toBe('success');
  });

  it('refuses to claim a mission that has not finished', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await expect(app.expeditions.claim(playerId, view.id)).rejects.toBeInstanceOf(
      ExpeditionNotCompleteError,
    );
  });

  it('grants the consolation on a failure', async () => {
    const { playerId, expeditionId } = await resolvedMission('failure');
    const before = await app.currency.getBalances(playerId);
    const result = await app.expeditions.claim(playerId, expeditionId);
    expect(result.outcome).toBe('failure');
    expect(result.waifubuxAfter).toBe(before.waifubux + 25);
  });

  it('appears in history once claimed', async () => {
    const { playerId, expeditionId } = await resolvedMission();
    await app.expeditions.claim(playerId, expeditionId);
    const history = await app.expeditions.getHistory(playerId);
    expect(history.map((h) => h.id)).toContain(expeditionId);
  });
});

describe('cancellation', () => {
  it('returns the copy, rolls nothing and pays nothing', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const before = await app.currency.getBalances(playerId);

    const cancelled = await app.expeditions.cancel(playerId, view.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    // Never rolled: no outcome, no roll, no rewards.
    const row = await rowOf(view.id);
    expect(row.outcome).toBeNull();
    expect(row.resolutionRoll).toBeNull();
    expect(row.rewards).toBeNull();
    expect(row.resolvedAt).toBeNull();
    // Never paid.
    expect(await app.currency.getBalances(playerId)).toEqual(before);
  });

  it('frees the region and the copy immediately', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await app.expeditions.cancel(playerId, view.id);

    expect((await app.expeditions.getBoard(playerId)).canDeploy).toBe(true);
    // The same copy can go straight back out.
    const again = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    expect(again.status).toBe('active');
  });

  it('cannot be used to peek at a result — a cancelled mission never resolves', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await app.expeditions.cancel(playerId, view.id);
    await timeTravel(view.id);

    // Reading after the finish line must not resurrect it.
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
    const row = await rowOf(view.id);
    expect(row.status).toBe('cancelled');
    expect(row.outcome).toBeNull();
  });

  it('refuses to cancel a resolved mission', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);
    await app.expeditions.getActive(playerId);
    await expect(app.expeditions.cancel(playerId, view.id)).rejects.toBeInstanceOf(
      ExpeditionNotCancellableError,
    );
  });

  it('cancels once under concurrent presses', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const attempts = await Promise.allSettled([
      app.expeditions.cancel(playerId, view.id),
      app.expeditions.cancel(playerId, view.id),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  });

  it('appears in history', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await app.expeditions.cancel(playerId, view.id);
    expect((await app.expeditions.getHistory(playerId)).map((h) => h.id)).toContain(view.id);
  });
});

describe('a deployed copy is away', () => {
  async function deployed() {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    return { playerId, waifuId, expeditionId: view.id };
  }

  it('reports her as on_expedition through the shared vocabulary', async () => {
    const { playerId, waifuId } = await deployed();
    const reasons = await app.availability.reasonsFor(t.db, playerId, waifuId);
    expect(reasons).toContain('on_expedition');
  });

  it('cannot be released', async () => {
    const { playerId, waifuId } = await deployed();
    await expect(app.collection.releaseWaifu(playerId, waifuId)).rejects.toBeInstanceOf(
      WaifuReleaseBlockedError,
    );
  });

  it('cannot be made Buddy', async () => {
    const { playerId, waifuId } = await deployed();
    await expect(app.collection.setBuddy(playerId, waifuId)).rejects.toBeInstanceOf(
      WaifuUnavailableError,
    );
  });

  it('cannot be made a Care target', async () => {
    const { playerId, waifuId } = await deployed();
    await expect(app.care.start(playerId, waifuId)).rejects.toBeInstanceOf(
      WaifuUnavailableError,
    );
  });

  it('is free again once the mission is claimed', async () => {
    const { playerId, waifuId, expeditionId } = await deployed();
    await timeTravel(expeditionId);
    await app.expeditions.claim(playerId, expeditionId);

    expect(await app.availability.reasonsFor(t.db, playerId, waifuId)).not.toContain(
      'on_expedition',
    );
    const { player } = await app.collection.setBuddy(playerId, waifuId);
    expect(player.buddyWaifuId).toBe(waifuId);
  });

  // The mirror of "a deployed copy cannot be cared for". Without it the two
  // rules would disagree depending on which order a player did them in.
  it('refuses to deploy the current Care target', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.care.start(playerId, waifuId);
    await expect(
      app.expeditions.deploy(playerId, 'test_run', waifuId),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });
});

describe('an active mission is an immutable contract', () => {
  /**
   * The strongest claim in this phase: once deployed, nothing content does can
   * change what a mission pays. Each test below deletes, disables or retunes
   * the content *underneath* a running mission and asserts it still finishes
   * on the terms it started on.
   */
  it('survives the reward table being retuned', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');

    // A content deploy that triples the payout, mid-flight.
    installContent(
      [definition()],
      [
        rewardTable({ waifubux: { min: 9999, max: 9999 } }),
        ...DEFAULT_TABLES.slice(1),
      ],
    );
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    // The deal she was sent under, not the one authored since.
    expect(resolved?.rewards?.waifubux).toBe(200);
  });

  it('survives the reward table being deleted outright', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');

    installContent([definition()], []);
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.outcome).toBe('success');
    expect(resolved?.rewards?.waifubux).toBe(200);
  });

  it('survives the expedition definition being removed from content', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');

    installContent([], []);
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.outcome).toBe('success');
    // The snapshot still renders her name — no "Unknown Expedition".
    expect(resolved?.name).toBe('Test Run');
    const claimed = await app.expeditions.claim(playerId, view.id);
    expect(claimed.waifubuxAfter).toBeGreaterThanOrEqual(200);
  });

  it('survives the expedition being disabled', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    installContent([definition({ enabled: false })], DEFAULT_TABLES);
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.status).toBe('resolved');
    await expect(app.expeditions.claim(playerId, view.id)).resolves.toBeDefined();
  });

  /**
   * A kill switch must not eat somebody's twelve hours: it stops new
   * deployments and hides the board, and leaves missions in flight alone.
   */
  it('still resolves and pays while the whole feature is switched off', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');

    installContent([definition()], DEFAULT_TABLES, { enabled: false });
    await timeTravel(view.id);

    const [resolved] = await app.expeditions.getActive(playerId);
    expect(resolved?.status).toBe('resolved');
    const claimed = await app.expeditions.claim(playerId, view.id);
    expect(claimed.rewards.waifubux).toBe(200);

    // The board is closed, though.
    const board = await app.expeditions.getBoard(playerId);
    expect(board.enabled).toBe(false);
    expect(board.entries).toEqual([]);
  });

  it('survives the suitability config being retuned', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const chanceAtDeploy = (await rowOf(view.id)).successChance;
    const matchAtDeploy = view.match;

    installContent([definition()], DEFAULT_TABLES, {
      suitability: { affinityStrong: 0.9, levelAtOrAbove: 0.9 },
      match: { thresholds: { strong: 0.99, partial: 0.98, weak: 0.97 } },
    });
    await timeTravel(view.id);
    await app.expeditions.getActive(playerId);

    const row = await rowOf(view.id);
    expect(row.successChance).toBe(chanceAtDeploy);
    expect(row.suitabilityBand).toBe(matchAtDeploy);
    expect((await app.expeditions.getActive(playerId))[0]?.match).toBe(matchAtDeploy);
  });

  /**
   * Rows deployed before match quality existed carry a success band. They
   * still resolve and pay exactly as before; they just do not claim a match
   * label the game never computed for them.
   */
  it('reads a legacy success band as no match label, and still resolves and pays', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await t.db
      .update(playerExpeditions)
      .set({ suitabilityBand: 'EXCELLENT' })
      .where(eq(playerExpeditions.id, view.id));
    expect((await app.expeditions.getActive(playerId))[0]?.match).toBeNull();

    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);
    const claimed = await app.expeditions.claim(playerId, view.id);
    expect(claimed.outcome).toBe('success');
    expect(claimed.rewards.waifubux).toBe(200);
    expect(claimed.expedition.match).toBeNull();
  });
});

describe('restarting the bot mid-flight', () => {
  /**
   * The acceptance criterion, tested directly. A brand-new service instance
   * against the same database — which is what a restart is — must resolve a
   * mission the old instance deployed, with no recovery step and no timer.
   */
  it('resolves a mission deployed by a previous process', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);

    // A second service, wired from scratch, sharing only the database.
    const availability = createWaifuAvailabilityService({
      bulkProviders: [createCoreAvailabilityProvider()],
    });
    const restarted = createExpeditionService({
      db: t.db,
      logger: t.logger,
      getContent: () => app.content,
      resolveRace: raceResolverFromContent(() => app.content),
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      collection: app.collection,
      progression: app.progression,
      availability,
      getCurrentRegion: (id) => app.travel.getCurrentRegion(id),
    });

    const [resolved] = await restarted.getActive(playerId);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.rewards?.waifubux).toBe(200);

    const claimed = await restarted.claim(playerId, view.id);
    expect(claimed.outcome).toBe('success');
  });

  it('agrees with the original process about the outcome', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);

    // Resolve through the original service, then read through a new one.
    const [byOriginal] = await app.expeditions.getActive(playerId);
    const restarted = createExpeditionService({
      db: t.db,
      logger: t.logger,
      getContent: () => app.content,
      resolveRace: raceResolverFromContent(() => app.content),
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      collection: app.collection,
      progression: app.progression,
      getCurrentRegion: (id) => app.travel.getCurrentRegion(id),
    });
    const [byRestarted] = await restarted.getActive(playerId);

    expect(byRestarted?.outcome).toBe(byOriginal?.outcome);
    expect(byRestarted?.rewards).toEqual(byOriginal?.rewards);
  });
});

/**
 * Regional concurrency — the rule the whole feature now hangs on.
 *
 * One active mission per player per region; as many regions at once as the
 * player can reach; the same WaifuMon in exactly one of them. Location gates
 * *starting* a mission and nothing else, which is the half of the rule most
 * likely to rot, so most of the tests below are about what location does
 * **not** do.
 */
describe('regional concurrency', () => {
  /** A player standing in Twin Peeks with a spare copy, both regions authored. */
  async function twoRegionPlayer() {
    installContent(twoRegionPool(), DEFAULT_TABLES);
    const { playerId, waifuId } = await playerWithWaifu();
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    return { playerId, valleyWaifu: waifuId, peeksWaifu: second.id };
  }

  it('runs two missions at once in different regions', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();

    const valley = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const peeks = await app.expeditions.deploy(playerId, 'peeks_360', peeksWaifu);

    expect(valley.region).toBe('waifu-valley');
    expect(peeks.region).toBe('twin-peeks');

    const active = await app.expeditions.getActive(playerId);
    expect(active).toHaveLength(2);
    expect(active.every((v) => v.status === 'active')).toBe(true);
    // Ordered by region, so a screen listing them is stable between reads.
    expect(active.map((v) => v.region)).toEqual(['twin-peeks', 'waifu-valley']);
  });

  it('refuses a second mission in a region that already has one', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await expect(
      app.expeditions.deploy(playerId, 'test_run_quick', peeksWaifu),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);
  });

  it('refuses a region holding a resolved-but-uncollected mission', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    const view = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await timeTravel(view.id);
    // Resolves it, but does not collect it. The region stays held: this is
    // service policy, not the index, and it is what stops a player stacking a
    // mission on top of a payout they have not looked at.
    await app.expeditions.getActive(playerId);

    await expect(
      app.expeditions.deploy(playerId, 'test_run', peeksWaifu),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);
    expect((await app.expeditions.getBoard(playerId)).canDeploy).toBe(false);
  });

  it('refuses the same WaifuMon in a second region', async () => {
    const { playerId, valleyWaifu } = await twoRegionPlayer();
    await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');
    // The region is free; she is not. Availability refuses, not concurrency.
    await expect(
      app.expeditions.deploy(playerId, 'peeks_360', valleyWaifu),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });

  it('refuses a mission whose region the player is not standing in', async () => {
    const { playerId, peeksWaifu } = await twoRegionPlayer();
    // Standing in Waifu Valley, reaching for a Twin Peeks job.
    await expect(
      app.expeditions.deploy(playerId, 'peeks_360', peeksWaifu),
    ).rejects.toBeInstanceOf(ExpeditionWrongRegionError);
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
  });

  it('is unaffected by travelling away after deployment', async () => {
    const { playerId, valleyWaifu } = await twoRegionPlayer();
    const view = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    const before = await rowOf(view.id);

    await forceRegion(t.db, playerId, 'twin-peeks');

    const [seen] = await app.expeditions.getActive(playerId);
    expect(seen?.id).toBe(view.id);
    expect(seen?.status).toBe('active');
    const after = await rowOf(view.id);
    expect(after.completesAt).toEqual(before.completesAt);
    expect(after.successChance).toBe(before.successChance);
    expect(after.resolutionPlan).toEqual(before.resolutionPlan);
  });

  it('claims a mission from a different region', async () => {
    const { playerId, valleyWaifu } = await twoRegionPlayer();
    const view = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);

    await forceRegion(t.db, playerId, 'twin-peeks');
    const result = await app.expeditions.claim(playerId, view.id);
    expect(result.outcome).toBe('success');
    expect(result.rewards.waifubux).toBe(200);
  });

  it('cancels a mission from a different region', async () => {
    const { playerId, valleyWaifu } = await twoRegionPlayer();
    const view = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);

    await forceRegion(t.db, playerId, 'twin-peeks');
    const cancelled = await app.expeditions.cancel(playerId, view.id);
    expect(cancelled.status).toBe('cancelled');
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
  });

  it('settles one region without touching another', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    const valley = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const peeks = await app.expeditions.deploy(playerId, 'peeks_360', peeksWaifu);

    // Only the Waifu Valley mission falls due.
    await forceOutcome(valley.id, 'success');
    await timeTravel(valley.id);
    await app.expeditions.claim(playerId, valley.id);

    const peeksRow = await rowOf(peeks.id);
    expect(peeksRow.status).toBe('active');
    expect(peeksRow.outcome).toBeNull();
    expect(peeksRow.rewards).toBeNull();

    // Waifu Valley is immediately re-deployable; Twin Peeks is not.
    const active = await app.expeditions.getActive(playerId);
    expect(active.map((v) => v.region)).toEqual(['twin-peeks']);
    await expect(
      app.expeditions.deploy(playerId, 'peeks_60', valleyWaifu),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);
    await forceRegion(t.db, playerId, 'waifu-valley');
    const again = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    expect(again.status).toBe('active');
  });

  /**
   * The index, not the service-side read, is what makes this safe. Two
   * simultaneous presses on the *same* region must produce one mission.
   */
  it('produces exactly one mission when the same region is raced', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    const attempts = await Promise.allSettled([
      app.expeditions.deploy(playerId, 'test_run', valleyWaifu),
      app.expeditions.deploy(playerId, 'test_run_quick', peeksWaifu),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  /**
   * The mirror image, and the one that would have failed under the old global
   * key: two deployments racing in *different* regions must both land.
   *
   * Driven at the database rather than through `deploy`, because a player
   * stands in exactly one region at a time — there is no way to reach two
   * different-region deployments concurrently through the service, and the
   * thing under test is the index that used to serialise them.
   */
  it('lets two different regions be deployed concurrently and keeps both', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    const insert = (region: string, waifuId: number) =>
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region,
        waifuId,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'STRONG_MATCH',
      });

    const settled = await Promise.allSettled([
      insert('waifu-valley', valleyWaifu),
      insert('twin-peeks', peeksWaifu),
    ]);
    expect(settled.filter((a) => a.status === 'fulfilled')).toHaveLength(2);

    const active = await app.expeditions.getActive(playerId);
    expect(active.map((v) => v.region)).toEqual(['twin-peeks', 'waifu-valley']);
  });

  it('shows the other regions on the board without blocking this one', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');

    const board = await app.expeditions.getBoard(playerId);
    expect(board.regionId).toBe('twin-peeks');
    expect(board.regionMission).toBeNull();
    expect(board.canDeploy).toBe(true);
    expect(board.elsewhere.map((v) => v.region)).toEqual(['waifu-valley']);

    // And deploying here really is allowed.
    const peeks = await app.expeditions.deploy(playerId, 'peeks_360', peeksWaifu);
    expect(peeks.region).toBe('twin-peeks');
  });

  /**
   * A snapshot written before regional concurrency existed must still resolve
   * and still pay its own tables. The migration touched no row, so the only
   * thing that could break this is a reader that started demanding a field the
   * old plan does not have.
   */
  it('resolves an in-flight mission deployed under the old slot model', async () => {
    installContent(twoRegionPool(), DEFAULT_TABLES);
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);

    // Make the row look exactly like a pre-migration one: slot 1, and content
    // since retuned out from under it.
    await t.db
      .update(playerExpeditions)
      .set({ slotIndex: 1 })
      .where(eq(playerExpeditions.id, view.id));
    installContent(
      [definition({ rewardTable: 'test_success' })],
      [rewardTable({ waifubux: { min: 1, max: 1 }, essence: undefined, groups: [] })],
    );

    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);
    const result = await app.expeditions.claim(playerId, view.id);
    // The snapshot's tables, not the retuned live ones.
    expect(result.rewards.waifubux).toBe(200);
    expect(result.outcome).toBe('success');
  });

  it('stays deterministic and idempotent across regions', async () => {
    const { playerId, valleyWaifu, peeksWaifu } = await twoRegionPlayer();
    const valley = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const peeks = await app.expeditions.deploy(playerId, 'peeks_360', peeksWaifu);
    await timeTravel(valley.id);
    await timeTravel(peeks.id);

    // Read repeatedly: resolution is idempotent, and the two missions do not
    // borrow each other's roll.
    const first = await app.expeditions.getActive(playerId);
    const second = await app.expeditions.getActive(playerId);
    expect(second.map((v) => v.outcome)).toEqual(first.map((v) => v.outcome));
    expect(second.map((v) => v.rewards)).toEqual(first.map((v) => v.rewards));

    // Concurrent claims on two different missions: both pay, once each.
    const claims = await Promise.all([
      app.expeditions.claim(playerId, valley.id),
      app.expeditions.claim(playerId, peeks.id),
    ]);
    expect(claims).toHaveLength(2);
    for (const id of [valley.id, peeks.id]) {
      expect((await rowOf(id)).status).toBe('claimed');
      await expect(app.expeditions.claim(playerId, id)).rejects.toBeInstanceOf(
        ExpeditionAlreadyClaimedError,
      );
    }
  });
});

describe('database-enforced invariants', () => {
  it('refuses a second active row in the same region', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    // Bypassing the service entirely — the index is the real guarantee.
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId: second.id,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_player_region_active_uq/);
  });

  /**
   * The index is keyed on the region, so a *different* slot index must not be
   * a way around it. This is the assertion that would fail if somebody
   * reinstated the old (player, slot) key alongside the new one.
   */
  it('refuses a second active row in the same region whatever the slot index', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        slotIndex: 2,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId: second.id,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_player_region_active_uq/);
  });

  it('allows a second active row in a different region', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await t.db.insert(playerExpeditions).values({
      playerId,
      expeditionKey: 'test_run',
      region: 'twin-peeks',
      waifuId: second.id,
      completesAt: sql`now() + interval '1 hour'`,
      successChance: 0.5,
      exceptionalChance: 0.05,
      suitabilityBand: 'FAIR',
    });
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toHaveLength(2);
  });

  it('refuses the same copy on two missions, even in different regions', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        // A different region, so only the waifu index can refuse this.
        region: 'twin-peeks',
        waifuId,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_waifu_active_uq/);
  });

  it('allows a new mission in a region whose previous one finished', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);
    await app.expeditions.claim(playerId, view.id);
    const again = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    expect(again.slotIndex).toBe(1);
    expect(again.region).toBe('waifu-valley');
  });

  it('refuses an active row that claims to be resolved', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId,
        status: 'active',
        resolvedAt: new Date(),
        outcome: 'success',
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_active_shape_check/);
  });

  it('refuses a resolved row with no outcome', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId,
        status: 'resolved',
        resolvedAt: new Date(),
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_resolved_shape_check/);
  });

  it('refuses a claim with no resolution behind it', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    // Shaped so the other three checks pass and this one is the only thing
    // left to catch it: a cancelled row (so the active and cancelled checks
    // are satisfied) with no outcome (so the resolved check is) that
    // nonetheless claims to have been collected.
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId,
        status: 'cancelled',
        cancelledAt: new Date(),
        claimedAt: new Date(),
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_claimed_shape_check/);
  });

  it('refuses an unknown region', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        expeditionKey: 'test_run',
        region: 'narnia',
        waifuId,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_region_check/);
  });

  it('refuses a slot index below 1', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        slotIndex: 0,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_slot_check/);
  });
});

describe('odds stay private', () => {
  it('never puts a numeric chance on the view a client sees', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    // Match quality is the whole contract with the player.
    expect(view).toHaveProperty('match');
    expect(view).not.toHaveProperty('band');
    expect(view).not.toHaveProperty('successChance');
    expect(view).not.toHaveProperty('exceptionalChance');
    expect(view).not.toHaveProperty('resolutionRoll');
  });

  it('still persists the chances for resolution and audit', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const row = await rowOf(view.id);
    expect(row.successChance).toBeGreaterThan(0);
    expect(row.exceptionalChance).toBeGreaterThan(0);
    expect(row.logicVersion).toBe(1);
  });
});

/**
 * ── Who the Waifu XP belongs to ────────────────────────────────────────────
 *
 * Regional concurrency makes this load-bearing in a way it was not when a
 * player had one mission. Five regions running at once produce roughly five
 * regions' worth of WaifuMon XP per day — and the design intent is that this
 * is *distributed across five WaifuMon*, because five simultaneous missions
 * structurally require five distinct copies (`player_expeditions_waifu_active_uq`).
 * It must not be five regions' worth of XP that can be funnelled onto one
 * favourite, which would turn Expeditions into a levelling exploit rather than
 * a passive progression path.
 *
 * Two independent mechanisms deliver that, and these tests cover both:
 *
 *   1. `waifu_id` is written at **deploy** and read back off the *claimed row*
 *      (`won.waifuId`) — never from whoever is Buddy at collection time.
 *   2. `collection.awardWaifuXp` locks on `(id, player_id)` and updates that
 *      one row, so the grant cannot spill sideways even if the caller lied.
 */
describe('Expedition XP belongs to the copy that was sent', () => {
  /**
   * Two regions with *different* XP payouts, so a cross-credit shows up as the
   * wrong number rather than as a coincidence. Same-valued tables would let a
   * swap pass silently.
   */
  const XP_TABLES = [
    ...DEFAULT_TABLES,
    rewardTable({
      id: 'peeks_success',
      waifubux: { min: 10, max: 10 },
      essence: undefined,
      waifuXp: 400,
      playerXp: 30,
      groups: [],
    }),
  ];

  function xpPool(): RegionalExpedition[] {
    return [
      // Waifu Valley keeps `test_success`: 80 Waifu XP, 0 player XP.
      ...completePool(),
      // Twin Peeks pays 400 Waifu XP and 30 player XP, on every tier.
      ...TIERS.map((minutes) =>
        definition({
          key: `peeks_${minutes}`,
          region: 'twin-peeks',
          durationMinutes: minutes,
          rewardTable: 'peeks_success',
        }),
      ),
    ];
  }

  const waifuXpOf = async (waifuId: number) => {
    const [row] = await t.db
      .select({ xp: playerWaifus.xp })
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    return row!.xp;
  };
  const playerXpOf = async (playerId: number) => {
    const [row] = await t.db.select({ xp: players.xp }).from(players).where(eq(players.id, playerId));
    return row!.xp;
  };

  /** A player with two spare copies and a mission running in each region. */
  async function twoRegionsInFlight() {
    installContent(xpPool(), XP_TABLES);
    const { playerId, waifuId: valleyWaifu } = await playerWithWaifu();
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    const valley = await app.expeditions.deploy(playerId, 'test_run', valleyWaifu);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const peeks = await app.expeditions.deploy(playerId, 'peeks_360', second.id);
    for (const view of [valley, peeks]) {
      await forceOutcome(view.id, 'success');
      await timeTravel(view.id);
    }
    return { playerId, valleyWaifu, peeksWaifu: second.id, valley, peeks };
  }

  it('credits each mission only to the WaifuMon that ran it', async () => {
    const { playerId, valleyWaifu, peeksWaifu, valley, peeks } = await twoRegionsInFlight();
    const valleyBefore = await waifuXpOf(valleyWaifu);
    const peeksBefore = await waifuXpOf(peeksWaifu);

    await app.expeditions.claim(playerId, valley.id);
    // After the Valley claim only the Valley copy has moved. This is the
    // cross-credit assertion: the Twin Peeks copy is untouched even though it
    // is the same player, in the same transaction-visible state.
    expect(await waifuXpOf(valleyWaifu)).toBe(valleyBefore + 80);
    expect(await waifuXpOf(peeksWaifu)).toBe(peeksBefore);

    await app.expeditions.claim(playerId, peeks.id);
    expect(await waifuXpOf(peeksWaifu)).toBe(peeksBefore + 400);
    // And the Valley copy did not pick up any of Twin Peeks' 400.
    expect(await waifuXpOf(valleyWaifu)).toBe(valleyBefore + 80);
  });

  it('cannot cross-credit when both regions are claimed simultaneously', async () => {
    const { playerId, valleyWaifu, peeksWaifu, valley, peeks } = await twoRegionsInFlight();
    const valleyBefore = await waifuXpOf(valleyWaifu);
    const peeksBefore = await waifuXpOf(peeksWaifu);

    // Both claims race through `currency.lockCurrencies` on the same player
    // row, so they serialise — the question is whether serialising them also
    // keeps the two XP grants pointed at different WaifuMon.
    const results = await Promise.all([
      app.expeditions.claim(playerId, valley.id),
      app.expeditions.claim(playerId, peeks.id),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['success', 'success']);

    expect(await waifuXpOf(valleyWaifu)).toBe(valleyBefore + 80);
    expect(await waifuXpOf(peeksWaifu)).toBe(peeksBefore + 400);
  });

  /**
   * Player XP is the opposite rule and must stay that way: it belongs to the
   * *player*, so two regions accumulate onto one total. Only Twin Peeks pays
   * it here, which is what makes the number attributable.
   */
  it('still pays player XP to the player, accumulating across regions', async () => {
    const { playerId, valley, peeks } = await twoRegionsInFlight();
    const before = await playerXpOf(playerId);

    await app.expeditions.claim(playerId, valley.id);
    // Waifu Valley's table pays no player XP, so nothing moves yet.
    expect(await playerXpOf(playerId)).toBe(before);

    await app.expeditions.claim(playerId, peeks.id);
    expect(await playerXpOf(playerId)).toBe(before + 30);
  });

  /**
   * The mid-flight Buddy swap — the failure mode `awardWaifuXp` exists for.
   *
   * An 18-hour mission outlives most Buddy decisions. If the claim read the
   * *current* Buddy instead of the row's `waifu_id`, the XP would land on
   * whoever happened to be equipped at collection time, which is both wrong
   * and quietly exploitable.
   */
  it('pays the deployed copy even after the Buddy changes mid-flight', async () => {
    const { playerId, valleyWaifu, valley } = await twoRegionsInFlight();
    // A third copy, kept at home: a deployed copy cannot be equipped as Buddy
    // (`setBuddy` refuses `on_expedition`), so the Buddy here is necessarily
    // somebody with no stake in either mission — which is the case that would
    // wrongly collect the XP if the claim read the Buddy pointer.
    const bystander = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await app.collection.setBuddy(playerId, bystander.id);
    const bystanderBefore = await waifuXpOf(bystander.id);
    const valleyBefore = await waifuXpOf(valleyWaifu);

    await app.expeditions.claim(playerId, valley.id);

    expect(await waifuXpOf(valleyWaifu)).toBe(valleyBefore + 80);
    expect(await waifuXpOf(bystander.id)).toBe(bystanderBefore);
  });

  /**
   * Expedition Waifu XP is deliberately **unbonused**.
   *
   * `buddy_xp_gain` is defined over "XP awarded to the active Buddy", and an
   * expedition names an arbitrary copy — who, by default, cannot even be the
   * Buddy (`buddyDeployable` ships false). Routing it through `awardBuddyXp`
   * would pay the bonus to a copy the bonus is not defined over, and would pay
   * it based on whoever is equipped at collection time. Essence is the
   * deliberate contrast: it goes through `essenceAward`, which *does* apply the
   * Buddy Bonus, exactly as every other Essence award in the game does.
   */
  it('pays the flat authored Waifu XP, unscaled by any Buddy Bonus', async () => {
    const { playerId, peeksWaifu, peeks } = await twoRegionsInFlight();
    const before = await waifuXpOf(peeksWaifu);
    const result = await app.expeditions.claim(playerId, peeks.id);

    // Exactly the authored number — not a bonused multiple of it.
    expect(result.rewards.waifuXp).toBe(400);
    expect(await waifuXpOf(peeksWaifu)).toBe(before + 400);
  });

  /**
   * The structural guarantee behind "five regions means five WaifuMon".
   *
   * Without this index a player could shuttle one copy across every unlocked
   * region and collect the whole game's Expedition XP onto her. It is a unique
   * index rather than a service check precisely so a race cannot beat it.
   */
  it('cannot concentrate several regions of XP onto one WaifuMon', async () => {
    installContent(xpPool(), XP_TABLES);
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await forceRegion(t.db, playerId, 'twin-peeks');
    await expect(
      app.expeditions.deploy(playerId, 'peeks_360', waifuId),
    ).rejects.toBeInstanceOf(WaifuUnavailableError);
  });
});

/**
 * The four regions that ship Expedition content today, end to end.
 *
 * Everything above drives synthetic pools. This block uses the *shipped*
 * missions and reward tables for Waifu Valley, Twin Peeks, Flaccid Foothills
 * and Thirstlands, and moves the player with the real `travel()` rather than
 * `forceRegion` — so "travel does not touch a running mission" is proven
 * against the code that actually moves a player, not a column write.
 */
describe('four shipped regions at once', () => {
  const SHIPPED = loadShippedContent();
  const WALK = ['waifu-valley', 'twin-peeks', 'flaccid-foothills', 'thirstlands'] as const;

  let otherSpecies: SpeciesRow;
  beforeAll(async () => {
    const [row] = await t.db
      .select()
      .from(speciesTable)
      .where(sql`${speciesTable.id} <> ${demonSpecies.id}`)
      .limit(1);
    otherSpecies = row!;
  });

  /**
   * A player standing in Waifu Valley with a road to every other region, four
   * copies to send, and a fifth kept at home — of a *different* species, so a
   * block that leaked by species rather than by copy would show up.
   */
  async function fourRegionPlayer() {
    installContent(SHIPPED.expeditions, SHIPPED.expeditionRewards, {
      ...SHIPPED.tables.expeditions,
      enabled: true,
    });
    const { playerId, waifuId } = await playerWithWaifu();
    const copies = [waifuId];
    for (let i = 0; i < 3; i++) {
      const copy = await insertOwnedWaifu(t.db, {
        playerId,
        speciesId: demonSpecies.id,
        level: 10,
      });
      copies.push(copy.id);
    }
    const spare = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: otherSpecies.id,
      level: 10,
    });
    for (const regionId of WALK.slice(1)) {
      await t.db
        .insert(playerUnlockedRoutes)
        .values({ playerId, regionId, source: 'admin' })
        .onConflictDoNothing();
    }
    return { playerId, copies, spare: spare.id };
  }

  /** The first mission on the board where the player is standing. */
  async function boardKey(playerId: number) {
    const board = await app.expeditions.getBoard(playerId);
    expect(board.entries.length).toBeGreaterThan(0);
    return board.entries[0]!.definition.key;
  }

  /** Deploy off this region's own board, as a player pressing it would. */
  async function deployHere(playerId: number, waifuId: number) {
    expect((await app.expeditions.getBoard(playerId)).canDeploy).toBe(true);
    return app.expeditions.deploy(playerId, await boardKey(playerId), waifuId);
  }

  /** Deploy one copy per region, travelling between them for real. */
  async function walkAndDeploy(playerId: number, copies: number[]) {
    const views = [];
    for (const [i, regionId] of WALK.entries()) {
      if (i > 0) await app.travel.travel(playerId, regionId);
      views.push(await deployHere(playerId, copies[i]!));
    }
    return views;
  }

  const xpOf = async (waifuId: number) => {
    const [row] = await t.db
      .select({ xp: playerWaifus.xp })
      .from(playerWaifus)
      .where(eq(playerWaifus.id, waifuId));
    return row!.xp;
  };

  it('ships an expedition board in each of the four regions', () => {
    for (const regionId of WALK) {
      expect(SHIPPED.expeditions.some((e) => e.region === regionId && e.enabled)).toBe(true);
    }
  });

  it('runs Valley, Peeks, Foothills and Thirstlands simultaneously, one copy each', async () => {
    const { playerId, copies, spare } = await fourRegionPlayer();
    const views: Awaited<ReturnType<typeof deployHere>>[] = [];

    for (const [i, regionId] of WALK.entries()) {
      if (i > 0) {
        const before = await Promise.all(views.map((v) => rowOf(v.id)));
        await app.travel.travel(playerId, regionId);
        expect(await app.travel.getCurrentRegion(playerId)).toBe(regionId);
        // Travelling left every earlier mission exactly as it was.
        const after = await Promise.all(views.map((v) => rowOf(v.id)));
        expect(after).toEqual(before);
        expect(after.every((r) => r.status === 'active')).toBe(true);

        // The new region's board is open, and lists the others as "also out"
        // rather than as a reason to refuse.
        const board = await app.expeditions.getBoard(playerId);
        expect(board.regionId).toBe(regionId);
        expect(board.regionMission).toBeNull();
        expect(board.canDeploy).toBe(true);
        expect(board.elsewhere.map((v) => v.region).sort()).toEqual(
          WALK.slice(0, i).slice().sort(),
        );
      }
      const view = await deployHere(playerId, copies[i]!);
      expect(view.region).toBe(regionId);
      expect(view.waifuId).toBe(copies[i]);
      views.push(view);
    }

    const active = await app.expeditions.getActive(playerId);
    expect(active).toHaveLength(4);
    expect(active.every((v) => v.status === 'active')).toBe(true);
    expect(active.map((v) => v.region).sort()).toEqual([...WALK].sort());
    // Four distinct owned copies, each the one sent to that region.
    expect(new Set(active.map((v) => v.waifuId)).size).toBe(4);
    for (const [i, regionId] of WALK.entries()) {
      expect(active.find((v) => v.region === regionId)!.waifuId).toBe(copies[i]);
    }

    // Standing in Thirstlands: this region is occupied, the rest are listed.
    const board = await app.expeditions.getBoard(playerId);
    expect(board.regionMission?.region).toBe('thirstlands');
    expect(board.canDeploy).toBe(false);
    expect(board.elsewhere).toHaveLength(3);

    // Exactly the four deployed copies are away; the spare — another
    // species — is still eligible.
    const key = await boardKey(playerId);
    const candidates = await app.expeditions.getCandidates(playerId, key);
    for (const id of copies) {
      expect(candidates.find((c) => c.waifuId === id)!.unavailableReasons).toContain(
        'on_expedition',
      );
    }
    expect(candidates.find((c) => c.waifuId === spare)!.unavailableReasons).toEqual([]);

    // A second Thirstlands mission is refused on the region, not the copy.
    await expect(app.expeditions.deploy(playerId, key, spare)).rejects.toBeInstanceOf(
      ExpeditionRegionBusyError,
    );
    expect(await app.expeditions.getActive(playerId)).toHaveLength(4);
  });

  it('settles each region on its own: resolved holds, claim frees, recall frees', async () => {
    const { playerId, copies, spare } = await fourRegionPlayer();
    const [valley, peeks, foothills, thirst] = await walkAndDeploy(playerId, copies);
    for (const view of [valley!, peeks!, foothills!]) {
      await forceOutcome(view.id, 'success');
      await timeTravel(view.id);
    }

    // Valley, Peeks and Foothills have finished; Thirstlands has not.
    const open = await app.expeditions.getActive(playerId);
    const statusOf = (region: string) => open.find((v) => v.region === region)!.status;
    expect(statusOf('waifu-valley')).toBe('resolved');
    expect(statusOf('twin-peeks')).toBe('resolved');
    expect(statusOf('flaccid-foothills')).toBe('resolved');
    expect(statusOf('thirstlands')).toBe('active');

    // A resolved-but-uncollected mission still holds its region.
    await forceRegion(t.db, playerId, 'waifu-valley');
    const held = await app.expeditions.getBoard(playerId);
    expect(held.regionMission?.status).toBe('resolved');
    expect(held.canDeploy).toBe(false);
    await expect(
      app.expeditions.deploy(playerId, await boardKey(playerId), spare),
    ).rejects.toBeInstanceOf(ExpeditionRegionBusyError);

    // Collect the Valley: XP lands on the Valley copy and nobody else…
    const others = [peeks!, foothills!, thirst!];
    const xpBefore = await Promise.all(copies.map(xpOf));
    const othersBefore = await Promise.all(others.map((v) => rowOf(v.id)));
    const claimed = await app.expeditions.claim(playerId, valley!.id);
    expect(claimed.rewards.waifuXp).toBeGreaterThan(0);
    const xpAfter = await Promise.all(copies.map(xpOf));
    expect(xpAfter[0]).toBe(xpBefore[0]! + claimed.rewards.waifuXp);
    expect(xpAfter.slice(1)).toEqual(xpBefore.slice(1));
    // …and every other region's row is exactly as it was.
    expect(await Promise.all(others.map((v) => rowOf(v.id)))).toEqual(othersBefore);

    // The claim freed the Valley: a new mission goes out at once.
    expect((await deployHere(playerId, spare)).region).toBe('waifu-valley');

    // Recalling Thirstlands frees that region, and her, too.
    await app.expeditions.cancel(playerId, thirst!.id);
    await forceRegion(t.db, playerId, 'thirstlands');
    expect((await deployHere(playerId, copies[3]!)).region).toBe('thirstlands');

    // Peeks and Foothills were never touched by any of that.
    expect((await rowOf(peeks!.id)).status).toBe('resolved');
    expect((await rowOf(foothills!.id)).status).toBe('resolved');
    const regions = (await app.expeditions.getActive(playerId)).map((v) => v.region).sort();
    expect(regions).toEqual([...WALK].sort());
  });

  it('pays each simultaneous claim once, to its own copy, even when raced', async () => {
    const { playerId, copies } = await fourRegionPlayer();
    const views = await walkAndDeploy(playerId, copies);
    for (const view of views) {
      await forceOutcome(view.id, 'success');
      await timeTravel(view.id);
    }
    const xpBefore = await Promise.all(copies.map(xpOf));
    const bux = async () => (await app.currency.getBalances(playerId)).waifubux;
    const buxBefore = await bux();

    // Every region collected at once, and every Collect pressed twice.
    const settled = await Promise.allSettled(
      views.flatMap((v) => [
        app.expeditions.claim(playerId, v.id),
        app.expeditions.claim(playerId, v.id),
      ]),
    );
    const won = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    expect(won).toHaveLength(4);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(ExpeditionAlreadyClaimedError);
    }
    expect(new Set(won.map((r) => r.expedition.id))).toEqual(new Set(views.map((v) => v.id)));

    // Each copy got exactly its own mission's Waifu XP.
    const xpAfter = await Promise.all(copies.map(xpOf));
    for (const [i, view] of views.entries()) {
      const result = won.find((r) => r.expedition.id === view.id)!;
      expect(result.expedition.waifuId).toBe(copies[i]);
      expect(xpAfter[i]).toBe(xpBefore[i]! + result.rewards.waifuXp);
    }
    // WaifuBux: the four payouts, once each.
    expect(await bux()).toBe(buxBefore + won.reduce((sum, r) => sum + r.rewards.waifubux, 0));
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
  });

  /**
   * Several copies racing into one real region. The service-side read cannot
   * stop this — every request sees the region empty — so it is the
   * `(player_id, region)` index that must leave exactly one row.
   */
  it('keeps one mission per region when several copies race into it', async () => {
    const { playerId, copies } = await fourRegionPlayer();
    await app.travel.travel(playerId, 'thirstlands');
    const key = await boardKey(playerId);

    const settled = await Promise.allSettled(
      copies.map((id) => app.expeditions.deploy(playerId, key, id)),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.region).toBe('thirstlands');
  });

  /**
   * One copy racing into all four regions at once.
   *
   * Location is read before the deploying transaction opens, so a press that
   * straddles a travel can pass the region check for a region the player has
   * just left. This service takes that to the limit — every call is "standing
   * in" the region its mission belongs to — leaving only the copy's row lock
   * and the `waifu_id` index between her and four missions.
   */
  it('keeps one mission per copy when she is raced into every region', async () => {
    const { playerId, copies } = await fourRegionPlayer();
    const keys = WALK.map(
      (regionId) => SHIPPED.expeditions.find((e) => e.region === regionId && e.enabled)!.key,
    );
    // `deploy` asks for the region synchronously on entry, so the calls below
    // consume this queue in the order they are made.
    const standingIn: string[] = [...WALK];
    const anywhere = createExpeditionService({
      db: t.db,
      logger: t.logger,
      getContent: () => app.content,
      resolveRace: raceResolverFromContent(() => app.content),
      currency: app.currency,
      essenceAward: app.essenceAward,
      inventory: app.inventory,
      collection: app.collection,
      progression: app.progression,
      availability: app.availability,
      getCurrentRegion: async () => standingIn.shift()!,
    });

    const settled = await Promise.allSettled(
      keys.map((key) => anywhere.deploy(playerId, key, copies[0]!)),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(WaifuUnavailableError);
    }
    const rows = await t.db
      .select()
      .from(playerExpeditions)
      .where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.waifuId).toBe(copies[0]);
  });

  /** The same race with the service out of the way: the index alone. */
  it('refuses one copy in four regions at the database, raced', async () => {
    const { playerId, copies } = await fourRegionPlayer();
    const settled = await Promise.allSettled(
      WALK.map((region) =>
        t.db.insert(playerExpeditions).values({
          playerId,
          expeditionKey: 'raw',
          region,
          waifuId: copies[0]!,
          completesAt: sql`now() + interval '1 hour'`,
          successChance: 0.5,
          exceptionalChance: 0.05,
          suitabilityBand: 'FAIR',
        }),
      ),
    );
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) {
      if (s.status === 'rejected') {
        expect((s.reason as Error).message).toMatch(/player_expeditions_waifu_active_uq/);
      }
    }
  });
});

/**
 * Races against the rest of the game, and what each side is told afterwards.
 *
 * Synthetic reward tables on the four real region ids, so every number below
 * is fixed: a claim pays exactly 200 WaifuBux, 50 Essence, 80 Waifu XP and 30
 * Player XP, and any drift is a bug rather than a roll.
 */
describe('races: the loser is refused properly, and balances stay true', () => {
  const REGIONS = ['waifu-valley', 'twin-peeks', 'flaccid-foothills', 'thirstlands'] as const;
  /** The 6h mission in each region. */
  const KEY: Record<(typeof REGIONS)[number], string> = {
    'waifu-valley': 'test_run',
    'twin-peeks': 'peeks_360',
    'flaccid-foothills': 'foot_360',
    thirstlands: 'thirst_360',
  };
  const PAY = { waifubux: 200, essence: 50, waifuXp: 80, playerXp: 30 };

  function installFourRegions() {
    installContent(
      [
        ...completePool(),
        ...poolFor('twin-peeks', 'peeks'),
        ...poolFor('flaccid-foothills', 'foot'),
        ...poolFor('thirstlands', 'thirst'),
      ],
      [
        rewardTable({
          waifubux: { min: PAY.waifubux, max: PAY.waifubux },
          essence: { min: PAY.essence, max: PAY.essence },
          waifuXp: PAY.waifuXp,
          playerXp: PAY.playerXp,
          groups: [],
        }),
        ...DEFAULT_TABLES.slice(1),
      ],
    );
  }

  /** A player in Waifu Valley with `n` copies and a road to every region. */
  async function playerWithCopies(n: number) {
    installFourRegions();
    const { playerId, waifuId } = await playerWithWaifu();
    const copies = [waifuId];
    while (copies.length < n) {
      copies.push(
        (await insertOwnedWaifu(t.db, { playerId, speciesId: demonSpecies.id, level: 10 })).id,
      );
    }
    for (const regionId of REGIONS.slice(1)) {
      await t.db
        .insert(playerUnlockedRoutes)
        .values({ playerId, regionId, source: 'admin' })
        .onConflictDoNothing();
    }
    return { playerId, copies };
  }

  /** One finished (successful, not yet resolved) mission per region. */
  async function fourDue(playerId: number, copies: number[]) {
    const views = [];
    for (const [i, region] of REGIONS.entries()) {
      await forceRegion(t.db, playerId, region);
      views.push(await app.expeditions.deploy(playerId, KEY[region], copies[i]!));
    }
    for (const view of views) {
      await forceOutcome(view.id, 'success');
      await timeTravel(view.id);
    }
    return views;
  }

  /** What the database holds, read on its own connection after the fact. */
  async function stateOf(playerId: number) {
    const [cur] = await t.db
      .select()
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    return {
      waifubux: cur!.waifubux,
      essence: cur!.essence,
      energy: cur!.huntEnergy,
      xp: player!.xp,
      region: player!.currentRegion,
    };
  }

  /**
   * Resolves once `n` callers have arrived. Lets two transactions be held at
   * the same point so the race is certain rather than likely.
   */
  function barrier(n: number) {
    let arrived = 0;
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    return async () => {
      arrived += 1;
      if (arrived === n) release();
      await open;
    };
  }

  // ── 1. The deployment race ──────────────────────────────────────────────

  /**
   * Two different, eligible WaifuMon into one region, and both requests are
   * held — inside their deploying transactions, after locking their own copy
   * and before the region check — until both have arrived. Neither can see
   * the other's uncommitted row, so both pass the service-side check and both
   * insert: the second is refused by `player_expeditions_player_region_active_uq`
   * itself. That violation must reach the caller as the domain refusal.
   */
  it('turns the loser of a same-region race into a region-busy refusal', async () => {
    for (let round = 0; round < 5; round++) {
      const { playerId, copies } = await playerWithCopies(2);
      const gate = barrier(2);
      const racing = createExpeditionService({
        db: t.db,
        logger: t.logger,
        getContent: () => app.content,
        resolveRace: raceResolverFromContent(() => app.content),
        currency: app.currency,
        essenceAward: app.essenceAward,
        inventory: app.inventory,
        collection: app.collection,
        progression: app.progression,
        availability: {
          ...app.availability,
          reasonsFor: async (tx, pid, wid) => {
            const reasons = await app.availability.reasonsFor(tx, pid, wid);
            await gate();
            return reasons;
          },
        },
        getCurrentRegion: (pid) => app.travel.getCurrentRegion(pid),
      });

      const settled = await Promise.allSettled([
        racing.deploy(playerId, 'test_run', copies[0]!),
        racing.deploy(playerId, 'test_run_quick', copies[1]!),
      ]);

      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(ExpeditionRegionBusyError);
      // The domain error, not a Postgres one wearing a different name.
      expect((lost.reason as { code?: unknown }).code).toBe('EXPEDITION_REGION_BUSY');
      expect(String((lost.reason as Error).message)).not.toMatch(/unique|duplicate|_uq/);
      // And it names who beat her there.
      const won = settled.find((s) => s.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof racing.deploy>>
      >;
      expect((lost.reason as { userMessage: string }).userMessage).toContain(won.value.waifuName);

      const rows = await t.db
        .select()
        .from(playerExpeditions)
        .where(eq(playerExpeditions.playerId, playerId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.waifuId).toBe(won.value.waifuId);
    }
  });

  // ── 2. The balance a claim reports ──────────────────────────────────────

  it('reports the post-claim balances for a single claim', async () => {
    const { playerId, copies } = await playerWithCopies(1);
    const view = await app.expeditions.deploy(playerId, 'test_run', copies[0]!);
    await forceOutcome(view.id, 'success');
    await timeTravel(view.id);
    const before = await stateOf(playerId);

    const result = await app.expeditions.claim(playerId, view.id);

    const after = await stateOf(playerId);
    expect(result.essenceGranted).toBe(PAY.essence);
    expect(result.essenceAfter).toBe(before.essence + PAY.essence);
    expect(result.essenceAfter).toBe(after.essence);
    expect(result.waifubuxAfter).toBe(before.waifubux + PAY.waifubux);
    expect(result.waifubuxAfter).toBe(after.waifubux);
  });

  /**
   * Four regions collected at once, each Collect pressed twice. Claims
   * serialise on the currency row, so the four winners' reported balances
   * must form an exact chain: each is the previous one plus its own grant,
   * and the last is what the database holds.
   */
  it('reports a consistent chain of balances across concurrent regional claims', async () => {
    const { playerId, copies } = await playerWithCopies(4);
    const views = await fourDue(playerId, copies);
    const before = await stateOf(playerId);

    const settled = await Promise.allSettled(
      views.flatMap((v) => [
        app.expeditions.claim(playerId, v.id),
        app.expeditions.claim(playerId, v.id),
      ]),
    );
    const won = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    expect(won).toHaveLength(4);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(ExpeditionAlreadyClaimedError);
    }

    const chain = [...won].sort((a, b) => a.essenceAfter - b.essenceAfter);
    let essence = before.essence;
    let bux = before.waifubux;
    for (const result of chain) {
      essence += result.essenceGranted;
      bux += result.rewards.waifubux;
      expect(result.essenceAfter).toBe(essence);
      expect(result.waifubuxAfter).toBe(bux);
    }
    const after = await stateOf(playerId);
    expect(after.essence).toBe(before.essence + 4 * PAY.essence);
    expect(chain.at(-1)!.essenceAfter).toBe(after.essence);
    expect(chain.at(-1)!.waifubuxAfter).toBe(after.waifubux);
  });

  /**
   * The Essence Buddy Bonus is applied by the canonical `awardEssence`, not by
   * the expedition service — and the reported balance includes the bonused
   * amount, because it is read after that award, in the same transaction.
   */
  it('reports the bonused Essence balance when a Buddy Bonus applies', async () => {
    const { playerId, copies } = await playerWithCopies(2);
    const [buddySpecies] = await t.db
      .select()
      .from(speciesTable)
      .where(sql`${speciesTable.id} <> ${demonSpecies.id}`)
      .limit(1);
    const entry = app.content.species.find((s) => s.slug === buddySpecies!.slug)!;
    const shipped = entry.buddyBonus;
    entry.buddyBonus = {
      name: 'Quiet Study',
      flavorText: '+100% Essence gained.',
      effectId: 'essence_gain',
      value: 100,
    } as typeof entry.buddyBonus;
    try {
      const buddy = await insertOwnedWaifu(t.db, {
        playerId,
        speciesId: buddySpecies!.id,
        level: 10,
      });
      await app.collection.setBuddy(playerId, buddy.id);

      const a = await app.expeditions.deploy(playerId, 'test_run', copies[0]!);
      await forceRegion(t.db, playerId, 'twin-peeks');
      const b = await app.expeditions.deploy(playerId, 'peeks_360', copies[1]!);
      for (const view of [a, b]) {
        await forceOutcome(view.id, 'success');
        await timeTravel(view.id);
      }
      const before = await stateOf(playerId);

      // Both collected at once, and the first pressed twice.
      const settled = await Promise.allSettled([
        app.expeditions.claim(playerId, a.id),
        app.expeditions.claim(playerId, a.id),
        app.expeditions.claim(playerId, b.id),
      ]);
      const won = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      expect(won).toHaveLength(2);

      for (const result of won) {
        // The table's 50, doubled by the Buddy — and only by the Buddy.
        expect(result.rewards.essence).toBe(PAY.essence);
        expect(result.essenceGranted).toBe(PAY.essence * 2);
      }
      const after = await stateOf(playerId);
      expect(after.essence).toBe(before.essence + 2 * PAY.essence * 2);
      const last = [...won].sort((x, y) => x.essenceAfter - y.essenceAfter).at(-1)!;
      expect(last.essenceAfter).toBe(after.essence);
      const first = [...won].sort((x, y) => x.essenceAfter - y.essenceAfter)[0]!;
      expect(first.essenceAfter).toBe(before.essence + PAY.essence * 2);
    } finally {
      if (shipped) entry.buddyBonus = shipped;
      else delete entry.buddyBonus;
    }
  });

  // ── 3. Travel racing a Collect ──────────────────────────────────────────

  /**
   * Travel and Collect, for the same player, started together — repeatedly.
   *
   * The mission is due but not yet resolved, so the claim resolves and claims
   * in one transaction (which takes KEY SHARE on `players` via the foreign
   * key) and pays Player XP (FOR UPDATE on `players`). Travel locks both
   * `players` and the currency row. If the two ever take those in opposite
   * orders, this deadlocks; they must not.
   */
  it('lets Travel and a Collect race without deadlock or partial effects', async () => {
    const ROUNDS = 25;
    const { playerId, copies } = await playerWithCopies(1);
    let here: (typeof REGIONS)[number] = 'waifu-valley';

    for (let round = 0; round < ROUNDS; round++) {
      const there: (typeof REGIONS)[number] = here === 'waifu-valley' ? 'twin-peeks' : 'waifu-valley';
      const view = await app.expeditions.deploy(playerId, KEY[here], copies[0]!);
      await forceOutcome(view.id, 'success');
      await timeTravel(view.id);
      await t.db
        .update(playerCurrencies)
        .set({ huntEnergy: 10 })
        .where(eq(playerCurrencies.playerId, playerId));
      const before = await stateOf(playerId);

      const [travelled, claimed] = await Promise.allSettled([
        app.travel.travel(playerId, there),
        app.expeditions.claim(playerId, view.id),
      ]);
      if (travelled.status === 'rejected') throw travelled.reason;
      if (claimed.status === 'rejected') throw claimed.reason;

      const after = await stateOf(playerId);
      // Travel: charged exactly once, and she is where she went.
      expect(after.region).toBe(there);
      expect(after.energy).toBe(before.energy - travelled.value.energySpent);
      expect(travelled.value.energySpent).toBeGreaterThan(0);
      // Collect: paid exactly once, in full.
      expect(after.waifubux).toBe(before.waifubux + PAY.waifubux);
      expect(after.essence).toBe(before.essence + claimed.value.essenceGranted);
      expect(claimed.value.essenceGranted).toBe(PAY.essence);
      expect(after.xp).toBe(before.xp + PAY.playerXp);
      expect(claimed.value.waifubuxAfter).toBe(after.waifubux);
      expect(claimed.value.essenceAfter).toBe(after.essence);
      expect((await rowOf(view.id)).status).toBe('claimed');

      here = there;
    }
  });
});
