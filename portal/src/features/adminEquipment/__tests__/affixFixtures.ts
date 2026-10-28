/** Test-only managed content; legacy entries use the unchanged shipped file. */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AffixEntry,
  LibraryExport,
  LibraryList,
  LibraryPreview,
  LibraryRevision,
  ManagedLibrary,
} from '@/api/adminEquipmentAffixes';
import type { EquipmentSlotName } from '@/api/adminEquipment';

// Read at test time, not imported: a static import makes `tsc` (and so the
// Portal image's `npm run build`) need repo `content/`, which is outside the
// `portal/` build context. Same pattern as lib/__tests__/speciesTags.test.ts.
const shipped = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'content', 'equipment', 'affixes.json'),
    'utf8',
  ),
) as { affixes: Array<{ key: string; suffix: string; pool: string; enabled: boolean }> };

export function entry(key = 'alpha', suffix = 'of Alpha'): AffixEntry {
  return { key, suffix, slots: ['attack', 'defense', 'health'], enabled: true };
}
export function managed(over: Partial<ManagedLibrary> = {}): ManagedLibrary {
  return {
    key: 'shared',
    name: 'Shared Names',
    description: 'Test-only library',
    readOnly: false,
    draftRevision: 5,
    publishedRevision: 2,
    dirty: true,
    draftEntryCount: 3,
    publishedEntryCount: 2,
    assignedTo: ['SSR', 'UR'],
    draftEntries: [
      entry('alpha', 'of Updated Alpha'),
      { ...entry('beta', 'of Beta'), enabled: false },
      entry('gamma', 'of Gamma'),
    ],
    publishedEntries: [entry('alpha', 'of Original Alpha'), entry('beta', 'of Beta')],
    updatedAt: '2026-10-27T18:00:00.000Z',
    updatedBy: 'editor',
    ...over,
  };
}
export function listFixture(library = managed()): LibraryList {
  const {
    draftEntries: _d,
    publishedEntries: _p,
    updatedAt: _t,
    updatedBy: _u,
    ...summary
  } = library;
  const other = managed({
    key: 'unpublished',
    name: 'Unpublished Names',
    description: 'Preparation only',
    draftRevision: 1,
    publishedRevision: null,
    draftEntryCount: 0,
    publishedEntryCount: 0,
    assignedTo: [],
  });
  const {
    draftEntries: _od,
    publishedEntries: _op,
    updatedAt: _ot,
    updatedBy: _ou,
    ...otherSummary
  } = other;
  return {
    managed: [summary, otherSummary],
    legacy: (['N', 'R', 'SR'] as const).map((rarity) => ({
      key: `legacy_${rarity.toLowerCase()}`,
      name: `Shipped ${rarity} affixes`,
      description: 'Read-only shipped affixes',
      readOnly: true,
      rarity,
      entries: shipped.affixes
        .filter((a) => a.pool.endsWith(`.${rarity}`))
        .map((a) => ({
          key: a.key,
          suffix: a.suffix,
          slots: [a.pool.split('.')[0] as EquipmentSlotName],
          enabled: a.enabled,
        })),
    })),
  };
}
export function revisionsFixture(): LibraryRevision[] {
  return [
    {
      revision: 2,
      contentHash: 'sha256:two',
      source: 'editor',
      rolledBackFrom: null,
      entryCount: 2,
      publishedBy: 'publisher',
      publishedAt: '2026-10-26T17:00:00.000Z',
      current: true,
    },
    {
      revision: 1,
      contentHash: 'sha256:one',
      source: 'import',
      rolledBackFrom: null,
      entryCount: 1,
      publishedBy: 'importer',
      publishedAt: '2026-10-25T17:00:00.000Z',
      current: false,
    },
  ];
}
export function previewFixture(library = managed()): LibraryPreview {
  return {
    draftRevision: library.draftRevision,
    publishedRevision: library.publishedRevision,
    validation: { ok: true, errors: [] },
    changes: [
      {
        path: 'entries',
        before: library.publishedRevision === null ? null : library.publishedEntries,
        after: library.draftEntries,
      },
    ],
  };
}
export function exportFixture(key = 'shared'): LibraryExport {
  return {
    format: 'waifumon-equipment-affix-library',
    version: 1,
    kind: 'draft',
    revision: 5,
    exportedAt: '2026-10-27T18:00:00.000Z',
    library: { key, name: 'Imported Names', description: 'Test import' },
    affixes: [entry('imported_affix', 'of Imported Tests')],
  };
}
