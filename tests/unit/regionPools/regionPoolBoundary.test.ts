/**
 * Region Pools and Dungeon WaifuMon Pools stay independent systems.
 *
 * Region Pools decide who a regional hunt can meet; dungeon species pools and
 * `dungeonSpeciesPolicy` decide who a dungeon can offer. Neither may read the
 * other's persistence or rules, so editing one can never grant or remove
 * access in the other. The hunt and the species selectors read only the
 * projection table, never the Region Pool module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? filesUnder(full) : d.name.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function offenders(files: string[], forbidden: RegExp): string[] {
  return files.flatMap((f) =>
    importsOf(f)
      .filter((s) => forbidden.test(s))
      .map((s) => `${path.relative(SRC, f)} imports ${s}`),
  );
}

describe('Region Pool boundaries', () => {
  it('dungeon code never imports the Region Pool module', () => {
    expect(offenders(filesUnder(path.join(SRC, 'modules', 'dungeons')), /regionPools\//)).toEqual([]);
  });

  it('the Region Pool module never imports dungeon code', () => {
    expect(offenders(filesUnder(path.join(SRC, 'modules', 'regionPools')), /\/dungeons\//)).toEqual([]);
  });

  it('the hunt and species selectors read the projection, not the Region Pool module', () => {
    const runtime = [
      path.join(SRC, 'modules', 'hunt', 'huntService.ts'),
      path.join(SRC, 'modules', 'encounters', 'speciesSelection.ts'),
    ];
    expect(offenders(runtime, /regionPools\//)).toEqual([]);
  });
});
