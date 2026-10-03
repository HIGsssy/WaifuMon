/**
 * Playable dungeon runs against a real database: starting and snapshotting,
 * navigation, combat with persistent HP through the real engine, rest, events,
 * rewards (secured gear and items, unbanked currency), extraction, defeat,
 * completion, abandon, and the idempotency and concurrency of all of it.
 *
 * Zones, enemies, events and reward tables are the test world's own
 * (`dungeonPlayFixtures.ts`), with flat payouts, so every expected number is
 * read off the generated graph rather than off shipped tuning.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dungeonRunEvents,
  dungeonRuns,
  items,
  playerCurrencies,
  playerEquipment,
  playerInventory,
  players,
  progressionCurrencyLedger,
  rewardTables,
} from '../../src/db/schema';
import { basicAttackController } from '../../src/modules/combat/combatController';
import { NO_DAMAGE_VARIANCE } from '../../src/modules/combat/combatMath';
import { simulateCombat } from '../../src/modules/combat/combatSimulator';
import { createCombatState } from '../../src/modules/combat/combatState';
import type { CombatEvent } from '../../src/modules/combat/combatTypes';
import type { DungeonGraph } from '../../src/modules/dungeons/dungeonGenerator';
import type { DungeonRunView } from '../../src/modules/dungeons/dungeonPlayService';
import { settleCurrency } from '../../src/modules/dungeons/dungeonRunState';
import {
  CombatBuddyRequiredError,
  CombatLoadoutIncompleteError,
  DungeonRunActiveError,
  DungeonRunNotFoundError,
  DungeonRunUnplayableError,
  FeatureLockedError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import {
  CURRENCY,
  GEAR_TABLE,
  LOOT_TABLE,
  STARTER,
  TEST_ENEMIES,
  atCompleted,
  createDungeonWorld,
  walk,
  type DungeonWorld,
} from '../helpers/dungeonPlayFixtures';
import { grant } from '../helpers/equipmentFixtures';
import { insertOwnedWaifu } from '../helpers/fixtures';

let w: DungeonWorld;

/** The base zone: one fork, a rest (the extraction point), a reward node, a beatable boss. */
const MAIN = 'play_main';
/** As MAIN, but the boss cannot be beaten: every run that reaches it is defeated. */
const DOOMED = 'play_doomed';
/** As MAIN, but the boss ends in a stalemate at the round limit. */
const STALLED = 'play_stalled';
/** Elites and minibosses as well as ordinary fights. */
const TYPES = 'play_types';
/** A rest that heals 100% of max HP. */
const SPA = 'play_spa';
/** A rest that heals 5% of max HP: 18. */
const NAP = 'play_nap';

/** The numbers a `combat_resolved`, `rest_resolved` or `event_resolved` event records. */
interface ResolvedPayload {
  nodeType: string;
  hpBefore: number;
  hpAfter: number;
  rounds: number;
  result: string;
  enemy: { key: string };
  events: CombatEvent[];
  eventKey: string;
  healBasisPoints: number;
  rewards: { currency: number };
}
const payloadOf = (event: { payload: Record<string, unknown> }) => event.payload as unknown as ResolvedPayload;

beforeAll(async () => {
  w = await createDungeonWorld();
  await w.zone(MAIN);
  await w.zone(DOOMED, (z) => {
    z.pools.boss = [{ id: 'brute', enemyKey: 'brute', weight: 10 }];
  });
  await w.zone(STALLED, (z) => {
    z.pools.boss = [{ id: 'wall', enemyKey: 'wall', weight: 10 }];
  });
  await w.zone(TYPES, (z) => {
    z.generation.nodeWeights = { combat: 20, elite: 30, event: 0, reward: 10, rest: 10, miniboss: 30, exit: 0 };
    z.generation.required = [{ types: ['rest'], min: 1 }, { types: ['elite'], min: 1 }, { types: ['miniboss'], min: 1 }];
    z.generation.limits = [{ types: ['elite'], max: 1 }, { types: ['miniboss'], max: 1 }, { types: ['reward'], max: 1 }];
  });
  await w.zone(SPA, (z) => {
    z.nodeSettings = { rest: { healBasisPoints: 10_000 } };
  });
  await w.zone(NAP, (z) => {
    z.nodeSettings = { rest: { healBasisPoints: 500 } };
  });
});
afterAll(async () => {
  await w?.cleanup();
});

const start = async (zoneKey = MAIN, seed?: number) => {
  const { playerId, buddyId } = await w.player();
  const run = await w.play.start(playerId, zoneKey, seed !== undefined ? { seed } : {});
  return { playerId, buddyId, run };
};
const rowOf = async (runId: number) => (await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, runId)))[0]!;
const eventTypes = async (runId: number) => (await w.play.history(runId)).map((e) => e.type);
const ledgerRows = async (playerId: number) =>
  w.t.db.select().from(progressionCurrencyLedger).where(eq(progressionCurrencyLedger.playerId, playerId));
const gearCount = async (playerId: number) =>
  (await w.t.db.select({ n: count() }).from(playerEquipment).where(eq(playerEquipment.playerId, playerId)))[0]!.n;
const waifubux = async (playerId: number) =>
  (await w.t.db.select().from(playerCurrencies).where(eq(playerCurrencies.playerId, playerId)))[0]!.waifubux;
const itemQty = async (playerId: number, slug: string) =>
  (
    await w.t.db
      .select({ q: playerInventory.quantity })
      .from(playerInventory)
      .innerJoin(items, eq(items.id, playerInventory.itemId))
      .where(and(eq(playerInventory.playerId, playerId), eq(items.slug, slug)))
  )[0]?.q ?? 0;
/** Unbanked currency a full walk of the path taken should have earned, from the flat test payouts. */
const earnedOn = (view: DungeonRunView, graph: DungeonGraph, visited: string[]) =>
  visited.reduce((sum, id) => {
    const node = graph.nodes.find((n) => n.id === id)!;
    if (node.type === 'boss') return sum + 10;
    if (node.type === 'reward') return sum + 5;
    if (node.type === 'rest') return sum;
    if (node.type === 'event') return sum + (view.zone.key && node.content!.key === 'shrine' ? 2 : 0);
    return sum + 2;
  }, 0);
const visitedOf = async (runId: number) =>
  (await w.play.history(runId)).filter((e) => e.type === 'node_entered').map((e) => e.nodeId!);

/* ─────────────────────────── lifecycle ─────────────────────────── */

describe('starting a run', () => {
  it('generates the graph, snapshots the fighter at full HP and records the start', async () => {
    const { playerId, buddyId, run } = await start(MAIN, 11);
    expect(run).toMatchObject({
      status: 'active',
      zone: { key: MAIN },
      fighter: { waifuId: buddyId, name: 'Nebula Nurse', currentSp: 185, ...STARTER },
      currentHp: STARTER.maxHp,
      depth: 1,
      nodeStatus: 'entered',
      resolution: null,
      next: [],
      canExtract: false,
      unbankedCurrency: 0,
      secured: [],
      settlement: null,
    });
    expect(Object.keys(run.fighter.gear).sort()).toEqual(['attack', 'defense', 'health']);
    expect(run.fighter.gear.attack).toMatchObject({ definitionKey: 'rusty_pipe', multiplierBp: 4500 });

    const row = await rowOf(run.id);
    expect(row.seed).toBe(11);
    expect((row.graph as unknown as DungeonGraph).nodes.length).toBeGreaterThanOrEqual(6);
    expect(row.fighter).toEqual(run.fighter);
    expect(row.currentNodeId).toBe((row.graph as unknown as DungeonGraph).startNodeId);
    expect(await eventTypes(run.id)).toEqual(['run_started', 'node_entered']);
    expect(await w.play.activeRun(playerId)).toEqual(run);
  });

  it('refuses a locked player, a player with no Buddy and an incomplete loadout — and stores nothing', async () => {
    const locked = await w.player({ unlocked: false });
    await expect(w.play.start(locked.playerId, MAIN)).rejects.toBeInstanceOf(FeatureLockedError);
    await expect(w.play.home(locked.playerId)).rejects.toBeInstanceOf(FeatureLockedError);
    expect(await w.play.isAvailable(locked.playerId)).toBe(false);

    const noBuddy = await w.player({ buddy: false });
    await expect(w.play.start(noBuddy.playerId, MAIN)).rejects.toBeInstanceOf(CombatBuddyRequiredError);
    expect((await w.play.home(noBuddy.playerId)).blocker).toBe('no_buddy');

    const noGear = await w.player({ starters: false });
    await expect(w.play.start(noGear.playerId, MAIN)).rejects.toBeInstanceOf(CombatLoadoutIncompleteError);
    expect((await w.play.zone(noGear.playerId, MAIN)).blocker).toBe('incomplete_loadout');

    for (const { playerId } of [locked, noBuddy, noGear]) {
      expect(await w.t.db.select().from(dungeonRuns).where(eq(dungeonRuns.playerId, playerId))).toHaveLength(0);
    }
  });

  it('refuses a second run while one is active, and offers the first to resume', async () => {
    const { playerId, run } = await start();
    await expect(w.play.start(playerId, MAIN)).rejects.toBeInstanceOf(DungeonRunActiveError);
    const home = await w.play.home(playerId);
    expect(home.activeRun?.id).toBe(run.id);
    expect((await w.play.zone(playerId, MAIN)).activeRunId).toBe(run.id);
  });

  it('lets exactly one of several concurrent starts through', async () => {
    const { playerId } = await w.player();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => w.play.start(playerId, MAIN)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonRunActiveError);
  });

  it('lists the open zones with the depth range and the configured currency', async () => {
    const { playerId } = await w.player();
    const home = await w.play.home(playerId);
    expect(home).toMatchObject({ activeRun: null, blocker: null, unplayableRunId: null });
    const zone = home.zones.find((z) => z.key === MAIN)!;
    expect(zone).toMatchObject({ hasBoss: true, balance: 0, defeatRetentionBasisPoints: 2500, currency: { key: CURRENCY } });
    expect(zone.minDepth).toBeLessThanOrEqual(zone.maxDepth);
  });

  it('does not find another player’s run', async () => {
    const { run } = await start();
    const other = await w.player();
    await expect(w.play.run(other.playerId, run.id)).rejects.toBeInstanceOf(DungeonRunNotFoundError);
    await expect(w.play.resolveNode(other.playerId, run.id, run.node.id)).rejects.toBeInstanceOf(DungeonRunNotFoundError);
  });
});

describe('the snapshot', () => {
  it('fights with the stats it started with after the gear is changed', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat');
    const { playerId, run } = await start(MAIN, seed);
    // A much stronger weapon, equipped mid-run through normal Equipment management.
    const better = await grant(w.t.db, w.svc, playerId, 'railcarbine', {
      roll: { kind: 'fixed', rolledMultiplierBp: 12_000, affixKey: null },
    });
    await w.svc.equipment.equip(playerId, { slot: 'attack', equipmentId: better });
    expect((await w.stats.calculateCombatStats(playerId)).stats.attack).toBe(222);

    const after = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    expect(after.fighter).toEqual(run.fighter);
    // ATK 83 needs two hits on a 150 HP Grunt, so it lands one: 60 × 100/165 = 36.
    expect(after.resolution).toMatchObject({ kind: 'combat', rounds: 2, hpBefore: 370, hpAfter: 334 });
    expect(after.currentHp).toBe(334);
  });

  it('keeps its Buddy after the active Buddy is changed', async () => {
    const { playerId, buddyId, run } = await start();
    const other = await insertOwnedWaifu(w.t.db, {
      playerId,
      speciesId: (await w.app.collection.getOwned(playerId, buddyId!)).species.id,
      level: 50,
      baseSp: 400,
      nickname: 'Someone Else',
    });
    await w.t.db.update(players).set({ buddyWaifuId: other.id }).where(eq(players.id, playerId));

    const view = await w.play.run(playerId, run.id);
    expect(view.fighter).toMatchObject({ waifuId: buddyId, name: 'Nebula Nurse', ...STARTER });
    const resolved = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    expect(resolved.fighter.waifuId).toBe(buddyId);
  });

  it('is untouched by a zone edit and a reward-table edit made after it started', async () => {
    const { playerId, run } = await start(DOOMED);
    const live = (await w.zones.get(DOOMED))!;
    const saved = (await w.zones.update(
      DOOMED,
      {
        zone: {
          ...live.zone,
          nodeSettings: { rest: { healBasisPoints: 0 } },
          rewards: { ...live.zone.rewards, defeatCurrencyRetentionBasisPoints: 10_000 },
        },
        expectedRevision: live.revision,
      },
      'admin',
    ))!;
    const [table] = await w.t.db.select().from(rewardTables).where(eq(rewardTables.tableId, LOOT_TABLE));
    await w.t.db
      .update(rewardTables)
      .set({ definition: { ...table!.definition, waifubux: { min: 999, max: 999 } } })
      .where(eq(rewardTables.tableId, LOOT_TABLE));
    try {
      const bux = await waifubux(playerId);
      const end = await walk(w.play, playerId, run);
      // The run was promised 11 WaifuBux and a 25% retention, and that is what it got.
      expect(await waifubux(playerId)).toBe(bux + 11);
      expect(end.status).toBe('defeated');
      expect(end.settlement).toMatchObject({ retentionBasisPoints: 2500 });
      expect(end.settlement!.banked).toBe(settleCurrency(end.settlement!.earned, 2500).banked);
      const rest = (await w.play.history(run.id)).find((e) => e.type === 'rest_resolved')!;
      expect(rest.payload.healBasisPoints).toBe(3000);
    } finally {
      await w.t.db.update(rewardTables).set({ definition: table!.definition }).where(eq(rewardTables.tableId, LOOT_TABLE));
      await w.zones.update(DOOMED, { zone: live.zone, expectedRevision: saved.revision }, 'admin');
    }
  });
});

/* ─────────────────────────── navigation ─────────────────────────── */

describe('navigation', () => {
  it('offers only the outgoing nodes, and only once the current node is completed', async () => {
    const { playerId, run } = await start();
    const graph = (await rowOf(run.id)).graph as unknown as DungeonGraph;
    const second = graph.nodes.find((n) => n.depth === 2)!;

    // Still standing on an unresolved node: nothing is available yet.
    expect(await w.play.enterNode(playerId, run.id, second.id)).toMatchObject({ status: 'refused', refusal: 'not_available' });

    const done = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    const outgoing = graph.edges.filter((e) => e.from === run.node.id).map((e) => e.to);
    expect(done.next.map((n) => n.id)).toEqual(outgoing);

    // Not adjacent, not real, and the node just completed.
    const far = graph.nodes.find((n) => n.depth === 3)!;
    for (const id of [far.id, 'n99', 'nope']) {
      expect(await w.play.enterNode(playerId, run.id, id)).toMatchObject({ status: 'refused', refusal: 'not_available' });
    }
    expect((await w.play.run(playerId, run.id)).node.id).toBe(run.node.id);
    expect((await rowOf(run.id)).graph).toEqual(graph);
  });

  it('makes a fork a permanent choice', async () => {
    const { playerId, run } = await start();
    const atFork = await walk(w.play, playerId, run, { stopAt: (v) => v.next.length > 1 });
    expect(atFork.next).toHaveLength(2);
    const [left, right] = atFork.next;

    const chosen = await w.play.enterNode(playerId, run.id, right!.id);
    expect(chosen).toMatchObject({ status: 'applied', run: { node: { id: right!.id }, nodeStatus: 'entered' } });
    // The other side is gone, and so is the node behind.
    expect(await w.play.enterNode(playerId, run.id, left!.id)).toMatchObject({ status: 'refused', refusal: 'not_available' });
    expect(await w.play.enterNode(playerId, run.id, atFork.node.id)).toMatchObject({ status: 'refused' });
    // Entering the node you are on again is a replay, not a second entry.
    expect(await w.play.enterNode(playerId, run.id, right!.id)).toMatchObject({ status: 'replayed' });
    expect((await visitedOf(run.id)).filter((id) => id === right!.id)).toHaveLength(1);
  });

  it('lets one of two simultaneous fork clicks win', async () => {
    const { playerId, run } = await start();
    const atFork = await walk(w.play, playerId, run, { stopAt: (v) => v.next.length > 1 });
    const results = await Promise.all(atFork.next.map((n) => w.play.enterNode(playerId, run.id, n.id)));
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'refused']);
    const winner = results.find((r) => r.status === 'applied')!;
    expect((await w.play.run(playerId, run.id)).node.id).toBe(winner.run.node.id);
  });

  it('resolves a node once: a retry reads the same resolution back', async () => {
    const { playerId, run } = await start();
    const first = await w.play.resolveNode(playerId, run.id, run.node.id);
    const events = await eventTypes(run.id);
    const again = await w.play.resolveNode(playerId, run.id, run.node.id);
    expect(first.status).toBe('applied');
    expect(again.status).toBe('replayed');
    expect(again.run).toEqual(first.run);
    expect(await eventTypes(run.id)).toEqual(events);
  });

  it('refuses to resolve a node the player is not on', async () => {
    const { playerId, run } = await start();
    expect(await w.play.resolveNode(playerId, run.id, 'n2')).toMatchObject({ status: 'refused', refusal: 'not_current' });
    expect(await w.play.resolveNode(playerId, run.id, 'n99')).toMatchObject({ status: 'refused', refusal: 'not_current' });
  });

  it('allows nothing once the run is over', async () => {
    const { playerId, run } = await start();
    const end = await walk(w.play, playerId, run);
    expect(end.status).toBe('completed');
    expect(end.next).toEqual([]);
    const graph = (await rowOf(run.id)).graph as unknown as DungeonGraph;
    expect(await w.play.enterNode(playerId, run.id, graph.nodes[1]!.id)).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect(await w.play.extract(playerId, run.id, end.node.id)).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect(await w.play.abandon(playerId, run.id)).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect((await rowOf(run.id)).status).toBe('completed');
  });
});

/* ─────────────────────────── combat ─────────────────────────── */

describe('combat', () => {
  it('carries HP from fight to fight, and every fight is the engine’s own result', async () => {
    const seed = await w.seedFor(TYPES, (g) => ['combat', 'elite', 'miniboss', 'boss'].every((t) => g.nodes.some((n) => n.type === t && g.nodes.filter((m) => m.depth === n.depth).length === 1)));
    const { playerId, run } = await start(TYPES, seed);
    const end = await walk(w.play, playerId, run);
    expect(end.status).toBe('completed');

    const fights = (await w.play.history(run.id)).filter((e) => e.type === 'combat_resolved');
    expect(new Set(fights.map((f) => payloadOf(f).nodeType))).toEqual(new Set(['combat', 'elite', 'miniboss', 'boss']));

    let hp: number = STARTER.maxHp;
    for (const event of await w.play.history(run.id)) {
      const p = payloadOf(event);
      if (event.type === 'rest_resolved') {
        expect(p.hpBefore).toBe(hp);
        hp = p.hpAfter;
      }
      if (event.type !== 'combat_resolved') continue;
      // It starts from the HP the last node left, not from full.
      expect(p.hpBefore).toBe(hp);
      const enemy = TEST_ENEMIES.find((e) => e.key === p.enemy.key)!;
      const expected = simulateCombat(
        createCombatState({
          player: { id: 'p', name: 'p', attack: STARTER.attack, defense: STARTER.defense, maxHp: STARTER.maxHp, currentHp: hp },
          enemy: { id: 'e', name: 'e', attack: enemy.attack, defense: enemy.defense, maxHp: enemy.hp },
          // The world fights with no damage variance (see `dungeonPlayFixtures`).
          rules: { damageVariance: NO_DAMAGE_VARIANCE },
        }),
        { player: basicAttackController, enemy: basicAttackController },
        { rng: seededRng(1) },
      );
      expect({ hpAfter: p.hpAfter, rounds: p.rounds, result: p.result }).toEqual({
        hpAfter: expected.finalState.player.currentHp,
        rounds: expected.rounds,
        result: expected.result,
      });
      const started = p.events.find((e) => e.type === 'combat_started')!;
      expect(started).toMatchObject({ player: { currentHp: hp, maxHp: STARTER.maxHp } });
      hp = p.hpAfter;
      expect(hp).toBeLessThan(p.hpBefore);
    }
    expect(end.currentHp).toBe(hp);
    expect(end.fighter).toEqual(run.fighter);
  });

  it('does not heal after an ordinary fight', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat' && g.nodes[1]!.type === 'combat' && g.nodes[1]!.depth === 2);
    const { playerId, run } = await start(MAIN, seed);
    const one = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    expect(one.currentHp).toBe(334);
    const entered = (await w.play.enterNode(playerId, run.id, one.next[0]!.id)).run;
    expect(entered.currentHp).toBe(334);
    const two = (await w.play.resolveNode(playerId, run.id, entered.node.id)).run;
    expect(two.resolution).toMatchObject({ kind: 'combat', hpBefore: 334, hpAfter: 298 });
  });

  it('ends the run at 0 HP, and nothing more can be entered', async () => {
    const { playerId, run } = await start(DOOMED);
    const end = await walk(w.play, playerId, run);
    expect(end).toMatchObject({ status: 'defeated', currentHp: 0, next: [], canExtract: false });
    expect(end.resolution).toMatchObject({ kind: 'combat', enemyKey: 'brute', result: 'enemy_victory', hpAfter: 0 });
    expect(end.settlement).toMatchObject({ outcome: 'defeated', cause: 'hp_zero', finalHp: 0 });
    expect(end.completedAt).not.toBeNull();
  });

  it('treats a fight that runs out the round limit as a defeat', async () => {
    const { playerId, run } = await start(STALLED);
    const end = await walk(w.play, playerId, run);
    expect(end.status).toBe('defeated');
    expect(end.resolution).toMatchObject({ kind: 'combat', enemyKey: 'wall', result: 'draw' });
    expect(end.settlement).toMatchObject({ cause: 'stalemate' });
    expect(end.currentHp).toBeGreaterThan(0);
  });

  it('fights once when the button is double-clicked', async () => {
    const { playerId, run } = await start();
    const results = await Promise.all([1, 2, 3].map(() => w.play.resolveNode(playerId, run.id, run.node.id)));
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'replayed', 'replayed']);
    expect(new Set(results.map((r) => r.run.currentHp)).size).toBe(1);
    const resolved = (await eventTypes(run.id)).filter((t) => t.endsWith('_resolved'));
    expect(resolved).toHaveLength(1);
  });
});

/* ─────────────────────────── rest ─────────────────────────── */

describe('rest nodes', () => {
  it('heal the configured share of max HP, once', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat' && g.nodes[1]!.type === 'rest');
    const { playerId, run } = await start(MAIN, seed);
    const rested = await walk(w.play, playerId, run, { stopAt: atCompleted('rest') });
    // 30% of 370 is 111: 334 → 445, clamped to 370.
    expect(rested.resolution).toEqual({ kind: 'rest', healBasisPoints: 3000, hpBefore: 334, hpAfter: 370 });
    expect(rested.currentHp).toBe(370);

    const again = await w.play.resolveNode(playerId, run.id, rested.node.id);
    expect(again).toMatchObject({ status: 'replayed', run: { currentHp: 370 } });
    expect((await eventTypes(run.id)).filter((t) => t === 'rest_resolved')).toHaveLength(1);
  });

  it('heal by the amount, not to full, when there is room', async () => {
    const seed = await w.seedFor(NAP, (g) => g.nodes[0]!.type === 'combat' && g.nodes[1]!.type === 'rest');
    const { playerId, run } = await start(NAP, seed);
    const rested = await walk(w.play, playerId, run, { stopAt: atCompleted('rest') });
    // 5% of 370 is 18.5, rounded toward zero.
    expect(rested.resolution).toEqual({ kind: 'rest', healBasisPoints: 500, hpBefore: 334, hpAfter: 352 });
  });

  it('never overheal, even at 100%', async () => {
    const { playerId, run } = await start(SPA);
    const rested = await walk(w.play, playerId, run, { stopAt: atCompleted('rest') });
    expect(rested.resolution).toMatchObject({ kind: 'rest', healBasisPoints: 10_000, hpAfter: 370 });
    expect(rested.currentHp).toBe(370);
  });
});

/* ─────────────────────────── rewards ─────────────────────────── */

describe('rewards', () => {
  it('accumulate currency unbanked, and secure gear, WaifuBux and items at once', async () => {
    const { playerId, run } = await start();
    const [gearBefore, buxBefore, itemsBefore] = [await gearCount(playerId), await waifubux(playerId), await itemQty(playerId, 'sticky_joystick')];
    const opened = await walk(w.play, playerId, run, { stopAt: atCompleted('reward') });

    expect(opened.resolution).toMatchObject({
      kind: 'reward',
      rewards: { currency: 5, waifubux: 11, items: [{ slug: 'sticky_joystick', quantity: 2 }] },
    });
    const drop = (opened.resolution as { rewards: { equipment: { equipmentId: number; slot: string; rarity: string }[] } }).rewards.equipment;
    expect(drop).toHaveLength(1);
    expect(drop[0]).toMatchObject({ slot: 'attack', rarity: 'N', rewardIndex: 0 });

    // Secured: already in the ordinary inventory, while the run is still going.
    expect(await gearCount(playerId)).toBe(gearBefore + 1);
    expect(await waifubux(playerId)).toBe(buxBefore + 11);
    expect(await itemQty(playerId, 'sticky_joystick')).toBe(itemsBefore + 2);
    const [instance] = await w.t.db.select().from(playerEquipment).where(eq(playerEquipment.id, drop[0]!.equipmentId));
    expect(instance).toMatchObject({ playerId, sourceType: 'dungeon', sourceKey: MAIN, grantKey: `dungeon:${run.id}:${opened.node.id}:0:0` });
    expect(opened.secured.map((s) => s.kind).sort()).toEqual(['equipment', 'item', 'waifubux']);

    // Unbanked: on the run, not on the player.
    expect(opened.unbankedCurrency).toBe(earnedOn(opened, (await rowOf(run.id)).graph as unknown as DungeonGraph, await visitedOf(run.id)));
    expect(opened.unbankedCurrency).toBeGreaterThanOrEqual(5);
    expect(await w.balance(playerId)).toBe(0);
    expect(await ledgerRows(playerId)).toHaveLength(0);

    // A retry pays nothing more and names the same instance.
    const again = await w.play.resolveNode(playerId, run.id, opened.node.id);
    expect(again.status).toBe('replayed');
    expect(again.run.resolution).toEqual(opened.resolution);
    expect(await gearCount(playerId)).toBe(gearBefore + 1);
    expect(await waifubux(playerId)).toBe(buxBefore + 11);
    expect(await itemQty(playerId, 'sticky_joystick')).toBe(itemsBefore + 2);
  });

  it('pay a table the run was promised nothing from when it was disabled at the start', async () => {
    await w.t.db.update(rewardTables).set({ enabled: false }).where(eq(rewardTables.tableId, GEAR_TABLE));
    let started;
    try {
      started = await start();
    } finally {
      await w.t.db.update(rewardTables).set({ enabled: true }).where(eq(rewardTables.tableId, GEAR_TABLE));
    }
    const { playerId, run } = started;
    const gear = await gearCount(playerId);
    const opened = await walk(w.play, playerId, run, { stopAt: atCompleted('reward') });
    // Re-enabled since, but this run's snapshot says it pays no gear.
    expect(opened.resolution).toMatchObject({ kind: 'reward', rewards: { currency: 5, waifubux: 11, equipment: [] } });
    expect(await gearCount(playerId)).toBe(gear);
  });

  it('events change HP and pay only when authored to', async () => {
    const seed = await w.seedFor(MAIN, (g) => g.nodes.some((n) => n.content?.key === 'trap' && n.lane === 0) && g.nodes.some((n) => n.content?.key === 'shrine' && n.lane === 0));
    const { playerId, run } = await start(MAIN, seed);
    await walk(w.play, playerId, run);
    const events = (await w.play.history(run.id)).filter((e) => e.type === 'event_resolved').map(payloadOf);
    const trap = events.find((e) => e.eventKey === 'trap')!;
    const shrine = events.find((e) => e.eventKey === 'shrine')!;
    // 10% of 370 is 37, either way; a shrine at full HP stays at full.
    expect(trap.hpAfter).toBe(Math.max(1, trap.hpBefore - 37));
    expect(trap.rewards).toMatchObject({ currency: 0 });
    expect(shrine.hpAfter).toBe(Math.min(370, shrine.hpBefore + 37));
    expect(shrine.rewards).toMatchObject({ currency: 2 });
  });
});

/* ─────────────────────────── extraction ─────────────────────────── */

describe('extraction', () => {
  it('is refused off an extraction point and before the node is completed', async () => {
    const seed = await w.seedFor(MAIN, (g) => !g.nodes[0]!.extraction);
    const { playerId, run } = await start(MAIN, seed);
    expect(await w.play.extract(playerId, run.id, run.node.id)).toMatchObject({ status: 'refused', refusal: 'not_extractable' });
    const done = (await w.play.resolveNode(playerId, run.id, run.node.id)).run;
    expect(done.canExtract).toBe(false);
    expect(await w.play.extract(playerId, run.id, run.node.id)).toMatchObject({ status: 'refused', refusal: 'not_extractable' });

    // On the extraction node but not yet rested: still no.
    const onRest = await walk(w.play, playerId, done, { stopAt: (v) => v.next.some((n) => n.extraction) });
    const entered = (await w.play.enterNode(playerId, run.id, onRest.next.find((n) => n.extraction)!.id)).run;
    expect(entered).toMatchObject({ nodeStatus: 'entered', canExtract: false, node: { extraction: true } });
    expect(await w.play.extract(playerId, run.id, entered.node.id)).toMatchObject({ status: 'refused', refusal: 'not_extractable' });
    expect((await rowOf(run.id)).status).toBe('active');
  });

  it('banks everything, ends the run, and does it once', async () => {
    // Open on a fight, so something has been earned by the time the rest is reached.
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat');
    const { playerId, run } = await start(MAIN, seed);
    const there = await walk(w.play, playerId, run, { stopAt: (v) => v.canExtract });
    expect(there.node.extraction).toBe(true);
    const unbanked = there.unbankedCurrency;
    expect(unbanked).toBeGreaterThan(0);

    const out = await w.play.extract(playerId, run.id, there.node.id);
    expect(out).toMatchObject({
      status: 'applied',
      run: {
        status: 'extracted',
        unbankedCurrency: 0,
        next: [],
        canExtract: false,
        currentHp: there.currentHp,
        settlement: {
          outcome: 'extracted',
          cause: 'extraction',
          nodeId: there.node.id,
          depth: there.depth,
          finalHp: there.currentHp,
          earned: unbanked,
          bonusCurrency: 0,
          retentionBasisPoints: 10_000,
          banked: unbanked,
          lost: 0,
          balanceAfter: unbanked,
        },
      },
    });
    expect(await w.balance(playerId)).toBe(unbanked);

    const again = await w.play.extract(playerId, run.id, there.node.id);
    expect(again.status).toBe('replayed');
    expect(await w.balance(playerId)).toBe(unbanked);
    const ledger = await ledgerRows(playerId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: unbanked, reason: 'dungeon_extraction', sourceRef: `dungeon_run:${run.id}`, requestKey: `dungeon_run:${run.id}:settlement` });

    expect(await w.play.enterNode(playerId, run.id, there.next[0]!.id)).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect((await eventTypes(run.id)).slice(-2)).toEqual(['currency_banked', 'extraction']);
  });

  it('lets exactly one of Extract and Continue win', async () => {
    const { playerId, run } = await start();
    const there = await walk(w.play, playerId, run, { stopAt: (v) => v.canExtract });
    const [extract, onward] = await Promise.all([
      w.play.extract(playerId, run.id, there.node.id),
      w.play.enterNode(playerId, run.id, there.next[0]!.id),
    ]);
    const final = await w.play.run(playerId, run.id);
    if (extract.status === 'applied') {
      expect(onward).toMatchObject({ status: 'refused', refusal: 'run_over' });
      expect(final).toMatchObject({ status: 'extracted', node: { id: there.node.id } });
      expect(await w.balance(playerId)).toBe(there.unbankedCurrency);
    } else {
      expect(onward.status).toBe('applied');
      expect(extract).toMatchObject({ status: 'refused', refusal: 'not_current' });
      expect(final).toMatchObject({ status: 'active', node: { id: there.next[0]!.id } });
      expect(await w.balance(playerId)).toBe(0);
    }
  });
});

/* ─────────────────────────── defeat ─────────────────────────── */

describe('defeat', () => {
  it('banks the retention share once, discards the rest, and keeps what was secured', async () => {
    const { playerId, run } = await start(DOOMED);
    const gear = await gearCount(playerId);
    const end = await walk(w.play, playerId, run);
    const s = end.settlement!;
    expect(end.status).toBe('defeated');
    expect(s.earned).toBeGreaterThanOrEqual(5);
    // 25%, rounded toward zero.
    expect(s.banked).toBe(Math.trunc(s.earned / 4));
    expect(s).toMatchObject({ retentionBasisPoints: 2500, bonusCurrency: 0, lost: s.earned - s.banked, bankingSkipped: null });
    expect(end.unbankedCurrency).toBe(0);
    expect(await w.balance(playerId)).toBe(s.banked);

    // The gear from the reward node is still the player's.
    expect(await gearCount(playerId)).toBe(gear + 1);
    expect(end.secured.some((r) => r.kind === 'equipment')).toBe(true);

    // The fight that ended it cannot be retried into a second settlement.
    const retry = await w.play.resolveNode(playerId, run.id, end.node.id);
    expect(retry.status).toBe('replayed');
    expect(await w.balance(playerId)).toBe(s.banked);
    expect(await ledgerRows(playerId)).toHaveLength(s.banked > 0 ? 1 : 0);
    expect((await eventTypes(run.id)).filter((t) => t === 'defeat')).toHaveLength(1);
  });

  it('adds to a balance the player already holds', async () => {
    const { playerId, run } = await start();
    const first = await walk(w.play, playerId, run);
    const held = await w.balance(playerId);
    expect(held).toBe(first.settlement!.banked);

    const second = await w.play.start(playerId, DOOMED);
    const end = await walk(w.play, playerId, second);
    expect(await w.balance(playerId)).toBe(held + end.settlement!.banked);
    expect(await w.balance(playerId)).toBeGreaterThanOrEqual(0);
  });
});

/* ─────────────────────────── completion ─────────────────────────── */

describe('completion', () => {
  it('finishes on the boss, banks everything plus the bonus once, and frees the player to start again', async () => {
    const { playerId, run } = await start();
    const end = await walk(w.play, playerId, run);
    const graph = (await rowOf(run.id)).graph as unknown as DungeonGraph;
    const earned = earnedOn(end, graph, await visitedOf(run.id));

    // No Extract click: beating the final boss completes the run.
    expect(end).toMatchObject({ status: 'completed', node: { boss: true, terminal: true }, next: [], canExtract: false });
    expect(end.resolution).toMatchObject({ kind: 'combat', enemyKey: 'overlord', result: 'player_victory', rewards: { currency: 10 } });
    expect(end.settlement).toMatchObject({
      outcome: 'completed',
      cause: 'boss_defeated',
      depth: graph.depthCount,
      earned,
      bonusCurrency: 7,
      retentionBasisPoints: 10_000,
      banked: earned + 7,
      lost: 0,
      balanceAfter: earned + 7,
    });
    expect(await w.balance(playerId)).toBe(earned + 7);

    const retry = await w.play.resolveNode(playerId, run.id, end.node.id);
    expect(retry.status).toBe('replayed');
    expect(await w.balance(playerId)).toBe(earned + 7);
    expect(await ledgerRows(playerId)).toHaveLength(1);
    expect((await eventTypes(run.id)).slice(-3)).toEqual(['combat_resolved', 'currency_banked', 'completion']);

    const next = await w.play.start(playerId, MAIN);
    expect(next.id).not.toBe(run.id);
    expect(next.currentHp).toBe(STARTER.maxHp);
  });

  it('keeps a structured history of the whole run', async () => {
    const { playerId, run } = await start();
    await walk(w.play, playerId, run);
    const history = await w.play.history(run.id);
    expect(history[0]).toMatchObject({ type: 'run_started', payload: { zoneKey: MAIN, fighter: { attack: 83 } } });
    const types = new Set(history.map((e) => e.type));
    for (const type of ['node_entered', 'combat_resolved', 'rest_resolved', 'reward_resolved', 'currency_banked', 'completion']) {
      expect(types.has(type as never)).toBe(true);
    }
    const stored = await w.t.db.select({ n: count() }).from(dungeonRunEvents).where(eq(dungeonRunEvents.runId, run.id));
    expect(stored[0]!.n).toBe(history.length);
    // The stored graph still reproduces from the seed.
    const full = (await w.runs.getRun(run.id))!;
    expect(w.runs.reproduceGraph(full)).toEqual(full.graph);
  });
});

/* ─────────────────────────── abandon ─────────────────────────── */

describe('abandon', () => {
  it('settles like a defeat, keeps what was secured, and frees the player', async () => {
    const { playerId, run } = await start();
    const mid = await walk(w.play, playerId, run, { stopAt: atCompleted('reward') });
    const gear = await gearCount(playerId);

    const out = (await w.play.abandon(playerId, run.id))!;
    const s = out.run.settlement!;
    expect(out.status).toBe('applied');
    expect(out.run.status).toBe('abandoned');
    expect(s).toMatchObject({
      outcome: 'abandoned',
      cause: 'abandoned',
      earned: mid.unbankedCurrency,
      retentionBasisPoints: 2500,
      banked: Math.trunc(mid.unbankedCurrency / 4),
      finalHp: mid.currentHp,
    });
    expect(await w.balance(playerId)).toBe(s.banked);
    expect(await gearCount(playerId)).toBe(gear);

    const again = (await w.play.abandon(playerId, run.id))!;
    expect(again.status).toBe('replayed');
    expect(await w.balance(playerId)).toBe(s.banked);
    expect((await eventTypes(run.id)).filter((t) => t === 'abandon')).toHaveLength(1);

    expect(await w.play.resolveNode(playerId, run.id, mid.next[0]!.id)).toMatchObject({ status: 'refused', refusal: 'run_over' });
    expect((await w.play.start(playerId, MAIN)).id).not.toBe(run.id);
  });

  it('racing a fight leaves one settled run, whichever lands first', async () => {
    const { playerId, run } = await start(DOOMED);
    const atBoss = await walk(w.play, playerId, run, { stopAt: (v) => v.next.some((n) => n.boss) });
    const entered = (await w.play.enterNode(playerId, run.id, atBoss.next[0]!.id)).run;

    const [abandon, fight] = await Promise.all([
      w.play.abandon(playerId, run.id),
      w.play.resolveNode(playerId, run.id, entered.node.id),
    ]);
    const final = await w.play.run(playerId, run.id);
    expect(['abandoned', 'defeated']).toContain(final.status);
    expect([abandon!.status, fight.status].sort()).toEqual(['applied', 'refused']);
    expect(await w.balance(playerId)).toBe(final.settlement!.banked);
    expect((await ledgerRows(playerId)).length).toBeLessThanOrEqual(1);
    expect((await eventTypes(run.id)).filter((t) => t === 'abandon' || t === 'defeat')).toHaveLength(1);
  });

  it('clears a run that was generated without a fighter', async () => {
    const { playerId } = await w.player();
    const raw = await w.runs.startRun({ playerId, zoneKey: MAIN });
    expect((await w.play.home(playerId)).unplayableRunId).toBe(raw.id);
    await expect(w.play.resolveNode(playerId, raw.id, raw.currentNodeId!)).rejects.toBeInstanceOf(DungeonRunUnplayableError);
    expect(await w.play.abandon(playerId, raw.id)).toBeNull();
    expect((await rowOf(raw.id)).status).toBe('abandoned');
    expect((await w.play.start(playerId, MAIN)).status).toBe('active');
  });
});

/* ─────────────────────────── currency ─────────────────────────── */

describe('the progression currency', () => {
  it('is named from its live metadata, and a disabled currency ends the run without banking', async () => {
    // Open on a fight, so there is something to bank when the rest is reached.
    const seed = await w.seedFor(MAIN, (g) => g.nodes[0]!.type === 'combat');
    const { playerId, run } = await start(MAIN, seed);
    const there = await walk(w.play, playerId, run, { stopAt: (v) => v.canExtract });
    const meta = (await w.currencies.get(CURRENCY))!;
    const renamed = (await w.currencies.updateMetadata(
      CURRENCY,
      { metadata: { singularName: 'Gleam', pluralName: 'Gleams', description: '', icon: '💠', enabled: false }, expectedRevision: meta.revision },
      'admin',
    ))!;
    try {
      expect((await w.play.run(playerId, run.id)).currency).toEqual({ key: CURRENCY, singularName: 'Gleam', pluralName: 'Gleams', icon: '💠' });
      const out = await w.play.extract(playerId, run.id, there.node.id);
      expect(out.run.status).toBe('extracted');
      expect(out.run.settlement).toMatchObject({ banked: 0, lost: there.unbankedCurrency, bankingSkipped: 'currency_disabled', balanceAfter: null });
      expect(await w.balance(playerId)).toBe(0);
    } finally {
      await w.currencies.updateMetadata(
        CURRENCY,
        { metadata: { singularName: meta.singularName, pluralName: meta.pluralName, description: meta.description, icon: meta.icon, enabled: true }, expectedRevision: renamed.revision },
        'admin',
      );
    }
  });
});
