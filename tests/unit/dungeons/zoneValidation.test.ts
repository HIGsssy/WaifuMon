/**
 * Authoring validation for a dungeon zone: the schema, references into other
 * content, reachability, and the trial runs — each with the path the editor
 * shows the problem at.
 */
import { describe, expect, it } from 'vitest';
import { DungeonZoneDefinitionSchema, dungeonZoneHash } from '../../../src/modules/dungeons/zoneDefinition';
import { validateDungeonZone, type DungeonZoneIssue } from '../../../src/modules/dungeons/zoneValidation';
import { testCatalogue, testValidationContext, testZoneDoc } from '../../helpers/dungeonFixtures';

type Patch = Parameters<typeof testZoneDoc>[0];
const issuesOf = (patch?: Patch, ctx = testValidationContext()) => validateDungeonZone(testZoneDoc(patch), ctx).issues;
const errorsAt = (issues: DungeonZoneIssue[]) => issues.filter((i) => i.severity === 'error').map((i) => i.path);
const warningsAt = (issues: DungeonZoneIssue[]) => issues.filter((i) => i.severity === 'warning').map((i) => i.path);

describe('a valid zone', () => {
  it('has no issues', () => {
    expect(issuesOf()).toEqual([]);
  });

  it('parses with every default spelled out, and hashes by meaning rather than formatting', () => {
    const parsed = DungeonZoneDefinitionSchema.parse(testZoneDoc());
    expect(parsed.artworkPath).toBeNull();
    expect(parsed.rewards.currencyKey).toBe('ascension_currency');
    expect(parsed.pools.combat[0]).toMatchObject({ enabled: true, maxDepth: 4, tags: [] });
    expect(dungeonZoneHash(parsed)).toBe(dungeonZoneHash(testZoneDoc()));
    expect(dungeonZoneHash(testZoneDoc({ name: 'Renamed' }))).not.toBe(dungeonZoneHash(testZoneDoc()));
  });
});

describe('schema', () => {
  it('rejects minNodes above maxNodes', () => {
    expect(errorsAt(issuesOf({ generation: { minNodes: 9, maxNodes: 6 } }))).toContain('generation.minNodes');
  });

  it('rejects negative weights and all-zero node weights', () => {
    expect(errorsAt(issuesOf({ generation: { nodeWeights: { combat: -1 } } }))).toContain('generation.nodeWeights.combat');
    const zero = { combat: 0, elite: 0, event: 0, reward: 0, rest: 0, miniboss: 0, exit: 0 };
    expect(errorsAt(issuesOf({ generation: { nodeWeights: zero } }))).toContain('generation.nodeWeights');
    expect(
      errorsAt(issuesOf({ pools: { combat: [{ id: 'grunt', enemyKey: 'grunt', weight: -5 }] } })),
    ).toContain('pools.combat[0].weight');
  });

  it('rejects an inverted depth range on a pool entry, a band and a type', () => {
    expect(
      errorsAt(issuesOf({ pools: { combat: [{ id: 'grunt', enemyKey: 'grunt', weight: 1, minDepth: 5, maxDepth: 2 }] } })),
    ).toContain('pools.combat[0].maxDepth');
    expect(
      errorsAt(issuesOf({ rewards: { bands: [{ id: 'b', minDepth: 4, maxDepth: 1 }] } })),
    ).toContain('rewards.bands[0].maxDepth');
    expect(
      errorsAt(issuesOf({ generation: { depthRanges: { elite: { minDepth: 6, maxDepth: 3 } } } })),
    ).toContain('generation.depthRanges.elite.maxDepth');
  });

  it('rejects duplicate pool entry ids and duplicate band ids', () => {
    const twice = [
      { id: 'grunt', enemyKey: 'grunt', weight: 1 },
      { id: 'grunt', enemyKey: 'brute', weight: 1 },
    ];
    expect(errorsAt(issuesOf({ pools: { combat: twice } }))).toContain('pools.combat[1].id');
    expect(
      errorsAt(issuesOf({ rewards: { bands: [{ id: 'a' }, { id: 'a' }] } })),
    ).toContain('rewards.bands[1].id');
  });

  it('rejects an unsafe artwork path, a bad key, an unknown field and an out-of-range retention', () => {
    for (const artworkPath of ['../secrets.png', '/etc/passwd.png', 'https://x.test/a.png', 'dungeons/zone.exe']) {
      expect(errorsAt(issuesOf({ artworkPath }))).toContain('artworkPath');
      expect(errorsAt(issuesOf({ backgroundArtworkPath: artworkPath }))).toContain('backgroundArtworkPath');
    }
    expect(issuesOf({ artworkPath: 'dungeons/zones/test_zone.webp' })).toEqual([]);
    expect(errorsAt(issuesOf({ key: 'Not A Key' }))).toContain('key');
    expect(errorsAt(validateDungeonZone({ ...testZoneDoc(), surprise: 1 }, testValidationContext()).issues)).toEqual(['zone']);
    expect(
      errorsAt(issuesOf({ rewards: { defeatCurrencyRetentionBasisPoints: 10_001 } })),
    ).toContain('rewards.defeatCurrencyRetentionBasisPoints');
  });
});

describe('references', () => {
  it('rejects a missing enemy, event, reward table and currency', () => {
    expect(
      errorsAt(issuesOf({ pools: { combat: [{ id: 'x', enemyKey: 'nobody', weight: 1 }] } })),
    ).toContain('pools.combat[0].enemyKey');
    expect(
      errorsAt(issuesOf({ pools: { event: [{ id: 'x', eventKey: 'nothing', weight: 1 }] } })),
    ).toContain('pools.event[0].eventKey');
    expect(
      errorsAt(issuesOf({ rewards: { bands: [{ id: 'b', rewardTable: 'missing', equipmentRewardTable: 'gone' }] } })),
    ).toEqual(expect.arrayContaining(['rewards.bands[0].rewardTable', 'rewards.bands[0].equipmentRewardTable']));
    expect(errorsAt(issuesOf({ rewards: { completion: { rewardTable: 'missing' } } }))).toContain(
      'rewards.completion.rewardTable',
    );
    expect(errorsAt(issuesOf({ rewards: { currencyKey: 'doubloons' } }))).toContain('rewards.currencyKey');
  });

  it('accepts a known reward table and only warns about a disabled one', () => {
    expect(issuesOf({ rewards: { bands: [{ id: 'b', rewardTable: 'loot' }] } })).toEqual([]);
    const issues = issuesOf({ rewards: { bands: [{ id: 'b', rewardTable: 'closed' }] } });
    expect(errorsAt(issues)).toEqual([]);
    expect(warningsAt(issues)).toContain('rewards.bands[0].rewardTable');
  });

  it('warns about a disabled enemy that leaves other entries to draw from', () => {
    const issues = issuesOf({}, testValidationContext(testCatalogue({ disabledEnemies: ['brute'] })));
    expect(errorsAt(issues)).toEqual([]);
    expect(warningsAt(issues)).toContain('pools.combat[1].enemyKey');
  });
});

describe('reachability', () => {
  it('rejects a required boss with no candidates', () => {
    expect(errorsAt(issuesOf({ pools: { boss: [] } }))).toContain('pools.boss');
    const disabled = issuesOf({}, testValidationContext(testCatalogue({ disabledEnemies: ['overlord'] })));
    expect(errorsAt(disabled)).toContain('pools.boss');
  });

  it('rejects a boss pool that does not cover every depth a run can end at', () => {
    const issues = issuesOf({ pools: { boss: [{ id: 'overlord', enemyKey: 'overlord', weight: 1, minDepth: 9 }] } });
    expect(issues.find((i) => i.path === 'pools.boss')?.message).toMatch(/ends at depth 4, 5, 6, 7, 8/);
  });

  it('rejects an extraction depth outside the run', () => {
    expect(errorsAt(issuesOf({ generation: { extraction: { minDepth: 30 } } }))).toContain(
      'generation.extraction.minDepth',
    );
    // The shortest run ends at depth 4 (6 nodes, a 2-long fork), so depth 4 cannot hold a guaranteed point.
    expect(errorsAt(issuesOf({ generation: { extraction: { minDepth: 4 } } }))).toContain(
      'generation.extraction.minDepth',
    );
  });

  it('accepts extraction windows that every run can hold, and rejects the ones it cannot', () => {
    const windows = (...w: { minDepth: number; maxDepth: number | null; required?: boolean }[]) => ({
      generation: { extraction: { windows: w } },
    });
    expect(issuesOf(windows({ minDepth: 3, maxDepth: 3 }, { minDepth: 6, maxDepth: null, required: false }))).toEqual([]);
    // The shortest run ends at depth 4: a required window from depth 4 cannot always be placed…
    expect(errorsAt(issuesOf(windows({ minDepth: 4, maxDepth: null })))).toContain('generation.extraction.windows[0]');
    // …but an optional one there is fine.
    expect(issuesOf(windows({ minDepth: 4, maxDepth: null, required: false }))).toEqual([]);
    // A window that ends above the extraction depth, or starts past every run, can never hold
    // anything: an error when it is required, a warning when it is optional (it is just dead).
    expect(errorsAt(issuesOf(windows({ minDepth: 1, maxDepth: 2 })))).toContain('generation.extraction.windows[0]');
    expect(errorsAt(issuesOf(windows({ minDepth: 30, maxDepth: null })))).toContain('generation.extraction.windows[0]');
    const dead = issuesOf(windows({ minDepth: 1, maxDepth: 2, required: false }, { minDepth: 30, maxDepth: null, required: false }));
    expect(errorsAt(dead)).toEqual([]);
    expect(warningsAt(dead)).toEqual(['generation.extraction.windows[0]', 'generation.extraction.windows[1]']);
    // Schema: an inverted window, an unknown field.
    expect(errorsAt(issuesOf(windows({ minDepth: 5, maxDepth: 3 }))).some((p) => p.startsWith('generation.extraction.windows'))).toBe(true);
    expect(
      errorsAt(issuesOf({ generation: { extraction: { windows: [{ minDepth: 3, maxDepth: 3, bogus: 1 } as never] } } })).some((p) =>
        p.startsWith('generation.extraction.windows'),
      ),
    ).toBe(true);
  });

  it('rejects a required node type with no eligible pool', () => {
    const issues = issuesOf({ generation: { required: [{ types: ['miniboss'], min: 1 }] }, pools: { miniboss: [] } });
    expect(errorsAt(issues)).toContain('generation.required[0]');
  });

  it('rejects an impossible depth range for a type in use', () => {
    expect(errorsAt(issuesOf({ generation: { depthRanges: { rest: { minDepth: 30 } } } }))).toContain(
      'generation.depthRanges.rest.minDepth',
    );
  });

  it('rejects a limit that contradicts a requirement', () => {
    const issues = issuesOf({
      generation: { required: [{ types: ['rest'], min: 2 }], limits: [{ types: ['rest'], max: 1 }] },
    });
    expect(errorsAt(issues)).toContain('generation.limits[0].max');
  });

  it('warns about a weighted type that can never be placed', () => {
    const issues = issuesOf({ pools: { miniboss: [] } });
    expect(errorsAt(issues)).toEqual([]);
    expect(warningsAt(issues)).toContain('generation.nodeWeights.miniboss');
  });
});

describe('trial runs', () => {
  // Each rule is fine alone; together they leave no legal type for some slots:
  // only rest has a weight, and two rests may not be adjacent.
  const jammed: Patch = {
    generation: {
      nodeWeights: { combat: 0, elite: 0, event: 0, reward: 0, rest: 10, miniboss: 0, exit: 0 },
      required: [],
      limits: [],
    },
  };

  it('rejects jointly impossible constraints on an enabled zone', () => {
    const issues = issuesOf(jammed);
    expect(errorsAt(issues)).toEqual(['generation']);
    expect(issues[0]!.message).toMatch(/cannot produce a run|trial runs could not be generated/);
  });

  it('only warns when the zone is disabled, so work in progress can be saved', () => {
    const issues = issuesOf({ ...jammed, enabled: false });
    expect(errorsAt(issues)).toEqual([]);
    expect(warningsAt(issues)).toEqual(['generation']);
  });

  it('can be skipped by a caller about to generate anyway', () => {
    const { issues } = validateDungeonZone(testZoneDoc(jammed), { ...testValidationContext(), skipTrialRuns: true });
    expect(issues).toEqual([]);
  });
});
