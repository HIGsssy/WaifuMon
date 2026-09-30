/**
 * The equipment and feature-unlock single-writer rules, enforced mechanically.
 *
 * "Every grant, equip and removal goes through one service" is the invariant
 * the design rests on — it is what stops a reward path from auto-equipping,
 * and what keeps ownership checks in one place. Comments do not enforce
 * invariants, so this reads every production source file and fails if any
 * file other than a table's designated writer writes it (the
 * `appearanceBoundary` model).
 *
 * Writers, per table:
 *
 *   player_equipment, player_loadouts,
 *   player_loadout_slots, equipment_events  → equipmentService.ts only
 *   equipment_definitions                   → the catalogue writers: the
 *                                             definition service, package
 *                                             import and the startup seed
 *   equipment_import_log                    → equipmentImportService.ts only
 *   player_feature_unlocks                  → featureUnlockService.ts only
 *
 * The detector recognises every way this codebase writes a table — drizzle
 * builders (bare, `schema.`-qualified or via an aliased import), `sql`
 * templates interpolating the table, and raw SQL text (schema-qualified or
 * not) — and ignores comments. `the detector` below pins each form, so a
 * pattern that silently stops matching fails here rather than passing
 * vacuously.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..', 'src');

interface TableRule {
  /** Drizzle export name in `db/schema.ts`. */
  ident: string;
  /** SQL table name. */
  table: string;
  /** Source files (relative to `src/`, forward slashes) allowed to write it. */
  writers: readonly string[];
}

const EQUIPMENT_SERVICE = 'modules/equipment/equipmentService.ts';
const CATALOGUE_WRITERS = [
  'modules/equipment/equipmentDefinitionService.ts',
  'modules/equipment/equipmentImportService.ts',
  'modules/equipment/seed.ts',
];

const RULES: readonly TableRule[] = [
  { ident: 'playerEquipment', table: 'player_equipment', writers: [EQUIPMENT_SERVICE] },
  { ident: 'playerLoadouts', table: 'player_loadouts', writers: [EQUIPMENT_SERVICE] },
  { ident: 'playerLoadoutSlots', table: 'player_loadout_slots', writers: [EQUIPMENT_SERVICE] },
  { ident: 'equipmentEvents', table: 'equipment_events', writers: [EQUIPMENT_SERVICE] },
  { ident: 'equipmentDefinitions', table: 'equipment_definitions', writers: CATALOGUE_WRITERS },
  { ident: 'equipmentImportLog', table: 'equipment_import_log', writers: ['modules/equipment/equipmentImportService.ts'] },
  { ident: 'playerFeatureUnlocks', table: 'player_feature_unlocks', writers: ['modules/features/featureUnlockService.ts'] },
];

/** Files that must write nothing at all. */
const READ_ONLY = ['modules/equipment/combatStatsService.ts', 'modules/equipment/equipmentQueries.ts'];

/**
 * Remove comments so prose ("never update player_equipment directly") cannot
 * trip the detector. Deliberately simple: a `//` inside a string literal (a
 * URL) truncates that one line, which can only hide text, never invent a write.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `source` write the table described by `rule`? */
export function writesTable(rawSource: string, rule: Pick<TableRule, 'ident' | 'table'>): boolean {
  const source = stripComments(rawSource);
  // Aliased imports: `import { playerEquipment as pe }`.
  const aliases = [...source.matchAll(new RegExp(`\\b${rule.ident}\\s+as\\s+(\\w+)`, 'g'))].map((m) => m[1]!);
  const names = [rule.ident, ...aliases].map(escape).join('|');
  const verbs = String.raw`insert\s+into|update|delete\s+from`;

  // Drizzle builders: `.insert(playerEquipment)`, `.update(schema.playerEquipment)`.
  const builder = new RegExp(String.raw`\.(?:insert|update|delete)\(\s*(?:\w+\.)?(?:${names})\b`);
  // `sql` templates: sql`insert into ${playerEquipment} …`.
  const template = new RegExp(String.raw`(?:${verbs})\s+\$\{\s*(?:\w+\.)?(?:${names})\s*\}`, 'i');
  // Raw SQL text, optionally schema-qualified and/or quoted.
  const raw = new RegExp(String.raw`(?:${verbs})\s+(?:"?\w+"?\.)?"?${escape(rule.table)}"?(?![\w])`, 'i');

  return builder.test(source) || template.test(source) || raw.test(source);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const FILES = sourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  source: fs.readFileSync(file, 'utf8'),
}));

describe('equipment and feature-unlock write boundaries', () => {
  it.each(RULES.map((r) => [r.table, r] as const))('%s is written only by its designated writers', (_table, rule) => {
    const writers = FILES.filter((f) => writesTable(f.source, rule)).map((f) => f.rel);
    expect(writers.filter((rel) => !rule.writers.includes(rel))).toEqual([]);
    // Guard the guard: each designated writer really is detected, so a rule
    // cannot pass because the detector stopped matching anything.
    expect(writers.sort()).toEqual([...rule.writers].sort());
  });

  it('the combat-stat service and the read-only query module write nothing', () => {
    for (const rel of READ_ONLY) {
      const { source } = FILES.find((f) => f.rel === rel)!;
      expect(stripComments(source), rel).not.toMatch(/\.(insert|update|delete)\(|insert\s+into|delete\s+from/i);
    }
  });

  it('the grant path never touches a loadout', () => {
    const { source } = FILES.find((f) => f.rel === EQUIPMENT_SERVICE)!;
    const start = source.indexOf('async grantEquipment(');
    const end = source.indexOf('async listEquipment(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/playerLoadout/);
    expect(body).not.toMatch(/ensureActiveLoadout|lockActiveLoadout/);
  });
});

describe('the detector', () => {
  const rule = { ident: 'playerEquipment', table: 'player_equipment' };

  it.each([
    ['a drizzle insert', 'await tx.insert(playerEquipment).values(v);'],
    ['a drizzle update across a line break', 'await tx\n  .update(\n    playerEquipment,\n  )'],
    ['a drizzle delete', 'db.delete(playerEquipment).where(x)'],
    ['a schema-qualified builder', 'db.insert(schema.playerEquipment).values(v)'],
    ['an aliased import', "import { playerEquipment as pe } from './schema';\ndb.update(pe).set(v)"],
    ['a sql template', 'await tx.execute(sql`insert into ${playerEquipment} (id) values (1)`);'],
    ['raw SQL', "pool.query('delete from player_equipment where id = $1')"],
    ['quoted, schema-qualified raw SQL', 'pool.query(`update "public"."player_equipment" set x = 1`)'],
  ])('catches %s', (_label, snippet) => {
    expect(writesTable(snippet, rule)).toBe(true);
  });

  it.each([
    ['a read', 'db.select().from(playerEquipment)'],
    ['a line comment', '// never update player_equipment directly'],
    ['a block comment', '/* insert into player_equipment happens elsewhere */'],
    ['a longer table name', "pool.query('insert into player_equipment_archive values (1)')"],
    ['a different drizzle table', 'db.insert(playerEquipmentArchive).values(v)'],
  ])('ignores %s', (_label, snippet) => {
    expect(writesTable(snippet, rule)).toBe(false);
  });
});
