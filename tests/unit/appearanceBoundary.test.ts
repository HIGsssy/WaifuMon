/**
 * The cosmetic firewall, enforced mechanically.
 *
 * "Appearance is cosmetic" is the design invariant the whole system rests on,
 * and comments do not enforce invariants. This reads the appearance module's
 * own source and fails if it ever imports a gameplay service or writes a
 * gameplay column.
 *
 * A lint plugin (`eslint-plugin-boundaries`) would be the heavier equivalent;
 * this is the same guarantee with no new dependency, and it lives beside the
 * behavioural tests that explain *why* the boundary exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE_DIR = path.resolve(__dirname, '..', '..', 'src', 'modules', 'appearance');

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(MODULE_DIR, file), 'utf8');
}

function importedPaths(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Services that own gameplay state. An appearance may *read* a level to decide
 * a gate; it may never reach a module that grants XP, resolves a capture,
 * moves affection, or advances Care Mode.
 */
const FORBIDDEN_MODULES = [
  'progression',
  'capture',
  'care',
  'collection',
  'hunt',
  'quests',
  'daily',
  'shop',
  'currency',
  'inventory',
  'items',
  'effects',
];

/**
 * Every file the module is allowed to contain.
 *
 * The enumeration is the anti-sprawl half of the firewall, and it is also what
 * keeps the per-file checks below honest: a new file cannot arrive without
 * being added here, and adding it here immediately subjects it to the same
 * gameplay-import ban. `assetResolver.ts` joined in Phase 2.5 when generic
 * artwork lookup moved out of the Discord layer so the card renderer could
 * share it — cosmetic work, held to the same rules as the rest.
 */
const MODULE_FILES = [
  'appearanceContent.ts',
  'appearanceRules.ts',
  'appearanceService.ts',
  'assetResolver.ts',
];

describe('appearance module boundaries', () => {
  const files = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith('.ts'));

  it('contains exactly the modules the design calls for and no more', () => {
    expect(files.sort()).toEqual([...MODULE_FILES].sort());
  });

  it.each(MODULE_FILES)(
    '%s imports no gameplay service',
    (file) => {
      const imports = importedPaths(sourceOf(file));
      for (const specifier of imports) {
        for (const forbidden of FORBIDDEN_MODULES) {
          expect(
            specifier.includes(`modules/${forbidden}/`),
            `${file} imports ${specifier} — appearance must stay cosmetic`,
          ).toBe(false);
        }
      }
    },
  );

  it('keeps the rules and content modules free of database access entirely', () => {
    // These two are the pure core: total, deterministic, callable from the API,
    // Discord, a Portal mock, and a unit test without a database in sight.
    for (const file of ['appearanceContent.ts', 'appearanceRules.ts']) {
      const source = sourceOf(file);
      expect(source, `${file} must not import drizzle`).not.toMatch(/from 'drizzle-orm'/);
      expect(source, `${file} must not import the db client`).not.toMatch(/db\/client/);
    }
  });

  it('keeps the shared asset resolver free of the database', () => {
    // It reads the filesystem, so it is not part of the pure core above — but
    // resolving artwork must never become a query. The card renderer depends
    // on being able to call it without a database in the process.
    const source = sourceOf('assetResolver.ts');
    expect(source).not.toMatch(/from 'drizzle-orm'/);
    expect(source).not.toMatch(/db\/client/);
  });

  it('writes only the two cosmetic columns', () => {
    const source = sourceOf('appearanceService.ts');
    // Every `.set({ … })` in the service must confine itself to `variant` and
    // `seenAppearances`. A future edit that adds `level:` or `xp:` here fails.
    const setClauses = [...source.matchAll(/\.set\(\{([^}]*)\}\)/gs)].map((m) => m[1]!);
    expect(setClauses.length).toBeGreaterThan(0);
    for (const clause of setClauses) {
      const fields = [...clause.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!);
      expect(fields.every((f) => f === 'variant' || f === 'seenAppearances'), clause).toBe(true);
    }
  });

  it('touches only the tables the design permits', () => {
    const source = sourceOf('appearanceService.ts');
    const tables = [...source.matchAll(/\.(?:from|update|insert)\((\w+)/g)].map((m) => m[1]!);
    const allowed = new Set(['playerWaifus', 'speciesTable', 'playerProgressionEvents']);
    for (const table of tables) {
      expect(allowed.has(table), `unexpected table access: ${table}`).toBe(true);
    }
  });
});
