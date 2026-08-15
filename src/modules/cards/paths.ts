/**
 * Default filesystem roots for the renderer.
 *
 * Resolved from `__dirname` rather than `process.cwd()` (same convention as
 * `src/db/migrate.ts`) so the module works identically under `tsx src/…` and
 * `node dist/…` — both land three levels below the repository root.
 */
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** The SVG kit. */
export const DEFAULT_ASSET_ROOT = path.join(REPO_ROOT, 'assets', 'cardart');

/** Generated, gitignored, safe to delete at any time. */
export const DEFAULT_CACHE_ROOT = path.join(REPO_ROOT, 'assets', '.card-cache');
