/**
 * Play a dungeon package through the sandbox and print what happened.
 *
 *   npm run dungeons:sandbox -- content/dungeons/examples/service_tunnels.dungeon.json
 *   npm run dungeons:sandbox -- <package.json> --seed 7 --attack 300 --defense 150 --hp 4000 --runs 50
 *
 * The package is verified first (`readDungeonPackage`), then played by the
 * same engine live gameplay uses, always taking the first thing on offer.
 * Enemies come from the package's own bundle, so no database and no content
 * directory are needed, and nothing is written anywhere. Reward tables are not
 * resolved here: only currency ranges pay.
 */
import fs from 'node:fs';
import { autoPlayDungeonSandbox, createDungeonSandbox } from '../modules/dungeons/engine/sandbox';
import { readDungeonPackage } from '../modules/dungeons/package/dungeonPackage';

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: dungeons:sandbox <package.dungeon.json> [--seed n] [--runs n] [--attack n] [--defense n] [--hp n]');
    return 2;
  }
  const read = readDungeonPackage(fs.readFileSync(file, 'utf8'));
  for (const issue of read.issues) console.error(`${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.message}`);
  if (!read.ok || !read.package) return 1;
  const pkg = read.package;

  const dependencies = { enemies: Object.fromEntries(pkg.bundled.enemies.map((e) => [e.key, e])), rewardTables: {} };
  const missing = pkg.dependencies.enemies.filter((e) => !(e.key in dependencies.enemies)).map((e) => e.key);
  if (missing.length > 0) {
    console.error(`the package does not bundle these enemies, so the sandbox cannot fight them: ${missing.join(', ')}`);
    return 1;
  }
  const fighter = { waifuId: 0, name: 'Sandbox Buddy', attack: option('attack', 300), defense: option('defense', 150), maxHp: option('hp', 4000) };
  const firstSeed = option('seed', 1);
  const runs = Math.max(1, Math.floor(option('runs', 1)));

  console.log(`${pkg.dungeon.name} (${pkg.dungeon.key}) — ${pkg.dungeon.rooms.length} rooms, ${pkg.contentHash}`);
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const seed = firstSeed + i;
    const sandbox = createDungeonSandbox({ definition: pkg.dungeon, dependencies, fighter, seed });
    const result = await autoPlayDungeonSandbox(sandbox);
    const key = result.stoppedBy === 'ended' ? sandbox.state.status : result.stoppedBy;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (runs > 1) continue;
    for (const entry of sandbox.log) {
      const { events: _events, ...payload } = entry.payload as { events?: unknown };
      console.log(`  ${entry.type.padEnd(22)} ${[entry.roomId, entry.actionId].filter(Boolean).join('/').padEnd(28)} ${JSON.stringify(payload)}`);
    }
    console.log(`seed ${seed}: ${key} after ${result.steps} steps, HP ${sandbox.state.hp}/${fighter.maxHp}, flags ${JSON.stringify(sandbox.state.flags)}`);
    console.log(`effects recorded (none applied): ${JSON.stringify(sandbox.effects)}`);
  }
  if (runs > 1) console.log(`${runs} runs from seed ${firstSeed}: ${JSON.stringify(outcomes)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
