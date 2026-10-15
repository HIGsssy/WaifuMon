import { describe, expect, it } from 'vitest';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
import {
  buildDungeonPackage,
  DungeonPackageV4Schema,
  dungeonContentHash,
  dungeonPackageIntegrityHash,
  portableHash,
  readDungeonPackage,
  serializeDungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import {
  reviewEncounterDependencies,
  type EncounterImportCatalogue,
} from '../../../src/modules/dungeons/package/dungeonEncounterImport';
import type { PackageSpeciesEvidence } from '../../../src/modules/dungeons/package/dungeonEncounterDependencies';
import type { DungeonDefinition } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { eventDungeon, eventRewardSnapshot } from '../../helpers/dungeonEventFixtures';

const evidence = (slug: string): PackageSpeciesEvidence => ({
  slug,
  rarity: 'N',
  enabled: true,
  regionExclusive: false,
  dungeonExclusive: false,
  dungeonAccess: [],
});
const source = {
  environment: 'source',
  origin: 'draft' as const,
  draftRevision: 1,
  publishedRevision: null,
};
const wild = singleRoomDungeon([
  {
    id: 'meet',
    type: 'wild_encounter' as const,
    source: { kind: 'pool' as const, poolId: 'finds' },
    intro: 'Hello.',
    capture: { allowedItems: ['z_charm', 'a_charm'] },
  },
]).rooms[0]!.actions[0]! as Extract<DungeonDefinition['rooms'][number]['actions'][number], { type: 'wild_encounter' }>;
function definition() {
  return singleRoomDungeon(
    [
      wild,
      {
        id: 'rescue',
        type: 'rescue',
        mode: 'direct',
        source: { kind: 'species', species: 'alpha' },
        intro: 'Free her.',
      },
    ],
    (d) => {
      d.key = 'destination';
      d.speciesPools = [
        {
          id: 'unused',
          name: 'Unused',
          entries: [{ id: 'unused', species: 'unused_missing', weight: 1 }],
        },
        {
          id: 'finds',
          name: 'Finds',
          entries: [
            { id: 'zeta', species: 'zeta', weight: 3 },
            { id: 'alpha', species: 'alpha', weight: 2 },
          ],
        },
      ];
    },
  );
}
function build(d = definition()) {
  return DungeonPackageV4Schema.parse(
    buildDungeonPackage({
      definition: d,
      source,
      species: new Map(['zeta', 'alpha'].map((slug) => [slug, evidence(slug)])),
      packageId: '00000000-0000-4000-8000-000000000001',
      exportedAt: new Date('2026-10-14T00:00:00Z'),
    }),
  );
}
const reseal = (p: ReturnType<typeof build>) => {
  p.contentHash = dungeonContentHash(p.dungeon);
  p.dependenciesHash = portableHash(p.dependencies);
  p.integrityHash = dungeonPackageIntegrityHash(p);
  return p;
};
function catalogue(): EncounterImportCatalogue {
  const rows = ['zeta', 'alpha'].map((slug) => ({
    ...evidence(slug),
    name: slug,
    dungeonAccess: [{ dungeon: 'destination', perPlayerLimit: 2, directRescue: true }],
  }));
  return {
    species: rows,
    items: ['a_charm', 'z_charm'].map((slug) => ({
      slug,
      name: slug,
      enabled: true,
      category: 'capture',
      captureRarities: ['N'],
      isGuaranteedCapture: false,
    })),
    source: {
      species: (slug) => {
        const row = rows.find((s) => s.slug === slug);
        return (
          row && {
            enabled: row.enabled,
            restricted: row.regionExclusive || row.dungeonExclusive,
            access: row.dungeonAccess,
          }
        );
      },
      item: () => ({ enabled: true, capture: true }),
      hasUsableCaptureItem: () => true,
    },
  };
}
describe('v4 package dependencies and integrity', () => {
  it('sorts and deduplicates reachable species/modes and explicit charms, retaining unused content', () => {
    const pkg = build();
    expect(
      pkg.dependencies.requiredSpecies.map(({ slug, modes }) => ({
        slug,
        modes,
      })),
    ).toEqual([
      { slug: 'alpha', modes: ['capture', 'direct'] },
      { slug: 'zeta', modes: ['capture'] },
    ]);
    expect(pkg.dependencies.captureItems).toEqual(['a_charm', 'z_charm']);
    expect(pkg.dependencies.items).toEqual([]);
    expect(pkg.dependencies.requiredItems).toEqual([]);
    expect(pkg.dungeon.speciesPools).toEqual(definition().speciesPools);
    expect(pkg.dependenciesHash).toBe(portableHash(pkg.dependencies));
    expect(pkg.integrityHash).toBe(dungeonPackageIntegrityHash(pkg));
    expect(serializeDungeonPackage(build())).toBe(serializeDungeonPackage(pkg));
    expect(serializeDungeonPackage(readDungeonPackage(serializeDungeonPackage(pkg)).package!)).toBe(
      serializeDungeonPackage(pkg),
    );
  });
  it('excludes encounters after terminal actions and in unreachable rooms', () => {
    const d = definition();
    d.rooms[0]!.actions.push(
      {
        ...wild,
        id: 'end',
        source: { kind: 'species', species: 'alpha' },
        next: { type: 'room_complete' },
      },
      {
        ...wild,
        id: 'unreachable',
        source: { kind: 'species', species: 'absent' },
      },
    );
    d.rooms.push({
      ...d.rooms[0]!,
      id: 'isolated',
      actions: [{ ...wild, source: { kind: 'species', species: 'absent' } }],
    });
    expect(build(d).dependencies.requiredSpecies.map((s) => s.slug)).toEqual(['alpha', 'zeta']);
  });
  it('uses v4 for unused species-pool libraries and does not enumerate global charms', () => {
    const d = singleRoomDungeon([], (x) => {
      x.speciesPools = definition().speciesPools;
    });
    expect(build(d)).toMatchObject({
      schemaVersion: 4,
      dependencies: { requiredSpecies: [], captureItems: [] },
    });
    const ordinary = definition();
    for (const a of ordinary.rooms[0]!.actions)
      if (a.type === 'wild_encounter') a.capture = { maxAttempts: 1, allowGuaranteedItems: false };
    expect(build(ordinary).dependencies.captureItems).toEqual([]);
  });
  it('preserves mixed Event/reward evidence in v4 without rewriting content', () => {
    const d = eventDungeon();
    d.rooms[0]!.actions.unshift({
      ...wild,
      source: { kind: 'species', species: 'alpha' },
    });
    const snapshot = eventRewardSnapshot(d);
    const pkg = buildDungeonPackage({
      definition: d,
      source,
      rewardSnapshot: snapshot,
      species: new Map([['alpha', evidence('alpha')]]),
    });
    expect(pkg.schemaVersion).toBe(4);
    expect(pkg.dungeon).toEqual(d);
    expect(readDungeonPackage(pkg).ok).toBe(true);
    expect(pkg.dependencies.items).toEqual(['scrap_parts']);
    if (pkg.schemaVersion === 4) expect(pkg.dependencies.requiredItems).toEqual(['vault_key']);
  });
  it.each(['rarity', 'policy', 'dependenciesHash', 'integrityHash', 'layout', 'source'] as const)(
    'rejects unsealed %s tampering',
    (field) => {
      const pkg = build();
      if (field === 'rarity') pkg.dependencies.requiredSpecies[0]!.rarity = 'EX';
      if (field === 'policy') pkg.dependencies.requiredSpecies[0]!.enabled = false;
      if (field === 'dependenciesHash' || field === 'integrityHash') pkg[field] = `sha256:${'0'.repeat(64)}`;
      if (field === 'layout')
        pkg.editor.layout = {
          ...pkg.editor.layout,
          rooms: { [pkg.dungeon.rooms[0]!.id]: { x: 2, y: 3 } },
        };
      if (field === 'source') pkg.source.environment = 'altered';
      expect(readDungeonPackage(pkg).ok).toBe(false);
    },
  );
  it.each([
    'omitted species',
    'extra species',
    'duplicate species',
    'unsorted species',
    'wrong mode',
    'omitted charm',
    'extra charm',
    'duplicate charm',
    'unsorted charms',
  ] as const)('rejects resealed %s manifests independently of hashes', (change) => {
    const pkg = build();
    if (change === 'omitted species') pkg.dependencies.requiredSpecies.pop();
    if (change === 'extra species')
      pkg.dependencies.requiredSpecies.push({
        ...evidence('unreferenced'),
        modes: ['capture'],
      });
    if (change === 'duplicate species') pkg.dependencies.requiredSpecies.push(pkg.dependencies.requiredSpecies[0]!);
    if (change === 'unsorted species') pkg.dependencies.requiredSpecies.reverse();
    if (change === 'wrong mode') pkg.dependencies.requiredSpecies[0]!.modes = ['capture'];
    if (change === 'omitted charm') pkg.dependencies.captureItems.pop();
    if (change === 'extra charm') pkg.dependencies.captureItems.push('unreferenced');
    if (change === 'duplicate charm') pkg.dependencies.captureItems.push('a_charm');
    if (change === 'unsorted charms') pkg.dependencies.captureItems.reverse();
    expect(readDungeonPackage(reseal(pkg)).issues).toContainEqual(
      expect.objectContaining({ code: 'package_dependencies_mismatch' }),
    );
  });
  it('rejects resealed noncanonical inherited manifests and reserved species entries', () => {
    const d = definition(); d.availableRegions = ['waifu-valley', 'neon-district'];
    const p = build(d); p.dependencies.regions.reverse();
    expect(readDungeonPackage(reseal(p)).issues).toContainEqual(expect.objectContaining({ code: 'package_dependencies_mismatch', path: 'dependencies.regions' }));
    const reserved = build(); reserved.dependencies.species = ['alpha'];
    expect(readDungeonPackage(reseal(reserved)).issues).toContainEqual(expect.objectContaining({ code: 'package_dependencies_mismatch', path: 'dependencies.species' }));
  });
  it.each(['duplicate', 'unsorted'])('rejects resealed %s access evidence', (kind) => {
    const p = build();
    p.dependencies.requiredSpecies[0]!.dungeonAccess =
      kind === 'duplicate'
        ? [{ dungeon: 'target' }, { dungeon: 'target' }]
        : [{ dungeon: 'z_target' }, { dungeon: 'a_target' }];
    expect(readDungeonPackage(reseal(p)).issues).toContainEqual(
      expect.objectContaining({ code: 'package_dependencies_mismatch' }),
    );
  });
  it('canonically sorts access evidence regardless of source catalogue ordering', () => {
    const d = definition();
    const rows = ['alpha', 'zeta'].map((slug): [string, PackageSpeciesEvidence] =>
      [slug, { ...evidence(slug), dungeonAccess: [{ dungeon: 'z_target' }, { dungeon: 'a_target' }] }]);
    const p = DungeonPackageV4Schema.parse(buildDungeonPackage({ definition: d, source, species: new Map(rows) }));
    expect(p.dependencies.requiredSpecies[0]!.dungeonAccess.map((a) => a.dungeon)).toEqual(['a_target', 'z_target']);
    expect(readDungeonPackage(p).ok).toBe(true);
  });
  it.each([1, 2, 3, 5])('explicitly rejects encounter content advertised as v%s', (schemaVersion) => {
    expect(readDungeonPackage({ ...build(), schemaVersion }).issues).toContainEqual(
      expect.objectContaining({ code: 'package_schema_version' }),
    );
  });
  it('keeps Scene Sprite refusal before v4 selection and legacy version checks', () => {
    const d = definition();
    d.rooms[0]!.sceneSprites = [{ id: 'chest', spriteKey: 'managed' }];
    expect(() => build(d)).toThrow(/Scene Sprites/);
    expect(readDungeonPackage({ ...build(), schemaVersion: 1, dungeon: d }).issues).toContainEqual(
      expect.objectContaining({ code: 'package_scene_sprites_unsupported' }),
    );
  });
  it.each(['broken pool', 'invalid charm rules'] as const)('rejects resealed %s', (change) => {
    const pkg = build();
    const a = pkg.dungeon.rooms[0]!.actions[0]!;
    if (a.type !== 'wild_encounter') throw new Error('fixture');
    if (change === 'broken pool') a.source = { kind: 'pool', poolId: 'absent' };
    else a.capture!.allowedItems = ['a_charm', 'a_charm'];
    expect(readDungeonPackage(reseal(pkg)).ok).toBe(false);
  });
});
describe('pure target dependency review', () => {
  it.each(['missing', 'disabled', 'restricted', 'direct_rescue_not_permitted', 'direct_limit_missing'] as const)(
    'blocks %s species using destination policy',
    (status) => {
      const c = catalogue();
      const row = c.species.find((s) => s.slug === 'alpha')!;
      if (status === 'missing') c.species.splice(c.species.indexOf(row), 1);
      if (status === 'disabled') row.enabled = false;
      if (status === 'restricted') {
        row.regionExclusive = true;
        row.dungeonAccess = [];
      }
      if (status === 'direct_rescue_not_permitted') row.dungeonAccess[0]!.directRescue = false;
      if (status === 'direct_limit_missing') row.dungeonAccess[0]!.perPlayerLimit = 'unlimited';
      const result = reviewEncounterDependencies(build(), definition(), c);
      expect(result.dependencies.requiredSpecies[0]!.status).toBe(status);
      expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
    },
  );
  it('warns on rarity/policy drift and accepts finite direct authorization', () => {
    const c = catalogue();
    c.species[1]!.rarity = 'R';
    const r = reviewEncounterDependencies(build(), definition(), c);
    expect(r.dependencies.requiredSpecies[0]!.status).toBe('available');
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        code: 'package_species_rarity_changed',
        severity: 'warning',
      }),
    );
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        code: 'package_species_policy_changed',
        severity: 'warning',
      }),
    );
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it.each(['missing', 'disabled', 'not_capture', 'incompatible'] as const)(
    'blocks %s explicit capture items',
    (status) => {
      const c = catalogue();
      if (status === 'missing') c.items.shift();
      if (status === 'disabled') c.items[0]!.enabled = false;
      if (status === 'not_capture') c.items[0]!.category = 'material';
      if (status === 'incompatible') c.source.hasUsableCaptureItem = () => false;
      expect(reviewEncounterDependencies(build(), definition(), c).dependencies.captureItems[0]!.status).toBe(status);
    },
  );
});
