/** Illustrative test-only data; no approved production high-rarity balance. */
import fs from 'node:fs';
import path from 'node:path';
import type {
  RollRules,
  RulesBundle,
  RollRulesPreview,
  RollRulesExport,
  LibraryOption,
} from '@/api/adminEquipmentRules';

// Read at test time, not imported: a static import makes `tsc` (and so the
// Portal image's `npm run build`) need repo `content/`, which is outside the
// `portal/` build context. Same pattern as lib/__tests__/speciesTags.test.ts.
const legacy = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'content', 'equipment', 'combatBonuses.json'),
    'utf8',
  ),
) as RollRules['legacy'];

export function rulesFixture(): RollRules {
  return {
    format: 'waifumon-equipment-roll-config',
    version: 2,
    legacy: structuredClone(legacy) as RollRules['legacy'],
    rarities: {
      SSR: {
        bonusCountWeightsBp: [0, 7000, 3000, 0],
        families: [
          {
            stat: 'crit_chance_bp',
            enabled: true,
            slots: ['attack', 'defense', 'health'],
            minValue: 101,
            maxValue: 201,
            step: 25,
          },
          {
            stat: 'lifesteal_bp',
            enabled: true,
            slots: ['attack', 'defense', 'health'],
            minValue: 100,
            maxValue: 200,
            step: 25,
          },
        ],
        primarySp: null,
        affixes: { mode: 'none' },
      },
    },
    flatSpLimits: { perItemMax: 200, perLoadoutMax: 400 },
  };
}
export function libraryFixture(over: Partial<LibraryOption> = {}): LibraryOption {
  return {
    key: 'shared',
    name: 'Shared relic names',
    description: '',
    readOnly: false,
    draftRevision: 3,
    publishedRevision: 2,
    dirty: false,
    draftEntryCount: 3,
    publishedEntryCount: 3,
    assignedTo: [],
    coveredSlots: ['attack', 'defense', 'health'],
    ...over,
  };
}
export function bundleFixture(): RulesBundle {
  const rules = rulesFixture();
  const publishedRules = structuredClone(rules);
  publishedRules.rarities.SSR!.bonusCountWeightsBp = [0, 7500, 2500, 0];
  return {
    draft: {
      draftRevision: 5,
      contentHash: 'sha256:draft',
      rules,
      publishedRevision: 2,
      dirty: true,
      updatedAt: '2026-10-27T17:00:00.000Z',
      updatedBy: 'editor',
    },
    published: {
      revision: 2,
      contentHash: 'sha256:published',
      rules: publishedRules,
      publishedAt: '2026-10-26T17:00:00.000Z',
      publishedBy: 'publisher',
      source: 'editor',
    },
    revisions: [
      {
        revision: 2,
        contentHash: 'sha256:published',
        publishedAt: '2026-10-26T17:00:00.000Z',
        publishedBy: 'publisher',
        source: 'editor',
        rolledBackFrom: null,
        current: true,
      },
      {
        revision: 1,
        contentHash: 'sha256:bootstrap',
        publishedAt: '2026-10-25T17:00:00.000Z',
        publishedBy: 'system:bootstrap',
        source: 'bootstrap',
        rolledBackFrom: null,
        current: false,
      },
    ],
    libraries: [],
  };
}
export function previewFixture(bundle = bundleFixture()): RollRulesPreview {
  return {
    draftRevision: bundle.draft.draftRevision,
    publishedRevision: bundle.published.revision,
    validation: { ok: true, errors: [], warnings: [], value: bundle.draft.rules },
    changes: [
      {
        path: 'rarities.SSR.bonusCountWeightsBp',
        kind: 'changed',
        before: bundle.published.rules.rarities.SSR!.bonusCountWeightsBp,
        after: bundle.draft.rules.rarities.SSR!.bonusCountWeightsBp,
      },
    ],
  };
}
export function exportFixture(): RollRulesExport {
  return {
    format: 'waifumon-equipment-roll-config-export',
    version: 1,
    kind: 'draft',
    revision: 5,
    exportedAt: '2026-10-27T17:00:00.000Z',
    contentHash: 'sha256:draft',
    config: rulesFixture(),
  };
}
