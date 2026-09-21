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
  playerExpeditions,
  species as speciesTable,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  ExpeditionAlreadyClaimedError,
  ExpeditionNotCancellableError,
  ExpeditionNotCompleteError,
  ExpeditionNotFoundError,
  ExpeditionSlotsFullError,
  ExpeditionsDisabledError,
  WaifuReleaseBlockedError,
  WaifuUnavailableError,
} from '../../src/shared/errors';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionsConfigSchema,
  type ExpeditionRewardTable,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';
import { createExpeditionService } from '../../src/modules/expeditions/expeditionService';
import {
  createCoreAvailabilityProvider,
  createWaifuAvailabilityService,
} from '../../src/modules/collection/waifuAvailability';
import { raceResolverFromContent } from '../../src/modules/encounters/speciesSelection';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
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
  installContent([definition()], DEFAULT_TABLES, { enabled: true, maxConcurrent: 1 });
});

describe('the board', () => {
  it('shows the region’s missions and a rotation deadline', async () => {
    const { playerId } = await playerWithWaifu();
    const board = await app.expeditions.getBoard(playerId);
    expect(board.regionId).toBe('waifu-valley');
    expect(board.entries.map((e) => e.definition.key)).toEqual(['test_run']);
    expect(board.rotatesAt.getTime()).toBeGreaterThan(Date.now());
    expect(board.slotsTotal).toBe(1);
    expect(board.slotsAvailable).toBe(1);
  });

  it('is empty, not broken, when the region has no expedition content', async () => {
    installContent([definition({ region: 'thirstlands' })], DEFAULT_TABLES);
    const { playerId } = await playerWithWaifu();
    const board = await app.expeditions.getBoard(playerId);
    expect(board.entries).toEqual([]);
    expect(board.enabled).toBe(true);
  });

  it('reports a slot as busy while a mission is running', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const board = await app.expeditions.getBoard(playerId);
    expect(board.slotsAvailable).toBe(0);
  });
});

describe('deploying', () => {
  it('starts a mission with a band, a finish line and a snapshot', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);

    expect(view.status).toBe('active');
    expect(view.slotIndex).toBe(1);
    expect(view.waifuId).toBe(waifuId);
    expect(view.name).toBe('Test Run');
    expect(['EXCELLENT', 'GOOD', 'FAIR', 'RISKY', 'POOR']).toContain(view.band);
    expect(view.secondsRemaining).toBeGreaterThan(0);

    const row = await rowOf(view.id);
    expect(row.resolutionPlan).not.toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.rewards).toBeNull();
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

  it('refuses a second mission while a slot is occupied', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const second = await insertOwnedWaifu(t.db, {
      playerId,
      speciesId: demonSpecies.id,
      level: 10,
    });
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await expect(
      app.expeditions.deploy(playerId, 'test_run', second.id),
    ).rejects.toBeInstanceOf(ExpeditionSlotsFullError);
  });

  it('refuses a copy already out on a mission', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    // Two slots, so the refusal is about the *copy* and not about capacity.
    installContent([definition()], DEFAULT_TABLES, { maxConcurrent: 2 });
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

  it('fills the lowest free slot when several are available', async () => {
    installContent([definition()], DEFAULT_TABLES, { maxConcurrent: 3 });
    const { playerId, waifuId } = await playerWithWaifu();
    const b = await insertOwnedWaifu(t.db, { playerId, speciesId: demonSpecies.id, level: 10 });
    const first = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    const second = await app.expeditions.deploy(playerId, 'test_run', b.id);
    expect(first.slotIndex).toBe(1);
    expect(second.slotIndex).toBe(2);
  });
});

describe('candidates', () => {
  it('bands every owned copy and flags the ones that cannot go', async () => {
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

  it('marks the mission claimed and frees the slot', async () => {
    const { playerId, expeditionId } = await resolvedMission();
    await app.expeditions.claim(playerId, expeditionId);

    const row = await rowOf(expeditionId);
    expect(row.status).toBe('claimed');
    expect(row.claimedAt).not.toBeNull();
    expect(await app.expeditions.getActive(playerId)).toEqual([]);
    expect((await app.expeditions.getBoard(playerId)).slotsAvailable).toBe(1);
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

  it('frees the slot and the copy immediately', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await app.expeditions.cancel(playerId, view.id);

    expect((await app.expeditions.getBoard(playerId)).slotsAvailable).toBe(1);
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
    const bandAtDeploy = view.band;

    installContent([definition()], DEFAULT_TABLES, {
      suitability: { affinityStrong: 0.9, levelAtOrAbove: 0.9 },
    });
    await timeTravel(view.id);
    await app.expeditions.getActive(playerId);

    const row = await rowOf(view.id);
    expect(row.successChance).toBe(chanceAtDeploy);
    expect(row.suitabilityBand).toBe(bandAtDeploy);
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
    });
    const [byRestarted] = await restarted.getActive(playerId);

    expect(byRestarted?.outcome).toBe(byOriginal?.outcome);
    expect(byRestarted?.rewards).toEqual(byOriginal?.rewards);
  });
});

describe('database-enforced invariants', () => {
  it('refuses a second active row in the same slot', async () => {
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
        slotIndex: 1,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId: second.id,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_player_slot_active_uq/);
  });

  it('refuses the same copy on two missions, even in different slots', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await expect(
      t.db.insert(playerExpeditions).values({
        playerId,
        slotIndex: 2,
        expeditionKey: 'test_run',
        region: 'waifu-valley',
        waifuId,
        completesAt: sql`now() + interval '1 hour'`,
        successChance: 0.5,
        exceptionalChance: 0.05,
        suitabilityBand: 'FAIR',
      }),
    ).rejects.toThrow(/player_expeditions_waifu_active_uq/);
  });

  it('allows a new mission in a slot whose previous one finished', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    await timeTravel(view.id);
    await app.expeditions.claim(playerId, view.id);
    const again = await app.expeditions.deploy(playerId, 'test_run', waifuId);
    expect(again.slotIndex).toBe(1);
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
    // The band is the whole contract with the player.
    expect(view).toHaveProperty('band');
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
