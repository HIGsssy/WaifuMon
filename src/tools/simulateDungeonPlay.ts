#!/usr/bin/env tsx
/**
 * `npm run dungeons:playtest` — play many runs of a shipped dungeon zone in
 * memory, for a spread of builds, and print how they went.
 *
 * Reads the content directory only (the zone, the combat enemies, the dungeon
 * events, the reward tables and the Equipment seed catalogue), so it needs no
 * database and reports on the zone as Git ships it. Fights, reward draws and
 * settlement are the same pure rules a real run uses (`dungeonRunState.ts`).
 *
 * A build is three Equipment multipliers applied to a Current SP — exactly how
 * real stats are derived. `--sp` takes a comma-separated list. Every build is
 * played under each extraction strategy (`PLAYTHROUGH_POLICIES`).
 *
 * Delve runs are capped per day, so rewards are also reported per full daily
 * allowance: per-run averages × `--daily` (default: the shipped daily limit).
 *
 * Usage:
 *   npm run dungeons:playtest
 *   npm run dungeons:playtest -- --zone scrapheap_gauntlet --runs 5000 --sp 185,300,450
 *   npm run dungeons:playtest -- --daily 3 --graphs
 *   npm run dungeons:playtest -- --json
 */
import path from 'node:path';
import process from 'node:process';
import { readContentFiles } from '../modules/content/loader';
import { DEFAULT_DUNGEON_DAILY_RUN_LIMIT } from '../modules/dungeons/dungeonAllowanceService';
import { generateDungeon } from '../modules/dungeons/dungeonGenerator';
import {
  PLAYTHROUGH_POLICIES,
  simulateDungeonPlaythroughs,
  type PlaythroughSnapshot,
} from '../modules/dungeons/dungeonPlaythrough';
import { dungeonCatalogueFromContent, loadShippedDungeonZones } from '../modules/dungeons/dungeonZoneStore';
import { deriveStat } from '../modules/equipment/equipmentMath';
import { loadEquipmentSeedCatalogue } from '../modules/equipment/seed';
import { equipmentSelectorsOf, resolveEquipmentPools } from '../modules/rewardTables/rewardTableCore';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Multipliers in basis points: the onboarding starters, then typical rolls by tier. */
const BUILDS = [
  { key: 'starter', label: 'Starter gear', attackBp: 4_500, defenseBp: 3_500, healthBp: 20_000 },
  { key: 'improved_n', label: 'Improved N', attackBp: 7_000, defenseBp: 6_000, healthBp: 24_000 },
  { key: 'r', label: 'R gear', attackBp: 8_500, defenseBp: 7_500, healthBp: 26_000 },
  { key: 'r_sr', label: 'Strong R / SR', attackBp: 11_000, defenseBp: 10_000, healthBp: 26_000 },
] as const;
const POLICIES = PLAYTHROUGH_POLICIES;

const contentDir = path.resolve(arg('content') ?? process.env.CONTENT_DIR ?? 'content');
const zones = loadShippedDungeonZones(contentDir);
const zoneKey = arg('zone') ?? zones[0]?.key;
const zone = zones.find((z) => z.key === zoneKey)?.definition;
if (!zone) {
  console.error(`No shipped dungeon zone "${String(zoneKey)}". Shipped: ${zones.map((z) => z.key).join(', ') || 'none'}`);
  process.exit(1);
}

const content = readContentFiles(contentDir);
const definitions = loadEquipmentSeedCatalogue(contentDir).map((d) => ({
  key: d.key,
  name: d.name,
  slot: d.slot,
  rarity: d.rarity,
  enabled: d.enabled ?? true,
}));
const tableIds = new Set(
  [
    ...zone.rewards.bands.flatMap((b) => [b.rewardTable, b.equipmentRewardTable]),
    zone.rewards.completion.rewardTable,
    zone.rewards.extraction.rewardTable,
  ].filter((id): id is string => id != null),
);
const rewardTables: PlaythroughSnapshot['rewardTables'] = {};
for (const id of tableIds) {
  const table = content.expeditionRewards.find((t) => t.id === id);
  if (!table) {
    console.error(`Zone "${zone.key}" names reward table "${id}", which content does not ship.`);
    process.exit(1);
  }
  rewardTables[id] = table.enabled
    ? { table, equipmentPools: resolveEquipmentPools(equipmentSelectorsOf([table]), definitions) }
    : null;
}
const snapshot: PlaythroughSnapshot = {
  zone,
  enemies: Object.fromEntries((content.combatEnemies ?? []).map((e) => [e.key, e])),
  events: Object.fromEntries((content.dungeonEvents ?? []).map((e) => [e.key, e])),
  rewardTables,
};
const catalogue = dungeonCatalogueFromContent(content);

const runs = Number(arg('runs') ?? 2000);
const firstSeed = Number(arg('seed') ?? 1);
const daily = Number(arg('daily') ?? DEFAULT_DUNGEON_DAILY_RUN_LIMIT);
const spValues = (arg('sp') ?? '185,300,450').split(',').map((v) => Number(v.trim()));

/** What the generator lays out, independent of any build: run length and where a player may leave. */
function graphReport() {
  let valid = 0;
  let invalid = 0;
  const points: Record<number, number> = {};
  const firstDepth: Record<number, number> = {};
  const depthCounts: Record<number, number> = {};
  for (let i = 0; i < runs; i++) {
    let graph;
    try {
      graph = generateDungeon(zone!, catalogue, firstSeed + i);
    } catch {
      invalid += 1;
      continue;
    }
    valid += 1;
    // Main-path extraction nodes: the ones no route can walk around.
    const perDepth = new Map<number, number>();
    for (const n of graph.nodes) perDepth.set(n.depth, (perDepth.get(n.depth) ?? 0) + 1);
    const mainPath = graph.nodes.filter((n) => n.extraction && perDepth.get(n.depth) === 1);
    points[mainPath.length] = (points[mainPath.length] ?? 0) + 1;
    const first = Math.min(...mainPath.map((n) => n.depth));
    if (Number.isFinite(first)) firstDepth[first] = (firstDepth[first] ?? 0) + 1;
    depthCounts[graph.depthCount] = (depthCounts[graph.depthCount] ?? 0) + 1;
  }
  return { valid, invalid, mainPathExtractionPoints: points, firstExtractionDepth: firstDepth, depthCounts };
}

const rows = [];
for (const sp of spValues) {
  for (const build of BUILDS) {
    const fighter = {
      attack: deriveStat(sp, build.attackBp),
      defense: deriveStat(sp, build.defenseBp),
      maxHp: deriveStat(sp, build.healthBp),
    };
    for (const policy of POLICIES) {
      const report = simulateDungeonPlaythroughs(snapshot, catalogue, fighter, { runs, firstSeed, policy });
      rows.push({
        sp,
        build: build.key,
        buildLabel: build.label,
        policy: policy.key,
        policyLabel: policy.label,
        fighter,
        report,
        daily: { runs: daily, banked: report.averageBanked * daily, equipment: report.averageEquipment * daily },
      });
    }
  }
}
const graphs = process.argv.includes('--graphs') || process.argv.includes('--json') ? graphReport() : null;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ zone: zone.key, runs, firstSeed, dailyRuns: daily, graphs, rows }, null, 2));
} else {
  const pct = (n: number | null) => (n == null ? '   —' : `${(n * 100).toFixed(0)}%`.padStart(4));
  const dist = (d: Record<number, number>, total: number) =>
    Object.entries(d)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => `${k}: ${((v / total) * 100).toFixed(0)}%`)
      .join(', ');
  console.log(`${zone.name} (${zone.key}) — ${runs} runs per row from seed ${firstSeed}; daily allowance ${daily} runs`);
  if (graphs) {
    console.log(`  graphs: ${graphs.valid} valid, ${graphs.invalid} invalid`);
    console.log(`  depths per run:                  ${dist(graphs.depthCounts, graphs.valid)}`);
    console.log(`  main-path extraction points/run: ${dist(graphs.mainPathExtractionPoints, graphs.valid)}`);
    console.log(`  depth of the first one:          ${dist(graphs.firstExtractionDepth, graphs.valid)}`);
  }
  console.log(
    '  SP  build        ATK  DEF    HP  policy        done  extr  dead reach  depth  hp@exit  bank/run  gear/run  bank/day  gear/day  gear/run (N/R/SR)  killed by',
  );
  for (const { sp, build, policy, fighter, report: r, daily: d } of rows) {
    const gear = ['N', 'R', 'SR'].map((rarity) => (r.equipmentPerRun[rarity] ?? 0).toFixed(2)).join('/');
    const killer = r.defeatedBy[0] ? `${r.defeatedBy[0].enemyKey} ×${r.defeatedBy[0].runs}` : '';
    console.log(
      [
        String(sp).padStart(4),
        ` ${build.padEnd(11)}`,
        String(fighter.attack).padStart(5),
        String(fighter.defense).padStart(5),
        String(fighter.maxHp).padStart(6),
        ` ${policy.padEnd(13)}`,
        pct(r.completionRate).padStart(5),
        pct(r.extractionRate).padStart(6),
        pct(r.defeatRate).padStart(6),
        pct(r.firstExtractionReachRate).padStart(6),
        r.averageDepth.toFixed(1).padStart(7),
        pct(r.averageHpShareAtExit).padStart(9),
        r.averageBanked.toFixed(1).padStart(10),
        r.averageEquipment.toFixed(2).padStart(10),
        d.banked.toFixed(1).padStart(10),
        d.equipment.toFixed(2).padStart(10),
        `  ${gear}`.padEnd(20),
        ` ${killer}`,
      ].join(''),
    );
  }
}
