/**
 * Dependency boundaries for the combat module, enforced mechanically.
 *
 *   - The generic engine (types, math, state, engine, controller, simulator)
 *     imports only itself and the pure `shared/random` / `shared/errors`.
 *   - Nothing under `modules/combat/` imports Discord, the database or
 *     Equipment — stats arrive as numbers from the caller.
 *   - Combat code never calls `Math.random()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMBAT = path.resolve(__dirname, '..', '..', '..', 'src', 'modules', 'combat');
const ENGINE = ['combatTypes.ts', 'combatMath.ts', 'combatState.ts', 'combatEngine.ts', 'combatController.ts', 'combatSimulator.ts'];
const ENGINE_ALLOWED_EXTERNAL = new Set(['../../shared/random', '../../shared/errors']);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function importsOf(file: string): string[] {
  const src = stripComments(fs.readFileSync(path.join(COMBAT, file), 'utf8'));
  return [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

const allFiles = fs.readdirSync(COMBAT).filter((f) => f.endsWith('.ts'));

describe('combat module boundaries', () => {
  it('lists every engine file (guards against a rename silently skipping checks)', () => {
    for (const f of ENGINE) expect(allFiles).toContain(f);
  });

  it.each(ENGINE)('%s imports only the engine and pure shared helpers', (file) => {
    const external = importsOf(file).filter((i) => !i.startsWith('./') && !ENGINE_ALLOWED_EXTERNAL.has(i));
    expect(external).toEqual([]);
    const local = importsOf(file).filter((i) => i.startsWith('./')).map((i) => `${i.slice(2)}.ts`);
    expect(local.filter((f) => !ENGINE.includes(f))).toEqual([]);
  });

  it.each(allFiles)('%s does not import Discord, the database or Equipment', (file) => {
    const bad = importsOf(file).filter((i) => /discord|\/db\/|drizzle|equipment/i.test(i));
    expect(bad).toEqual([]);
  });

  it.each(allFiles)('%s never calls Math.random', (file) => {
    expect(stripComments(fs.readFileSync(path.join(COMBAT, file), 'utf8'))).not.toMatch(/Math\.random/);
  });
});
