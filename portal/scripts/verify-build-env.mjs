#!/usr/bin/env node
/**
 * Production-build input guard — runs *before* Vite, not after.
 *
 * `verify-bundle.mjs` inspects the finished bundle for known dev-only code
 * markers. It cannot catch a leaked credential, and a production audit proved
 * it does not: a bundle built with `VITE_PLATFORM_API_TOKEN` set passed it
 * clean, because the check has no way to recognise a secret it has never seen.
 * Pattern-matching the output for things that "look like" a token would be
 * guesswork with both false positives and false negatives.
 *
 * So this guards the *input* instead, which is a closed set and therefore
 * decidable. Two structural rules, no heuristics:
 *
 *   1. None of the env files Vite auto-loads may exist. Vite reads `.env`,
 *      `.env.local`, `.env.<mode>` and `.env.<mode>.local` from the project
 *      root by itself and merges them into `import.meta.env`, underneath any
 *      allowlist a Dockerfile or CI job thinks it is enforcing.
 *   2. No forbidden variable may be set in the process environment — the other
 *      way in, via `--build-arg`, `ENV`, or an exported shell variable.
 *
 * Together those are every route by which a value reaches a production bundle.
 *
 * **This never prints a value.** A failure names the file or the variable and
 * stops; printing the offending value to a build log would turn a prevented
 * leak into an actual one.
 *
 * Scope: the production build path only (`npm run build`). `npm run dev` is
 * untouched — `VITE_PLATFORM_API_TOKEN` in `portal/.env` remains the supported
 * way to drive the dev server, which is the one place it is safe, because the
 * dev server injects it from Node and never compiles it into a shipped
 * artifact. `npm run build:e2e` is also untouched: it runs `--mode e2e` against
 * a committed fixture holding a deliberately fake token, and produces a local
 * artifact that is never deployed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const portalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every env file Vite loads on its own during a default-mode (production)
 * build, plus the development-mode pair. The development files cannot be read
 * by `vite build` today, and are listed anyway: the cost of covering them is
 * one array entry, and the cost of missing them is a silent leak on the day
 * someone adds a `--mode` flag to the build script.
 *
 * `.env.example` is deliberately absent — Vite never loads it, it holds
 * placeholders by definition, and it is the file the documentation points at.
 */
const FORBIDDEN_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
  '.env.development',
  '.env.development.local',
];

/**
 * Variables that must not reach a production bundle at any strength.
 *
 * `VITE_PLATFORM_API_TOKEN` is the shared Platform API bearer credential. It is
 * one master token with no per-player scoping, so a copy in a public bundle is
 * read access to every player's data for anyone who opens devtools. The Portal
 * attaches it unconditionally when it is present (`src/api/client.ts`), which
 * is correct for the dev server and catastrophic in a shipped build.
 */
const FORBIDDEN_ENV_VARS = ['VITE_PLATFORM_API_TOKEN'];

const failures = [];

for (const name of FORBIDDEN_ENV_FILES) {
  if (existsSync(path.join(portalDir, name))) {
    failures.push(
      `  portal/${name} exists. Vite would load it into this build automatically.`,
    );
  }
}

for (const name of FORBIDDEN_ENV_VARS) {
  // Presence alone is the failure. The value is never read, compared or shown.
  if (process.env[name] !== undefined && process.env[name] !== '') {
    failures.push(`  ${name} is set in the environment of this build.`);
  }
}

if (failures.length > 0) {
  console.error('\nverify-build-env: refusing to run a production build.\n');
  console.error(failures.join('\n'));
  console.error(
    [
      '',
      'A production bundle is public. Anything Vite can read at build time is',
      'compiled into JavaScript that every visitor can read back.',
      '',
      'To build for production: remove or move the file(s) above, and unset the',
      'variable(s) above. The supported way to configure a production build is',
      'the explicit ARG list in portal/Dockerfile.',
      '',
      'To keep working locally: `npm run dev` is unaffected and still reads',
      'portal/.env, including VITE_PLATFORM_API_TOKEN.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `verify-build-env: OK — ${FORBIDDEN_ENV_FILES.length} env files absent, ` +
    `${FORBIDDEN_ENV_VARS.length} forbidden variable unset.`,
);
