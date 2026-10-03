/**
 * The pure rules of a playable run: rounding, HP clamps, navigation, the
 * deterministic reward draws, fights that start from the run's HP, and the
 * balance simulation built on the same functions.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NO_DAMAGE_VARIANCE } from '../../../src/modules/combat/combatMath';
import { generateDungeon } from '../../../src/modules/dungeons/dungeonGenerator';
import {
  PLAYTHROUGH_POLICIES,
  playDungeon,
  simulateDungeonPlaythroughs,
  type PlaythroughSnapshot,
} from '../../../src/modules/dungeons/dungeonPlaythrough';
import type { DungeonRunSnapshot } from '../../../src/modules/dungeons/dungeonRunService';
import {
  DUNGEON_COMBAT_SEED_SALT,
  availableNodes,
  dungeonCombatSeed,
  dungeonDrawId,
  dungeonEquipmentGrantKey,
  fighterFromCombatStats,
  fightEnemy,
  hpAfterEvent,
  hpAfterRest,
  nodeOf,
  nodePaysBand,
  rollNodeRewards,
  rollRunBonus,
  settleCurrency,
  shareOf,
  type DungeonFighter,
  type DungeonNodeStates,
} from '../../../src/modules/dungeons/dungeonRunState';
import { DungeonZoneDefinitionSchema } from '../../../src/modules/dungeons/zoneDefinition';
import { assembleCombatStats } from '../../../src/modules/equipment/equipmentMath';
import { equipmentSelectorKey } from '../../../src/modules/equipment/rewardSelector';
import { CombatBuddyRequiredError, CombatLoadoutIncompleteError } from '../../../src/shared/errors';
import { testCatalogue, testZone } from '../../helpers/dungeonFixtures';

/** Rules with no damage variance, for the tests that assert exact HP. */
const FLAT = { damageVariance: NO_DAMAGE_VARIANCE };

const FIGHTER: DungeonFighter = {
  formulaVersion: 1,
  waifuId: 7,
  speciesSlug: 'nurse',
  name: 'Nebula Nurse',
  level: 35,
  currentSp: 185,
  attack: 83,
  defense: 65,
  maxHp: 370,
  gear: {} as DungeonFighter['gear'],
};
const enemy = (key: string, attack: number, defense: number, hp: number) => ({
  key,
  name: key,
  attack,
  defense,
  hp,
  artworkPath: null,
  spriteArtworkPath: null,
  spritePlacement: null,
  enabled: true,
  tags: [],
});
const ENEMIES = {
  grunt: enemy('grunt', 60, 0, 150),
  brute: enemy('brute', 60, 0, 150),
  sentinel: enemy('sentinel', 60, 0, 160),
  warden: enemy('warden', 60, 0, 170),
  overlord: enemy('overlord', 60, 0, 300),
};
const EVENTS = {
  shrine: { key: 'shrine', name: 'Shrine', description: '', enabled: true, artworkPath: null, tags: [], hpChangeBasisPoints: 1000, paysReward: true },
  trap: { key: 'trap', name: 'Trap', description: '', enabled: true, artworkPath: null, tags: [], hpChangeBasisPoints: -1000, paysReward: false },
};
const GEAR = {
  id: 'gear',
  enabled: true,
  waifuXp: 0,
  playerXp: 0,
  waifubux: { min: 3, max: 9 },
  groups: [{ id: 'g', enabled: true, rolls: 1, chanceBasisPoints: 10_000, entries: [], equipment: [{ rarity: 'N' as const, enabled: true, weight: 1 }] }],
};
const POOLS = { [equipmentSelectorKey({ rarity: 'N' })]: [{ key: 'pipe', name: 'Pipe', slot: 'attack' as const, rarity: 'N' }, { key: 'plate', name: 'Plate', slot: 'defense' as const, rarity: 'N' }] };

function snapshotFor(zone = testZone(), tables: DungeonRunSnapshot['rewardTables'] = {}): DungeonRunSnapshot {
  return { zone, enemies: ENEMIES, events: EVENTS, rewardTables: tables } as unknown as DungeonRunSnapshot;
}

describe('rounding', () => {
  it('takes a share toward zero', () => {
    expect(shareOf(370, 3000)).toBe(111);
    expect(shareOf(370, 500)).toBe(18);
    expect(shareOf(370, -1000)).toBe(-37);
    expect(shareOf(3, 2500)).toBe(0);
    expect(shareOf(4, 2500)).toBe(1);
  });

  it.each([
    [40, 2500, 10, 30],
    [3, 2500, 0, 3],
    [7, 2500, 1, 6],
    [9, 10_000, 9, 0],
    [9, 0, 0, 9],
    [0, 2500, 0, 0],
  ])('settles %i at %i bp as %i banked, %i lost', (total, bp, banked, lost) => {
    expect(settleCurrency(total, bp)).toEqual({ banked, lost });
  });
});

describe('HP changes', () => {
  it('a rest heals by its share and never past max', () => {
    expect(hpAfterRest(FIGHTER, 100, 3000)).toBe(211);
    expect(hpAfterRest(FIGHTER, 334, 3000)).toBe(370);
    expect(hpAfterRest(FIGHTER, 370, 3000)).toBe(370);
    expect(hpAfterRest(FIGHTER, 1, 10_000)).toBe(370);
    expect(hpAfterRest(FIGHTER, 200, 0)).toBe(200);
  });

  it('an event heals or hurts within 1..max — it never ends a run', () => {
    expect(hpAfterEvent(FIGHTER, 200, 1000)).toBe(237);
    expect(hpAfterEvent(FIGHTER, 360, 1000)).toBe(370);
    expect(hpAfterEvent(FIGHTER, 200, -1000)).toBe(163);
    expect(hpAfterEvent(FIGHTER, 20, -1000)).toBe(1);
    expect(hpAfterEvent(FIGHTER, 370, -10_000)).toBe(1);
    expect(hpAfterEvent(FIGHTER, 200, 0)).toBe(200);
  });
});

describe('the fighter snapshot', () => {
  const item = (equipmentId: number, multiplierBp: number) => ({
    equipmentId,
    definitionKey: `def_${equipmentId}`,
    name: `Item ${equipmentId}`,
    definitionName: `Item ${equipmentId}`,
    affixKey: null,
    rarity: 'N',
    multiplierBp,
    rolledProperties: {},
  });
  const buddy = { waifuId: 7, speciesSlug: 'nurse', name: 'Nebula Nurse', level: 35, baseSp: 100, currentSp: 185 };

  it('freezes the stats and names the gear they came from', () => {
    const stats = assembleCombatStats({
      buddy,
      loadoutId: 1,
      slots: { attack: item(1, 4500), defense: item(2, 3500), health: item(3, 20_000) },
    });
    expect(fighterFromCombatStats(stats)).toMatchObject({
      waifuId: 7,
      name: 'Nebula Nurse',
      currentSp: 185,
      attack: 83,
      defense: 65,
      maxHp: 370,
      gear: { attack: { equipmentId: 1, multiplierBp: 4500 }, health: { equipmentId: 3, name: 'Item 3' } },
    });
  });

  it('refuses a missing Buddy or an empty slot', () => {
    const slots = { attack: item(1, 4500), defense: item(2, 3500), health: item(3, 20_000) };
    expect(() => fighterFromCombatStats(assembleCombatStats({ buddy: null, loadoutId: 1, slots }))).toThrow(CombatBuddyRequiredError);
    expect(() =>
      fighterFromCombatStats(assembleCombatStats({ buddy, loadoutId: 1, slots: { ...slots, health: null } })),
    ).toThrow(CombatLoadoutIncompleteError);
  });
});

describe('navigation', () => {
  const graph = generateDungeon(testZone(), testCatalogue(), 3);
  const completed = (id: string): DungeonNodeStates => ({
    [id]: { status: 'completed', enteredAt: '', completedAt: '', resolution: { kind: 'exit' } },
  });

  it('offers nothing until the current node is completed, then exactly its outgoing nodes', () => {
    const start = graph.startNodeId;
    const entered: DungeonNodeStates = { [start]: { status: 'entered', enteredAt: '', completedAt: null, resolution: null } };
    expect(availableNodes(graph, {}, start)).toEqual([]);
    expect(availableNodes(graph, entered, start)).toEqual([]);
    const next = availableNodes(graph, completed(start), start).map((n) => n.id);
    expect(next).toEqual(graph.edges.filter((e) => e.from === start).map((e) => e.to));
    expect(next.length).toBeGreaterThan(0);
  });

  it('offers nothing past the terminal node or for an unknown node', () => {
    expect(availableNodes(graph, completed(graph.terminalNodeId), graph.terminalNodeId)).toEqual([]);
    expect(availableNodes(graph, completed('n99'), 'n99')).toEqual([]);
    expect(nodeOf(graph, null)).toBeNull();
  });
});

describe('reward draws', () => {
  const zone = testZone({
    rewards: {
      bands: [
        { id: 'all', currency: { min: 1, max: 9 } },
        { id: 'cache', nodeTypes: ['reward'], currency: { min: 5, max: 5 }, equipmentRewardTable: 'gear' },
      ],
      completion: { currency: { min: 4, max: 4 }, rewardTable: 'gear' },
    },
  });
  const graph = [...Array(200).keys()]
    .map((seed) => generateDungeon(zone, testCatalogue(), seed + 1))
    .find((g) => ['combat', 'reward', 'rest'].every((type) => g.nodes.some((n) => n.type === type)))!;
  const snapshot = snapshotFor(zone, { gear: { table: GEAR, equipmentPools: POOLS } });
  const byType = (type: string) => graph.nodes.find((n) => n.type === type)!;

  it('are the same every time they are asked for', () => {
    for (const node of graph.nodes) {
      expect(rollNodeRewards(snapshot, graph, node)).toEqual(rollNodeRewards(snapshot, graph, node));
    }
    expect(rollRunBonus(snapshot, graph, 'completion')).toEqual(rollRunBonus(snapshot, graph, 'completion'));
  });

  it('pay a fight and a reward node their band, and a rest nothing', () => {
    const fight = rollNodeRewards(snapshot, graph, byType('combat'));
    expect(fight.currency).toBeGreaterThanOrEqual(1);
    expect(fight.currency).toBeLessThanOrEqual(9);
    expect(fight.equipment).toEqual([]);

    const cache = rollNodeRewards(snapshot, graph, byType('reward'));
    expect(cache.currency).toBe(5);
    expect(cache.waifubux).toBeGreaterThanOrEqual(3);
    expect(cache.equipment).toHaveLength(1);
    expect(['pipe', 'plate']).toContain(cache.equipment[0]!.definitionKey);

    expect(nodePaysBand(snapshot, byType('rest'))).toBe(false);
    expect(rollNodeRewards(snapshot, graph, byType('rest'))).toEqual({ currency: 0, waifubux: 0, items: [], equipment: [] });
  });

  it('pay an event only when it is authored to', () => {
    const eventNode = (key: string) => ({ ...byType('combat'), type: 'event' as const, content: { kind: 'event' as const, key } });
    expect(nodePaysBand(snapshot, eventNode('shrine'))).toBe(true);
    expect(nodePaysBand(snapshot, eventNode('trap'))).toBe(false);
  });

  it('pay nothing from a table that was disabled when the run started', () => {
    const off = snapshotFor(zone, { gear: null });
    expect(rollNodeRewards(off, graph, byType('reward'))).toEqual({ currency: 5, waifubux: 0, items: [], equipment: [] });
    expect(rollRunBonus(off, graph, 'completion')).toMatchObject({ currency: 4, equipment: [] });
    expect(rollRunBonus(off, graph, 'extraction')).toEqual({ currency: 0, waifubux: 0, items: [], equipment: [] });
  });

  it('key every payout on its own draw id and every gear drop on a stable grant key', () => {
    const ids = new Set<number>();
    for (let ordinal = 0; ordinal <= 40; ordinal++) {
      for (const slot of ['band', 'bandGear', 'completion', 'extraction'] as const) ids.add(dungeonDrawId(99, ordinal, slot));
    }
    expect(ids.size).toBe(41 * 4);
    expect(dungeonDrawId(98, 40, 'extraction')).toBeLessThan(dungeonDrawId(99, 0, 'band'));
    expect(Number.isSafeInteger(dungeonDrawId(0xffff_ffff, 40, 'extraction'))).toBe(true);
    expect(dungeonEquipmentGrantKey(12, 'n4', 0)).toBe('dungeon:12:n4:0');
    expect(dungeonEquipmentGrantKey(12, 'n4', 1)).not.toBe(dungeonEquipmentGrantKey(12, 'n5', 1));
  });
});

describe('fights', () => {
  const zone = testZone();
  const graph = generateDungeon(zone, testCatalogue(), 3);

  it('start from the HP the run carries, not from full', () => {
    const full = fightEnemy(FIGHTER, 370, ENEMIES.grunt, 1, FLAT);
    expect(full).toMatchObject({ result: 'player_victory', hpBefore: 370, hpAfter: 334, rounds: 2, enemyHpAfter: 0 });
    const hurt = fightEnemy(FIGHTER, 100, ENEMIES.grunt, 1, FLAT);
    expect(hurt).toMatchObject({ result: 'player_victory', hpBefore: 100, hpAfter: 64 });
    expect(hurt.events[0]).toMatchObject({ type: 'combat_started', player: { currentHp: 100, maxHp: 370 } });
  });

  it('are lost at 0 HP when the run has too little left', () => {
    expect(fightEnemy(FIGHTER, 30, ENEMIES.grunt, 1, FLAT)).toMatchObject({ result: 'enemy_victory', hpAfter: 0 });
  });

  it('roll damage from a seed derived from the run seed and the node — a stream of their own', () => {
    // Pinned: the derivation is md5("<seed>:<node>:combat:<salt>"), first 32 bits.
    expect(DUNGEON_COMBAT_SEED_SALT).toBe('waifumon.dungeon.combat.v1');
    expect(dungeonCombatSeed(42, 'n3')).toBe(
      Number.parseInt(createHash('md5').update('42:n3:combat:waifumon.dungeon.combat.v1').digest('hex').slice(0, 8), 16),
    );
    expect(dungeonCombatSeed(42, 'n3')).toBe(dungeonCombatSeed(42, 'n3'));
    expect(dungeonCombatSeed(42, 'n3')).not.toBe(dungeonCombatSeed(42, 'n4'));
    expect(dungeonCombatSeed(42, 'n3')).not.toBe(dungeonCombatSeed(43, 'n3'));
    // Unsigned 32-bit: the range `seededRng` takes.
    for (const [seed, node] of [[0, 'n1'], [0xffff_ffff, 'n40'], [7, 'n12']] as const) {
      const s = dungeonCombatSeed(seed, node);
      expect(Number.isInteger(s) && s >= 0 && s <= 0xffff_ffff).toBe(true);
    }
  });

  it('are reproducible: the same seed and starting HP give the same fight, event for event', () => {
    const seed = dungeonCombatSeed(graph.seed, 'n2');
    const first = fightEnemy(FIGHTER, 370, ENEMIES.grunt, seed);
    expect(fightEnemy(FIGHTER, 370, ENEMIES.grunt, seed)).toEqual(first);
    expect(first.combatSeed).toBe(seed);
    // Under the default rules the hits vary, inside 90%–110% of base.
    const hits = first.events.filter((e) => e.type === 'damage');
    for (const hit of hits) {
      if (hit.type !== 'damage') continue;
      expect(hit.varianceBasisPoints).toBeGreaterThanOrEqual(9_000);
      expect(hit.varianceBasisPoints).toBeLessThanOrEqual(11_000);
    }
  });

  it('differ between nodes of one run and between runs', () => {
    const outcomes = new Set<number>();
    for (let n = 1; n <= 30; n++) outcomes.add(fightEnemy(FIGHTER, 370, ENEMIES.grunt, dungeonCombatSeed(5, `n${n}`)).hpAfter);
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('do not depend on how the layout was generated: generating again changes nothing', () => {
    const seed = dungeonCombatSeed(graph.seed, 'n2');
    const before = fightEnemy(FIGHTER, 370, ENEMIES.grunt, seed);
    // Drain the layout generator's stream some more; combat has its own.
    for (let i = 0; i < 5; i++) generateDungeon(zone, testCatalogue(), graph.seed);
    expect(fightEnemy(FIGHTER, 370, ENEMIES.grunt, seed)).toEqual(before);
  });
});

describe('the balance simulation', () => {
  const zone = DungeonZoneDefinitionSchema.parse(testZone());
  const content: PlaythroughSnapshot = snapshotFor(zone);
  const strong = { attack: 400, defense: 400, maxHp: 4000 };
  const weak = { attack: 5, defense: 0, maxHp: 30 };

  it('plays a run to its end with the same rules, deterministically', () => {
    const a = playDungeon(content, testCatalogue(), strong, 5, { extractAtHpBasisPoints: null });
    expect(a).toEqual(playDungeon(content, testCatalogue(), strong, 5, { extractAtHpBasisPoints: null }));
    expect(a).toMatchObject({ outcome: 'completed', defeatedBy: null });
    expect(a.depth).toBe(a.depthCount);
    expect(a.banked).toBe(a.earned);
  });

  it('reports rates that add up, and what killed the runs that died', () => {
    const report = simulateDungeonPlaythroughs(content, testCatalogue(), weak, { runs: 50, policy: { extractAtHpBasisPoints: null } });
    expect(report.runs).toBe(50);
    expect(report.completionRate + report.extractionRate + report.defeatRate).toBeCloseTo(1);
    expect(report.defeatRate).toBe(1);
    expect(report.averageHpShareAtExit).toBeNull();
    expect(report.defeatedBy.reduce((sum, k) => sum + k.runs, 0)).toBe(50);
    // A defeat banks the zone's 25%, rounded toward zero, of whatever was earned.
    expect(report.averageBanked).toBeLessThanOrEqual(report.averageEarned / 4);
  });

  it('reports reaching the first extraction separately from what the policy then did', () => {
    const never = simulateDungeonPlaythroughs(content, testCatalogue(), strong, { runs: 50, policy: { extractAtHpBasisPoints: null } });
    const always = simulateDungeonPlaythroughs(content, testCatalogue(), strong, { runs: 50, policy: { extractAtHpBasisPoints: 10_000 } });
    // A build that cannot die reaches the guaranteed point whether or not it leaves there.
    expect(never.firstExtractionReachRate).toBe(1);
    expect(always.firstExtractionReachRate).toBe(1);
    expect(never.extractionRate).toBe(0);
    expect(never.averageFirstExtractionDepth).toBe(always.averageFirstExtractionDepth);
    expect(always.averageExtractionOpportunities).toBe(1);
    expect(never.averageExtractionOpportunities).toBeGreaterThanOrEqual(1);
    // A build that dies on the first fight never gets there.
    const dead = simulateDungeonPlaythroughs(content, testCatalogue(), weak, { runs: 50, policy: { extractAtHpBasisPoints: 10_000 } });
    expect(dead.firstExtractionReachRate).toBeLessThan(1);
    expect(Object.values(dead.defeatsByDepth).reduce((a, b) => a + b, 0)).toBe(Math.round(dead.defeatRate * 50));
    expect(always.averageEquipment).toBeCloseTo(Object.values(always.equipmentPerRun).reduce((a, b) => a + b, 0));
  });

  it('names the three extraction strategies the reports compare', () => {
    const byKey = Object.fromEntries(PLAYTHROUGH_POLICIES.map((p) => [p.key, p.extractAtHpBasisPoints]));
    expect(byKey).toMatchObject({ aggressive: null, cautious: 5_000, conservative: 7_000 });
  });

  it('extracts at an extraction point when the policy says to', () => {
    const always = simulateDungeonPlaythroughs(content, testCatalogue(), strong, { runs: 50, policy: { extractAtHpBasisPoints: 10_000 } });
    expect(always.extractionRate).toBe(1);
    expect(always.averageProgress).toBeLessThan(1);
    const never = simulateDungeonPlaythroughs(content, testCatalogue(), strong, { runs: 50, policy: { extractAtHpBasisPoints: null } });
    expect(never.completionRate).toBe(1);
    expect(never.averageBanked).toBeGreaterThan(always.averageBanked);
  });
});
