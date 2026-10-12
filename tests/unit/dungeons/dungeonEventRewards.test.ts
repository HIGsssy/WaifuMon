/**
 * Event rewards through the one shared traversal: what counts as a reward
 * site, and that every consumer — dependencies, the publication snapshot,
 * work bounds, the importer's rewrite, packages — sees the same ones.
 */
import { describe, expect, it } from 'vitest';
import {
  DungeonDefinitionSchema,
  dungeonDependencies,
  dungeonRequiredItems,
  dungeonRewardActivities,
  dungeonRewardSites,
  dungeonUsesEvents,
  mapDungeonRewardBundles,
  reachableDungeonEvents,
} from '../../../src/modules/dungeons/content/dungeonDefinition';
import { validateDungeonRewardWork, DUNGEON_REWARD_LIMITS } from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  dungeonGameplayHash,
  hasDungeonRewardBundles,
  resolveDungeonRewardDependencies,
} from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { buildDungeonPackage, dungeonContentHash, readDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
import { readImportPackage } from '../../../src/modules/dungeons/package/dungeonImportService';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { singleRoomDungeon, testDungeon } from '../../helpers/dungeonFixtures';
import { VAULT_HOARD, eventDungeon, eventValidationContext } from '../../helpers/dungeonEventFixtures';

const definition = eventDungeon();
const SOURCE = { environment: 'staging', origin: 'draft' as const, draftRevision: 1, publishedRevision: null };

describe('dungeonRewardSites', () => {
  it('finds bundles on activities and on every branch of reachable events, in a fixed order', () => {
    const mixed = eventDungeon((d) => {
      d.rooms[3]!.actions = [
        { id: 'guard', type: 'combat', waves: [{ enemy: { key: 'grunt' } }], rewards: { guaranteed: [], chances: [], tables: [] } },
        { id: 'boss', type: 'boss', waves: [{ enemy: { key: 'overlord' } }], rewards: { guaranteed: [], chances: [], tables: [] } },
        { id: 'chest', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [] } },
      ];
      d.events![0]!.choices[1]!.failure!.rewards = { guaranteed: [], chances: [], tables: [] };
    });
    expect(dungeonRewardSites(mixed).map((s) => s.path)).toEqual([
      'rooms[3].actions[0].rewards',
      'rooms[3].actions[1].rewards',
      'rooms[3].actions[2].rewards',
      'events[0].choices[0].outcome.rewards',
      'events[0].choices[1].success.rewards',
      'events[0].choices[1].failure.rewards',
      'events[1].choices[0].outcome.rewards',
    ]);
    expect(dungeonRewardSites(mixed)[4]!.owner).toEqual({ kind: 'event', eventIndex: 0, choiceIndex: 1, eventId: 'sealed_vault', choiceId: 'pick_lock', branch: 'success' });
    expect(dungeonRewardSites(mixed)[0]!.owner).toEqual({ kind: 'action', roomIndex: 3, actionIndex: 0, roomId: 'lower', actionId: 'guard' });
  });

  it('counts an event reached only through a pool, and not one nothing uses', () => {
    expect([...reachableDungeonEvents(definition)].sort()).toEqual(['buried_crate', 'scavenger_trader', 'sealed_vault', 'sparking_drone']);
    const reachable = dungeonRewardSites(definition).map((s) => s.path);
    expect(reachable).toContain('events[1].choices[0].outcome.rewards');
    expect(reachable).not.toContain('events[4].choices[0].outcome.rewards');
    // The library view includes it, for rewriting and tooling.
    expect(dungeonRewardSites(definition, { scope: 'all' }).map((s) => s.path)).toContain('events[4].choices[0].outcome.rewards');

    // Detach the vault from its room: its bundles stop being dependencies.
    const detached = eventDungeon((d) => { d.rooms[1]!.actions = []; });
    expect(dungeonRewardSites(detached).map((s) => s.path)).toEqual(['events[1].choices[0].outcome.rewards']);
    expect(dungeonDependencies(detached).lootTables).toEqual([]);
  });

  it('is exactly the old walk for a dungeon without events', () => {
    const legacy = testDungeon();
    expect(dungeonRewardSites(legacy)).toEqual([]);
    expect(dungeonUsesEvents(legacy)).toBe(false);
    expect(hasDungeonRewardBundles(legacy)).toBe(false);
    const v2 = singleRoomDungeon([
      { id: 'fight', type: 'combat', waves: [{ enemy: { key: 'grunt' } }], rewards: { guaranteed: [], chances: [], tables: [] } },
      { id: 'rest', type: 'rest' },
      { id: 'loot', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [] } },
    ]);
    expect(dungeonRewardSites(v2).map((s) => s.path)).toEqual(['rooms[0].actions[0].rewards', 'rooms[0].actions[2].rewards']);
    expect(dungeonRewardSites(v2, { scope: 'all' })).toEqual(dungeonRewardSites(v2));
  });
});

describe('a loot table referenced only by an event', () => {
  it('is a dependency, is pinned in the snapshot and moves the gameplay hash', () => {
    expect(dungeonDependencies(definition).lootTables).toEqual(['vault_hoard']);
    expect(hasDungeonRewardBundles(definition)).toBe(true);
    const state = resolveDungeonRewardDependencies(definition, eventValidationContext());
    expect(Object.keys(state.tables)).toEqual(['vault_hoard']);
    expect(state.snapshot!.tables.vault_hoard!.body).toEqual(VAULT_HOARD);
    // Items the table pays are pinned; the Vault Key, which is spent and never paid, is not a reward item.
    expect(Object.keys(state.snapshot!.items)).toEqual(['scrap_parts']);
    expect(dungeonRequiredItems(definition)).toEqual(['vault_key']);
    expect(dungeonDependencies(definition).items).toEqual([]);

    const edited = new Map(eventValidationContext().lootTables);
    edited.set('vault_hoard', { name: 'Vault hoard', archivedAt: null, revision: 2, body: { ...VAULT_HOARD, guaranteed: [] } });
    const changed = resolveDungeonRewardDependencies(definition, { ...eventValidationContext(), lootTables: edited }).snapshot!;
    const contentHash = dungeonContentHash(definition);
    expect(changed.hash).not.toBe(state.snapshot!.hash);
    expect(dungeonGameplayHash(contentHash, changed.hash)).not.toBe(dungeonGameplayHash(contentHash, state.snapshot!.hash));
  });

  it('blocks the snapshot when it is missing, and is reported at the event', () => {
    const ctx = { ...eventValidationContext(), lootTables: new Map() };
    expect(resolveDungeonRewardDependencies(definition, ctx)).toMatchObject({ snapshot: null, tables: { vault_hoard: { status: 'missing' } } });
    expect(validateDungeonDefinition(definition, ctx).issues).toContainEqual(expect.objectContaining({
      code: 'reward_table_missing', severity: 'error', path: 'events[0].choices[0].outcome.rewards.tables[0]',
    }));
  });

  it('does not make an unused event’s table a requirement', () => {
    // `unfinished_table` exists nowhere; only the shelved event names it.
    const state = resolveDungeonRewardDependencies(definition, eventValidationContext());
    expect(state.snapshot).not.toBeNull();
    expect(Object.keys(state.tables)).not.toContain('unfinished_table');
    expect(validateDungeonDefinition(definition, eventValidationContext()).issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Put it in a pool a room draws from and it becomes one.
    const used = eventDungeon((d) => { d.eventPools![0]!.entries.push({ id: 'e_shelf', weight: 1, eventId: 'shelved_idea' }); });
    expect(resolveDungeonRewardDependencies(used, eventValidationContext())).toMatchObject({ snapshot: null, tables: { unfinished_table: { status: 'missing' } } });
    expect(dungeonDependencies(used).lootTables).toEqual(['unfinished_table', 'vault_hoard']);
  });
});

describe('work bounds', () => {
  it('counts an event activity once, at the largest of its outcomes', () => {
    const tables = new Map([['vault_hoard', VAULT_HOARD]]);
    const result = validateDungeonRewardWork(definition, tables);
    expect(result).toMatchObject({ ok: true, complete: true });
    // hall and heap can each pay the crate's 2; the vault at most the key's 5 (not 5 + 3).
    expect(result.work.currencies.shards).toBe(2 + 5 + 2);
    expect(dungeonRewardActivities(definition).map((a) => [a.path, a.sites.length])).toEqual([
      ['rooms[0].actions[0]', 1], ['rooms[1].actions[0]', 2], ['rooms[2].actions[0]', 1],
    ]);
  });

  it('checks every outcome against the per-activity limits, reporting a shared event once', () => {
    const big = { type: 'affection' as const, amount: { min: 500, max: 500 } };
    const heavy = eventDungeon((d) => {
      d.events![1]!.choices[0]!.outcome!.rewards = { guaranteed: [], chances: [], tables: [{ id: 't', table: 'love', draws: 3 }] };
    });
    const tables = new Map([['love', { guaranteed: [{ id: 'a', grant: big }], chances: [], pools: [] }], ['vault_hoard', VAULT_HOARD]]);
    const result = validateDungeonRewardWork(heavy, tables);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'reward_affection_too_large', path: 'events[1].choices[0].outcome.rewards' })]);
    expect(DUNGEON_REWARD_LIMITS.affectionPerActivity).toBeLessThan(1500);
  });
});

describe('mapDungeonRewardBundles', () => {
  const rename = (d: typeof definition) => mapDungeonRewardBundles(d, (bundle) => ({
    ...bundle, tables: bundle.tables.map((ref) => ({ ...ref, table: ref.table === 'vault_hoard' ? 'vault_hoard_copy' : `${ref.table}_x` })),
  }));

  it('rewrites table keys in activities and in every event, used or not, without mutating', () => {
    const withTreasure = eventDungeon((d) => {
      d.rooms[3]!.actions = [{ id: 'chest', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 't', table: 'vault_hoard', draws: 1 }] } }];
    });
    const before = structuredClone(withTreasure);
    const mapped = rename(withTreasure);
    expect(withTreasure).toEqual(before);
    expect(DungeonDefinitionSchema.safeParse(mapped).success).toBe(true);
    expect(dungeonDependencies(mapped).lootTables).toEqual(['vault_hoard_copy']);
    expect(dungeonRewardSites(mapped, { scope: 'all' }).flatMap((s) => s.bundle.tables.map((t) => t.table)).sort()).toEqual(['unfinished_table_x', 'vault_hoard_copy', 'vault_hoard_copy']);
    // Nothing but the bundles changed.
    const strip = (d: typeof definition) => mapDungeonRewardBundles(d, (bundle) => ({ ...bundle, tables: [] }));
    expect(strip(mapped)).toEqual(strip(withTreasure));
  });

  it('returns an equal definition when nothing needs rewriting', () => {
    expect(mapDungeonRewardBundles(definition, (bundle) => bundle)).toEqual(definition);
    expect(mapDungeonRewardBundles(testDungeon(), (bundle) => bundle)).toEqual(testDungeon());
  });
});

describe('packages carry events only through v3', () => {
  it('builds v3 with or without reachable rewards', () => {
    const snapshot = resolveDungeonRewardDependencies(definition, eventValidationContext()).snapshot!;
    expect(buildDungeonPackage({ definition, rewardSnapshot: snapshot, source: SOURCE }).schemaVersion).toBe(3);
    // Without reward bundles it would otherwise have been written as v1.
    const bare = eventDungeon((d) => {
      for (const event of d.events!) for (const choice of event.choices) for (const branch of ['outcome', 'success', 'failure'] as const) delete choice[branch]?.rewards;
    });
    expect(hasDungeonRewardBundles(bare)).toBe(false);
    expect(buildDungeonPackage({ definition: bare, source: SOURCE })).toMatchObject({ schemaVersion: 3, rewardSnapshot: null });
    expect(buildDungeonPackage({ definition: { ...testDungeon(), events: [] }, source: SOURCE }).schemaVersion).toBe(3);
  });

  it('refuses events disguised as legacy packages', () => {
    const legacy = buildDungeonPackage({ definition: testDungeon(), source: SOURCE });
    const bare = eventDungeon((d) => {
      for (const event of d.events!) for (const choice of event.choices) for (const branch of ['outcome', 'success', 'failure'] as const) delete choice[branch]?.rewards;
    });
    const forged = { ...legacy, dungeon: bare, contentHash: dungeonContentHash(bare), source: { ...legacy.source, dungeonKey: bare.key } };
    for (const read of [readDungeonPackage(forged), readImportPackage(forged)]) {
      expect(read).toMatchObject({ ok: false, package: null });
      expect(read.issues.map((i) => i.code)).toContain('package_schema_version');
    }
    // Event-free packages read as they always did.
    expect(readDungeonPackage(legacy)).toMatchObject({ ok: true });
  });
});
