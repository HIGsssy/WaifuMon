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
} from '../../src/modules/equipment/vocabulary';
import {
  FEATURE_KEY_SQL_LIST,
  FEATURE_UNLOCK_SOURCE_SQL_LIST,
} from '../../src/modules/features/vocabulary';
import { RARITIES } from '../../src/db/schema';
import { REGION_SQL_LIST } from '../../src/modules/locations/regions';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'drizzle', '0045_equipment_foundation.sql'),
  'utf8',
);

/** The `in (...)` list of the named CHECK constraint. */
function checkList(constraint: string): string {
  const line = SQL.split('\n').find((l) => l.includes(`"${constraint}"`));
  if (!line) throw new Error(`constraint ${constraint} not found in 0045`);
  const match = /\bin \(([^)]*)\)/.exec(line);
  if (!match) throw new Error(`constraint ${constraint} has no IN list`);
  return match[1]!;
}

describe('0045 CHECK lists mirror the vocabulary', () => {
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
