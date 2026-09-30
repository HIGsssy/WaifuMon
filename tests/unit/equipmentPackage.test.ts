/**
 * Equipment packages — pure parse, build and plan. The database half
 * (`equipmentImportService`) is covered in tests/integration/equipmentContent.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEquipmentPackage,
  EQUIPMENT_PACKAGE_FORMAT,
  parseEquipmentPackage,
  planEquipmentImport,
  type ImportTargetDefinition,
} from '../../src/modules/equipment/equipmentPackage';
import { parseEquipmentDefinition } from '../../src/modules/equipment/definitionSchema';
import { EquipmentValidationError } from '../../src/shared/errors';
import type { EquipmentDefinitionRow } from '../../src/db/schema';

const ring = { key: 'spiked_ring', name: 'Spiked Ring', slot: 'attack', rarity: 'R', attackBp: 7_200 };
const belt = { key: 'guard_belt', name: 'Guard Belt', slot: 'defense', rarity: 'N', defenseBp: 4_000 };

const pkg = (definitions: unknown[], over: Record<string, unknown> = {}) => ({
  format: EQUIPMENT_PACKAGE_FORMAT,
  version: 1,
  definitions,
  ...over,
});

function issuesOf(raw: unknown) {
  try {
    parseEquipmentPackage(raw);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(EquipmentValidationError);
    return (err as EquipmentValidationError).issues;
  }
}

describe('parseEquipmentPackage', () => {
  it('parses a valid package, empty included', () => {
    expect(parseEquipmentPackage(pkg([])).definitions).toEqual([]);
    const parsed = parseEquipmentPackage(pkg([ring, belt], { label: 'staging', exportedAt: '2026-09-30T00:00:00Z' }));
    expect(parsed.definitions.map((d) => d.key)).toEqual(['spiked_ring', 'guard_belt']);
    expect(parsed.label).toBe('staging');
  });

  it('refuses another format', () => {
    expect(issuesOf(pkg([], { format: 'waifumon-world-encounters' }))).toContainEqual({
      path: 'format',
      message: `must be "${EQUIPMENT_PACKAGE_FORMAT}"`,
    });
  });

  it('refuses an unknown version by name', () => {
    expect(issuesOf(pkg([], { version: 2 }))).toContainEqual({
      path: 'version',
      message: 'this build reads version 1 only, got 2',
    });
  });

  it('refuses a definition carrying a numeric id', () => {
    expect(issuesOf(pkg([{ ...ring, id: 4 }]))).toContainEqual({
      path: 'definitions[0]',
      message: 'definitions are identified by key; numeric ids are not allowed',
    });
  });

  it('refuses duplicate keys', () => {
    expect(issuesOf(pkg([ring, belt, ring]))).toContainEqual({
      path: 'definitions[2].key',
      message: 'duplicate key "spiked_ring" (also definitions[0])',
    });
  });

  it('collects every invalid entry before failing', () => {
    const issues = issuesOf(pkg([{ ...ring, attackBp: 0 }, belt, { ...belt, key: 'x', rarity: 'EX' }]));
    expect(issues.map((i) => i.path)).toEqual(['definitions[0].attackBp', 'definitions[2].rarity']);
  });

  it('refuses a non-object, a missing definitions array and unknown envelope fields', () => {
    expect(issuesOf([])).toEqual([{ path: '', message: 'a package must be a JSON object' }]);
    expect(issuesOf({ format: EQUIPMENT_PACKAGE_FORMAT, version: 1 })).toContainEqual({
      path: 'definitions',
      message: 'must be an array',
    });
    expect(issuesOf(pkg([], { players: [] }))).toContainEqual({ path: '', message: 'unknown field(s): players' });
  });
});

function row(over: Partial<EquipmentDefinitionRow> & { key: string }): EquipmentDefinitionRow {
  return {
    id: 99,
    name: 'Row',
    description: '',
    slot: 'attack',
    rarity: 'R',
    attackBp: 7_000,
    defenseBp: 0,
    healthBp: 0,
    secondaryEffects: [],
    tags: [],
    regionId: null,
    artworkPath: null,
    enabled: true,
    shopRegions: [],
    buyPrice: null,
    priceCurrency: 'waifubux',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    updatedBy: 'someone',
    ...over,
  };
}

describe('buildEquipmentPackage', () => {
  it('writes keys, never ids or audit columns, sorted by key', () => {
    const built = buildEquipmentPackage([row({ key: 'zeta', id: 1 }), row({ key: 'alpha', id: 2 })], {
      exportedAt: '2026-09-30T00:00:00.000Z',
      label: 'test',
    });
    expect(built.definitions.map((d) => d.key)).toEqual(['alpha', 'zeta']);
    const text = JSON.stringify(built);
    expect(text).not.toMatch(/"id"/);
    expect(text).not.toMatch(/updatedBy|createdAt|updatedAt/);
  });

  it('round-trips through parse unchanged', () => {
    const built = buildEquipmentPackage([row({ key: 'alpha', tags: ['ring'], regionId: 'thirstlands' })], {
      exportedAt: '2026-09-30T00:00:00.000Z',
    });
    expect(parseEquipmentPackage(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });
});

describe('planEquipmentImport', () => {
  const target = (entries: [unknown, number][]) =>
    new Map<string, ImportTargetDefinition>(
      entries.map(([raw, instanceCount]) => {
        const input = parseEquipmentDefinition(raw);
        return [input.key, { input, instanceCount }];
      }),
    );

  it('classifies create, update and unchanged', () => {
    const plan = planEquipmentImport(
      parseEquipmentPackage(pkg([ring, belt, { ...ring, key: 'new_ring' }])),
      target([
        [ring, 0],
        [{ ...belt, name: 'Old Belt Name' }, 3],
      ]),
    );
    expect(plan.ok).toBe(true);
    expect(plan.entries).toEqual([
      { key: 'spiked_ring', action: 'unchanged', changedFields: [] },
      { key: 'guard_belt', action: 'update', changedFields: ['name'] },
      { key: 'new_ring', action: 'create', changedFields: [] },
    ]);
    expect(plan.counts).toEqual({ create: 1, update: 1, unchanged: 1 });
  });

  it('refuses a slot change on a definition players own', () => {
    const moved = { ...ring, slot: 'defense', attackBp: 0, defenseBp: 5_000 };
    const plan = planEquipmentImport(parseEquipmentPackage(pkg([moved])), target([[ring, 2]]));
    expect(plan.ok).toBe(false);
    expect(plan.issues).toEqual([
      {
        path: 'definitions[0].slot',
        message: '"spiked_ring" is owned by players (2 instance(s)); its slot cannot change from attack to defense',
      },
    ]);
  });

  it('allows a slot change on a definition nobody owns', () => {
    const moved = { ...ring, slot: 'defense', attackBp: 0, defenseBp: 5_000 };
    const plan = planEquipmentImport(parseEquipmentPackage(pkg([moved])), target([[ring, 0]]));
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]!.changedFields).toEqual(['slot', 'attackBp', 'defenseBp']);
  });

  it('never plans a delete for a target definition the package omits', () => {
    const plan = planEquipmentImport(parseEquipmentPackage(pkg([])), target([[ring, 5]]));
    expect(plan.entries).toEqual([]);
    expect(plan.ok).toBe(true);
  });
});
