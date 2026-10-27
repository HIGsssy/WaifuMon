/**
 * Managed affix libraries (Equipment 3.0, E3-B), pure: entry validation and
 * the global key/suffix namespace, the read-only view of the shipped N/R/SR
 * catalogue, the suffix snapshot that keeps owned names stable, and the
 * export/import envelope. No high-rarity affix content ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAffixCatalogue,
  EQUIPMENT_AFFIX_POOLS,
  EquipmentAffixFileSchema,
} from '../../src/modules/equipment/affixCatalogue';
import {
  affixSnapshotProperties,
  buildAffixLibraryExport,
  isReservedLibraryKey,
  LibraryKeySchema,
  legacyAffixLibraries,
  legacyNamespace,
  readAffixLibraryExport,
  readAffixSuffixSnapshot,
  slotsCovered,
  validateLibraryEntries,
  type ManagedAffixEntry,
} from '../../src/modules/equipment/affixLibraries';
import { equipmentDisplayName, UNKNOWN_AFFIX_LABEL } from '../../src/modules/equipment/equipmentRoll';
import { CONTENT_DIR } from '../helpers/fixtures';

const SHIPPED = buildAffixCatalogue(
  EquipmentAffixFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'affixes.json'), 'utf8'))).affixes,
);
const EMPTY = { keys: new Map<string, string>(), suffixes: new Map<string, string>() };
const entry = (key: string, suffix: string, slots: ManagedAffixEntry['slots'] = ['attack', 'defense', 'health'], enabled = true): ManagedAffixEntry => ({
  key,
  suffix,
  slots,
  enabled,
});

describe('library keys', () => {
  it('are stable snake_case identifiers, never a path and never a legacy name', () => {
    expect(LibraryKeySchema.safeParse('high_rarity_affixes').success).toBe(true);
    for (const bad of ['legacy', 'legacy_n', 'legacy_ssr', '../affixes.json', '/srv/x', 'C:\\x', 'High Rarity', '']) {
      expect(LibraryKeySchema.safeParse(bad).success).toBe(false);
    }
    expect(isReservedLibraryKey('legacy_sr')).toBe(true);
    expect(isReservedLibraryKey('legacyish')).toBe(false);
  });
});

describe('entries', () => {
  it('accepts an empty library and slot-specific entries', () => {
    expect(validateLibraryEntries([], EMPTY)).toEqual({ ok: true, value: [], errors: [] });
    const entries = [entry('the_unbroken_oath', 'of the Unbroken Oath', ['attack']), entry('quiet_dawn', 'of the Quiet Dawn', ['defense', 'health'])];
    expect(validateLibraryEntries(entries, EMPTY)).toMatchObject({ ok: true, errors: [] });
    expect(slotsCovered(entries)).toEqual(new Set(['attack', 'defense', 'health']));
    expect(slotsCovered([entry('x', 'of X', ['attack'], false)])).toEqual(new Set());
  });

  it('refuses duplicates, bad shapes and anything colliding with the shipped catalogue', () => {
    const legacy = legacyNamespace(SHIPPED);
    const [first] = SHIPPED.all();
    const errors = validateLibraryEntries(
      [
        entry('dup', 'of Dup'),
        entry('dup', 'of Dup Two'),
        entry('same_suffix', 'of DUP'),
        entry(first!.key, 'of Something New'),
        entry('fresh', first!.suffix.toUpperCase()),
        entry('two_slots', 'of Two', ['attack', 'attack']),
      ],
      legacy,
    ).errors.map((e) => `${e.path} ${e.message}`);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/entries\[1\]\.key duplicate affix key "dup"/),
        expect.stringMatching(/entries\[2\]\.suffix duplicate suffix/),
        expect.stringMatching(/entries\[3\]\.key affix key ".*" is already used by the shipped affix catalogue/),
        expect.stringMatching(/entries\[4\]\.suffix suffix ".*" is already used by the shipped affix catalogue/),
        expect.stringMatching(/entries\[5\]\.slots contains duplicates/),
      ]),
    );
    for (const bad of [
      [{ key: 'x', suffix: ' of X', slots: ['attack'], enabled: true }],
      [{ key: 'x', suffix: 'of X', slots: [], enabled: true }],
      [{ key: 'x', suffix: 'of X', slots: ['relic'], enabled: true }],
      [{ key: 'x', suffix: 'of X', slots: ['attack'], enabled: true, weight: 5 }],
      [{ key: 'X', suffix: 'of X', slots: ['attack'], enabled: true }],
    ]) {
      expect(validateLibraryEntries(bad, EMPTY).ok).toBe(false);
    }
  });
});

describe('the shipped catalogue, read-only', () => {
  const legacy = legacyAffixLibraries(SHIPPED);

  it('is three read-only libraries holding every shipped affix exactly once', () => {
    expect(legacy.map((l) => [l.key, l.rarity, l.readOnly])).toEqual([
      ['legacy_n', 'N', true],
      ['legacy_r', 'R', true],
      ['legacy_sr', 'SR', true],
    ]);
    expect(legacy.flatMap((l) => l.entries.map((e) => e.key)).sort()).toEqual(SHIPPED.all().map((a) => a.key).sort());
  });

  it('presents each pool in file order — the exact list and order the legacy roll draws from', () => {
    for (const pool of EQUIPMENT_AFFIX_POOLS) {
      const [slot, rarity] = pool.split('.') as [string, string];
      const library = legacy.find((l) => l.rarity === rarity)!;
      const shown = library.entries.filter((e) => e.enabled && e.slots[0] === slot).map((e) => e.key);
      expect(shown).toEqual(SHIPPED.rollable(pool).map((a) => a.key));
    }
  });
});

describe('owned-copy names', () => {
  it('a legacy copy resolves its key exactly as before', () => {
    const [first] = SHIPPED.all();
    expect(equipmentDisplayName('Rusty Pipe', first!.key, SHIPPED)).toBe(`Rusty Pipe ${first!.suffix}`);
    expect(equipmentDisplayName('Rusty Pipe', first!.key, SHIPPED, {})).toBe(`Rusty Pipe ${first!.suffix}`);
    expect(equipmentDisplayName('Rusty Pipe', null, SHIPPED, {})).toBe('Rusty Pipe');
  });

  it('a managed-library copy renders its snapshot, whatever the catalogues say now', () => {
    const props = { flatSp: 20, ...affixSnapshotProperties('high_rarity', { suffix: 'of the Unbroken Oath' }) };
    expect(props).toEqual({ flatSp: 20, affixSuffix: 'of the Unbroken Oath', affixLibrary: 'high_rarity' });
    expect(equipmentDisplayName('Relic Blade', 'the_unbroken_oath', SHIPPED, props)).toBe('Relic Blade of the Unbroken Oath');
    // Without the snapshot the key is unknown to the shipped catalogue — the
    // marker shows; the snapshot is what keeps such a copy named.
    expect(equipmentDisplayName('Relic Blade', 'the_unbroken_oath', SHIPPED, {})).toBe(`Relic Blade ${UNKNOWN_AFFIX_LABEL}`);
  });

  it.each([[{}, null], [{ affixSuffix: '' }, null], [{ affixSuffix: 5 }, null], [null, null], [[], null], [{ affixSuffix: 'of X' }, 'of X']])(
    'reads %j as snapshot %j',
    (props, expected) => {
      expect(readAffixSuffixSnapshot(props)).toBe(expected);
    },
  );
});

describe('export / import envelope', () => {
  it('round-trips with its stable key', () => {
    const entries = [entry('the_unbroken_oath', 'of the Unbroken Oath')];
    const file = buildAffixLibraryExport({ key: 'high_rarity', name: 'High rarity', description: '' }, entries, {
      kind: 'published',
      revision: 2,
      exportedAt: '2026-10-27T00:00:00.000Z',
    });
    expect(file).toMatchObject({ format: 'waifumon-equipment-affix-library', version: 1, kind: 'published', revision: 2 });
    expect(readAffixLibraryExport(JSON.parse(JSON.stringify(file)))).toEqual({
      ok: true,
      library: { key: 'high_rarity', name: 'High rarity', description: '' },
      affixes: entries,
    });
  });

  it('refuses a legacy key, a path, or unknown envelope fields', () => {
    const file = buildAffixLibraryExport({ key: 'high_rarity', name: 'H', description: '' }, [], { kind: 'draft', revision: 1, exportedAt: 'x' });
    expect(readAffixLibraryExport({ ...file, library: { ...file.library, key: 'legacy_n' } }).ok).toBe(false);
    expect(readAffixLibraryExport({ ...file, library: { ...file.library, key: '../../content/equipment/affixes' } }).ok).toBe(false);
    expect(readAffixLibraryExport({ ...file, sourcePath: '/srv/affixes.json' }).ok).toBe(false);
  });
});
