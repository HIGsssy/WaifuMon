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
const hasBlocking = (issues: DungeonZoneIssue[]) => issues.some((i) => i.severity === 'error');
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

describe('regions', () => {
  it('accepts one region and several', () => {
    expect(issuesOf({ availableRegions: ['waifu-valley'] })).toEqual([]);
    expect(issuesOf({ availableRegions: ['waifu-valley', 'twin-peeks', 'flaccid-foothills'] })).toEqual([]);
  });

  it('refuses a region the catalogue does not have, at its index', () => {
    const issues = issuesOf({ availableRegions: ['waifu-valley', 'sunken-mall'] });
    expect(errorsAt(issues)).toEqual(['availableRegions[1]']);
    expect(issues[0]!.message).toBe('"sunken-mall" is not a region');
  });

  it('refuses a duplicate and a value that is not a region id at all', () => {
    expect(errorsAt(issuesOf({ availableRegions: ['waifu-valley', 'waifu-valley'] }))).toEqual(['availableRegions[1]']);
    expect(errorsAt(issuesOf({ availableRegions: ['Waifu Valley'] }))).toEqual(['availableRegions[0]']);
    expect(new Set(errorsAt(issuesOf({ availableRegions: [''] })))).toEqual(new Set(['availableRegions[0]']));
    expect(errorsAt(issuesOf({ availableRegions: 'waifu-valley' as never }))).toEqual(['availableRegions']);
  });

  it('requires at least one region on an enabled zone — an empty list is nowhere, never everywhere', () => {
    const enabled = issuesOf({ availableRegions: [] });
    expect(errorsAt(enabled)).toEqual(['availableRegions']);
    expect(enabled[0]!.message).toMatch(/choose at least one region/);
    // A zone still being authored may be saved without one, with a warning.
    const draft = issuesOf({ enabled: false, availableRegions: [] });
    expect(errorsAt(draft)).toEqual([]);
    expect(warningsAt(draft)).toContain('availableRegions');
  });

  it('defaults to no region when the field is absent: a zone saved before regions existed still parses', () => {
    const { availableRegions: _dropped, ...legacy } = testZoneDoc();
    const parsed = DungeonZoneDefinitionSchema.parse(legacy);
    expect(parsed.availableRegions).toEqual([]);
    expect(errorsAt(validateDungeonZone(legacy, testValidationContext()).issues)).toEqual(['availableRegions']);
  });

  it('warns about a region that exists but is not released', () => {
    const issues = issuesOf({ availableRegions: ['waifu-valley', 'sealed-vault'] });
    expect(errorsAt(issues)).toEqual([]);
    expect(warningsAt(issues)).toEqual(['availableRegions[1]']);
  });
});

describe('artwork paths', () => {
  it('accepts the conventional zone and background paths, and none at all', () => {
    expect(issuesOf({ artworkPath: 'dungeons/zones/test_zone.webp', backgroundArtworkPath: 'dungeons/backgrounds/test_zone.webp' })).toEqual([]);
    expect(issuesOf({ artworkPath: null, backgroundArtworkPath: null })).toEqual([]);
    expect(issuesOf({ artworkPath: 'dungeons/zones/test_zone.png' })).toEqual([]);
  });

  it.each([
    ['traversal', '../secrets.webp'],
    ['traversal inside', 'dungeons/../../etc/passwd.webp'],
    ['absolute', '/etc/passwd.webp'],
    ['windows drive', 'C:/art/zone.webp'],
    ['backslashes', 'dungeons\\zones\\x.webp'],
    ['a URL', 'https://example.com/x.webp'],
    ['not an image', 'dungeons/zones/x.exe'],
    ['no extension', 'dungeons/zones/x'],
    ['a leading assets/', 'assets/dungeons/zones/x.webp'],
  ])('refuses %s on both fields', (_what, value) => {
    expect(errorsAt(issuesOf({ artworkPath: value }))).toEqual(['artworkPath']);
    expect(errorsAt(issuesOf({ backgroundArtworkPath: value }))).toEqual(['backgroundArtworkPath']);
  });

  it('says what is wrong with a leading assets/', () => {
    expect(issuesOf({ artworkPath: 'assets/dungeons/zones/x.webp' })[0]!.message).toMatch(/drop the leading "assets\/"/);
  });
});

describe('rest rules', () => {
  const rest = (r: Record<string, unknown>, generation: Record<string, unknown> = {}) => ({ generation: { rest: r, ...generation } }) as Patch;

  it('accepts a consistent set, and the defaults are no rule at all', () => {
    expect(issuesOf(rest({ minNodes: 1, maxNodes: 2, minDepth: 2, maxDepth: null, beforeBoss: true }))).toEqual([]);
    expect(DungeonZoneDefinitionSchema.parse(testZoneDoc()).generation.rest).toEqual({
      minNodes: 0,
      maxNodes: null,
      minDepth: 1,
      maxDepth: null,
      beforeBoss: false,
    });
  });

  it('refuses a minimum above the maximum, and an inverted depth range', () => {
    expect(errorsAt(issuesOf(rest({ minNodes: 3, maxNodes: 2 })))).toEqual(['generation.rest.minNodes']);
    expect(errorsAt(issuesOf(rest({ minDepth: 5, maxDepth: 3 })))).toEqual(['generation.rest.maxDepth']);
  });

  it('refuses negative, fractional and unknown values', () => {
    expect(errorsAt(issuesOf(rest({ minNodes: -1 })))).toEqual(['generation.rest.minNodes']);
    expect(errorsAt(issuesOf(rest({ maxNodes: 1.5 })))).toEqual(['generation.rest.maxNodes']);
    expect(errorsAt(issuesOf(rest({ minDepth: 0 })))).toEqual(['generation.rest.minDepth']);
    expect(errorsAt(issuesOf(rest({ beforeBoss: 'yes' })))).toEqual(['generation.rest.beforeBoss']);
    expect(errorsAt(issuesOf(rest({ sometimes: true })))).toEqual(['generation.rest']);
  });

  it('refuses a depth range no run reaches, and a minimum the shortest run cannot hold', () => {
    expect(errorsAt(issuesOf(rest({ minNodes: 1, minDepth: 30 })))).toContain('generation.rest.minDepth');
    // The shortest run ends at depth 4: three nodes before the final one.
    expect(errorsAt(issuesOf(rest({ minNodes: 4 })))).toContain('generation.rest.minNodes');
  });

  it('refuses Rest before Boss without a boss', () => {
    const issues = issuesOf(rest({ beforeBoss: true }, { boss: { required: false } }));
    expect(errorsAt(issues)).toContain('generation.rest.beforeBoss');
    expect(issues.find((i) => i.path === 'generation.rest.beforeBoss')!.message).toMatch(/needs a boss/);
  });

  it('refuses Rest before Boss when no rest is allowed', () => {
    expect(errorsAt(issuesOf(rest({ beforeBoss: true, maxNodes: 0 })))).toContain('generation.rest.maxNodes');
    expect(errorsAt(issuesOf(rest({ beforeBoss: true }, { limits: [{ types: ['rest'], max: 0 }], required: [{ types: ['reward'], min: 1 }] })))).toContain(
      'generation.limits[0].max',
    );
  });

  it('refuses Rest before Boss when the rest depth range excludes where it must sit, naming the depths', () => {
    // With the rule on, runs end at depth 5–10 (the last interior depth is closed to
    // forks, so the shortest forked run is one deeper), and the rest sits at depth 4–9.
    const late = issuesOf(rest({ beforeBoss: true, maxDepth: 6 }));
    expect(errorsAt(late)).toEqual(['generation.rest.beforeBoss']);
    expect(late[0]!.message).toMatch(/runs end at depth 5–10, so the rest before the boss sits at depth 4–9; the rest depth range excludes depth 7, 8, 9/);
    const early = issuesOf(rest({ beforeBoss: true, minDepth: 5 }));
    expect(early[0]!.message).toMatch(/excludes depth 4$/);
    // The generic per-type depth range is checked the same way.
    const generic = issuesOf(rest({ beforeBoss: true }, { depthRanges: { rest: { minDepth: 1, maxDepth: 4 } } }));
    expect(errorsAt(generic)).toEqual(['generation.rest.beforeBoss']);
  });

  it('refuses Rest before Boss in a run too short for a start, a rest and a boss', () => {
    const issues = issuesOf(rest({ beforeBoss: true }, { minNodes: 2, maxNodes: 2, branching: { minBranches: 0, maxBranches: 0 }, required: [], extraction: { minDepth: 1, minPoints: 0 } }));
    expect(errorsAt(issues)).toContain('generation.rest.beforeBoss');
  });

  it('refuses required forks that leave no room for a rest no branch bypasses', () => {
    // 4 nodes with a required fork: start, the fork's two sides, the boss — no free depth before it.
    const shape = { minNodes: 4, maxNodes: 4, branching: { minBranches: 1, maxBranches: 1, chanceBasisPoints: 10_000, maxLength: 1 }, required: [], extraction: { minDepth: 2, minPoints: 0 } };
    const issues = issuesOf(rest({ beforeBoss: true }, shape));
    expect(errorsAt(issues)).toContain('generation.rest.beforeBoss');
    expect(issues.find((i) => i.path === 'generation.rest.beforeBoss')!.message).toMatch(/no fork bypasses/);
    // Without the rule, that complaint is not made.
    expect(errorsAt(issuesOf(rest({}, shape)))).not.toContain('generation.rest.beforeBoss');
  });

  it('a limit below the rest minimum is refused where the limit is', () => {
    expect(errorsAt(issuesOf(rest({ minNodes: 2 }, { limits: [{ types: ['rest'], max: 1 }] })))).toContain('generation.limits[0].max');
  });

  it('catches jointly impossible rest rules with the trial runs', () => {
    // Two rests that may not be adjacent, in a depth range one wide.
    const issues = issuesOf(rest({ minNodes: 2, minDepth: 2, maxDepth: 2 }, { branching: { minBranches: 0, maxBranches: 0 } }));
    expect(hasBlocking(issues)).toBe(true);
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
