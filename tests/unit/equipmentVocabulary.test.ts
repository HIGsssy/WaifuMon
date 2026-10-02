/**
 * `0045_equipment_foundation.sql` is hand-written, so its CHECK lists are
 * literals that cannot import the TypeScript vocabulary they mirror. This is
 * the drift guard: widen a list in `vocabulary.ts` without a migration (or the
 * reverse) and this fails, instead of production refusing a row the code
 * believes is legal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_EVENT_KIND_SQL_LIST,
  EQUIPMENT_KEY_PATTERN,
  EQUIPMENT_MULTIPLIER_BP_MAX,
  EQUIPMENT_MULTIPLIER_CAP_SQL,
  EQUIPMENT_SLOT_SQL_LIST,
  EQUIPMENT_SOURCE_TYPE_SQL_LIST,
  WORKSHOP_OPERATION_KIND_SQL_LIST,
  WORKSHOP_SLOT_CHOICE_SQL_LIST,
} from '../../src/modules/equipment/vocabulary';
import {
  FEATURE_KEY_SQL_LIST,
  FEATURE_UNLOCK_SOURCE_SQL_LIST,
} from '../../src/modules/features/vocabulary';
import { RARITIES } from '../../src/db/schema';
import { REGION_SQL_LIST } from '../../src/modules/locations/regions';

const DRIZZLE = path.resolve(__dirname, '..', '..', 'drizzle');
const SQL = fs.readFileSync(path.join(DRIZZLE, '0045_equipment_foundation.sql'), 'utf8');

/**
 * Every migration from 0045 on, in order. A later migration may widen a list
 * (0049 adds source `fabrication` and event kind `dismantled`) by dropping
 * and re-adding the constraint, so what the database enforces is the
 * **last** definition of each.
 */
const LATER_MIGRATIONS = fs
  .readdirSync(DRIZZLE)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f >= '0045')
  .sort()
  .map((f) => ({ file: f, sql: fs.readFileSync(path.join(DRIZZLE, f), 'utf8') }));

/** The `in (...)` list of the named CHECK constraint, as last defined. */
function checkList(constraint: string): string {
  let found: string | null = null;
  for (const { sql } of LATER_MIGRATIONS) {
    for (const line of sql.split('\n')) {
      if (!line.includes(`"${constraint}"`) || !/CHECK/.test(line)) continue;
      const match = /\bin \(([^)]*)\)/.exec(line);
      if (match) found = match[1]!;
    }
  }
  if (found == null) throw new Error(`constraint ${constraint} has no IN list in 0045 or later`);
  return found;
}

describe('0045 CHECK lists (as later widened) mirror the vocabulary', () => {
  it.each([
    ['equipment_definitions_slot_check', EQUIPMENT_SLOT_SQL_LIST],
    ['player_equipment_slot_check', EQUIPMENT_SLOT_SQL_LIST],
    ['player_loadout_slots_slot_check', EQUIPMENT_SLOT_SQL_LIST],
    ['equipment_events_slot_check', EQUIPMENT_SLOT_SQL_LIST],
    ['player_equipment_source_type_check', EQUIPMENT_SOURCE_TYPE_SQL_LIST],
    ['equipment_events_kind_check', EQUIPMENT_EVENT_KIND_SQL_LIST],
    ['player_feature_unlocks_feature_check', FEATURE_KEY_SQL_LIST],
    ['player_feature_unlocks_source_check', FEATURE_UNLOCK_SOURCE_SQL_LIST],
    ['equipment_definitions_rarity_check', RARITIES.map((r) => `'${r}'`).join(',')],
    ['equipment_definitions_region_check', REGION_SQL_LIST],
    ['equipment_workshop_operations_kind_check', WORKSHOP_OPERATION_KIND_SQL_LIST],
    ['equipment_workshop_operations_slot_choice_check', WORKSHOP_SLOT_CHOICE_SQL_LIST],
  ])('%s', (constraint, expected) => {
    expect(checkList(constraint)).toBe(expected);
  });

  it('bounds the multipliers exactly as the vocabulary does', () => {
    const line = SQL.split('\n').find((l) => l.includes('"equipment_definitions_bounds_check"'))!;
    expect(line).toContain(`"attack_bp" <= ${EQUIPMENT_MULTIPLIER_BP_MAX.attack}`);
    expect(line).toContain(`"defense_bp" <= ${EQUIPMENT_MULTIPLIER_BP_MAX.defense}`);
    expect(line).toContain(`"health_bp" <= ${EQUIPMENT_MULTIPLIER_BP_MAX.health}`);
  });
});

describe('0045 indexes mirror the schema', () => {
  const TABLES = [
    'equipment_definitions',
    'player_equipment',
    'player_loadouts',
    'player_loadout_slots',
    'equipment_events',
    'equipment_import_log',
    'player_feature_unlocks',
  ];
  const ownIndex = (name: string) => TABLES.some((t) => name.startsWith(`${t}_`));
  const schemaSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'db', 'schema.ts'),
    'utf8',
  );
  const inSchema = [...schemaSource.matchAll(/\b(?:uniqueIndex|index)\('([a-z0-9_]+)'\)/g)]
    .map((m) => m[1]!)
    .filter(ownIndex)
    .sort();
  const inMigration = [...SQL.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([a-z0-9_]+)"/g)]
    .map((m) => m[1]!)
    .sort();

  it('declares the same index set in both places', () => {
    expect(inMigration).toEqual(inSchema);
  });

  it('indexes the equipment_events loadout foreign key', () => {
    // `ON DELETE SET NULL` from player_loadouts would otherwise scan the ledger.
    expect(SQL).toContain(
      'CREATE INDEX IF NOT EXISTS "equipment_events_loadout_idx" ON "equipment_events" USING btree ("loadout_id");',
    );
    expect(inSchema).toContain('equipment_events_loadout_idx');
  });
});

describe('0045 shape', () => {
  const statements = SQL.split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  it('splits into statements the migrator can run, none of them comment-only', () => {
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) {
      expect(statement.replace(/^--.*$/gm, '').trim().length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: every CREATE is IF NOT EXISTS', () => {
    const creates = SQL.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^\n]*/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) expect(create).toMatch(/IF NOT EXISTS/);
  });

  it('inserts no content and touches no existing table', () => {
    // Statements only — the header comment is allowed to *say* "insert".
    const code = SQL.replace(/^--.*$/gm, '');
    expect(code).not.toMatch(/\bINSERT\b/i);
    expect(code).not.toMatch(/\bUPDATE\b\s+"/i);
    expect(code).not.toMatch(/\bALTER TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
  });
});

describe('0046 CHECKs mirror the vocabulary', () => {
  const SQL_0046 = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'drizzle', '0046_equipment_rolled_instances.sql'),
    'utf8',
  );
  const line = (constraint: string) => {
    const found = SQL_0046.split('\n').find((l) => l.includes(`ADD CONSTRAINT "${constraint}"`));
    if (!found) throw new Error(`constraint ${constraint} not added in 0046`);
    return found;
  };

  it.each(['equipment_definitions_multiplier_bounds_check', 'player_equipment_rolled_multiplier_check'])(
    '%s caps each slot exactly as the vocabulary does',
    (constraint) => {
      expect(line(constraint)).toContain(EQUIPMENT_MULTIPLIER_CAP_SQL);
    },
  );

  it('matches affix keys with the key pattern the catalogue validates', () => {
    expect(line('player_equipment_affix_key_check')).toContain(`'${EQUIPMENT_KEY_PATTERN.source}'`);
  });

  it('guards the range modulo against a zero step, as the schema does', () => {
    expect(line('equipment_definitions_multiplier_range_check')).toContain(
      'case when "multiplier_step_bp" > 0 then ("multiplier_max_bp" - "multiplier_min_bp") % "multiplier_step_bp" = 0 else false end',
    );
  });
});

describe('0049 (Patch\'s Workshop) mirrors the schema', () => {
  const sql = fs.readFileSync(path.join(DRIZZLE, '0049_equipment_workshop.sql'), 'utf8');
  const schemaSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'db', 'schema.ts'), 'utf8');

  it('declares the same workshop indexes in both places', () => {
    const own = (name: string) => name.startsWith('equipment_workshop_operations_');
    const inSchema = [...schemaSource.matchAll(/\b(?:uniqueIndex|index)\('([a-z0-9_]+)'\)/g)].map((m) => m[1]!).filter(own).sort();
    const inMigration = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([a-z0-9_]+)"/g)].map((m) => m[1]!).sort();
    expect(inMigration).toEqual(inSchema);
  });

  it('keeps Salvaged Components non-negative in both places', () => {
    expect(sql).toContain('"player_currencies_salvaged_components_check" CHECK ("player_currencies"."salvaged_components" >= 0)');
    expect(schemaSource).toContain("check('player_currencies_salvaged_components_check'");
  });

  it('is idempotent: every CREATE is IF NOT EXISTS and every ADD CONSTRAINT is dropped first', () => {
    for (const create of sql.match(/CREATE (UNIQUE )?(TABLE|INDEX)[^\n]*/g) ?? []) expect(create).toMatch(/IF NOT EXISTS/);
    for (const [, name] of sql.matchAll(/ADD CONSTRAINT "([a-z0-9_]+)"/g)) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "${name}"`);
    }
  });
});
