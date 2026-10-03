/**
 * The shipped dungeon content: the first zone, its events, and a simulation
 * of the zone as a sanity check on the initial tuning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readContentFiles } from '../../../src/modules/content/loader';
import { validateDungeonGraph, generateDungeon } from '../../../src/modules/dungeons/dungeonGenerator';
import { PLAYTHROUGH_POLICIES, simulateDungeonPlaythroughs, type PlaythroughSnapshot } from '../../../src/modules/dungeons/dungeonPlaythrough';
import { simulateDungeonGeneration } from '../../../src/modules/dungeons/dungeonSimulation';
import { dungeonCatalogueFromContent, loadShippedDungeonZones } from '../../../src/modules/dungeons/dungeonZoneStore';
import { DUNGEON_EVENT_FILE, DungeonEventFileSchema } from '../../../src/modules/dungeons/eventDefinitions';
import { depthInRange } from '../../../src/modules/dungeons/zoneDefinition';
import { validateDungeonZone } from '../../../src/modules/dungeons/zoneValidation';
import { deriveStat } from '../../../src/modules/equipment/equipmentMath';
import { STARTER_ROLLS } from '../../../src/modules/onboarding/vocabulary';
import { CONTENT_DIR } from '../../helpers/fixtures';

const content = readContentFiles(CONTENT_DIR);
const catalogue = dungeonCatalogueFromContent(content);
const zones = loadShippedDungeonZones(CONTENT_DIR);
const gauntlet = zones.find((z) => z.key === 'scrapheap_gauntlet')!.definition;

describe('shipped dungeon events', () => {
  it('load through the content loader, enabled and unique', () => {
    const file = DungeonEventFileSchema.parse(
      JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, DUNGEON_EVENT_FILE), 'utf8')),
    );
    expect(content.dungeonEvents?.map((e) => e.key)).toEqual(file.events.map((e) => e.key));
    expect(file.events.length).toBeGreaterThan(0);
  });

  it('refuses a duplicate key and an unsafe artwork path', () => {
    const event = { key: 'a', name: 'A', enabled: true };
    const file = (events: unknown[]) => ({ format: 'waifumon-dungeon-events', version: 1, events });
    expect(DungeonEventFileSchema.safeParse(file([event, event])).success).toBe(false);
    expect(DungeonEventFileSchema.safeParse(file([{ ...event, artworkPath: '../x.png' }])).success).toBe(false);
    expect(DungeonEventFileSchema.safeParse(file([{ ...event, artworkPath: 'dungeons/events/a.webp' }])).success).toBe(true);
  });
});

describe('Scrapheap Gauntlet', () => {
  it('ships enabled, tagged as initial tuning, with conventional artwork paths', () => {
    expect(gauntlet).toMatchObject({
      enabled: true,
      artworkPath: 'dungeons/zones/scrapheap_gauntlet.webp',
      backgroundArtworkPath: 'dungeons/backgrounds/scrapheap_gauntlet.webp',
    });
    expect(gauntlet.tags).toContain('initial_tuning');
    expect(gauntlet.rewards.defeatCurrencyRetentionBasisPoints).toBe(2500);
  });

  it('validates against the shipped enemies and events with no errors or warnings', () => {
    const { issues } = validateDungeonZone(gauntlet, {
      catalogue,
      rewardTables: new Map(content.expeditionRewards.map((t) => [t.id, { enabled: t.enabled }])),
      currencies: new Map([['ascension_currency', { enabled: true }]]),
    });
    expect(issues).toEqual([]);
  });

  it('is playable: rests heal, the special nodes pay from shipped tables, and it is all marked initial tuning', () => {
    expect(gauntlet.nodeSettings.rest.healBasisPoints).toBe(3000);
    const tables = new Map(content.expeditionRewards.map((t) => [t.id, t]));
    const gearBands = gauntlet.rewards.bands.filter((b) => b.equipmentRewardTable);
    expect(gearBands.map((b) => b.id).sort()).toEqual(['boss', 'cache', 'elite']);
    for (const band of gearBands) {
      const table = tables.get(band.equipmentRewardTable!)!;
      expect(table).toMatchObject({ enabled: true });
      expect(table.version).toContain('initial_tuning');
      // Gear is a chance, never a certainty, and never SSR/UR.
      for (const group of table.groups) {
        expect(group.chanceBasisPoints).toBeLessThan(10_000);
        expect(group.equipment!.every((e) => ['N', 'R', 'SR'].includes(e.rarity!))).toBe(true);
      }
    }
    // An ordinary fight pays currency only.
    for (const id of ['early', 'mid', 'deep']) {
      expect(gauntlet.rewards.bands.find((b) => b.id === id)).toMatchObject({ rewardTable: null, equipmentRewardTable: null });
    }
    expect(gauntlet.rewards.completion.currency).toEqual({ min: 10, max: 10 });
    for (const event of content.dungeonEvents ?? []) expect(event.tags).toContain('initial_tuning');
  });

  it('references only enemies that exist, and a boss marked temporary', () => {
    const enemies = new Map((content.combatEnemies ?? []).map((e) => [e.key, e]));
    for (const pool of ['combat', 'elite', 'miniboss', 'boss'] as const) {
      for (const entry of gauntlet.pools[pool]) expect(enemies.has(entry.enemyKey)).toBe(true);
    }
    expect(enemies.get(gauntlet.pools.boss[0]!.enemyKey)?.tags).toContain('temporary');
  });

  it('simulates cleanly over 2000 seeds and matches its brief', () => {
    const report = simulateDungeonGeneration(gauntlet, catalogue, { runs: 2000 });
    expect(report.invalid).toBe(0);
    expect(report.minNodeCount).toBeGreaterThanOrEqual(6);
    expect(report.maxNodeCount).toBeLessThanOrEqual(9);
    // Mandatory boss and rest; extraction always reachable.
    expect(report.bossRate).toBe(1);
    expect(report.restRate).toBe(1);
    expect(report.extractionRate).toBe(1);
    // A small chance of one branch; an optional elite.
    expect(report.branchRate).toBeGreaterThan(0.1);
    expect(report.branchRate).toBeLessThan(0.45);
    expect(report.averageBranches).toBeLessThanOrEqual(1);
    expect(report.nodeTypeRunRate.elite).toBeGreaterThan(0.05);
    expect(report.nodeTypeRunRate.elite).toBeLessThan(0.6);
    // Combat-heavy: the most common type by a clear margin.
    for (const type of ['elite', 'event', 'reward', 'rest'] as const) {
      expect(report.nodeTypeShare.combat).toBeGreaterThan(report.nodeTypeShare[type] * 2);
    }
    // Every authored enemy and event shows up.
    expect(report.enemies.map((e) => e.key).sort()).toEqual(
      ['alley_bruiser', 'scrapheap_colossus', 'scrapyard_drone', 'security_automaton'].sort(),
    );
    expect(report.events).toHaveLength(3);
  });

  it('gates its enemies by depth: drones open the run, the Bruiser from 3, the Automaton from 5', () => {
    const eligible = (depth: number) =>
      gauntlet.pools.combat.filter((e) => e.enabled && e.weight > 0 && depthInRange(depth, e)).map((e) => e.enemyKey).sort();
    expect(eligible(1)).toEqual(['scrapyard_drone']);
    expect(eligible(2)).toEqual(['scrapyard_drone']);
    expect(eligible(3)).toEqual(['alley_bruiser', 'scrapyard_drone']);
    expect(eligible(4)).toEqual(['alley_bruiser', 'scrapyard_drone']);
    expect(eligible(5)).toEqual(['alley_bruiser', 'security_automaton']);
    expect(eligible(7)).toEqual(['alley_bruiser', 'security_automaton']);
    expect(eligible(8)).toEqual(['security_automaton']);
    // The elite is the Automaton again, so it waits for the same depth.
    expect(gauntlet.pools.elite.map((e) => [e.enemyKey, e.minDepth])).toEqual([['security_automaton', 5]]);
    expect(gauntlet.generation.depthRanges.elite).toMatchObject({ minDepth: 5 });
    // The stat blocks themselves are the shared Combat Trial enemies, untouched.
    const stats = Object.fromEntries((content.combatEnemies ?? []).map((e) => [e.key, [e.attack, e.defense, e.hp]]));
    expect(stats).toMatchObject({
      scrapyard_drone: [55, 30, 300],
      alley_bruiser: [100, 55, 520],
      security_automaton: [140, 90, 800],
      scrapheap_colossus: [170, 110, 1200],
    });
  });

  it('offers an early way out always and a later one where the run has room — never on every node', () => {
    expect(gauntlet.generation.extraction).toEqual({
      minDepth: 3,
      nodeTypes: ['rest', 'exit'],
      minPoints: 1,
      windows: [
        { minDepth: 3, maxDepth: 4, required: true },
        { minDepth: 6, maxDepth: null, required: false },
      ],
    });
    // One rest per run: the early window takes it, so the later way out is a bare exit — no heal.
    expect(gauntlet.generation.limits).toContainEqual({ types: ['rest'], max: 1 });
    expect(gauntlet.generation.required).toContainEqual({ types: ['rest'], min: 1 });
    expect(gauntlet.generation.nodeWeights.exit).toBe(0);
  });

  it('generates 5000 seeds with none invalid, each with its rest, its early extraction and its boss', () => {
    let twoPoints = 0;
    let longRuns = 0;
    for (let seed = 1; seed <= 5000; seed++) {
      const graph = generateDungeon(gauntlet, catalogue, seed);
      expect(validateDungeonGraph(gauntlet, graph), `seed ${seed}`).toEqual([]);
      const perDepth = new Map<number, number>();
      for (const n of graph.nodes) perDepth.set(n.depth, (perDepth.get(n.depth) ?? 0) + 1);
      const main = graph.nodes.filter((n) => perDepth.get(n.depth) === 1);
      const points = main.filter((n) => n.extraction);

      // Required behaviour: one boss at the end, exactly one rest, a reward or event on the main path.
      expect(graph.nodes.filter((n) => n.boss).map((n) => n.id)).toEqual([graph.terminalNodeId]);
      expect(graph.nodes.filter((n) => n.type === 'rest')).toHaveLength(1);
      expect(main.some((n) => n.type === 'reward' || n.type === 'event')).toBe(true);

      // The first way out is the rest, at depth 3 or 4, and nothing but drones stands before depth 3.
      expect(points.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(points.length).toBeLessThanOrEqual(2);
      expect(points[0]).toMatchObject({ type: 'rest' });
      expect([3, 4]).toContain(points[0]!.depth);
      for (const n of graph.nodes) {
        if (n.content?.kind === 'enemy' && n.depth <= 2) expect(n.content.key).toBe('scrapyard_drone');
        if (n.type === 'elite') expect(n.depth).toBeGreaterThanOrEqual(5);
        // Extraction is never on the final node, and only ever a rest or an exit.
        if (n.extraction) expect(n.terminal).toBe(false);
      }
      // A second way out, when there is one, is a bare exit at depth 6 or deeper.
      if (points[1]) {
        expect(points[1]).toMatchObject({ type: 'exit' });
        expect(points[1].depth).toBeGreaterThanOrEqual(6);
        twoPoints += 1;
      }
      if (graph.depthCount >= 8) longRuns += 1;
    }
    // Most runs long enough to have a depth-6 interior node get the later one.
    expect(twoPoints).toBeGreaterThan(5000 * 0.5);
    expect(twoPoints).toBeGreaterThan(longRuns);
  });

  describe('initial tuning for a newly eligible player (Current SP 185)', () => {
    const snapshot: PlaythroughSnapshot = {
      zone: gauntlet,
      enemies: Object.fromEntries((content.combatEnemies ?? []).map((e) => [e.key, e])),
      events: Object.fromEntries((content.dungeonEvents ?? []).map((e) => [e.key, e])),
      // Gear is not what these guards measure.
      rewardTables: {},
    };
    const build = (sp: number, [attack, defense, health]: readonly number[]) => ({
      attack: deriveStat(sp, attack!),
      defense: deriveStat(sp, defense!),
      maxHp: deriveStat(sp, health!),
    });
    const STARTER = [STARTER_ROLLS.attack.rolledMultiplierBp, STARTER_ROLLS.defense.rolledMultiplierBp, STARTER_ROLLS.health.rolledMultiplierBp];
    const policy = (key: (typeof PLAYTHROUGH_POLICIES)[number]['key']) => PLAYTHROUGH_POLICIES.find((p) => p.key === key)!;
    const play = (fighter: ReturnType<typeof build>, key: Parameters<typeof policy>[0]) =>
      simulateDungeonPlaythroughs(snapshot, catalogue, fighter, { runs: 2000, policy: policy(key) });

    // Tuning guards, not exact pins: they hold the *shape* the zone is meant to have.
    it('starter gear usually survives to the first extraction, and never finishes the dungeon', () => {
      const starter = build(185, STARTER);
      expect(starter).toEqual({ attack: 83, defense: 65, maxHp: 370 });
      const pushing = play(starter, 'aggressive');
      expect(pushing.firstExtractionReachRate).toBeGreaterThan(0.65);
      expect(pushing.firstExtractionReachRate).toBeLessThan(0.92);
      expect(pushing.completionRate).toBeLessThan(0.01);
      // Leaving at the first chance banks something, and usually works.
      const leaving = play(starter, 'first_exit');
      expect(leaving.extractionRate).toBe(leaving.firstExtractionReachRate);
      expect(leaving.averageBanked).toBeGreaterThan(pushing.averageBanked);
      expect(leaving.averageBanked).toBeGreaterThan(1);
    });

    it('gets further with better gear, and the boss still needs more than gear alone at this SP', () => {
      const depth = (multipliers: readonly number[]) => play(build(185, multipliers), 'aggressive').averageDepth;
      const starter = depth(STARTER);
      const improvedN = depth([7_000, 6_000, 24_000]);
      const r = depth([8_500, 7_500, 26_000]);
      expect(improvedN).toBeGreaterThan(starter + 0.5);
      expect(r).toBeGreaterThan(improvedN);
      expect(play(build(185, [8_500, 7_500, 26_000]), 'aggressive').completionRate).toBeLessThan(0.05);
    });

    it('is finished reliably by strong gear on a strong Buddy', () => {
      expect(play(build(300, [11_000, 10_000, 26_000]), 'aggressive').completionRate).toBeGreaterThan(0.9);
    });
  });

  it('is deterministic: the same arguments give the same report', () => {
    const a = simulateDungeonGeneration(gauntlet, catalogue, { runs: 200, firstSeed: 50 });
    expect(simulateDungeonGeneration(gauntlet, catalogue, { runs: 200, firstSeed: 50 })).toEqual(a);
    for (let seed = 50; seed < 60; seed++) {
      expect(validateDungeonGraph(gauntlet, generateDungeon(gauntlet, catalogue, seed))).toEqual([]);
    }
  });

  it('counts failed seeds instead of throwing', () => {
    const broken = { ...gauntlet, pools: { ...gauntlet.pools, boss: [] } };
    const report = simulateDungeonGeneration(broken, catalogue, { runs: 25 });
    expect(report).toMatchObject({ valid: 0, invalid: 25, invalidRate: 1, averageNodeCount: 0 });
    expect(Object.keys(report.failures)[0]).toMatch(/no eligible boss/);
    expect(() => simulateDungeonGeneration(gauntlet, catalogue, { runs: 0 })).toThrow(RangeError);
  });
});
