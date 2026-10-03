#!/usr/bin/env tsx
/**
 * `npm run dungeons:simulate` — generate many runs of a shipped dungeon zone
 * and print what came out.
 *
 * Reads the content directory only (`dungeons/zones.json`, the combat enemies
 * and the dungeon events), so it needs no database and reports on the zone as
 * Git ships it — not on a zone edited in Portal Admin. For a live zone, use
 * the simulation on the Admin preview page; both call the same generator.
 *
 * Deterministic: seeds are `--seed`, `--seed + 1`, …
 *
 * Usage:
 *   npm run dungeons:simulate
 *   npm run dungeons:simulate -- --zone scrapheap_gauntlet --runs 5000 --seed 1
 *   npm run dungeons:simulate -- --json
 */
import path from 'node:path';
import process from 'node:process';
import { readContentFiles } from '../modules/content/loader';
import { simulateDungeonGeneration } from '../modules/dungeons/dungeonSimulation';
import { dungeonCatalogueFromContent, loadShippedDungeonZones } from '../modules/dungeons/dungeonZoneStore';
import { DUNGEON_NODE_TYPES } from '../modules/dungeons/zoneDefinition';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const contentDir = path.resolve(arg('content') ?? process.env.CONTENT_DIR ?? 'content');
const zones = loadShippedDungeonZones(contentDir);
const zoneKey = arg('zone') ?? zones[0]?.key;
const zone = zones.find((z) => z.key === zoneKey);
if (!zone) {
  console.error(`No shipped dungeon zone "${String(zoneKey)}". Shipped: ${zones.map((z) => z.key).join(', ') || 'none'}`);
  process.exit(1);
}

const report = simulateDungeonGeneration(zone.definition, dungeonCatalogueFromContent(readContentFiles(contentDir)), {
  runs: Number(arg('runs') ?? 1000),
  firstSeed: Number(arg('seed') ?? 1),
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`${zone.definition.name} (${zone.key}) — ${report.runs} runs from seed ${report.firstSeed}`);
  console.log(`  valid ${report.valid}, invalid ${report.invalid} (${pct(report.invalidRate)}), avg attempts ${report.averageAttempts.toFixed(2)}`);
  for (const [reason, count] of Object.entries(report.failures)) console.log(`    failed ×${count}: ${reason}`);
  console.log(`  nodes: avg ${report.averageNodeCount.toFixed(2)} (min ${report.minNodeCount}, max ${report.maxNodeCount}), avg depth ${report.averageDepth.toFixed(2)}`);
  console.log(`  branch rate ${pct(report.branchRate)}, boss ${pct(report.bossRate)}, rest ${pct(report.restRate)}`);
  console.log(`  extraction: ${pct(report.extractionRate)} of runs, avg ${report.averageExtractionPoints.toFixed(2)} points`);
  const spread = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort(([x], [y]) => Number(x) - Number(y))
      .map(([n, runs]) => `${n}: ${pct(runs / (report.valid || 1))}`)
      .join(', ');
  console.log(`  rests per run: ${spread(report.restCountDistribution)}; rest immediately before the boss: ${pct(report.restBeforeBossRate)}`);
  console.log(`  extraction points per run: ${spread(report.extractionCountDistribution)}`);
  console.log('  node types (share of nodes / runs with at least one):');
  for (const type of DUNGEON_NODE_TYPES) {
    console.log(`    ${type.padEnd(9)} ${pct(report.nodeTypeShare[type]).padStart(6)}  ${pct(report.nodeTypeRunRate[type]).padStart(6)}`);
  }
  for (const [label, list] of [['enemies', report.enemies], ['events', report.events]] as const) {
    console.log(`  ${label} (nodes / share of runs):`);
    for (const c of list) console.log(`    ${c.key.padEnd(22)} ${String(c.nodes).padStart(6)}  ${pct(c.runRate).padStart(6)}`);
  }
}
