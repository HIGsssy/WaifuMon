/**
 * The shipped dungeon content: the first zone, its events, and a simulation
 * of the zone as a sanity check on the initial tuning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readContentFiles } from '../../../src/modules/content/loader';
import { validateDungeonGraph, generateDungeon } from '../../../src/modules/dungeons/dungeonGenerator';
import { simulateDungeonGeneration } from '../../../src/modules/dungeons/dungeonSimulation';
import { dungeonCatalogueFromContent, loadShippedDungeonZones } from '../../../src/modules/dungeons/dungeonZoneStore';
import { DUNGEON_EVENT_FILE, DungeonEventFileSchema } from '../../../src/modules/dungeons/eventDefinitions';
import { validateDungeonZone } from '../../../src/modules/dungeons/zoneValidation';
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
      rewardTables: new Map(),
      currencies: new Map([['ascension_currency', { enabled: true }]]),
    });
    expect(issues).toEqual([]);
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
