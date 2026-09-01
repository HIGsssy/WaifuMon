/**
 * The production-build input guard, exercised as a subprocess.
 *
 * `verify-build-env.mjs` is the only thing standing between a developer's
 * `portal/.env` and a Platform API credential compiled into a public bundle,
 * so it is tested by actually running it against a scratch directory rather
 * than by importing its constants and trusting them.
 *
 * A scratch copy, never the real `portal/` — a test that creates `.env` files
 * in the working tree would race the developer's own and could delete one.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'verify-build-env.mjs');

let dir: string;
let scriptCopy: string;

beforeEach(() => {
  // The script resolves the portal root as its own parent directory, so the
  // copy lives in <scratch>/scripts/ and treats <scratch>/ as the project.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-build-env-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  scriptCopy = path.join(dir, 'scripts', 'verify-build-env.mjs');
  fs.copyFileSync(SCRIPT, scriptCopy);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the guard, returning its exit code and combined output.
 *
 * Async rather than `execFileSync`: Vitest runs test files in parallel
 * workers, and a synchronous spawn blocks its worker's event loop for the
 * whole child process. A dozen of those was enough to push the heavier jsdom
 * rendering suites past their timeouts — the guard is cheap, but it was
 * stealing the scheduler from everything running beside it.
 */
function run(env: NodeJS.ProcessEnv = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptCopy],
      {
        encoding: 'utf8',
        // A clean base: the ambient environment may legitimately carry the
        // token on a developer machine, which would make "passes when clean"
        // flaky in exactly the case the guard exists to catch.
        env: { PATH: process.env.PATH ?? '', ...env },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, output: `${stdout}${stderr}` });
      },
    );
  });
}

describe('a clean build directory', () => {
  it('passes, and passes with .env.example present', async () => {
    // Two assertions, one subprocess each, deliberately kept in a single test:
    // this file runs beside the jsdom component suites, and every extra spawn
    // is scheduler time taken from them. `.env.example` is the false-positive
    // case that matters — Vite never loads it, and it is the file the
    // documentation tells people to copy.
    const clean = await run();
    expect(clean.code).toBe(0);
    expect(clean.output).toContain('verify-build-env: OK');

    fs.writeFileSync(path.join(dir, '.env.example'), 'VITE_PLATFORM_API_TOKEN=\n');
    expect((await run()).code).toBe(0);
  });
});

describe('env files Vite auto-loads', () => {
  const FORBIDDEN = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
    '.env.development',
    '.env.development.local',
  ];

  it('refuses to build, naming every offending file', async () => {
    // All six in one run rather than six runs: the guard reports the complete
    // set, so one subprocess proves the whole list is covered. A partial
    // implementation that stopped at the first match fails this.
    const secret = 'SENTINEL-FILE-BODY-MUST-NOT-APPEAR';
    for (const name of FORBIDDEN) {
      fs.writeFileSync(path.join(dir, name), `VITE_PLATFORM_API_TOKEN=${secret}\n`);
    }
    const { code, output } = await run();
    expect(code).toBe(1);
    for (const name of FORBIDDEN) expect(output).toContain(name);
    // A guard that echoes a file's contents into a build log turns a prevented
    // leak into a real one — build logs are archived and widely readable.
    expect(output).not.toContain(secret);
  });

  it('refuses on a single stray file, not only on the full set', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'VITE_PLATFORM_API_TOKEN=sentinel\n');
    const { code, output } = await run();
    expect(code).toBe(1);
    expect(output).toContain('.env');
  });
});

describe('the process-environment vector', () => {
  it('refuses when VITE_PLATFORM_API_TOKEN is set, without printing it', async () => {
    // The route `rm -f` cannot close: --build-arg, ENV, or an exported shell
    // variable reaches Vite with no file on disk at all.
    const secret = 'SENTINEL-MUST-NOT-APPEAR-IN-OUTPUT';
    const { code, output } = await run({ VITE_PLATFORM_API_TOKEN: secret });
    expect(code).toBe(1);
    expect(output).toContain('VITE_PLATFORM_API_TOKEN');
    expect(output).not.toContain(secret);
  });

  it('treats an empty value as unset', async () => {
    expect((await run({ VITE_PLATFORM_API_TOKEN: '' })).code).toBe(0);
  });
});
