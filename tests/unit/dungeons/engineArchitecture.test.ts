/**
 * The engine stays pure.
 *
 * `stepDungeon` is only worth having if the sandbox and live gameplay really
 * do run the same rules, which holds exactly as long as nothing under
 * `engine/` (or the content and validation it reads) can reach a database, a
 * Discord client or a service. This walks the import graph from those folders
 * and fails on the first module that could.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DUNGEON_RUN_EVENT_TYPES, DUNGEON_RUN_STATUSES } from '../../../src/db/schema';
import {
  DUNGEON_RUN_EVENT_TYPES as ENGINE_EVENT_TYPES,
  DUNGEON_RUN_STATUSES as ENGINE_STATUSES,
} from '../../../src/modules/dungeons/engine/types';

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const PURE_ROOTS = ['modules/dungeons/engine', 'modules/dungeons/content', 'modules/dungeons/validation', 'modules/dungeons/package'];

/** What a pure module may never import, directly or through anything it imports. */
/**
 * `src/db/schema.ts` is table *declarations* and shared constant lists: it
 * opens no connection, and older pure modules the engine reuses (the reward
 * roller's content schemas) read constants from it. It is tolerated when
 * reached through those and not walked into — but nothing under the dungeon
 * folders may import it directly, which is what keeps a query out of them.
 */
const SCHEMA = path.join(SRC, 'db', 'schema.ts');

const FORBIDDEN: { test: (specifier: string, resolved: string | null) => boolean; why: string }[] = [
  { test: (s) => s === 'pg' || s.startsWith('drizzle-orm') || s.startsWith('pg-'), why: 'a database driver' },
  { test: (s) => s === 'discord.js' || s.startsWith('@discordjs/'), why: 'the Discord client' },
  { test: (s) => s === 'fastify' || s.startsWith('@fastify/'), why: 'the HTTP server' },
  { test: (_s, r) => r != null && /\/src\/db\/(?!schema\.ts$)/.test(r), why: 'the database layer' },
  { test: (_s, r) => r != null && /\/src\/(discord|api)\//.test(r), why: 'a presentation layer' },
  { test: (_s, r) => r != null && /Service\.ts$/.test(r), why: 'a service' },
  { test: (s) => s === 'node:fs' || s === 'fs' || s === 'node:net' || s === 'node:http' || s === 'node:https', why: 'I/O' },
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Runtime imports only: `import type` and `export type` vanish at compile time. */
function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) continue;
    out.push(match[4]!);
  }
  return out;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

describe('dungeon engine architecture', () => {
  it('reaches no database, Discord, HTTP, service or file I/O through any import', () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    const queue = PURE_ROOTS.flatMap((root) => sourceFiles(path.join(SRC, root)));
    expect(queue.length).toBeGreaterThan(8);
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of runtimeImports(file)) {
        const resolved = resolveLocal(file, specifier);
        const hit = FORBIDDEN.find((rule) => rule.test(specifier, resolved));
        const own = PURE_ROOTS.some((root) => file.startsWith(path.join(SRC, root) + path.sep));
        if (hit) violations.push(`${path.relative(SRC, file)} imports "${specifier}" — ${hit.why}`);
        else if (resolved === SCHEMA) {
          if (own) violations.push(`${path.relative(SRC, file)} imports the database schema directly`);
        } else if (resolved) queue.push(resolved);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the engine’s vocabulary and the database CHECK lists identical', () => {
    expect([...ENGINE_STATUSES]).toEqual([...DUNGEON_RUN_STATUSES]);
    expect([...ENGINE_EVENT_TYPES]).toEqual([...DUNGEON_RUN_EVENT_TYPES]);
  });
});
