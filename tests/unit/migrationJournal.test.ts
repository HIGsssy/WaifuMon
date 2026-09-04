/**
 * The Drizzle migration journal is the startup migrator's index.
 *
 * `drizzle-orm/node-postgres/migrator` reads `drizzle/meta/_journal.json`,
 * loads `<tag>.sql` for each entry **in journal order**, and splits each file
 * on `--> statement-breakpoint`. Nothing validates that index for you: a
 * hand-written migration whose journal entry is missing is silently never
 * applied, and one whose tag does not match its filename fails at boot on the
 * production node rather than here.
 *
 * The repo has hand-written migrations by convention since 0005, so those two
 * mistakes are exactly the ones that are easy to make. These checks are cheap
 * and need no database — the tests that need one live in
 * `tests/integration/*Migration.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DRIZZLE_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const journal = JSON.parse(
  fs.readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
) as { entries: JournalEntry[] };

const sqlFiles = fs
  .readdirSync(DRIZZLE_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('drizzle migration journal', () => {
  it('names a file that exists for every entry', () => {
    const missing = journal.entries
      .map((e) => `${e.tag}.sql`)
      .filter((f) => !fs.existsSync(path.join(DRIZZLE_DIR, f)));
    expect(missing).toEqual([]);
  });

  it('has an entry for every committed .sql file', () => {
    // The failure this catches: a migration added to the folder but never
    // registered, which never runs and is only noticed as a missing column.
    const tagged = new Set(journal.entries.map((e) => `${e.tag}.sql`));
    expect(sqlFiles.filter((f) => !tagged.has(f))).toEqual([]);
  });

  it('is strictly ordered by idx, with no gaps or duplicates', () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(
      journal.entries.map((_, i) => i),
    );
  });

  it('advances `when` monotonically so file order matches apply order', () => {
    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it('agrees with the numeric prefix each filename carries', () => {
    for (const entry of journal.entries) {
      expect(entry.tag.slice(0, 4)).toBe(String(entry.idx).padStart(4, '0'));
    }
  });
});

describe('Phase 2 migrations', () => {
  const read = (tag: string) =>
    fs.readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');

  it('0025 adds the continuation pointer and both vendor tables', () => {
    const sql = read('0025_encounter_continuation_and_vendor');
    expect(sql).toContain('ALTER TABLE "active_world_encounters" ADD COLUMN "continuation_of_id"');
    expect(sql).toContain('CREATE TABLE "world_encounter_vendors"');
    expect(sql).toContain('CREATE TABLE "world_encounter_vendor_instances"');
    expect(sql).toContain('world_encounter_vendor_instances_active_encounter_uq');
  });

  it('0026 adds the spawn origin columns and their partial unique index', () => {
    const sql = read('0026_wild_encounter_origin');
    expect(sql).toContain('ALTER TABLE "encounters" ADD COLUMN "origin_kind"');
    expect(sql).toContain('ALTER TABLE "encounters" ADD COLUMN "origin_ref"');
    // Partial, so hunted rows (both columns null) never enter the index and
    // an ordinary hunt keeps its current insert cost.
    expect(sql).toContain('CREATE UNIQUE INDEX "encounters_origin_uq"');
    expect(sql).toMatch(/WHERE\s+origin_kind is not null and origin_ref is not null/);
  });

  it('breaks 0025 and 0026 into statements the migrator can split', () => {
    for (const tag of ['0025_encounter_continuation_and_vendor', '0026_wild_encounter_origin']) {
      const statements = read(tag)
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(statements.length).toBeGreaterThan(1);
      // A fragment that is only a comment would be sent to Postgres as an
      // empty statement.
      for (const statement of statements) {
        expect(statement.replace(/^--.*$/gm, '').trim().length).toBeGreaterThan(0);
      }
    }
  });
});
