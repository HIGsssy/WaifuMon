/**
 * Architectural boundaries, asserted mechanically.
 *
 * These are the success criteria from plan §24 that are easy to state and easy
 * to violate by accident:
 *
 *   §24.4   nothing under `portal/` imports the bot's source
 *   §24.13  no feature renders a raw `<img src>` — artwork goes through the
 *           image resolver so the asset source stays swappable (§12)
 *   §24.6   no helper issues a write; the client refuses one at runtime, and
 *           this catches an `apiClient.post(...)` at author time
 *
 * A lint rule covers the first two as well, but lint is opt-in and this is not:
 * `npm test` fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) found.push(full);
  }
  return found;
}

/**
 * Application sources only. Test files are excluded: they legitimately name
 * the very patterns being banned (this file spells out `apiClient.post` in a
 * regex), and asserting against them would be self-defeating.
 */
const files = sourceFiles(srcDir)
  .map((file) => ({
    path: path.relative(srcDir, file).replace(/\\/g, '/'),
    contents: readFileSync(file, 'utf8'),
  }))
  .filter((file) => !file.path.includes('__tests__/') && !file.path.startsWith('test/'));

describe('architectural boundaries', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never imports the bot repo — the Portal is a pure Platform API consumer', () => {
    // Anything climbing out of `portal/` and into the sibling `src/` tree.
    const escaping = /from\s+['"](?:\.\.\/)+src\//;
    const offenders = files.filter((file) => escaping.test(file.contents));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('never renders a raw <img> in feature code — artwork goes through <Artwork>', () => {
    const offenders = files
      .filter((file) => file.path.startsWith('features/'))
      .filter((file) => /<img[\s>]/.test(file.contents));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('never issues a write against the Platform API', () => {
    const writeCall = /apiClient\.(post|put|patch|delete)\s*[(<]/;
    const offenders = files
      // The client itself names the methods it refuses.
      .filter((file) => file.path !== 'api/client.ts')
      .filter((file) => writeCall.test(file.contents));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('reaches the Platform API only through the api/ module', () => {
    // `api/system.ts` is the one deliberate exception: /ready and /health live
    // at the API server's root, outside the client's `/api` base URL.
    const rawAxios = /from\s+['"]axios['"]/;
    const allowed = new Set(['api/client.ts', 'api/system.ts']);
    const offenders = files.filter(
      (file) => rawAxios.test(file.contents) && !allowed.has(file.path),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
