#!/usr/bin/env node
/**
 * Production-bundle guarantees (plan §23, success criterion §24.16).
 *
 * Run after `npm run build`. It asserts that the developer diagnostics page and
 * its telemetry ring buffer are *absent* from the shipped bundle — not merely
 * unlinked. Both are guarded by `import.meta.env.DEV` in `router.tsx` and
 * `telemetry.ts`; this is what catches the day someone imports the diagnostics
 * module from a production code path and quietly re-includes the whole subtree.
 *
 * Exits non-zero with the offending file and marker so CI failure is readable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Strings that only exist inside the dev-only subtree. */
const FORBIDDEN_MARKERS = [
  'Developer diagnostics',
  '__dev/diagnostics',
  'Recent API activity',
  'Silhouette fallbacks',
  'subscribeToRequestLog',
  // The developer login screen and its player switcher. Guarded by
  // `import.meta.env.DEV` in `DevSessionProvider.tsx`, `SelectPlayerPage.tsx`,
  // `Header.tsx` and `SettingsPage.tsx` — a production build authenticates from
  // `VITE_DEFAULT_PLAYER_ID` and has no way to change players at runtime.
  'Developer login',
  'Switch player',
  'waifumon-portal:dev-identity',
  'DevPlayerNotFoundError',
  'useDevAuth',
  // Development instrumentation: the image-transfer observer, the slow-request
  // timer, and the duplicate-request detector. All three are diagnostics for a
  // dev server that serves artwork and proxies the API on one origin; none of
  // them has a job in a shipped bundle.
  'portal image',
  'portal slow',
  'portal duplicate',
  'installImageInstrumentation',
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

let distFiles;
try {
  distFiles = walk(distDir);
} catch {
  console.error(`verify-bundle: no build found at ${distDir}. Run "npm run build" first.`);
  process.exit(1);
}

const textFiles = distFiles.filter((file) => /\.(js|css|html)$/.test(file));
const violations = [];

for (const file of textFiles) {
  const contents = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN_MARKERS) {
    if (contents.includes(marker)) {
      violations.push({ file: path.relative(distDir, file), marker });
    }
  }
}

if (violations.length > 0) {
  console.error('verify-bundle: dev-only code leaked into the production bundle.\n');
  for (const { file, marker } of violations) {
    console.error(`  ${file}  contains  "${marker}"`);
  }
  console.error(
    '\nThe diagnostics feature and the telemetry ring buffer must stay behind ' +
      'import.meta.env.DEV guards (plan §23).',
  );
  process.exit(1);
}

console.log(
  `verify-bundle: OK — ${textFiles.length} bundle files checked, no dev-only code present.`,
);
